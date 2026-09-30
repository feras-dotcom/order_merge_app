import db from "../db.server";

// ── Merge journal ─────────────────────────────────────────────────────────────
// Persistence for MergeOperation (see prisma/schema.prisma). Behind an
// interface so executeMerge's recovery logic can be tested without a database.

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
  updatedAt: Date;
}

export type NewMergeOperation = Omit<
  MergeOperationRecord,
  "id" | "attempts" | "lastError" | "updatedAt"
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
  create(op: NewMergeOperation): Promise<MergeOperationRecord>;
  update(
    id: string,
    patch: Partial<Pick<MergeOperationRecord, "status" | "secondaries" | "attempts" | "lastError">>,
  ): Promise<void>;
  /** PENDING_COMMIT and COMMITTED operations for the shop. */
  findUnfinished(shop: string): Promise<MergeOperationRecord[]>;
  /** Order IDs involved in any PENDING_COMMIT / COMMITTED / NEEDS_REVIEW op. */
  findBlockingOrderIds(shop: string): Promise<Set<string>>;
  /** Idempotent: a merged order is only ever recorded once. */
  recordHistory(entry: MergeHistoryEntry): Promise<void>;
}

const toRecord = (row: any): MergeOperationRecord => ({
  ...row,
  secondaries: row.secondaries as JournalSecondary[],
});

export const prismaMergeJournal: MergeJournal = {
  async create(op) {
    const row = await db.mergeOperation.create({
      data: { ...op, secondaries: op.secondaries as any },
    });
    return toRecord(row);
  },
  async update(id, patch) {
    await db.mergeOperation.update({
      where: { id },
      data: { ...patch, ...(patch.secondaries && { secondaries: patch.secondaries as any }) },
    });
  },
  async findUnfinished(shop) {
    const rows = await db.mergeOperation.findMany({
      where: { shop, status: { in: ["PENDING_COMMIT", "COMMITTED"] } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toRecord);
  },
  async findBlockingOrderIds(shop) {
    const rows = await db.mergeOperation.findMany({
      where: { shop, status: { in: BLOCKING_STATUSES } },
      select: { involvedOrderIds: true },
    });
    return new Set(rows.flatMap((r) => r.involvedOrderIds));
  },
  async recordHistory(entry) {
    await db.mergeRecord.createMany({ data: [entry], skipDuplicates: true });
  },
};

/** Operations the merchant must look at (shown on the dashboard). */
export async function listOperationsNeedingReview(shop: string) {
  return db.mergeOperation.findMany({
    where: { shop, status: "NEEDS_REVIEW" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      primaryOrderId: true,
      primaryOrderName: true,
      secondaries: true,
      lastError: true,
      createdAt: true,
    },
  });
}
