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

import type { PrismaClient } from "@prisma/client";
import defaultDb from "../db.server";
import { DB_NOW, dbNowPlus, OwnershipLostError } from "./ownership.server";

export type WorkOutcome =
  /** The merge reached COMPLETED / NEEDS_REVIEW. */
  | "MERGED" | "REVIEW"
  /** Order deleted/cancelled/closed (incl. already merged away). */
  | "ANCHOR_GONE"
  /** A rule failed on fresh state (anchor or no compatible partner). */
  | "INELIGIBLE"
  /** No matching sibling after the search-index grace period. */
  | "NO_SIBLINGS"
  /** Merchant has not granted location access on a multi-location shop. */
  | "LOCATION_ACCESS"
  | "AUTOMATION_OFF" | "SHOP_UNINSTALLED" | "EXHAUSTED" | "LEGACY";

export interface WorkItem {
  id: string;
  shop: string;
  orderId: string;
  status: "PENDING" | "DONE";
  attempts: number;
  retryAfter: Date | null;
  leaseToken: string | null;
  leasedUntil: Date | null;
  outcome: string | null;
  lastReason: string | null;
  deadlineAt: Date | null;
  createdAt: Date;
  doneAt: Date | null;
}

export interface WorkStore {
  /** Inserts a PENDING item leased to `token` (attempts = 1, retryAfter = now,
   *  deadlineAt = now + deadlineMs). Returns null on (shop, orderId) conflict.
   *  Other DB errors propagate. */
  insertLeased(shop: string, orderId: string, token: string, ttlMs: number, deadlineMs: number): Promise<WorkItem | null>;
  /** Leases up to `limit` due items (PENDING, retryAfter <= now, lease null or
   *  expired), each with its own fresh token, attempts += 1. Returns the
   *  leased items with their tokens. */
  claimDue(limit: number, ttlMs: number): Promise<WorkItem[]>;
  /** Extends the lease. Conditional on token+unexpired; throws OwnershipLostError. */
  renew(id: string, token: string, ttlMs: number): Promise<void>;
  /** status=DONE, outcome, lastReason, doneAt=now, lease cleared. Conditional
   *  on token+unexpired+status PENDING; returns false if ownership lost. */
  markDone(id: string, token: string, outcome: WorkOutcome, reason: string): Promise<boolean>;
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
          ${crypto.randomUUID()}, ${shop}, ${orderId}, 'PENDING', 1, ${DB_NOW},
          ${token}, ${dbNowPlus(ttlMs)}, ${dbNowPlus(deadlineMs)}, ${DB_NOW}, ${DB_NOW}
        )
        ON CONFLICT ("shop", "orderId") DO NOTHING
        RETURNING *`;
      return rows.length ? toWorkItem(rows[0]) : null;
    },
    async claimDue(limit, ttlMs) {
      // One statement: SKIP LOCKED picks due rows that no live worker holds;
      // each leased row gets its own token, returned to the caller.
      const rows = await db.$queryRaw<any[]>`
        UPDATE "ProcessedWebhook" w
        SET "leaseToken" = md5(random()::text || clock_timestamp()::text || w.id),
            "leasedUntil" = ${dbNowPlus(ttlMs)},
            "attempts" = w."attempts" + 1,
            "updatedAt" = ${DB_NOW}
        FROM (
          SELECT id FROM "ProcessedWebhook"
          WHERE "status" = 'PENDING' AND "retryAfter" <= ${DB_NOW}
            AND ("leasedUntil" IS NULL OR "leasedUntil" < ${DB_NOW})
          ORDER BY "retryAfter"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        ) due
        WHERE w.id = due.id
        RETURNING w.*`;
      return rows.map(toWorkItem);
    },
    async renew(id, token, ttlMs) {
      const updated = await db.$executeRaw`
        UPDATE "ProcessedWebhook" SET "leasedUntil" = ${dbNowPlus(ttlMs)}, "updatedAt" = ${DB_NOW}
        WHERE "id" = ${id} AND "leaseToken" = ${token} AND "leasedUntil" >= ${DB_NOW}`;
      if (updated === 0) throw new OwnershipLostError(`Work item ${id} is owned by another worker.`);
    },
    async markDone(id, token, outcome, reason) {
      const updated = await db.$executeRaw`
        UPDATE "ProcessedWebhook"
        SET "status" = 'DONE', "outcome" = ${outcome}, "lastReason" = ${reason},
            "doneAt" = ${DB_NOW}, "leaseToken" = NULL, "leasedUntil" = NULL,
            "retryAfter" = NULL, "updatedAt" = ${DB_NOW}
        WHERE "id" = ${id} AND "leaseToken" = ${token} AND "leasedUntil" >= ${DB_NOW}
          AND "status" = 'PENDING'`;
      return updated === 1;
    },
    async scheduleRetry(id, token, delayMs, reason) {
      const updated = await db.$executeRaw`
        UPDATE "ProcessedWebhook"
        SET "retryAfter" = ${dbNowPlus(delayMs)}, "lastReason" = ${reason},
            "leaseToken" = NULL, "leasedUntil" = NULL, "updatedAt" = ${DB_NOW}
        WHERE "id" = ${id} AND "leaseToken" = ${token} AND "leasedUntil" >= ${DB_NOW}
          AND "status" = 'PENDING'`;
      return updated === 1;
    },
    async purgeDone(olderThanMs) {
      // COALESCE covers overlap-era DONE rows whose doneAt was never set.
      return db.$executeRaw`
        DELETE FROM "ProcessedWebhook"
        WHERE "status" = 'DONE' AND COALESCE("doneAt", "createdAt") < ${dbNowPlus(-olderThanMs)}`;
    },
    async find(shop, orderId) {
      const row = await db.processedWebhook.findUnique({ where: { shop_orderId: { shop, orderId } } });
      return row && toWorkItem(row);
    },
  };
}
