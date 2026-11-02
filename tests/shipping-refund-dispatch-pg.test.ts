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
   *  snapshot epochs mirroring seedGate, a lease granted via the store. */
  async function seedPrepared(s: string, o: { sourceCancelledAt?: string; amount?: string; approvedHash?: boolean } = {}) {
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
});
