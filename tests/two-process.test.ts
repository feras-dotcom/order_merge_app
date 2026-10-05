// Two-process protocol test (spec §12): real OS processes race to merge order
// groups against the REAL Postgres stores and a shared fake Shopify served
// over HTTP. This is the counterexample the memory stores can only simulate:
// claims, locks, gates and leases race for real.
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

const viteNodeCli = path.resolve(__dirname, "..", "node_modules", "vite-node", "vite-node.mjs");
const repoRoot = path.resolve(__dirname, "..");

/** One FakeShopify + HTTP server + truncated database per case. */
async function startHarness() {
  const shopify = new FakeShopify([makeOrder(1), makeOrder(2), makeOrder(3)]);
  shopify.clock = () => new Date(); // real wall clock — children run on it
  const registered = new Set<string>();
  const readyWork = new Map<string, { orderId: string; leaseToken: string | null }[]>();
  let expectedWorkers: string[] | null = null;
  let goResolve: (() => void) | null = null;
  const released = () =>
    expectedWorkers !== null && expectedWorkers.every((n) => registered.has(n));
  const maybeRelease = () => {
    if (released()) {
      goResolve?.();
      goResolve = null;
    }
  };

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
    if (req.method === "POST" && req.url?.startsWith("/ready")) {
      const worker = new URL(req.url, "http://localhost").searchParams.get("worker");
      if (worker) {
        readyWork.set(worker, await db.$queryRaw<{ orderId: string; leaseToken: string | null }[]>`
          SELECT "orderId", "leaseToken" FROM "ProcessedWebhook" WHERE "shop" = ${SHOP}`);
        registered.add(worker);
        maybeRelease();
      }
      return json({ ok: true });
    }
    if (req.url === "/go") return json({ go: released() });
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

  const runChild = (env: Record<string, string>) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        [viteNodeCli, path.join("tests", "helpers", "worker-process.ts")],
        {
          env: {
            ...process.env,
            DATABASE_URL: DATABASE_URL!,
            FAKE_SHOPIFY_URL: base,
            SHOP,
            MERGESHIP_MUTATIONS: "enabled",
            DISABLE_BACKGROUND_WORKER: "true",
            ...env,
          },
          cwd: repoRoot,
        },
      );
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code, out }));
    });

  return {
    shopify,
    db,
    runChild,
    readyWork,
    // Release once every named worker has posted /ready — event-driven, no
    // timer. Children arriving later (e.g. a post-completion fourth order)
    // poll /go and pass immediately once the expected set has checked in.
    release: (expected: string[]) =>
      new Promise<void>((resolve, reject) => {
        expectedWorkers = expected;
        if (released()) return resolve();
        goResolve = resolve;
        setTimeout(
          () =>
            reject(
              new Error(
                `workers never registered: want [${expected}], have [${[...registered]}]`,
              ),
            ),
          60_000,
        );
      }),
    close: async () => {
      server.close();
      await db.$disconnect();
    },
  };
}

const opsFor = (db: PrismaClient) =>
  db.$queryRaw<any[]>`SELECT * FROM "MergeOperation" WHERE "shop" = ${SHOP} AND "protocolVersion" = 2`;
const attemptsFor = (db: PrismaClient, opId: string, kind: string) =>
  db.$queryRaw<any[]>`SELECT * FROM "MergeMutationAttempt" WHERE "operationId" = ${opId} AND "kind" = ${kind}`;
const lockCount = async (db: PrismaClient) =>
  Number(
    (await db.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*)::bigint AS n FROM "MergeOrderLock" WHERE "shop" = ${SHOP}`)[0].n,
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

run("two processes sharing real Postgres", () => {
  it("leased anchor work exists at readiness, before a sweep-only peer can declare startup quiet", async () => {
    const h = await startHarness();
    const a = h.runChild({ ANCHOR_ORDER_ID: id(2), WORKER_NAME: "A" });
    const b = h.runChild({ SWEEP_ONLY: "true", SWEEP_MAX_MS: "90000", WORKER_NAME: "B" });
    await h.release(["A", "B"]);
    const observedAtReadiness = h.readyWork.get("A");
    const [ra, rb] = await Promise.all([a, b]);
    await h.close();
    expect(observedAtReadiness).toContainEqual(expect.objectContaining({ orderId: id(2), leaseToken: expect.any(String) }));
    expect(ra.code, ra.out).toBe(0);
    expect(rb.code, rb.out).toBe(0);
  }, 120_000);

  it("A anchors #2, B anchors #3: one op, ≤1 commit, exact line multiset, secondaries cancelled once", async () => {
    const h = await startHarness();
    const duplicates: string[] = [];
    const sampler = setInterval(async () => {
      try {
        const rows = await h.db.$queryRaw<{ orderId: string; n: bigint }[]>`
          SELECT "orderId", COUNT(DISTINCT "operationId") AS n
          FROM "MergeOrderLock" WHERE "shop" = ${SHOP} GROUP BY "orderId" HAVING COUNT(*) > 1`;
        for (const r of rows) if (Number(r.n) > 1) duplicates.push(r.orderId);
      } catch {
        /* sampling is best effort */
      }
    }, 100);

    const a = h.runChild({ ANCHOR_ORDER_ID: id(2), WORKER_NAME: "A" });
    const b = h.runChild({ ANCHOR_ORDER_ID: id(3), WORKER_NAME: "B" });
    await h.release(["A", "B"]);
    const [ra, rb] = await Promise.all([a, b]);
    clearInterval(sampler);
    await h.close();

    console.log("── child A (#2) ──\n" + ra.out.trim());
    console.log("── child B (#3) ──\n" + rb.out.trim());
    expect(ra.code).toBe(0);
    expect(rb.code).toBe(0);
    expect(duplicates).toEqual([]);

    const ops = await opsFor(h.db);
    expect(ops.length).toBeGreaterThanOrEqual(1);
    expect(ops.length).toBeLessThanOrEqual(2);
    for (const op of ops) {
      expect(["COMPLETED", "ABANDONED"]).toContain(op.phase);
      // An op that committed must complete; an abandoned one never dispatched.
      const attempts = await attemptsFor(h.db, op.id, "EDIT_COMMIT");
      expect(attempts.length).toBeLessThanOrEqual(1);
      expect(attempts.every((a) => a.state === "SUCCEEDED")).toBe(true);
    }
    const completed = ops.filter((o) => o.phase === "COMPLETED");
    expect(completed).toHaveLength(1);
    expect(completed[0].sideEffectsDone).toBe(true);
    expect([...completed[0].involvedOrderIds].sort()).toEqual([id(1), id(2), id(3)].sort());

    // No locks remain; every work item is DONE.
    expect(await lockCount(h.db)).toBe(0);
    const work = await h.db.$queryRaw<any[]>`SELECT * FROM "ProcessedWebhook" WHERE "shop" = ${SHOP}`;
    expect(work.length).toBe(2);
    expect(work.every((w) => w.status === "DONE")).toBe(true);
    expect(work.some((w) => w.outcome === "MERGED" || w.operationId === completed[0].id)).toBe(true);

    // Fake-Shopify state: the primary has exactly the 3 expected lines (3
    // distinct ids), each secondary cancelled exactly once.
    const primary = h.shopify.order(1);
    expect(primary.cancelledAt).toBeNull();
    expect(primary.lineItems).toHaveLength(3);
    expect(new Set(primary.lineItems.map((l) => l.id)).size).toBe(3);
    for (const n of [2, 3]) {
      const s = h.shopify.order(n);
      expect(s.cancelledAt).toBeTruthy();
      expect(s.cancelCount).toBe(1);
      expect(s.cancellation?.staffNote).toContain("MS-");
    }
    // Exactly one commit ever reached Shopify for this group.
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(1);
  }, 120_000);

  it("delayed application: commit response lost, edit applies ~3s later — still exactly one commit", async () => {
    const h = await startHarness();
    h.shopify.commitMode.set("*", "lose-apply-later");
    // 45s op lease: the dispatch gate requires >30s of lease margin, so it
    // must exceed that while still lapsing early in the 90s sweep — the
    // parked COMMIT_IN_DOUBT op becomes re-acquirable ~15s past its first
    // evidence-ladder slot.
    const child = h.runChild({
      ANCHOR_ORDER_ID: id(2),
      SWEEP_MAX_MS: "90000",
      LEASE_TTL_MS: "45000",
      WORKER_NAME: "A",
    });
    await h.release(["A"]);

    // Wait for the child's commit to reach the fake, then apply it ~3s later.
    const observed = Date.now();
    while (h.shopify.mutationCalls("MergeEditCommit") < 1 && Date.now() - observed < 30_000) {
      await sleep(100);
    }
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(1);
    await sleep(3000);
    h.shopify.deliverPendingCommit(h.shopify.lastCalcId());

    const r = await child;
    await h.close();
    console.log("── child (#2) ──\n" + r.out.trim());
    expect(r.code).toBe(0);

    const ops = await opsFor(h.db);
    expect(ops).toHaveLength(1); // no second op was ever created
    expect(ops[0].phase).toBe("COMPLETED");
    expect(ops[0].sideEffectsDone).toBe(true);
    expect(await attemptsFor(h.db, ops[0].id, "EDIT_COMMIT")).toHaveLength(1);
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(1);
    expect(h.shopify.order(1).lineItems).toHaveLength(3);
    for (const n of [2, 3]) {
      expect(h.shopify.order(n).cancelCount).toBe(1);
      expect(h.shopify.order(n).cancelledAt).toBeTruthy();
    }
    expect(await lockCount(h.db)).toBe(0);
  }, 120_000);

  it("takeover: a worker that crashes after the attempt record is reconciled, never re-committed", async () => {
    const h = await startHarness();
    // A 45s op lease: the dispatch gate refuses with <30s of lease margin,
    // so this is the smallest value that lets A dispatch once; it still
    // lapses quickly after the crash for the sweeper to take over.
    const a = h.runChild({
      ANCHOR_ORDER_ID: id(2),
      CRASH_AT: "after-attempt-record",
      LEASE_TTL_MS: "45000",
      WORKER_NAME: "A",
    });
    const b = h.runChild({ SWEEP_ONLY: "true", SWEEP_MAX_MS: "90000", WORKER_NAME: "B" });
    await h.release(["A", "B"]);
    const [ra, rb] = await Promise.all([a, b]);
    await h.close();
    console.log("── child A (#2, crash) ──\n" + ra.out.trim());
    console.log("── child B (sweep) ──\n" + rb.out.trim());
    expect(ra.code).toBe(1); // crashed, did not swallow the exit
    expect(rb.code).toBe(0);

    const ops = await opsFor(h.db);
    expect(ops).toHaveLength(1);
    expect(ops[0].phase).toBe("COMPLETED");
    // A's attempt row stays exactly as recorded; no second EDIT_COMMIT ever.
    const commits = await attemptsFor(h.db, ops[0].id, "EDIT_COMMIT");
    expect(commits).toHaveLength(1);
    expect(commits[0].state).toBe("SUCCEEDED");
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(1);
    expect(h.shopify.order(1).lineItems).toHaveLength(3);
    for (const n of [2, 3]) {
      expect(h.shopify.order(n).cancelCount).toBe(1);
      expect(h.shopify.order(n).cancelledAt).toBeTruthy();
    }
    expect(await lockCount(h.db)).toBe(0);
  }, 120_000);

  it("late application after a real takeover: B owns the op before the lost commit lands — never re-dispatched", async () => {
    const h = await startHarness();
    // The commit response is lost but the edit stays parked — A records
    // UNKNOWN and crashes; the test applies the commit only after B owns
    // the op, proving the takeover reconciles A's fact instead of resending.
    h.shopify.commitMode.set("*", "lose-apply-later");
    let commitSeenResolve!: () => void;
    const commitSeen = new Promise<void>((r) => (commitSeenResolve = r));
    h.shopify.on("MergeEditCommit", () => {
      commitSeenResolve();
      return undefined; // the fake's lose-apply-later behaviour still runs
    });

    // 45s op lease: the dispatch gate requires >30s of lease margin, so this
    // is the smallest value that lets A dispatch once — it still lapses soon
    // after the crash for B's sweeps to take over.
    const a = h.runChild({
      ANCHOR_ORDER_ID: id(2),
      CRASH_AT: "after-attempt-record",
      LEASE_TTL_MS: "45000",
      WORKER_NAME: "A",
    });
    const b = h.runChild({ SWEEP_ONLY: "true", SWEEP_MAX_MS: "240000", WORKER_NAME: "B" });
    await h.release(["A", "B"]);

    // (1) A's commit reached the fake (lost + parked there).
    await commitSeen;
    // (2) A recorded the attempt outcome and crashed.
    const ra = await a;
    const crashedAt = performance.now();
    console.log("── child A (#2, crash) ──\n" + ra.out.trim());
    expect(ra.code).toBe(1);
    expect(ra.out).toContain("crash after attempt record");

    const [opAfterCrash] = await opsFor(h.db);
    expect(opAfterCrash.phase).toBe("COMMIT_IN_DOUBT");
    const aLeaseToken = opAfterCrash.leaseToken;

    // (3) B takes over only once A's lease lapses — poll for a different
    // live lease token, never a sleep. performance.now() has sub-ms
    // resolution — Date.now() can collide on consecutive events.
    let takeoverAt = 0;
    for (const deadline = Date.now() + 150_000; Date.now() < deadline; ) {
      const [op] = await opsFor(h.db);
      if (
        op.leaseToken !== aLeaseToken &&
        new Date(op.leasedUntil).getTime() > Date.now()
      ) {
        takeoverAt = performance.now();
        // Still mid-doubt, and no second commit was ever dispatched.
        expect(op.phase).toBe("COMMIT_IN_DOUBT");
        expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(1);
        break;
      }
      await sleep(250);
    }
    expect(takeoverAt).toBeGreaterThan(0);

    // (4) Only now does Shopify apply the commit A's response lost.
    h.shopify.deliverPendingCommit(h.shopify.lastCalcId());
    const deliveredAt = performance.now();
    console.log(
      `── timeline ── B took over ${Math.round((takeoverAt - crashedAt) / 1000)}s ` +
        `after A's crash; commit delivered ${Math.round(deliveredAt - takeoverAt)}ms later`,
    );

    // (5) B's evidence ladder finds the applied commit and finishes the op.
    const rb = await b;
    await h.close();
    console.log("── child B (sweep) ──\n" + rb.out.trim());
    expect(rb.code).toBe(0);
    expect(takeoverAt).toBeLessThan(deliveredAt);

    const ops = await opsFor(h.db);
    expect(ops).toHaveLength(1);
    expect(ops[0].phase).toBe("COMPLETED");
    expect(ops[0].sideEffectsDone).toBe(true);
    // A's UNKNOWN fact stands — B reconciled it, never re-dispatched or
    // rewrote the recorded outcome.
    const commits = await attemptsFor(h.db, ops[0].id, "EDIT_COMMIT");
    expect(commits).toHaveLength(1);
    expect(commits[0].state).toBe("UNKNOWN");
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(1);
    expect(h.shopify.order(1).lineItems).toHaveLength(3);
    for (const n of [2, 3]) {
      expect(h.shopify.order(n).cancelCount).toBe(1);
      expect(h.shopify.order(n).cancelledAt).toBeTruthy();
    }
    expect(await lockCount(h.db)).toBe(0);
  }, 300_000);

  it("a fourth order after completion starts a second op on the released primary", async () => {
    const h = await startHarness();
    const first = h.runChild({ ANCHOR_ORDER_ID: id(2), WORKER_NAME: "A" });
    await h.release(["A"]);
    expect((await first).code).toBe(0);

    // A new order for the same customer arrives after the merge completed.
    h.shopify.orders.set(id(4), makeOrder(4));
    const fourth = h.runChild({ ANCHOR_ORDER_ID: id(4), WORKER_NAME: "B" });
    const r = await fourth; // go is already released
    await h.close();
    console.log("── child (#4) ──\n" + r.out.trim());
    expect(r.code).toBe(0);

    const ops = await opsFor(h.db);
    expect(ops).toHaveLength(2);
    expect(ops.every((o) => o.phase === "COMPLETED" && o.sideEffectsDone)).toBe(true);
    expect(ops[1].primaryOrderId).toBe(id(1));
    expect(h.shopify.order(1).lineItems).toHaveLength(4);
    expect(h.shopify.order(4).cancelCount).toBe(1);
    expect(h.shopify.order(4).cancelledAt).toBeTruthy();
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(2);
    expect(await lockCount(h.db)).toBe(0);
  }, 120_000);

  it("a merchant-cancelled secondary parks the op in REVIEW_REQUIRED — locks held, #4 never starts a second op", async () => {
    const h = await startHarness();
    // The commit applies; immediately afterwards the merchant cancels #3
    // themselves, before the op's cancellation step can reach it.
    h.shopify.on("MergeEditCommit", (vars) => {
      h.shopify.applyCommit(vars.id);
      const o3 = h.shopify.order(3);
      o3.cancelledAt = new Date().toISOString();
      o3.cancellation = { staffNote: "merchant" };
      o3.cancelCount += 1;
      return { data: { orderEditCommit: { order: { id: id(1) }, userErrors: [] } } };
    });
    const first = h.runChild({ ANCHOR_ORDER_ID: id(2), SWEEP_MAX_MS: "30000", WORKER_NAME: "A" });
    await h.release(["A"]);
    expect((await first).code).toBe(0);

    let ops = await opsFor(h.db);
    expect(ops).toHaveLength(1);
    expect(ops[0].phase).toBe("REVIEW_REQUIRED");
    expect(await lockCount(h.db)).toBe(3); // 1/2/3 stay protected in review
    expect(h.shopify.order(2).cancelCount).toBe(1); // #2 still cancelled by us
    expect(h.shopify.order(3).cancellation?.staffNote).toBe("merchant");

    // A new order can never pull the parked group into a second op.
    h.shopify.orders.set(id(4), makeOrder(4));
    const fourth = h.runChild({ ANCHOR_ORDER_ID: id(4), SWEEP_MAX_MS: "30000", WORKER_NAME: "B" });
    const r = await fourth;
    await h.close();
    console.log("── child (#4) ──\n" + r.out.trim());
    expect(r.code).toBe(0);

    ops = await opsFor(h.db);
    expect(ops).toHaveLength(1); // still exactly one op
    expect(await lockCount(h.db)).toBe(3);
    const item = await h.db.$queryRaw<any[]>`
      SELECT * FROM "ProcessedWebhook" WHERE "shop" = ${SHOP} AND "orderId" = ${id(4)}`;
    expect(item).toHaveLength(1);
    expect(item[0].operationId).toBeNull();
    expect(
      (item[0].status === "DONE" && item[0].outcome === "NO_PARTNER") || item[0].status === "PENDING",
    ).toBe(true);
  }, 120_000);
});
