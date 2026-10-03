// ── Per-order merge claims ────────────────────────────────────────────────────
// A merge holds a lease on every order it touches, taken atomically before any
// evaluation runs and fenced (renewed) before every mutation. An expired lease
// can be taken over — the stale worker's next renew fails on the token.

import type { PrismaClient } from "@prisma/client";
import defaultDb from "../db.server";
import {
  ClaimContentionError,
  DB_WALL,
  dbWallPlus,
  OwnershipLostError,
  withOwnershipTx,
} from "./ownership.server";

export interface ClaimStore {
  /** All-or-nothing. true if every order is now claimed with `token`; false if
   *  any order is held by an unexpired lease (nothing changes in that case). */
  acquire(shop: string, orderIds: string[], token: string, ttlMs: number): Promise<boolean>;
  /** Extends every claim held with `token`. Throws OwnershipLostError unless
   *  affected rows === orderIds.length. */
  renew(shop: string, orderIds: string[], token: string, ttlMs: number): Promise<void>;
  /** Deletes only claims held with `token`. Never throws for stale tokens. */
  release(shop: string, orderIds: string[], token: string): Promise<void>;
  /** Deletes expired claims; returns count. */
  reapExpired(): Promise<number>;
  /** The subset of orderIds with a live claim (leasedUntil > db clock) —
   *  whose worker holds them is not reported; presence alone means "busy". */
  findHeld(shop: string, orderIds: string[]): Promise<Set<string>>;
}



const isContention = (err: unknown): boolean => {
  if (err instanceof ClaimContentionError) return true;
  const e = err as any;
  // Unique violation / serialization failure / deadlock, or Prisma's wrapped
  // transaction-conflict error — all mean a concurrent acquire won.
  return (
    e?.code === "P2002" ||
    e?.code === "P2034" ||
    ["23505", "40001", "40P01"].includes(e?.meta?.code)
  );
};

export function prismaClaimStore(db: PrismaClient = defaultDb): ClaimStore {
  return {
    async acquire(shop, orderIds, token, ttlMs) {
      const ids = [...new Set(orderIds)].sort();
      if (!ids.length) return true;
      const rowIds = ids.map(() => crypto.randomUUID());
      try {
        await db.$transaction(async (tx) => {
          // One statement: existing rows are only overwritten when their lease
          // already expired, so an unexpired conflict is skipped. Skipped rows
          // mean fewer returned than requested — roll everything back.
          const rows = await tx.$queryRaw<{ orderId: string }[]>`
            INSERT INTO "MergeClaim" ("id", "shop", "orderId", "leaseToken", "leasedUntil", "createdAt")
            SELECT r.id, ${shop}, r."orderId", ${token}, ${dbWallPlus(ttlMs)}, ${DB_WALL}
            FROM unnest(${rowIds}::text[], ${ids}::text[]) WITH ORDINALITY AS r(id, "orderId", ord)
            ORDER BY r.ord
            ON CONFLICT ("shop", "orderId") DO UPDATE
              SET "leaseToken" = EXCLUDED."leaseToken", "leasedUntil" = EXCLUDED."leasedUntil"
              WHERE "MergeClaim"."leasedUntil" < ${DB_WALL}
            RETURNING "orderId"`;
          if (rows.length < ids.length) throw new ClaimContentionError();
        });
        return true;
      } catch (err) {
        if (isContention(err)) return false;
        throw err;
      }
    },
    async renew(shop, orderIds, token, ttlMs) {
      const ids = [...new Set(orderIds)].sort();
      if (!ids.length) return;
      await withOwnershipTx(db, async (tx) => {
        // Lock every row first so the wait happens on the SELECT (bounded by
        // lock_timeout); the guarded UPDATE then evaluates token+expiry
        // against the rows as they stand after the wait — a locked-but-
        // unchanged row would not be re-evaluated by a conditional UPDATE.
        await tx.$queryRaw`
          SELECT "orderId" FROM "MergeClaim"
          WHERE "shop" = ${shop} AND "orderId" = ANY(${ids})
          ORDER BY "orderId" FOR UPDATE`;
        const updated = await tx.$executeRaw`
          UPDATE "MergeClaim" SET "leasedUntil" = ${dbWallPlus(ttlMs)}
          WHERE "shop" = ${shop} AND "orderId" = ANY(${ids})
            AND "leaseToken" = ${token} AND "leasedUntil" > ${DB_WALL}`;
        if (updated !== ids.length) {
          throw new OwnershipLostError(`Merge claim lost for ${shop} (${ids.length} orders).`);
        }
      });
    },
    async release(shop, orderIds, token) {
      const ids = [...new Set(orderIds)].sort();
      if (!ids.length) return;
      await withOwnershipTx(db, async (tx) => {
        await tx.$queryRaw`
          SELECT "orderId" FROM "MergeClaim"
          WHERE "shop" = ${shop} AND "orderId" = ANY(${ids})
          ORDER BY "orderId" FOR UPDATE`;
        await tx.$executeRaw`
          DELETE FROM "MergeClaim"
          WHERE "shop" = ${shop} AND "orderId" = ANY(${ids}) AND "leaseToken" = ${token}`;
      });
    },
    async reapExpired() {
      return db.$executeRaw`DELETE FROM "MergeClaim" WHERE "leasedUntil" < ${DB_WALL}`;
    },
    async findHeld(shop, orderIds) {
      const ids = [...new Set(orderIds)];
      if (!ids.length) return new Set();
      const rows = await db.$queryRaw<{ orderId: string }[]>`
        SELECT "orderId" FROM "MergeClaim"
        WHERE "shop" = ${shop} AND "orderId" = ANY(${ids}) AND "leasedUntil" > ${DB_WALL}`;
      return new Set(rows.map((r) => r.orderId));
    },
  };
}
