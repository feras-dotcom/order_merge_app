import { Prisma, type PrismaClient } from "@prisma/client";
import defaultDb from "../db.server";
import { DB_WALL, dbWallPlus, OwnershipLostError } from "./ownership.server";

// ── Merge journal ─────────────────────────────────────────────────────────────
// Persistence for MergeOperation (see prisma/schema.prisma). Behind an
// interface so executeMerge's recovery logic can be tested without a database.
//
// An operation being driven by a worker carries a lease (leaseToken +
// leasedUntil). Every write that must only come from the current owner —
// status, secondaries, attempts, lastError, renew, lease acquisition — is a
// conditional UPDATE on (id, leaseToken, unexpired) checked by affected rows;
// a stale worker gets OwnershipLostError instead of overwriting newer state.

export type MergeOperationStatus =
  | "PENDING_COMMIT"
  | "COMMITTED"
  | "COMPLETED"
  | "ABANDONED"
  | "NEEDS_REVIEW";

/** Statuses whose orders must not take part in any new merge. */
export const BLOCKING_STATUSES: MergeOperationStatus[] = [
  "PENDING_COMMIT",
  "COMMITTED",
  "NEEDS_REVIEW",
];

/** Statuses a worker may take over and finish. */
const UNFINISHED_STATUSES: MergeOperationStatus[] = ["PENDING_COMMIT", "COMMITTED"];

export interface JournalSecondary {
  id: string;
  name: string;
  /** Units transferred to the primary (for Consolidation History). */
  items: number;
  /** Cancellation confirmed and history recorded. */
  done: boolean;
  /** ISO time orderCancel was last accepted. orderCancel is asynchronous, so
   *  while a recent request is outstanding MergeShip polls instead of
   *  cancelling again. */
  cancelRequestedAt?: string | null;
}

export interface MergeOperationRecord {
  id: string;
  shop: string;
  status: MergeOperationStatus;
  primaryOrderId: string;
  primaryOrderName: string;
  customerId: string | null;
  primaryLineItemCountBefore: number;
  addedLineItemCount: number;
  secondaries: JournalSecondary[];
  involvedOrderIds: string[];
  attempts: number;
  lastError: string | null;
  leaseToken: string | null;
  leasedUntil: Date | null;
  updatedAt: Date;
}

export type NewMergeOperation = Omit<
  MergeOperationRecord,
  "id" | "attempts" | "lastError" | "leaseToken" | "leasedUntil" | "updatedAt"
>;

export interface MergeHistoryEntry {
  shop: string;
  primaryOrderId: string;
  primaryOrderName: string;
  mergedOrderId: string;
  mergedOrderName: string;
  customerId: string | null;
  itemsCombined: number;
}

export interface MergeJournal {
  /** Writes the intent row before the commit, leased to `token`. */
  create(op: NewMergeOperation, token: string, ttlMs: number): Promise<MergeOperationRecord>;
  /** Conditional on op.leaseToken + unexpired. Throws OwnershipLostError on 0 rows. */
  update(
    op: Pick<MergeOperationRecord, "id" | "leaseToken">,
    patch: Partial<Pick<MergeOperationRecord, "status" | "secondaries" | "attempts" | "lastError">>,
  ): Promise<void>;
  /** Extends the lease. Conditional; throws OwnershipLostError. */
  renew(op: Pick<MergeOperationRecord, "id" | "leaseToken">, ttlMs: number): Promise<void>;
  /** Takes the lease of an unfinished op whose lease is null/expired. Returns
   *  the fresh record (with the new token) or null if another worker holds it
   *  or it is no longer unfinished. */
  acquireLease(opId: string, token: string, ttlMs: number): Promise<MergeOperationRecord | null>;
  /** v1 only: PENDING_COMMIT and COMMITTED operations for the shop. */
  findUnfinished(shop: string): Promise<MergeOperationRecord[]>;
  /** v1 only: order IDs involved in any PENDING_COMMIT / COMMITTED /
   *  NEEDS_REVIEW op (v2 involvement is covered by MergeOrderLock). */
  findBlockingOrderIds(shop: string): Promise<Set<string>>;
  /** v1 only: orderId -> status for blocking ops, so callers can tell active
   *  (PENDING_COMMIT/COMMITTED) from flagged (NEEDS_REVIEW) involvement. */
  findBlockingOrderStatuses(shop: string): Promise<Map<string, MergeOperationStatus>>;
  /** v1 only: shops having at least one PENDING_COMMIT/COMMITTED operation. */
  findShopsWithUnfinished(): Promise<string[]>;
  /** Idempotent: a merged order is only ever recorded once. */
  recordHistory(entry: MergeHistoryEntry): Promise<void>;
}

const toRecord = (row: any): MergeOperationRecord => ({
  ...row,
  secondaries: row.secondaries as JournalSecondary[],
});

const leasedCondition = (op: Pick<MergeOperationRecord, "id" | "leaseToken">) =>
  Prisma.sql`"id" = ${op.id} AND "leaseToken" = ${op.leaseToken} AND "leasedUntil" >= ${DB_WALL}`;

export function makeMergeJournal(db: PrismaClient): MergeJournal {
  return {
    async create(op, token, ttlMs) {
      const rows = await db.$queryRaw<any[]>`
      INSERT INTO "MergeOperation" (
        "id", "shop", "status", "primaryOrderId", "primaryOrderName", "customerId",
        "primaryLineItemCountBefore", "addedLineItemCount", "secondaries",
        "involvedOrderIds", "attempts", "leaseToken", "leasedUntil", "createdAt", "updatedAt"
      ) VALUES (
        ${crypto.randomUUID()}, ${op.shop}, ${op.status}, ${op.primaryOrderId},
        ${op.primaryOrderName}, ${op.customerId}, ${op.primaryLineItemCountBefore},
        ${op.addedLineItemCount}, ${JSON.stringify(op.secondaries)}::jsonb,
        ${op.involvedOrderIds}, 0, ${token}, ${dbWallPlus(ttlMs)}, ${DB_WALL}, ${DB_WALL}
      )
      RETURNING *`;
      return toRecord(rows[0]);
    },
    async update(op, patch) {
      const sets: Prisma.Sql[] = [];
      if (patch.status !== undefined) sets.push(Prisma.sql`"status" = ${patch.status}`);
      if (patch.secondaries !== undefined)
        sets.push(Prisma.sql`"secondaries" = ${JSON.stringify(patch.secondaries)}::jsonb`);
      if (patch.attempts !== undefined) sets.push(Prisma.sql`"attempts" = ${patch.attempts}`);
      if ("lastError" in patch) sets.push(Prisma.sql`"lastError" = ${patch.lastError}`);
      if (!sets.length) return;
      const updated = await db.$executeRaw`
      UPDATE "MergeOperation" SET ${Prisma.join(sets)}, "updatedAt" = ${DB_WALL}
      WHERE ${leasedCondition(op)}`;
      if (updated === 0) throw new OwnershipLostError(`Merge operation ${op.id} is owned by another worker.`);
    },
    async renew(op, ttlMs) {
      const updated = await db.$executeRaw`
      UPDATE "MergeOperation" SET "leasedUntil" = ${dbWallPlus(ttlMs)}, "updatedAt" = ${DB_WALL}
      WHERE ${leasedCondition(op)}`;
      if (updated === 0) throw new OwnershipLostError(`Merge operation ${op.id} is owned by another worker.`);
    },
    async acquireLease(opId, token, ttlMs) {
      const rows = await db.$queryRaw<any[]>`
      UPDATE "MergeOperation"
      SET "leaseToken" = ${token}, "leasedUntil" = ${dbWallPlus(ttlMs)}, "updatedAt" = ${DB_WALL}
      WHERE "id" = ${opId} AND "status" IN ('PENDING_COMMIT', 'COMMITTED')
        AND ("leasedUntil" IS NULL OR "leasedUntil" < ${DB_WALL})
      RETURNING *`;
      return rows.length ? toRecord(rows[0]) : null;
    },
    async findUnfinished(shop) {
      const rows = await db.mergeOperation.findMany({
        where: { shop, protocolVersion: 1, status: { in: UNFINISHED_STATUSES } },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toRecord);
    },
    async findBlockingOrderIds(shop) {
      const rows = await db.mergeOperation.findMany({
        where: { shop, protocolVersion: 1, status: { in: BLOCKING_STATUSES } },
        select: { involvedOrderIds: true },
      });
      return new Set(rows.flatMap((r) => r.involvedOrderIds));
    },
    async findBlockingOrderStatuses(shop) {
      const rows = await db.mergeOperation.findMany({
        where: { shop, protocolVersion: 1, status: { in: BLOCKING_STATUSES } },
        select: { status: true, involvedOrderIds: true },
      });
      const map = new Map<string, MergeOperationStatus>();
      for (const row of rows) {
        for (const orderId of row.involvedOrderIds) map.set(orderId, row.status as MergeOperationStatus);
      }
      return map;
    },
    async findShopsWithUnfinished() {
      const rows = await db.mergeOperation.findMany({
        where: { protocolVersion: 1, status: { in: UNFINISHED_STATUSES } },
        select: { shop: true },
        distinct: ["shop"],
      });
      return rows.map((r) => r.shop);
    },
    async recordHistory(entry) {
      await db.mergeRecord.createMany({ data: [entry], skipDuplicates: true });
    },
  };
}

export const prismaMergeJournal: MergeJournal = makeMergeJournal(defaultDb);

/** Operations the merchant must look at (shown on the dashboard): v1 ops
 *  flagged NEEDS_REVIEW plus v2 ops parked in REVIEW_REQUIRED. */
export async function listOperationsNeedingReview(shop: string) {
  return defaultDb.mergeOperation.findMany({
    where: {
      shop,
      OR: [
        { protocolVersion: 1, status: "NEEDS_REVIEW" },
        { protocolVersion: 2, phase: "REVIEW_REQUIRED" },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      primaryOrderId: true,
      primaryOrderName: true,
      secondaries: true,
      lastError: true,
      createdAt: true,
      protocolVersion: true,
      phase: true,
      reviewReason: true,
    },
  });
}
