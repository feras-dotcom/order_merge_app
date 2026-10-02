// ── Protocol v2 operation store ───────────────────────────────────────────────
// Persistence for the "never replace, only reconcile" protocol (spec §0/§3):
//
// - MergeOrderLock rows are durable and never expire. They exist for every
//   order an operation touches from createOperation until the terminal
//   transition (COMPLETED / ABANDONED) deletes them in the same transaction.
// - MergeMutationAttempt is the write-ahead dispatch record: the row exists
//   BEFORE the Shopify request is sent, so a response lost in flight is
//   reconciled from evidence — never silently re-dispatched.
// - Leases (leaseToken/leasedUntil) give liveness and stale-write protection
//   ONLY; they are never the reason a mutation is safe.
//
// Every ownership-sensitive write is a single conditional statement or a
// withOwnershipTx transaction; every clock comparison uses DB_WALL
// ((clock_timestamp() AT TIME ZONE 'UTC')). now() is forbidden.

import { Prisma, type PrismaClient } from "@prisma/client";
import defaultDb from "../db.server";
import {
  ClaimContentionError,
  DB_WALL,
  dbWallPlus,
  OwnershipLostError,
  withOwnershipTx,
} from "./ownership.server";

export type OperationPhase =
  | "READY"
  | "COMMIT_IN_DOUBT"
  | "COMMIT_REJECTED"
  | "APPLIED"
  | "COMPLETED"
  | "ABANDONED"
  | "REVIEW_REQUIRED";

export const TERMINAL_PHASES: OperationPhase[] = ["COMPLETED", "ABANDONED"];

export type AttemptKind = "EDIT_COMMIT" | "ORDER_CANCEL" | "REVIEW_TAG" | "ANNOTATE" | "CLOSE";
export type AttemptState = "DISPATCHING" | "SUCCEEDED" | "REJECTED" | "UNKNOWN";
export type ControlSwitch = "newMergesEnabled" | "completionEnabled";

/** RECOMMIT_SAME_CALC is OFF: no code path may re-dispatch orderEditCommit for
 *  an operation that already has an EDIT_COMMIT attempt — the outcome is
 *  reconciled from evidence instead. Do not add one behind a flag either. */
export const RECOMMIT_SAME_CALC = false;

export type SecondaryCancelPhase =
  | "TRANSFER_PENDING"
  | "CANCEL_READY"
  | "CANCEL_IN_DOUBT"
  | "CANCEL_VERIFIED"
  | "CANCEL_REVIEW";

export interface OperationSecondary {
  id: string;
  name: string;
  /** Units transferred to the primary. */
  items: number;
  /** Cancellation confirmed and history recorded. */
  done?: boolean;
  cancelPhase?: SecondaryCancelPhase;
  cancelledAt?: string | null;
  jobId?: string | null;
  cancelRequestedAt?: string | null;
  staffNoteMatched?: boolean;
}

export interface OperationRecord {
  id: string;
  shop: string;
  status: string; // legacy v1 shield: NEEDS_REVIEW while v2 non-terminal
  protocolVersion: number;
  phase: OperationPhase | null;
  opToken: string | null;
  primaryOrderId: string;
  primaryOrderName: string;
  customerId: string | null;
  primaryLineItemCountBefore: number;
  addedLineItemCount: number;
  secondaries: OperationSecondary[];
  involvedOrderIds: string[];
  attempts: number;
  lastError: string | null;
  leaseToken: string | null;
  leasedUntil: Date | null;
  calculatedOrderId: string | null;
  expectedTransfer: unknown;
  expectedLocationId: string | null;
  primaryLineItemIdsBefore: string[];
  appliedEvidence: unknown;
  firstDispatchAt: Date | null;
  nextCheckAt: Date | null;
  reviewReason: string | null;
  reviewRequiredAt: Date | null;
  workItemId: string | null;
  sideEffectsDone: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MutationAttempt {
  id: string;
  operationId: string;
  kind: AttemptKind;
  targetOrderId: string;
  attemptNo: number;
  state: AttemptState;
  dispatchToken: string;
  dispatchedAt: Date;
  respondedAt: Date | null;
  responseSummary: string | null;
  jobId: string | null;
}

export interface ControlRow {
  id: string;
  newMergesEnabled: boolean;
  completionEnabled: boolean;
  allowShops: string[];
  note: string | null;
}

export interface NewOperationV2 {
  shop: string;
  /** Token the caller currently holds on every involved order's MergeClaim. */
  claimToken: string;
  involvedOrderIds: string[];
  primaryOrderId: string;
  primaryOrderName: string;
  customerId: string | null;
  primaryLineItemCountBefore: number;
  addedLineItemCount: number;
  secondaries: OperationSecondary[];
  /** Set when driven by a ProcessedWebhook work item (settled inside the tx). */
  workItemId?: string;
  workToken?: string;
  opToken: string;
  calculatedOrderId: string | null;
  expectedTransfer: unknown;
  expectedLocationId: string | null;
  primaryLineItemIdsBefore: string[];
  /** Fresh lease token for the operation row. */
  leaseToken: string;
  ttlMs: number;
}

export interface OperationPatch {
  /** Condition: the op must currently be in this phase (0 rows otherwise). */
  expectedPhase?: OperationPhase;
  phase?: OperationPhase;
  /** ms offset from the wall clock, "now" for due immediately, null to clear. */
  nextCheckAt?: number | "now" | null;
  appliedEvidence?: unknown;
  reviewReason?: string | null;
  secondaries?: OperationSecondary[];
  lastError?: string | null;
  firstDispatchAt?: "now";
}

export interface DispatchGateArgs {
  op: Pick<OperationRecord, "id" | "shop" | "leaseToken">;
  kind: AttemptKind;
  targetOrderId: string;
  /** Token proving this process is the dispatcher that may record the result. */
  dispatchToken: string;
  /** The phase the op must be in for this dispatch to be legal. */
  requiredPhase: OperationPhase;
}

export interface OperationStore {
  /** Atomically: verify claim ownership (+30s margin), settle the linked work
   *  item, prove no lock/v1-op blocks any id, insert the v2 op (READY) and one
   *  MergeOrderLock per involved order. Throws OwnershipLostError (stale
   *  claims/work lease) or ClaimContentionError (blocked) — nothing persists. */
  createOperation(input: NewOperationV2): Promise<OperationRecord>;
  /** Lease the next due non-terminal v2 op (or a specific one) via FOR UPDATE
   *  SKIP LOCKED. Returns the row with the new token, or null. */
  acquireOperationLease(
    opId: string | undefined,
    token: string,
    ttlMs: number,
  ): Promise<OperationRecord | null>;
  /** Extend the op lease. Conditional on token + unexpired; throws
   *  OwnershipLostError on 0 rows. */
  renewOperation(op: Pick<OperationRecord, "id" | "leaseToken">, ttlMs: number): Promise<void>;
  /** Conditional UPDATE on (id, leaseToken, unexpired, expectedPhase). Terminal
   *  phases run in a transaction that also deletes the order locks and
   *  settles/requeues the linked work item; REVIEW_REQUIRED settles it as
   *  OPERATION_REVIEW (locks stay — the orders remain locked for review). */
  transition(
    op: Pick<OperationRecord, "id" | "leaseToken" | "workItemId">,
    patch: OperationPatch,
  ): Promise<void>;
  /** The ONLY way a Shopify mutation may be dispatched: inside one
   *  transaction, verify the op lease (with 30s margin), the required phase,
   *  the AppControl switch (MERGESHIP_MUTATIONS=enabled is checked in code
   *  first) and the per-kind guards, flip phase for EDIT_COMMIT, and insert
   *  the DISPATCHING attempt row. Returns it, or null when the gate is
   *  refused — the caller must NOT send anything on null. */
  openDispatchGate(args: DispatchGateArgs): Promise<MutationAttempt | null>;
  /** Write-once fact: records the dispatch outcome on the DISPATCHING attempt
   *  held by dispatchToken (NOT the op lease — facts belong to the
   *  dispatcher). Returns false if already recorded or token mismatch. */
  recordAttempt(
    attemptId: string,
    dispatchToken: string,
    state: Exclude<AttemptState, "DISPATCHING">,
    summary: string | null,
    jobId?: string | null,
  ): Promise<boolean>;
  listAttempts(opId: string, kind?: AttemptKind, targetOrderId?: string): Promise<MutationAttempt[]>;
  /** Atomically mark the secondary CANCEL_VERIFIED (conditional on
   *  lease + APPLIED phase) and insert the MergeRecord (deduped by
   *  (shop, mergedOrderId)). 0 rows on the UPDATE => OwnershipLostError and
   *  NO history row — a stale worker can never write history. */
  recordHistoryAndVerifyCancel(
    op: OperationRecord,
    secondaryId: string,
    evidence: { cancelledAt: string },
  ): Promise<void>;
  /** Order ids (of `ids`) currently held by a MergeOrderLock. */
  findLockedOrderIds(shop: string, ids: string[]): Promise<Set<string>>;
  /** Order ids (of `ids`) involved in a v1 op in a blocking status. */
  findBlockingV1(shop: string, ids: string[]): Promise<Set<string>>;
  getControl(): Promise<ControlRow | null>;
  setControl(patch: Partial<Omit<ControlRow, "id">>): Promise<void>;
  /** Read-side helper for entry points (the gate SQL is the enforcement). */
  isEnabled(shop: string, sw: ControlSwitch): Promise<boolean>;
  /** WorkerInstance heartbeat upsert (sweeper liveness). */
  heartbeat(instanceId: string, deploymentId: string | null, version: string | null): Promise<void>;
  listRecentInstances(): Promise<any[]>;
  /** Delete heartbeat rows older than olderThanMs. */
  purgeOldInstances(olderThanMs: number): Promise<number>;
}

const toOp = (row: any): OperationRecord => row as OperationRecord;

const V1_BLOCKING = ["PENDING_COMMIT", "COMMITTED", "NEEDS_REVIEW"];

/** Legacy `status` shield for v2 rows: NEEDS_REVIEW while non-terminal so old
 *  code still blocks the orders and never resumes them. */
const legacyStatusFor = (phase: OperationPhase) =>
  phase === "COMPLETED" || phase === "ABANDONED" ? phase : "NEEDS_REVIEW";

const KIND_SWITCH: Record<AttemptKind, ControlSwitch> = {
  EDIT_COMMIT: "newMergesEnabled",
  ORDER_CANCEL: "completionEnabled",
  REVIEW_TAG: "completionEnabled",
  ANNOTATE: "completionEnabled",
  CLOSE: "completionEnabled",
};

const mutationsEnabled = () => process.env.MERGESHIP_MUTATIONS === "enabled";

export function makeOperationStore(db: PrismaClient): OperationStore {
  return {
    async createOperation(input) {
      const ids = [...new Set(input.involvedOrderIds)].sort();
      const opId = crypto.randomUUID();
      try {
        return await withOwnershipTx(db, async (tx) => {
          // 1. The caller still owns every claim, with enough margin that the
          //    locks are in place before they could expire.
          const held = await tx.$queryRaw<{ orderId: string }[]>`
            SELECT "orderId" FROM "MergeClaim"
            WHERE "shop" = ${input.shop} AND "orderId" = ANY(${ids})
              AND "leaseToken" = ${input.claimToken}
              AND "leasedUntil" > ${DB_WALL} + interval '30 seconds'
            FOR UPDATE`;
          if (held.length !== ids.length) {
            throw new OwnershipLostError(`Merge claims lost for ${input.shop} before operation create.`);
          }

          // 2. Settle the work item this operation replaces (same tx, same
          //    lease semantics as WorkStore.linkOperation).
          if (input.workItemId) {
            const linked = await tx.$executeRaw`
              UPDATE "ProcessedWebhook"
              SET "status" = 'DONE', "outcome" = 'OPERATION_CREATED',
                  "operationId" = ${opId}, "doneAt" = ${DB_WALL},
                  "leaseToken" = NULL, "leasedUntil" = NULL, "retryAfter" = NULL,
                  "updatedAt" = ${DB_WALL}
              WHERE "id" = ${input.workItemId} AND "leaseToken" = ${input.workToken}
                AND "leasedUntil" > ${DB_WALL} AND "status" = 'PENDING'`;
            if (linked !== 1) {
              throw new OwnershipLostError(`Work item ${input.workItemId} is owned by another worker.`);
            }
          }

          // 3. Blocking: a durable lock on any involved order, or a v1
          //    operation in a blocking status touching it. (The unique index
          //    on MergeOrderLock would also catch the lock case on insert.)
          const [locked] = await tx.$queryRaw<{ orderId: string }[]>`
            SELECT "orderId" FROM "MergeOrderLock"
            WHERE "shop" = ${input.shop} AND "orderId" = ANY(${ids}) LIMIT 1`;
          if (locked) throw new ClaimContentionError(`Order ${locked.orderId} is locked.`);
          const [blocking] = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM "MergeOperation"
            WHERE "shop" = ${input.shop} AND "status" = ANY(${V1_BLOCKING})
              AND "involvedOrderIds" && ${ids} LIMIT 1`;
          if (blocking) throw new ClaimContentionError(`Order involved in blocking op ${blocking.id}.`);

          // 4. The v2 operation row (READY; legacy status shield NEEDS_REVIEW).
          const [op] = await tx.$queryRaw<any[]>`
            INSERT INTO "MergeOperation" (
              "id", "shop", "status", "protocolVersion", "phase", "opToken",
              "primaryOrderId", "primaryOrderName", "customerId",
              "primaryLineItemCountBefore", "addedLineItemCount", "secondaries",
              "involvedOrderIds", "calculatedOrderId", "expectedTransfer",
              "expectedLocationId", "primaryLineItemIdsBefore", "workItemId",
              "attempts", "leaseToken", "leasedUntil", "nextCheckAt",
              "createdAt", "updatedAt"
            ) VALUES (
              ${opId}, ${input.shop}, 'NEEDS_REVIEW', 2, 'READY', ${input.opToken},
              ${input.primaryOrderId}, ${input.primaryOrderName}, ${input.customerId},
              ${input.primaryLineItemCountBefore}, ${input.addedLineItemCount},
              ${JSON.stringify(input.secondaries)}::jsonb,
              ${input.involvedOrderIds}, ${input.calculatedOrderId},
              ${JSON.stringify(input.expectedTransfer ?? null)}::jsonb,
              ${input.expectedLocationId}, ${input.primaryLineItemIdsBefore},
              ${input.workItemId ?? null}, 0, ${input.leaseToken},
              ${dbWallPlus(input.ttlMs)}, ${DB_WALL}, ${DB_WALL}, ${DB_WALL}
            )
            RETURNING *`;

          // 5. Durable locks — unique violation rolls everything back.
          for (const orderId of ids) {
            await tx.$executeRaw`
              INSERT INTO "MergeOrderLock" ("id", "shop", "orderId", "operationId", "createdAt")
              VALUES (${crypto.randomUUID()}, ${input.shop}, ${orderId}, ${opId}, ${DB_WALL})`;
          }
          return toOp(op);
        });
      } catch (err) {
        // A lock-row unique violation means a concurrent createOperation won.
        const e = err as any;
        if (e?.code === "P2002" || e?.meta?.code === "23505") {
          throw new ClaimContentionError("Order lock conflict during operation create.");
        }
        throw err;
      }
    },

    async acquireOperationLease(opId, token, ttlMs) {
      const rows = await db.$queryRaw<any[]>`
        UPDATE "MergeOperation"
        SET "leaseToken" = ${token}, "leasedUntil" = ${dbWallPlus(ttlMs)}, "updatedAt" = ${DB_WALL}
        WHERE id = (
          SELECT id FROM "MergeOperation"
          WHERE "protocolVersion" = 2 AND "phase" NOT IN ('COMPLETED', 'ABANDONED')
            AND "nextCheckAt" <= ${DB_WALL}
            AND ("leasedUntil" IS NULL OR "leasedUntil" < ${DB_WALL})
            ${opId ? Prisma.sql`AND id = ${opId}` : Prisma.empty}
          ORDER BY "nextCheckAt" LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *`;
      return rows.length ? toOp(rows[0]) : null;
    },

    async renewOperation(op, ttlMs) {
      const updated = await db.$executeRaw`
        UPDATE "MergeOperation"
        SET "leasedUntil" = ${dbWallPlus(ttlMs)}, "updatedAt" = ${DB_WALL}
        WHERE "id" = ${op.id} AND "leaseToken" = ${op.leaseToken}
          AND "leasedUntil" > ${DB_WALL}`;
      if (updated === 0) {
        throw new OwnershipLostError(`Merge operation ${op.id} is owned by another worker.`);
      }
    },

    async transition(op, patch) {
      const sets: Prisma.Sql[] = [];
      const targetPhase = patch.phase;
      if (targetPhase !== undefined) {
        sets.push(Prisma.sql`"phase" = ${targetPhase}`);
        sets.push(Prisma.sql`"status" = ${legacyStatusFor(targetPhase)}`);
        if (targetPhase === "REVIEW_REQUIRED") {
          sets.push(Prisma.sql`"reviewRequiredAt" = ${DB_WALL}`);
        }
      }
      if (patch.nextCheckAt !== undefined) {
        sets.push(
          patch.nextCheckAt === null
            ? Prisma.sql`"nextCheckAt" = NULL`
            : patch.nextCheckAt === "now"
              ? Prisma.sql`"nextCheckAt" = ${DB_WALL}`
              : Prisma.sql`"nextCheckAt" = ${dbWallPlus(patch.nextCheckAt)}`,
        );
      }
      if (patch.appliedEvidence !== undefined) {
        sets.push(Prisma.sql`"appliedEvidence" = ${JSON.stringify(patch.appliedEvidence)}::jsonb`);
      }
      if (patch.reviewReason !== undefined) sets.push(Prisma.sql`"reviewReason" = ${patch.reviewReason}`);
      if (patch.secondaries !== undefined) {
        sets.push(Prisma.sql`"secondaries" = ${JSON.stringify(patch.secondaries)}::jsonb`);
      }
      if (patch.lastError !== undefined) sets.push(Prisma.sql`"lastError" = ${patch.lastError}`);
      if (patch.firstDispatchAt === "now") sets.push(Prisma.sql`"firstDispatchAt" = ${DB_WALL}`);
      sets.push(Prisma.sql`"updatedAt" = ${DB_WALL}`);

      const condition = Prisma.sql`
        "id" = ${op.id} AND "leaseToken" = ${op.leaseToken} AND "leasedUntil" > ${DB_WALL}
        ${patch.expectedPhase ? Prisma.sql`AND "phase" = ${patch.expectedPhase}` : Prisma.empty}`;

      const terminal = targetPhase === "COMPLETED" || targetPhase === "ABANDONED";
      const settlesWork = targetPhase === "REVIEW_REQUIRED";
      if (!terminal && !settlesWork) {
        const updated = await db.$executeRaw`
          UPDATE "MergeOperation" SET ${Prisma.join(sets)} WHERE ${condition}`;
        if (updated === 0) {
          throw new OwnershipLostError(`Merge operation ${op.id} is owned by another worker.`);
        }
        return;
      }

      // Terminal/REVIEW_REQUIRED: locks and the linked work item move in the
      // same transaction as the phase change — an op can never end leaving
      // locks behind or its work item stranded.
      await withOwnershipTx(db, async (tx) => {
        const updated = await tx.$executeRaw`
          UPDATE "MergeOperation" SET ${Prisma.join(sets)} WHERE ${condition}`;
        if (updated === 0) {
          throw new OwnershipLostError(`Merge operation ${op.id} is owned by another worker.`);
        }
        if (terminal) {
          await tx.$executeRaw`DELETE FROM "MergeOrderLock" WHERE "operationId" = ${op.id}`;
        }
        if (!op.workItemId) return;
        if (targetPhase === "COMPLETED") {
          await tx.$executeRaw`
            UPDATE "ProcessedWebhook"
            SET "status" = 'DONE', "outcome" = 'MERGED', "doneAt" = ${DB_WALL}, "updatedAt" = ${DB_WALL}
            WHERE "id" = ${op.workItemId} AND "status" = 'DONE'
              AND "outcome" = 'OPERATION_CREATED' AND "operationId" = ${op.id}`;
        } else if (targetPhase === "ABANDONED") {
          await tx.$executeRaw`
            UPDATE "ProcessedWebhook"
            SET "status" = 'PENDING', "retryAfter" = ${DB_WALL}, "outcome" = NULL,
                "lastReason" = ${patch.lastError ?? "operation abandoned"},
                "leaseToken" = NULL, "leasedUntil" = NULL, "updatedAt" = ${DB_WALL}
            WHERE "id" = ${op.workItemId} AND "status" = 'DONE'
              AND "outcome" = 'OPERATION_CREATED' AND "operationId" = ${op.id}`;
        } else {
          // REVIEW_REQUIRED
          await tx.$executeRaw`
            UPDATE "ProcessedWebhook"
            SET "status" = 'DONE', "outcome" = 'OPERATION_REVIEW', "doneAt" = ${DB_WALL},
                "updatedAt" = ${DB_WALL}
            WHERE "id" = ${op.workItemId} AND "status" = 'DONE'
              AND "outcome" = 'OPERATION_CREATED' AND "operationId" = ${op.id}`;
        }
      });
    },

    async openDispatchGate({ op, kind, targetOrderId, dispatchToken, requiredPhase }) {
      // Defense in depth: the env flag is checked in code before any SQL.
      if (!mutationsEnabled()) return null;
      const switchColumn = KIND_SWITCH[kind];

      const kindGuards: Prisma.Sql[] = [];
      if (kind === "EDIT_COMMIT") {
        // One EDIT_COMMIT attempt per operation, ever (RECOMMIT_SAME_CALC).
        kindGuards.push(Prisma.sql`AND NOT EXISTS (
          SELECT 1 FROM "MergeMutationAttempt" a
          WHERE a."operationId" = ${op.id} AND a."kind" = 'EDIT_COMMIT')`);
      } else if (kind === "ORDER_CANCEL") {
        // At most one in-doubt cancel per secondary; bounded rejected retries.
        kindGuards.push(Prisma.sql`AND NOT EXISTS (
          SELECT 1 FROM "MergeMutationAttempt" a
          WHERE a."operationId" = ${op.id} AND a."kind" = 'ORDER_CANCEL'
            AND a."targetOrderId" = ${targetOrderId}
            AND a."state" IN ('DISPATCHING', 'UNKNOWN', 'SUCCEEDED'))`);
        kindGuards.push(Prisma.sql`AND (
          SELECT count(*) FROM "MergeMutationAttempt" a
          WHERE a."operationId" = ${op.id} AND a."kind" = 'ORDER_CANCEL'
            AND a."targetOrderId" = ${targetOrderId} AND a."state" = 'REJECTED') < 3`);
      } else {
        // Side-effect kinds: at most 3 attempts per (op, kind, order).
        kindGuards.push(Prisma.sql`AND (
          SELECT count(*) FROM "MergeMutationAttempt" a
          WHERE a."operationId" = ${op.id} AND a."kind" = ${kind}
            AND a."targetOrderId" = ${targetOrderId}) < 3`);
      }

      return withOwnershipTx(db, async (tx) => {
        // The gate: phase flip + throttle happen only while we provably own
        // the op (with margin), in the required phase, with the switch on.
        const updated = await tx.$executeRaw`
          UPDATE "MergeOperation"
          SET "phase" = CASE WHEN ${kind} = 'EDIT_COMMIT' THEN 'COMMIT_IN_DOUBT' ELSE "phase" END,
              "firstDispatchAt" = COALESCE("firstDispatchAt",
                CASE WHEN ${kind} = 'EDIT_COMMIT' THEN ${DB_WALL} END),
              "nextCheckAt" = ${DB_WALL} + interval '30 seconds',
              "status" = 'NEEDS_REVIEW',
              "updatedAt" = ${DB_WALL}
          WHERE "id" = ${op.id} AND "leaseToken" = ${op.leaseToken}
            AND "leasedUntil" > ${DB_WALL} + interval '30 seconds'
            AND "phase" = ${requiredPhase}
            AND EXISTS (
              SELECT 1 FROM "AppControl" c
              WHERE c.id = 'control' AND c."${Prisma.raw(switchColumn)}"
                AND (cardinality(c."allowShops") = 0 OR ${op.shop} = ANY(c."allowShops")))
            ${Prisma.join(kindGuards, " ")}`;
        if (updated !== 1) return null;

        const rows = await tx.$queryRaw<MutationAttempt[]>`
          INSERT INTO "MergeMutationAttempt" (
            "id", "operationId", "kind", "targetOrderId", "attemptNo",
            "state", "dispatchToken", "dispatchedAt"
          ) VALUES (
            ${crypto.randomUUID()}, ${op.id}, ${kind}, ${targetOrderId},
            (SELECT COALESCE(MAX("attemptNo"), 0) + 1 FROM "MergeMutationAttempt"
             WHERE "operationId" = ${op.id} AND "kind" = ${kind}
               AND "targetOrderId" = ${targetOrderId}),
            'DISPATCHING', ${dispatchToken}, ${DB_WALL}
          )
          RETURNING *`;
        return rows[0];
      });
    },

    async recordAttempt(attemptId, dispatchToken, state, summary, jobId) {
      const updated = await db.$executeRaw`
        UPDATE "MergeMutationAttempt"
        SET "state" = ${state}, "respondedAt" = ${DB_WALL},
            "responseSummary" = ${summary},
            "jobId" = COALESCE(${jobId ?? null}, "jobId")
        WHERE "id" = ${attemptId} AND "state" = 'DISPATCHING'
          AND "dispatchToken" = ${dispatchToken}`;
      return updated === 1;
    },

    async listAttempts(opId, kind, targetOrderId) {
      return db.$queryRaw<MutationAttempt[]>`
        SELECT * FROM "MergeMutationAttempt"
        WHERE "operationId" = ${opId}
          ${kind ? Prisma.sql`AND "kind" = ${kind}` : Prisma.empty}
          ${targetOrderId ? Prisma.sql`AND "targetOrderId" = ${targetOrderId}` : Prisma.empty}
        ORDER BY "attemptNo"`;
    },

    async recordHistoryAndVerifyCancel(op, secondaryId, evidence) {
      const secondaries = (op.secondaries as OperationSecondary[]).map((s) =>
        s.id === secondaryId
          ? { ...s, cancelPhase: "CANCEL_VERIFIED" as const, cancelledAt: evidence.cancelledAt, staffNoteMatched: true, done: true }
          : s,
      );
      const secondary = secondaries.find((s) => s.id === secondaryId);
      await withOwnershipTx(db, async (tx) => {
        const updated = await tx.$executeRaw`
          UPDATE "MergeOperation"
          SET "secondaries" = ${JSON.stringify(secondaries)}::jsonb, "updatedAt" = ${DB_WALL}
          WHERE "id" = ${op.id} AND "leaseToken" = ${op.leaseToken}
            AND "leasedUntil" > ${DB_WALL} AND "phase" = 'APPLIED'`;
        if (updated === 0) {
          throw new OwnershipLostError(`Merge operation ${op.id} is owned by another worker.`);
        }
        await tx.$executeRaw`
          INSERT INTO "MergeRecord" (
            "id", "shop", "primaryOrderId", "primaryOrderName", "mergedOrderId",
            "mergedOrderName", "customerId", "itemsCombined", "operationId", "createdAt"
          ) VALUES (
            ${crypto.randomUUID()}, ${op.shop}, ${op.primaryOrderId}, ${op.primaryOrderName},
            ${secondaryId}, ${secondary?.name ?? secondaryId}, ${op.customerId},
            ${secondary?.items ?? 0}, ${op.id}, ${DB_WALL}
          )
          ON CONFLICT ("shop", "mergedOrderId") DO NOTHING`;
      });
    },

    async findLockedOrderIds(shop, ids) {
      if (!ids.length) return new Set();
      const rows = await db.$queryRaw<{ orderId: string }[]>`
        SELECT "orderId" FROM "MergeOrderLock"
        WHERE "shop" = ${shop} AND "orderId" = ANY(${ids})`;
      return new Set(rows.map((r) => r.orderId));
    },

    async findBlockingV1(shop, ids) {
      if (!ids.length) return new Set();
      const rows = await db.$queryRaw<{ involvedOrderIds: string[] }[]>`
        SELECT "involvedOrderIds" FROM "MergeOperation"
        WHERE "shop" = ${shop} AND "protocolVersion" = 1
          AND "status" = ANY(${V1_BLOCKING}) AND "involvedOrderIds" && ${ids}`;
      return new Set(rows.flatMap((r) => r.involvedOrderIds).filter((id) => ids.includes(id)));
    },

    async getControl() {
      const rows = await db.$queryRaw<ControlRow[]>`
        SELECT * FROM "AppControl" WHERE id = 'control'`;
      return rows[0] ?? null;
    },

    async setControl(patch) {
      const sets: Prisma.Sql[] = [];
      if (patch.newMergesEnabled !== undefined)
        sets.push(Prisma.sql`"newMergesEnabled" = ${patch.newMergesEnabled}`);
      if (patch.completionEnabled !== undefined)
        sets.push(Prisma.sql`"completionEnabled" = ${patch.completionEnabled}`);
      if (patch.allowShops !== undefined) sets.push(Prisma.sql`"allowShops" = ${patch.allowShops}`);
      if (patch.note !== undefined) sets.push(Prisma.sql`"note" = ${patch.note}`);
      if (!sets.length) return;
      sets.push(Prisma.sql`"updatedAt" = ${DB_WALL}`);
      await db.$executeRaw`UPDATE "AppControl" SET ${Prisma.join(sets)} WHERE id = 'control'`;
    },

    async isEnabled(shop, sw) {
      const rows = await db.$queryRaw<any[]>`
        SELECT ${Prisma.raw(`"${sw}"`)} AS enabled, "allowShops"
        FROM "AppControl" WHERE id = 'control'`;
      const row = rows[0];
      if (!row?.enabled) return false;
      return row.allowShops.length === 0 || row.allowShops.includes(shop);
    },

    async heartbeat(instanceId, deploymentId, version) {
      await db.$executeRaw`
        INSERT INTO "WorkerInstance"
          ("instanceId", "railwayDeploymentId", "startedAt", "heartbeatAt", "version")
        VALUES (${instanceId}, ${deploymentId}, ${DB_WALL}, ${DB_WALL}, ${version})
        ON CONFLICT ("instanceId") DO UPDATE
          SET "heartbeatAt" = ${DB_WALL},
              "railwayDeploymentId" = ${deploymentId},
              "version" = ${version}`;
    },

    async listRecentInstances() {
      return db.$queryRaw<any[]>`
        SELECT * FROM "WorkerInstance" ORDER BY "heartbeatAt" DESC`;
    },

    async purgeOldInstances(olderThanMs) {
      return db.$executeRaw`
        DELETE FROM "WorkerInstance" WHERE "heartbeatAt" < ${dbWallPlus(-olderThanMs)}`;
    },
  };
}

export const prismaOperationStore: OperationStore = makeOperationStore(defaultDb);
