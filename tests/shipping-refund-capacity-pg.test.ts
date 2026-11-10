// §4.6/§4.7/§8.4-N5 capacity, breaker and waiting semantics on a real
// disposable PostgreSQL database: capacity refusals always WAIT (row
// unchanged PREPARED/QUEUED, backoff <= 15 min, attempts untouched, zero
// Shopify reads and zero mutations), eligibility/horizon refusals always
// ABORT, and infrastructure failures are no-decisions. Direct drivers:
// preparedCapacityPrecheck, prefreezeCapacityPrecheck,
// leasePreparedShippingRefund and openDispatchGate; representative cases
// also run the full dispatch cycle under a counting fake admin — fake
// admin clients only, no Shopify calls.
//   MERGESHIP_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:PORT/mergeship_test_x \
//   MERGESHIP_SHADOW_TOKEN=<token> npx vitest run tests/shipping-refund-capacity-pg.test.ts
//
// Wait ordering (both prechecks): breaker -> shop 24h cap -> global 24h
// cap -> approval presence/hash -> currency -> cap formats -> per-refund
// cap. Every wait needs prior dispatched rows RESOLVED first (the breaker
// is global and checked first), and a resolved row's dispatchedAt still
// counts toward the trailing-24h caps.
//
// COVERAGE NOTES:
//   - Malformed non-NULL maxRefundMinor and plannedShippingMinor values are
//     format-CHECK-bound; updates to populated frozen columns are also
//     write-once-trigger-bound. A legally NULL plannedShippingMinor on a
//     PREPARED row DOES reach WAIT:APPROVAL_MALFORMED_CAP, tested below.
//   - Trailing-24h dispatch cap ageing is a real but untested time boundary.
//     dispatchedAt is write-once, so immediate test backdating is forbidden;
//     the row can still age out of the count through elapsed time.
//   - A T3 bad-lane refusal is not constructible through valid database
//     states: lane is immutable and dispatch-path statuses require EXECUTE.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { preflightDisposableDatabase } from "./helpers/disposable-db";
import {
  leasePreparedShippingRefund,
  openDispatchGate,
  preparedCapacityPrecheck,
  prefreezeCapacityPrecheck,
} from "../app/lib/shipping-refund-dispatch.server";
import { runShippingRefundDispatchCycle } from "../app/lib/shipping-refund-worker.server";
import { runShippingRefundAdmissionScan } from "../app/lib/shipping-refund-admission.server";
import {
  r2HappyAdmin,
  r2RoutingAdmin,
  r2RecheckBody,
  r2ShadowOrderBody,
  r2ShadowPreviewBody,
  seedPreparedR2Row,
  seedShippingR2Gate,
  seedShippingR2MergeOp,
  type R2Admin,
  type R2Evidence,
  type SeedR2RowResult,
} from "./helpers/shipping-refund-r2-fixture";

const TEST_URL = process.env.MERGESHIP_TEST_DATABASE_URL;
const oid = (n: number) => `gid://shopify/Order/${n}`;
const txnGid = (n: number) => `gid://shopify/OrderTransaction/${n}`;
const refundGid = (n: number) => `gid://shopify/Refund/${n}`;
const naive = (iso: string) => Prisma.sql`(${iso}::timestamptz AT TIME ZONE 'UTC')`;

describe.skipIf(!TEST_URL)("shipping-refund capacity & waiting (real disposable database)", () => {
  let db: PrismaClient;
  let seq = 900_000_000 + Math.floor(Math.random() * 900_000_000);

  beforeAll(async () => {
    await preflightDisposableDatabase(TEST_URL!);
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: TEST_URL! }, stdio: "pipe" });
    db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
  }, 120_000);
  afterAll(async () => { await db?.$disconnect(); });

  const resolveInflightDispatches = async () => {
    // Rows are append-only and the breaker is GLOBAL: any unresolved
    // dispatched row would trip every later test's T3. Park through legal
    // transitions only.
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='IN_DOUBT',"responseKind"='TRANSPORT',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "status"='DISPATCHING'`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='REVIEW_REQUIRED',"reasonCode"='TEST_CLEANUP',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "status" IN ('IN_DOUBT','REFUND_RECORDED')`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='RESOLVED',"resolvedBy"='test',"resolvedAt"=clock_timestamp() AT TIME ZONE 'UTC',"resolution"='cleanup',"resolutionNote"='x',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "status"='REVIEW_REQUIRED'`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='ABORTED',"reasonCode"='TEST_CLEANUP',"leaseToken"=NULL,"leasedUntil"=NULL,"nextCheckAt"=NULL,"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "status"='PREPARED'`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='SKIPPED',"reasonCode"='TEST_CLEANUP',"leaseToken"=NULL,"leasedUntil"=NULL,"nextCheckAt"=NULL,"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "status"='QUEUED'`;
  };
  beforeEach(async () => {
    process.env.MERGESHIP_SHIPPING_REFUNDS = "enabled";
    await resolveInflightDispatches();
  });
  afterEach(async () => {
    delete process.env.MERGESHIP_SHIPPING_REFUNDS;
    await resolveInflightDispatches();
    await db.$executeRaw`UPDATE "ShippingExecuteControl" SET
      "admissionEnabled"=false,"admissionEnabledAt"=NULL,
      "dispatchEnabled"=false,"dispatchEnabledAt"=NULL,
      "globalDailyCap"=0,"note"='S1-A: seeded fully off',
      "updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "id"='control'`;
    await db.$executeRaw`UPDATE "AppControl" SET
      "shippingAdjustmentsEnabled"=false,"shippingEnabledAt"=NULL,
      "shippingAllowShops"='{}'::text[] WHERE "id"='control'`;
    await db.$executeRaw`DELETE FROM "ShippingExecuteApproval" WHERE "approvedBy"='r2-test'`;
    await db.$executeRaw`DELETE FROM "ShippingExecuteApproval" WHERE "approvedBy"='op'`;
  });

  const shop = () => `cap-${randomUUID()}.myshopify.com`;

  // ── Seeding and observation helpers ──────────────────────────────────

  interface Seeded {
    row: SeedR2RowResult;
    opId: string;
    ev: R2Evidence;
  }

  async function seedScenario(
    s: string,
    o: {
      gate?: Parameters<typeof seedShippingR2Gate>[2];
      evidence?: Partial<R2Evidence>;
      approvedHash?: boolean;
      preparedOverrides?: Parameters<typeof seedPreparedR2Row>[1]["preparedOverrides"];
    } = {},
  ): Promise<Seeded> {
    await seedShippingR2Gate(db, s, o.gate);
    const ids = {
      sourceOrderId: oid(++seq),
      primaryOrderId: oid(++seq),
      captureTxnId: txnGid(++seq),
      authTxnId: txnGid(++seq),
    };
    const opId = await seedShippingR2MergeOp(db, {
      shop: s,
      primaryId: ids.primaryOrderId,
      secondaryId: ids.sourceOrderId,
    });
    const row = await seedPreparedR2Row(db, {
      shop: s,
      mergeOperationId: opId,
      evidence: { ...ids, ...o.evidence },
      approvedHash: o.approvedHash,
      preparedOverrides: o.preparedOverrides,
    });
    return { row, opId, ev: row.evidence };
  }

  const rowSnapshot = async (id: string) =>
    (
      await db.$queryRaw<
        {
          status: string;
          reasonCode: string | null;
          reviewReason: string | null;
          attempts: number;
          nextCheckAt: Date | null;
          dispatchedAt: Date | null;
          dispatchToken: string | null;
          refundId: string | null;
          wireVariables: string;
          wireHash: string | null;
          idempotencyKey: string;
          marker: string;
          documentSha256: string | null;
          mutationVersion: string | null;
          plannedShippingMinor: string | null;
          currencyCode: string | null;
        }[]
      >`SELECT "status","reasonCode","reviewReason","attempts","nextCheckAt",
               "dispatchedAt","dispatchToken","refundId",
               "wireVariables"::text AS "wireVariables","wireHash","idempotencyKey",
               "marker","documentSha256","mutationVersion","plannedShippingMinor",
               "currencyCode"
        FROM "ShippingRefund" WHERE "id" = ${id}`
    )[0];

  const FROZEN_KEYS = [
    "wireVariables",
    "wireHash",
    "idempotencyKey",
    "marker",
    "documentSha256",
    "mutationVersion",
    "plannedShippingMinor",
    "currencyCode",
  ] as const;

  const expectUntouched = (
    before: Awaited<ReturnType<typeof rowSnapshot>>,
    after: Awaited<ReturnType<typeof rowSnapshot>>,
  ) => {
    expect(after.dispatchedAt).toBeNull();
    expect(after.dispatchToken).toBeNull();
    expect(after.refundId).toBeNull();
    expect(after.attempts).toBe(before.attempts);
    for (const k of FROZEN_KEYS) expect(after[k], `frozen column ${k}`).toEqual(before[k]);
  };

  const runCycle = (admin: R2Admin["admin"]) =>
    runShippingRefundDispatchCycle({
      db,
      adminFactory: async () => admin,
      sessionLoader: async () => ({ expires: new Date("2030-01-10T00:00:00Z") }),
    });

  const lease = async (rowId: string) => {
    const l = await leasePreparedShippingRefund(rowId, {}, db);
    if (!l.leased) throw new Error(`seed lease failed: ${l.reason}`);
    return l.leaseToken;
  };

  /** Drive a seeded PREPARED row through a real T3 and park it at the
   *  requested post-dispatch status using only legal transitions. The
   *  row's dispatchedAt stays set: it counts toward the 24h caps and —
   *  unless VERIFIED/RESOLVED — trips the breaker. */
  async function dispatchedBlocker(
    s: string,
    to: "DISPATCHING" | "IN_DOUBT" | "REFUND_RECORDED" | "REVIEW_REQUIRED" | "VERIFIED" | "RESOLVED",
  ): Promise<string> {
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    const leaseToken = await lease(seeded.row.id);
    const t3 = await openDispatchGate(seeded.row.id, leaseToken, {}, db);
    if (t3.kind !== "PERMIT") throw new Error(`blocker T3 failed: ${JSON.stringify(t3)}`);
    const id = seeded.row.id;
    const wall = `clock_timestamp() AT TIME ZONE 'UTC'`;
    if (to === "DISPATCHING") return id;
    if (to === "IN_DOUBT") {
      await db.$executeRawUnsafe(
        `UPDATE "ShippingRefund" SET "status"='IN_DOUBT',"responseKind"='TRANSPORT',"respondedAt"=${wall},"updatedAt"=${wall} WHERE "id"='${id}'`,
      );
      return id;
    }
    // DISPATCHING -> REFUND_RECORDED needs the refund id + response evidence.
    await db.$executeRawUnsafe(
      `UPDATE "ShippingRefund" SET "status"='REFUND_RECORDED',"refundId"='${refundGid(++seq)}',"responseKind"='ACCEPTED',"respondedAt"=${wall},"refundCreatedAt"=${wall},"updatedAt"=${wall} WHERE "id"='${id}'`,
    );
    if (to === "REFUND_RECORDED") return id;
    if (to === "VERIFIED") {
      await db.$executeRawUnsafe(
        `UPDATE "ShippingRefund" SET "status"='VERIFIED',"settlementState"='SUCCESS',"settlementCheckAt"=${wall},"verifiedEvidence"='{"probe":"test"}'::jsonb,"verifiedAt"=${wall},"updatedAt"=${wall} WHERE "id"='${id}'`,
      );
      return id;
    }
    await db.$executeRawUnsafe(
      `UPDATE "ShippingRefund" SET "status"='REVIEW_REQUIRED',"reasonCode"='TEST_BLOCKER',"updatedAt"=${wall} WHERE "id"='${id}'`,
    );
    if (to === "REVIEW_REQUIRED") return id;
    await db.$executeRawUnsafe(
      `UPDATE "ShippingRefund" SET "status"='RESOLVED',"resolvedBy"='test',"resolvedAt"=${wall},"resolution"='cleanup',"resolutionNote"='x',"updatedAt"=${wall} WHERE "id"='${id}'`,
    );
    return id;
  }

  /** A never-dispatched terminal row: inserted QUEUED (which the insert
   *  trigger allows) and driven to a terminal status through a legal
   *  transition. `dispatchedAt` is NULL forever — it can never trip the
   *  breaker and never counts toward the caps. */
  async function insertTerminalRow(
    s: string,
    to: "ABORTED" | "SKIPPED" | "INELIGIBLE" | "REVIEW_REQUIRED" | "OBSERVED",
  ): Promise<string> {
    const id = `sr_${randomUUID().replace(/-/g, "")}`;
    const key = randomUUID();
    const lane = to === "OBSERVED" ? "OBSERVE" : "EXECUTE";
    const dispatchEpoch = to === "OBSERVED" ? null : "2030-01-05T00:00:00Z";
    await db.$executeRaw`
      INSERT INTO "ShippingRefund" (
        "id","shop","mergeOperationId","sourceOrderId","primaryOrderId","primaryOrderName",
        "operationCreatedAt","sourceCancelledAt","lane","status",
        "merchantEpochAt","rolloutEpochAt","switchEpochAt","activationCutoffAt",
        "admissionEpochAt","admissionCutoffAt","dispatchEpochAtAdmission",
        "approvalApprovedAt","approvalOptInEpoch","approvalAckVersion",
        "policyKind","idempotencyKey","marker"
      ) VALUES (
        ${id}, ${s}, ${"mo_" + id}, ${oid(++seq)}, ${oid(++seq)}, '#P1',
        ${naive("2030-01-06T00:00:00Z")}, ${naive("2030-01-06T00:00:00Z")}, ${lane}, 'QUEUED',
        ${naive("2030-01-01T00:00:00Z")}, ${naive("2030-01-02T00:00:00Z")},
        ${naive("2030-01-03T00:00:00Z")}, ${naive("2030-01-03T00:00:00Z")},
        ${naive("2030-01-04T00:00:00Z")}, ${naive("2030-01-05T00:00:00Z")},
        ${dispatchEpoch === null ? null : naive(dispatchEpoch)},
        ${naive("2030-01-05T00:00:00Z")}, ${naive("2030-01-01T00:00:00Z")},
        'v1', 'REFUND_ALL', ${key}, ${`MS-SHIPREFUND-${key}`}
      )`;
    await db.$executeRawUnsafe(
      `UPDATE "ShippingRefund" SET "status"='${to}',"reasonCode"='TEST_BLOCKER',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "id"='${id}'`,
    );
    return id;
  }

  /** Shared WAIT driver at T3: lease, mutate live state, open the gate —
   *  the row must stay PREPARED with every frozen column identical. */
  async function expectWait(s: Seeded, reason: string, mutate?: () => Promise<unknown>) {
    const leaseToken = await lease(s.row.id);
    const before = await rowSnapshot(s.row.id);
    if (mutate) await mutate();
    const t3 = await openDispatchGate(s.row.id, leaseToken, {}, db);
    expect(t3).toEqual({ kind: "WAIT", reason });
    const after = await rowSnapshot(s.row.id);
    expect(after.status).toBe("PREPARED");
    expectUntouched(before, after);
    return t3;
  }

  // ── 1. Positive control ──────────────────────────────────────────────

  it("control: the unmutated seed proceeds at the precheck and mints a PERMIT at T3", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    expect(await preparedCapacityPrecheck(seeded.row.id, db)).toEqual({ proceed: true });
    const leaseToken = await lease(seeded.row.id);
    const t3 = await openDispatchGate(seeded.row.id, leaseToken, {}, db);
    expect(t3.kind).toBe("PERMIT");
  });

  // ── 2. Per-refund cap and currency pin (4.6, 4.6.1, I29) ─────────────

  it("planned 400 vs maxRefundMinor 399 waits PER_REFUND_CAP at precheck and T3; equal (400) permits", async () => {
    const s = shop();
    const capped = await seedScenario(s, { gate: { autoApprove: true, maxMinor: "399" } });
    expect(await preparedCapacityPrecheck(capped.row.id, db)).toEqual({
      wait: true,
      reason: "PER_REFUND_CAP",
    });
    await expectWait(capped, "PER_REFUND_CAP");
    // Boundary: the cap is inclusive — planned == max is admitted.
    const equal = await seedScenario(shop(), { gate: { autoApprove: true, maxMinor: "400" } });
    expect(await preparedCapacityPrecheck(equal.row.id, db)).toEqual({ proceed: true });
    const lt = await lease(equal.row.id);
    expect((await openDispatchGate(equal.row.id, lt, {}, db)).kind).toBe("PERMIT");
  });

  it("a currency-pinned approval (EUR vs row USD) waits CURRENCY_MISMATCH at precheck and T3", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true, approvalCurrency: "EUR" } });
    expect(await preparedCapacityPrecheck(seeded.row.id, db)).toEqual({
      wait: true,
      reason: "CURRENCY_MISMATCH",
    });
    await expectWait(seeded, "CURRENCY_MISMATCH");
  });

  it("a NULL plannedShippingMinor on a legal PREPARED row waits APPROVAL_MALFORMED_CAP at precheck, T3 and in the cycle", async () => {
    const s = shop();
    // The column is NULL-able by design (ShippingRefund_plannedShippingMinor_format
    // is `IS NULL OR ~ '...'`), so a PREPARED row may legitimately carry
    // NULL — the §4.6.1 format check then classifies it malformed, a WAIT.
    const seeded = await seedScenario(s, {
      gate: { autoApprove: true, dailyCap: 1_000_000, globalCap: 1_000_000 },
      preparedOverrides: { plannedShippingMinor: null },
    });
    const before = await rowSnapshot(seeded.row.id);
    expect(before.plannedShippingMinor).toBeNull();
    // (a) preparedCapacityPrecheck: every earlier gate satisfied
    // (no breaker, high caps, autoApprove hash, matching currency) — the
    // asserted reason can ONLY be the malformed-cap guard.
    expect(await preparedCapacityPrecheck(seeded.row.id, db)).toEqual({
      wait: true,
      reason: "APPROVAL_MALFORMED_CAP",
    });
    // (b) direct T3 under a real lease: same WAIT, no permit, nothing written.
    const leaseToken = await lease(seeded.row.id);
    const t3 = await openDispatchGate(seeded.row.id, leaseToken, {}, db);
    expect(t3).toEqual({ kind: "WAIT", reason: "APPROVAL_MALFORMED_CAP" });
    let after = await rowSnapshot(seeded.row.id);
    expect(after.status).toBe("PREPARED");
    expectUntouched(before, after);
    // (c) the whole worker cycle: the capacity precheck precedes every
    // Shopify read — zero reads, zero mutations, row still PREPARED.
    await db.$executeRaw`UPDATE "ShippingRefund" SET "leaseToken"=NULL,"leasedUntil"=NULL WHERE "id"=${seeded.row.id}`;
    const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
    const report = await runCycle(admin.admin);
    expect(report.outcomes["WAIT:APPROVAL_MALFORMED_CAP"]).toBe(1);
    expect(admin.allCalls()).toBe(0);
    expect(admin.mutationCalls()).toBe(0);
    after = await rowSnapshot(seeded.row.id);
    expect(after.status).toBe("PREPARED");
    expect(after.plannedShippingMinor).toBeNull(); // NULL before AND after
    expectUntouched(before, after);
    // Positive control: the identical row with a valid amount permits.
    const ok = await seedScenario(shop(), { gate: { autoApprove: true } });
    const lt = await lease(ok.row.id);
    expect((await openDispatchGate(ok.row.id, lt, {}, db)).kind).toBe("PERMIT");
    await resolveInflightDispatches();
  });

  it("malformed minor-unit values are rejected by the named format CHECKs — and a write-once update is trigger rejection, not a CHECK", async () => {
    const s = shop();
    await seedScenario(s, { gate: { autoApprove: true } });
    // Mutable approval columns: the format CHECK fires directly and the
    // error names the constraint, proving WHICH guard rejected the write.
    for (const bad of ["4.00", "-1", "", "01", "abc", "9".repeat(41)]) {
      await expect(
        db.$executeRaw`UPDATE "ShippingExecuteApproval" SET "maxRefundMinor"=${bad} WHERE "shop"=${s}`,
        `maxRefundMinor ${JSON.stringify(bad)}`,
      ).rejects.toThrow(/ShippingExecuteApproval_maxRefundMinor_format/);
    }
    await expect(
      db.$executeRaw`UPDATE "ShippingExecuteApproval" SET "dailyCap"=-1 WHERE "shop"=${s}`,
    ).rejects.toThrow(/ShippingExecuteApproval_dailyCap/);
    // The row side reaches the CHECK only through a legal NULL -> value
    // write-once transition: a NULL-planned PREPARED row accepts the
    // column write (the frozen trigger permits NULL -> value) and the
    // format CHECK then names itself on a malformed value.
    const nullSeeded = await seedScenario(shop(), {
      gate: { autoApprove: true },
      preparedOverrides: { plannedShippingMinor: null },
    });
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "plannedShippingMinor"='4.00' WHERE "id"=${nullSeeded.row.id}`,
    ).rejects.toThrow(/ShippingRefund_plannedShippingMinor_format/);
    // On an already-populated row the same UPDATE is rejected by the
    // write-once TRIGGER instead — "write-once column changed", never the
    // CHECK name — so a bare rejects.toThrow() alone would not prove the
    // format guard fired.
    const normal = await seedScenario(shop(), { gate: { autoApprove: true } });
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "plannedShippingMinor"='4.00' WHERE "id"=${normal.row.id}`,
    ).rejects.toThrow(/write-once column changed/);
    // A malformed maxRefundMinor can never be stored (CHECK-bound), so
    // APPROVAL_MALFORMED_CAP is reachable only via the row's
    // plannedShippingMinor — which is NULL-able by design.
  });
  it.todo("trailing-24h cap ageing boundary (untested time boundary): dispatchedAt is write-once so it cannot be backdated — the window only ages with real elapsed time; covering it needs a controllable database clock or a >24 h wait. Deliberately NOT adding a production clock hook for this test-only change");

  // ── 3. Operator hash approval (4.6) ──────────────────────────────────

  it("a missing operator hash approval waits HASH_APPROVAL_MISSING at precheck and T3", async () => {
    const s = shop();
    // autoApprove false and no approvedWireHash recorded.
    const seeded = await seedScenario(s, { gate: { autoApprove: false } });
    expect(await preparedCapacityPrecheck(seeded.row.id, db)).toEqual({
      wait: true,
      reason: "HASH_APPROVAL_MISSING",
    });
    await expectWait(seeded, "HASH_APPROVAL_MISSING");
  });

  // CANDIDATE DEFECT (reviewer-confirmed; do NOT fix here): the design
  // intends a missing approval row to classify HASH_APPROVAL_MISSING —
  // the code even carries `if (!ap) return { wait: true, reason:
  // "HASH_APPROVAL_MISSING" }` — but the earlier shop-cap check reads
  // `ap?.dailyCap ?? 0` = 0 and `count >= 0` is always true, so
  // SHOP_CAP_REACHED fires first at BOTH prechecks AND inside T3's wait
  // path: the dedicated branch is unreachable and the worker's capacity
  // precheck reports the WAIT before the GATE_CLOSED-on-approval gate-
  // recheck abort can ever be reached — so the designed gate-change
  // abort can be delayed until the seven-day horizon expires the row.
  // No unauthorized-refund bypass was demonstrated (every path still
  // waits with zero sends); the wrong classification needs a separate
  // production fix and independent review. it.fails documents the
  // designed verdict as a live tripwire.
  it.fails("a deleted approval row should wait HASH_APPROVAL_MISSING (currently reports SHOP_CAP_REACHED)", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    await db.$executeRaw`DELETE FROM "ShippingExecuteApproval" WHERE "shop"=${s}`;
    expect(await preparedCapacityPrecheck(seeded.row.id, db)).toEqual({
      wait: true,
      reason: "HASH_APPROVAL_MISSING",
    });
  });

  it("a deleted approval row still waits (never sends) — SHOP_CAP_REACHED is the observed reason today", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    const leaseToken = await lease(seeded.row.id);
    const before = await rowSnapshot(seeded.row.id);
    await db.$executeRaw`DELETE FROM "ShippingExecuteApproval" WHERE "shop"=${s}`;
    // The precheck waits (SHOP_CAP_REACHED — see the it.fails defect
    // marker above); inside T3 the missing approval is a gate closure.
    expect(await preparedCapacityPrecheck(seeded.row.id, db)).toMatchObject({ wait: true });
    const t3 = await openDispatchGate(seeded.row.id, leaseToken, {}, db);
    expect(t3).toEqual({ kind: "ABORTED", reasonCode: "GATE_CHANGED" });
    const after = await rowSnapshot(seeded.row.id);
    expect(after.status).toBe("ABORTED");
    expect(after.reviewReason).toContain("approval");
    expectUntouched(before, after);
  });

  // ── 4. Daily caps (4.6) ──────────────────────────────────────────────

  it("the per-shop 24h cap waits SHOP_CAP_REACHED; a resolved dispatch still counts", async () => {
    const s = shop();
    // One dispatch consumed and resolved — its dispatchedAt still counts
    // toward the trailing-24h shop total.
    const blockerShop = s;
    await dispatchedBlocker(blockerShop, "RESOLVED");
    const seeded = await seedScenario(s, { gate: { autoApprove: true, dailyCap: 1 } });
    expect(await preparedCapacityPrecheck(seeded.row.id, db)).toEqual({
      wait: true,
      reason: "SHOP_CAP_REACHED",
    });
    await expectWait(seeded, "SHOP_CAP_REACHED");
    // A different shop is unaffected by this shop's cap.
    const other = await seedScenario(shop(), { gate: { autoApprove: true, dailyCap: 100 } });
    expect(await preparedCapacityPrecheck(other.row.id, db)).toEqual({ proceed: true });
  });

  it("the global 24h cap binds across shops as GLOBAL_CAP_REACHED", async () => {
    const s = shop();
    await dispatchedBlocker(shop(), "RESOLVED"); // resolved: clears the breaker, still counts globally
    const seeded = await seedScenario(s, { gate: { autoApprove: true, globalCap: 1, dailyCap: 1_000_000 } });
    expect(await preparedCapacityPrecheck(seeded.row.id, db)).toEqual({
      wait: true,
      reason: "GLOBAL_CAP_REACHED",
    });
    await expectWait(seeded, "GLOBAL_CAP_REACHED");
  });

  // ── 5. The financial breaker (4.7, I11) ──────────────────────────────

  it.each(["DISPATCHING", "IN_DOUBT", "REFUND_RECORDED", "REVIEW_REQUIRED"] as const)(
    "a dispatched row in %s trips the breaker at the precheck and inside T3",
    async (to) => {
      const s = shop();
      const blockerId = await dispatchedBlocker(shop(), to);
      try {
        const seeded = await seedScenario(s, { gate: { autoApprove: true } });
        expect(await preparedCapacityPrecheck(seeded.row.id, db)).toEqual({
          wait: true,
          reason: "BREAKER_TRIPPED",
        });
        expect(await prefreezeCapacityPrecheck(s, db)).toEqual({
          wait: true,
          reason: "BREAKER_TRIPPED",
        });
        await expectWait(seeded, "BREAKER_TRIPPED");
      } finally {
        await resolveInflightDispatches();
      }
      expect(blockerId).toBeTruthy();
    },
  );

  it("VERIFIED and RESOLVED dispatched rows do NOT trip the breaker", async () => {
    const s = shop();
    await dispatchedBlocker(shop(), "VERIFIED");
    await dispatchedBlocker(shop(), "RESOLVED");
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    expect(await preparedCapacityPrecheck(seeded.row.id, db)).toEqual({ proceed: true });
    const lt = await lease(seeded.row.id);
    expect((await openDispatchGate(seeded.row.id, lt, {}, db)).kind).toBe("PERMIT");
  });

  it("never-dispatched terminal rows (ABORTED, SKIPPED, INELIGIBLE, OBSERVED, REVIEW_REQUIRED) never trip the breaker", async () => {
    const s = shop();
    for (const to of ["ABORTED", "SKIPPED", "INELIGIBLE", "REVIEW_REQUIRED", "OBSERVED"] as const) {
      await insertTerminalRow(s, to);
    }
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    expect(await preparedCapacityPrecheck(seeded.row.id, db)).toEqual({ proceed: true });
    expect(await prefreezeCapacityPrecheck(s, db)).toEqual({ proceed: true });
  });

  // ── 6. The pre-freeze precheck consults ONLY breaker and daily caps ──

  it("prefreezeCapacityPrecheck consults only the breaker and daily caps — hostile approval fields still proceed", async () => {
    const s = shop();
    await seedShippingR2Gate(db, s, {
      autoApprove: false,
      maxMinor: "0", // would refuse every PREPARED dispatch post-freeze
      approvalCurrency: "EUR",
      dailyCap: 1_000_000,
    });
    // autoApprove=false, maxRefundMinor='0', currency mismatch — all
    // post-freeze concerns the pre-freeze precheck must NOT consult. With
    // a high dailyCap and no breaker it still proceeds.
    expect(await prefreezeCapacityPrecheck(s, db)).toEqual({ proceed: true });
    // No approval row at all means dailyCap defaults to 0 (§4.6): the
    // shop-cap check legitimately waits — approval presence itself is a
    // post-freeze/gate matter, not consulted here.
    await db.$executeRaw`DELETE FROM "ShippingExecuteApproval" WHERE "shop"=${s}`;
    expect(await prefreezeCapacityPrecheck(s, db)).toEqual({
      wait: true,
      reason: "SHOP_CAP_REACHED",
    });
  });

  it("prefreezeCapacityPrecheck waits on the shop cap and the global cap only", async () => {
    const s = shop();
    await dispatchedBlocker(s, "RESOLVED"); // one 24h dispatch on this shop
    await seedShippingR2Gate(db, s, { autoApprove: true, dailyCap: 1 });
    expect(await prefreezeCapacityPrecheck(s, db)).toEqual({
      wait: true,
      reason: "SHOP_CAP_REACHED",
    });
    await db.$executeRaw`UPDATE "ShippingExecuteApproval" SET "dailyCap"=1000000 WHERE "shop"=${s}`;
    await db.$executeRaw`UPDATE "ShippingExecuteControl" SET "globalDailyCap"=1 WHERE "id"='control'`;
    expect(await prefreezeCapacityPrecheck(s, db)).toEqual({
      wait: true,
      reason: "GLOBAL_CAP_REACHED",
    });
  });

  // ── 7. Waiting rows (§8.4 N5): waits never abort, never consume attempts ──

  it("a PREPARED row waiting >24h under a tripped breaker stays PREPARED across cycles, then resumes on the same row", async () => {
    const s = shop();
    const blockerId = await dispatchedBlocker(shop(), "DISPATCHING");
    // The row has been PREPARED for more than a day (preparedAt is
    // write-once: it can only be backdated at the freeze update itself).
    const backdated = new Date(Date.now() - 25 * 3_600_000).toISOString();
    const seeded = await seedScenario(s, {
      gate: { autoApprove: true },
      preparedOverrides: { preparedAt: backdated },
      evidence: { cancelledAt: new Date(Date.now() - 2 * 86_400_000).toISOString() },
    });
    const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
    for (let cycle = 0; cycle < 3; cycle++) {
      const before = await rowSnapshot(seeded.row.id);
      const report = await runCycle(admin.admin);
      const after = await rowSnapshot(seeded.row.id);
      expect(report.outcomes["WAIT:BREAKER_TRIPPED"]).toBe(1);
      expect(admin.allCalls()).toBe(0); // capacity precedes every Shopify read
      expect(after.status).toBe("PREPARED");
      expect(after.attempts).toBe(before.attempts); // no attempt consumed
      // The backoff is at most 15 minutes ahead — never a stale abort.
      expect(after.nextCheckAt).not.toBeNull();
      expect(after.nextCheckAt!.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 5_000);
      expectUntouched(before, after);
      // Force the row due again to simulate the next sweep.
      await db.$executeRaw`UPDATE "ShippingRefund" SET "nextCheckAt"=NULL,"leaseToken"=NULL,"leasedUntil"=NULL WHERE "id"=${seeded.row.id}`;
    }
    // Clear the blocker through the legal transitions, make the SAME row
    // due, and it resumes: fresh R2 reads, exactly one mutation.
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='IN_DOUBT',"responseKind"='TRANSPORT',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "id"=${blockerId}`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='REVIEW_REQUIRED',"reasonCode"='TEST',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "id"=${blockerId}`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='RESOLVED',"resolvedBy"='t',"resolvedAt"=clock_timestamp() AT TIME ZONE 'UTC',"resolution"='x',"resolutionNote"='x',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "id"=${blockerId}`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "nextCheckAt"=NULL,"leaseToken"=NULL,"leasedUntil"=NULL WHERE "id"=${seeded.row.id}`;
    const before = await rowSnapshot(seeded.row.id);
    const report = await runCycle(admin.admin);
    expect(report.outcomes["DISPATCHED:ACCEPTED"]).toBe(1);
    expect(admin.mutationCalls()).toBe(1);
    expect(admin.allCalls()).toBeGreaterThan(0); // fresh R2 recheck + evaluator reads
    const docs = admin.calls.map((c) => c.doc);
    expect(docs.some((d) => d.includes("source") || d.includes("Recheck"))).toBe(true);
    expect(docs.some((d) => d.includes("Shadow"))).toBe(true);
    const after = await rowSnapshot(seeded.row.id);
    expect(after.status).toBe("REFUND_RECORDED");
    expect(after.attempts).toBe(before.attempts); // the resume consumed no extra attempt
    // The row really was >24 h old when it dispatched — preparedAt kept
    // the backdated write-once value.
    const [{ ageOk }] = await db.$queryRaw<{ ageOk: boolean }[]>`
      SELECT "preparedAt" < (clock_timestamp() AT TIME ZONE 'UTC' - interval '24 hours') AS "ageOk"
      FROM "ShippingRefund" WHERE "id"=${seeded.row.id}`;
    expect(ageOk).toBe(true);
    for (const k of FROZEN_KEYS) expect(after[k], `frozen column ${k}`).toEqual(before[k]);
  });

  it("a QUEUED EXECUTE row waiting under a tripped breaker is released with backoff and never evaluated", async () => {
    const s = shop();
    await seedShippingR2Gate(db, s, { autoApprove: true });
    // A due, unleased QUEUED EXECUTE row — what the scan's Part A selects.
    // Its mergeOperationId/sourceOrderId/primaryOrderId mirror the seeded
    // operation's own secondary/primary so the fixture is internally
    // consistent (no merge-evidence issue unrelated to the breaker wait).
    const primaryId = oid(++seq);
    const secondaryId = oid(++seq);
    const opId = await seedShippingR2MergeOp(db, { shop: s, primaryId, secondaryId });
    const rowId = `sr_${randomUUID().replace(/-/g, "")}`;
    const key = randomUUID();
    await db.$executeRaw`
      INSERT INTO "ShippingRefund" (
        "id","shop","mergeOperationId","sourceOrderId","primaryOrderId","primaryOrderName",
        "operationCreatedAt","sourceCancelledAt","lane","status",
        "merchantEpochAt","rolloutEpochAt","switchEpochAt","activationCutoffAt",
        "admissionEpochAt","admissionCutoffAt","dispatchEpochAtAdmission",
        "approvalApprovedAt","approvalOptInEpoch","approvalAckVersion",
        "policyKind","idempotencyKey","marker"
      ) VALUES (
        ${rowId}, ${s}, ${opId}, ${secondaryId}, ${primaryId}, '#P1',
        ${naive("2030-01-06T00:00:00Z")}, ${naive(new Date(Date.now() - 2 * 86_400_000).toISOString())},
        'EXECUTE', 'QUEUED',
        ${naive("2030-01-01T00:00:00Z")}, ${naive("2030-01-02T00:00:00Z")},
        ${naive("2030-01-03T00:00:00Z")}, ${naive("2030-01-03T00:00:00Z")},
        ${naive("2030-01-04T00:00:00Z")}, ${naive("2030-01-05T00:00:00Z")},
        ${naive("2030-01-05T00:00:00Z")},
        ${naive("2030-01-05T00:00:00Z")}, ${naive("2030-01-01T00:00:00Z")},
        'v1', 'REFUND_ALL', ${key}, ${`MS-SHIPREFUND-${key}`}
      )`;
    // Trip the global breaker on another shop, then restore the claim
    // shop's allowlist membership (the blocker seed overwrites it), then
    // run a real admission scan: the pre-freeze precheck must release the
    // row with backoff — QUEUED, attempts untouched, zero Shopify reads.
    const blockerShop = shop();
    await dispatchedBlocker(blockerShop, "DISPATCHING");
    await db.$executeRaw`UPDATE "AppControl" SET "shippingAllowShops"=ARRAY[${s},${blockerShop}]::text[] WHERE "id"='control'`;
    const admin = r2RoutingAdmin({});
    const reports = await runShippingRefundAdmissionScan(
      [s],
      {
        adminFactory: async () => admin.admin,
        sessionLoader: async () => ({ expires: new Date("2030-01-10T00:00:00Z") }),
      },
      db,
    );
    expect(
      reports[0].dueRowsExamined,
      JSON.stringify({ gateOpen: reports[0].gateOpen, stoppedBy: reports[0].stoppedBy, outcomes: reports[0].outcomes }),
    ).toBe(1);
    expect(reports[0].outcomes["WAIT:BREAKER_TRIPPED"]).toBe(1);
    expect(admin.allCalls()).toBe(0);
    // The QUEUED row's fixture is internally consistent (real seeded
    // MergeOperation/MergeRecord for its sourceOrderId/primaryOrderId):
    // the scan surfaces no malformed-operation entries and no
    // merge-evidence outcome — the only refusal is the breaker wait.
    expect(reports[0].malformed).toEqual([]);
    expect(Object.keys(reports[0].outcomes).filter((k) => k.includes("EVIDENCE"))).toEqual([]);
    const [row] = await db.$queryRaw<{ status: string; attempts: number; nextCheckAt: Date | null }[]>`
      SELECT "status","attempts","nextCheckAt" FROM "ShippingRefund" WHERE "id"=${rowId}`;
    expect(row.status).toBe("QUEUED");
    expect(row.attempts).toBe(0);
    expect(row.nextCheckAt).not.toBeNull();
    expect(row.nextCheckAt!.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 5_000);
    await resolveInflightDispatches();
  });

  it("a waiting PREPARED row RESUMES once capacity frees — fresh R2 reads, then exactly one mutation", async () => {
    const s = shop();
    const blockerId = await dispatchedBlocker(shop(), "DISPATCHING");
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
    // Cycle 1: the breaker waits the row before any Shopify read.
    let report = await runCycle(admin.admin);
    expect(report.outcomes["WAIT:BREAKER_TRIPPED"]).toBe(1);
    expect(admin.allCalls()).toBe(0);
    expect((await rowSnapshot(seeded.row.id)).status).toBe("PREPARED");
    // Free the breaker and force the row due.
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='IN_DOUBT',"responseKind"='TRANSPORT',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "id"=${blockerId}`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='REVIEW_REQUIRED',"reasonCode"='T',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "id"=${blockerId}`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='RESOLVED',"resolvedBy"='t',"resolvedAt"=clock_timestamp() AT TIME ZONE 'UTC',"resolution"='x',"resolutionNote"='x',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "id"=${blockerId}`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "nextCheckAt"=NULL,"leaseToken"=NULL,"leasedUntil"=NULL WHERE "id"=${seeded.row.id}`;
    // Cycle 2: full R2 (recheck + evaluator documents) then one send.
    report = await runCycle(admin.admin);
    expect(admin.mutationCalls()).toBe(1);
    expect(admin.allCalls()).toBeGreaterThan(0);
    const docs = admin.calls.map((c) => c.doc);
    expect(docs.some((d) => d.includes("ShippingRefundExecRecheck") || d.includes("source"))).toBe(true);
    expect(docs.some((d) => d.includes("ShippingShadowSource") || d.includes("ShippingShadowPreview") || d.includes("suggestedRefund"))).toBe(true);
    expect(report.outcomes["DISPATCHED:ACCEPTED"]).toBe(1);
    expect((await rowSnapshot(seeded.row.id)).status).toBe("REFUND_RECORDED");
  });

  it("between cycles, drifted evidence aborts DRIFT_BEFORE_DISPATCH with zero sends", async () => {
    const s = shop();
    const blockerId = await dispatchedBlocker(shop(), "DISPATCHING");
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
    await runCycle(admin.admin); // waits on the breaker, zero reads
    expect(admin.allCalls()).toBe(0);
    // Free the breaker but drift the evaluator's shipping evidence.
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='IN_DOUBT',"responseKind"='TRANSPORT',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "id"=${blockerId}`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='REVIEW_REQUIRED',"reasonCode"='T',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "id"=${blockerId}`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='RESOLVED',"resolvedBy"='t',"resolvedAt"=clock_timestamp() AT TIME ZONE 'UTC',"resolution"='x',"resolutionNote"='x',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "id"=${blockerId}`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "nextCheckAt"=NULL,"leaseToken"=NULL,"leasedUntil"=NULL WHERE "id"=${seeded.row.id}`;
    const drift = { ...seeded.ev, shippingAmount: "5.00" };
    const admin2 = r2RoutingAdmin({
      recheck: () => r2RecheckBody(seeded.ev),
      order: () => r2ShadowOrderBody(drift),
      preview: () => r2ShadowPreviewBody(drift),
    });
    const report = await runCycle(admin2.admin);
    expect(admin2.mutationCalls()).toBe(0);
    expect(report.outcomes["ABORTED:DRIFT_BEFORE_DISPATCH"]).toBe(1);
    const after = await rowSnapshot(seeded.row.id);
    expect(after.status).toBe("ABORTED");
    expect(after.dispatchedAt).toBeNull();
  });

  it("between cycles, a cycled dispatch epoch aborts GATE_CHANGED inside T3", async () => {
    const s = shop();
    const blockerId = await dispatchedBlocker(shop(), "DISPATCHING");
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
    await runCycle(admin.admin);
    expect(admin.allCalls()).toBe(0);
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='IN_DOUBT',"responseKind"='TRANSPORT',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "id"=${blockerId}`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='REVIEW_REQUIRED',"reasonCode"='T',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "id"=${blockerId}`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='RESOLVED',"resolvedBy"='t',"resolvedAt"=clock_timestamp() AT TIME ZONE 'UTC',"resolution"='x',"resolutionNote"='x',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "id"=${blockerId}`;
    // Cycle the dispatch switch: the live epoch no longer equals the snapshot.
    await db.$executeRaw`UPDATE "ShippingExecuteControl" SET "dispatchEnabled"=false,"dispatchEnabledAt"=NULL WHERE "id"='control'`;
    await db.$executeRaw`UPDATE "ShippingExecuteControl" SET "dispatchEnabled"=true,"dispatchEnabledAt"=${naive("2030-01-05T06:00:00Z")} WHERE "id"='control'`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "nextCheckAt"=NULL,"leaseToken"=NULL,"leasedUntil"=NULL WHERE "id"=${seeded.row.id}`;
    const report = await runCycle(admin.admin);
    expect(admin.mutationCalls()).toBe(0);
    expect(report.outcomes["ABORTED:GATE_CHANGED"]).toBe(1);
    const after = await rowSnapshot(seeded.row.id);
    expect(after.status).toBe("ABORTED");
    expect(after.reasonCode).toBe("GATE_CHANGED");
    expect(after.reviewReason).toContain("dispatchEpochAtAdmission");
    expect(after.dispatchedAt).toBeNull();
  });

  // ── 8. The seven-day horizon (8.4): the only age-based abort ─────────

  it("just outside the horizon aborts HORIZON_EXPIRED at the lease, the precheck and inside T3 — never waits", async () => {
    const s = shop();
    // 7 days + 1 hour before the DB wall clock.
    const cancelled = new Date(Date.now() - (7 * 24 + 1) * 3_600_000).toISOString();
    const seeded = await seedScenario(s, {
      gate: { autoApprove: true },
      evidence: { cancelledAt: cancelled },
    });
    // At the lease itself.
    const l = await leasePreparedShippingRefund(seeded.row.id, {}, db);
    expect(l).toEqual({ leased: false, reason: "HORIZON_EXPIRED" });
    let after = await rowSnapshot(seeded.row.id);
    expect(after.status).toBe("ABORTED");
    expect(after.reasonCode).toBe("HORIZON_EXPIRED");
    // A second identically seeded row: the precheck aborts.
    const seeded2 = await seedScenario(shop(), {
      gate: { autoApprove: true },
      evidence: { cancelledAt: cancelled },
    });
    expect(await preparedCapacityPrecheck(seeded2.row.id, db)).toEqual({
      abort: true,
      reason: "HORIZON_EXPIRED",
    });
    // And inside T3 with a lease stamped directly (a lease acquired
    // before the boundary passed).
    await db.$executeRaw`UPDATE "ShippingRefund" SET "leaseToken"='held',"leasedUntil"=clock_timestamp() AT TIME ZONE 'UTC' + interval '1 hour' WHERE "id"=${seeded2.row.id}`;
    const t3 = await openDispatchGate(seeded2.row.id, "held", {}, db);
    expect(t3).toEqual({ kind: "ABORTED", reasonCode: "HORIZON_EXPIRED" });
    after = await rowSnapshot(seeded2.row.id);
    expect(after.status).toBe("ABORTED");
    expect(after.dispatchedAt).toBeNull();
    expect(after.dispatchToken).toBeNull();
  });

  it("just inside the horizon still dispatches normally", async () => {
    const s = shop();
    // 7 days minus 1 hour — inside the boundary by a safe margin.
    const cancelled = new Date(Date.now() - (7 * 24 - 1) * 3_600_000).toISOString();
    const seeded = await seedScenario(s, {
      gate: { autoApprove: true },
      evidence: { cancelledAt: cancelled },
    });
    expect(await preparedCapacityPrecheck(seeded.row.id, db)).toEqual({ proceed: true });
    const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
    const report = await runCycle(admin.admin);
    expect(admin.mutationCalls()).toBe(1);
    expect(report.outcomes["DISPATCHED:ACCEPTED"]).toBe(1);
    expect((await rowSnapshot(seeded.row.id)).status).toBe("REFUND_RECORDED");
  });
});
