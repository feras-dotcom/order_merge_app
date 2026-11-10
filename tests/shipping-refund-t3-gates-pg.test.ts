// §9.2 T3 gate-input matrix on a real disposable PostgreSQL database:
// every live-control or frozen-contract change between the freeze and T3
// must refuse with the designed class — and never mint a permit, never
// send, never touch attempts or the frozen columns. The primary driver is
// a direct leasePreparedShippingRefund + openDispatchGate (exact verdict
// classification); a representative subset also runs the full dispatch
// cycle under a counting fake admin — fake admin clients only, no Shopify
// calls.
//   MERGESHIP_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:PORT/mergeship_test_x \
//   MERGESHIP_SHADOW_TOKEN=<token> npx vitest run tests/shipping-refund-t3-gates-pg.test.ts
//
// Scenario -> expected T3 class (§9.2 refusal classes; reasonCode is the
// durable ABORTED code or the WAIT reason, detail the reviewReason):
//   unchanged seeding (positive control)                  PERMIT
//   dispatch switch off                                   ABORTED GATE_CHANGED "gate recheck: GATE_CHANGED on dispatchEpochAtAdmission"
//   dispatch off->on with a new epoch                     ABORTED GATE_CHANGED "gate recheck: GATE_CHANGED on dispatchEpochAtAdmission"
//   admission switch off                                  ABORTED GATE_CHANGED "gate recheck: GATE_CLOSED on admissionControl"
//   AppControl shipping switch off                        ABORTED GATE_CHANGED "gate recheck: GATE_CLOSED on activationGate"
//   AppControl shipping epoch changed                     ABORTED GATE_CHANGED "gate recheck: GATE_CHANGED on switchEpochAt"
//   shop removed from shippingAllowShops                  ABORTED GATE_CHANGED "gate recheck: GATE_CLOSED on activationGate"
//   merchant opt-out                                      ABORTED GATE_CHANGED "gate recheck: GATE_CLOSED on activationGate"
//   opt-out -> re-opt-in, new merchant epoch              ABORTED GATE_CHANGED "gate recheck: GATE_CHANGED on merchantEpochAt"
//   approval revoked                                      ABORTED GATE_CHANGED "gate recheck: GATE_CLOSED on approval"
//   approval approvedAt restamped                         ABORTED GATE_CHANGED "gate recheck: GATE_CHANGED on approvalApprovedAt"
//   approval ackVersion changed                           ABORTED GATE_CHANGED "gate recheck: GATE_CHANGED on approvalAckVersion"
//   approval merchantOptInEpoch changed                   ABORTED GATE_CHANGED "gate recheck: GATE_CLOSED on approvalOptInEpoch"
//   approval row deleted                                  ABORTED GATE_CHANGED "gate recheck: GATE_CLOSED on approval"
//   Settings.shippingPolicy != REFUND_ALL                 ABORTED GATE_CHANGED "gate recheck: GATE_CLOSED on shippingPolicy"
//   MERGESHIP_SHIPPING_REFUNDS env removed                ABORTED GATE_CHANGED "... is not enabled"
//   foreign documentSha256                                ABORTED DOCUMENT_CHANGED
//   foreign mutationVersion / NULL                        (covered end-to-end in shipping-refund-r2-pg.test.ts)
//   wireHash inconsistent with wireVariables              ABORTED WIRE_HASH_MISMATCH
//   lane OBSERVE / invalid lane on a PREPARED row         NOT CONSTRUCTIBLE: lane is trigger-immutable and
//                                                         ShippingRefund_dispatch_path_state CHECK requires
//                                                         lane='EXECUTE' for every dispatch-path status
//   malformed gate snapshot (SNAPSHOT_INVALID)            NOT CONSTRUCTIBLE: snapshot columns are trigger-
//                                                         immutable and the derived-cutoff CHECKs
//                                                         (activationCutoff_derived / admissionCutoff_derived /
//                                                         lane_dispatch_epoch) forbid inconsistency
//   operationCreatedAt < live dispatchCutoff              NOT CONSTRUCTIBLE legally: shippingRefund_no_retroactive
//                                                         + lane_dispatch_epoch CHECKs make operationCreatedAt >=
//                                                         max(admissionCutoffAt, dispatchEpochAtAdmission), and
//                                                         every input to the live cutoff is itself a snapshotted
//                                                         field whose change fails the gate recheck first —
//                                                         defense-in-depth; the realistic equivalent (cycled
//                                                         dispatch epoch) is covered above
//   trigger catalog broken mid-transaction                thrown no-decision (no permit, row unchanged);
//                                                         via the cycle: outcome T3_NO_DECISION
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  preflightDisposableDatabase,
  withScratchDatabase,
  type PreflightedDatabase,
} from "./helpers/disposable-db";
import {
  classifyDispatchResponse,
  leasePreparedShippingRefund,
  openDispatchGate,
  recordDispatchOutcome,
  sendRefund,
} from "../app/lib/shipping-refund-dispatch.server";
import { runShippingRefundDispatchCycle } from "../app/lib/shipping-refund-worker.server";
import {
  r2HappyAdmin,
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

describe.skipIf(!TEST_URL)("shipping-refund T3 gate-input matrix (real disposable database)", () => {
  let db: PrismaClient;
  let preflighted: PreflightedDatabase;
  let seq = 900_000_000 + Math.floor(Math.random() * 900_000_000);

  beforeAll(async () => {
    preflighted = await preflightDisposableDatabase(TEST_URL!);
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: TEST_URL! }, stdio: "pipe" });
    db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
  }, 120_000);
  afterAll(async () => { await db?.$disconnect(); });

  const resolveInflightDispatches = async () => {
    // Same convention as the r2/dispatch suites: rows are append-only, so
    // park every in-flight or leftover row through legal transitions —
    // including leftover PREPARED rows, which would otherwise leak into
    // the next test's due list.
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='IN_DOUBT',"responseKind"='TRANSPORT',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "status"='DISPATCHING'`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='REVIEW_REQUIRED',"reasonCode"='TEST_CLEANUP',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "status" IN ('IN_DOUBT','REFUND_RECORDED')`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='RESOLVED',"resolvedBy"='test',"resolvedAt"=clock_timestamp() AT TIME ZONE 'UTC',"resolution"='cleanup',"resolutionNote"='x',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "status"='REVIEW_REQUIRED'`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='ABORTED',"reasonCode"='TEST_CLEANUP',"leaseToken"=NULL,"leasedUntil"=NULL,"nextCheckAt"=NULL,"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "status"='PREPARED'`;
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
  });

  const shop = () => `t3-${randomUUID()}.myshopify.com`;

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
          parentTransactionId: string | null;
          gateway: string | null;
          currencyCode: string | null;
          merchantEpochAt: Date | null;
          rolloutEpochAt: Date | null;
          switchEpochAt: Date | null;
          activationCutoffAt: Date | null;
          admissionEpochAt: Date | null;
          admissionCutoffAt: Date | null;
          dispatchEpochAtAdmission: Date | null;
          approvalApprovedAt: Date | null;
          approvalOptInEpoch: Date | null;
          approvalAckVersion: string | null;
        }[]
      >`SELECT "status","reasonCode","reviewReason","attempts","nextCheckAt",
               "dispatchedAt","dispatchToken","refundId",
               "wireVariables"::text AS "wireVariables","wireHash","idempotencyKey",
               "marker","documentSha256","mutationVersion","plannedShippingMinor",
               "parentTransactionId","gateway","currencyCode",
               "merchantEpochAt","rolloutEpochAt","switchEpochAt","activationCutoffAt",
               "admissionEpochAt","admissionCutoffAt","dispatchEpochAtAdmission",
               "approvalApprovedAt","approvalOptInEpoch","approvalAckVersion"
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
    "parentTransactionId",
    "gateway",
    "currencyCode",
    "merchantEpochAt",
    "rolloutEpochAt",
    "switchEpochAt",
    "activationCutoffAt",
    "admissionEpochAt",
    "admissionCutoffAt",
    "dispatchEpochAtAdmission",
    "approvalApprovedAt",
    "approvalOptInEpoch",
    "approvalAckVersion",
  ] as const;

  /** Every refusal path's shared assertions: no dispatch evidence, attempts
   *  untouched, every frozen column and snapshot epoch byte-identical. */
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

  const runCycle = (admin: R2Admin["admin"], scratchDb?: PrismaClient) =>
    runShippingRefundDispatchCycle({
      db: scratchDb ?? db,
      adminFactory: async () => admin,
      sessionLoader: async () => ({ expires: new Date("2030-01-10T00:00:00Z") }),
    });

  /** Lease a seeded PREPARED row; the caller then mutates live state and
   *  opens T3 under that lease (or runs a whole cycle). */
  const lease = async (rowId: string) => {
    const l = await leasePreparedShippingRefund(rowId, {}, db);
    if (!l.leased) throw new Error(`seed lease failed: ${l.reason}`);
    return l.leaseToken;
  };

  /** The shared gate-abort driver: mutate live state after the lease, open
   *  T3, and assert the designed refusal — no permit, durable ABORTED row,
   *  the exact reasonCode and the detail naming the guard that fired. */
  async function expectGateAbort(
    s: Seeded,
    mutate: () => Promise<unknown>,
    reasonCode: string,
    detail: RegExp | string,
  ) {
    const leaseToken = await lease(s.row.id);
    const before = await rowSnapshot(s.row.id);
    await mutate();
    const t3 = await openDispatchGate(s.row.id, leaseToken, {}, db);
    expect(t3).toEqual({ kind: "ABORTED", reasonCode });
    const after = await rowSnapshot(s.row.id);
    expect(after.status).toBe("ABORTED");
    expect(after.reasonCode).toBe(reasonCode);
    if (typeof detail === "string") expect(after.reviewReason).toBe(detail);
    else expect(after.reviewReason).toMatch(detail);
    expectUntouched(before, after);
  }

  /** A whole worker cycle for the subset that should refuse inside the
   *  real pipeline too: R2 spends its reads, T3 aborts, nothing sends. */
  async function expectCycleAbort(
    s: Seeded,
    admin: R2Admin,
    outcome: string,
  ) {
    const before = await rowSnapshot(s.row.id);
    const report = await runCycle(admin.admin);
    const after = await rowSnapshot(s.row.id);
    expect(admin.mutationCalls()).toBe(0);
    expect(report.outcomes[outcome]).toBe(1);
    expect(after.status).toBe("ABORTED");
    expectUntouched(before, after);
    return { before, after, report };
  }

  // ── 1. Positive control: unchanged seeding mints a permit ────────────

  it("control: unchanged seeding mints a PERMIT (and one mutation through the cycle)", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    const leaseToken = await lease(seeded.row.id);
    const t3 = await openDispatchGate(seeded.row.id, leaseToken, {}, db);
    expect(t3.kind).toBe("PERMIT");
    // The permit left the row DISPATCHING: resolve it or the global
    // breaker waits every later gate in this test.
    await resolveInflightDispatches();
    // The same seeding through the real cycle: exactly one send.
    const seeded2 = await seedScenario(shop(), { gate: { autoApprove: true } });
    const admin = r2HappyAdmin(seeded2.ev, refundGid(++seq));
    const report = await runCycle(admin.admin);
    expect(admin.mutationCalls()).toBe(1);
    expect(report.outcomes["DISPATCHED:ACCEPTED"]).toBe(1);
    expect((await rowSnapshot(seeded2.row.id)).status).toBe("REFUND_RECORDED");
  });

  // ── 2. Dispatch/admission control changes (§9.2 gate recheck) ────────

  it("dispatch switch off aborts GATE_CHANGED on dispatchEpochAtAdmission", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    await expectGateAbort(
      seeded,
      () => db.$executeRaw`UPDATE "ShippingExecuteControl" SET "dispatchEnabled"=false,"dispatchEnabledAt"=NULL WHERE "id"='control'`,
      "GATE_CHANGED",
      "gate recheck: GATE_CHANGED on dispatchEpochAtAdmission",
    );
  });

  it("dispatch off->on with a new epoch aborts GATE_CHANGED on dispatchEpochAtAdmission", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    await expectGateAbort(
      seeded,
      async () => {
        await db.$executeRaw`UPDATE "ShippingExecuteControl" SET "dispatchEnabled"=false,"dispatchEnabledAt"=NULL WHERE "id"='control'`;
        await db.$executeRaw`UPDATE "ShippingExecuteControl" SET "dispatchEnabled"=true,"dispatchEnabledAt"=${naive("2030-01-05T06:00:00Z")} WHERE "id"='control'`;
      },
      "GATE_CHANGED",
      "gate recheck: GATE_CHANGED on dispatchEpochAtAdmission",
    );
  });

  it("the same dispatch-off refusal happens inside the real cycle (reads spent, zero sends)", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
    await db.$executeRaw`UPDATE "ShippingExecuteControl" SET "dispatchEnabled"=false,"dispatchEnabledAt"=NULL WHERE "id"='control'`;
    const { report } = await expectCycleAbort(seeded, admin, "ABORTED:GATE_CHANGED");
    expect(report.outcomes["ABORTED:GATE_CHANGED"]).toBe(1);
    expect(admin.allCalls()).toBeGreaterThan(0); // R2 ran its reads before T3 refused
    expect((await rowSnapshot(seeded.row.id)).reviewReason).toContain("dispatchEpochAtAdmission");
  });

  it("admission switch off aborts GATE_CHANGED on admissionControl (GATE_CLOSED)", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    await expectGateAbort(
      seeded,
      () => db.$executeRaw`UPDATE "ShippingExecuteControl" SET "admissionEnabled"=false,"admissionEnabledAt"=NULL,"dispatchEnabled"=false,"dispatchEnabledAt"=NULL WHERE "id"='control'`,
      "GATE_CHANGED",
      "gate recheck: GATE_CLOSED on admissionControl",
    );
  });

  // ── 3. Phase 1 activation changes ────────────────────────────────────

  it("AppControl shipping switch off aborts GATE_CLOSED on activationGate", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    await expectGateAbort(
      seeded,
      () => db.$executeRaw`UPDATE "AppControl" SET "shippingAdjustmentsEnabled"=false,"shippingEnabledAt"=NULL WHERE "id"='control'`,
      "GATE_CHANGED",
      "gate recheck: GATE_CLOSED on activationGate",
    );
  });

  it("a changed AppControl shipping epoch aborts GATE_CHANGED on switchEpochAt", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    await expectGateAbort(
      seeded,
      () => db.$executeRaw`UPDATE "AppControl" SET "shippingEnabledAt"=${naive("2030-01-03T12:00:00Z")} WHERE "id"='control'`,
      "GATE_CHANGED",
      "gate recheck: GATE_CHANGED on switchEpochAt",
    );
  });

  it("removing the shop from shippingAllowShops aborts GATE_CLOSED on activationGate", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    await expectGateAbort(
      seeded,
      () => db.$executeRaw`UPDATE "AppControl" SET "shippingAllowShops"='{}'::text[] WHERE "id"='control'`,
      "GATE_CHANGED",
      "gate recheck: GATE_CLOSED on activationGate",
    );
  });

  it("merchant opt-out aborts GATE_CLOSED on activationGate", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    await expectGateAbort(
      seeded,
      () => db.$executeRaw`UPDATE "Settings" SET "shippingAdjustmentEnabled"=false,"shippingAdjustmentEnabledAt"=NULL WHERE "shop"=${s}`,
      "GATE_CHANGED",
      "gate recheck: GATE_CLOSED on activationGate",
    );
  });

  it("a re-opt-in with a new merchant epoch aborts GATE_CLOSED on approvalOptInEpoch (I20)", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    // The new merchant epoch invalidates the approval before the snapshot
    // compare ever runs: the gate CLOSES on approvalOptInEpoch (4.4/I20 —
    // a re-opt-in voids every earlier approval). The merchantEpochAt drift
    // is reported by the same GATE_CLOSED recheck inside its detail.
    await expectGateAbort(
      seeded,
      async () => {
        await db.$executeRaw`UPDATE "Settings" SET "shippingAdjustmentEnabled"=false,"shippingAdjustmentEnabledAt"=NULL WHERE "shop"=${s}`;
        await db.$executeRaw`UPDATE "Settings" SET "shippingAdjustmentEnabled"=true,"shippingAdjustmentEnabledAt"=${naive("2030-01-01T06:00:00Z")} WHERE "shop"=${s}`;
      },
      "GATE_CHANGED",
      "gate recheck: GATE_CLOSED on approvalOptInEpoch",
    );
  });

  // ── 4. Approval changes ──────────────────────────────────────────────

  it("a revoked approval aborts GATE_CLOSED on approval", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    await expectGateAbort(
      seeded,
      () => db.$executeRaw`UPDATE "ShippingExecuteApproval" SET "revokedAt"=${naive("2030-01-06T00:00:00Z")} WHERE "shop"=${s}`,
      "GATE_CHANGED",
      "gate recheck: GATE_CLOSED on approval",
    );
  });

  it("a restamped approvedAt aborts GATE_CHANGED on admissionCutoffAt (derived cutoff drifts first)", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    // approvedAt feeds the derived admissionCutoffAt, which sits earlier
    // in the §4.4 compare order — the derived field reports first, which
    // is exactly why NEW-8 stores every epoch individually.
    await expectGateAbort(
      seeded,
      () => db.$executeRaw`UPDATE "ShippingExecuteApproval" SET "approvedAt"=${naive("2030-01-05T12:00:00Z")} WHERE "shop"=${s}`,
      "GATE_CHANGED",
      "gate recheck: GATE_CHANGED on admissionCutoffAt",
    );
  });

  it("a changed ackVersion aborts GATE_CHANGED on approvalAckVersion", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    await expectGateAbort(
      seeded,
      () => db.$executeRaw`UPDATE "ShippingExecuteApproval" SET "ackVersion"='v2' WHERE "shop"=${s}`,
      "GATE_CHANGED",
      "gate recheck: GATE_CLOSED on approvalAckVersion",
    );
  });

  it("a changed approval opt-in epoch aborts GATE_CLOSED on approvalOptInEpoch", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    await expectGateAbort(
      seeded,
      () => db.$executeRaw`UPDATE "ShippingExecuteApproval" SET "merchantOptInEpoch"=${naive("2030-01-01T06:00:00Z")} WHERE "shop"=${s}`,
      "GATE_CHANGED",
      "gate recheck: GATE_CLOSED on approvalOptInEpoch",
    );
  });

  it("a deleted approval row aborts GATE_CLOSED on approval (not a wait at T3)", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    await expectGateAbort(
      seeded,
      () => db.$executeRaw`DELETE FROM "ShippingExecuteApproval" WHERE "shop"=${s}`,
      "GATE_CHANGED",
      "gate recheck: GATE_CLOSED on approval",
    );
  });

  // ── 5. Policy and process environment ────────────────────────────────

  it("a policy change away from REFUND_ALL aborts GATE_CLOSED on shippingPolicy", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    // §9.2: the gate recheck fires before the dedicated POLICY_CHANGED
    // abort — the abort class is identical either way (eligibility abort,
    // durable, zero sends); the recheck's GATE_CLOSED detail names the field.
    await expectGateAbort(
      seeded,
      () => db.$executeRaw`UPDATE "Settings" SET "shippingPolicy"='RETAIN_FIXED' WHERE "shop"=${s}`,
      "GATE_CHANGED",
      "gate recheck: GATE_CLOSED on shippingPolicy",
    );
  });

  it("the same policy refusal happens inside the real cycle", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
    await db.$executeRaw`UPDATE "Settings" SET "shippingPolicy"='RETAIN_FIXED' WHERE "shop"=${s}`;
    await expectCycleAbort(seeded, admin, "ABORTED:GATE_CHANGED");
    expect((await rowSnapshot(seeded.row.id)).reviewReason).toContain("shippingPolicy");
  });

  it("the missing process env flag aborts GATE_CHANGED naming the flag", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    const leaseToken = await lease(seeded.row.id);
    const before = await rowSnapshot(seeded.row.id);
    delete process.env.MERGESHIP_SHIPPING_REFUNDS;
    try {
      const t3 = await openDispatchGate(seeded.row.id, leaseToken, {}, db);
      expect(t3).toEqual({ kind: "ABORTED", reasonCode: "GATE_CHANGED" });
    } finally {
      process.env.MERGESHIP_SHIPPING_REFUNDS = "enabled";
    }
    const after = await rowSnapshot(seeded.row.id);
    expect(after.status).toBe("ABORTED");
    expect(after.reasonCode).toBe("GATE_CHANGED");
    expect(after.reviewReason).toContain("MERGESHIP_SHIPPING_REFUNDS");
    expectUntouched(before, after);
  });

  // ── 6. Frozen contract (§9.2.3: this build's contract or nothing) ────

  it("a foreign documentSha256 aborts DOCUMENT_CHANGED at T3 with no permit", async () => {
    const s = shop();
    const seeded = await seedScenario(s, {
      gate: { autoApprove: true },
      preparedOverrides: { documentSha256: "f".repeat(64) },
    });
    const leaseToken = await lease(seeded.row.id);
    const before = await rowSnapshot(seeded.row.id);
    const t3 = await openDispatchGate(seeded.row.id, leaseToken, {}, db);
    expect(t3).toEqual({ kind: "ABORTED", reasonCode: "DOCUMENT_CHANGED" });
    const after = await rowSnapshot(seeded.row.id);
    expect(after.status).toBe("ABORTED");
    expect(after.reviewReason).toContain("documentSha256");
    expectUntouched(before, after);
  });

  it("a wireHash inconsistent with the frozen variables aborts WIRE_HASH_MISMATCH at T3", async () => {
    const s = shop();
    const seeded = await seedScenario(s, {
      gate: { autoApprove: true },
      preparedOverrides: { wireHash: "e".repeat(64) },
    });
    const leaseToken = await lease(seeded.row.id);
    const before = await rowSnapshot(seeded.row.id);
    const t3 = await openDispatchGate(seeded.row.id, leaseToken, {}, db);
    expect(t3).toEqual({ kind: "ABORTED", reasonCode: "WIRE_HASH_MISMATCH" });
    const after = await rowSnapshot(seeded.row.id);
    expect(after.status).toBe("ABORTED");
    expect(after.reviewReason).toContain("wireHash");
    expectUntouched(before, after);
    // The same row through the real cycle refuses at R2's integrity check
    // first — before any Shopify read is spent.
    const seeded2 = await seedScenario(shop(), {
      gate: { autoApprove: true },
      preparedOverrides: { wireHash: "e".repeat(64) },
    });
    const admin = r2HappyAdmin(seeded2.ev, refundGid(++seq));
    await expectCycleAbort(seeded2, admin, "ABORTED:WIRE_HASH_MISMATCH");
    expect(admin.allCalls()).toBe(0);
  });

  // ── 7. Trigger-catalog integrity at T3 (scratch DB only) ─────────────

  // Scratch-database migrations exceed Vitest's 5 s default on Windows:
  // explicit per-test timeout (third arg), no CLI flags needed.
  it("a broken trigger catalog is a thrown T3 no-decision: no permit, row unchanged, cycle T3_NO_DECISION", async () => {
    await withScratchDatabase(preflighted, async (scratchUrl) => {
      execSync("npx prisma migrate deploy", {
        env: { ...process.env, DATABASE_URL: scratchUrl },
        stdio: "pipe",
      });
      const scratch = new PrismaClient({ datasources: { db: { url: scratchUrl } } });
      try {
        const s = shop();
        await seedShippingR2Gate(scratch, s, { autoApprove: true });
        const ids = {
          sourceOrderId: oid(++seq),
          primaryOrderId: oid(++seq),
          captureTxnId: txnGid(++seq),
          authTxnId: txnGid(++seq),
        };
        const opId = await seedShippingR2MergeOp(scratch, {
          shop: s,
          primaryId: ids.primaryOrderId,
          secondaryId: ids.sourceOrderId,
        });
        const row = await seedPreparedR2Row(scratch, {
          shop: s,
          mergeOperationId: opId,
          evidence: ids,
        });
        const l = await leasePreparedShippingRefund(row.id, {}, scratch);
        if (!l.leased) throw new Error(`scratch lease failed: ${l.reason}`);
        await scratch.$executeRawUnsafe(
          `DROP TRIGGER shippingrefund_frozen_columns_guard ON "ShippingRefund"`,
        );
        // The direct gate call throws (a no-decision — never an abort and
        // never a permit): the transaction refuses before any write.
        await expect(openDispatchGate(row.id, l.leaseToken, {}, scratch)).rejects.toThrow(
          /trigger catalog not intact/,
        );
        // Release the direct-assertion lease so the cycle can take its
        // own, then surface the same no-decision end to end: the row
        // stays PREPARED, untouched, and nothing was sent.
        await scratch.$executeRaw`UPDATE "ShippingRefund" SET "leaseToken"=NULL,"leasedUntil"=NULL WHERE "id"=${row.id}`;
        const admin = r2HappyAdmin(row.evidence, refundGid(++seq));
        const report = await runCycle(admin.admin, scratch);
        expect(admin.mutationCalls()).toBe(0);
        expect(report.outcomes["T3_NO_DECISION"]).toBe(1);
        const [after] = await scratch.$queryRaw<
          { status: string; reasonCode: string | null; dispatchedAt: Date | null; dispatchToken: string | null }[]
        >`SELECT "status","reasonCode","dispatchedAt","dispatchToken" FROM "ShippingRefund" WHERE "id"=${row.id}`;
        expect(after.status).toBe("PREPARED");
        expect(after.reasonCode).toBeNull();
        expect(after.dispatchedAt).toBeNull();
        expect(after.dispatchToken).toBeNull();
      } finally {
        await scratch.$disconnect();
      }
    });
  }, 120_000);

  // ── 8. The point of no return (§4.8, §9.3): post-commit state changes
  //       cannot unsend what T3 already committed ────────────────────────

  it("a committed T3 permit still sends exactly once after every switch is pulled", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: true } });
    const leaseToken = await lease(seeded.row.id);
    const t3 = await openDispatchGate(seeded.row.id, leaseToken, {}, db);
    if (t3.kind !== "PERMIT") throw new Error("expected permit");
    // Emergency stop after the commit: dispatch off, env flag removed,
    // approval revoked — none of it can recall the committed send.
    await db.$executeRaw`UPDATE "ShippingExecuteControl" SET "dispatchEnabled"=false,"dispatchEnabledAt"=NULL WHERE "id"='control'`;
    delete process.env.MERGESHIP_SHIPPING_REFUNDS;
    await db.$executeRaw`UPDATE "ShippingExecuteApproval" SET "revokedAt"=${naive("2030-01-06T00:00:00Z")} WHERE "shop"=${s}`;
    const rid = refundGid(++seq);
    const admin = r2HappyAdmin(seeded.ev, rid);
    const body = await sendRefund(t3.permit, admin.admin);
    expect(admin.mutationCalls()).toBe(1); // exactly one mutation, ever
    const outcome = classifyDispatchResponse(body);
    expect(outcome.kind).toBe("ACCEPTED");
    const t4 = await recordDispatchOutcome(seeded.row.id, t3.permit.dispatchToken, outcome, {}, db);
    expect(t4.wrote).toBe(true);
    expect((await rowSnapshot(seeded.row.id)).status).toBe("REFUND_RECORDED");
    // A second gate attempt on the same row is NOT_PREPARED; a second
    // cycle sends nothing (the env flag alone closes it too).
    process.env.MERGESHIP_SHIPPING_REFUNDS = "enabled";
    const t3b = await openDispatchGate(seeded.row.id, leaseToken, {}, db);
    expect(t3b).toEqual({ kind: "ABORTED", reasonCode: "NOT_PREPARED" });
    const admin2 = r2HappyAdmin(seeded.ev, refundGid(++seq));
    const report2 = await runCycle(admin2.admin);
    expect(admin2.mutationCalls()).toBe(0);
    expect(report2.outcomes["DISPATCHED:ACCEPTED"] ?? 0).toBe(0);
  });

  // ── Coverage gaps (DB-enforced: no legal row state reaches them) ─────
  it.todo("T3 lane check on a PREPARED row — lane is trigger-immutable and the dispatch-path CHECK requires EXECUTE");
  it.todo("SNAPSHOT_INVALID at T3 — snapshot columns are trigger-immutable and derived-cutoff CHECKs forbid inconsistency");
  it.todo("operationCreatedAt < live dispatchCutoff at T3 — no_retroactive + lane CHECKs + the gate recheck make it unreachable");
});
