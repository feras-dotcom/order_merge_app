// Focused tests for the G-E7 send gate and genuinely-concurrent batch send
// (scripts/lib/campaign-send.impl.ts + scripts/lib/campaign-checks.ts).
// Child processes are fully mocked — no Shopify calls, no network.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authorizeSend, campaignVarsFor, CAMPAIGN_ORDER_GID, CAMPAIGN_PARENT_GID,
  initCampaign, resolveSendOuts, runSendBatch, validateCampaignRequest,
  verifiedBaseline,
} from "../scripts/lib/campaign-send.impl";
import { decideBaseline } from "../scripts/lib/campaign-checks";
import { buildManifestLines } from "../scripts/lib/evidence-manifest";

const KEY = "76657d42-302c-43de-af25-fbc615f39cbf";
const SHORT = CAMPAIGN_ORDER_GID.split("/").pop()!;

// ── mocked child process ─────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() { this.killed = true; return true; }
  finish(code: number | null, signal: string | null = null) {
    this.emit("close", code, signal);
  }
}

interface SpawnCall { argv: string[]; child: FakeChild; started: number }

function fakeSpawn(calls: SpawnCall[]) {
  return (command: string, argv: readonly string[]) => {
    const child = new FakeChild();
    calls.push({ argv: [...argv], child, started: Date.now() });
    return child as unknown as import("node:child_process").ChildProcess;
  };
}

// ── seeded campaign dirs ─────────────────────────────────────────────────

const REPO = process.cwd();
const SRC_DIR = join(REPO, "docs", "evidence", "shipping-v0-e7");

function seedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ms-e7-send-"));
  for (const f of ["e7-refund.graphql", "e7-refund-literal-template.graphql"]) {
    writeFileSync(join(dir, f), readFileSync(join(SRC_DIR, f)));
  }
  writeFileSync(join(dir, "e7-idempotency-key.txt"), KEY + "\n");
  writeFileSync(join(dir, "e7-vars-1.00.json"), JSON.stringify(campaignVarsFor(KEY, "1.00")));
  writeFileSync(join(dir, "e7-vars-changed-0.50.json"), JSON.stringify(campaignVarsFor(KEY, "0.50")));
  writeFileSync(join(dir, "e7-refund-literal.graphql"),
    readFileSync(join(dir, "e7-refund-literal-template.graphql"), "utf8").split("__IDEMPOTENCY_KEY__").join(KEY));
  return dir;
}

function seedBaseline(dir: string, over: Record<string, unknown> = {}) {
  const name = `baseline-${SHORT}.json`;
  writeFileSync(join(dir, name), JSON.stringify({
    kind: "order-baseline", orderId: CAMPAIGN_ORDER_GID, runAtUtc: "2026-10-20T09:00:00Z",
    refundIds: ["gid://shopify/Refund/1123042787575"],
    totalRefundedMinor: "3000", totalRefundedShippingMinor: "3000", ...over,
  }));
  writeFileSync(join(dir, "MANIFEST.sha256"),
    buildManifestLines(dir, [name]).join("\n") + "\n");
}

const sendArgs = (dir: string) => ({
  dir,
  docPath: join(dir, "e7-refund.graphql"),
  varsPath: join(dir, "e7-vars-1.00.json"),
  outs: [join(dir, "e7-1-concurrent-A.json"), join(dir, "e7-1-concurrent-B.json")],
});

// ── concurrency ──────────────────────────────────────────────────────────

describe("runSendBatch concurrency", () => {
  it("starts every child before awaiting any completion (true overlap)", async () => {
    const dir = seedDir();
    const calls: SpawnCall[] = [];
    const spawn = fakeSpawn(calls);
    let resolvedEarly = false;
    const p = runSendBatch({
      docPath: join(dir, "e7-refund.graphql"),
      varsPath: join(dir, "e7-vars-1.00.json"),
      outs: [join(dir, "e7-1-concurrent-A.json"), join(dir, "e7-1-concurrent-B.json")],
      spawnFn: spawn, timeoutMs: 5000,
    }).then((r) => { resolvedEarly = true; return r; });
    await new Promise((r) => setImmediate(r));
    // Both spawned while neither has completed — sequential spawnSync could
    // never produce this state.
    expect(calls.length).toBe(2);
    expect(resolvedEarly).toBe(false);
    calls[0].child.stdout!.end(JSON.stringify({ data: { op: { refund: { id: "gid://shopify/Refund/1" }, userErrors: [] } } }));
    calls[0].child.finish(0);
    calls[1].child.stderr!.end("Order is temporarily unavailable to be modified.");
    calls[1].child.finish(0);
    const { results } = await p;
    expect(results.length).toBe(2);
    expect(results[0].exitCode).toBe(0);
    expect(results[0].raw).toContain("gid://shopify/Refund/1");
    expect(results[1].raw).toContain("temporarily unavailable");
    expect(results[0].raw).not.toContain("temporarily unavailable");
    // Raw output preserved independently per process.
    expect(readFileSync(join(dir, "e7-1-concurrent-A.json"), "utf8")).toContain("gid://shopify/Refund/1");
    expect(readFileSync(join(dir, "e7-1-concurrent-B.json"), "utf8")).toContain("temporarily unavailable");
  });

  it("records timeouts and kills the child — no retry is ever issued", async () => {
    const dir = seedDir();
    const calls: SpawnCall[] = [];
    const spawn = fakeSpawn(calls);
    const { results } = await runSendBatch({
      docPath: join(dir, "e7-refund.graphql"), varsPath: join(dir, "e7-vars-1.00.json"),
      outs: [join(dir, "e7-hang-A.json")], spawnFn: spawn, timeoutMs: 25,
    });
    expect(results[0].timedOut).toBe(true);
    expect(results[0].error).toContain("timeout");
    expect(calls[0].child.killed).toBe(true);
    // exactly one spawn for one out — an ambiguous result is never retried
    expect(calls.length).toBe(1);
    expect(existsSync(join(dir, "e7-hang-A.json"))).toBe(true);
  });

  it("records nonzero exits and spawn errors without retrying", async () => {
    const dir = seedDir();
    const calls: SpawnCall[] = [];
    const spawn = fakeSpawn(calls);
    const p = runSendBatch({
      docPath: join(dir, "e7-refund.graphql"), varsPath: join(dir, "e7-vars-1.00.json"),
      outs: [join(dir, "e7-err-A.json")], spawnFn: spawn, timeoutMs: 5000,
    });
    await new Promise((r) => setImmediate(r));
    calls[0].child.stderr!.end("THROTTLED");
    calls[0].child.finish(1);
    const { results } = await p;
    expect(results[0].exitCode).toBe(1);
    expect(results[0].error).toContain("exit code 1");
    expect(results[0].raw).toContain("THROTTLED");
    expect(calls.length).toBe(1);
  });
});

// ── pre-send authorization ───────────────────────────────────────────────

describe("authorizeSend", () => {
  it("authorizes the approved variable-doc create request", () => {
    const dir = seedDir();
    seedBaseline(dir);
    const r = authorizeSend(sendArgs(dir));
    expect(r).toMatchObject({ ok: true, kind: "variable", amount: "1.00" });
  });
  it("authorizes the rendered literal document and the mismatch vars", () => {
    const dir = seedDir();
    seedBaseline(dir);
    const r = authorizeSend({
      ...sendArgs(dir),
      docPath: join(dir, "e7-refund-literal.graphql"),
      varsPath: join(dir, "e7-vars-changed-0.50.json"),
      outs: [join(dir, "e7-4-mismatch.json")],
    });
    expect(r).toMatchObject({ ok: true, kind: "literal", amount: "0.50" });
  });
  it("refuses without a verified baseline", () => {
    const dir = seedDir(); // no baseline
    const r = authorizeSend(sendArgs(dir));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("baseline");
  });
  it("refuses a baseline not covered by the manifest (tampered since read-back)", () => {
    const dir = seedDir();
    seedBaseline(dir);
    writeFileSync(join(dir, `baseline-${SHORT}.json`), JSON.stringify({ orderId: CAMPAIGN_ORDER_GID, refundIds: [], totalRefundedMinor: "0", totalRefundedShippingMinor: "0" }));
    const r = authorizeSend(sendArgs(dir));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("manifest");
  });
  it("refuses wrong order, parent, amount, currency and unapproved documents/keys", () => {
    const dir = seedDir();
    seedBaseline(dir);
    const bad = (mut: (v: ReturnType<typeof campaignVarsFor>) => void) => {
      const v = campaignVarsFor(KEY, "1.00");
      mut(v);
      writeFileSync(join(dir, "bad-vars.json"), JSON.stringify(v));
      return authorizeSend({ ...sendArgs(dir), varsPath: join(dir, "bad-vars.json"), outs: [join(dir, `o-${Math.random()}.json`)] });
    };
    for (const m of [
      (v: any) => { v.input.orderId = "gid://shopify/Order/1"; },
      (v: any) => { v.input.transactions[0].parentId = "gid://shopify/OrderTransaction/1"; },
      (v: any) => { v.input.shipping.amount = "2.00"; },
      (v: any) => { v.input.currency = "EUR"; },
      (v: any) => { v.input.notify = true; },
      (v: any) => { v.idempotencyKey = "other-key-0000-0000-000000000000"; },
      (v: any) => { v.input.shipping = { amount: "1.00" }; }, // missing fullRefund
    ]) {
      expect(bad(m).ok).toBe(false);
    }
    writeFileSync(join(dir, "bad-doc.graphql"), "query { shop { name } }");
    expect(authorizeSend({ ...sendArgs(dir), docPath: join(dir, "bad-doc.graphql"), outs: [join(dir, "o-doc.json")] }).ok).toBe(false);
    // a different key than the persisted one refuses
    writeFileSync(join(dir, "badkey-vars.json"), JSON.stringify(campaignVarsFor("99999999-9999-4999-8999-999999999999", "1.00")));
    expect(authorizeSend({ ...sendArgs(dir), varsPath: join(dir, "badkey-vars.json"), outs: [join(dir, "o-k.json")] }).ok).toBe(false);
  });
  it("refuses when an output already exists (no overwrite of mutation responses)", () => {
    const dir = seedDir();
    seedBaseline(dir);
    writeFileSync(join(dir, "e7-1-concurrent-A.json"), "{}");
    const r = authorizeSend(sendArgs(dir));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("already exists");
  });
  it("refuses outputs outside the evidence dir", () => {
    const dir = seedDir();
    seedBaseline(dir);
    const r = authorizeSend({ ...sendArgs(dir), outs: [join(tmpdir(), "escape.json")] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("outside the evidence dir");
  });
});

describe("verifiedBaseline", () => {
  it("requires existence, the right order, manifest coverage and shape", () => {
    const dir = seedDir();
    expect(verifiedBaseline(dir, CAMPAIGN_ORDER_GID).ok).toBe(false);
    seedBaseline(dir);
    expect(verifiedBaseline(dir, CAMPAIGN_ORDER_GID).ok).toBe(true);
    expect(verifiedBaseline(dir, "gid://shopify/Order/1").ok).toBe(false);
  });
});

describe("decideBaseline (pre-send gate in the read-back runner)", () => {
  const good = { guardVerdict: "PASS" as const, reconcileOk: true, refundsComplete: true, transactionsComplete: true, totalsParseable: true };
  it("persists only when every gate passes", () => {
    expect(decideBaseline(good).persist).toBe(true);
  });
  it.each([
    ["guard FAIL", { ...good, guardVerdict: "FAIL" as const }],
    ["guard INCOMPLETE", { ...good, guardVerdict: "INCOMPLETE" as const }],
    ["reconcile invalid", { ...good, reconcileOk: false }],
    ["refunds unprovable", { ...good, refundsComplete: false }],
    ["transactions unprovable", { ...good, transactionsComplete: false }],
    ["unreadable totals", { ...good, totalsParseable: false }],
  ])("refuses: %s", (_n, opts) => {
    expect(decideBaseline(opts).persist).toBe(false);
  });
});

describe("initCampaign persistence", () => {
  it("persists the key once and never regenerates or rewrites", () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-e7-init-"));
    writeFileSync(join(dir, "e7-refund-literal-template.graphql"),
      readFileSync(join(SRC_DIR, "e7-refund-literal-template.graphql"), "utf8"));
    const a = initCampaign(dir);
    expect(a.reused).toBe(false);
    const before = readFileSync(join(dir, "e7-vars-1.00.json"), "utf8");
    writeFileSync(join(dir, "e7-vars-1.00.json"), "TAMPERED");
    const b = initCampaign(dir);
    expect(b.reused).toBe(true);
    expect(b.key).toBe(a.key);
    expect(readFileSync(join(dir, "e7-vars-1.00.json"), "utf8")).toBe("TAMPERED");
    expect(readFileSync(join(dir, "e7-idempotency-key.txt"), "utf8").trim()).toBe(a.key);
    void before;
  });
});
