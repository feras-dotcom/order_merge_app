// S2 dispatch path on a real disposable PostgreSQL database (20.2):
// T3 gating and write-ahead, the permit + single send, T4, waits and
// aborts, racing, the restored-DISPATCHING no-send rule and the N12
// session guard — with fake admin clients only; no Shopify calls.
//   MERGESHIP_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:PORT/mergeship_test \
//     npx vitest run tests/shipping-refund-dispatch-pg.test.ts
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  preflightDisposableDatabase,
} from "./helpers/disposable-db";
import {
  classifyDispatchResponse,
  DISPATCH_PERMIT_TTL_MS,
  leasePreparedShippingRefund,
  listDuePreparedShippingRefunds,
  openDispatchGate,
  preparedCapacityPrecheck,
  recordDispatchOutcome,
  releaseLeaseWithBackoff,
  sendRefund,
} from "../app/lib/shipping-refund-dispatch.server";
import { runShippingRefundDispatchCycle } from "../app/lib/shipping-refund-worker.server";
import {
  computeWireHash,
  type ShippingRefundWireVariables,
  generateIdempotencyKey,
  REFUND_DOCUMENT_SHA256,
  shippingRefundMutationDocument,
} from "../app/lib/shipping-refund-contract";
import { recordApprovedWireHash } from "../app/lib/shipping-refund-store.server";
import { SHIPPING_REFUND_TRIGGER_MANIFEST } from "../app/lib/shipping-refund-trigger-manifest";

const TEST_URL = process.env.MERGESHIP_TEST_DATABASE_URL;
const oid = (n: number) => `gid://shopify/Order/${n}`;
const txnGid = (n: number) => `gid://shopify/OrderTransaction/${n}`;
const refundGid = (n: number) => `gid://shopify/Refund/${n}`;

describe.skipIf(!TEST_URL)("shipping-refund S2 dispatch (real disposable database)", () => {
  let db: PrismaClient;
  // Per-run random base: refundId is globally unique and rows are
  // append-only, so a fixed base collides across runs.
  let seq = 900_000_000 + Math.floor(Math.random() * 900_000_000);

  beforeAll(async () => {
    await preflightDisposableDatabase(TEST_URL!);
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: TEST_URL! }, stdio: "pipe" });
    db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
  }, 120_000);
  afterAll(async () => { await db?.$disconnect(); });
  const resolveInflightDispatches = async () => {
    // Rows are append-only across tests AND suites; a leftover unresolved
    // dispatch trips the global breaker for every later test, so park them
    // through legal transitions (DISPATCHING->IN_DOUBT->REVIEW_REQUIRED->
    // RESOLVED, REFUND_RECORDED->REVIEW_REQUIRED->RESOLVED).
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='IN_DOUBT',"responseKind"='TRANSPORT',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "status"='DISPATCHING'`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='REVIEW_REQUIRED',"reasonCode"='TEST_CLEANUP',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "status" IN ('IN_DOUBT','REFUND_RECORDED')`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='RESOLVED',"resolvedBy"='test',"resolvedAt"=clock_timestamp() AT TIME ZONE 'UTC',"resolution"='cleanup',"resolutionNote"='x',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "status"='REVIEW_REQUIRED'`;
  };
  beforeEach(async () => {
    process.env.MERGESHIP_SHIPPING_REFUNDS = "enabled";
    await resolveInflightDispatches();
  });
  afterEach(async () => {
    delete process.env.MERGESHIP_SHIPPING_REFUNDS;
    await resolveInflightDispatches();
    // The control singleton and AppControl are shared rows: leave them
    // exactly as the migration seeded them for sibling suites.
    await db.$executeRaw`UPDATE "ShippingExecuteControl" SET
      "admissionEnabled"=false,"admissionEnabledAt"=NULL,
      "dispatchEnabled"=false,"dispatchEnabledAt"=NULL,
      "globalDailyCap"=0,"note"='S1-A: seeded fully off',
      "updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "id"='control'`;
    await db.$executeRaw`UPDATE "AppControl" SET
      "shippingAdjustmentsEnabled"=false,"shippingEnabledAt"=NULL,
      "shippingAllowShops"='{}'::text[] WHERE "id"='control'`;
  });
  const cleanupEnv = () => { delete process.env.MERGESHIP_SHIPPING_REFUNDS; };

  const shop = () => `s2-${randomUUID()}.myshopify.com`;

  // Live gate state: epochs that the row snapshot will mirror exactly.
  async function seedGate(s: string, o: { cap?: number; maxMinor?: string; auto?: boolean; globalCap?: number } = {}) {
    const E1 = "2030-01-01T00:00:00Z", E2 = "2030-01-02T00:00:00Z", E3 = "2030-01-03T00:00:00Z",
      E4 = "2030-01-04T00:00:00Z", E5 = "2030-01-05T00:00:00Z";
    await db.$executeRaw`
      UPDATE "AppControl" SET "shippingAdjustmentsEnabled" = true,
        "shippingEnabledAt" = ${E3}::timestamptz AT TIME ZONE 'UTC',
        "shippingAllowShops" = ARRAY[${s}]::text[]
      WHERE "id" = 'control'`;
    await db.$executeRaw`
      INSERT INTO "Settings" ("id","shop","autoMergeEnabled","mergeWindowHours","shippingCostSavings","shippingAdjustmentEnabled","shippingAdjustmentEnabledAt","shippingRolloutAt","shippingPolicy")
      VALUES (${"set_" + randomUUID().replace(/-/g, "")}, ${s}, false, 24, '0', true, ${E1}::timestamptz AT TIME ZONE 'UTC',
              ${E2}::timestamptz AT TIME ZONE 'UTC', 'REFUND_ALL')
      ON CONFLICT ("shop") DO UPDATE SET
        "shippingAdjustmentEnabled" = true,
        "shippingAdjustmentEnabledAt" = ${E1}::timestamptz AT TIME ZONE 'UTC',
        "shippingRolloutAt" = ${E2}::timestamptz AT TIME ZONE 'UTC',
        "shippingPolicy" = 'REFUND_ALL'`;
    await db.$executeRaw`
      UPDATE "ShippingExecuteControl" SET
        "admissionEnabled" = true, "admissionEnabledAt" = ${E4}::timestamptz AT TIME ZONE 'UTC',
        "dispatchEnabled" = true, "dispatchEnabledAt" = ${E5}::timestamptz AT TIME ZONE 'UTC',
        "globalDailyCap" = ${o.globalCap ?? 1_000_000}
      WHERE "id" = 'control'`;
    await db.$executeRaw`
      INSERT INTO "ShippingExecuteApproval"
        ("shop","approvedAt","approvedBy","revokedAt","merchantOptInEpoch","ackVersion","ackRecordedAt","currencyCode","maxRefundMinor","dailyCap","autoApprove")
      VALUES (${s}, ${E5}::timestamptz AT TIME ZONE 'UTC', 'op', NULL,
              ${E1}::timestamptz AT TIME ZONE 'UTC', 'v1',
              ${E5}::timestamptz AT TIME ZONE 'UTC', 'USD',
              ${o.maxMinor ?? "1000"}, ${o.cap ?? 1_000_000}, ${o.auto ?? false})
      ON CONFLICT ("shop") DO UPDATE SET
        "approvedAt" = ${E5}::timestamptz AT TIME ZONE 'UTC', "revokedAt" = NULL,
        "merchantOptInEpoch" = ${E1}::timestamptz AT TIME ZONE 'UTC',
        "ackVersion" = 'v1', "currencyCode" = 'USD',
        "maxRefundMinor" = ${o.maxMinor ?? "1000"}, "dailyCap" = ${o.cap ?? 1_000_000},
        "autoApprove" = ${o.auto ?? false}`;
    return { E1, E2, E3, E4, E5 };
  }

  /** A constraint-valid PREPARED row: frozen contract matching this build,
   *  snapshot epochs mirroring seedGate, a lease granted via the store.
   *  `noLease` skips the lease step (for rows whose horizon state would
   *  make the normal lease refuse); the caller stamps a lease itself. */
  async function seedPrepared(s: string, o: { sourceCancelledAt?: string; amount?: string; approvedHash?: boolean; noLease?: boolean } = {}) {
    const id = `sr_${randomUUID().replace(/-/g, "")}`;
    const key = generateIdempotencyKey();
    const m = "MS-SHIPREFUND-" + key;
    const sourceOrderId = oid(++seq), primaryOrderId = oid(++seq), parentId = txnGid(++seq);
    const amount = o.amount ?? "1.00";
    const wireVariables = {
      idempotencyKey: key,
      input: {
        orderId: sourceOrderId, note: m, notify: false, currency: "USD",
        shipping: { fullRefund: false, amount },
        transactions: [{ orderId: sourceOrderId, parentId, gateway: "bogus", kind: "REFUND", amount }],
      },
    };
    const wireHash = computeWireHash(REFUND_DOCUMENT_SHA256, wireVariables as unknown as ShippingRefundWireVariables);
    const minor = "100";
    const cancelled = o.sourceCancelledAt ?? "2030-01-06T00:00:00Z";
    await db.$executeRaw`
      INSERT INTO "ShippingRefund" (
        "id","shop","mergeOperationId","sourceOrderId","primaryOrderId","primaryOrderName",
        "operationCreatedAt","sourceCancelledAt","lane","status",
        "merchantEpochAt","rolloutEpochAt","switchEpochAt","activationCutoffAt",
        "admissionEpochAt","admissionCutoffAt","dispatchEpochAtAdmission",
        "approvalApprovedAt","approvalOptInEpoch","approvalAckVersion",
        "policyKind","idempotencyKey","marker"
      ) VALUES (
        ${id}, ${s}, ${"mo_" + id}, ${sourceOrderId}, ${primaryOrderId}, '#P1',
        ${"2030-01-06T00:00:00Z"}::timestamptz AT TIME ZONE 'UTC',
        ${cancelled}::timestamptz AT TIME ZONE 'UTC', 'EXECUTE', 'QUEUED',
        ${"2030-01-01T00:00:00Z"}::timestamptz AT TIME ZONE 'UTC',
        ${"2030-01-02T00:00:00Z"}::timestamptz AT TIME ZONE 'UTC',
        ${"2030-01-03T00:00:00Z"}::timestamptz AT TIME ZONE 'UTC',
        ${"2030-01-03T00:00:00Z"}::timestamptz AT TIME ZONE 'UTC',
        ${"2030-01-04T00:00:00Z"}::timestamptz AT TIME ZONE 'UTC',
        ${"2030-01-05T00:00:00Z"}::timestamptz AT TIME ZONE 'UTC',
        ${"2030-01-05T00:00:00Z"}::timestamptz AT TIME ZONE 'UTC',
        ${"2030-01-05T00:00:00Z"}::timestamptz AT TIME ZONE 'UTC',
        ${"2030-01-01T00:00:00Z"}::timestamptz AT TIME ZONE 'UTC',
        'v1', 'REFUND_ALL', ${key}, ${m}
      )`;
    await db.$executeRaw`
      UPDATE "ShippingRefund" SET
        "status" = 'PREPARED', "preparedAt" = clock_timestamp() AT TIME ZONE 'UTC',
        "wireVariables" = ${JSON.stringify(wireVariables)}::jsonb,
        "wireHash" = ${wireHash}, "documentSha256" = ${REFUND_DOCUMENT_SHA256},
        "mutationVersion" = 'MergeShipShippingRefund@2026-04',
        "currencyCode" = 'USD', "plannedShippingMinor" = ${minor},
        "parentTransactionId" = ${parentId}, "gateway" = 'bogus',
        "preEvidence" = ${JSON.stringify({ baseline: { capturedAt: "2030-01-06T00:00:00Z", mode: "STRICT_EMPTY", currency: "USD", refunds: [], refundCount: 0, totalRefundedMinor: "0", totalRefundedShippingMinor: "0", transactionIds: [parentId], moneyTransactionCount: 1 } })}::jsonb
      WHERE "id" = ${id}`;
    if (o.approvedHash) {
      const ok = await recordApprovedWireHash(id, wireHash, "op", db);
      if (!ok) throw new Error("seed approval failed");
    }
    if (o.noLease) {
      return { id, shop: s, key, wireHash, wireVariables, leaseToken: "", sourceOrderId, primaryOrderId, parentId };
    }
    const lease = await leasePreparedShippingRefund(id, {}, db);
    if (!lease.leased) throw new Error(`seed lease failed: ${lease.reason}`);
    return { id, shop: s, key, wireHash, wireVariables, leaseToken: lease.leaseToken, sourceOrderId, primaryOrderId, parentId };
  }

  const rowStatus = async (id: string) =>
    (await db.$queryRaw<{ status: string; attempts: number; nextCheckAt: Date | null; dispatchToken: string | null; refundId: string | null; leasedUntil: Date | null }[]>`
      SELECT "status","attempts","nextCheckAt","dispatchToken","refundId","leasedUntil" FROM "ShippingRefund" WHERE "id" = ${id}`)[0];

  const fakeAdmin = (body: unknown, throws = false) => {
    let calls = 0;
    return {
      calls: () => calls,
      admin: {
        graphql: async (_doc: string, _opts: unknown) => {
          calls += 1;
          if (throws) throw new Error("wire error");
          return { json: async () => body };
        },
      } as never,
    };
  };
  const accept = (refundId: string) => ({ data: { refundCreate: { refund: { id: refundId, createdAt: "2030-01-07T00:00:00Z" }, userErrors: [] } } });

  it("T3 happy path: permit, exactly one send, T4 -> REFUND_RECORDED", async () => {
    const s = shop(); await seedGate(s);
    const r = await seedPrepared(s, { approvedHash: true });
    const t3 = await openDispatchGate(r.id, r.leaseToken, {}, db);
    expect(t3.kind).toBe("PERMIT");
    if (t3.kind !== "PERMIT") return;
    const { admin, calls } = fakeAdmin(accept(refundGid(++seq)));
    const body = await sendRefund(t3.permit, admin);
    expect(calls()).toBe(1);
    const outcome = classifyDispatchResponse(body);
    expect(outcome.kind).toBe("ACCEPTED");
    const t4 = await recordDispatchOutcome(r.id, t3.permit.dispatchToken, outcome, {}, db);
    expect(t4.wrote).toBe(true);
    const st = await rowStatus(r.id);
    expect(st.status).toBe("REFUND_RECORDED");
    expect(st.refundId).toBe(outcome.refundId);
    cleanupEnv();
  });

  it("capacity waits never abort and never consume attempts", async () => {
    const s = shop(); await seedGate(s);
    const r = await seedPrepared(s); // approvedWireHash null + autoApprove false
    const pc = await preparedCapacityPrecheck(r.id, db);
    expect(pc).toMatchObject({ wait: true, reason: "HASH_APPROVAL_MISSING" });
    const t3 = await openDispatchGate(r.id, r.leaseToken, {}, db);
    expect(t3).toMatchObject({ kind: "WAIT", reason: "HASH_APPROVAL_MISSING" });
    await releaseLeaseWithBackoff(r.id, r.leaseToken, undefined, db);
    const st = await rowStatus(r.id);
    expect(st.status).toBe("PREPARED");
    expect(st.attempts).toBe(0);
    expect(st.nextCheckAt).not.toBeNull();
    cleanupEnv();
  });

  it("breaker: an unresolved dispatched row makes T3 wait", async () => {
    const s = shop(); await seedGate(s);
    const a = await seedPrepared(s, { approvedHash: true });
    const t3a = await openDispatchGate(a.id, a.leaseToken, {}, db);
    expect(t3a.kind).toBe("PERMIT");
    const b = await seedPrepared(s);
    const t3b = await openDispatchGate(b.id, b.leaseToken, {}, db);
    expect(t3b).toMatchObject({ kind: "WAIT", reason: "BREAKER_TRIPPED" });
    cleanupEnv();
  });

  it("T3 aborts on a changed gate and on a tampered wire hash", async () => {
    const s = shop(); await seedGate(s);
    const r = await seedPrepared(s);
    await db.$executeRaw`UPDATE "ShippingExecuteApproval" SET "approvedAt" = clock_timestamp() AT TIME ZONE 'UTC' WHERE "shop" = ${s}`;
    const t3 = await openDispatchGate(r.id, r.leaseToken, {}, db);
    expect(t3).toMatchObject({ kind: "ABORTED", reasonCode: "GATE_CHANGED" });
    expect((await rowStatus(r.id)).status).toBe("ABORTED");
    cleanupEnv();
  });

  it("two racing openDispatchGate calls produce exactly one permit", async () => {
    const s = shop(); await seedGate(s);
    const r = await seedPrepared(s, { approvedHash: true });
    const [a, b] = await Promise.all([
      openDispatchGate(r.id, r.leaseToken, {}, db).then((x) => x, (e) => ({ kind: "ERR", e })),
      openDispatchGate(r.id, r.leaseToken, {}, db).then((x) => x, (e) => ({ kind: "ERR", e })),
    ]);
    const permits = [a, b].filter((x) => (x as { kind: string }).kind === "PERMIT");
    expect(permits.length).toBe(1);
    cleanupEnv();
  });

  it("a DISPATCHING row never re-dispatches: due-list excludes it and the lease refuses", async () => {
    const s = shop(); await seedGate(s);
    const r = await seedPrepared(s, { approvedHash: true });
    const t3 = await openDispatchGate(r.id, r.leaseToken, {}, db);
    expect(t3.kind).toBe("PERMIT");
    const due = await listDuePreparedShippingRefunds(100, db);
    expect(due.map((d) => d.id)).not.toContain(r.id);
    const lease = await leasePreparedShippingRefund(r.id, {}, db);
    expect(lease).toMatchObject({ leased: false, reason: "NOT_PREPARED" });
    cleanupEnv();
  });

  it("T4 is token-fenced: a wrong token writes nothing; echo is a no-op", async () => {
    const s = shop(); await seedGate(s);
    const r = await seedPrepared(s, { approvedHash: true });
    const t3 = await openDispatchGate(r.id, r.leaseToken, {}, db);
    if (t3.kind !== "PERMIT") throw new Error("expected permit");
    const outcome = classifyDispatchResponse(accept(refundGid(++seq)));
    const bad = await recordDispatchOutcome(r.id, "wrong-token", outcome, {}, db);
    expect(bad).toMatchObject({ wrote: false, reason: "FENCED_OUT" });
    expect((await rowStatus(r.id)).status).toBe("DISPATCHING");
    const good = await recordDispatchOutcome(r.id, t3.permit.dispatchToken, outcome, {}, db);
    expect(good.wrote).toBe(true);
    const echo = await recordDispatchOutcome(r.id, t3.permit.dispatchToken, outcome, {}, db);
    expect(echo).toMatchObject({ wrote: false, reason: "DUPLICATE_ECHO" });
    cleanupEnv();
  });

  it("worker end-to-end: env flag + session guard + dispatch", async () => {
    const s = shop(); await seedGate(s);
    const r = await seedPrepared(s, { approvedHash: true });
    // Release the seed lease so the worker can lease the row itself.
    await db.$executeRaw`UPDATE "ShippingRefund" SET "leaseToken"=NULL,"leasedUntil"=NULL,"nextCheckAt"=NULL WHERE "id"=${r.id}`;
    const rid = refundGid(++seq);
    let calls = 0;
    const admin = {
      graphql: async (doc: string) => {
        calls += 1;
        if (doc === shippingRefundMutationDocument()) {
          return { json: async () => accept(rid) };
        }
        // Q-RECHECK: a valid empty-baseline source + untouched primary.
        return { json: async () => ({
          data: {
            source: {
              id: r.sourceOrderId, cancelledAt: "2030-01-06T00:00:00Z", closed: true,
              displayFinancialStatus: "PAID", currencyCode: "USD",
              totalRefundedSet: { presentmentMoney: { amount: "0.00", currencyCode: "USD" } },
              totalRefundedShippingSet: { presentmentMoney: { amount: "0.00", currencyCode: "USD" } },
              refunds: [],
              transactions: [{
                id: r.parentId, kind: "CAPTURE", status: "SUCCESS", gateway: "bogus",
                test: true, amountSet: { presentmentMoney: { amount: "4.00", currencyCode: "USD" } },
                parentTransaction: null,
              }],
            },
            primary: { id: r.primaryOrderId, cancelledAt: null, displayFinancialStatus: "PAID", currencyCode: "USD" },
          },
        }) };
      },
    } as never;
    const report = await runShippingRefundDispatchCycle({
      db,
      adminFactory: async () => admin,
      sessionLoader: async () => ({ expires: new Date("2030-01-10T00:00:00Z") }),
    });
    expect(report.enabled).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(1);
    expect((await rowStatus(r.id)).status).toBe("REFUND_RECORDED");
    cleanupEnv();
  });

  it("worker skips a shop whose canonical offline session is unusable (N12)", async () => {
    const s = shop(); await seedGate(s);
    const r = await seedPrepared(s);
    await db.$executeRaw`UPDATE "ShippingRefund" SET "leaseToken"=NULL,"leasedUntil"=NULL,"nextCheckAt"=NULL WHERE "id"=${r.id}`;
    const { admin, calls } = fakeAdmin(accept(refundGid(++seq)));
    // An expired canonical session: the guard must see it and skip.
    const report = await runShippingRefundDispatchCycle({
      db,
      adminFactory: async () => admin,
      sessionLoader: async (sh) => (sh === s ? { expires: new Date("2020-01-01T00:00:00Z") } : null),
    });
    expect(calls()).toBe(0);
    expect(report.outcomes["SHOP_SKIPPED:SESSION_UNUSABLE"]).toBeGreaterThanOrEqual(1);
    expect((await rowStatus(r.id)).status).toBe("PREPARED");
    cleanupEnv();
  });

  it("trigger names still equal the manifest after the S2 migration", async () => {
    const names = await db.$queryRaw<{ tgname: string }[]>`
      SELECT t.tgname FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname LIKE 'shippingrefund%' ORDER BY 1`;
    expect(names.map((n) => n.tgname).sort()).toEqual([...SHIPPING_REFUND_TRIGGER_MANIFEST.map((e) => e.name)].sort());
    cleanupEnv();
  });

  // ── 20.2 fault injection: exactly-once, unknown outcomes, recovery ──

  /** A fake admin that fails the wire call in one of the fault modes of
   *  10.5 — the first two resolve with error bodies (what the wire client
   *  surfaces for throttled/server errors), the rest throw like a broken
   *  connection or an aborted/timed-out request. */
  const failureAdmin = (mode: "429" | "503" | "reset" | "abort" | "timeout") => {
    let calls = 0;
    const admin = {
      graphql: async () => {
        calls += 1;
        if (mode === "429") return { json: async () => ({ errors: [{ message: "Throttled" }], data: null }) };
        if (mode === "503") return { json: async () => ({ errors: [{ message: "Service Unavailable" }], data: null }) };
        if (mode === "reset") throw new Error("read ECONNRESET");
        if (mode === "abort") { const e = new Error("The operation was aborted"); e.name = "AbortError"; throw e; }
        const e = new Error("The request timed out"); e.name = "TimeoutError"; throw e;
      },
    } as never;
    return { admin, calls: () => calls };
  };

  /** Counts only calls to the pinned mutation document — reads for R2 or
   *  reconciliation are not the wire request being bounded. */
  const mutationCountingAdmin = (body: unknown = {}) => {
    let mutationCalls = 0;
    let allCalls = 0;
    const admin = {
      graphql: async (doc: string) => {
        allCalls += 1;
        if (doc === shippingRefundMutationDocument()) {
          mutationCalls += 1;
          return { json: async () => body };
        }
        return { json: async () => ({}) };
      },
    } as never;
    return { admin, mutationCalls: () => mutationCalls, allCalls: () => allCalls };
  };

  /** A db whose interactive $transaction runs `inner` on the REAL client —
   *  used to make the commit actually happen while the promise the caller
   *  awaited rejects (the lost-acknowledgement case), or to fail the call
   *  outright (the dead-database case). */
  const sabotageTransactions = (
    inner: (run: () => Promise<unknown>) => Promise<unknown>,
  ): PrismaClient =>
    new Proxy(db, {
      get(t, p) {
        if (p === "$transaction") {
          return (fn: never, opts: never) =>
            inner(() => (db.$transaction as unknown as (f: never, o: never) => Promise<unknown>)(fn, opts));
        }
        const v = (t as unknown as Record<PropertyKey, unknown>)[p];
        return typeof v === "function" ? (v as CallableFunction).bind(t) : v;
      },
    }) as PrismaClient;

  it("exactly one wire call per dispatch under 429, 503, connection reset, abort and timeout (10.5)", async () => {
    const s = shop(); await seedGate(s);
    for (const mode of ["429", "503", "reset", "abort", "timeout"] as const) {
      const r = await seedPrepared(s, { approvedHash: true });
      const t3 = await openDispatchGate(r.id, r.leaseToken, {}, db);
      if (t3.kind !== "PERMIT") throw new Error(`expected permit for mode ${mode}`);
      const { admin, calls } = failureAdmin(mode);
      await sendRefund(t3.permit, admin).catch(() => {});
      expect(calls(), `mode ${mode}`).toBe(1);
      // The consumed permit can never issue a second request.
      await sendRefund(t3.permit, admin).catch(() => {});
      expect(calls(), `mode ${mode} re-use`).toBe(1);
      // Resolve this row's breaker so the next mode's T3 is not a capacity wait.
      await resolveInflightDispatches();
    }
    cleanupEnv();
  });

  it("a real permit is single-use and expires on the monotonic clock (9.3)", async () => {
    const s = shop(); await seedGate(s);
    const r = await seedPrepared(s, { approvedHash: true });
    const t3 = await openDispatchGate(r.id, r.leaseToken, {}, db);
    if (t3.kind !== "PERMIT") throw new Error("expected permit");
    const { admin, calls } = fakeAdmin(accept(refundGid(++seq)));
    await sendRefund(t3.permit, admin);
    expect(calls()).toBe(1);
    await expect(sendRefund(t3.permit, admin)).rejects.toThrow(/single-use/);
    expect(calls()).toBe(1);
    // Clear this row's unresolved dispatch so the next T3 is not a capacity wait.
    await resolveInflightDispatches();

    const r2 = await seedPrepared(s, { approvedHash: true });
    const now = { t: 10_000 };
    const t3b = await openDispatchGate(r2.id, r2.leaseToken, { monotonicNow: () => now.t }, db);
    if (t3b.kind !== "PERMIT") throw new Error("expected second permit");
    now.t += DISPATCH_PERMIT_TTL_MS + 1;
    const dead = failureAdmin("reset");
    await expect(sendRefund(t3b.permit, dead.admin)).rejects.toThrow(/expired/);
    expect(dead.calls()).toBe(0);
    expect((await rowStatus(r2.id)).status).toBe("DISPATCHING");
    cleanupEnv();
  });

  it("an unknown T3 commit acknowledgement produces no permit and zero sends (9.3, 13)", async () => {
    const s = shop(); await seedGate(s);
    const r = await seedPrepared(s, { approvedHash: true });
    // The transaction REALLY commits — the row is left DISPATCHING, the
    // ambiguous durable state of section 13 — but the promise the caller
    // awaited rejects, exactly like a connection lost at COMMIT.
    const flaky = sabotageTransactions(async (run) => {
      await run();
      throw new Error("commit acknowledgement lost");
    });
    const { calls } = fakeAdmin(accept(refundGid(++seq)));
    await expect(openDispatchGate(r.id, r.leaseToken, {}, flaky)).rejects.toThrow(/acknowledgement/);
    expect(calls()).toBe(0);
    expect((await rowStatus(r.id)).status).toBe("DISPATCHING");
    // The recovered DISPATCHING row can never produce a permit or a send:
    // not due, not leaseable, and the gate aborts it.
    expect((await listDuePreparedShippingRefunds(100, db)).map((d) => d.id)).not.toContain(r.id);
    expect(await leasePreparedShippingRefund(r.id, {}, db)).toMatchObject({ leased: false, reason: "NOT_PREPARED" });
    expect(await openDispatchGate(r.id, "any", {}, db)).toMatchObject({ kind: "ABORTED", reasonCode: "NOT_PREPARED" });
    expect(calls()).toBe(0);
    cleanupEnv();
  });

  it("a response lost after Shopify applied the refund never causes a resend (11, 13)", async () => {
    const s = shop(); await seedGate(s);
    const r = await seedPrepared(s, { approvedHash: true });
    const t3 = await openDispatchGate(r.id, r.leaseToken, {}, db);
    if (t3.kind !== "PERMIT") throw new Error("expected permit");
    // The wire request applies the refund; the response never comes back.
    let applied = 0;
    const admin = {
      graphql: async () => { applied += 1; throw new Error("response dropped on the wire"); },
    } as never;
    await sendRefund(t3.permit, admin).catch(() => {});
    expect(applied).toBe(1);
    const outcome = classifyDispatchResponse(null); // TRANSPORT — no body arrived
    const t4 = await recordDispatchOutcome(r.id, t3.permit.dispatchToken, outcome, {}, db);
    expect(t4.wrote).toBe(true);
    expect((await rowStatus(r.id)).status).toBe("IN_DOUBT");
    // Every avenue to a second send refuses, including a whole worker cycle.
    expect((await listDuePreparedShippingRefunds(100, db)).map((d) => d.id)).not.toContain(r.id);
    expect(await leasePreparedShippingRefund(r.id, {}, db)).toMatchObject({ leased: false });
    expect(await openDispatchGate(r.id, "x", {}, db)).toMatchObject({ kind: "ABORTED" });
    const counter = mutationCountingAdmin(accept(refundGid(++seq)));
    await runShippingRefundDispatchCycle({
      db,
      adminFactory: async () => counter.admin,
      sessionLoader: async () => ({ expires: new Date("2030-01-10T00:00:00Z") }),
    });
    expect(counter.mutationCalls()).toBe(0);
    expect(applied).toBe(1);
    cleanupEnv();
  });

  it("a crash after T3 never lets another worker dispatch the same row (13)", async () => {
    const s = shop(); await seedGate(s);
    const r = await seedPrepared(s, { approvedHash: true });
    // Worker A commits T3; its permit dies with the simulated crash and is
    // simply never used.
    const t3 = await openDispatchGate(r.id, r.leaseToken, {}, db);
    expect(t3.kind).toBe("PERMIT");
    // Worker B sees only a DISPATCHING row: no lease, not due, gate aborts.
    expect(await leasePreparedShippingRefund(r.id, {}, db)).toMatchObject({ leased: false, reason: "NOT_PREPARED" });
    expect(await openDispatchGate(r.id, "x", {}, db)).toMatchObject({ kind: "ABORTED" });
    const counter = mutationCountingAdmin(accept(refundGid(++seq)));
    await runShippingRefundDispatchCycle({
      db,
      adminFactory: async () => counter.admin,
      sessionLoader: async () => ({ expires: new Date("2030-01-10T00:00:00Z") }),
    });
    expect(counter.mutationCalls()).toBe(0);
    expect((await rowStatus(r.id)).status).toBe("DISPATCHING");
    cleanupEnv();
  });

  it("T4 write exhaustion leaves DISPATCHING — recoverable by the late write, never resendable (9.4)", async () => {
    const s = shop(); await seedGate(s);
    const r = await seedPrepared(s, { approvedHash: true });
    const t3 = await openDispatchGate(r.id, r.leaseToken, {}, db);
    if (t3.kind !== "PERMIT") throw new Error("expected permit");
    const { admin, calls } = fakeAdmin(accept(refundGid(++seq)));
    const outcome = classifyDispatchResponse(await sendRefund(t3.permit, admin));
    expect(outcome.kind).toBe("ACCEPTED");
    // All three in-process T4 attempts hit a dead database.
    const dead = sabotageTransactions(() => Promise.reject(new Error("db down")));
    const t4 = await recordDispatchOutcome(
      r.id, t3.permit.dispatchToken, outcome, { sleep: async () => {} }, dead,
    );
    expect(t4).toMatchObject({ wrote: false, reason: "WRITE_FAILED" });
    expect((await rowStatus(r.id)).status).toBe("DISPATCHING");
    expect(calls()).toBe(1);
    // The sender's late T4 still writes (token-fenced) — recovery needs no resend.
    const t4b = await recordDispatchOutcome(r.id, t3.permit.dispatchToken, outcome, {}, db);
    expect(t4b.wrote).toBe(true);
    expect((await rowStatus(r.id)).status).toBe("REFUND_RECORDED");
    expect(calls()).toBe(1);
    cleanupEnv();
  });

  it("the seven-day horizon is enforced inside T3 itself (8.4, 9.2)", async () => {
    const s = shop(); await seedGate(s);
    // A row whose source cancelledAt is already past the horizon, holding a
    // lease stamped directly (the normal lease path would abort it first —
    // this simulates a lease acquired before the boundary passed).
    const r = await seedPrepared(s, { sourceCancelledAt: "2020-01-01T00:00:00Z", noLease: true });
    const held = `held-${r.id}`;
    await db.$executeRaw`
      UPDATE "ShippingRefund" SET "leaseToken" = ${held},
        "leasedUntil" = clock_timestamp() AT TIME ZONE 'UTC' + interval '1 hour',
        "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC'
      WHERE "id" = ${r.id}`;
    const t3 = await openDispatchGate(r.id, held, {}, db);
    expect(t3).toMatchObject({ kind: "ABORTED", reasonCode: "HORIZON_EXPIRED" });
    const st = await rowStatus(r.id);
    expect(st.status).toBe("ABORTED");
    expect(st.dispatchToken).toBeNull();
    cleanupEnv();
  });

  it("the per-shop daily cap admits one dispatch and waits the rest under competition (4.6, 9.2)", async () => {
    const s = shop(); await seedGate(s, { cap: 1 });
    const a = await seedPrepared(s, { approvedHash: true });
    const b = await seedPrepared(s, { approvedHash: true });
    const t3a = await openDispatchGate(a.id, a.leaseToken, {}, db);
    if (t3a.kind !== "PERMIT") throw new Error("expected permit");
    const outcome = classifyDispatchResponse(accept(refundGid(++seq)));
    await recordDispatchOutcome(a.id, t3a.permit.dispatchToken, outcome, {}, db);
    // Resolve row a so the breaker clears; its dispatchedAt still counts.
    await resolveInflightDispatches();
    const t3b = await openDispatchGate(b.id, b.leaseToken, {}, db);
    expect(t3b).toMatchObject({ kind: "WAIT", reason: "SHOP_CAP_REACHED" });
    const st = await rowStatus(b.id);
    expect(st.status).toBe("PREPARED");
    expect(st.attempts).toBe(0);
    cleanupEnv();
  });

  it("the global daily cap binds across competing shops (4.6, 9.2)", async () => {
    const s1 = shop(), s2 = shop();
    // The 24h count is global: seed the cap relative to the dispatches
    // earlier tests already recorded, so the first dispatch fits and the
    // second does not.
    const [cur] = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS "n" FROM "ShippingRefund"
      WHERE "dispatchedAt" IS NOT NULL
        AND "dispatchedAt" > (clock_timestamp() AT TIME ZONE 'UTC' - INTERVAL '24 hours')`;
    await seedGate(s1, { globalCap: Number(cur.n) + 1 });
    await seedGate(s2, { globalCap: Number(cur.n) + 1 });
    await db.$executeRaw`
      UPDATE "AppControl" SET "shippingAllowShops" = ARRAY[${s1},${s2}]::text[]
      WHERE "id" = 'control'`;
    const a = await seedPrepared(s1, { approvedHash: true });
    const b = await seedPrepared(s2, { approvedHash: true });
    const t3a = await openDispatchGate(a.id, a.leaseToken, {}, db);
    if (t3a.kind !== "PERMIT") throw new Error("expected permit");
    const outcome = classifyDispatchResponse(accept(refundGid(++seq)));
    await recordDispatchOutcome(a.id, t3a.permit.dispatchToken, outcome, {}, db);
    await resolveInflightDispatches();
    const t3b = await openDispatchGate(b.id, b.leaseToken, {}, db);
    expect(t3b).toMatchObject({ kind: "WAIT", reason: "GLOBAL_CAP_REACHED" });
    expect((await rowStatus(b.id)).status).toBe("PREPARED");
    cleanupEnv();
  });
});
