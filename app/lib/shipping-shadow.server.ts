// ── Shipping v0 shadow evaluator (Phase 1.1) ──────────────────────────────────
// A READ-ONLY Shopify-path evaluator that records what a shipping refund
// worker WOULD decide for every eligible secondary of a completed native v2
// combine — without any refund path existing yet.
//
// Isolation guarantees:
//   - Shopify access is forced through readOnlyAdmin(), which refuses any
//     document containing the `mutation` keyword before it reaches the wire.
//   - The only table it writes is ShippingAdjustment, and only through the
//     store below, which refuses every write unless ALL of these hold:
//       * no production markers in the environment (RAILWAY_* / NODE_ENV),
//       * MERGESHIP_SHADOW_DATABASE === current_database(),
//       * the database carries a disposable marker comment containing a token
//         that equals MERGESHIP_SHADOW_TOKEN — a marker only the explicit
//         local test-database bootstrap creates. A database NAME, a localhost
//         address or a comment alone never proves a database is disposable.
//   - Every row it writes carries mode='SHADOW' (CHECK constraint) — shadow
//     evidence is never executable; a future dispatcher must reject it.
//   - It never touches MergeOperation/MergeOrderLock/ProcessedWebhook/
//     MergeRecord/MergeMutationAttempt/MergeClaim — a crashed or wrong
//     evaluation can never modify, restart, block or reverse a combine.
//
// Activation cutoff (B1): an intent may only exist for a combine created
// on/after the LATEST of three epochs — merchant opt-in
// (Settings.shippingAdjustmentEnabledAt), rollout membership
// (Settings.shippingRolloutAt) and the kill switch (AppControl.shippingEnabledAt).
// The cutoff is snapshotted on the row (activationCutoffAt); claimIntent and
// READY-settle recompute it inside the same transaction under FOR SHARE locks
// and refuse when it has changed — so a control change mid-scan can never
// produce a misleading READY row.
//
// Future dispatch gate (DEFINED, NOT IMPLEMENTED — no code path may dispatch):
//   - Promote a SHADOW row through a separately authorized process only;
//   - PENDING→DISPATCHING must re-read AppControl FOR SHARE and the Settings
//     row FOR SHARE in the same transaction and require the recomputed
//     cutoff to equal activationCutoffAt;
//   - Re-read the order + full refund/transaction history and reproduce the
//     frozen preview, requestPayload and requestHash before any dispatch;
//   - Reject READY evidence older than a bounded age (e.g. 24h);
//   - Reject on opt-out, uninstall, any control change, policy drift or any
//     inconsistent financial evidence. Never resend with a new key.
//
// Concurrency: intent rows are claimed by INSERT (unique (shop,
// sourceOrderId)) with a lease; PENDING rows are re-leased only after the
// lease expires AND nextCheckAt is due; every outcome write is a
// token+unexpired-conditional UPDATE on the database wall clock, exactly
// like the merge stores. Leases give liveness and stale-write fencing only.
//
// Fail-closed rules (all become REVIEW_REQUIRED unless noted):
//   non-native-v2/incomplete combine evidence, missing/uncancelled/unclosed
//   secondary, non-PAID financial state, multi-currency orders, unknown
//   currency precision, tax-bearing shipping (E3 pending), prior shipping
//   refunds, unbounded/unverifiable refund or transaction histories,
//   inconsistent Shopify previews, ambiguous/split suggested transactions,
//   any gateway other than `bogus` on a proven test order, no verifiable
//   capture/sale allocation, unsupported policy. Terminal verdicts are
//   immutable: READY, SKIPPED and REVIEW_REQUIRED rows are never rewritten
//   by a later scan.

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
import { shippingActivationCutoff } from "./shipping-activation";
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
/** New durable outcomes per combine per scan. Terminal rows and PENDING
 *  reclaims never consume the allowance, so a combine with up to 50
 *  secondaries always progresses. */
const SECONDARY_SCAN_CAP = 25;
/** The marker prefix stamped on a disposable database by the local bootstrap.
 *  Format: `mergeship-shadow-disposable:<token>`. */
export const SHADOW_DB_MARKER_PREFIX = "mergeship-shadow-disposable:";
/** The only gateway a v0 shadow READY payload may allocate to: Bogus Gateway
 *  on a proven test order. Real gateways stay disabled until a separate
 *  production-gateway decision; manual/gift_card/cash and every unknown
 *  gateway are REVIEW. */
const GATEWAY_BOGUS_TEST = "bogus";

export class ShadowDatabaseNotAllowedError extends Error {
  name = "ShadowDatabaseNotAllowedError";
}

/** Dry runs must never trigger an offline-session token refresh: the Shopify
 *  library rotates the refresh token with Shopify BEFORE attempting the
 *  Session write, so a failed write can strand the shop's only refresh
 *  credential. The library's own refresh threshold is 5 minutes
 *  (WITHIN_MILLISECONDS_OF_EXPIRY); a dry run requires the access token to
 *  have much more life than that so the two checks can never disagree. */
export const DRY_RUN_SESSION_MIN_REMAINING_MS = 30 * 60 * 1000;
export function dryRunSessionUsable(
  session: { expires: Date | null } | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!session) return false;
  // A session with no expiry (non-expiring token) is never refreshed.
  if (!(session.expires instanceof Date)) return true;
  return session.expires.getTime() - now.getTime() > DRY_RUN_SESSION_MIN_REMAINING_MS;
}
/** A control change committed while a claim/READY write was in flight — the
 *  write is refused; the PENDING row survives for a later re-evaluation. */
export class GateChangedError extends Error {
  name = "GateChangedError";
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

// ── GraphQL (read-only). Both documents were executed verbatim against the ──
// pinned 2026-04 API on ordermergetest2 (M5) — including suggestedRefund's
// shippingAmount variable and the suggestedTransactions/parentTransaction
// shape — and the RefundInput payload below was validated by introspection.

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
          discountedPriceSet { presentmentMoney { amount currencyCode } }
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
          parentTransaction { id kind status gateway test }
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
  activationCutoffAt: Date | null;
  mode: string;
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
  /** The effective activation cutoff at scan time — written into the row and
   *  re-verified atomically on READY settle. */
  activationCutoffAt: Date;
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
  /** COMPLETED native-v2 ops that still have at least one secondary with no
   *  ShippingAdjustment row — evaluated combines fall out of the window, so
   *  the limit can never starve newer combines behind terminal rows. */
  findUnevaluatedOps(shop: string, limit: number): Promise<OperationRecord[]>;
  /** PENDING intents whose deferral has elapsed (nextCheckAt due). */
  findDuePending(shop: string, limit: number): Promise<ShippingShadowRow[]>;
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
  /** INSERT a leased PENDING intent carrying the frozen policy + cutoff
   *  snapshot. Recomputes the cutoff under FOR SHARE inside the write
   *  transaction and returns 'GATE_CHANGED' when it no longer matches;
   *  null on (shop, sourceOrderId) conflict. */
  claimIntent(
    identity: ShadowIntentIdentity,
    ttlMs: number,
  ): Promise<ShippingShadowRow | "GATE_CHANGED" | null>;
  /** Re-lease an expired, due PENDING intent; null when live-leased,
   *  not yet due, or no longer PENDING. */
  reclaimIntent(id: string, token: string, ttlMs: number): Promise<ShippingShadowRow | null>;
  /** Settle a claimed intent. A READY settle re-verifies the activation
   *  cutoff under FOR SHARE in the same transaction and throws
   *  GateChangedError on any control change; throws OwnershipLostError on a
   *  stale lease. */
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

/** SQL fragment: bind a JS Date into a naive-UTC TIMESTAMP column safely. */
const utcTs = (d: Date) => Prisma.sql`(${d}::timestamptz AT TIME ZONE 'UTC')`;

/**
 * Recompute the shop's live activation cutoff inside a transaction under
 * FOR SHARE reads — the same linearization discipline the merge dispatch
 * gate uses. Returns null when any prerequisite is inactive.
 */
async function liveCutoff(
  tx: Prisma.TransactionClient,
  shop: string,
): Promise<Date | null> {
  const [control] = await tx.$queryRaw<
    {
      shippingAdjustmentsEnabled: boolean;
      shippingEnabledAt: Date | null;
      shippingAllowShops: string[];
    }[]
  >`SELECT "shippingAdjustmentsEnabled", "shippingEnabledAt", "shippingAllowShops"
    FROM "AppControl" WHERE id = 'control' FOR SHARE`;
  const [settings] = await tx.$queryRaw<
    {
      shippingAdjustmentEnabled: boolean;
      shippingAdjustmentEnabledAt: Date | null;
      shippingRolloutAt: Date | null;
    }[]
  >`SELECT "shippingAdjustmentEnabled", "shippingAdjustmentEnabledAt", "shippingRolloutAt"
    FROM "Settings" WHERE "shop" = ${shop} FOR SHARE`;
  if (!control) return null;
  return shippingActivationCutoff({
    shippingAdjustmentsEnabled: control.shippingAdjustmentsEnabled,
    shippingEnabledAt: control.shippingEnabledAt,
    shippingAllowShops: control.shippingAllowShops,
    shop,
    shippingRolloutAt: settings?.shippingRolloutAt ?? null,
    shopEnabled: settings?.shippingAdjustmentEnabled ?? false,
    enabledAt: settings?.shippingAdjustmentEnabledAt ?? null,
  });
}

const sameInstant = (a: Date | null, b: Date | null) =>
  a instanceof Date && b instanceof Date && a.getTime() === b.getTime();

export function makeShippingShadowStore(db: PrismaClient = defaultDb): ShippingShadowStore {
  let writableChecked = false;
  /**
   * Hard guard: persistent shadow evidence is allowed ONLY on a database that
   * proves it is the disposable one. A name match, a localhost address or a
   * comment alone are never sufficient — the marker comment must carry the
   * token the operator exported as MERGESHIP_SHADOW_TOKEN, and production
   * environment markers refuse outright. The marker is created only by the
   * explicit test-database bootstrap (tests / scripts), never by migrations.
   */
  const assertWritable = async () => {
    if (writableChecked) return;
    if (
      process.env.NODE_ENV === "production" ||
      process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_ENVIRONMENT_NAME ||
      process.env.RAILWAY_PROJECT_ID
    ) {
      throw new ShadowDatabaseNotAllowedError(
        "Shadow writes refused: a production environment marker is set.",
      );
    }
    const expectedDb = process.env.MERGESHIP_SHADOW_DATABASE;
    const expectedToken = process.env.MERGESHIP_SHADOW_TOKEN;
    const [row] = await db.$queryRaw<{ db: string; marker: string | null }[]>`
      SELECT current_database() AS db,
        shobj_description(
          (SELECT oid FROM pg_database WHERE datname = current_database()),
          'pg_database'
        ) AS marker`;
    if (!expectedDb || !row || expectedDb !== row.db) {
      throw new ShadowDatabaseNotAllowedError(
        `Shadow writes refused: MERGESHIP_SHADOW_DATABASE (${expectedDb ?? "unset"}) does not match current_database() (${row?.db ?? "unknown"}).`,
      );
    }
    if (
      !expectedToken ||
      row.marker !== `${SHADOW_DB_MARKER_PREFIX}${expectedToken}`
    ) {
      throw new ShadowDatabaseNotAllowedError(
        `Shadow writes refused: database '${row.db}' carries no disposable marker matching MERGESHIP_SHADOW_TOKEN.`,
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
    async findUnevaluatedOps(shop, limit) {
      return db.$queryRaw<OperationRecord[]>`
        SELECT op.* FROM "MergeOperation" op
        WHERE op."shop" = ${shop} AND op."protocolVersion" = 2 AND op."phase" = 'COMPLETED'
          -- Cleanup-deferred combines (sideEffectsDone=false with a scheduled
          -- nextCheckAt) are excluded from the bounded window: merge
          -- completion and shipping are independent switches, so an op may
          -- await cleanup indefinitely and must never starve newer combines.
          -- When its state resolves — sideEffectsDone=true, or nextCheckAt
          -- cleared by the worker give-up — it re-enters the window.
          AND (op."sideEffectsDone" = true OR op."nextCheckAt" IS NULL)
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(op."secondaries") s
            WHERE NOT EXISTS (
              SELECT 1 FROM "ShippingAdjustment" sa
              WHERE sa."shop" = op."shop" AND sa."sourceOrderId" = (s->>'id')
            )
          )
        ORDER BY op."createdAt" ASC
        LIMIT ${limit}`;
    },

    async findDuePending(shop, limit) {
      const rows = await db.$queryRaw<any[]>`
        SELECT * FROM "ShippingAdjustment"
        WHERE "shop" = ${shop} AND "status" = 'PENDING'
          AND ("nextCheckAt" IS NULL OR "nextCheckAt" <= ${DB_WALL})
        ORDER BY "nextCheckAt" ASC NULLS FIRST
        LIMIT ${limit}`;
      return rows.map(toShadowRow);
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
          "activationCutoffAt",
          "policyKind", "policyRetainedMinor", "policyCurrencyCode",
          "status", "idempotencyKey", "marker", "reasonCode", "reviewReason",
          "attempts", "createdAt", "updatedAt"
        ) VALUES (
          ${b.id}, ${identity.shop}, ${identity.mergeOperationId}, ${identity.sourceOrderId},
          ${utcTs(identity.operationCreatedAt)},
          ${utcTs(identity.activationCutoffAt)},
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
      return withOwnershipTx(db, async (tx) => {
        // Atomic gate: the recomputed live cutoff must equal the snapshot the
        // scan is about to write — a control change committed while this tx
        // waits on the FOR SHARE locks is always observed.
        const cutoff = await liveCutoff(tx, identity.shop);
        if (!sameInstant(cutoff, identity.activationCutoffAt)) return "GATE_CHANGED" as const;
        const rows = await tx.$queryRaw<any[]>`
          INSERT INTO "ShippingAdjustment" (
            "id", "shop", "mergeOperationId", "sourceOrderId", "operationCreatedAt",
            "activationCutoffAt",
            "policyKind", "policyRetainedMinor", "policyCurrencyCode",
            "status", "idempotencyKey", "marker",
            "leaseToken", "leasedUntil", "nextCheckAt", "attempts",
            "createdAt", "updatedAt"
          ) VALUES (
            ${b.id}, ${identity.shop}, ${identity.mergeOperationId}, ${identity.sourceOrderId},
            ${utcTs(identity.operationCreatedAt)},
            ${utcTs(identity.activationCutoffAt)},
            ${b.kind}, ${b.minor}, ${b.currency},
            'PENDING', ${b.idem}, ${b.marker},
            ${crypto.randomUUID()}, ${dbWallPlus(ttlMs)}, ${DB_WALL}, 1,
            ${DB_WALL}, ${DB_WALL}
          )
          ON CONFLICT ("shop", "sourceOrderId") DO NOTHING
          RETURNING *`;
        return rows.length ? toShadowRow(rows[0]) : null;
      });
    },

    async reclaimIntent(id, token, ttlMs) {
      await assertWritable();
      const rows = await db.$queryRaw<any[]>`
        UPDATE "ShippingAdjustment"
        SET "leaseToken" = ${token}, "leasedUntil" = ${dbWallPlus(ttlMs)},
            "attempts" = "attempts" + 1, "updatedAt" = ${DB_WALL}
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
        const [row] = await tx.$queryRaw<
          { shop: string; activationCutoffAt: Date | null }[]
        >`SELECT "shop", "activationCutoffAt" FROM "ShippingAdjustment"
          WHERE id = ${id} FOR UPDATE`;
        // READY is the last writable verdict with financial content — the
        // live cutoff must still equal the row's snapshot. Any control change
        // committed while this tx waited on the row/FOR SHARE locks is
        // observed here and refuses the write.
        if (patch.status === "READY") {
          const cutoff = await liveCutoff(tx, row?.shop ?? "");
          if (!row || !sameInstant(cutoff, row.activationCutoffAt)) {
            throw new GateChangedError(
              `Shipping intent ${id}: activation cutoff changed since intent creation.`,
            );
          }
        }
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

/** Sum MoneyV2 fragments into minor units; null when any value is
 *  unparseable or in a different currency than the order's. */
const sumMoney = (values: any[], currencyCode: string): bigint | null => {
  let total = 0n;
  for (const v of values) {
    const parsed = parseShopMoney(v);
    if (!parsed || parsed.currencyCode !== currencyCode) return null;
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

  const currencyCode = order.currencyCode;
  const shippingNodes = order.shippingLines.nodes as any[];
  // What the customer actually paid for shipping is the DISCOUNTED price —
  // originalPriceSet is pre-discount and would overstate the refund target.
  const shippingPaid = sumMoney(
    shippingNodes.map((l) => l?.discountedPriceSet?.presentmentMoney),
    currencyCode,
  );
  const shippingOriginal = sumMoney(
    shippingNodes.map((l) => l?.originalPriceSet?.presentmentMoney),
    currencyCode,
  );
  const shippingTax = sumMoney(
    shippingNodes.flatMap((l) => (l?.taxLines ?? []).map((t: any) => t?.priceSet?.presentmentMoney)),
    currencyCode,
  );
  if (shippingPaid === null || shippingTax === null || shippingOriginal === null) {
    return review("Shipping price or tax amounts are unparseable or in a foreign currency.");
  }

  // Refund history: the bounded refund list's shipping lines must reconcile
  // exactly with the order-level refunded-shipping aggregate.
  const refundedShippingLines = refunds.flatMap((r: any) => r.refundShippingLines?.nodes ?? []);
  const refundedShipping = sumMoney(
    refundedShippingLines.map((l: any) => l?.subtotalAmountSet?.presentmentMoney),
    currencyCode,
  );
  if (refundedShipping === null) {
    return review("Refunded shipping amounts are unparseable or in a foreign currency.");
  }
  const aggregateRefunded = parseShopMoney(order.totalRefundedShippingSet?.presentmentMoney);
  if (!aggregateRefunded || aggregateRefunded.currencyCode !== currencyCode) {
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

  // Transaction allocation: v0 accepts exactly ONE suggested transaction —
  // a split refund across parents/gateways is ambiguous and never guessed.
  // It must be a SUGGESTED_REFUND moving exactly the planned amount whose
  // parent is a verifiably successful CAPTURE or SALE on this same order.
  const suggested = Array.isArray(preview.suggestedTransactions)
    ? preview.suggestedTransactions
    : [];
  if (suggested.length !== 1) {
    return review(
      `Refund preview suggests ${suggested.length} transactions; a single exact allocation is required.`,
    );
  }
  const [suggestion] = suggested;
  if (suggestion?.kind !== "SUGGESTED_REFUND") {
    return review(`Suggested transaction kind ${suggestion?.kind ?? "unknown"} is not supported.`);
  }
  const suggestedAmount = parseShopMoney(suggestion.amountSet?.presentmentMoney);
  if (
    !suggestedAmount ||
    suggestedAmount.currencyCode !== currencyCode ||
    suggestedAmount.minorUnits !== BigInt(decision.transactionMinor)
  ) {
    return review("Suggested transaction amount does not equal the planned refund total.");
  }
  const parent = suggestion.parentTransaction;
  const parentTxn =
    parent &&
    transactions.find(
      (t: any) =>
        t?.id === parent.id &&
        t?.status === "SUCCESS" &&
        (t?.kind === "CAPTURE" || t?.kind === "SALE"),
    );
  if (!parentTxn) {
    return review("No verifiable capture/sale transaction for the refund allocation.");
  }
  // Gateway allowlist: only Bogus Gateway, and only on a proven test order.
  // Production-gateway enablement is a separate decision — manual,
  // gift_card, cash and every unknown gateway are REVIEW.
  const gateway = suggestion.gateway;
  if (typeof gateway !== "string" || !gateway || parentTxn.gateway !== gateway) {
    return review("Suggested transaction gateway is missing or inconsistent.");
  }
  if (gateway !== GATEWAY_BOGUS_TEST) {
    return review(`Gateway '${gateway}' is not on the shipping-refund allowlist.`);
  }
  if (parent.test !== true || parentTxn.test !== true || order.test !== true) {
    return review("Transaction test flags are inconsistent with a test order.");
  }

  // Frozen RefundInput — verified against the 2026-04 schema by introspection
  // and by the E1/E2 live shipping-only refunds on ordermergetest2:
  //   RefundInput.shipping    → ShippingRefundInput { amount: Money, fullRefund }
  //   RefundInput.transactions → [OrderTransactionInput!] { orderId, parentId,
  //                             gateway, kind: REFUND, amount: Money }
  // `amount` is a plain Money scalar in both places — NOT a MoneyInput. The
  // similarly named RefundShippingInput.shippingRefundAmount belongs to the
  // returns API, not refundCreate; using it here would produce an invalid input.
  const requestPayload = {
    orderId: input.sourceOrderId,
    notify: false,
    note: `MergeShip shipping adjustment ${input.marker} — shipping refunded for order merged into ${input.primaryOrderName}.`,
    currency: currencyCode,
    shipping: {
      amount: minorToDecimal(decision.shippingMinor, precision),
      fullRefund: false,
    },
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
        shippingOriginalMinor: shippingOriginal.toString(),
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
        suggestedTransactionMinor: suggestedAmount.minorUnits.toString(),
      },
      allocation: {
        parentTransactionId: parentTxn.id,
        parentKind: parentTxn.kind,
        parentStatus: parentTxn.status,
        parentTest: parentTxn.test === true,
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
  ops: Pick<OperationStore, "getControl" | "getOperation" | "listAttempts">;
  settings: (shop: string) => Promise<MergeSettings>;
  /** Offline admin per shop; null = no session. Throwing means the session
   *  lookup itself failed — treated as TRANSIENT (rescheduled), never as a
   *  financial-review outcome. */
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
  | "GATE_CHANGED"
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
 * write unless the connected database proves it is the disposable one.
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
      | "activationCutoffAt"
      | "policyKind"
      | "policyRetainedMinor"
      | "policyCurrencyCode"
      | "marker"
      | "attempts"
      | "leaseToken"
    >,
    op: OperationRecord | null,
    secondaryName: string,
    liveCutoffNow: Date | null,
  ) => {
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
    // Activation must be unchanged since the row was created — a toggled
    // control stamps a NEW epoch, so equality is the re-gate. REVIEW settles
    // are non-executable evidence and do not need the atomic gate; READY is
    // additionally re-verified inside settleIntent's transaction.
    if (!sameInstant(liveCutoffNow, row.activationCutoffAt)) {
      return settle(
        {
          status: "REVIEW_REQUIRED",
          reviewReason: "Activation state changed since the intent was created.",
        },
        "REVIEW_REQUIRED",
        "activation cutoff changed",
      );
    }
    const policy = reconstructPolicy(row);
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
    // attempts counts claims+reclaims; a value > cap parks the intent.
    if (row.attempts > maxAttempts) {
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
      // Session/lookup failures are transient infrastructure problems — the
      // intent is rescheduled, never burned into a permanent REVIEW.
      const detail = String(err?.message ?? err);
      if (!opts.apply) {
        return push({ ...entryBase, outcome: "ERROR", detail });
      }
      try {
        await deps.store.rescheduleIntent(row.id, row.leaseToken!, retryMs, "TRANSIENT");
      } catch (e2) {
        if (!(e2 instanceof OwnershipLostError)) throw e2;
        return push({ ...entryBase, outcome: "LEASE_LOST" });
      }
      return push({ ...entryBase, outcome: "RETRY_SCHEDULED", detail });
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
        primaryOrderName: op?.primaryOrderName ?? "",
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
    const cutoff = shippingActivationCutoff({
      shippingAdjustmentsEnabled: control.shippingAdjustmentsEnabled,
      shippingEnabledAt: control.shippingEnabledAt,
      shippingAllowShops: control.shippingAllowShops,
      shop,
      shippingRolloutAt: settings.shippingRolloutAt,
      shopEnabled: settings.shippingAdjustmentEnabled,
      enabledAt: settings.shippingAdjustmentEnabledAt,
    });

    // ── A) Due PENDING intents: re-lease and re-evaluate ──
    for (const row of await deps.store.findDuePending(shop, limit)) {
      const base = {
        shop,
        mergeOperationId: row.mergeOperationId,
        sourceOrderId: row.sourceOrderId,
      };
      if (!opts.apply) {
        // Dry runs are observational only: no reclaim, no lease, no attempt
        // spent, no ShippingAdjustment write — and no error either.
        push({ ...base, outcome: "PENDING_HELD", detail: "dry run — intent not reclaimed" });
        continue;
      }
      try {
        const reclaimed = await deps.store.reclaimIntent(row.id, crypto.randomUUID(), ttl);
        if (!reclaimed) {
          push({ ...base, outcome: "PENDING_HELD" });
          continue;
        }
        const op = await deps.ops.getOperation(row.mergeOperationId);
        const secondary = (op?.secondaries ?? []).find(
          (s: OperationSecondary) => s.id === row.sourceOrderId,
        );
        if (!op || op.phase !== "COMPLETED" || !secondary) {
          await deps.store.settleIntent(reclaimed.id, reclaimed.leaseToken!, {
            status: "REVIEW_REQUIRED",
            reviewReason: "Combine evidence is missing or the operation is no longer COMPLETED.",
          });
          push({ ...base, outcome: "REVIEW_REQUIRED", detail: "combine evidence missing" });
          continue;
        }
        await finish(reclaimed, op, secondary.name, cutoff);
      } catch (err) {
        if (err instanceof ShadowDatabaseNotAllowedError) {
          // A guard misconfiguration is global, not per-combine — abort the
          // scan so the operator sees the actionable error.
          throw err;
        }
        if (err instanceof OwnershipLostError) {
          push({ ...base, outcome: "LEASE_LOST" });
        } else if (err instanceof GateChangedError) {
          push({ ...base, outcome: "GATE_CHANGED" });
        } else {
          push({ ...base, outcome: "ERROR", detail: String((err as Error)?.message ?? err) });
        }
      }
    }

    // ── B) Combines with at least one never-evaluated secondary ──
    for (const op of await deps.store.findUnevaluatedOps(shop, limit)) {
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
        const allSecondaries = (op.secondaries ?? []) as OperationSecondary[];
        // The per-scan allowance covers NEW durable outcomes only: up to
        // SECONDARY_SCAN_CAP secondaries with no row. Terminal rows never
        // consume the allowance and PENDING reclaims are handled outside it,
        // so a combine with up to 50 secondaries always progresses.
        const rowFree = allSecondaries.filter((s) => !bySource.has(s.id));
        const pendingRows = allSecondaries.filter(
          (s) => bySource.get(s.id)?.status === "PENDING",
        );
        // sideEffectsDone=false + nextCheckAt=null is the permanent give-up
        // state (the worker cleared the schedule after MAX_SIDE_EFFECT_PASSES).
        // While nextCheckAt is set, cleanup is still scheduled — defer.
        const cleanupStopped = !op.sideEffectsDone && op.nextCheckAt == null;

        for (const secondary of rowFree.slice(0, SECONDARY_SCAN_CAP)) {
          const base = {
            shop,
            mergeOperationId: op.id,
            sourceOrderId: secondary.id,
            sourceOrderName: secondary.name,
          };

          // cutoff === null means a prerequisite is inactive: nothing is
          // written, nothing can become eligible retroactively.
          if (cutoff === null) {
            push({ ...base, outcome: "GATE_CLOSED" });
            continue;
          }

          if (!op.sideEffectsDone) {
            if (cleanupStopped) {
              // Cleanup permanently stopped: a refund is never authorized on
              // incomplete combine evidence, and the op must not pin the scan
              // window — record a durable fail-closed REVIEW.
              if (opts.apply) {
                const snap = policySnapshot(settings);
                await deps.store.recordTerminal(
                  {
                    shop,
                    mergeOperationId: op.id,
                    sourceOrderId: secondary.id,
                    operationCreatedAt: op.createdAt,
                    activationCutoffAt: cutoff,
                    policyKind: snap.kind,
                    policyRetainedMinor: snap.retainedMinor,
                    policyCurrencyCode: snap.currencyCode,
                  },
                  "REVIEW_REQUIRED",
                  {
                    reasonCode: "CLEANUP_STOPPED",
                    reviewReason:
                      "Combine cleanup permanently stopped before side effects completed; shipping evidence is incomplete.",
                  },
                );
              }
              push({
                ...base,
                outcome: "REVIEW_REQUIRED",
                detail: "combine cleanup permanently stopped",
              });
            } else {
              // Cleanup still scheduled — re-consider next scan.
              push({ ...base, outcome: "EXISTS", detail: "combine side effects unfinished" });
            }
            continue;
          }

          // No row yet. A combine predating the CURRENT cutoff can never
          // qualify — record a durable SKIPPED row so it is never re-examined.
          if (op.createdAt.getTime() < cutoff.getTime()) {
            if (opts.apply) {
              const snap = policySnapshot(settings);
              await deps.store.recordTerminal(
                {
                  shop,
                  mergeOperationId: op.id,
                  sourceOrderId: secondary.id,
                  operationCreatedAt: op.createdAt,
                  activationCutoffAt: cutoff,
                  policyKind: snap.kind,
                  policyRetainedMinor: snap.retainedMinor,
                  policyCurrencyCode: snap.currencyCode,
                },
                "SKIPPED",
                { reasonCode: "BEFORE_EPOCH", reviewReason: "Combine predates the shipping activation cutoff." },
              );
            }
            push({ ...base, outcome: "SKIPPED", detail: "before activation cutoff" });
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
                  activationCutoffAt: cutoff,
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
                  activationCutoffAt: cutoff,
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

          const snap = policySnapshot(settings);
          const identity: ShadowIntentIdentity = {
            shop,
            mergeOperationId: op.id,
            sourceOrderId: secondary.id,
            operationCreatedAt: op.createdAt,
            activationCutoffAt: cutoff,
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
            let admin: AdminClient | null = null;
            try {
              admin = await deps.adminFactory(shop);
            } catch (err) {
              push({
                ...base,
                outcome: "ERROR",
                detail: String((err as Error)?.message ?? err),
              });
              continue;
            }
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
          if (claimed === "GATE_CHANGED") {
            push({ ...base, outcome: "GATE_CHANGED" });
            continue;
          }
          if (!claimed) {
            // A concurrent scanner won the insert — its verdict stands.
            push({ ...base, outcome: "PENDING_HELD" });
            continue;
          }
          try {
            await finish(claimed, op, secondary.name, cutoff);
          } catch (err) {
            if (err instanceof OwnershipLostError) {
              push({ ...base, outcome: "LEASE_LOST" });
            } else if (err instanceof GateChangedError) {
              push({ ...base, outcome: "GATE_CHANGED" });
            } else {
              throw err;
            }
          }
        }

        // PENDING rows: re-lease only when expired and due. Outside the
        // new-outcome cap — reclaims never consume the allowance.
        for (const secondary of pendingRows) {
          const base = {
            shop,
            mergeOperationId: op.id,
            sourceOrderId: secondary.id,
            sourceOrderName: secondary.name,
          };
          const row = bySource.get(secondary.id)!;
          if (!opts.apply) {
            push({ ...base, outcome: "PENDING_HELD", detail: "dry run — intent not reclaimed" });
            continue;
          }
          try {
            const reclaimed = await deps.store.reclaimIntent(row.id, crypto.randomUUID(), ttl);
            if (!reclaimed) {
              push({ ...base, outcome: "PENDING_HELD" });
              continue;
            }
            await finish(reclaimed, op, secondary.name, cutoff);
          } catch (err) {
            if (err instanceof OwnershipLostError) {
              push({ ...base, outcome: "LEASE_LOST" });
            } else if (err instanceof GateChangedError) {
              push({ ...base, outcome: "GATE_CHANGED" });
            } else {
              throw err;
            }
          }
        }
      } catch (err) {
        if (err instanceof ShadowDatabaseNotAllowedError) {
          // A guard misconfiguration is global, not per-combine — abort the
          // scan so the operator sees the actionable error.
          throw err;
        }
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
