// Two-process protocol test (spec §12): two real OS processes race to merge
// the same order group against the REAL Postgres stores and a shared fake
// Shopify served over HTTP. This is the counterexample the memory stores can
// only simulate: claims, locks, gates and leases race for real.
//
// Opt-in: MERGESHIP_TEST_DATABASE_URL=postgresql://... (disposable db — the
// suite truncates the v2 tables). Postgres must already have the migrations.
//
//   MERGESHIP_TEST_DATABASE_URL=postgresql://... npx vitest run tests/two-process.test.ts

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { FakeShopify, makeOrder } from "./fake-shopify";

const DATABASE_URL = process.env.MERGESHIP_TEST_DATABASE_URL;
const SHOP = "two-process.myshopify.com";
const id = (n: number) => `gid://shopify/Order/${n}`;

const run = DATABASE_URL ? describe : describe.skip;

run("two processes sharing real Postgres", () => {
  it("A anchors #2, B anchors #3: one op, ≤1 commit, exact line multiset, secondaries cancelled once", async () => {
    const shopify = new FakeShopify([makeOrder(1), makeOrder(2), makeOrder(3)]);
    shopify.clock = () => new Date(); // real wall clock — children run on it
    let go = false;

    const server = http.createServer(async (req, res) => {
      const json = (body: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && req.url === "/graphql") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
          const { query, variables } = JSON.parse(body);
          try {
            const r = await shopify.admin.graphql(query, { variables });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(await r.text());
          } catch (err: any) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: err?.message ?? String(err) }));
          }
        });
        return;
      }
      if (req.url === "/go") return json({ go });
      if (req.url === "/state") {
        return json({
          orders: [...shopify.orders.values()].map((o) => ({
            id: o.id,
            name: o.name,
            cancelledAt: o.cancelledAt,
            cancellation: o.cancellation,
            cancelCount: o.cancelCount,
            lineItems: o.lineItems.map((l) => ({ id: l.id, quantity: l.quantity, variantId: l.variant?.id })),
          })),
          calls: { MergeEditCommit: shopify.mutationCalls("MergeEditCommit") },
        });
      }
      res.writeHead(404).end();
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as any).port));
    });
    const base = `http://127.0.0.1:${port}`;

    const db = new PrismaClient({ datasourceUrl: DATABASE_URL });
    // Clean slate + both kill switches on for this shop.
    await db.$executeRawUnsafe(
      `TRUNCATE "MergeOrderLock", "MergeMutationAttempt", "MergeOperation", "MergeClaim", "ProcessedWebhook", "MergeRecord"`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "AppControl" ("id", "newMergesEnabled", "completionEnabled", "allowShops", "updatedAt")
       VALUES ('control', true, true, '{}', now())
       ON CONFLICT ("id") DO UPDATE SET "newMergesEnabled" = true, "completionEnabled" = true`,
    );

    // Concurrent lock-ownership sampler: at no instant may two ops hold a lock
    // on the same order (the unique constraint already forbids it, this also
    // records that the constraint was exercised).
    const duplicates: string[] = [];
    const sampler = setInterval(async () => {
      try {
        const rows = await db.$queryRaw<{ orderId: string; n: bigint }[]>`
          SELECT "orderId", COUNT(DISTINCT "operationId") AS n
          FROM "MergeOrderLock" WHERE "shop" = ${SHOP} GROUP BY "orderId" HAVING COUNT(*) > 1`;
        for (const r of rows) if (Number(r.n) > 1) duplicates.push(r.orderId);
      } catch {
        /* sampling is best effort */
      }
    }, 100);

    // Equivalent to `npx vite-node tests/helpers/worker-process.ts`: spawning
    // npx(.cmd) itself needs a shell on Windows, so run node on vite-node's
    // entry directly. (vite.config fs.allow includes tests/ for this.)
    const viteNodeCli = path.resolve(
      __dirname,
      "..",
      "node_modules",
      "vite-node",
      "vite-node.mjs",
    );

    const childEnv = (anchor: string) => ({
      ...process.env,
      DATABASE_URL: DATABASE_URL!,
      FAKE_SHOPIFY_URL: base,
      SHOP,
      ANCHOR_ORDER_ID: anchor,
      MERGESHIP_MUTATIONS: "enabled",
      DISABLE_BACKGROUND_WORKER: "true",
    });
    const runChild = (anchor: string) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, [viteNodeCli, path.join("tests", "helpers", "worker-process.ts")], {
          env: childEnv(anchor),
          cwd: path.resolve(__dirname, ".."),
        });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("close", (code) => resolve({ code, out }));
      });

    const a = runChild(id(2));
    const b = runChild(id(3));
    // Give both children a moment to reach the barrier, then release them.
    await new Promise((r) => setTimeout(r, 4000));
    go = true;
    const [ra, rb] = await Promise.all([a, b]);
    clearInterval(sampler);
    server.close();

    console.log("── child A (#2) ──\n" + ra.out.trim());
    console.log("── child B (#3) ──\n" + rb.out.trim());
    expect(ra.code).toBe(0);
    expect(rb.code).toBe(0);
    expect(duplicates).toEqual([]);

    const ops = await db.$queryRaw<any[]>`
      SELECT * FROM "MergeOperation" WHERE "shop" = ${SHOP} AND "protocolVersion" = 2`;
    expect(ops.length).toBeGreaterThanOrEqual(1);
    expect(ops.length).toBeLessThanOrEqual(2);
    for (const op of ops) {
      expect(["COMPLETED", "ABANDONED"]).toContain(op.phase);
      // An op that committed must complete; an abandoned one never dispatched.
      const attempts = await db.$queryRaw<any[]>`
        SELECT "kind", "state" FROM "MergeMutationAttempt"
        WHERE "operationId" = ${op.id} AND "kind" = 'EDIT_COMMIT'`;
      expect(attempts.length).toBeLessThanOrEqual(1);
      expect(attempts.every((a) => a.state === "SUCCEEDED")).toBe(true);
    }
    const completed = ops.filter((o) => o.phase === "COMPLETED");
    expect(completed).toHaveLength(1);
    expect(completed[0].sideEffectsDone).toBe(true);
    expect([...completed[0].involvedOrderIds].sort()).toEqual([id(1), id(2), id(3)].sort());

    // No locks remain; every work item is DONE.
    expect(
      await db.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*)::bigint AS n FROM "MergeOrderLock" WHERE "shop" = ${SHOP}`,
    ).toEqual([{ n: 0n }]);
    const work = await db.$queryRaw<any[]>`SELECT * FROM "ProcessedWebhook" WHERE "shop" = ${SHOP}`;
    expect(work.length).toBe(2);
    expect(work.every((w) => w.status === "DONE")).toBe(true);
    expect(work.some((w) => w.outcome === "MERGED" || w.operationId === completed[0].id)).toBe(true);

    // Fake-Shopify state: the primary has exactly the 3 expected lines (3
    // distinct ids), each secondary cancelled exactly once.
    const state = shopifyState(shopify);
    const primary = state.orders.find((o: any) => o.id === id(1));
    expect(primary).toBeDefined();
    expect(primary!.cancelledAt).toBeNull();
    expect(primary!.lineItems).toHaveLength(3);
    expect(new Set(primary!.lineItems.map((l: any) => l.id)).size).toBe(3);
    for (const n of [2, 3]) {
      const s = state.orders.find((o: any) => o.id === id(n));
      expect(s).toBeDefined();
      expect(s!.cancelledAt).toBeTruthy();
      expect(s!.cancelCount).toBe(1);
      expect(s!.cancellation?.staffNote).toContain("MS-");
    }
    // Exactly one commit ever reached Shopify for this group.
    expect(state.calls.MergeEditCommit).toBe(1);

    await db.$disconnect();
  }, 120_000);
});

// Local fallback if the server is already closed when /state is polled.
function shopifyState(shopify: FakeShopify) {
  return {
    orders: [...shopify.orders.values()].map((o) => ({
      id: o.id,
      name: o.name,
      cancelledAt: o.cancelledAt,
      cancellation: o.cancellation,
      cancelCount: o.cancelCount,
      lineItems: o.lineItems.map((l) => ({ id: l.id, quantity: l.quantity, variantId: l.variant?.id })),
    })),
    calls: { MergeEditCommit: shopify.mutationCalls("MergeEditCommit") },
  };
}
