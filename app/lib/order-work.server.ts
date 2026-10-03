// ── Durable order work items ──────────────────────────────────────────────────
// The ProcessedWebhook table is the durable work queue for orders/create
// events: a PENDING row is a lease that survives process restarts, claimed by
// the webhook (insertLeased) or the sweeper (claimDue), and driven by
// processOrderWork (order-work-processor.server.ts) until a terminal outcome.
//
// Ownership follows the shared fencing rules (ownership.server.ts): every
// ownership-sensitive write is conditional on (id, leaseToken, unexpired) and
// the affected-row count decides; a stale worker gets OwnershipLostError or
// false instead of overwriting another worker's state. All clock comparisons
// in raw SQL use the database clock in UTC.

import type { Prisma, PrismaClient } from "@prisma/client";
import defaultDb from "../db.server";
import { DB_WALL, dbWallPlus, OwnershipLostError, withOwnershipTx } from "./ownership.server";

export type WorkOutcome =
  /** The merge reached COMPLETED / NEEDS_REVIEW. */
  | "MERGED" | "REVIEW"
  /** v2: a MergeOperation now owns the item (row is DONE). */
  | "OPERATION_CREATED"
  /** v2: the operation ended in REVIEW_REQUIRED (row is DONE, not REVIEW —
   *  the operation itself carries the review state). */
  | "OPERATION_REVIEW"
  /** Order deleted/cancelled/closed (incl. already merged away). */
  | "ANCHOR_GONE"
  /** A rule failed on fresh state (anchor or no compatible partner). */
  | "INELIGIBLE"
  /** Siblings existed but none were compatible. */
  | "NO_PARTNER"
  /** No matching sibling after the search-index grace period. */
  | "NO_SIBLINGS"
  /** Merchant has not granted location access on a multi-location shop. */
  | "LOCATION_ACCESS"
  | "AUTOMATION_OFF" | "SHOP_UNINSTALLED" | "EXHAUSTED" | "LEGACY";

export interface WorkItem {
  id: string;
  shop: string;
  orderId: string;
  status: "PENDING" | "DONE" | "REVIEW";
  attempts: number;
  retryAfter: Date | null;
  leaseToken: string | null;
  leasedUntil: Date | null;
  outcome: string | null;
  lastReason: string | null;
  deadlineAt: Date | null;
  createdAt: Date;
  doneAt: Date | null;
  reviewReason: string | null;
  operationId: string | null;
}

export interface WorkStore {
  /** Inserts a PENDING item leased to `token` (attempts = 1, retryAfter = now,
   *  deadlineAt = now + deadlineMs). Returns null on (shop, orderId) conflict.
   *  Other DB errors propagate. */
  insertLeased(shop: string, orderId: string, token: string, ttlMs: number, deadlineMs: number): Promise<WorkItem | null>;
  /** Leases up to `limit` due items (PENDING, retryAfter <= now, lease null or
   *  expired), each with its own fresh token, attempts += 1. Returns the
   *  leased items with their tokens. The sweeper claims one at a time. */
  claimDue(limit: number, ttlMs: number): Promise<WorkItem[]>;
  /** Converts expired/unowned PENDING items past their limit to status REVIEW
   *  + outcome EXHAUSTED (v2: the sweeper owns exhaustion; the row's stale
   *  owner then fails every subsequent conditional write). Returns count. */
  exhaustDue(): Promise<number>;
  /** Terminal hand-off to an operation: status DONE, outcome
   *  OPERATION_CREATED, operationId set. Conditional on the work lease
   *  (token + unexpired + status PENDING); returns false if ownership lost.
   *  The same statement runs inside createOperation's transaction. */
  linkOperation(id: string, token: string, operationId: string): Promise<boolean>;
  /** State-CAS (NOT lease-based — the operation owns the item now): an item
   *  the operation abandoned goes back to PENDING, lease cleared, due now.
   *  Only fires on status DONE + outcome OPERATION_CREATED + matching
   *  operationId, so it can never resurrect an item settled another way. */
  requeueFromOperation(workItemId: string, operationId: string, reason: string): Promise<boolean>;
  /** State-CAS counterpart of requeueFromOperation: marks the operation-owned
   *  item DONE with the final outcome (MERGED or OPERATION_REVIEW). */
  settleFromOperation(
    workItemId: string,
    operationId: string,
    outcome: "MERGED" | "OPERATION_REVIEW",
  ): Promise<boolean>;
  /** Extends the lease. Conditional on token+unexpired; throws OwnershipLostError. */
  renew(id: string, token: string, ttlMs: number): Promise<void>;
  /** status=DONE, outcome, lastReason, doneAt=now, lease cleared. Conditional
   *  on token+unexpired+status PENDING; returns false if ownership lost.
   *  `operationId` (optional) records which v2 op owns the outcome — e.g. an
   *  OPERATION_REVIEW row points at the op parked in REVIEW_REQUIRED. */
  markDone(
    id: string,
    token: string,
    outcome: WorkOutcome,
    reason: string,
    operationId?: string,
  ): Promise<boolean>;
  /** retryAfter = now + delayMs, lastReason, lease cleared. Conditional as
   *  above; returns false if ownership lost. */
  scheduleRetry(id: string, token: string, delayMs: number, reason: string): Promise<boolean>;
  /** Deletes DONE rows whose finish time (doneAt, falling back to createdAt
   *  for overlap-era rows that predate the column) is older than olderThanMs. */
  purgeDone(olderThanMs: number): Promise<number>;
  /** Find by (shop, orderId) — tests/observability. */
  find(shop: string, orderId: string): Promise<WorkItem | null>;
}

export const MAX_ATTEMPTS = 20;
export const WORK_DEADLINE_MS = 6 * 60 * 60 * 1000;
/** Grace while Shopify's search index catches up with a brand-new order. */
export const INDEX_LAG_GRACE_MS = 120_000;
export const SWEEP_INTERVAL_MS = 30_000;
export const SWEEP_BATCH = 3;
export const DONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const CONTENTION_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000];
const TRANSIENT_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000];

/** Backoff table for a retried item, ±25% jitter. `attempts` is the attempt
 *  that just ran (item.attempts), so attempt 1 retries after the first entry. */
export function retryDelayMs(
  kind: "contention" | "transient",
  attempts: number,
  random: () => number = Math.random,
): number {
  const table = kind === "contention" ? CONTENTION_DELAYS_MS : TRANSIENT_DELAYS_MS;
  const base = table[Math.min(Math.max(attempts, 1) - 1, table.length - 1)];
  return Math.round(base * (0.75 + random() * 0.5));
}

const toWorkItem = (row: any): WorkItem => row as WorkItem;

/** Row lock taken BEFORE the guarded write: the wait (bounded by
 *  lock_timeout) happens on the SELECT, and the conditional UPDATE then
 *  evaluates its predicates against the row as it stands after the wait —
 *  PG does not re-evaluate a conditional UPDATE whose row was locked but
 *  not changed. */
const lockRow = (tx: Prisma.TransactionClient, id: string) =>
  tx.$queryRaw`SELECT id FROM "ProcessedWebhook" WHERE id = ${id} FOR UPDATE`;

export function prismaWorkStore(db: PrismaClient = defaultDb): WorkStore {
  return {
    async insertLeased(shop, orderId, token, ttlMs, deadlineMs) {
      // DO NOTHING turns the (shop, orderId) duplicate delivery into an empty
      // RETURNING set instead of a P2002.
      const rows = await db.$queryRaw<any[]>`
        INSERT INTO "ProcessedWebhook"
          ("id", "shop", "orderId", "status", "attempts", "retryAfter",
           "leaseToken", "leasedUntil", "deadlineAt", "createdAt", "updatedAt")
        VALUES (
          ${crypto.randomUUID()}, ${shop}, ${orderId}, 'PENDING', 1, ${DB_WALL},
          ${token}, ${dbWallPlus(ttlMs)}, ${dbWallPlus(deadlineMs)}, ${DB_WALL}, ${DB_WALL}
        )
        ON CONFLICT ("shop", "orderId") DO NOTHING
        RETURNING *`;
      return rows.length ? toWorkItem(rows[0]) : null;
    },
    async claimDue(limit = 1, ttlMs) {
      // One statement: SKIP LOCKED picks due rows that no live worker holds;
      // each leased row gets its own token, returned to the caller.
      const rows = await db.$queryRaw<any[]>`
        UPDATE "ProcessedWebhook" w
        SET "leaseToken" = md5(random()::text || clock_timestamp()::text || w.id),
            "leasedUntil" = ${dbWallPlus(ttlMs)},
            "attempts" = w."attempts" + 1,
            "updatedAt" = ${DB_WALL}
        FROM (
          SELECT id FROM "ProcessedWebhook"
          WHERE "status" = 'PENDING' AND "retryAfter" <= ${DB_WALL}
            AND ("leasedUntil" IS NULL OR "leasedUntil" < ${DB_WALL})
          ORDER BY "retryAfter"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        ) due
        WHERE w.id = due.id
        RETURNING w.*`;
      return rows.map(toWorkItem);
    },
    async exhaustDue() {
      // Not lease-gated: it only converts items nobody live-holds, and a stale
      // owner's later writes all fail on status <> 'PENDING' anyway.
      return db.$executeRaw`
        UPDATE "ProcessedWebhook"
        SET "status" = 'REVIEW', "outcome" = 'EXHAUSTED',
            "reviewReason" = COALESCE("lastReason", 'retry limit reached'),
            "leaseToken" = NULL, "leasedUntil" = NULL, "retryAfter" = NULL,
            "updatedAt" = ${DB_WALL}
        WHERE "status" = 'PENDING'
          AND ("leasedUntil" IS NULL OR "leasedUntil" < ${DB_WALL})
          AND ("attempts" >= ${MAX_ATTEMPTS}
            OR ("deadlineAt" IS NOT NULL AND "deadlineAt" < ${DB_WALL}))`;
    },
    async linkOperation(id, token, operationId) {
      return withOwnershipTx(db, async (tx) => {
        await lockRow(tx, id);
        const updated = await tx.$executeRaw`
          UPDATE "ProcessedWebhook"
          SET "status" = 'DONE', "outcome" = 'OPERATION_CREATED',
              "operationId" = ${operationId}, "doneAt" = ${DB_WALL},
              "leaseToken" = NULL, "leasedUntil" = NULL, "retryAfter" = NULL,
              "updatedAt" = ${DB_WALL}
          WHERE "id" = ${id} AND "leaseToken" = ${token}
            AND "leasedUntil" > ${DB_WALL} AND "status" = 'PENDING'`;
        return updated === 1;
      });
    },
    async requeueFromOperation(workItemId, operationId, reason) {
      const updated = await db.$executeRaw`
        UPDATE "ProcessedWebhook"
        SET "status" = 'PENDING', "retryAfter" = ${DB_WALL}, "outcome" = NULL,
            "lastReason" = ${reason}, "leaseToken" = NULL, "leasedUntil" = NULL,
            "updatedAt" = ${DB_WALL}
        WHERE "id" = ${workItemId} AND "status" = 'DONE'
          AND "outcome" = 'OPERATION_CREATED' AND "operationId" = ${operationId}`;
      return updated === 1;
    },
    async settleFromOperation(workItemId, operationId, outcome) {
      const updated = await db.$executeRaw`
        UPDATE "ProcessedWebhook"
        SET "status" = 'DONE', "outcome" = ${outcome}, "doneAt" = ${DB_WALL},
            "updatedAt" = ${DB_WALL}
        WHERE "id" = ${workItemId} AND "status" = 'DONE'
          AND "outcome" = 'OPERATION_CREATED' AND "operationId" = ${operationId}`;
      return updated === 1;
    },
    async renew(id, token, ttlMs) {
      await withOwnershipTx(db, async (tx) => {
        await lockRow(tx, id);
        const updated = await tx.$executeRaw`
          UPDATE "ProcessedWebhook" SET "leasedUntil" = ${dbWallPlus(ttlMs)}, "updatedAt" = ${DB_WALL}
          WHERE "id" = ${id} AND "leaseToken" = ${token} AND "leasedUntil" >= ${DB_WALL}`;
        if (updated === 0) throw new OwnershipLostError(`Work item ${id} is owned by another worker.`);
      });
    },
    async markDone(id, token, outcome, reason, operationId) {
      return withOwnershipTx(db, async (tx) => {
        await lockRow(tx, id);
        const updated = await tx.$executeRaw`
          UPDATE "ProcessedWebhook"
          SET "status" = 'DONE', "outcome" = ${outcome}, "lastReason" = ${reason},
              "operationId" = COALESCE(${operationId ?? null}, "operationId"),
              "doneAt" = ${DB_WALL}, "leaseToken" = NULL, "leasedUntil" = NULL,
              "retryAfter" = NULL, "updatedAt" = ${DB_WALL}
          WHERE "id" = ${id} AND "leaseToken" = ${token} AND "leasedUntil" >= ${DB_WALL}
            AND "status" = 'PENDING'`;
        return updated === 1;
      });
    },
    async scheduleRetry(id, token, delayMs, reason) {
      return withOwnershipTx(db, async (tx) => {
        await lockRow(tx, id);
        const updated = await tx.$executeRaw`
          UPDATE "ProcessedWebhook"
          SET "retryAfter" = ${dbWallPlus(delayMs)}, "lastReason" = ${reason},
              "leaseToken" = NULL, "leasedUntil" = NULL, "updatedAt" = ${DB_WALL}
          WHERE "id" = ${id} AND "leaseToken" = ${token} AND "leasedUntil" >= ${DB_WALL}
            AND "status" = 'PENDING'`;
        return updated === 1;
      });
    },
    async purgeDone(olderThanMs) {
      // COALESCE covers overlap-era DONE rows whose doneAt was never set.
      return db.$executeRaw`
        DELETE FROM "ProcessedWebhook"
        WHERE "status" = 'DONE' AND COALESCE("doneAt", "createdAt") < ${dbWallPlus(-olderThanMs)}`;
    },
    async find(shop, orderId) {
      const row = await db.processedWebhook.findUnique({ where: { shop_orderId: { shop, orderId } } });
      return row && toWorkItem(row);
    },
  };
}
