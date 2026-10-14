/** Read-only evidence audit; never represents an undo authorization. */
export interface RecoverySnapshot {
  operation: {
    id: string;
    protocolVersion: number;
    phase: string | null;
    primaryOrderId: string;
    secondaries: unknown;
    expectedTransfer: unknown;
    appliedEvidence: unknown;
  };
  mutationAttempts: Array<{ kind: string; targetOrderId: string; state: string }>;
  mergeRecords: Array<{ primaryOrderId: string; mergedOrderId: string }>;
  durableLocks: Array<{ orderId: string }>;
}
export interface RecoveryAssessment {
  status: "DIAGNOSTIC_EVIDENCE_PRESENT" | "INCOMPLETE_REQUIRES_REVIEW";
  issues: string[];
  /** Explicitly never elevated by this function. */
  automaticRecoveryAuthorized: false;
}

export function assessRecoveryEvidence(s: RecoverySnapshot): RecoveryAssessment {
  const issues: string[] = [];
  const op = s.operation;
  const secondaries = Array.isArray(op.secondaries) ? op.secondaries as Array<Record<string, unknown>> : [];
  if (op.protocolVersion !== 2) issues.push("Operation is not native Protocol v2; use the legacy recovery procedure.");
  if (op.phase !== "COMPLETED") issues.push(`Merge is not completed (phase ${op.phase ?? "unknown"}); do not modify involved orders.`);
  if (!secondaries.length) issues.push("No secondary orders recorded.");
  if (!Array.isArray(op.expectedTransfer) || !op.expectedTransfer.length) issues.push("Frozen transfer manifest missing.");
  if (!op.appliedEvidence || typeof op.appliedEvidence !== "object") issues.push("Applied transfer proof missing.");
  if (!s.mutationAttempts.some(a => a.kind === "EDIT_COMMIT" && a.state !== "REJECTED")) {
    issues.push("No potentially dispatched order-edit commit attempt recorded.");
  }
  if (s.durableLocks.length) issues.push("Durable locks remain. Human review required before any recovery action.");
  const seen = new Set<string>();
  for (const raw of secondaries) {
    const id = raw?.id;
    if (typeof id !== "string" || !id || seen.has(id)) {
      issues.push("A secondary identifier is missing or duplicated.");
      continue;
    }
    seen.add(id);
    if (raw.cancelPhase !== "CANCEL_VERIFIED") issues.push(`Secondary ${id} cancellation is not verified.`);
    if (!s.mergeRecords.some(r => r.mergedOrderId === id && r.primaryOrderId === op.primaryOrderId)) {
      issues.push(`No MergeRecord links secondary ${id} to primary ${op.primaryOrderId}.`);
    }
    if (!s.mutationAttempts.some(a => a.kind === "ORDER_CANCEL" && a.targetOrderId === id && a.state !== "REJECTED")) {
      issues.push(`No potentially dispatched cancellation attempt for ${id}.`);
    }
  }
  return {
    status: issues.length ? "INCOMPLETE_REQUIRES_REVIEW" : "DIAGNOSTIC_EVIDENCE_PRESENT",
    issues,
    automaticRecoveryAuthorized: false,
  };
}
