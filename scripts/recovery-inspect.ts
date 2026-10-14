/**
 * READ-ONLY Recovery v0 operator inspection.
 * Usage: npx vite-node scripts/recovery-inspect.ts --operation <MergeOperation.id>
 * Output is a diagnostic report, NOT a command to undo, refund or reconstruct.
 * Avoid pasting raw output containing order identifiers into public issues.
 */
import "./require-database-url";
import db from "../app/db.server";
import { assessRecoveryEvidence } from "../app/lib/recovery-diagnostic";

const args = process.argv.slice(2);
const usage = () => {
  console.error("usage: npx vite-node scripts/recovery-inspect.ts --operation <id>");
  process.exit(2);
};
if (args.length !== 2 || args[0] !== "--operation" || !args[1]?.trim()) usage();
const operationId = args[1];
const op = await db.mergeOperation.findUnique({ where: { id: operationId } });
if (!op) {
  console.error(`No MergeOperation found for ID ${operationId}`);
  process.exit(1);
}
const [attempts, locks, records, workItems] = await Promise.all([
  db.mergeMutationAttempt.findMany({ where: { operationId }, orderBy: [{ dispatchedAt: "asc" }, { attemptNo: "asc" }] }),
  db.mergeOrderLock.findMany({ where: { operationId } }),
  db.mergeRecord.findMany({ where: { operationId } }),
  db.processedWebhook.findMany({ where: { operationId } }),
]);

const secondaries = Array.isArray(op.secondaries) ? op.secondaries : [];
const expected = Array.isArray(op.expectedTransfer) ? op.expectedTransfer : null;
const applied = op.appliedEvidence && typeof op.appliedEvidence === "object" ? op.appliedEvidence : null;

const assessment = assessRecoveryEvidence({
  operation: {
    id: op.id,
    protocolVersion: op.protocolVersion,
    phase: op.phase,
    primaryOrderId: op.primaryOrderId,
    secondaries: op.secondaries,
    expectedTransfer: op.expectedTransfer,
    appliedEvidence: op.appliedEvidence,
  },
  mutationAttempts: attempts.map(a => ({ kind: a.kind, targetOrderId: a.targetOrderId, state: a.state })),
  mergeRecords: records.map(r => ({ primaryOrderId: r.primaryOrderId, mergedOrderId: r.mergedOrderId })),
  durableLocks: locks.map(l => ({ orderId: l.orderId })),
});

console.log(JSON.stringify({
  assessment,
  classification: "READ_ONLY_DIAGNOSTIC_NOT_UNDO",
  generatedAt: new Date().toISOString(),
  operation: {
    id: op.id,
    shop: op.shop,
    protocolVersion: op.protocolVersion,
    phase: op.phase,
    status: op.status,
    primaryOrderId: op.primaryOrderId,
    primaryOrderName: op.primaryOrderName,
    secondaryOrders: secondaries,
    involvedOrderIds: op.involvedOrderIds,
    reviewReason: op.reviewReason,
    sideEffectsDone: op.sideEffectsDone,
    opToken: op.opToken,
    expectedLocationId: op.expectedLocationId,
    primaryLineItemIdsBefore: op.primaryLineItemIdsBefore,
    expectedTransfer: expected,
    appliedEvidence: applied,
    createdAt: op.createdAt,
    updatedAt: op.updatedAt,
  },
  mutationAttempts: attempts.map(a => ({
    id: a.id, kind: a.kind, targetOrderId: a.targetOrderId,
    attemptNo: a.attemptNo, state: a.state, dispatchedAt: a.dispatchedAt,
    respondedAt: a.respondedAt, responseSummary: a.responseSummary, jobId: a.jobId,
  })),
  durableLocks: locks.map(l => ({ orderId: l.orderId, operationId: l.operationId })),
  mergeRecords: records.map(r => ({
    id: r.id, primaryOrderId: r.primaryOrderId, mergedOrderId: r.mergedOrderId, itemsCombined: r.itemsCombined,
  })),
  workItems: workItems.map(w => ({
    orderId: w.orderId, status: w.status, outcome: w.outcome, reviewReason: w.reviewReason,
  })),
  warnings: [
    "Shopify current state MUST be inspected separately before corrective action.",
    "The cancelled source order cannot be uncancelled; replacement/draft order is a hypothesis, not an automatic step.",
    "Refunds, fulfillment, inventory, shipping and reporting require separate reconciliation.",
    "This tool performs NO Shopify requests and NO mutations.",
  ],
}, null, 2));

await db.$disconnect();
