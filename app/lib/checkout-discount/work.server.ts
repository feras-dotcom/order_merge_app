// ── Durable checkout-eligibility work items ───────────────────────────────────
// CheckoutEligibilityWork is the level-triggered work queue for the
// orders/paid, orders/cancelled, orders/fulfilled and
// orders/partially_fulfilled webhooks (D1): a delivery only marks the order
// "dirty" (gen = gen + 1, status PENDING); the processor reconciles the order's
// desired projection state from fresh Admin data, so duplicates, reordering,
// delayed payment and restarts all converge.
//
// Ownership follows the shared fencing rules (ownership.server.ts): every
// ownership-sensitive write is conditional on (id, leaseToken, unexpired) and
// the affected-row count decides; a stale worker gets OwnershipLostError,
// false or LOST instead of overwriting another worker's state. Completion is
// conditional on `gen` still equal to the generation processed — a newer event
// that arrived mid-processing re-queues instead of being lost. All clock
// comparisons in raw SQL use the database clock in UTC.

import type { Prisma, PrismaClient } from "@prisma/client";
import defaultDb from "../../db.server";
import {
  DB_WALL,
  dbWallPlus,
  OwnershipLostError,
  withOwnershipTx,
} from "../ownership.server";
import { retryDelayMs } from "../order-work.server";

export { retryDelayMs };

export type CheckoutWorkOutcome =
  | "PROJECTED"
  | "REFUSED"
  | "REVOKED"
  | "CONSUMED"
  | "CONSUMED_NO_RECORD"
  | "ORDER_GONE"
  | "CUSTOMER_GONE"
  | "FEATURE_OFF"
  | "SHOP_UNINSTALLED"
  | "EXHAUSTED";

export interface CheckoutWorkItem {
  id: string;
  shop: string;
  orderId: string;
  /** Generation of the "dirty" mark. A complete() against an older gen is
   *  REQUEUED — a newer event arrived mid-processing and is never lost. */
  gen: number;
  status: "PENDING" | "DONE" | "REVIEW";
  attempts: number;
  retryAfter: Date | null;
  leaseToken: string | null;
  leasedUntil: Date | null;
  outcome: string | null;
  lastReason: string | null;
  deadlineAt: Date | null;
  doneAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const CHECKOUT_MAX_ATTEMPTS = 20;
export const CHECKOUT_DEADLINE_MS = 6 * 60 * 60 * 1000;
export const CHECKOUT_DONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface CheckoutWorkStore {
  /** Marks (shop, orderId) dirty and bumps gen. A new row is created PENDING
   *  leased to `token` (attempts 1, deadline now + deadlineMs). An existing
   *  row — including DONE or REVIEW — is reopened the same way: PENDING,
   *  due now, outcome cleared; a LIVE lease (PENDING, unexpired) is kept
   *  untouched and reported as not acquired, otherwise `token` takes it and
   *  attempts reset to 1. */
  upsertDirty(
    shop: string,
    orderId: string,
    token: string,
    ttlMs: number,
    deadlineMs: number,
  ): Promise<{ item: CheckoutWorkItem; acquired: boolean }>;
  /** Leases up to `limit` due items (PENDING, retryAfter <= now, lease null
   *  or expired), each with its own fresh token, attempts += 1. */
  claimDue(limit: number, ttlMs: number): Promise<CheckoutWorkItem[]>;
  /** Converts expired/unowned PENDING items past their limit to REVIEW +
   *  outcome EXHAUSTED. Returns the count. */
  exhaustDue(): Promise<number>;
  /** Extends the lease. Conditional on token+unexpired; throws
   *  OwnershipLostError. */
  renew(id: string, token: string, ttlMs: number): Promise<void>;
  /** retryAfter = now + delayMs, lastReason, lease cleared. Conditional on
   *  token+unexpired+PENDING; false = ownership lost. */
  scheduleRetry(id: string, token: string, delayMs: number, reason: string): Promise<boolean>;
  /** Terminal settle, generation-fenced. LOST: the lease is gone (taken over
   *  or exhausted). DONE: gen still matches seenGen — row DONE, outcome,
   *  doneAt, lease cleared. REQUEUED: a newer dirty mark arrived mid-
   *  processing — the lease is released and the item is due immediately so
   *  the newer generation is reconciled, never lost. */
  complete(
    id: string,
    token: string,
    seenGen: number,
    outcome: CheckoutWorkOutcome | string,
    reason: string,
  ): Promise<"DONE" | "REQUEUED" | "LOST">;
  /** Deletes DONE rows older than olderThanMs. */
  purgeDone(olderThanMs: number): Promise<number>;
  /** Find by (shop, orderId) — tests/observability. */
  find(shop: string, orderId: string): Promise<CheckoutWorkItem | null>;
}

const toItem = (row: any): CheckoutWorkItem => row as CheckoutWorkItem;

/** Row lock taken BEFORE the guarded write: the wait (bounded by
 *  lock_timeout) happens on the SELECT, and the conditional UPDATE then
 *  evaluates its predicates against the row as it stands after the wait —
 *  PG does not re-evaluate a conditional UPDATE whose row was locked but
 *  not changed. */
const lockRow = (tx: Prisma.TransactionClient, id: string) =>
  tx.$queryRaw`SELECT id FROM "CheckoutEligibilityWork" WHERE id = ${id} FOR UPDATE`;

export function prismaCheckoutWorkStore(db: PrismaClient = defaultDb): CheckoutWorkStore {
  return {
    async upsertDirty(shop, orderId, token, ttlMs, deadlineMs) {
      // One statement per delivery. "leaseToken = token" in RETURNING is the
      // acquired flag: we own the row iff the statement left OUR token on it.
      const rows = await db.$queryRaw<any[]>`
        INSERT INTO "CheckoutEligibilityWork"
          ("id", "shop", "orderId", "gen", "status", "attempts", "retryAfter",
           "leaseToken", "leasedUntil", "deadlineAt", "createdAt", "updatedAt")
        VALUES (
          ${crypto.randomUUID()}, ${shop}, ${orderId}, 1, 'PENDING', 1, ${DB_WALL},
          ${token}, ${dbWallPlus(ttlMs)}, ${dbWallPlus(deadlineMs)}, ${DB_WALL}, ${DB_WALL}
        )
        ON CONFLICT ("shop", "orderId") DO UPDATE SET
          "gen" = "CheckoutEligibilityWork"."gen" + 1,
          "status" = 'PENDING',
          "retryAfter" = ${DB_WALL},
          "deadlineAt" = ${dbWallPlus(deadlineMs)},
          "outcome" = NULL, "lastReason" = NULL, "doneAt" = NULL,
          "leaseToken" = CASE
            WHEN "CheckoutEligibilityWork"."status" = 'PENDING'
             AND "CheckoutEligibilityWork"."leasedUntil" > ${DB_WALL}
            THEN "CheckoutEligibilityWork"."leaseToken" ELSE ${token} END,
          "leasedUntil" = CASE
            WHEN "CheckoutEligibilityWork"."status" = 'PENDING'
             AND "CheckoutEligibilityWork"."leasedUntil" > ${DB_WALL}
            THEN "CheckoutEligibilityWork"."leasedUntil" ELSE ${dbWallPlus(ttlMs)} END,
          "attempts" = CASE
            WHEN "CheckoutEligibilityWork"."status" = 'PENDING'
             AND "CheckoutEligibilityWork"."leasedUntil" > ${DB_WALL}
            THEN "CheckoutEligibilityWork"."attempts" ELSE 1 END,
          "updatedAt" = ${DB_WALL}
        RETURNING *, ("leaseToken" = ${token}) AS "acquired"`;
      const row = rows[0];
      return { item: toItem(row), acquired: row.acquired === true };
    },
    async claimDue(limit = 1, ttlMs) {
      // One statement: SKIP LOCKED picks due rows that no live worker holds;
      // each leased row gets its own token, returned to the caller.
      const rows = await db.$queryRaw<any[]>`
        UPDATE "CheckoutEligibilityWork" w
        SET "leaseToken" = md5(random()::text || clock_timestamp()::text || w.id),
            "leasedUntil" = ${dbWallPlus(ttlMs)},
            "attempts" = w."attempts" + 1,
            "updatedAt" = ${DB_WALL}
        FROM (
          SELECT id FROM "CheckoutEligibilityWork"
          WHERE "status" = 'PENDING' AND "retryAfter" <= ${DB_WALL}
            AND ("leasedUntil" IS NULL OR "leasedUntil" < ${DB_WALL})
          ORDER BY "retryAfter"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        ) due
        WHERE w.id = due.id
        RETURNING w.*`;
      return rows.map(toItem);
    },
    async exhaustDue() {
      // Not lease-gated: it only converts items nobody live-holds, and a stale
      // owner's later writes all fail on status <> 'PENDING' anyway.
      return db.$executeRaw`
        UPDATE "CheckoutEligibilityWork"
        SET "status" = 'REVIEW', "outcome" = 'EXHAUSTED',
            "lastReason" = COALESCE("lastReason", 'retry limit reached'),
            "leaseToken" = NULL, "leasedUntil" = NULL, "retryAfter" = NULL,
            "updatedAt" = ${DB_WALL}
        WHERE "status" = 'PENDING'
          AND ("leasedUntil" IS NULL OR "leasedUntil" < ${DB_WALL})
          AND ("attempts" >= ${CHECKOUT_MAX_ATTEMPTS}
            OR ("deadlineAt" IS NOT NULL AND "deadlineAt" < ${DB_WALL}))`;
    },
    async renew(id, token, ttlMs) {
      await withOwnershipTx(db, async (tx) => {
        await lockRow(tx, id);
        const updated = await tx.$executeRaw`
          UPDATE "CheckoutEligibilityWork" SET "leasedUntil" = ${dbWallPlus(ttlMs)}, "updatedAt" = ${DB_WALL}
          WHERE "id" = ${id} AND "leaseToken" = ${token} AND "leasedUntil" >= ${DB_WALL}`;
        if (updated === 0)
          throw new OwnershipLostError(`Checkout work ${id} is owned by another worker.`);
      });
    },
    async scheduleRetry(id, token, delayMs, reason) {
      return withOwnershipTx(db, async (tx) => {
        await lockRow(tx, id);
        const updated = await tx.$executeRaw`
          UPDATE "CheckoutEligibilityWork"
          SET "retryAfter" = ${dbWallPlus(delayMs)}, "lastReason" = ${reason},
              "leaseToken" = NULL, "leasedUntil" = NULL, "updatedAt" = ${DB_WALL}
          WHERE "id" = ${id} AND "leaseToken" = ${token} AND "leasedUntil" >= ${DB_WALL}
            AND "status" = 'PENDING'`;
        return updated === 1;
      });
    },
    async complete(id, token, seenGen, outcome, reason) {
      return withOwnershipTx(db, async (tx) => {
        await lockRow(tx, id);
        const rows = await tx.$queryRaw<{ gen: number }[]>`
          SELECT "gen" FROM "CheckoutEligibilityWork"
          WHERE "id" = ${id} AND "leaseToken" = ${token}
            AND "leasedUntil" >= ${DB_WALL} AND "status" = 'PENDING'`;
        if (rows.length === 0) return "LOST";
        if (rows[0].gen === seenGen) {
          const updated = await tx.$executeRaw`
            UPDATE "CheckoutEligibilityWork"
            SET "status" = 'DONE', "outcome" = ${outcome}, "lastReason" = ${reason},
                "doneAt" = ${DB_WALL}, "leaseToken" = NULL, "leasedUntil" = NULL,
                "retryAfter" = NULL, "updatedAt" = ${DB_WALL}
            WHERE "id" = ${id} AND "leaseToken" = ${token}
              AND "leasedUntil" >= ${DB_WALL} AND "status" = 'PENDING'`;
          return updated === 1 ? "DONE" : "LOST";
        }
        // A newer dirty mark arrived while we processed generation seenGen:
        // release the lease, due now — the newer generation is reconciled by
        // the next pass instead of being lost.
        await tx.$executeRaw`
          UPDATE "CheckoutEligibilityWork"
          SET "retryAfter" = ${DB_WALL}, "lastReason" = ${`superseded by generation ${rows[0].gen}`},
              "leaseToken" = NULL, "leasedUntil" = NULL, "updatedAt" = ${DB_WALL}
          WHERE "id" = ${id} AND "leaseToken" = ${token}
            AND "leasedUntil" >= ${DB_WALL} AND "status" = 'PENDING'`;
        return "REQUEUED";
      });
    },
    async purgeDone(olderThanMs) {
      return db.$executeRaw`
        DELETE FROM "CheckoutEligibilityWork"
        WHERE "status" = 'DONE' AND COALESCE("doneAt", "createdAt") < ${dbWallPlus(-olderThanMs)}`;
    },
    async find(shop, orderId) {
      const row = await db.checkoutEligibilityWork.findUnique({
        where: { shop_orderId: { shop, orderId } },
      });
      return row && toItem(row);
    },
  };
}

// ── In-memory store ───────────────────────────────────────────────────────────
// Same contract as prismaCheckoutWorkStore for unit tests. `clock` is the only
// time source (epoch ms); leases live/die by it exactly like the DB wall clock.

interface MemRow extends CheckoutWorkItem {
  leaseToken: string | null;
  leasedUntil: Date | null;
}

export function memoryCheckoutWorkStore(clock: () => number): CheckoutWorkStore {
  const rows = new Map<string, MemRow>();
  let tokenNo = 0;
  const now = () => new Date(clock());
  const key = (shop: string, orderId: string) => `${shop}${orderId}`;
  const live = (r: MemRow) =>
    r.status === "PENDING" && r.leaseToken !== null && (r.leasedUntil?.getTime() ?? 0) > clock();
  const due = (r: MemRow) =>
    r.status === "PENDING" &&
    (r.retryAfter?.getTime() ?? 0) <= clock() &&
    (r.leasedUntil === null || r.leasedUntil.getTime() < clock());
  const owns = (r: MemRow | undefined, id: string, token: string): r is MemRow =>
    !!r &&
    r.id === id &&
    r.leaseToken === token &&
    (r.leasedUntil?.getTime() ?? 0) >= clock() &&
    r.status === "PENDING";

  const findById = (id: string) => [...rows.values()].find((r) => r.id === id);

  return {
    async upsertDirty(shop, orderId, token, ttlMs, deadlineMs) {
      const k = key(shop, orderId);
      const existing = rows.get(k);
      if (!existing) {
        const item: MemRow = {
          id: `mem-${rows.size + 1}`,
          shop,
          orderId,
          gen: 1,
          status: "PENDING",
          attempts: 1,
          retryAfter: now(),
          leaseToken: token,
          leasedUntil: new Date(clock() + ttlMs),
          outcome: null,
          lastReason: null,
          deadlineAt: new Date(clock() + deadlineMs),
          doneAt: null,
          createdAt: now(),
          updatedAt: now(),
        };
        rows.set(k, item);
        return { item: { ...item }, acquired: true };
      }
      const hadLiveLease = live(existing);
      existing.gen += 1;
      existing.status = "PENDING";
      existing.retryAfter = now();
      existing.deadlineAt = new Date(clock() + deadlineMs);
      existing.outcome = null;
      existing.lastReason = null;
      existing.doneAt = null;
      if (!hadLiveLease) {
        existing.leaseToken = token;
        existing.leasedUntil = new Date(clock() + ttlMs);
        existing.attempts = 1;
      }
      existing.updatedAt = now();
      // Detached snapshot — Postgres returns a stale copy, and the gen race
      // test depends on complete() comparing the snapshot, not the live row.
      return { item: { ...existing }, acquired: !hadLiveLease };
    },
    async claimDue(limit, ttlMs) {
      const out: CheckoutWorkItem[] = [];
      for (const r of rows.values()) {
        if (out.length >= limit) break;
        if (!due(r)) continue;
        r.leaseToken = `sweep-${++tokenNo}`;
        r.leasedUntil = new Date(clock() + ttlMs);
        r.attempts += 1;
        r.updatedAt = now();
        out.push({ ...r });
      }
      return out;
    },
    async exhaustDue() {
      let n = 0;
      for (const r of rows.values()) {
        if (
          r.status === "PENDING" &&
          (r.leasedUntil === null || r.leasedUntil.getTime() < clock()) &&
          (r.attempts >= CHECKOUT_MAX_ATTEMPTS ||
            (r.deadlineAt !== null && r.deadlineAt.getTime() < clock()))
        ) {
          r.status = "REVIEW";
          r.outcome = "EXHAUSTED";
          r.lastReason = r.lastReason ?? "retry limit reached";
          r.leaseToken = null;
          r.leasedUntil = null;
          r.retryAfter = null;
          r.updatedAt = now();
          n++;
        }
      }
      return n;
    },
    async renew(id, token, ttlMs) {
      const r = findById(id);
      if (!r || r.leaseToken !== token || (r.leasedUntil?.getTime() ?? 0) < clock()) {
        throw new OwnershipLostError(`Checkout work ${id} is owned by another worker.`);
      }
      r.leasedUntil = new Date(clock() + ttlMs);
      r.updatedAt = now();
    },
    async scheduleRetry(id, token, delayMs, reason) {
      const r = findById(id);
      if (!owns(r, id, token)) return false;
      r.retryAfter = new Date(clock() + delayMs);
      r.lastReason = reason;
      r.leaseToken = null;
      r.leasedUntil = null;
      r.updatedAt = now();
      return true;
    },
    async complete(id, token, seenGen, outcome, reason) {
      const r = findById(id);
      if (!owns(r, id, token)) return "LOST";
      if (r.gen === seenGen) {
        r.status = "DONE";
        r.outcome = outcome;
        r.lastReason = reason;
        r.doneAt = now();
        r.leaseToken = null;
        r.leasedUntil = null;
        r.retryAfter = null;
        r.updatedAt = now();
        return "DONE";
      }
      r.retryAfter = now();
      r.lastReason = `superseded by generation ${r.gen}`;
      r.leaseToken = null;
      r.leasedUntil = null;
      r.updatedAt = now();
      return "REQUEUED";
    },
    async purgeDone(olderThanMs) {
      let n = 0;
      for (const [k, r] of rows) {
        if (
          r.status === "DONE" &&
          (r.doneAt ?? r.createdAt).getTime() < clock() - olderThanMs
        ) {
          rows.delete(k);
          n++;
        }
      }
      return n;
    },
    async find(shop, orderId) {
      const r = rows.get(key(shop, orderId));
      return r ? { ...r } : null;
    },
  };
}
