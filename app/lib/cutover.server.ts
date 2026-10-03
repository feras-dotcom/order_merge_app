// ── Cutover work policy (spec §11, corrections C2) ───────────────────────────
// Reconsiders ProcessedWebhook rows the v1→v2 cutover stranded, and reopens
// DONE rows the order backfill already saw. Everything is fail-safe toward
// re-examining an order — EXCEPT orders a live merge still owns
// (MergeOrderLock) or already absorbed (MergeRecord.mergedOrderId), which are
// never requeued.

import type { PrismaClient } from "@prisma/client";
import { DB_WALL, dbWallPlus } from "./ownership.server";
import { WORK_DEADLINE_MS } from "./order-work.server";

export interface CutoverPlan {
  since: Date;
  /** Max Settings.mergeWindowHours — how far before --since a LEGACY row
   *  could still belong to an in-flight merge window. Informational. */
  maxWindowHours: number;
  /** DONE/LEGACY rows created in [since − maxWindow, since). */
  legacyInWindowBefore: number;
  /** DONE rows since --since with NULL/LEGACY outcome (pre-exclusion). */
  candidates: { shop: string; orderId: string; createdAt: Date }[];
  /** Candidates excluded because a live op holds the order's lock. */
  excludedLocked: { shop: string; orderId: string }[];
  /** Candidates excluded because the order is already a merge secondary. */
  excludedMerged: { shop: string; orderId: string }[];
  /** Rows that would be / were requeued. */
  eligible: { shop: string; orderId: string }[];
  /** Rows actually requeued (0 in dry run). */
  requeued: number;
  /** Pre-existing PENDING backlog rows whose deadlineAt would be / was
   *  extended to now + WORK_DEADLINE_MS — a backlog that waited while
   *  mutations were disabled must not exhaust to REVIEW on re-enable. */
  pendingExtended: number;
}

/** Finds DONE rows since `since` with NULL/LEGACY outcome, minus orders a
 *  live merge locks or already merged; with `apply: true` requeues them
 *  (PENDING, attempts 0, retryAfter now, deadline +6h, lease cleared).
 *  Re-running is a no-op — requeued rows no longer match the predicate. */
export async function requeueCutoverWork(
  db: PrismaClient,
  since: Date,
  opts: { apply: boolean },
): Promise<CutoverPlan> {
  const [settings] = await db.$queryRaw<{ max: number | null }[]>`
    SELECT MAX("mergeWindowHours") AS max FROM "Settings"`;
  const maxWindowHours = settings?.max ?? 24;
  const windowStart = new Date(since.getTime() - maxWindowHours * 60 * 60_000);
  // (?::timestamptz AT TIME ZONE 'UTC') turns a JS Date into the naive UTC
  // wall clock every column here stores — session-timezone proof.
  const sinceTs = since.toISOString();
  const windowTs = windowStart.toISOString();
  const [{ count: legacyBefore }] = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "ProcessedWebhook"
    WHERE "createdAt" >= (${windowTs}::timestamptz AT TIME ZONE 'UTC')
      AND "createdAt" < (${sinceTs}::timestamptz AT TIME ZONE 'UTC')
      AND "status" = 'DONE' AND "outcome" = 'LEGACY'`;

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
  const locked = new Set(lockedRows.map((r) => `${r.shop}${r.orderId}`));
  const merged = new Set(mergedRows.map((r) => `${r.shop}${r.orderId}`));

  const excludedLocked = candidates.filter((c) => locked.has(`${c.shop}${c.orderId}`));
  const excludedMerged = candidates.filter(
    (c) => !locked.has(`${c.shop}${c.orderId}`) && merged.has(`${c.shop}${c.orderId}`),
  );
  const eligible = candidates.filter(
    (c) => !locked.has(`${c.shop}${c.orderId}`) && !merged.has(`${c.shop}${c.orderId}`),
  );

  // Extend before the requeue so pendingExtended counts only the backlog
  // that predates this run — requeued rows get their own fresh deadline.
  const [{ count: pendingNow }] = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "ProcessedWebhook" WHERE "status" = 'PENDING'`;
  let pendingExtended = Number(pendingNow ?? 0);
  if (opts.apply) {
    pendingExtended = await db.$executeRaw`
      UPDATE "ProcessedWebhook"
      SET "deadlineAt" = ${dbWallPlus(WORK_DEADLINE_MS)}, "updatedAt" = ${DB_WALL}
      WHERE "status" = 'PENDING'`;
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
          WHERE r."shop" = p."shop" AND r."mergedOrderId" = p."orderId")`;
  }

  return {
    since,
    maxWindowHours,
    legacyInWindowBefore: Number(legacyBefore ?? 0),
    candidates,
    excludedLocked,
    excludedMerged,
    eligible,
    requeued,
    pendingExtended,
  };
}

/** Upserts one work item: inserts PENDING when absent; reopens the existing
 *  row only when it is DONE with a NULL/LEGACY outcome — v2 outcomes and
 *  REVIEW rows are never touched. Returns the affected row count. */
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
    VALUES (
      ${crypto.randomUUID()}, ${shop}, ${orderId}, 'PENDING', 0, ${DB_WALL},
      NULL, NULL, ${dbWallPlus(WORK_DEADLINE_MS)}, 'CUTOVER_BACKFILL',
      ${DB_WALL}, ${DB_WALL}
    )
    ON CONFLICT ("shop", "orderId") DO UPDATE SET
      "status" = 'PENDING', "attempts" = 0, "retryAfter" = ${DB_WALL},
      "deadlineAt" = ${dbWallPlus(WORK_DEADLINE_MS)}, "lastReason" = 'CUTOVER_BACKFILL',
      "outcome" = NULL, "doneAt" = NULL, "leaseToken" = NULL, "leasedUntil" = NULL,
      "updatedAt" = ${DB_WALL}
    WHERE "ProcessedWebhook"."status" = 'DONE'
      AND ("ProcessedWebhook"."outcome" IS NULL OR "ProcessedWebhook"."outcome" = 'LEGACY')`;
}
