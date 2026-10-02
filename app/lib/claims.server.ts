// ── Per-order merge claims ────────────────────────────────────────────────────
// A merge holds a lease on every order it touches, taken atomically before any
// evaluation runs and fenced (renewed) before every mutation. An expired lease
// can be taken over — the stale worker's next renew fails on the token.

import type { PrismaClient } from "@prisma/client";
import defaultDb from "../db.server";
import { ClaimContentionError, DB_WALL, dbWallPlus, OwnershipLostError } from "./ownership.server";

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
      const ids = [...new Set(orderIds)];
      if (!ids.length) return;
      const updated = await db.$executeRaw`
        UPDATE "MergeClaim" SET "leasedUntil" = ${dbWallPlus(ttlMs)}
        WHERE "shop" = ${shop} AND "orderId" = ANY(${ids})
          AND "leaseToken" = ${token} AND "leasedUntil" > ${DB_WALL}`;
      if (updated !== ids.length) {
        throw new OwnershipLostError(`Merge claim lost for ${shop} (${ids.length} orders).`);
      }
    },
    async release(shop, orderIds, token) {
      const ids = [...new Set(orderIds)];
      if (!ids.length) return;
      await db.$executeRaw`
        DELETE FROM "MergeClaim"
        WHERE "shop" = ${shop} AND "orderId" = ANY(${ids}) AND "leaseToken" = ${token}`;
    },
    async reapExpired() {
      return db.$executeRaw`DELETE FROM "MergeClaim" WHERE "leasedUntil" < ${DB_WALL}`;
    },
  };
}
