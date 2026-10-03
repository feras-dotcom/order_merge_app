// ── Cutover work policy (spec §11, corrections C2 + N7) ──────────────────────
// Reconsiders ProcessedWebhook rows the v1→v2 cutover stranded, and reopens
// DONE rows the order backfill already saw. Everything is fail-safe toward
// re-examining an order — EXCEPT orders a live merge still owns
// (MergeOrderLock) or already absorbed (MergeRecord.mergedOrderId), which are
// never requeued. The lookback window is derived from the operator's cutover
// timestamp and the widest configured merge window; an explicit --since that
// would silently exclude provable work refuses to run.

import { Prisma, type PrismaClient } from "@prisma/client";
import { gql, nextPageCursor, type AdminClient } from "./graphql.server";
import { LEGACY_RECONCILE_STATUSES } from "./legacy-reconcile.server";
import { DB_WALL, dbWallPlus } from "./ownership.server";
import { WORK_DEADLINE_MS } from "./order-work.server";

/** Refuses a cutover window that could silently strand provable v1-era work,
 *  and reports un-dispositioned pre-cutover rows when no disposition was
 *  given. The CLI prints it and exits 2. */
export class CutoverWindowError extends Error {
  name = "CutoverWindowError";
}

/** Cutover tooling must run with both mutation switches off — a switch left
 *  on means the v2 engine is live and tooling writes would race it. A missing
 *  control row is all-off and allowed. */
export class ControlsNotFrozenError extends Error {
  name = "ControlsNotFrozenError";
}

export type OlderLegacyDisposition = "requeue" | "review" | "exclude";

export interface CutoverOptions {
  /** When the v1 engine stopped (operator-supplied). */
  cutoverAt: Date;
  /** Explicit lower bound; must be <= cutoverAt − maxWindow, else
   *  CutoverWindowError. Default: the derived bound. */
  since?: Date;
  /** What to do with DONE/LEGACY rows older than `since` — required when any
   *  un-dispositioned ones exist. */
  olderLegacy?: OlderLegacyDisposition;
  apply: boolean;
}

export interface CutoverPlan {
  cutoverAt: Date;
  /** cutoverAt − maxWindowHours: the earliest moment a LEGACY row could still
   *  belong to an in-flight merge window. */
  safeSince: Date;
  since: Date;
  /** Max Settings.mergeWindowHours (24 when no Settings rows exist). */
  maxWindowHours: number;
  /** DONE/LEGACY rows created before `since`, still un-dispositioned, and
   *  what was done with them (affected counts only the rows the disposition
   *  actually reached — lock/MergeRecord exclusions still apply). */
  olderLegacy: {
    count: number;
    disposition: OlderLegacyDisposition | null;
    eligible: number;
    affected: number;
  };
  /** DONE rows since `since` with NULL/LEGACY outcome (pre-exclusion). */
  candidates: { shop: string; orderId: string; createdAt: Date }[];
  /** Candidates excluded because a live op holds the order's lock. */
  excludedLocked: { shop: string; orderId: string }[];
  /** Candidates excluded because the order is already a merge secondary. */
  excludedMerged: { shop: string; orderId: string }[];
  /** Candidates excluded because the order is involved in an unreconciled
   *  v1 operation — it must convert or quarantine before work can requeue. */
  excludedLegacy: { shop: string; orderId: string }[];
  /** Rows that would be / were requeued. */
  eligible: { shop: string; orderId: string }[];
  /** Rows actually requeued (0 in dry run). */
  requeued: number;
  /** PENDING rows within an hour of their deadline whose deadlineAt would be
   *  / was pushed to now + WORK_DEADLINE_MS — a backlog that waited while
   *  mutations were disabled must not exhaust to REVIEW on re-enable. */
  pendingExtended: number;
}

/** The unreconciled-v1 predicate: TRUE when the order takes part in a v1
 *  operation still awaiting reconciliation (PENDING_COMMIT / COMMITTED /
 *  NEEDS_REVIEW / ABANDONED — a v1 abandonment is not proof its commit never
 *  applied). Such orders are never requeued or backfilled; the arguments are
 *  SQL fragments — correlated column references for the bulk statements,
 *  bound literals for a single order. Converted v2 rows no longer match:
 *  native lock/terminal semantics apply instead. */
export const unreconciledV1 = (shop: Prisma.Sql, orderId: Prisma.Sql) => Prisma.sql`
  EXISTS (
    SELECT 1 FROM "MergeOperation" o
    WHERE o."protocolVersion" = 1
      AND o."status" = ANY(${LEGACY_RECONCILE_STATUSES})
      AND o."shop" = ${shop}
      AND o."involvedOrderIds" && ARRAY[${orderId}]::text[]
  )`;

const P_SHOP = Prisma.sql`p."shop"`;
const P_ORDER = Prisma.sql`p."orderId"`;

/** Throws ControlsNotFrozenError unless both mutation switches are off. */
export async function requireControlsOff(db: PrismaClient): Promise<void> {
  const [control] = await db.$queryRaw<
    { newMergesEnabled: boolean; completionEnabled: boolean }[]
  >`SELECT "newMergesEnabled", "completionEnabled" FROM "AppControl" WHERE id = 'control'`;
  if (control && (control.newMergesEnabled || control.completionEnabled)) {
    throw new ControlsNotFrozenError(
      "mutation switches are not frozen — turn both off with scripts/app-control.ts first",
    );
  }
}

/** Finds DONE rows since the cutover window with NULL/LEGACY outcome, minus
 *  orders a live merge locks or already merged; with `apply: true` requeues
 *  them (PENDING, attempts 0, retryAfter now, deadline +6h, lease cleared).
 *  Older LEGACY rows need an explicit --older-legacy disposition. Re-running
 *  is a no-op — handled rows no longer match. */
export async function requeueCutoverWork(
  db: PrismaClient,
  opts: CutoverOptions,
): Promise<CutoverPlan> {
  if (opts.apply) await requireControlsOff(db);

  const [settings] = await db.$queryRaw<{ max: number | null }[]>`
    SELECT MAX("mergeWindowHours") AS max FROM "Settings"`;
  const maxWindowHours = settings?.max ?? 24;
  const safeSince = new Date(opts.cutoverAt.getTime() - maxWindowHours * 60 * 60_000);
  const since = opts.since ?? safeSince;
  if (since.getTime() > safeSince.getTime()) {
    throw new CutoverWindowError(
      `--since ${since.toISOString()} is inside the merge window — the earliest safe bound is ` +
        `cutoverAt − ${maxWindowHours}h = ${safeSince.toISOString()}; older LEGACY rows need --older-legacy`,
    );
  }
  // (?::timestamptz AT TIME ZONE 'UTC') turns a JS Date into the naive UTC
  // wall clock every column here stores — session-timezone proof.
  const sinceTs = since.toISOString();

  // Pre-cutover rows the since-bound does not cover: they are provably
  // stranded (v1 wrote them before the window could still be in flight), so
  // the operator must say what happens to them. Stamped rows are already
  // handled — a rerun does not re-ask.
  const [{ count: olderCount }] = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "ProcessedWebhook"
    WHERE "status" = 'DONE' AND "outcome" = 'LEGACY'
      AND "createdAt" < (${sinceTs}::timestamptz AT TIME ZONE 'UTC')
      AND "lastReason" IS DISTINCT FROM 'CUTOVER_EXCLUDED_BY_OPERATOR'`;
  const older = Number(olderCount ?? 0);
  if (older > 0 && !opts.olderLegacy) {
    throw new CutoverWindowError(
      `${older} unproven pre-cutover row(s) are older than ${since.toISOString()} — ` +
        `pass --older-legacy requeue|review|exclude`,
    );
  }
  const [{ count: olderEligibleCount }] = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "ProcessedWebhook" p
    WHERE p."status" = 'DONE' AND p."outcome" = 'LEGACY'
      AND p."createdAt" < (${sinceTs}::timestamptz AT TIME ZONE 'UTC')
      AND p."lastReason" IS DISTINCT FROM 'CUTOVER_EXCLUDED_BY_OPERATOR'
      AND NOT EXISTS (
        SELECT 1 FROM "MergeOrderLock" l
        WHERE l."shop" = p."shop" AND l."orderId" = p."orderId")
      AND NOT EXISTS (
        SELECT 1 FROM "MergeRecord" r
        WHERE r."shop" = p."shop" AND r."mergedOrderId" = p."orderId")
      AND NOT ${unreconciledV1(P_SHOP, P_ORDER)}`;
  const olderEligible = Number(olderEligibleCount ?? 0);

  let olderAffected = 0;
  if (opts.apply && opts.olderLegacy === "requeue") {
    olderAffected = await db.$executeRaw`
      UPDATE "ProcessedWebhook" p
      SET "status" = 'PENDING', "attempts" = 0, "retryAfter" = ${DB_WALL},
          "deadlineAt" = ${dbWallPlus(WORK_DEADLINE_MS)}, "lastReason" = 'CUTOVER_REQUEUE',
          "outcome" = NULL, "doneAt" = NULL, "leaseToken" = NULL, "leasedUntil" = NULL,
          "updatedAt" = ${DB_WALL}
      WHERE p."status" = 'DONE' AND p."outcome" = 'LEGACY'
        AND p."createdAt" < (${sinceTs}::timestamptz AT TIME ZONE 'UTC')
        AND p."lastReason" IS DISTINCT FROM 'CUTOVER_EXCLUDED_BY_OPERATOR'
        AND NOT EXISTS (
          SELECT 1 FROM "MergeOrderLock" l
          WHERE l."shop" = p."shop" AND l."orderId" = p."orderId")
        AND NOT EXISTS (
          SELECT 1 FROM "MergeRecord" r
          WHERE r."shop" = p."shop" AND r."mergedOrderId" = p."orderId")
        AND NOT ${unreconciledV1(P_SHOP, P_ORDER)}`;
  // review/exclude may still stamp a row whose order an unreconciled v1 op
  // involves — neither puts work back in the queue (harmless).
  } else if (opts.apply && opts.olderLegacy === "review") {
    olderAffected = await db.$executeRaw`
      UPDATE "ProcessedWebhook" p
      SET "status" = 'REVIEW',
          "reviewReason" = 'Unproven pre-cutover work (LEGACY) routed to review by the operator',
          "lastReason" = 'CUTOVER_REVIEW', "updatedAt" = ${DB_WALL}
      WHERE p."status" = 'DONE' AND p."outcome" = 'LEGACY'
        AND p."createdAt" < (${sinceTs}::timestamptz AT TIME ZONE 'UTC')
        AND p."lastReason" IS DISTINCT FROM 'CUTOVER_EXCLUDED_BY_OPERATOR'
        AND NOT EXISTS (
          SELECT 1 FROM "MergeOrderLock" l
          WHERE l."shop" = p."shop" AND l."orderId" = p."orderId")
        AND NOT EXISTS (
          SELECT 1 FROM "MergeRecord" r
          WHERE r."shop" = p."shop" AND r."mergedOrderId" = p."orderId")`;
  } else if (opts.apply && opts.olderLegacy === "exclude") {
    olderAffected = await db.$executeRaw`
      UPDATE "ProcessedWebhook" p
      SET "lastReason" = 'CUTOVER_EXCLUDED_BY_OPERATOR', "updatedAt" = ${DB_WALL}
      WHERE p."status" = 'DONE' AND p."outcome" = 'LEGACY'
        AND p."createdAt" < (${sinceTs}::timestamptz AT TIME ZONE 'UTC')
        AND p."lastReason" IS DISTINCT FROM 'CUTOVER_EXCLUDED_BY_OPERATOR'
        AND NOT EXISTS (
          SELECT 1 FROM "MergeOrderLock" l
          WHERE l."shop" = p."shop" AND l."orderId" = p."orderId")
        AND NOT EXISTS (
          SELECT 1 FROM "MergeRecord" r
          WHERE r."shop" = p."shop" AND r."mergedOrderId" = p."orderId")`;
  }

  const candidates = await db.$queryRaw<
    { id: string; shop: string; orderId: string; createdAt: Date }[]
  >`
    SELECT p."id", p."shop", p."orderId", p."createdAt" FROM "ProcessedWebhook" p
    WHERE p."createdAt" >= (${sinceTs}::timestamptz AT TIME ZONE 'UTC')
      AND p."status" = 'DONE'
      AND (p."outcome" IS NULL OR p."outcome" = 'LEGACY')
    ORDER BY p."createdAt"`;

  const lockedRows = await db.$queryRaw<{ shop: string; orderId: string }[]>`
    SELECT DISTINCT "shop", "orderId" FROM "MergeOrderLock"`;
  const mergedRows = await db.$queryRaw<{ shop: string; orderId: string }[]>`
    SELECT "shop", "mergedOrderId" AS "orderId" FROM "MergeRecord"`;
  const legacyRows = await db.$queryRaw<{ shop: string; orderId: string }[]>`
    SELECT o."shop", unnest(o."involvedOrderIds") AS "orderId"
    FROM "MergeOperation" o
    WHERE o."protocolVersion" = 1 AND o."status" = ANY(${LEGACY_RECONCILE_STATUSES})`;
  const locked = new Set(lockedRows.map((r) => `${r.shop}${r.orderId}`));
  const merged = new Set(mergedRows.map((r) => `${r.shop}${r.orderId}`));
  const legacy = new Set(legacyRows.map((r) => `${r.shop}${r.orderId}`));

  const excludedLegacy = candidates.filter((c) => legacy.has(`${c.shop}${c.orderId}`));
  const excludedLocked = candidates.filter(
    (c) => !legacy.has(`${c.shop}${c.orderId}`) && locked.has(`${c.shop}${c.orderId}`),
  );
  const excludedMerged = candidates.filter(
    (c) =>
      !legacy.has(`${c.shop}${c.orderId}`) &&
      !locked.has(`${c.shop}${c.orderId}`) &&
      merged.has(`${c.shop}${c.orderId}`),
  );
  const eligible = candidates.filter(
    (c) =>
      !legacy.has(`${c.shop}${c.orderId}`) &&
      !locked.has(`${c.shop}${c.orderId}`) &&
      !merged.has(`${c.shop}${c.orderId}`),
  );

  // Extend before the requeue so pendingExtended counts only the backlog
  // that predates this run — requeued rows get their own fresh deadline.
  // Only rows inside an hour of their deadline are touched; a fresh backlog
  // keeps its own clock.
  const [{ count: pendingSoon }] = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "ProcessedWebhook"
    WHERE "status" = 'PENDING' AND "deadlineAt" < ${DB_WALL} + interval '1 hour'`;
  let pendingExtended = Number(pendingSoon ?? 0);
  if (opts.apply) {
    pendingExtended = await db.$executeRaw`
      UPDATE "ProcessedWebhook"
      SET "deadlineAt" = ${dbWallPlus(WORK_DEADLINE_MS)}, "updatedAt" = ${DB_WALL}
      WHERE "status" = 'PENDING' AND "deadlineAt" < ${DB_WALL} + interval '1 hour'`;
  }

  let requeued = 0;
  if (opts.apply && eligible.length) {
    requeued = await db.$executeRaw`
      UPDATE "ProcessedWebhook" p
      SET "status" = 'PENDING', "attempts" = 0, "retryAfter" = ${DB_WALL},
          "deadlineAt" = ${dbWallPlus(WORK_DEADLINE_MS)}, "lastReason" = 'CUTOVER_REQUEUE',
          "outcome" = NULL, "doneAt" = NULL, "leaseToken" = NULL, "leasedUntil" = NULL,
          "updatedAt" = ${DB_WALL}
      WHERE p."createdAt" >= (${sinceTs}::timestamptz AT TIME ZONE 'UTC')
        AND p."status" = 'DONE'
        AND (p."outcome" IS NULL OR p."outcome" = 'LEGACY')
        AND NOT EXISTS (
          SELECT 1 FROM "MergeOrderLock" l
          WHERE l."shop" = p."shop" AND l."orderId" = p."orderId")
        AND NOT EXISTS (
          SELECT 1 FROM "MergeRecord" r
          WHERE r."shop" = p."shop" AND r."mergedOrderId" = p."orderId")
        AND NOT ${unreconciledV1(P_SHOP, P_ORDER)}`;
  }

  return {
    cutoverAt: opts.cutoverAt,
    safeSince,
    since,
    maxWindowHours,
    olderLegacy: {
      count: older,
      disposition: opts.olderLegacy ?? null,
      eligible: olderEligible,
      affected: olderAffected,
    },
    candidates,
    excludedLocked,
    excludedMerged,
    excludedLegacy,
    eligible,
    requeued,
    pendingExtended,
  };
}

/** Upserts one work item: inserts PENDING when absent; reopens the existing
 *  row only when it is DONE with a NULL/LEGACY outcome — v2 outcomes and
 *  REVIEW rows are never touched. An order a live merge locks, a MergeRecord
 *  already absorbed, or an unreconciled v1 operation still involves is never
 *  inserted or reopened. Returns the affected row count. */
export async function backfillWorkItem(
  db: PrismaClient,
  shop: string,
  orderId: string,
): Promise<number> {
  return db.$executeRaw`
    INSERT INTO "ProcessedWebhook"
      ("id", "shop", "orderId", "status", "attempts", "retryAfter",
       "leaseToken", "leasedUntil", "deadlineAt", "lastReason",
       "createdAt", "updatedAt")
    SELECT
      ${crypto.randomUUID()}, ${shop}, ${orderId}, 'PENDING', 0, ${DB_WALL},
      NULL, NULL, ${dbWallPlus(WORK_DEADLINE_MS)}, 'CUTOVER_BACKFILL',
      ${DB_WALL}, ${DB_WALL}
    WHERE NOT EXISTS (
      SELECT 1 FROM "MergeOrderLock" l
      WHERE l."shop" = ${shop} AND l."orderId" = ${orderId})
    AND NOT EXISTS (
      SELECT 1 FROM "MergeRecord" r
      WHERE r."shop" = ${shop} AND r."mergedOrderId" = ${orderId})
    AND NOT ${unreconciledV1(Prisma.sql`${shop}`, Prisma.sql`${orderId}`)}
    ON CONFLICT ("shop", "orderId") DO UPDATE SET
      "status" = 'PENDING', "attempts" = 0, "retryAfter" = ${DB_WALL},
      "deadlineAt" = ${dbWallPlus(WORK_DEADLINE_MS)}, "lastReason" = 'CUTOVER_BACKFILL',
      "outcome" = NULL, "doneAt" = NULL, "leaseToken" = NULL, "leasedUntil" = NULL,
      "updatedAt" = ${DB_WALL}
    WHERE "ProcessedWebhook"."status" = 'DONE'
      AND ("ProcessedWebhook"."outcome" IS NULL OR "ProcessedWebhook"."outcome" = 'LEGACY')
      AND NOT EXISTS (
        SELECT 1 FROM "MergeOrderLock" l
        WHERE l."shop" = ${shop} AND l."orderId" = ${orderId})
      AND NOT EXISTS (
        SELECT 1 FROM "MergeRecord" r
        WHERE r."shop" = ${shop} AND r."mergedOrderId" = ${orderId})
      AND NOT ${unreconciledV1(Prisma.sql`${shop}`, Prisma.sql`${orderId}`)}`;
}

const BACKFILL_ORDERS_QUERY = `#graphql
  query BackfillOrders($query: String!, $after: String) {
    orders(first: 250, query: $query, after: $after) {
      nodes { id }
      pageInfo { hasNextPage endCursor }
    }
  }`;

/** Lists recent open/paid/unfulfilled order ids for the backfill script.
 *  Fail-closed like every Shopify read: a GraphQL error, a missing orders
 *  payload or a page that cannot prove its own completeness throws — the
 *  caller must never mistake a broken read for an empty result. */
export async function listBackfillOrderIds(
  admin: AdminClient,
  since: string,
): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  do {
    const orders: any = await gql(
      admin,
      "Backfill orders",
      BACKFILL_ORDERS_QUERY,
      {
        query: `created_at:>=${since} status:open financial_status:paid fulfillment_status:unfulfilled`,
        after,
      },
      "orders",
      null,
    );
    after = nextPageCursor(orders, seen, "Backfill orders");
    for (const n of orders.nodes) if (n?.id) ids.push(n.id);
  } while (after);
  return ids;
}
