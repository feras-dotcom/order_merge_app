// §8.4 R2 pre-dispatch parity on a real disposable PostgreSQL database:
// the worker's processPreparedRow driven through
// runShippingRefundDispatchCycle over fake admin clients only — no
// Shopify calls. Every refusal path asserts zero sends, the outcome row
// state, unchanged attempts, NULL dispatch evidence and byte-identical
// frozen columns.
//   MERGESHIP_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:PORT/mergeship_test_x \
//   MERGESHIP_SHADOW_TOKEN=<token> npx vitest run tests/shipping-refund-r2-pg.test.ts
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { preflightDisposableDatabase } from "./helpers/disposable-db";
import {
  checkFrozenWireIntegrity,
  runShippingRefundDispatchCycle,
} from "../app/lib/shipping-refund-worker.server";
import {
  computeWireHash,
  REFUND_DOCUMENT_SHA256,
  buildWireVariables,
  type ShippingRefundInput,
} from "../app/lib/shipping-refund-contract";
import {
  r2HappyAdmin,
  r2Raw,
  r2RecheckBody,
  r2RefundDetailNode,
  r2RoutingAdmin,
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

describe.skipIf(!TEST_URL)("shipping-refund R2 pre-dispatch parity (real disposable database)", () => {
  let db: PrismaClient;
  let seq = 900_000_000 + Math.floor(Math.random() * 900_000_000);

  beforeAll(async () => {
    await preflightDisposableDatabase(TEST_URL!);
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: TEST_URL! }, stdio: "pipe" });
    db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
  }, 120_000);
  afterAll(async () => { await db?.$disconnect(); });

  const resolveInflightDispatches = async () => {
    // Same convention as the dispatch suite: rows are append-only, so
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

  const shop = () => `r2-${randomUUID()}.myshopify.com`;

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
      opId?: string;
      opSeed?: { secondaries?: unknown; phase?: string | null; status?: string };
    } = {},
  ): Promise<Seeded> {
    await seedShippingR2Gate(db, s, o.gate);
    const ids = {
      sourceOrderId: oid(++seq),
      primaryOrderId: oid(++seq),
      captureTxnId: txnGid(++seq),
      authTxnId: txnGid(++seq),
    };
    const opId =
      o.opId ??
      (await seedShippingR2MergeOp(db, {
        shop: s,
        primaryId: ids.primaryOrderId,
        secondaryId: ids.sourceOrderId,
        ...o.opSeed,
      }));
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
          plannedShippingMinor: string | null;
          parentTransactionId: string | null;
          gateway: string | null;
          currencyCode: string | null;
        }[]
      >`SELECT "status","reasonCode","reviewReason","attempts","nextCheckAt",
               "dispatchedAt","dispatchToken","refundId",
               "wireVariables"::text AS "wireVariables","wireHash","idempotencyKey",
               "marker","documentSha256","plannedShippingMinor","parentTransactionId",
               "gateway","currencyCode"
        FROM "ShippingRefund" WHERE "id" = ${id}`
    )[0];

  const attemptCount = async (opId: string) =>
    Number(
      (
        await db.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS "n" FROM "MergeMutationAttempt" WHERE "operationId" = ${opId}`
      )[0].n,
    );

  const FROZEN_KEYS = [
    "wireVariables",
    "wireHash",
    "idempotencyKey",
    "marker",
    "documentSha256",
    "plannedShippingMinor",
    "parentTransactionId",
    "gateway",
    "currencyCode",
  ] as const;

  /** Every refusal path's shared assertions: no send, no dispatch
   *  evidence, attempts untouched, frozen columns byte-identical. */
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

  /** A scenario-level run: snapshot, count attempts, run one cycle, then
   *  assert the shared refusal invariants when `expectSend` is false. */
  async function drive(s: Seeded, admin: R2Admin) {
    const before = await rowSnapshot(s.row.id);
    const attemptsBefore = await attemptCount(s.opId);
    const report = await runCycle(admin.admin);
    const after = await rowSnapshot(s.row.id);
    const attemptsAfter = await attemptCount(s.opId);
    return { before, after, report, attemptsBefore, attemptsAfter, admin };
  }

  // ── 1. The unchanged-evidence happy path ─────────────────────────────

  it("unchanged evidence: exactly one send of the frozen variables -> REFUND_RECORDED", async () => {
    const s = shop();
    const seeded = await seedScenario(s);
    const rid = refundGid(++seq);
    const admin = r2HappyAdmin(seeded.ev, rid);
    const { after, report, attemptsBefore, attemptsAfter } = await drive(seeded, admin);
    expect(admin.mutationCalls()).toBe(1);
    // T3 sent the database-frozen variables — same idempotency key, same input.
    expect(admin.sentVariables[0]).toEqual(seeded.row.wireVariables);
    expect((admin.sentVariables[0] as { idempotencyKey: string }).idempotencyKey).toBe(
      seeded.row.idempotencyKey,
    );
    expect(after.status).toBe("REFUND_RECORDED");
    expect(after.refundId).toBe(rid);
    expect(after.dispatchedAt).not.toBeNull();
    expect(attemptsAfter).toBe(attemptsBefore);
    expect(report.outcomes["DISPATCHED:ACCEPTED"]).toBe(1);
  });

  // ── 2–6. Drift: the rebuild must not equal the freeze ────────────────

  it("a changed shipping price aborts DRIFT_BEFORE_DISPATCH with no send", async () => {
    const s = shop();
    const seeded = await seedScenario(s);
    // 4.00 -> 5.00 in the fresh evidence; the recheck transactions are
    // unchanged so only the planned amount and the wire request drift.
    const drift = { ...seeded.ev, shippingAmount: "5.00" };
    const admin = r2RoutingAdmin({
      recheck: () => r2RecheckBody(seeded.ev),
      order: () => r2ShadowOrderBody(drift),
      preview: () => r2ShadowPreviewBody(drift),
    });
    const { before, after, report, attemptsBefore, attemptsAfter } = await drive(seeded, admin);
    expect(admin.mutationCalls()).toBe(0);
    expect(after.status).toBe("ABORTED");
    expect(after.reasonCode).toBe("DRIFT_BEFORE_DISPATCH");
    expect(after.reviewReason).toContain("plannedShippingMinor");
    expect(report.outcomes["ABORTED:DRIFT_BEFORE_DISPATCH"]).toBe(1);
    expect(attemptsAfter).toBe(attemptsBefore);
    expectUntouched(before, after);
  });

  it("a suggested-transaction amount that differs aborts EVALUATOR_REVIEW with no send", async () => {
    const s = shop();
    const seeded = await seedScenario(s);
    // The evaluator itself refuses this before the rebuild-compare ever
    // runs: a suggested transaction that does not move exactly the planned
    // amount is a deterministic REVIEW ("Suggested transaction amount does
    // not equal the planned refund total."), which §8.4 aborts as
    // EVALUATOR_REVIEW — still ABORTED, still zero sends.
    const preview = r2ShadowPreviewBody(seeded.ev);
    preview.order.suggestedRefund.suggestedTransactions[0].amountSet = {
      presentmentMoney: { amount: "5.00", currencyCode: "USD" },
    };
    const admin = r2RoutingAdmin({
      recheck: () => r2RecheckBody(seeded.ev),
      order: () => r2ShadowOrderBody(seeded.ev),
      preview: () => preview,
    });
    const { before, after, report, attemptsBefore, attemptsAfter } = await drive(seeded, admin);
    expect(admin.mutationCalls()).toBe(0);
    expect(after.status).toBe("ABORTED");
    expect(after.reasonCode).toBe("EVALUATOR_REVIEW");
    expect(report.outcomes["ABORTED:EVALUATOR_REVIEW"]).toBe(1);
    expect(attemptsAfter).toBe(attemptsBefore);
    expectUntouched(before, after);
  });

  it("a changed parent transaction aborts DRIFT_BEFORE_DISPATCH with no send", async () => {
    const s = shop();
    const seeded = await seedScenario(s);
    // The evaluator's reads see a different successful capture than the
    // recheck/baseline (a mid-R2 race): the rebuilt contract names the new
    // parent, so the adapter's own binding proof and then the frozen
    // parentTransactionId both drift. (A capture change consistent across
    // ALL fresh reads is instead caught earlier by the §8.2.5 baseline as
    // REFUND_APPEARED — asserted in the next test.)
    const drift = { ...seeded.ev, captureTxnId: txnGid(++seq) };
    const admin = r2RoutingAdmin({
      recheck: () => r2RecheckBody(seeded.ev),
      order: () => r2ShadowOrderBody(drift),
      preview: () => r2ShadowPreviewBody(drift),
    });
    const { before, after, report, attemptsBefore, attemptsAfter } = await drive(seeded, admin);
    expect(admin.mutationCalls()).toBe(0);
    expect(after.status).toBe("ABORTED");
    expect(after.reasonCode).toBe("DRIFT_BEFORE_DISPATCH");
    expect(report.outcomes["ABORTED:DRIFT_BEFORE_DISPATCH"]).toBe(1);
    expect(attemptsAfter).toBe(attemptsBefore);
    expectUntouched(before, after);
  });

  it("a capture change consistent across every fresh read aborts REFUND_APPEARED first", async () => {
    const s = shop();
    const seeded = await seedScenario(s);
    // The §8.2.5 baseline transaction-id set differs from the freeze, so
    // the baseline compare aborts before the evaluator even runs — the
    // deliberately-earlier refusal stage of R2.
    const drift = { ...seeded.ev, captureTxnId: txnGid(++seq) };
    const admin = r2RoutingAdmin({
      recheck: () => r2RecheckBody(drift),
      order: () => r2ShadowOrderBody(drift),
      preview: () => r2ShadowPreviewBody(drift),
    });
    const { before, after, attemptsBefore, attemptsAfter } = await drive(seeded, admin);
    expect(admin.mutationCalls()).toBe(0);
    expect(after.status).toBe("ABORTED");
    expect(after.reasonCode).toBe("REFUND_APPEARED");
    expect(after.reviewReason).toContain("transaction-id set");
    expect(attemptsAfter).toBe(attemptsBefore);
    expectUntouched(before, after);
  });

  it("a non-allowlisted gateway aborts EVALUATOR_REVIEW with no send", async () => {
    const s = shop();
    const seeded = await seedScenario(s);
    // The evaluator's gateway allowlist refuses 'manual' itself, before
    // the rebuild-compare — an evaluator REVIEW, aborted by §8.4.
    const order = r2ShadowOrderBody(seeded.ev);
    for (const t of order.order.transactions) t.gateway = "manual";
    const preview = r2ShadowPreviewBody(seeded.ev);
    preview.order.suggestedRefund.suggestedTransactions[0].gateway = "manual";
    preview.order.suggestedRefund.suggestedTransactions[0].parentTransaction.gateway = "manual";
    const admin = r2RoutingAdmin({
      recheck: () => r2RecheckBody(seeded.ev),
      order: () => order,
      preview: () => preview,
    });
    const { before, after, attemptsBefore, attemptsAfter } = await drive(seeded, admin);
    expect(admin.mutationCalls()).toBe(0);
    expect(after.status).toBe("ABORTED");
    expect(after.reasonCode).toBe("EVALUATOR_REVIEW");
    expect(after.reviewReason).toContain("allowlist");
    expect(attemptsAfter).toBe(attemptsBefore);
    expectUntouched(before, after);
  });

  it("a changed currency aborts DRIFT_BEFORE_DISPATCH with no send", async () => {
    const s = shop();
    const seeded = await seedScenario(s);
    const drift = { ...seeded.ev, currency: "EUR" };
    const admin = r2RoutingAdmin({
      recheck: () => r2RecheckBody(drift),
      order: () => r2ShadowOrderBody(drift),
      preview: () => r2ShadowPreviewBody(drift),
    });
    const { before, after, attemptsBefore, attemptsAfter } = await drive(seeded, admin);
    expect(admin.mutationCalls()).toBe(0);
    expect(after.status).toBe("ABORTED");
    expect(after.reasonCode).toBe("DRIFT_BEFORE_DISPATCH");
    expect(after.reviewReason).toContain("currencyCode");
    expect(attemptsAfter).toBe(attemptsBefore);
    expectUntouched(before, after);
  });

  it("an evaluator SKIP (shipping no longer paid) aborts with the evaluator reason code", async () => {
    const s = shop();
    const seeded = await seedScenario(s);
    // The fresh evaluator read sees no refundable shipping — the shipping
    // line now discounts to 0.00, a deterministic real-evaluator SKIP
    // (NOTHING_REFUNDABLE, shipping-shadow.server.ts) — which §8.4 aborts
    // with the evaluator's own reason code before the rebuild/T3.
    const order = r2ShadowOrderBody(seeded.ev);
    order.order.shippingLines.nodes[0].discountedPriceSet = {
      presentmentMoney: { amount: "0.00", currencyCode: "USD" },
    };
    const admin = r2RoutingAdmin({
      recheck: () => r2RecheckBody(seeded.ev),
      order: () => order,
      preview: () => r2ShadowPreviewBody(seeded.ev),
    });
    const { before, after, report, attemptsBefore, attemptsAfter } = await drive(seeded, admin);
    expect(admin.mutationCalls()).toBe(0);
    expect(after.status).toBe("ABORTED");
    expect(after.reasonCode).toBe("NOTHING_REFUNDABLE");
    expect(after.reviewReason).toContain("No refundable shipping amount");
    expect(report.outcomes["ABORTED:NOTHING_REFUNDABLE"]).toBe(1);
    expect(attemptsAfter).toBe(attemptsBefore);
    expectUntouched(before, after);
  });

  // ── 7. Merge-evidence contradiction — before any Shopify read ────────

  it("a vanished merge operation parks REVIEW_REQUIRED with zero Shopify reads", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { opId: `mo_missing_${randomUUID()}` });
    const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
    const { before, after, report, attemptsBefore, attemptsAfter } = await drive(seeded, admin);
    expect(admin.allCalls()).toBe(0); // the reassessment precedes every read
    expect(admin.mutationCalls()).toBe(0);
    expect(after.status).toBe("REVIEW_REQUIRED");
    expect(after.reasonCode).toBe("MERGE_EVIDENCE_CONTRADICTION");
    expect(after.reviewReason).toBe("the merge operation is no longer readable");
    expect(report.outcomes["REVIEW_REQUIRED:MERGE_EVIDENCE_CONTRADICTION"]).toBe(1);
    expect(attemptsAfter).toBe(attemptsBefore);
    expectUntouched(before, after);
  });

  it("a secondary removed from the operation parks REVIEW_REQUIRED with zero Shopify reads", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { opSeed: { secondaries: [] } });
    const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
    const { before, after } = await drive(seeded, admin);
    expect(admin.allCalls()).toBe(0);
    expect(after.status).toBe("REVIEW_REQUIRED");
    expect(after.reasonCode).toBe("MERGE_EVIDENCE_CONTRADICTION");
    expect(after.reviewReason).toBe("the secondary is no longer present in the operation");
    expectUntouched(before, after);
  });

  it("an operation whose evidence no longer assesses clean parks REVIEW_REQUIRED", async () => {
    const s = shop();
    // phase != COMPLETED -> assessSecondaryEvidence reports issues.
    const seeded = await seedScenario(s, { opSeed: { phase: "APPLIED" } });
    const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
    const { after } = await drive(seeded, admin);
    expect(admin.allCalls()).toBe(0);
    expect(after.status).toBe("REVIEW_REQUIRED");
    expect(after.reasonCode).toBe("MERGE_EVIDENCE_CONTRADICTION");
    expect(after.reviewReason).toContain("not COMPLETED");
  });

  // ── 8–9. Baseline-class refusals ─────────────────────────────────────

  it("a new external refund id aborts REFUND_APPEARED with no send", async () => {
    const s = shop();
    const seeded = await seedScenario(s);
    const rid = refundGid(++seq);
    const recheck = r2RecheckBody(seeded.ev);
    recheck.source.refunds = [{ id: rid }];
    const admin = r2RoutingAdmin({
      recheck: () => recheck,
      detail: () => ({
        nodes: [r2RefundDetailNode(seeded.ev, { id: rid, note: "support-issued refund" })],
      }),
      order: () => r2ShadowOrderBody(seeded.ev),
      preview: () => r2ShadowPreviewBody(seeded.ev),
    });
    const { before, after, attemptsBefore, attemptsAfter } = await drive(seeded, admin);
    expect(admin.mutationCalls()).toBe(0);
    expect(after.status).toBe("ABORTED");
    expect(after.reasonCode).toBe("REFUND_APPEARED");
    expect(attemptsAfter).toBe(attemptsBefore);
    expectUntouched(before, after);
  });

  it("a refund carrying the MS-SHIPREFUND- prefix parks REVIEW_REQUIRED UNEXPECTED_OWN_MARKER", async () => {
    const s = shop();
    const seeded = await seedScenario(s);
    const rid = refundGid(++seq);
    const recheck = r2RecheckBody(seeded.ev);
    recheck.source.refunds = [{ id: rid }];
    const admin = r2RoutingAdmin({
      recheck: () => recheck,
      detail: () => ({
        nodes: [
          r2RefundDetailNode(seeded.ev, {
            id: rid,
            note: "MS-SHIPREFUND-00000000-0000-4000-8000-000000000001 unexplained",
          }),
        ],
      }),
      order: () => r2ShadowOrderBody(seeded.ev),
      preview: () => r2ShadowPreviewBody(seeded.ev),
    });
    const { before, after, attemptsBefore, attemptsAfter } = await drive(seeded, admin);
    expect(admin.mutationCalls()).toBe(0);
    expect(after.status).toBe("REVIEW_REQUIRED");
    expect(after.reasonCode).toBe("UNEXPECTED_OWN_MARKER");
    expect(attemptsAfter).toBe(attemptsBefore);
    expectUntouched(before, after);
  });

  // ── 10. Transients: the row waits, stays PREPARED, consumes nothing ──

  const expectWait = async (
    seeded: Seeded,
    admin: R2Admin,
    outcome: string,
  ) => {
    const { before, after, report, attemptsBefore, attemptsAfter } = await drive(seeded, admin);
    expect(admin.mutationCalls()).toBe(0);
    expect(after.status).toBe("PREPARED");
    expect(after.nextCheckAt).not.toBeNull();
    expect(attemptsAfter).toBe(attemptsBefore);
    expect(report.outcomes[outcome]).toBe(1);
    expectUntouched(before, after);
  };

  it("a throwing Q-RECHECK waits RECHECK_TRANSPORT", async () => {
    const s = shop();
    const seeded = await seedScenario(s);
    const admin = r2RoutingAdmin({
      recheck: () => {
        throw new Error("connection reset");
      },
      order: () => r2ShadowOrderBody(seeded.ev),
      preview: () => r2ShadowPreviewBody(seeded.ev),
    });
    await expectWait(seeded, admin, "WAIT:RECHECK_TRANSPORT");
  });

  it("a recheck failure analysis waits RECHECK_UNVERIFIED", async () => {
    const s = shop();
    const seeded = await seedScenario(s);
    const admin = r2RoutingAdmin({
      // Shape-invalid recheck (missing source) -> BASELINE_UNVERIFIED.
      recheck: () => ({ source: null, primary: { id: seeded.ev.primaryOrderId } }),
      order: () => r2ShadowOrderBody(seeded.ev),
      preview: () => r2ShadowPreviewBody(seeded.ev),
    });
    await expectWait(seeded, admin, "WAIT:RECHECK_UNVERIFIED");
  });

  it("an incomplete refund-detail read waits DETAIL_READ_INCOMPLETE", async () => {
    const s = shop();
    const seeded = await seedScenario(s);
    const rid = refundGid(++seq);
    const recheck = r2RecheckBody(seeded.ev);
    recheck.source.refunds = [{ id: rid }];
    const admin = r2RoutingAdmin({
      recheck: () => recheck,
      // nodes does not cover the requested id -> validate fails -> wait.
      detail: () => ({ nodes: [] }),
      order: () => r2ShadowOrderBody(seeded.ev),
      preview: () => r2ShadowPreviewBody(seeded.ev),
    });
    await expectWait(seeded, admin, "WAIT:DETAIL_READ_INCOMPLETE");
  });

  it("a throwing evaluator query waits EVALUATOR_TRANSPORT", async () => {
    const s = shop();
    const seeded = await seedScenario(s);
    const admin = r2RoutingAdmin({
      recheck: () => r2RecheckBody(seeded.ev),
      order: () => {
        throw new Error("read ECONNRESET");
      },
      preview: () => r2ShadowPreviewBody(seeded.ev),
    });
    await expectWait(seeded, admin, "WAIT:EVALUATOR_TRANSPORT");
  });

  it("top-level GraphQL errors on the evaluator wait EVALUATOR_TRANSPORT", async () => {
    const s = shop();
    const seeded = await seedScenario(s);
    const admin = r2RoutingAdmin({
      recheck: () => r2RecheckBody(seeded.ev),
      // A response the gql() layer rejects before any field is read.
      order: () => r2Raw({ errors: [{ message: "Throttled" }] }),
      preview: () => r2ShadowPreviewBody(seeded.ev),
    });
    await expectWait(seeded, admin, "WAIT:EVALUATOR_TRANSPORT");
  });

  // ── 11. Frozen integrity — before any Shopify read ───────────────────

  it("a foreign-but-valid documentSha256 aborts DOCUMENT_CHANGED with zero reads", async () => {
    const s = shop();
    const seeded = await seedScenario(s, {
      preparedOverrides: { documentSha256: "f".repeat(64) },
    });
    const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
    const { before, after, report, attemptsBefore, attemptsAfter } = await drive(seeded, admin);
    expect(admin.allCalls()).toBe(0);
    expect(after.status).toBe("ABORTED");
    expect(after.reasonCode).toBe("DOCUMENT_CHANGED");
    expect(report.outcomes["ABORTED:DOCUMENT_CHANGED"]).toBe(1);
    expect(attemptsAfter).toBe(attemptsBefore);
    expectUntouched(before, after);
  });

  it("a wireHash inconsistent with the variables aborts WIRE_HASH_MISMATCH with zero reads", async () => {
    const s = shop();
    const seeded = await seedScenario(s, {
      preparedOverrides: { wireHash: "e".repeat(64) },
    });
    const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
    const { before, after, attemptsBefore, attemptsAfter } = await drive(seeded, admin);
    expect(admin.allCalls()).toBe(0);
    expect(after.status).toBe("ABORTED");
    expect(after.reasonCode).toBe("WIRE_HASH_MISMATCH");
    expect(attemptsAfter).toBe(attemptsBefore);
    expectUntouched(before, after);
  });

  it("the uninsertable integrity cases are covered through the exported check", () => {
    // ShippingRefund_wire_idempotencyKey (CHECK) and ShippingRefund_policyKind
    // (CHECK) make these two rows physically uninsertable through the normal
    // seed path — including the QUEUED -> PREPARED update — so they are
    // driven through the narrowly exported integrity function directly.
    // (The DB-backed half of this group above proves the same reason codes
    // on real rows where the CHECKs allow the inconsistency.)
    const validVars = seededVars();
    expect(
      checkFrozenWireIntegrity({
        documentSha256: REFUND_DOCUMENT_SHA256,
        wireHash: computeWireHash(REFUND_DOCUMENT_SHA256, validVars.badKeyVars),
        wireVariables: validVars.badKeyVars,
        idempotencyKey: validVars.key,
        policyKind: "REFUND_ALL",
      }),
    ).toMatchObject({ ok: false, reasonCode: "WIRE_HASH_MISMATCH" });
    expect(
      checkFrozenWireIntegrity({
        documentSha256: REFUND_DOCUMENT_SHA256,
        wireHash: validVars.hash,
        wireVariables: validVars.vars,
        idempotencyKey: validVars.key,
        policyKind: "RETAIN_FIXED",
      }),
    ).toMatchObject({ ok: false, reasonCode: "POLICY_CHANGED" });
  });

  function seededVars() {
    const key = "63d6dbac-d6e6-4b31-9014-e2c5e877e71d";
    const otherKey = "00000000-0000-4000-8000-000000000001";
    const orderId = oid(++seq);
    const input: ShippingRefundInput = {
      orderId,
      note: "MS-SHIPREFUND-4d854578-911b-4960-957d-8d34069d2be0 note",
      notify: false as const,
      currency: "USD",
      shipping: { fullRefund: false as const, amount: "4.00" },
      transactions: [
        {
          orderId,
          parentId: txnGid(++seq),
          gateway: "bogus",
          kind: "REFUND" as const,
          amount: "4.00",
        },
      ],
    };
    const vars = buildWireVariables(key, input);
    const badKeyVars = buildWireVariables(otherKey, input);
    return {
      key,
      vars,
      badKeyVars,
      hash: computeWireHash(REFUND_DOCUMENT_SHA256, vars),
    };
  }

  // ── 12. Lease / capacity / T3 invariants under the new R2 ────────────

  it("a lease stolen mid-R2 ends the row without a send (LEASE_LOST)", async () => {
    const s = shop();
    const seeded = await seedScenario(s);
    const admin = r2RoutingAdmin({
      recheck: () => r2RecheckBody(seeded.ev),
      order: async () => {
        // Steal the lease while the evaluator read is in flight: the T3
        // fence must catch it — no mutation, no abort written.
        await db.$executeRaw`
          UPDATE "ShippingRefund" SET "leaseToken" = 'stolen',
            "leasedUntil" = clock_timestamp() AT TIME ZONE 'UTC' + interval '1 hour'
          WHERE "id" = ${seeded.row.id}`;
        return r2ShadowOrderBody(seeded.ev);
      },
      preview: () => r2ShadowPreviewBody(seeded.ev),
    });
    const { after, report } = await drive(seeded, admin);
    expect(admin.mutationCalls()).toBe(0);
    expect(after.status).toBe("PREPARED");
    expect(report.outcomes["LEASE_LOST"]).toBe(1);
  });

  it("missing hash approval waits with zero Shopify calls and no attempts", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { autoApprove: false } });
    const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
    const { before, after, report, attemptsBefore, attemptsAfter } = await drive(seeded, admin);
    expect(admin.allCalls()).toBe(0);
    expect(after.status).toBe("PREPARED");
    expect(after.nextCheckAt).not.toBeNull();
    expect(attemptsAfter).toBe(attemptsBefore);
    expect(report.outcomes["WAIT:HASH_APPROVAL_MISSING"]).toBe(1);
    expectUntouched(before, after);
  });

  it("the per-refund cap waits with zero Shopify calls", async () => {
    const s = shop();
    // planned is 400 minor; the approval caps at 300.
    const seeded = await seedScenario(s, { gate: { maxMinor: "300" } });
    const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
    const { after, report } = await drive(seeded, admin);
    expect(admin.allCalls()).toBe(0);
    expect(after.status).toBe("PREPARED");
    expect(report.outcomes["WAIT:PER_REFUND_CAP"]).toBe(1);
  });

  it("a currency-pinned approval waits with zero Shopify calls", async () => {
    const s = shop();
    const seeded = await seedScenario(s, { gate: { approvalCurrency: "EUR" } });
    const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
    const { after, report } = await drive(seeded, admin);
    expect(admin.allCalls()).toBe(0);
    expect(after.status).toBe("PREPARED");
    expect(report.outcomes["WAIT:CURRENCY_MISMATCH"]).toBe(1);
  });

  it("two racing worker cycles send exactly one mutation", async () => {
    const s = shop();
    const seeded = await seedScenario(s);
    const a = r2HappyAdmin(seeded.ev, refundGid(++seq));
    const b = r2HappyAdmin(seeded.ev, refundGid(++seq));
    const [ra, rb] = await Promise.all([runCycle(a.admin), runCycle(b.admin)]);
    expect(a.mutationCalls() + b.mutationCalls()).toBe(1);
    expect((await rowSnapshot(seeded.row.id)).status).toBe("REFUND_RECORDED");
    expect((ra.outcomes["DISPATCHED:ACCEPTED"] ?? 0) + (rb.outcomes["DISPATCHED:ACCEPTED"] ?? 0)).toBe(1);
  });
});
