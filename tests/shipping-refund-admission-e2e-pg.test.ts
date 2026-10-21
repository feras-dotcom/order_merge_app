// Real-Postgres end-to-end tests for the Shipping v0 Phase 2 S1-E milestone:
// the §7.2 bounded scanner + the §8 evaluation/recheck/freeze path in
// app/lib/shipping-refund-admission.server.ts and the new store functions of
// app/lib/shipping-refund-store.server.ts, driven over injected read-only
// fake Shopify evidence.
//
// Opt-in (the same disposable-database gate as the other real suites):
//
//   MERGESHIP_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:PORT/mergeship_test \
//   MERGESHIP_SHADOW_TOKEN=<operator token> \
//     npx vitest run tests/shipping-refund-admission-e2e-pg.test.ts
//
// `preflightDisposableDatabase` runs BEFORE any write and refuses unless the
// target already carries the mergeship-shadow-disposable:<token> marker.
//
// Destructive-scope note: ShippingRefundEvent is append-only — this suite
// never deletes or truncates it. Tests isolate by unique shop/order/operation
// identities and leave their rows in place. MergeOperation / MergeRecord /
// MergeMutationAttempt rows are test fixtures for the scanner's reads; no
// protocol-v2 write path is exercised.

import { execSync } from "child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  claimShippingRefund,
  freezeShippingRefund,
  HORIZON_EXPIRED_PREDICATE,
  recordApprovedWireHash,
  recordEvaluationFailure,
  settleQueuedShippingRefund,
  sweepPreparedHorizon,
  writePreparedR2Outcome,
  type ShippingRefundFreezeInput,
} from "../app/lib/shipping-refund-store.server";
import {
  runShippingRefundAdmissionScan,
  SCAN_EVALUATIONS_PER_SHOP,
  type ShippingRefundScanDeps,
} from "../app/lib/shipping-refund-admission.server";
import { OwnershipLostError } from "../app/lib/ownership.server";
import type { AdminClient } from "../app/lib/graphql.server";
import {
  checkTriggerIntegrity,
  TRIGGER_CATALOG_SQL,
  type ShippingRefundTriggerCatalogRow,
} from "../app/lib/shipping-refund-trigger-manifest";
import {
  preflightDisposableDatabase,
  withScratchDatabase,
  type PreflightedDatabase,
} from "./helpers/disposable-db";

const TEST_URL = process.env.MERGESHIP_TEST_DATABASE_URL;
const oid = (n: number) => `gid://shopify/Order/${n}`;
const txn = (n: number) => `gid://shopify/OrderTransaction/${n}`;
const refundGid = (n: number) => `gid://shopify/Refund/${n}`;

/** The naive-UTC timestamp bind (repository discipline). */
const naive = (iso: string) => Prisma.sql`(${iso}::timestamptz AT TIME ZONE 'UTC')`;

const EPOCH = "2026-10-10T00:00:00.000Z";
const MONEY = (amount: string, currencyCode = "USD") => ({ amount, currencyCode });
const PM = (amount: string, currencyCode = "USD") => ({
  presentmentMoney: MONEY(amount, currencyCode),
});

const TXN_AUTH = txn(900);
const TXN_CAP = txn(901);

// ── Fake Shopify evidence (injected; read-only) ────────────────────────────

function shopifyOrder(srcId: string, cancelledAt: string, over: any = {}): any {
  return {
    id: srcId,
    name: `#${srcId.split("/").pop()}`,
    test: true,
    cancelledAt,
    closedAt: cancelledAt,
    closed: true,
    displayFinancialStatus: "PAID",
    currencyCode: "USD",
    presentmentCurrencyCode: "USD",
    taxesIncluded: false,
    totalRefundedShippingSet: PM("0.00"),
    totalRefundedSet: PM("0.00"),
    shippingLines: {
      nodes: [
        {
          title: "Standard",
          originalPriceSet: PM("8.00"),
          discountedPriceSet: PM("8.00"),
          taxLines: [],
        },
      ],
      pageInfo: { hasNextPage: false },
    },
    refunds: [],
    transactions: [
      {
        id: TXN_AUTH,
        kind: "AUTHORIZATION",
        status: "SUCCESS",
        gateway: "bogus",
        test: true,
        amountSet: PM("18.00"),
        parentTransaction: null,
      },
      {
        id: TXN_CAP,
        kind: "CAPTURE",
        status: "SUCCESS",
        gateway: "bogus",
        test: true,
        amountSet: PM("18.00"),
        parentTransaction: { id: TXN_AUTH },
      },
    ],
    ...over,
  };
}

function shopifyPreview(over: any = {}): any {
  return {
    suggestedRefund: {
      amountSet: PM("8.00"),
      maximumRefundableSet: PM("18.00"),
      shipping: {
        amountSet: PM("8.00"),
        taxSet: PM("0.00"),
        maximumRefundableSet: PM("8.00"),
      },
      suggestedTransactions: [
        {
          kind: "SUGGESTED_REFUND",
          gateway: "bogus",
          amountSet: PM("8.00"),
          parentTransaction: {
            id: TXN_CAP,
            kind: "CAPTURE",
            status: "SUCCESS",
            gateway: "bogus",
            test: true,
          },
        },
      ],
      ...over,
    },
  };
}

function recheckBody(srcId: string, priId: string, over: { source?: any; primary?: any } = {}): any {
  return {
      source: {
        id: srcId,
        cancelledAt: "2026-10-15T09:30:00Z",
        closed: true,
        displayFinancialStatus: "PAID",
        currencyCode: "USD",
        totalRefundedSet: PM("0.00"),
        totalRefundedShippingSet: PM("0.00"),
        refunds: [],
        transactions: [
          {
            id: TXN_AUTH,
            kind: "AUTHORIZATION",
            status: "SUCCESS",
            gateway: "bogus",
            test: true,
            amountSet: PM("18.00"),
            parentTransaction: null,
          },
          {
            id: TXN_CAP,
            kind: "CAPTURE",
            status: "SUCCESS",
            gateway: "bogus",
            test: true,
            amountSet: PM("18.00"),
            parentTransaction: { id: TXN_AUTH },
          },
        ],
        ...over.source,
      },
      primary: {
        id: priId,
        cancelledAt: null,
        displayFinancialStatus: "PAID",
        currencyCode: "USD",
        ...over.primary,
      },
  };
}

interface FakeAdminHandlers {
  order?: (vars: any, calls: number) => any | Promise<any>;
  preview?: (vars: any, calls: number) => any | Promise<any>;
  recheck?: (vars: any, calls: number) => any | Promise<any>;
  detail?: (vars: any, calls: number) => any | Promise<any>;
}

/** An AdminClient that routes by document content and records every call. */
function fakeAdmin(handlers: FakeAdminHandlers, ctx: { srcId: string; priId: string; cancelledAt: string }) {
  const calls: { query: string; variables: any }[] = [];
  const admin = {
    calls,
    graphql: async (query: string, options?: { variables?: any }) => {
      calls.push({ query, variables: options?.variables });
      if (/mutation\b/.test(query)) throw new Error("a mutation must never be issued");
      const n = calls.length;
      const payload =
        query.includes("ShippingRefundDetail")
          ? { nodes: (await handlers.detail?.(options?.variables, n)) ?? [] }
          : query.includes("ShippingRefundExecRecheck")
            ? (await handlers.recheck?.(options?.variables, n)) ??
              recheckBody(ctx.srcId, ctx.priId, {
                source: { cancelledAt: ctx.cancelledAt },
              })
            : query.includes("suggestedRefund")
              ? { order: (await handlers.preview?.(options?.variables, n)) ?? shopifyPreview() }
              : { order: (await handlers.order?.(options?.variables, n)) ?? shopifyOrder(ctx.srcId, ctx.cancelledAt) };
      return { json: async () => ({ data: payload }) } as any;
    },
  };
  return admin as AdminClient & { calls: { query: string; variables: any }[] };
}

const usableSession = () => Promise.resolve({ expires: new Date(Date.now() + 3600e3) });

describe.skipIf(!TEST_URL)(
  "shipping-refund S1-E end-to-end non-dispatch workflow (real disposable database)",
  () => {
    let db: PrismaClient;
    let preflighted: PreflightedDatabase;
    let savedAppControl: {
      shippingAdjustmentsEnabled: boolean;
      shippingEnabledAt: Date | null;
      shippingAllowShops: string[];
    } | null;
    let savedExecuteControl: {
      admissionEnabled: boolean;
      admissionEnabledAt: Date | null;
      dispatchEnabled: boolean;
      dispatchEnabledAt: Date | null;
    } | null;

    beforeAll(async () => {
      // FIRST — before migrations or any write.
      preflighted = await preflightDisposableDatabase(TEST_URL!);
      execSync("npx prisma migrate deploy", {
        env: { ...process.env, DATABASE_URL: TEST_URL! },
        stdio: "pipe",
      });
      db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });

      [savedAppControl] = await db.$queryRaw<
        {
          shippingAdjustmentsEnabled: boolean;
          shippingEnabledAt: Date | null;
          shippingAllowShops: string[];
        }[]
      >`
        SELECT "shippingAdjustmentsEnabled", "shippingEnabledAt", "shippingAllowShops"
        FROM "AppControl" WHERE "id" = 'control'`;
      [savedExecuteControl] = await db.$queryRaw<
        {
          admissionEnabled: boolean;
          admissionEnabledAt: Date | null;
          dispatchEnabled: boolean;
          dispatchEnabledAt: Date | null;
        }[]
      >`
        SELECT "admissionEnabled", "admissionEnabledAt", "dispatchEnabled", "dispatchEnabledAt"
        FROM "ShippingExecuteControl" WHERE "id" = 'control'`;

      await db.$executeRaw`
        UPDATE "AppControl" SET
          "shippingAdjustmentsEnabled" = true,
          "shippingEnabledAt" = ${naive(EPOCH)}
        WHERE "id" = 'control'`;
      await db.$executeRaw`
        INSERT INTO "ShippingExecuteControl"
          ("id", "admissionEnabled", "admissionEnabledAt", "dispatchEnabled", "dispatchEnabledAt")
        VALUES ('control', true, ${naive(EPOCH)}, false, NULL)
        ON CONFLICT ("id") DO UPDATE SET
          "admissionEnabled" = true, "admissionEnabledAt" = ${naive(EPOCH)},
          "dispatchEnabled" = false, "dispatchEnabledAt" = NULL`;
    }, 120_000);

    afterAll(async () => {
      // F2: restore the shared control singletons — success or failure.
      try {
        if (savedAppControl) {
          await db.$executeRaw`
            UPDATE "AppControl" SET
              "shippingAdjustmentsEnabled" = ${savedAppControl.shippingAdjustmentsEnabled},
              "shippingEnabledAt" = ${savedAppControl.shippingEnabledAt},
              "shippingAllowShops" = ${savedAppControl.shippingAllowShops}
            WHERE "id" = 'control'`;
        }
        if (savedExecuteControl) {
          await db.$executeRaw`
            UPDATE "ShippingExecuteControl" SET
              "admissionEnabled" = ${savedExecuteControl.admissionEnabled},
              "admissionEnabledAt" = ${savedExecuteControl.admissionEnabledAt},
              "dispatchEnabled" = ${savedExecuteControl.dispatchEnabled},
              "dispatchEnabledAt" = ${savedExecuteControl.dispatchEnabledAt}
            WHERE "id" = 'control'`;
        } else {
          await db.$executeRaw`DELETE FROM "ShippingExecuteControl" WHERE "id" = 'control'`;
        }
      } finally {
        await db?.$disconnect();
      }
    });

    const uniqueShop = () => `s1e-${randomUUID()}.myshopify.com`;
    let orderSeq = 500_000;
    const nextOrder = () => oid(++orderSeq);
    let opSeq = 0;
    const nextOpId = () => `op_s1e_${++opSeq}_${randomUUID().slice(0, 8)}`;

    const dbWall = async (): Promise<Date> => {
      const [row] = await db.$queryRaw<{ wall: Date }[]>`
        SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "wall"`;
      return row.wall;
    };

    interface GateSeed {
      dispatchEnabled?: boolean;
      dispatchEnabledAt?: string | null;
      revokedAt?: string | null;
    }

    async function seedGate(shop: string, over: GateSeed = {}): Promise<void> {
      await db.$executeRaw`
        UPDATE "AppControl" SET
          "shippingAllowShops" = array_append("shippingAllowShops", ${shop})
        WHERE "id" = 'control'`;
      await db.$executeRaw`
        INSERT INTO "Settings" ("id", "shop", "shippingAdjustmentEnabled",
          "shippingAdjustmentEnabledAt", "shippingRolloutAt", "shippingPolicy")
        VALUES (${`set_${randomUUID()}`}, ${shop}, true, ${naive(EPOCH)}, ${naive(EPOCH)}, 'REFUND_ALL')
        ON CONFLICT ("shop") DO UPDATE SET
          "shippingAdjustmentEnabled" = EXCLUDED."shippingAdjustmentEnabled",
          "shippingAdjustmentEnabledAt" = EXCLUDED."shippingAdjustmentEnabledAt",
          "shippingRolloutAt" = EXCLUDED."shippingRolloutAt",
          "shippingPolicy" = EXCLUDED."shippingPolicy"`;
      // The dispatch switch is shared control state — always write it so a
      // previous test's EXECUTE lane can never leak into an OBSERVE test.
      await db.$executeRaw`
        UPDATE "ShippingExecuteControl" SET
          "dispatchEnabled" = ${over.dispatchEnabled ?? false},
          "dispatchEnabledAt" = ${over.dispatchEnabledAt ? naive(over.dispatchEnabledAt) : Prisma.sql`NULL`}
        WHERE "id" = 'control'`;
      await db.$executeRaw`
        INSERT INTO "ShippingExecuteApproval"
          ("shop", "approvedAt", "approvedBy", "revokedAt", "merchantOptInEpoch",
           "ackVersion", "ackRecordedAt", "currencyCode", "maxRefundMinor")
        VALUES (${shop}, ${naive(EPOCH)}, 's1e-test',
          ${over.revokedAt ? naive(over.revokedAt) : Prisma.sql`NULL`},
          ${naive(EPOCH)}, 'v1', ${naive(EPOCH)}, 'USD', '0')
        ON CONFLICT ("shop") DO UPDATE SET
          "approvedAt" = EXCLUDED."approvedAt",
          "revokedAt" = EXCLUDED."revokedAt",
          "merchantOptInEpoch" = EXCLUDED."merchantOptInEpoch",
          "ackVersion" = EXCLUDED."ackVersion"`;
    }

    interface OpSeed {
      shop: string;
      primaryId?: string;
      secondaryId?: string;
      secondaries?: unknown;
      cancelledAt?: string;
      createdAt?: string;
      phase?: string | null;
      status?: string;
      protocolVersion?: number;
      calculatedOrderId?: string | null;
      sideEffectsDone?: boolean;
      withMergeRecord?: boolean;
      withAttempts?: boolean;
    }

    /** A fixture MergeOperation (plus its MergeRecord + attempts) the scanner
     *  reads. cancelledAt defaults to an hour before seed time; createdAt to
     *  just now (always >= the EPOCH cutoff). */
    async function seedOp(seed: OpSeed): Promise<{
      opId: string;
      primaryId: string;
      secondaryId: string;
      cancelledAt: string;
    }> {
      const opId = nextOpId();
      const primaryId = seed.primaryId ?? nextOrder();
      const secondaryId = seed.secondaryId ?? nextOrder();
      const now = await dbWall();
      const cancelledAt =
        seed.cancelledAt ?? new Date(now.getTime() - 3600e3).toISOString();
      const createdAt = seed.createdAt ?? now.toISOString();
      const secondaries =
        seed.secondaries !== undefined
          ? seed.secondaries
          : [
              {
                id: secondaryId,
                name: `#${secondaryId.split("/").pop()}`,
                items: 1,
                done: true,
                cancelPhase: "CANCEL_VERIFIED",
                cancelledAt,
                staffNoteMatched: true,
              },
            ];
      await db.$executeRaw`
        INSERT INTO "MergeOperation"
          ("id", "shop", "status", "primaryOrderId", "primaryOrderName",
           "primaryLineItemCountBefore", "addedLineItemCount", "secondaries",
           "involvedOrderIds", "createdAt", "updatedAt", "protocolVersion",
           "phase", "opToken", "calculatedOrderId", "expectedTransfer",
           "appliedEvidence", "sideEffectsDone")
        VALUES (
          ${opId}, ${seed.shop}, ${seed.status ?? "COMPLETED"}, ${primaryId},
          '#primary',
          1, 1, ${JSON.stringify(secondaries)}::jsonb,
          ${[primaryId, secondaryId]}::text[],
          ${naive(createdAt)}, ${naive(createdAt)},
          ${seed.protocolVersion ?? 2}, ${seed.phase === undefined ? "COMPLETED" : seed.phase},
          ${`TK${randomUUID().slice(0, 6).toUpperCase()}`},
          ${seed.calculatedOrderId === undefined ? "gid://shopify/CalculatedOrder/1" : seed.calculatedOrderId},
          ${JSON.stringify([{ secondaryId, secondaryIndex: 1, lines: [{ sourceLineItemId: "gid://shopify/LineItem/9", variantId: "gid://shopify/ProductVariant/9", quantity: 1 }] }])}::jsonb,
          ${JSON.stringify({ agreementId: "gid://shopify/OrderEditAgreement/1", happenedAt: createdAt, lines: [{ secondaryId }] })}::jsonb,
          ${seed.sideEffectsDone ?? true}
        )`;
      if (seed.withMergeRecord ?? true) {
        await db.$executeRaw`
          INSERT INTO "MergeRecord"
            ("id", "shop", "primaryOrderId", "primaryOrderName", "mergedOrderId",
             "mergedOrderName", "itemsCombined", "operationId", "createdAt")
          VALUES (${`mr_${randomUUID()}`}, ${seed.shop}, ${primaryId}, '#primary',
            ${secondaryId}, '#secondary', 1, ${opId}, ${naive(createdAt)})`;
      }
      if (seed.withAttempts ?? true) {
        await db.$executeRaw`
          INSERT INTO "MergeMutationAttempt"
            ("id", "operationId", "kind", "targetOrderId", "attemptNo", "state",
             "dispatchToken", "dispatchedAt", "respondedAt")
          VALUES
            (${`att_${randomUUID()}`}, ${opId}, 'EDIT_COMMIT', ${primaryId}, 1,
             'SUCCEEDED', 't', ${naive(createdAt)}, ${naive(createdAt)}),
            (${`att_${randomUUID()}`}, ${opId}, 'ORDER_CANCEL', ${secondaryId}, 1,
             'SUCCEEDED', 't', ${naive(createdAt)}, ${naive(createdAt)})`;
      }
      return { opId, primaryId, secondaryId, cancelledAt };
    }

    const refundRow = async (shop: string, sourceOrderId: string) => {
      const rows = await db.$queryRaw<any[]>`
        SELECT * FROM "ShippingRefund" WHERE "shop" = ${shop} AND "sourceOrderId" = ${sourceOrderId}`;
      return rows[0] ?? null;
    };
    const refundRows = async (shop: string) =>
      db.$queryRaw<any[]>`SELECT * FROM "ShippingRefund" WHERE "shop" = ${shop}`;
    const eventsFor = async (rowId: string) =>
      db.$queryRaw<{ fromStatus: string | null; toStatus: string; actor: string }[]>`
        SELECT "fromStatus", "toStatus", "actor" FROM "ShippingRefundEvent"
        WHERE "shippingRefundId" = ${rowId} ORDER BY "at" ASC, "id" ASC`;

    const scan = (shops: string[], deps: ShippingRefundScanDeps, log?: (l: string) => void) =>
      runShippingRefundAdmissionScan(shops, { log: log ?? (() => {}), ...deps }, db);

    // ── The main demonstrations ──────────────────────────────────────────

    it("an eligible completed combine reaches OBSERVED on the OBSERVE lane", async () => {
      const shop = uniqueShop();
      await seedGate(shop); // dispatch off → OBSERVE
      const { primaryId, secondaryId, cancelledAt } = await seedOp({ shop });
      const admin = fakeAdmin({}, { srcId: secondaryId, priId: primaryId, cancelledAt });
      const reports = await scan([shop], {
        adminFactory: async () => admin,
        sessionLoader: usableSession,
      });
      const row = await refundRow(shop, secondaryId);
      expect(row).not.toBeNull();
      expect(row.status).toBe("OBSERVED");
      expect(row.lane).toBe("OBSERVE");
      expect(reports[0].claimed).toBe(1);
      expect(reports[0].outcomes["FROZEN:OBSERVED"]).toBe(1);
      // Frozen columns set; every dispatch/response/refund column NULL.
      expect(row.wireHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.documentSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.dispatchToken).toBeNull();
      expect(row.dispatchedAt).toBeNull();
      expect(row.refundId).toBeNull();
      expect(row.preparedAt).not.toBeNull();
      expect(row.leaseToken).toBeNull();
      expect(row.preEvidence?.baseline?.mode).toBe("STRICT_EMPTY");
      // Event chain: insert then the OBSERVED freeze.
      const ev = await eventsFor(row.id);
      expect(ev.map((e) => `${e.fromStatus}->${e.toStatus}`)).toEqual([
        "null->QUEUED",
        "QUEUED->OBSERVED",
      ]);
      // Read-only: no issued document is a mutation.
      expect(admin.calls.every((c) => !/\bmutation\b/.test(c.query))).toBe(true);
    });

    it("a valid EXECUTE candidate reaches PREPARED with frozen wire evidence", async () => {
      const shop = uniqueShop();
      await seedGate(shop, { dispatchEnabled: true, dispatchEnabledAt: EPOCH });
      const { primaryId, secondaryId, cancelledAt } = await seedOp({ shop });
      const admin = fakeAdmin({}, { srcId: secondaryId, priId: primaryId, cancelledAt });
      await scan([shop], { adminFactory: async () => admin, sessionLoader: usableSession });
      const row = await refundRow(shop, secondaryId);
      expect(row.status).toBe("PREPARED");
      expect(row.lane).toBe("EXECUTE");
      expect(row.dispatchEpochAtAdmission).not.toBeNull();
      // Frozen financial facts.
      expect(row.currencyCode).toBe("USD");
      expect(row.plannedShippingMinor).toBe("800");
      expect(row.parentTransactionId).toBe(TXN_CAP);
      expect(row.gateway).toBe("bogus");
      // The frozen wire contract.
      const wv = row.wireVariables as any;
      expect(wv.idempotencyKey).toBe(row.idempotencyKey);
      expect(wv.input.orderId).toBe(secondaryId);
      expect(wv.input.transactions[0].parentId).toBe(TXN_CAP);
      expect(wv.input.note).toContain(row.marker);
      expect(row.mutationVersion).toBeTruthy();
      expect(row.wireHash).toMatch(/^[0-9a-f]{64}$/);
      // The baseline: empty under STRICT_EMPTY.
      expect(row.preEvidence?.baseline?.refundCount).toBe(0);
      expect(row.preEvidence?.captureTransactionId).toBe(TXN_CAP);
      // No dispatch evidence.
      expect(row.dispatchToken).toBeNull();
      expect(row.dispatchedAt).toBeNull();
      expect(row.refundId).toBeNull();
      // §4.6 operator wire-hash recording: only equal to the row's hash.
      expect(await recordApprovedWireHash(row.id, "wrong-hash", "op", db)).toBe(false);
      expect(await recordApprovedWireHash(row.id, row.wireHash, "operator-x", db)).toBe(true);
      expect(await recordApprovedWireHash(row.id, row.wireHash, "operator-x", db)).toBe(false);
      const after = await refundRow(shop, secondaryId);
      expect(after.approvedWireHash).toBe(row.wireHash);
      expect(after.approvedBy).toBe("operator-x");
      const ev = await eventsFor(row.id);
      expect(ev.map((e) => `${e.fromStatus}->${e.toStatus}`)).toEqual([
        "null->QUEUED",
        "QUEUED->PREPARED",
      ]);
    });

    it("repeated and concurrent scans never duplicate a candidate", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const { primaryId, secondaryId, cancelledAt } = await seedOp({ shop });
      const admin = fakeAdmin({}, { srcId: secondaryId, priId: primaryId, cancelledAt });
      const deps: ShippingRefundScanDeps = {
        adminFactory: async () => admin,
        sessionLoader: usableSession,
      };
      await scan([shop], deps);
      await scan([shop], deps); // already OBSERVED — no new row
      await Promise.all([scan([shop], deps), scan([shop], deps)]);
      const rows = await refundRows(shop);
      expect(rows.length).toBe(1);
      const ev = await eventsFor(rows[0].id);
      expect(ev.length).toBe(2);
    });

    it("invalid cancelledAt claims REVIEW_REQUIRED(CANCELLED_AT_INVALID) with no Shopify read", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const { primaryId, secondaryId } = await seedOp({ shop, cancelledAt: "not-a-date" });
      const admin = fakeAdmin({}, { srcId: secondaryId, priId: primaryId, cancelledAt: "x" });
      const reports = await scan([shop], {
        adminFactory: async () => admin,
        sessionLoader: usableSession,
      });
      const row = await refundRow(shop, secondaryId);
      expect(row.status).toBe("REVIEW_REQUIRED");
      expect(row.reasonCode).toBe("CANCELLED_AT_INVALID");
      expect(row.sourceCancelledAt).toBeNull();
      expect(admin.calls.length).toBe(0); // no Shopify read before the claim
      expect(
        reports[0].malformed.some((m) => m.defect === "cancelled-at-invalid"),
      ).toBe(true);
    });

    it("stopped, incomplete, non-v2 and historical combines are never selected", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const past = new Date((await dbWall()).getTime() - 3600e3).toISOString();
      await seedOp({ shop, sideEffectsDone: false });
      await seedOp({ shop, phase: "COMMIT_IN_DOUBT", status: "NEEDS_REVIEW" });
      await seedOp({ shop, protocolVersion: 1, calculatedOrderId: null });
      await seedOp({ shop, createdAt: "2026-10-01T00:00:00.000Z", cancelledAt: past });
      const reports = await scan([shop], {
        adminFactory: async () => {
          throw new Error("must never be called");
        },
        sessionLoader: usableSession,
      });
      expect(await refundRows(shop)).toEqual([]);
      expect(reports[0].claimed).toBe(0);
    });

    it("malformed operations are reported and do not stall the scan", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const good = await seedOp({ shop });
      await seedOp({ shop, secondaries: "not-an-array" });
      const badPid = nextOrder();
      await seedOp({
        shop,
        primaryId: badPid,
        secondaries: [42, { id: "not-a-gid" }, { id: badPid }, { name: "no-id" }],
      });
      const admin = fakeAdmin(
        {},
        { srcId: good.secondaryId, priId: good.primaryId, cancelledAt: good.cancelledAt },
      );
      const reports = await scan([shop], {
        adminFactory: async () => admin,
        sessionLoader: usableSession,
      });
      expect(reports[0].malformed.length).toBeGreaterThanOrEqual(4);
      const defects = reports[0].malformed.map((m) => m.defect);
      expect(defects).toContain("secondaries-not-array");
      expect(defects).toContain("element-not-object");
      expect(defects).toContain("id-not-a-gid");
      expect(defects).toContain("id-equals-primary");
      expect(defects).toContain("id-not-a-string");
      // The good operation still processed.
      const row = await refundRow(shop, good.secondaryId);
      expect(row?.status).toBe("OBSERVED");
    });

    it("the 15-minute settle delay defers; the stale combine skips durably", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const now = await dbWall();
      const recent = new Date(now.getTime() - 5 * 60e3).toISOString(); // <15 min
      const stale = new Date(now.getTime() - 8 * 24 * 3600e3).toISOString(); // >7 days
      const a = await seedOp({ shop, cancelledAt: recent });
      const b = await seedOp({ shop, cancelledAt: stale });
      const reports = await scan([shop], {
        adminFactory: async () => fakeAdmin({}, { srcId: a.secondaryId, priId: a.primaryId, cancelledAt: recent }),
        sessionLoader: usableSession,
      });
      expect(await refundRow(shop, a.secondaryId)).toBeNull(); // still in window
      expect(reports[0].deferredSettleDelay).toBe(1);
      const staleRow = await refundRow(shop, b.secondaryId);
      expect(staleRow.status).toBe("SKIPPED");
      expect(staleRow.reasonCode).toBe("STALE_COMBINE");
    });

    it("a merge-evidence contradiction claims REVIEW_REQUIRED with no Shopify read", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const { primaryId, secondaryId } = await seedOp({ shop, withMergeRecord: false });
      const admin = fakeAdmin({}, { srcId: secondaryId, priId: primaryId, cancelledAt: "x" });
      await scan([shop], { adminFactory: async () => admin, sessionLoader: usableSession });
      const row = await refundRow(shop, secondaryId);
      expect(row.status).toBe("REVIEW_REQUIRED");
      expect(row.reasonCode).toBe("MERGE_EVIDENCE_CONTRADICTION");
      expect(admin.calls.length).toBe(0);
    });

    it("evaluator SKIP settles SKIPPED; evaluator REVIEW settles INELIGIBLE", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const a = await seedOp({ shop }); // zero-paid shipping → NOTHING_REFUNDABLE
      const b = await seedOp({ shop }); // no suggested transactions → REVIEW
      const admin = fakeAdmin(
        {
          order: (vars) =>
            vars.id === a.secondaryId
              ? shopifyOrder(a.secondaryId, a.cancelledAt, {
                  shippingLines: {
                    nodes: [
                      {
                        title: "Free",
                        originalPriceSet: PM("0.00"),
                        discountedPriceSet: PM("0.00"),
                        taxLines: [],
                      },
                    ],
                    pageInfo: { hasNextPage: false },
                  },
                })
              : shopifyOrder(vars.id, b.cancelledAt),
          preview: () => shopifyPreview({ suggestedTransactions: [] }),
          recheck: (vars) =>
            recheckBody(vars.source, vars.primary, { source: { cancelledAt: a.cancelledAt } }),
        },
        { srcId: a.secondaryId, priId: a.primaryId, cancelledAt: a.cancelledAt },
      );
      await scan([shop], { adminFactory: async () => admin, sessionLoader: usableSession });
      const rowA = await refundRow(shop, a.secondaryId);
      const rowB = await refundRow(shop, b.secondaryId);
      expect(rowA?.status).toBe("SKIPPED");
      expect(rowA?.reasonCode).toBe("NOTHING_REFUNDABLE");
      expect(rowA?.wireHash).toBeNull();
      expect(rowB?.status).toBe("INELIGIBLE");
      expect(rowB?.reasonCode).toBe("EVALUATOR_REVIEW");
    });

    it("prior refund records and refunded shipping fail closed INELIGIBLE", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const a = await seedOp({ shop }); // recheck lists a prior refund record
      const b = await seedOp({ shop }); // evaluator sees refunded shipping
      const admin = fakeAdmin(
        {
          order: (vars) =>
            vars.id === b.secondaryId
              ? shopifyOrder(b.secondaryId, b.cancelledAt, {
                  totalRefundedShippingSet: PM("8.00"),
                  refunds: [
                    {
                      id: refundGid(5),
                      note: "",
                      refundShippingLines: {
                        nodes: [
                          {
                            subtotalAmountSet: PM("8.00"),
                            taxAmountSet: PM("0.00"),
                          },
                        ],
                        pageInfo: { hasNextPage: false },
                      },
                    },
                  ],
                })
              : shopifyOrder(vars.id, a.cancelledAt),
          recheck: (vars) =>
            recheckBody(vars.source, vars.primary, {
              source: {
                cancelledAt: a.cancelledAt,
                refunds:
                  vars.source === a.secondaryId ? [{ id: refundGid(7) }] : [],
              },
            }),
          detail: () => [
            {
              id: refundGid(7),
              note: "",
              createdAt: "2026-10-14T00:00:00Z",
              processedAt: "2026-10-14T00:00:00Z",
              order: { id: a.secondaryId },
              totalRefundedSet: PM("0.00"),
              duties: [],
              refundShippingLines: { nodes: [], pageInfo: { hasNextPage: false } },
              refundLineItems: { nodes: [], pageInfo: { hasNextPage: false } },
              orderAdjustments: { nodes: [], pageInfo: { hasNextPage: false } },
              transactions: { nodes: [{ id: "t1" }], pageInfo: { hasNextPage: false } },
            },
          ],
        },
        { srcId: a.secondaryId, priId: a.primaryId, cancelledAt: a.cancelledAt },
      );
      await scan([shop], { adminFactory: async () => admin, sessionLoader: usableSession });
      const rowA = await refundRow(shop, a.secondaryId);
      const rowB = await refundRow(shop, b.secondaryId);
      expect(rowA?.status).toBe("INELIGIBLE");
      expect(rowA?.reasonCode).toBe("PRIOR_REFUND_RECORD");
      expect(rowA?.reviewReason).toContain("gid://shopify/Refund/7");
      expect(rowB?.status).toBe("INELIGIBLE");
      // The evaluator's review of prior refunded shipping lands as
      // EVALUATOR_REVIEW — still INELIGIBLE, still no freeze.
      expect(rowB?.wireHash).toBeNull();
    });

    it("a read failure retries without authorizing a refund, then settles", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const { primaryId, secondaryId, cancelledAt } = await seedOp({ shop });
      let orderCalls = 0;
      const admin = fakeAdmin(
        {
          order: (_v, _n) => {
            orderCalls += 1;
            if (orderCalls === 1) throw new Error("simulated transport failure");
            return shopifyOrder(secondaryId, cancelledAt);
          },
        },
        { srcId: secondaryId, priId: primaryId, cancelledAt },
      );
      const deps: ShippingRefundScanDeps = {
        adminFactory: async () => admin,
        sessionLoader: usableSession,
      };
      await scan([shop], deps);
      let row = await refundRow(shop, secondaryId);
      expect(row.status).toBe("QUEUED"); // rescheduled, not settled
      expect(row.attempts).toBe(2);
      expect(row.nextCheckAt).not.toBeNull();
      // Simulate the backoff having elapsed.
      await db.$executeRaw`
        UPDATE "ShippingRefund" SET "nextCheckAt" = NULL WHERE "id" = ${row.id}`;
      await scan([shop], deps);
      row = await refundRow(shop, secondaryId);
      expect(row.status).toBe("OBSERVED");
      const ev = await eventsFor(row.id);
      expect(ev.map((e) => `${e.fromStatus}->${e.toStatus}`)).toEqual([
        "null->QUEUED",
        "QUEUED->OBSERVED",
      ]);
    });

    it("two shops stay isolated when one shop's session lookup fails", async () => {
      const shopA = uniqueShop();
      const shopB = uniqueShop();
      await seedGate(shopA);
      await seedGate(shopB);
      const a = await seedOp({ shop: shopA });
      const b = await seedOp({ shop: shopB });
      const adminB = fakeAdmin({}, { srcId: b.secondaryId, priId: b.primaryId, cancelledAt: b.cancelledAt });
      const reports = await scan([shopA, shopB], {
        adminFactory: async (s) => (s === shopB ? adminB : fakeAdmin({}, { srcId: a.secondaryId, priId: a.primaryId, cancelledAt: a.cancelledAt })),
        sessionLoader: async (s) => {
          if (s === shopA) throw new Error("session store down");
          return usableSession();
        },
      });
      // Shop A claimed its row, then the session-lookup failure rescheduled
      // it through the attempts budget — a handled retry, not an error.
      const rowA = await refundRow(shopA, a.secondaryId);
      expect(rowA?.status).toBe("QUEUED");
      expect(rowA?.attempts).toBe(2);
      expect(rowA?.nextCheckAt).not.toBeNull();
      expect(reports[0].secondaryErrors).toEqual([]);
      expect(reports[0].outcomes["RETRY_SESSION_LOOKUP_FAILED"]).toBe(1);
      // Shop B was unaffected.
      const rowB = await refundRow(shopB, b.secondaryId);
      expect(rowB?.status).toBe("OBSERVED");
      expect(reports[1].claimed).toBe(1);
    });

    it("a gate change during evaluation prevents the freeze (ABORTED GATE_CHANGED)", async () => {
      const shop = uniqueShop();
      await seedGate(shop, { dispatchEnabled: true, dispatchEnabledAt: EPOCH });
      const { primaryId, secondaryId, cancelledAt } = await seedOp({ shop });
      let flipped = false;
      const admin = fakeAdmin(
        {
          order: async (v, n) => {
            // Revoke the shop's approval mid-evaluation, before the freeze's
            // recheck — a per-shop gate change (admission off while dispatch
            // is on violates the control CHECK, so the approval is used).
            if (!flipped) {
              flipped = true;
              await db.$executeRaw`
                UPDATE "ShippingExecuteApproval" SET "revokedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
                WHERE "shop" = ${shop}`;
            }
            return shopifyOrder(secondaryId, cancelledAt);
          },
        },
        { srcId: secondaryId, priId: primaryId, cancelledAt },
      );
      try {
        await scan([shop], { adminFactory: async () => admin as any, sessionLoader: usableSession });
      } finally {
        await db.$executeRaw`
          UPDATE "ShippingExecuteApproval" SET "revokedAt" = NULL WHERE "shop" = ${shop}`;
      }
      const row = await refundRow(shop, secondaryId);
      expect(row.status).toBe("ABORTED");
      expect(row.reasonCode).toBe("GATE_CHANGED");
      expect(row.wireHash).toBeNull();
      const ev = await eventsFor(row.id);
      expect(ev.map((e) => `${e.fromStatus}->${e.toStatus}`)).toEqual([
        "null->QUEUED",
        "QUEUED->ABORTED",
      ]);
    });

    it("a lost lease can neither settle nor freeze", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const { opId, secondaryId, cancelledAt } = await seedOp({ shop });
      const [op] = await db.$queryRaw<any[]>`SELECT * FROM "MergeOperation" WHERE "id" = ${opId}`;
      const claim = await claimShippingRefund(
        { operation: op, secondary: { id: secondaryId, cancelledAt } },
        db,
        () => {},
      );
      expect(claim.claimed).toBe(true);
      if (!claim.claimed) return;
      // Another owner takes the row.
      await db.$executeRaw`
        UPDATE "ShippingRefund" SET "leaseToken" = 'other-owner'
        WHERE "id" = ${claim.rowId}`;
      await expect(
        settleQueuedShippingRefund(
          claim.rowId,
          claim.leaseToken!,
          { status: "SKIPPED", reasonCode: "x" },
          db,
        ),
      ).rejects.toThrow(OwnershipLostError);
      const frozen: ShippingRefundFreezeInput = {
        contract: {
          documentSha256: "0".repeat(64),
          mutationVersion: "v",
          wireVariables: {},
          wireHash: "0".repeat(64),
        },
        financialColumns: {
          currencyCode: "USD",
          plannedShippingMinor: "800",
          parentTransactionId: TXN_CAP,
          gateway: "bogus",
        },
        preEvidence: {},
      };
      const frz = await freezeShippingRefund(claim.rowId, claim.leaseToken!, frozen, db);
      expect(frz).toMatchObject({ frozen: false, reason: "OWNERSHIP_LOST" });
      const row = await refundRow(shop, secondaryId);
      expect(row.status).toBe("QUEUED");
      expect(row.wireHash).toBeNull();
    });

    it("transient evaluation failure exhausts to INELIGIBLE(EVAL_UNAVAILABLE)", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const { opId, secondaryId, cancelledAt } = await seedOp({ shop });
      const [op] = await db.$queryRaw<any[]>`SELECT * FROM "MergeOperation" WHERE "id" = ${opId}`;
      const claim = await claimShippingRefund(
        { operation: op, secondary: { id: secondaryId, cancelledAt } },
        db,
        () => {},
      );
      expect(claim.claimed).toBe(true);
      if (!claim.claimed) return;
      // attempts is already 1; each failure releases the lease and sets
      // nextCheckAt, so re-stamp a live lease before the next failure. The
      // 8th failure settles INELIGIBLE(EVAL_UNAVAILABLE).
      let last: { rescheduled: boolean; exhausted?: boolean } = { rescheduled: true };
      let token = claim.leaseToken!;
      for (let i = 0; i < 8; i++) {
        if (i > 0) {
          token = randomUUID();
          await db.$executeRaw`
            UPDATE "ShippingRefund" SET "leaseToken" = ${token},
              "leasedUntil" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '120 seconds',
              "nextCheckAt" = NULL
            WHERE "id" = ${claim.rowId}`;
        }
        last = await recordEvaluationFailure(claim.rowId, token, db);
      }
      expect(last).toEqual({ rescheduled: false, exhausted: true });
      const row = await refundRow(shop, secondaryId);
      expect(row.status).toBe("INELIGIBLE");
      expect(row.reasonCode).toBe("EVAL_UNAVAILABLE");
    });

    it("the PREPARED horizon sweep aborts past-horizon rows and respects the boundary", async () => {
      const shop = uniqueShop();
      await seedGate(shop, { dispatchEnabled: true, dispatchEnabledAt: EPOCH });
      const wall = await dbWall();
      // Ten seconds inside the horizon: the claim validates (past the E6
      // delay), the freeze admits (not yet expired), the sweep crosses it.
      const cancelledAt = new Date(wall.getTime() - 7 * 24 * 3600e3 + 10_000).toISOString();
      const { primaryId, secondaryId } = await seedOp({ shop, cancelledAt });
      const admin = fakeAdmin(
        {},
        { srcId: secondaryId, priId: primaryId, cancelledAt },
      );
      await scan([shop], { adminFactory: async () => admin as any, sessionLoader: usableSession });
      const row = await refundRow(shop, secondaryId);
      expect(row.status).toBe("PREPARED");
      // Not yet expired — the sweep does not select it.
      let sweep = await sweepPreparedHorizon({ shop }, db, () => {});
      expect(sweep.abortedIds).toEqual([]);
      expect((await refundRow(shop, secondaryId)).status).toBe("PREPARED");
      // Wait for the boundary to pass, then the sweep aborts it.
      const wait = new Date(cancelledAt).getTime() + 7 * 24 * 3600e3 - (await dbWall()).getTime() + 1_500;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      sweep = await sweepPreparedHorizon({ shop }, db, () => {});
      expect(sweep.abortedIds).toContain(row.id);
      const after = await refundRow(shop, secondaryId);
      expect(after.status).toBe("ABORTED");
      expect(after.reasonCode).toBe("HORIZON_EXPIRED");
      const ev = await eventsFor(row.id);
      expect(ev.map((e) => `${e.fromStatus}->${e.toStatus}`)).toEqual([
        "null->QUEUED",
        "QUEUED->PREPARED",
        "PREPARED->ABORTED",
      ]);
      // The frozen columns survive the abort untouched.
      expect(after.wireHash).toBe(row.wireHash);
    }, 60_000);

    it("the horizon predicate fragment is exact at the boundary", async () => {
      // Execute the same exported fragment as a plain SELECT on literals —
      // the spec's deterministic boundary check (7.6.1).
      const at = "2026-10-15T09:30:00.000Z";
      const checks = await db.$queryRaw<{ now_iso: string; expired: boolean }[]>`
        SELECT t.now_iso, ${HORIZON_EXPIRED_PREDICATE(
          Prisma.sql`(t.now_iso::timestamptz AT TIME ZONE 'UTC')`,
        )} AS "expired"
        FROM (VALUES
          (${naive(at)}, '2026-10-22T09:30:00.000Z'),
          (${naive(at)}, '2026-10-22T09:30:00.001Z'),
          (${naive(at)}, '2026-10-23T00:00:00.000Z')
        ) AS t("sourceCancelledAt", now_iso)`;
      expect(checks.map((c) => c.expired)).toEqual([false, true, true]);
      // Under a non-UTC session too — bound values are read as UTC.
      await db.$executeRaw`SET TIME ZONE 'Asia/Tokyo'`;
      try {
        const [c] = await db.$queryRaw<{ expired: boolean }[]>`
          SELECT ${HORIZON_EXPIRED_PREDICATE(
            Prisma.sql`('2026-10-22T09:30:00.001Z'::timestamptz AT TIME ZONE 'UTC')`,
          )} AS "expired"
          FROM (VALUES (${naive(at)})) AS t("sourceCancelledAt")`;
        expect(c.expired).toBe(true);
      } finally {
        await db.$executeRaw`SET TIME ZONE 'UTC'`;
      }
    });

    it("the contained R2 writer aborts or reviews a fixture PREPARED row under a lease", async () => {
      const shop = uniqueShop();
      await seedGate(shop, { dispatchEnabled: true, dispatchEnabledAt: EPOCH });
      const { primaryId, secondaryId, cancelledAt } = await seedOp({ shop });
      await scan([shop], {
        adminFactory: async () => fakeAdmin({}, { srcId: secondaryId, priId: primaryId, cancelledAt }) as any,
        sessionLoader: usableSession,
      });
      const row = await refundRow(shop, secondaryId);
      expect(row.status).toBe("PREPARED");
      // A live lease under a different token refuses first.
      const token = randomUUID();
      await db.$executeRaw`
        UPDATE "ShippingRefund" SET "leaseToken" = 'other',
          "leasedUntil" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '120 seconds'
        WHERE "id" = ${row.id}`;
      await expect(
        writePreparedR2Outcome(
          row.id,
          token,
          { toStatus: "ABORTED", reasonCode: "REFUND_APPEARED" },
          db,
        ),
      ).rejects.toThrow(OwnershipLostError);
      // With the matching token the contained writer moves it.
      await db.$executeRaw`
        UPDATE "ShippingRefund" SET "leaseToken" = ${token} WHERE "id" = ${row.id}`;
      await writePreparedR2Outcome(
        row.id,
        token,
        { toStatus: "ABORTED", reasonCode: "REFUND_APPEARED" },
        db,
      );
      const after = await refundRow(shop, secondaryId);
      expect(after.status).toBe("ABORTED");
      expect(after.reasonCode).toBe("REFUND_APPEARED");
    });

    it("no S1 path issues a mutation or reaches a dispatch-path status", async () => {
      const shop = uniqueShop();
      await seedGate(shop, { dispatchEnabled: true, dispatchEnabledAt: EPOCH });
      const { primaryId, secondaryId, cancelledAt } = await seedOp({ shop });
      const admin = fakeAdmin({}, { srcId: secondaryId, priId: primaryId, cancelledAt });
      await scan([shop], { adminFactory: async () => admin as any, sessionLoader: usableSession });
      const row = await refundRow(shop, secondaryId);
      expect(row.status).toBe("PREPARED");
      // A raw DISPATCHING write is still rejected by the database itself.
      await expect(
        db.$executeRaw`
          UPDATE "ShippingRefund" SET "status" = 'DISPATCHING' WHERE "id" = ${row.id}`,
      ).rejects.toThrow();
      expect((await refundRow(shop, secondaryId)).status).toBe("PREPARED");
      expect(admin.calls.every((c) => !/mutation\b/.test(c.query))).toBe(true);
    });

    it("the per-shop evaluation budget stops claiming at 25", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const ops: { primaryId: string; secondaryId: string; cancelledAt: string }[] = [];
      for (let i = 0; i < SCAN_EVALUATIONS_PER_SHOP + 5; i++) {
        ops.push(await seedOp({ shop }));
      }
      // One admin answers every source identically (the fixtures bind the
      // request variables, so per-source answers are unnecessary).
      const admin = fakeAdmin(
        {
          order: (vars) => shopifyOrder(vars.id, ops[0].cancelledAt),
          recheck: (vars) =>
            recheckBody(vars.source, vars.primary, {
              source: { cancelledAt: ops[0].cancelledAt },
            }),
        },
        { srcId: ops[0].secondaryId, priId: ops[0].primaryId, cancelledAt: ops[0].cancelledAt },
      );
      const deps: ShippingRefundScanDeps = {
        adminFactory: async () => admin,
        sessionLoader: usableSession,
      };
      const reports = await scan([shop], deps);
      expect(reports[0].evaluations).toBe(SCAN_EVALUATIONS_PER_SHOP);
      expect(reports[0].stoppedBy).toBe("evaluation-budget");
      const rows = await refundRows(shop);
      expect(rows.length).toBe(SCAN_EVALUATIONS_PER_SHOP);
      expect(rows.every((r) => r.status === "OBSERVED")).toBe(true);
      // A second scan evaluates the remaining five.
      const reports2 = await scan([shop], deps);
      expect(reports2[0].evaluations).toBe(5);
      expect((await refundRows(shop)).length).toBe(SCAN_EVALUATIONS_PER_SHOP + 5);
    }, 60_000);

    it("the per-shop error budget ends a shop's scan without starving the next", async () => {
      const shopA = uniqueShop();
      const shopB = uniqueShop();
      await seedGate(shopA);
      await seedGate(shopB);
      // 26 secondaries whose lease is stolen mid-evaluation by the fake
      // admin itself: the settle throws OwnershipLostError (UNKNOWN class)
      // inside the per-secondary boundary — a real, deterministic error.
      const opsA: { primaryId: string; secondaryId: string; cancelledAt: string }[] = [];
      for (let i = 0; i < 26; i++) opsA.push(await seedOp({ shop: shopA }));
      const b = await seedOp({ shop: shopB });
      const adminA = fakeAdmin(
        {
          order: async (vars) => {
            await db.$executeRaw`
              UPDATE "ShippingRefund" SET "leaseToken" = 'stolen',
                "leasedUntil" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '120 seconds'
              WHERE "shop" = ${shopA} AND "sourceOrderId" = ${vars.id}`;
            // A SKIP-shaped order so evaluation reaches settle (which throws
            // OwnershipLostError under the stolen lease) rather than freeze.
            return shopifyOrder(vars.id, opsA[0].cancelledAt, {
              shippingLines: {
                nodes: [
                  {
                    title: "Free",
                    originalPriceSet: PM("0.00"),
                    discountedPriceSet: PM("0.00"),
                    taxLines: [],
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            });
          },
        },
        { srcId: opsA[0].secondaryId, priId: opsA[0].primaryId, cancelledAt: opsA[0].cancelledAt },
      );
      const adminB = fakeAdmin({}, { srcId: b.secondaryId, priId: b.primaryId, cancelledAt: b.cancelledAt });
      const reports = await scan([shopA, shopB], {
        adminFactory: async (s) => (s === shopA ? adminA : adminB) as any,
        sessionLoader: usableSession,
      });
      expect(reports[0].secondaryErrors.length).toBe(25);
      expect(reports[0].stoppedBy).toBe("error-budget");
      expect(reports[0].secondaryErrors[0].errorClass).toBe("UNKNOWN");
      // Every poisoned secondary claimed a row that stays QUEUED under the
      // stolen lease; quarantined sources are not retried this scan.
      const rowsA = await refundRows(shopA);
      expect(rowsA.length).toBe(25);
      expect(rowsA.every((r) => r.status === "QUEUED")).toBe(true);
      expect((await refundRow(shopB, b.secondaryId))?.status).toBe("OBSERVED");
    }, 60_000);

    // ── Cycle-level trigger integrity (3.2 rule 11 / 5.4.7) ────────────
    // A due-only cycle: one valid QUEUED row with an expired lease, no new
    // eligible operations. Catalog alterations run only on a scratch
    // database (created and dropped by withScratchDatabase); rule 10
    // reserves DISABLE/ENABLE REPLICA entirely, so the disabled and
    // failed-read verdicts are exercised through an injected catalog
    // reader — the same verdicts the store-level checks already prove on
    // real DDL.

    interface DueFixture {
      shop: string;
      primaryId: string;
      secondaryId: string;
      cancelledAt: string;
      rowId: string;
      leaseToken: string;
    }

    /** Gate open on the EXECUTE lane, a valid op fixture, and a due QUEUED
     *  row claimed through the real claim path with its lease expired. */
    async function seedDueRow(scratch: PrismaClient): Promise<DueFixture> {
      const shop = uniqueShop();
      const wall = (
        await scratch.$queryRaw<{ wall: Date }[]>`
          SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "wall"`
      )[0].wall;
      const cancelledAt = new Date(wall.getTime() - 3600e3).toISOString();
      const primaryId = nextOrder();
      const secondaryId = nextOrder();

      await scratch.$executeRaw`
        UPDATE "AppControl" SET
          "shippingAdjustmentsEnabled" = true,
          "shippingEnabledAt" = ${naive(EPOCH)},
          "shippingAllowShops" = array_append("shippingAllowShops", ${shop})
        WHERE "id" = 'control'`;
      await scratch.$executeRaw`
        INSERT INTO "Settings" ("id", "shop", "shippingAdjustmentEnabled",
          "shippingAdjustmentEnabledAt", "shippingRolloutAt", "shippingPolicy")
        VALUES (${`set_${randomUUID()}`}, ${shop}, true, ${naive(EPOCH)}, ${naive(EPOCH)}, 'REFUND_ALL')`;
      await scratch.$executeRaw`
        UPDATE "ShippingExecuteControl" SET
          "admissionEnabled" = true, "admissionEnabledAt" = ${naive(EPOCH)},
          "dispatchEnabled" = true, "dispatchEnabledAt" = ${naive(EPOCH)}
        WHERE "id" = 'control'`;
      await scratch.$executeRaw`
        INSERT INTO "ShippingExecuteApproval"
          ("shop", "approvedAt", "approvedBy", "revokedAt", "merchantOptInEpoch",
           "ackVersion", "ackRecordedAt", "currencyCode", "maxRefundMinor")
        VALUES (${shop}, ${naive(EPOCH)}, 's1e-test', NULL,
          ${naive(EPOCH)}, 'v1', ${naive(EPOCH)}, 'USD', '0')`;

      const opId = nextOpId();
      await scratch.$executeRaw`
        INSERT INTO "MergeOperation"
          ("id", "shop", "status", "primaryOrderId", "primaryOrderName",
           "primaryLineItemCountBefore", "addedLineItemCount", "secondaries",
           "involvedOrderIds", "createdAt", "updatedAt", "protocolVersion",
           "phase", "opToken", "calculatedOrderId", "expectedTransfer",
           "appliedEvidence", "sideEffectsDone")
        VALUES (
          ${opId}, ${shop}, 'COMPLETED', ${primaryId}, '#primary',
          1, 1, ${JSON.stringify([
            {
              id: secondaryId,
              name: `#${secondaryId.split("/").pop()}`,
              items: 1,
              done: true,
              cancelPhase: "CANCEL_VERIFIED",
              cancelledAt,
              staffNoteMatched: true,
            },
          ])}::jsonb,
          ${[primaryId, secondaryId]}::text[],
          ${naive(wall.toISOString())}, ${naive(wall.toISOString())},
          2, 'COMPLETED', ${`TK${randomUUID().slice(0, 6).toUpperCase()}`},
          'gid://shopify/CalculatedOrder/1',
          ${JSON.stringify([{ secondaryId, secondaryIndex: 1, lines: [{ sourceLineItemId: "gid://shopify/LineItem/9", variantId: "gid://shopify/ProductVariant/9", quantity: 1 }] }])}::jsonb,
          ${JSON.stringify({ agreementId: "gid://shopify/OrderEditAgreement/1", happenedAt: wall.toISOString(), lines: [{ secondaryId }] })}::jsonb,
          true
        )`;
      await scratch.$executeRaw`
        INSERT INTO "MergeRecord"
          ("id", "shop", "primaryOrderId", "primaryOrderName", "mergedOrderId",
           "mergedOrderName", "itemsCombined", "operationId", "createdAt")
        VALUES (${`mr_${randomUUID()}`}, ${shop}, ${primaryId}, '#primary',
          ${secondaryId}, '#secondary', 1, ${opId}, ${naive(wall.toISOString())})`;
      await scratch.$executeRaw`
        INSERT INTO "MergeMutationAttempt"
          ("id", "operationId", "kind", "targetOrderId", "attemptNo", "state",
           "dispatchToken", "dispatchedAt", "respondedAt")
        VALUES
          (${`att_${randomUUID()}`}, ${opId}, 'EDIT_COMMIT', ${primaryId}, 1,
           'SUCCEEDED', 't', ${naive(wall.toISOString())}, ${naive(wall.toISOString())}),
          (${`att_${randomUUID()}`}, ${opId}, 'ORDER_CANCEL', ${secondaryId}, 1,
           'SUCCEEDED', 't', ${naive(wall.toISOString())}, ${naive(wall.toISOString())})`;

      const [opRow] = await scratch.$queryRaw<any[]>`
        SELECT * FROM "MergeOperation" WHERE "id" = ${opId}`;
      const claim = await claimShippingRefund(
        { operation: opRow, secondary: { id: secondaryId, cancelledAt } },
        scratch,
        () => {},
      );
      expect(claim.claimed).toBe(true);
      if (!claim.claimed) throw new Error(`claim refused: ${claim.code}`);
      // Expire the claim's lease so Part A can acquire the row.
      await scratch.$executeRaw`
        UPDATE "ShippingRefund" SET
          "leasedUntil" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second'
        WHERE "id" = ${claim.rowId}`;
      return { shop, primaryId, secondaryId, cancelledAt, rowId: claim.rowId, leaseToken: claim.leaseToken! };
    }

    it("a non-intact catalog stops a due-only cycle before any write or Shopify read (scratch)", async () => {
      await withScratchDatabase(preflighted, async (scratchUrl) => {
        execSync("npx prisma migrate deploy", {
          env: { ...process.env, DATABASE_URL: scratchUrl },
          stdio: "pipe",
        });
        const scratch = new PrismaClient({ datasources: { db: { url: scratchUrl } } });
        try {
          const fx = await seedDueRow(scratch);
          const rowState = async () =>
            (
              await scratch.$queryRaw<any[]>`
                SELECT * FROM "ShippingRefund" WHERE "id" = ${fx.rowId}`
            )[0];
          const rowEvents = async () =>
            scratch.$queryRaw<any[]>`
              SELECT "fromStatus", "toStatus", "actor"
              FROM "ShippingRefundEvent" WHERE "shippingRefundId" = ${fx.rowId}
              ORDER BY "at" ASC, "id" ASC`;
          const realCatalog = () =>
            scratch.$queryRawUnsafe<ShippingRefundTriggerCatalogRow[]>(
              TRIGGER_CATALOG_SQL,
            );

          const runScan = async (
            catalogReader?: ShippingRefundScanDeps["catalogReader"],
          ) => {
            const logs: string[] = [];
            const admin = fakeAdmin(
              {},
              { srcId: fx.secondaryId, priId: fx.primaryId, cancelledAt: fx.cancelledAt },
            );
            const reports = await runShippingRefundAdmissionScan(
              [fx.shop],
              {
                adminFactory: async () => admin as any,
                sessionLoader: usableSession,
                log: (l) => logs.push(l),
                ...(catalogReader ? { catalogReader } : {}),
              },
              scratch,
            );
            return { reports, logs, admin };
          };

          /** The fail-closed contract (5.4.7): stoppedBy set, the log line
           *  with reasons, and every observable byte unchanged — no lease,
           *  no transition, no frozen columns, no event, no Shopify call. */
          const expectRefused = async (
            reader?: ShippingRefundScanDeps["catalogReader"],
          ) => {
            const before = await rowState();
            const evBefore = await rowEvents();
            const { reports, logs, admin } = await runScan(reader);
            expect(reports[0].stoppedBy).toBe("triggers-not-intact");
            expect(reports[0].gateOpen).toBe(false);
            expect(reports[0].dueRowsExamined).toBe(0);
            expect(reports[0].claimed).toBe(0);
            expect(reports[0].evaluations).toBe(0);
            expect(reports[0].secondaryErrors).toEqual([]);
            expect(reports[0].outcomes).toEqual({});
            expect(admin.calls.length).toBe(0);
            expect(
              logs.some((l) =>
                l.includes("[shipping-refund] triggers-not-intact"),
              ),
            ).toBe(true);
            expect(await rowState()).toEqual(before);
            expect(await rowEvents()).toEqual(evBefore);
          };

          const withMutatedCatalog = async (ddl: string[], undo: string[]) => {
            for (const stmt of ddl) await scratch.$executeRawUnsafe(stmt);
            try {
              const v = await checkTriggerIntegrity(realCatalog);
              expect(v.intact).toBe(false);
              await expectRefused();
            } finally {
              for (const stmt of undo) await scratch.$executeRawUnsafe(stmt);
            }
          };

          // Missing mandatory triggers (the reviewer's demonstrated case
          // and the frozen-columns guard).
          await withMutatedCatalog(
            [`DROP TRIGGER shippingrefund_frozen_columns_guard ON "ShippingRefund"`],
            [
              `CREATE TRIGGER shippingrefund_frozen_columns_guard
               BEFORE UPDATE ON "ShippingRefund"
               FOR EACH ROW EXECUTE FUNCTION shipping_refund_fn_frozen_columns_guard()`,
            ],
          );
          await withMutatedCatalog(
            [`DROP TRIGGER shippingrefund_event_writer ON "ShippingRefund"`],
            [
              `CREATE TRIGGER shippingrefund_event_writer
               AFTER INSERT OR UPDATE ON "ShippingRefund"
               FOR EACH ROW EXECUTE FUNCTION shipping_refund_fn_event_writer()`,
            ],
          );

          // An unexpected extra trigger.
          await withMutatedCatalog(
            [
              `CREATE TRIGGER zz_rogue BEFORE UPDATE ON "ShippingRefund"
               FOR EACH ROW EXECUTE FUNCTION shipping_refund_fn_insert_guard()`,
            ],
            [`DROP TRIGGER zz_rogue ON "ShippingRefund"`],
          );

          // A disabled mandatory trigger — rule 10 keeps DISABLE TRIGGER
          // out of test DDL, so the 'D' row is injected over the real
          // catalog rows (same verdict path as a real disabled trigger).
          await expectRefused(async () =>
            (await realCatalog()).map((r) =>
              r.triggerName === "shippingrefund_transition_guard"
                ? { ...r, tgenabled: "D" }
                : r,
            ),
          );

          // A catalog read that fails, and one that returns nothing.
          await expectRefused(async () => {
            throw new Error("catalog read down");
          });
          await expectRefused(async () => []);

          // Intact control: the same due row freezes normally.
          expect((await checkTriggerIntegrity(realCatalog)).intact).toBe(true);
          const { reports, admin } = await runScan();
          expect(reports[0].stoppedBy).toBeNull();
          expect(reports[0].dueRowsExamined).toBe(1);
          expect(reports[0].outcomes["FROZEN:PREPARED"]).toBe(1);
          const row = await rowState();
          expect(row.status).toBe("PREPARED");
          expect(row.wireHash).toMatch(/^[0-9a-f]{64}$/);
          expect(admin.calls.length).toBeGreaterThan(0);
          expect(admin.calls.every((c) => !/\bmutation\b/.test(c.query))).toBe(true);
          expect(
            (await rowEvents()).map((e) => `${e.fromStatus}->${e.toStatus}`),
          ).toEqual(["null->QUEUED", "QUEUED->PREPARED"]);
        } finally {
          await scratch.$disconnect();
        }
      });
    }, 240_000);

    it("the freeze's in-transaction recheck refuses a catalog broken mid-cycle (scratch)", async () => {
      await withScratchDatabase(preflighted, async (scratchUrl) => {
        execSync("npx prisma migrate deploy", {
          env: { ...process.env, DATABASE_URL: scratchUrl },
          stdio: "pipe",
        });
        const scratch = new PrismaClient({ datasources: { db: { url: scratchUrl } } });
        try {
          const fx = await seedDueRow(scratch);
          const rowState = async () =>
            (
              await scratch.$queryRaw<any[]>`
                SELECT * FROM "ShippingRefund" WHERE "id" = ${fx.rowId}`
            )[0];
          const rowEvents = async () =>
            scratch.$queryRaw<any[]>`
              SELECT "fromStatus", "toStatus", "actor"
              FROM "ShippingRefundEvent" WHERE "shippingRefundId" = ${fx.rowId}
              ORDER BY "at" ASC, "id" ASC`;

          const frozen: ShippingRefundFreezeInput = {
            contract: {
              documentSha256: "0".repeat(64),
              mutationVersion: "v",
              wireVariables: {},
              wireHash: "0".repeat(64),
            },
            financialColumns: {
              currencyCode: "USD",
              plannedShippingMinor: "800",
              parentTransactionId: TXN_CAP,
              gateway: "bogus",
            },
            preEvidence: {},
          };

          // Direct: a catalog already missing a trigger refuses inside the
          // freeze transaction — before the lease is even considered and
          // with zero writes. The lease is made live again so the refusal
          // cannot be a lease-expiry artifact.
          await scratch.$executeRaw`
            UPDATE "ShippingRefund" SET
              "leasedUntil" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '120 seconds'
            WHERE "id" = ${fx.rowId}`;
          const before = await rowState();
          await scratch.$executeRawUnsafe(
            `DROP TRIGGER shippingrefund_frozen_columns_guard ON "ShippingRefund"`,
          );
          try {
            const frz = await freezeShippingRefund(fx.rowId, fx.leaseToken, frozen, scratch);
            expect(frz).toMatchObject({
              frozen: false,
              reason: "TRIGGERS_NOT_INTACT",
            });
            expect(await rowState()).toEqual(before);
          } finally {
            await scratch.$executeRawUnsafe(
              `CREATE TRIGGER shippingrefund_frozen_columns_guard
               BEFORE UPDATE ON "ShippingRefund"
               FOR EACH ROW EXECUTE FUNCTION shipping_refund_fn_frozen_columns_guard()`,
            );
          }

          // Mid-cycle: the catalog is intact when the cycle checks it; the
          // drop lands inside the fake recheck read, between the cycle
          // check and the freeze. The freeze's recheck still refuses.
          await scratch.$executeRaw`
            UPDATE "ShippingRefund" SET
              "leasedUntil" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second'
            WHERE "id" = ${fx.rowId}`;
          let dropped = false;
          const logs: string[] = [];
          const admin = fakeAdmin(
            {
              recheck: async (vars) => {
                if (!dropped) {
                  dropped = true;
                  await scratch.$executeRawUnsafe(
                    `DROP TRIGGER shippingrefund_event_writer ON "ShippingRefund"`,
                  );
                }
                return recheckBody(vars.source, vars.primary, {
                  source: { cancelledAt: fx.cancelledAt },
                });
              },
            },
            { srcId: fx.secondaryId, priId: fx.primaryId, cancelledAt: fx.cancelledAt },
          );
          try {
            const reports = await runShippingRefundAdmissionScan(
              [fx.shop],
              {
                adminFactory: async () => admin as any,
                sessionLoader: usableSession,
                log: (l) => logs.push(l),
              },
              scratch,
            );
            expect(dropped).toBe(true);
            expect(reports[0].stoppedBy).toBe("triggers-not-intact");
            expect(reports[0].outcomes["TRIGGERS_NOT_INTACT"]).toBe(1);
            expect(
              logs.some((l) =>
                l.includes("[shipping-refund] triggers-not-intact"),
              ),
            ).toBe(true);
            const row = await rowState();
            // Nothing settled or froze: still QUEUED, no wire columns, and
            // the journal holds only the claim's insert event.
            expect(row.status).toBe("QUEUED");
            expect(row.wireHash).toBeNull();
            expect(row.plannedShippingMinor).toBeNull();
            expect(
              (await rowEvents()).map((e) => `${e.fromStatus}->${e.toStatus}`),
            ).toEqual(["null->QUEUED"]);
          } finally {
            await scratch.$executeRawUnsafe(
              `CREATE TRIGGER shippingrefund_event_writer
               AFTER INSERT OR UPDATE ON "ShippingRefund"
               FOR EACH ROW EXECUTE FUNCTION shipping_refund_fn_event_writer()`,
            );
          }
        } finally {
          await scratch.$disconnect();
        }
      });
    }, 240_000);
  },
);
