// ── Shipping v0 shadow evaluator (Phase 1) ────────────────────────────────────
// A READ-ONLY Shopify-path evaluator that records what a shipping refund
// worker WOULD decide for every eligible secondary of a completed native v2
// combine — without any refund path existing yet.
//
// Isolation guarantees:
//   - Shopify access is forced through readOnlyAdmin(), which refuses any
//     document containing the `mutation` keyword before it reaches the wire.
//   - The only table it writes is ShippingAdjustment, and only through the
//     store below, which refuses every write unless the connected database
//     is the explicitly-named disposable test database
//     (MERGESHIP_SHADOW_DATABASE === current_database()).
//   - It never touches MergeOperation/MergeOrderLock/ProcessedWebhook/
//     MergeRecord/MergeMutationAttempt/MergeClaim — a crashed or wrong
//     evaluation can never modify, restart, block or reverse a combine.
//
// Concurrency: intent rows are claimed by INSERT (unique (shop,
// sourceOrderId)) with a lease; PENDING rows are re-leased only after the
// lease expires; every outcome write is a token+unexpired-conditional UPDATE
// on the database wall clock, exactly like the merge stores. Leases give
// liveness and stale-write fencing only.
//
// Fail-closed rules (all become REVIEW_REQUIRED unless noted):
//   non-native-v2/incomplete combine evidence, missing/uncancelled/unclosed
//   secondary, non-PAID financial state, multi-currency orders, unknown
//   currency precision, tax-bearing shipping (E3 pending), prior shipping
//   refunds, unbounded/unverifiable refund or transaction histories,
//   inconsistent Shopify previews, no verifiable capture/sale allocation,
//   unsupported policy. Terminal verdicts are immutable: READY, SKIPPED and
//   REVIEW_REQUIRED rows are never rewritten by a later scan.

import { createHash } from "crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import defaultDb from "../db.server";
import type { AdminClient } from "./graphql.server";
import { gql, ShopifyGraphqlError } from "./graphql.server";
import { getCurrencyPrecision, parseShopMoney } from "./money";
import {
  DB_WALL,
  dbWallPlus,
  OwnershipLostError,
  withOwnershipTx,
} from "./ownership.server";
import type {
  OperationRecord,
  OperationSecondary,
  OperationStore,
} from "./operation-store.server";
import { isShippingIntentAllowed } from "./shipping-activation";
import { assessSecondaryEvidence } from "./shipping-eligibility";
import { buildShippingAmounts } from "./shipping-evidence";
import {
  proposeShippingAdjustment,
  type ShippingPolicy,
  type ShippingPolicyKind,
} from "./shipping-policy";
import type { MergeSettings } from "./settings.server";

export const SHADOW_LEASE_TTL_MS = 60_000;
export const SHADOW_RETRY_MS = 300_000;
export const SHADOW_MAX_ATTEMPTS = 8;
/** Refund/transaction lists have no pageInfo — reads are bounded and must
 *  return strictly fewer rows than the bound to count as complete. */
const LIST_BOUND = 50;

export class ShadowDatabaseNotAllowedError extends Error {
  name = "ShadowDatabaseNotAllowedError";
}

/** Wrap an AdminClient so no mutation can ever be sent by this subsystem. */
export function readOnlyAdmin(admin: AdminClient): AdminClient {
  return {
    graphql: (query, options) => {
      if (/\bmutation\b/i.test(query)) {
        return Promise.reject(
          new Error("Shipping shadow evaluator is read-only; mutation documents are forbidden."),
        );
      }
      return admin.graphql(query, options);
    },
  };
}

/** Exact decimal string for a minor-unit amount at the currency precision. */
export function minorToDecimal(minor: string | bigint, precision: number): string {
  const n = BigInt(minor);
  const scale = 10n ** BigInt(precision);
  const whole = n / scale;
  const frac = (n < 0n ? -n : n) % scale;
  return precision === 0
    ? whole.toString()
    : `${whole}.${frac.toString().padStart(precision, "0")}`;
}

/** Deterministic JSON (sorted keys) — the string requestHash signs. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as any)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const requestHashOf = (payload: unknown): string =>
  createHash("sha256").update(canonicalJson(payload)).digest("hex");

// ── GraphQL (read-only; validated against API 2026-04 during E0) ──────────────

/** Fresh financial/state evidence for the cancelled+closed secondary. */
const SHADOW_ORDER_QUERY = `#graphql
  query ShippingShadowSource($id: ID!) {
    order(id: $id) {
      id
      name
      test
      cancelledAt
      closedAt
      closed
      displayFinancialStatus
      currencyCode
      presentmentCurrencyCode
      taxesIncluded
      totalRefundedShippingSet { presentmentMoney { amount currencyCode } }
      totalRefundedSet { presentmentMoney { amount currencyCode } }
      shippingLines(first: 5) {
        nodes {
          title
          originalPriceSet { presentmentMoney { amount currencyCode } }
          taxLines { priceSet { presentmentMoney { amount currencyCode } } }
        }
        pageInfo { hasNextPage }
      }
      refunds(first: 50) {
        id
        note
        refundShippingLines(first: 10) {
          nodes {
            subtotalAmountSet { presentmentMoney { amount currencyCode } }
            taxAmountSet { presentmentMoney { amount currencyCode } }
          }
          pageInfo { hasNextPage }
        }
      }
      transactions(first: 50) {
        id
        kind
        status
        gateway
        test
        amountSet { presentmentMoney { amount currencyCode } }
        parentTransaction { id }
      }
    }
  }`;

const SHADOW_PREVIEW_QUERY = `#graphql
  query ShippingShadowPreview($id: ID!, $shippingAmount: Money) {
    order(id: $id) {
      suggestedRefund(shippingAmount: $shippingAmount) {
        amountSet { presentmentMoney { amount currencyCode } }
        maximumRefundableSet { presentmentMoney { amount currencyCode } }
        shipping {
          amountSet { presentmentMoney { amount currencyCode } }
          taxSet { presentmentMoney { amount currencyCode } }
          maximumRefundableSet { presentmentMoney { amount currencyCode } }
        }
        suggestedTransactions {
          kind
          gateway
          amountSet { presentmentMoney { amount currencyCode } }
          parentTransaction { id kind status gateway }
        }
      }
    }
  }`;

// ── Store ────────────────────────────────────────────────────────────────────

export interface ShippingShadowRow {
  id: string;
  shop: string;
  mergeOperationId: string;
  sourceOrderId: string;
  operationCreatedAt: Date;
  policyKind: string;
  policyRetainedMinor: string | null;
  policyCurrencyCode: string | null;
  sourceShippingMinor: string | null;
  plannedRefundMinor: string | null;
  currencyCode: string | null;
  status: string;
  idempotencyKey: string;
  marker: string | null;
  requestPayload: unknown;
  requestHash: string | null;
  previewEvidence: unknown;
  leaseToken: string | null;
  leasedUntil: Date | null;
  nextCheckAt: Date | null;
  attempts: number;
  reasonCode: string | null;
  reviewReason: string | null;
  preparedAt: Date | null;
  dispatchedAt: Date | null;
  refundId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ShadowIntentIdentity {
  shop: string;
  mergeOperationId: string;
  sourceOrderId: string;
  operationCreatedAt: Date;
  policyKind: ShippingPolicyKind;
  policyRetainedMinor: string | null;
  policyCurrencyCode: string | null;
}

export interface ShadowSettlePatch {
  status: "READY" | "SKIPPED" | "REVIEW_REQUIRED";
  reasonCode?: string | null;
  reviewReason?: string | null;
  sourceShippingMinor?: string;
  plannedRefundMinor?: string;
  currencyCode?: string;
  previewEvidence?: unknown;
  requestPayload?: unknown;
  requestHash?: string;
}

export interface ShippingShadowStore {
  /** Native/v2 COMPLETED ops for a shop, oldest first, capped. Read-only. */
  findCompletedOps(shop: string, limit: number): Promise<OperationRecord[]>;
  /** MergeRecord rows written by an operation. Read-only. */
  listMergeRecords(
    shop: string,
    operationId: string,
  ): Promise<{ mergedOrderId: string; primaryOrderId: string; operationId: string | null }[]>;
  /** Existing intent rows for these sources. Read-only. */
  findAdjustments(shop: string, sourceOrderIds: string[]): Promise<ShippingShadowRow[]>;
  /** Terminal SKIPPED/REVIEW_REQUIRED insert. false when a row already
   *  exists (another worker beat us, or it was settled before). */
  recordTerminal(
    identity: ShadowIntentIdentity,
    status: "SKIPPED" | "REVIEW_REQUIRED",
    reason: { reasonCode?: string; reviewReason?: string },
  ): Promise<boolean>;
  /** INSERT a leased PENDING intent carrying the frozen policy snapshot.
   *  null on (shop, sourceOrderId) conflict. */
  claimIntent(identity: ShadowIntentIdentity, ttlMs: number): Promise<ShippingShadowRow | null>;
  /** Re-lease an expired PENDING intent; null when it is live-leased or no
   *  longer PENDING. */
  reclaimIntent(id: string, token: string, ttlMs: number): Promise<ShippingShadowRow | null>;
  /** Settle a claimed intent. Throws OwnershipLostError on a stale lease. */
  settleIntent(id: string, token: string, patch: ShadowSettlePatch): Promise<void>;
  /** Reschedule a claimed intent for a later retry. Throws OwnershipLostError. */
  rescheduleIntent(id: string, token: string, delayMs: number, reason: string): Promise<void>;
}

const toShadowRow = (row: any): ShippingShadowRow => row as ShippingShadowRow;

const policyColumns = (p: ShadowIntentIdentity) => ({
  kind: p.policyKind,
  minor: p.policyKind === "RETAIN_FIXED" ? p.policyRetainedMinor : null,
  currency: p.policyKind === "RETAIN_FIXED" ? p.policyCurrencyCode : null,
});

export function makeShippingShadowStore(db: PrismaClient = defaultDb): ShippingShadowStore {
  let writableChecked = false;
  /** Hard guard: persistent shadow evidence is allowed ONLY on the
   *  explicitly-named disposable database. */
  const assertWritable = async () => {
    if (writableChecked) return;
    const expected = process.env.MERGESHIP_SHADOW_DATABASE;
    const [row] = await db.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
    if (!expected || !row || expected !== row.db) {
      throw new ShadowDatabaseNotAllowedError(
        `Shadow writes refused: MERGESHIP_SHADOW_DATABASE (${expected ?? "unset"}) does not match current_database() (${row?.db ?? "unknown"}).`,
      );
    }
    writableChecked = true;
  };

  const baseInsert = (p: ShadowIntentIdentity) => {
    const { kind, minor, currency } = policyColumns(p);
    return {
      id: crypto.randomUUID(),
      idem: crypto.randomUUID(),
      marker: `MS-SHIP-${crypto.randomUUID()}`,
      kind,
      minor,
      currency,
    };
  };

  return {
    async findCompletedOps(shop, limit) {
      return db.$queryRaw<OperationRecord[]>`
        SELECT * FROM "MergeOperation"
        WHERE "shop" = ${shop} AND "protocolVersion" = 2 AND "phase" = 'COMPLETED'
        ORDER BY "createdAt" ASC
        LIMIT ${limit}`;
    },

    async listMergeRecords(shop, operationId) {
      return db.$queryRaw<
        { mergedOrderId: string; primaryOrderId: string; operationId: string | null }[]
      >`
        SELECT "mergedOrderId", "primaryOrderId", "operationId"
        FROM "MergeRecord" WHERE "shop" = ${shop} AND "operationId" = ${operationId}`;
    },

    async findAdjustments(shop, sourceOrderIds) {
      if (!sourceOrderIds.length) return [];
      const rows = await db.$queryRaw<any[]>`
        SELECT * FROM "ShippingAdjustment"
        WHERE "shop" = ${shop} AND "sourceOrderId" = ANY(${sourceOrderIds})`;
      return rows.map(toShadowRow);
    },

    async recordTerminal(identity, status, reason) {
      await assertWritable();
      const b = baseInsert(identity);
      const rows = await db.$queryRaw<any[]>`
        INSERT INTO "ShippingAdjustment" (
          "id", "shop", "mergeOperationId", "sourceOrderId", "operationCreatedAt",
          "policyKind", "policyRetainedMinor", "policyCurrencyCode",
          "status", "idempotencyKey", "marker", "reasonCode", "reviewReason",
          "attempts", "createdAt", "updatedAt"
        ) VALUES (
          ${b.id}, ${identity.shop}, ${identity.mergeOperationId}, ${identity.sourceOrderId},
          ${identity.operationCreatedAt},
          ${b.kind}, ${b.minor}, ${b.currency},
          ${status}, ${b.idem}, ${b.marker},
          ${reason.reasonCode ?? null}, ${reason.reviewReason ?? null},
          1, ${DB_WALL}, ${DB_WALL}
        )
        ON CONFLICT ("shop", "sourceOrderId") DO NOTHING
        RETURNING "id"`;
      return rows.length === 1;
    },

    async claimIntent(identity, ttlMs) {
      await assertWritable();
      const b = baseInsert(identity);
      const rows = await db.$queryRaw<any[]>`
        INSERT INTO "ShippingAdjustment" (
          "id", "shop", "mergeOperationId", "sourceOrderId", "operationCreatedAt",
          "policyKind", "policyRetainedMinor", "policyCurrencyCode",
          "status", "idempotencyKey", "marker",
          "leaseToken", "leasedUntil", "nextCheckAt", "attempts",
          "createdAt", "updatedAt"
        ) VALUES (
          ${b.id}, ${identity.shop}, ${identity.mergeOperationId}, ${identity.sourceOrderId},
          ${identity.operationCreatedAt},
          ${b.kind}, ${b.minor}, ${b.currency},
          'PENDING', ${b.idem}, ${b.marker},
          ${crypto.randomUUID()}, ${dbWallPlus(ttlMs)}, ${DB_WALL}, 1,
          ${DB_WALL}, ${DB_WALL}
        )
        ON CONFLICT ("shop", "sourceOrderId") DO NOTHING
        RETURNING *`;
      return rows.length ? toShadowRow(rows[0]) : null;
    },

    async reclaimIntent(id, token, ttlMs) {
      await assertWritable();
      const rows = await db.$queryRaw<any[]>`
        UPDATE "ShippingAdjustment"
        SET "leaseToken" = ${token}, "leasedUntil" = ${dbWallPlus(ttlMs)},
            "attempts" = "attempts" + 1, "nextCheckAt" = ${DB_WALL}, "updatedAt" = ${DB_WALL}
        WHERE "id" = ${id} AND "status" = 'PENDING'
          AND ("leasedUntil" IS NULL OR "leasedUntil" < ${DB_WALL})
          AND ("nextCheckAt" IS NULL OR "nextCheckAt" <= ${DB_WALL})
        RETURNING *`;
      return rows.length ? toShadowRow(rows[0]) : null;
    },

    async settleIntent(id, token, patch) {
      await assertWritable();
      const sets: Prisma.Sql[] = [
        Prisma.sql`"status" = ${patch.status}`,
        Prisma.sql`"leaseToken" = NULL`,
        Prisma.sql`"leasedUntil" = NULL`,
        Prisma.sql`"nextCheckAt" = NULL`,
        Prisma.sql`"reasonCode" = ${patch.reasonCode ?? null}`,
        Prisma.sql`"reviewReason" = ${patch.reviewReason ?? null}`,
        Prisma.sql`"updatedAt" = ${DB_WALL}`,
      ];
      if (patch.status === "READY") {
        sets.push(
          Prisma.sql`"sourceShippingMinor" = ${patch.sourceShippingMinor ?? null}`,
          Prisma.sql`"plannedRefundMinor" = ${patch.plannedRefundMinor ?? null}`,
          Prisma.sql`"currencyCode" = ${patch.currencyCode ?? null}`,
          Prisma.sql`"previewEvidence" = ${JSON.stringify(patch.previewEvidence ?? null)}::jsonb`,
          Prisma.sql`"requestPayload" = ${JSON.stringify(patch.requestPayload ?? null)}::jsonb`,
          Prisma.sql`"requestHash" = ${patch.requestHash ?? null}`,
          Prisma.sql`"preparedAt" = ${DB_WALL}`,
        );
      }
      await withOwnershipTx(db, async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ShippingAdjustment" WHERE id = ${id} FOR UPDATE`;
        const updated = await tx.$executeRaw`
          UPDATE "ShippingAdjustment" SET ${Prisma.join(sets)}
          WHERE "id" = ${id} AND "leaseToken" = ${token}
            AND "leasedUntil" > ${DB_WALL} AND "status" = 'PENDING'`;
        if (updated === 0) {
          throw new OwnershipLostError(`Shipping intent ${id} is owned by another worker.`);
        }
      });
    },

    async rescheduleIntent(id, token, delayMs, reason) {
      await assertWritable();
      await withOwnershipTx(db, async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ShippingAdjustment" WHERE id = ${id} FOR UPDATE`;
        const updated = await tx.$executeRaw`
          UPDATE "ShippingAdjustment"
          SET "nextCheckAt" = ${dbWallPlus(delayMs)}, "reasonCode" = ${reason},
              "leaseToken" = NULL, "leasedUntil" = NULL, "updatedAt" = ${DB_WALL}
          WHERE "id" = ${id} AND "leaseToken" = ${token}
            AND "leasedUntil" > ${DB_WALL} AND "status" = 'PENDING'`;
        if (updated === 0) {
          throw new OwnershipLostError(`Shipping intent ${id} is owned by another worker.`);
        }
      });
    },
  };
}

// ── Evaluation ───────────────────────────────────────────────────────────────

export type ShadowOutcome =
  | {
      kind: "READY";
      sourceShippingMinor: string;
      plannedRefundMinor: string;
      currencyCode: string;
      previewEvidence: unknown;
      requestPayload: unknown;
      requestHash: string;
    }
  | { kind: "SKIP"; reasonCode: string; reason: string }
  | { kind: "REVIEW"; reason: string };

const review = (reason: string): ShadowOutcome => ({ kind: "REVIEW", reason });
const skip = (reasonCode: string, reason: string): ShadowOutcome => ({
  kind: "SKIP",
  reasonCode,
  reason,
});

const sumMoney = (values: any[]): bigint | null => {
  let total = 0n;
  for (const v of values) {
    const parsed = parseShopMoney(v);
    if (!parsed) return null;
    total += parsed.minorUnits;
  }
  return total;
};

/**
 * Evaluates one secondary against fresh Shopify state. Throws only for
 * transport/top-level failures (the caller treats those as TRANSIENT and
 * reschedules); every deterministic ambiguity is REVIEW/SKIP. `admin` MUST be
 * wrapped with readOnlyAdmin before calling.
 */
export async function evaluateShadowSource(
  admin: AdminClient,
  input: {
    sourceOrderId: string;
    policy: ShippingPolicy;
    marker: string;
    primaryOrderName: string;
  },
): Promise<ShadowOutcome> {
  const order = await gql<any>(
    admin,
    "Shipping shadow source",
    SHADOW_ORDER_QUERY,
    { id: input.sourceOrderId },
    "order",
    null,
  );
  if (!order) return review("Source order could no longer be loaded.");

  // Supported final state: Protocol v2 cancels (verified) and closes the
  // secondary. Anything else is ambiguous — the combine's own evidence said
  // the cancellation was ours, so a missing flag means something else acted.
  if (typeof order.cancelledAt !== "string" || !order.cancelledAt) {
    return review("Secondary is no longer cancelled.");
  }
  if (order.closed !== true || typeof order.closedAt !== "string" || !order.closedAt) {
    return review("Secondary is not closed though the combine's side effects completed.");
  }
  if (order.displayFinancialStatus !== "PAID") {
    return review(
      `Secondary financial status is ${order.displayFinancialStatus ?? "unknown"}, not PAID.`,
    );
  }

  // Bounded reads must be provably complete.
  if (order.shippingLines?.pageInfo?.hasNextPage !== false) {
    return review("Shipping line list is incomplete.");
  }
  const refunds = Array.isArray(order.refunds) ? order.refunds : [];
  if (refunds.length >= LIST_BOUND) {
    return review("Refund history exceeds the bounded read; completeness unproven.");
  }
  for (const r of refunds) {
    if (r?.refundShippingLines?.pageInfo?.hasNextPage !== false) {
      return review("A refund's shipping lines exceed the bounded read.");
    }
  }
  const transactions = Array.isArray(order.transactions) ? order.transactions : [];
  if (transactions.length >= LIST_BOUND) {
    return review("Transaction history exceeds the bounded read; completeness unproven.");
  }

  const shippingNodes = order.shippingLines.nodes as any[];
  const shippingPaid = sumMoney(shippingNodes.map((l) => l?.originalPriceSet?.presentmentMoney));
  const shippingTax = sumMoney(
    shippingNodes.flatMap((l) => (l?.taxLines ?? []).map((t: any) => t?.priceSet?.presentmentMoney)),
  );
  if (shippingPaid === null || shippingTax === null) {
    return review("Shipping price or tax amounts are unparseable.");
  }

  // Refund history: the bounded refund list's shipping lines must reconcile
  // exactly with the order-level refunded-shipping aggregate.
  const refundedShippingLines = refunds.flatMap((r: any) => r.refundShippingLines?.nodes ?? []);
  const refundedShipping = sumMoney(
    refundedShippingLines.map((l: any) => l?.subtotalAmountSet?.presentmentMoney),
  );
  if (refundedShipping === null) {
    return review("Refunded shipping amounts are unparseable.");
  }
  const aggregateRefunded = parseShopMoney(order.totalRefundedShippingSet?.presentmentMoney);
  if (!aggregateRefunded) {
    return review("Order refunded-shipping aggregate is missing or invalid.");
  }
  if (refundedShipping !== aggregateRefunded.minorUnits) {
    return review("Refund history does not reconcile with the refunded-shipping aggregate.");
  }

  // Phase 1 tax scope: only unambiguous zero-shipping-tax cases.
  if (order.taxesIncluded === true) {
    return review("Order prices are tax-inclusive; shipping tax handling is unverified (E3 pending).");
  }
  if (shippingTax > 0n) {
    return review("Shipping carried tax; shipping-tax refunds are unverified (E3 pending).");
  }

  const policy = input.policy;
  const retained =
    policy.kind === "RETAIN_FIXED" ? BigInt(policy.retainedMinor) : 0n;
  const desired = shippingPaid - retained;
  if (desired <= 0n) {
    return skip("NOTHING_REFUNDABLE", "No refundable shipping amount under the snapshotted policy.");
  }
  if (refundedShipping > 0n) {
    return review("Source shipping was already partially or fully refunded.");
  }

  const currencyCode = order.currencyCode;
  const precision = getCurrencyPrecision(currencyCode);
  if (precision === null) {
    return review(`Currency ${currencyCode} has no supported minor-unit precision.`);
  }
  const previewOrder = await gql<any>(
    admin,
    "Shipping shadow preview",
    SHADOW_PREVIEW_QUERY,
    { id: input.sourceOrderId, shippingAmount: minorToDecimal(desired, precision) },
    "order",
    null,
  );
  const preview = previewOrder?.suggestedRefund;
  if (!preview) return review("Shopify returned no refund preview.");

  const built = buildShippingAmounts({
    orderCurrencyCode: currencyCode,
    presentmentCurrencyCode: order.presentmentCurrencyCode,
    taxesIncluded: order.taxesIncluded,
    sourceShippingPaid: {
      amount: minorToDecimal(shippingPaid, precision),
      currencyCode,
    },
    previouslyRefundedShipping: order.totalRefundedShippingSet?.presentmentMoney,
    maxShippingRefundable: preview.shipping?.maximumRefundableSet?.presentmentMoney,
    maxPaymentRefundable: preview.maximumRefundableSet?.presentmentMoney,
    previewShipping: preview.shipping?.amountSet?.presentmentMoney,
    previewShippingTax: preview.shipping?.taxSet?.presentmentMoney,
    previewTotal: preview.amountSet?.presentmentMoney,
    completeRefundHistory: true,
  });
  if (!built.ok) return review(built.reason);

  if (built.amounts.previewShippingTaxMinor !== "0") {
    return review("Shopify preview includes shipping tax; unverified (E3 pending).");
  }

  const decision = proposeShippingAdjustment(policy, built.amounts);
  if (decision.kind === "SKIP") return skip("POLICY_SKIP", decision.reason);
  if (decision.kind === "REVIEW") return review(decision.reason);

  // Explicit transaction allocation: the preview must name a suggested
  // transaction whose parent is a verifiably successful CAPTURE or SALE on
  // this same order — never a guessed or default allocation.
  const suggested = Array.isArray(preview.suggestedTransactions)
    ? preview.suggestedTransactions
    : [];
  const parent = suggested[0]?.parentTransaction;
  const parentTxn =
    parent &&
    transactions.find(
      (t: any) =>
        t?.id === parent.id &&
        t?.status === "SUCCESS" &&
        (t?.kind === "CAPTURE" || t?.kind === "SALE"),
    );
  if (!suggested.length || !parentTxn) {
    return review("No verifiable capture/sale transaction for the refund allocation.");
  }
  const gateway = suggested[0].gateway;
  if (typeof gateway !== "string" || !gateway || parentTxn.gateway !== gateway) {
    return review("Suggested transaction gateway is missing or inconsistent.");
  }

  const requestPayload = {
    orderId: input.sourceOrderId,
    notify: false,
    note: `MergeShip shipping adjustment ${input.marker} — shipping refunded for order merged into ${input.primaryOrderName}.`,
    currency: currencyCode,
    shipping: { amount: minorToDecimal(decision.shippingMinor, precision), fullRefund: false },
    transactions: [
      {
        orderId: input.sourceOrderId,
        parentId: parentTxn.id,
        gateway,
        kind: "REFUND",
        amount: minorToDecimal(decision.transactionMinor, precision),
      },
    ],
  };
  return {
    kind: "READY",
    sourceShippingMinor: shippingPaid.toString(),
    plannedRefundMinor: decision.transactionMinor,
    currencyCode,
    previewEvidence: {
      order: {
        id: order.id,
        name: order.name,
        test: order.test === true,
        cancelledAt: order.cancelledAt,
        closedAt: order.closedAt,
        displayFinancialStatus: order.displayFinancialStatus,
        currencyCode,
        presentmentCurrencyCode: order.presentmentCurrencyCode,
        taxesIncluded: order.taxesIncluded,
        shippingPaidMinor: shippingPaid.toString(),
        shippingTaxMinor: shippingTax.toString(),
        refundedShippingMinor: refundedShipping.toString(),
        refundCount: refunds.length,
        transactionCount: transactions.length,
      },
      preview: {
        shippingMinor: built.amounts.previewShippingMinor,
        shippingTaxMinor: built.amounts.previewShippingTaxMinor,
        totalMinor: built.amounts.previewTotalMinor,
        maxShippingMinor: built.amounts.maxShippingRefundableMinor,
        maxPaymentMinor: built.amounts.maxPaymentRefundableMinor,
      },
      allocation: {
        parentTransactionId: parentTxn.id,
        parentKind: parentTxn.kind,
        parentStatus: parentTxn.status,
        gateway,
      },
    },
    requestPayload,
    requestHash: requestHashOf(requestPayload),
  };
}

// ── Scan driver ──────────────────────────────────────────────────────────────

export interface ShadowDeps {
  store: ShippingShadowStore;
  ops: Pick<OperationStore, "getControl" | "listAttempts">;
  settings: (shop: string) => Promise<MergeSettings>;
  /** Offline admin per shop; null = no session. */
  adminFactory: (shop: string) => Promise<AdminClient | null>;
  leaseTtlMs?: number;
  retryMs?: number;
  maxAttempts?: number;
}

export type ShadowEntryOutcome =
  | "READY"
  | "SKIPPED"
  | "REVIEW_REQUIRED"
  | "RETRY_SCHEDULED"
  | "EXISTS"
  | "PENDING_HELD"
  | "LEASE_LOST"
  | "GATE_CLOSED"
  | "NO_SESSION"
  | "ERROR";

export interface ShadowScanEntry {
  shop: string;
  mergeOperationId: string;
  sourceOrderId: string;
  sourceOrderName?: string;
  outcome: ShadowEntryOutcome;
  detail?: string;
}

export interface ShadowScanReport {
  applied: boolean;
  subsystemEnabled: boolean;
  entries: ShadowScanEntry[];
}

const reconstructPolicy = (row: {
  policyKind: string;
  policyRetainedMinor: string | null;
  policyCurrencyCode: string | null;
}): ShippingPolicy | null => {
  if (row.policyKind === "REFUND_ALL") return { kind: "REFUND_ALL" };
  if (row.policyKind === "RETAIN_FIXED" && row.policyRetainedMinor && row.policyCurrencyCode) {
    return {
      kind: "RETAIN_FIXED",
      retainedMinor: row.policyRetainedMinor,
      currencyCode: row.policyCurrencyCode,
    };
  }
  return null;
};

/** Snapshot the merchant's current shipping policy for an intent row. */
export function policySnapshot(
  settings: MergeSettings,
): { kind: ShippingPolicyKind; retainedMinor: string | null; currencyCode: string | null } {
  if (
    settings.shippingPolicy === "RETAIN_FIXED" &&
    settings.shippingRetainedMinor &&
    settings.shippingRetainedCurrency
  ) {
    return {
      kind: "RETAIN_FIXED",
      retainedMinor: settings.shippingRetainedMinor,
      currencyCode: settings.shippingRetainedCurrency,
    };
  }
  if (settings.shippingPolicy === "REFUND_ALL") {
    return { kind: "REFUND_ALL", retainedMinor: null, currencyCode: null };
  }
  // Unsupported/malformed settings policy — reported to the caller; the
  // identity falls back to REFUND_ALL so the CHECK constraint is never
  // violated, while the row's reviewReason records the real value.
  return { kind: "REFUND_ALL", retainedMinor: null, currencyCode: null };
}

const isPolicySupported = (settings: MergeSettings) =>
  settings.shippingPolicy === "REFUND_ALL" ||
  (settings.shippingPolicy === "RETAIN_FIXED" &&
    !!settings.shippingRetainedMinor &&
    !!settings.shippingRetainedCurrency);

/**
 * One shadow scan over the rollout shops. With `apply: false` nothing is
 * written (dry run — outcomes are still computed with fresh Shopify reads).
 * With `apply: true` outcomes persist via the store, which itself refuses to
 * write outside MERGESHIP_SHADOW_DATABASE.
 */
export async function runShadowScan(
  deps: ShadowDeps,
  opts: { shop?: string; limit?: number; apply: boolean },
): Promise<ShadowScanReport> {
  const report: ShadowScanReport = {
    applied: opts.apply,
    subsystemEnabled: false,
    entries: [],
  };
  const control = await deps.ops.getControl();
  if (!control?.shippingAdjustmentsEnabled) return report;
  report.subsystemEnabled = true;
  const shops = (opts.shop
    ? control.shippingAllowShops.filter((s) => s === opts.shop)
    : [...control.shippingAllowShops]
  ).sort();
  if (!shops.length) return report;

  const ttl = deps.leaseTtlMs ?? SHADOW_LEASE_TTL_MS;
  const retryMs = deps.retryMs ?? SHADOW_RETRY_MS;
  const maxAttempts = deps.maxAttempts ?? SHADOW_MAX_ATTEMPTS;
  const limit = opts.limit ?? 50;

  const push = (e: ShadowScanEntry) => report.entries.push(e);

  /** Evaluate an owned intent and persist (or report) the outcome. */
  const finish = async (
    row: Pick<
      ShippingShadowRow,
      | "id"
      | "shop"
      | "mergeOperationId"
      | "sourceOrderId"
      | "policyKind"
      | "policyRetainedMinor"
      | "policyCurrencyCode"
      | "marker"
      | "attempts"
      | "leaseToken"
    >,
    op: OperationRecord,
    secondaryName: string,
  ) => {
    const policy = reconstructPolicy(row);
    const entryBase = {
      shop: row.shop,
      mergeOperationId: row.mergeOperationId,
      sourceOrderId: row.sourceOrderId,
      sourceOrderName: secondaryName,
    };
    const settle = async (patch: ShadowSettlePatch, outcome: ShadowEntryOutcome, detail?: string) => {
      if (opts.apply) {
        await deps.store.settleIntent(row.id, row.leaseToken!, patch);
      }
      push({ ...entryBase, outcome, detail });
    };
    if (!policy) {
      return settle(
        {
          status: "REVIEW_REQUIRED",
          reviewReason: `Snapshotted policy ${row.policyKind} is unsupported or malformed.`,
        },
        "REVIEW_REQUIRED",
        "unsupported policy snapshot",
      );
    }
    if (row.attempts >= maxAttempts) {
      return settle(
        {
          status: "REVIEW_REQUIRED",
          reviewReason: `Shadow evaluation attempt cap (${maxAttempts}) reached.`,
        },
        "REVIEW_REQUIRED",
        "attempt cap reached",
      );
    }
    let admin: AdminClient | null = null;
    try {
      admin = await deps.adminFactory(row.shop);
    } catch (err: any) {
      return settle(
        {
          status: "REVIEW_REQUIRED",
          reviewReason: `Shop session lookup failed: ${err?.message ?? err}`,
        },
        "REVIEW_REQUIRED",
        "session lookup failed",
      );
    }
    if (!admin) {
      return settle(
        { status: "REVIEW_REQUIRED", reviewReason: "No offline session for the shop." },
        "NO_SESSION",
        "no offline session",
      );
    }
    try {
      const outcome = await evaluateShadowSource(readOnlyAdmin(admin), {
        sourceOrderId: row.sourceOrderId,
        policy,
        marker: row.marker ?? `MS-SHIP-${row.id}`,
        primaryOrderName: op.primaryOrderName,
      });
      if (outcome.kind === "READY") {
        return settle(
          {
            status: "READY",
            sourceShippingMinor: outcome.sourceShippingMinor,
            plannedRefundMinor: outcome.plannedRefundMinor,
            currencyCode: outcome.currencyCode,
            previewEvidence: outcome.previewEvidence,
            requestPayload: outcome.requestPayload,
            requestHash: outcome.requestHash,
          },
          "READY",
          `refund ${outcome.plannedRefundMinor} minor units of ${outcome.currencyCode}`,
        );
      }
      if (outcome.kind === "SKIP") {
        return settle(
          { status: "SKIPPED", reasonCode: outcome.reasonCode, reviewReason: outcome.reason },
          "SKIPPED",
          outcome.reason,
        );
      }
      return settle(
        { status: "REVIEW_REQUIRED", reviewReason: outcome.reason },
        "REVIEW_REQUIRED",
        outcome.reason,
      );
    } catch (err) {
      if (err instanceof OwnershipLostError) throw err;
      const detail = err instanceof ShopifyGraphqlError ? err.message : String(err);
      if (!opts.apply) {
        return push({ ...entryBase, outcome: "RETRY_SCHEDULED", detail });
      }
      await deps.store.rescheduleIntent(row.id, row.leaseToken!, retryMs, `TRANSIENT`);
      return push({ ...entryBase, outcome: "RETRY_SCHEDULED", detail });
    }
  };

  for (const shop of shops) {
    const settings = await deps.settings(shop);
    // The merchant opt-in gate is a precondition for ANY write: without it no
    // row is created at all (a later opt-in stamps a fresh epoch anyway, so
    // nothing here could ever qualify retroactively).
    const optedIn =
      settings.shippingAdjustmentEnabled === true &&
      settings.shippingAdjustmentEnabledAt instanceof Date &&
      !Number.isNaN(settings.shippingAdjustmentEnabledAt.getTime());
    const ops = await deps.store.findCompletedOps(shop, limit);
    for (const op of ops) {
      try {
      const [records, attempts, existing] = await Promise.all([
        deps.store.listMergeRecords(shop, op.id),
        deps.ops.listAttempts(op.id),
        deps.store.findAdjustments(
          shop,
          (op.secondaries ?? []).map((s: OperationSecondary) => s.id),
        ),
      ]);
      const bySource = new Map(existing.map((r) => [r.sourceOrderId, r]));

      for (const secondary of (op.secondaries ?? []) as OperationSecondary[]) {
        const base = {
          shop,
          mergeOperationId: op.id,
          sourceOrderId: secondary.id,
          sourceOrderName: secondary.name,
        };
        const row = bySource.get(secondary.id);

        if (row) {
          // Terminal verdicts are immutable; a live lease is another worker's.
          if (row.status !== "PENDING") {
            push({ ...base, outcome: "EXISTS", detail: `status ${row.status}` });
            continue;
          }
          const gateOpen = isShippingIntentAllowed({
            shippingAdjustmentsEnabled: control.shippingAdjustmentsEnabled,
            shippingAllowShops: control.shippingAllowShops,
            shop,
            shopEnabled: settings.shippingAdjustmentEnabled,
            enabledAt: settings.shippingAdjustmentEnabledAt,
            operationCreatedAt: row.operationCreatedAt,
          });
          if (!gateOpen) {
            push({ ...base, outcome: "GATE_CLOSED" });
            continue;
          }
          if (!opts.apply) {
            push({ ...base, outcome: "EXISTS", detail: "PENDING (dry run)" });
            continue;
          }
          const reclaimed = await deps.store.reclaimIntent(row.id, crypto.randomUUID(), ttl);
          if (!reclaimed) {
            push({ ...base, outcome: "PENDING_HELD" });
            continue;
          }
          try {
            await finish(reclaimed, op, secondary.name);
          } catch (err) {
            if (!(err instanceof OwnershipLostError)) throw err;
            push({ ...base, outcome: "LEASE_LOST" });
          }
          continue;
        }

        // No row yet. The full activation gate decides whether anything is
        // allowed; only an epoch-excluded combine gets a durable SKIPPED row.
        const gateOpen = isShippingIntentAllowed({
          shippingAdjustmentsEnabled: control.shippingAdjustmentsEnabled,
          shippingAllowShops: control.shippingAllowShops,
          shop,
          shopEnabled: settings.shippingAdjustmentEnabled,
          enabledAt: settings.shippingAdjustmentEnabledAt,
          operationCreatedAt: op.createdAt,
        });
        if (!gateOpen) {
          // Everything passed except the epoch: the combine predates the
          // current activation epoch and can never qualify — record a durable
          // SKIPPED row so it is never re-examined.
          if (optedIn && op.createdAt < settings.shippingAdjustmentEnabledAt!) {
            if (opts.apply) {
              const snap = policySnapshot(settings);
              await deps.store.recordTerminal(
                {
                  shop,
                  mergeOperationId: op.id,
                  sourceOrderId: secondary.id,
                  operationCreatedAt: op.createdAt,
                  policyKind: snap.kind,
                  policyRetainedMinor: snap.retainedMinor,
                  policyCurrencyCode: snap.currencyCode,
                },
                "SKIPPED",
                { reasonCode: "BEFORE_EPOCH", reviewReason: "Combine predates the shipping activation epoch." },
              );
            }
            push({ ...base, outcome: "SKIPPED", detail: "before activation epoch" });
          } else {
            push({ ...base, outcome: "GATE_CLOSED" });
          }
          continue;
        }

        if (!isPolicySupported(settings)) {
          if (opts.apply) {
            const snap = policySnapshot(settings);
            await deps.store.recordTerminal(
              {
                shop,
                mergeOperationId: op.id,
                sourceOrderId: secondary.id,
                operationCreatedAt: op.createdAt,
                policyKind: snap.kind,
                policyRetainedMinor: snap.retainedMinor,
                policyCurrencyCode: snap.currencyCode,
              },
              "REVIEW_REQUIRED",
              { reviewReason: `Settings.shippingPolicy '${settings.shippingPolicy}' is unsupported or malformed.` },
            );
          }
          push({ ...base, outcome: "REVIEW_REQUIRED", detail: "unsupported settings policy" });
          continue;
        }

        // The combine's own evidence must prove this secondary before any
        // Shopify read happens — a contradiction parks REVIEW_REQUIRED.
        const verdict = assessSecondaryEvidence({
          operation: {
            id: op.id,
            protocolVersion: op.protocolVersion,
            phase: op.phase,
            calculatedOrderId: op.calculatedOrderId,
            opToken: op.opToken,
            primaryOrderId: op.primaryOrderId,
            expectedTransfer: op.expectedTransfer,
            appliedEvidence: op.appliedEvidence,
          },
          secondary,
          mergeRecords: records,
          attempts,
        });
        if (!verdict.eligible) {
          if (opts.apply) {
            const snap = policySnapshot(settings);
            await deps.store.recordTerminal(
              {
                shop,
                mergeOperationId: op.id,
                sourceOrderId: secondary.id,
                operationCreatedAt: op.createdAt,
                policyKind: snap.kind,
                policyRetainedMinor: snap.retainedMinor,
                policyCurrencyCode: snap.currencyCode,
              },
              "REVIEW_REQUIRED",
              { reviewReason: `Combine evidence incomplete: ${verdict.issues.join(" ")}` },
            );
          }
          push({ ...base, outcome: "REVIEW_REQUIRED", detail: verdict.issues.join(" ") });
          continue;
        }

        // A combine whose side effects did not finish is re-considered next
        // scan instead of being parked on a state that is still changing.
        if (!op.sideEffectsDone) {
          push({ ...base, outcome: "EXISTS", detail: "combine side effects unfinished" });
          continue;
        }

        const snap = policySnapshot(settings);
        const identity: ShadowIntentIdentity = {
          shop,
          mergeOperationId: op.id,
          sourceOrderId: secondary.id,
          operationCreatedAt: op.createdAt,
          policyKind: snap.kind,
          policyRetainedMinor: snap.retainedMinor,
          policyCurrencyCode: snap.currencyCode,
        };
        if (!opts.apply) {
          // Dry run: evaluate directly — reads only, no rows.
          const policy = reconstructPolicy({
            policyKind: identity.policyKind,
            policyRetainedMinor: identity.policyRetainedMinor,
            policyCurrencyCode: identity.policyCurrencyCode,
          })!;
          const admin = await deps.adminFactory(shop);
          if (!admin) {
            push({ ...base, outcome: "NO_SESSION" });
            continue;
          }
          try {
            const outcome = await evaluateShadowSource(readOnlyAdmin(admin), {
              sourceOrderId: secondary.id,
              policy,
              marker: "MS-SHIP-DRYRUN",
              primaryOrderName: op.primaryOrderName,
            });
            push({
              ...base,
              outcome:
                outcome.kind === "READY"
                  ? "READY"
                  : outcome.kind === "SKIP"
                    ? "SKIPPED"
                    : "REVIEW_REQUIRED",
              detail: outcome.kind === "READY" ? `refund ${outcome.plannedRefundMinor}` : outcome.reason,
            });
          } catch (err) {
            push({
              ...base,
              outcome: "ERROR",
              detail: err instanceof ShopifyGraphqlError ? err.message : String(err),
            });
          }
          continue;
        }

        const claimed = await deps.store.claimIntent(identity, ttl);
        if (!claimed) {
          // A concurrent scanner won the insert — its verdict stands.
          push({ ...base, outcome: "PENDING_HELD" });
          continue;
        }
        try {
          await finish(claimed, op, secondary.name);
        } catch (err) {
          if (!(err instanceof OwnershipLostError)) throw err;
          push({ ...base, outcome: "LEASE_LOST" });
        }
      }
      } catch (err) {
        // One failed combine must never stop the scan — and a shadow error
        // can never propagate into the combine engine (it shares nothing).
        push({
          shop,
          mergeOperationId: op.id,
          sourceOrderId: "",
          outcome: "ERROR",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return report;
}
