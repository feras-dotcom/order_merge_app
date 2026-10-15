/**
 * Shipping v0 shadow evaluator — merge-evidence assessment. Pure, no I/O.
 *
 * Decides whether ONE secondary of a COMPLETED native Protocol v2 combine is
 * proven well enough that a shadow shipping evaluation may be recorded for
 * it. This is deliberately stricter than "the op says COMPLETED": every piece
 * of evidence the protocol itself wrote is re-checked, because a shadow
 * intent is the eventual write-ahead record for real money.
 *
 * Required evidence (all of it, fail-closed):
 *   - native v2 operation (protocolVersion 2 AND calculatedOrderId set —
 *     legacy-converted ops are out of v0 scope) in phase COMPLETED;
 *   - the secondary's own cancellation verdict: CANCEL_VERIFIED with the
 *     recorded cancelledAt and the op-specific staff-note match;
 *   - a durable MergeRecord linking THIS secondary to THIS op's primary
 *     (unique by (shop, mergedOrderId), so it can only be one merge);
 *   - the frozen transfer manifest (expectedTransfer) and the applied
 *     evidence both naming this secondary;
 *   - a potentially-dispatched EDIT_COMMIT attempt and a non-REJECTED
 *     ORDER_CANCEL attempt for this secondary (the same provenance rule
 *     the cancellation protocol itself uses);
 *   - the opToken the staff-note provenance is bound to.
 *
 * A COMPLETED op failing ANY of these is a contradiction — the caller turns
 * the issue list into a REVIEW_REQUIRED intent, never silently skips.
 */
export interface ShadowSecondaryEvidence {
  operation: {
    id: string;
    protocolVersion: number;
    phase: string | null;
    calculatedOrderId: string | null;
    opToken: string | null;
    primaryOrderId: string;
    /** expectedTransfer entries (JSON): [{ secondaryId, lines }] */
    expectedTransfer: unknown;
    /** appliedEvidence (JSON): { lines: [{ secondaryId, ... }] } */
    appliedEvidence: unknown;
  };
  secondary: {
    id: string;
    cancelPhase?: string;
    done?: boolean;
    cancelledAt?: string | null;
    staffNoteMatched?: boolean;
  };
  mergeRecords: Array<{
    mergedOrderId: string;
    primaryOrderId: string;
    operationId: string | null;
  }>;
  /** All MergeMutationAttempt rows for the operation. */
  attempts: Array<{ kind: string; targetOrderId: string; state: string }>;
}

export function assessSecondaryEvidence(
  input: ShadowSecondaryEvidence,
): { eligible: true } | { eligible: false; issues: string[] } {
  const issues: string[] = [];
  const { operation: op, secondary: s } = input;

  // Native v2 only: protocolVersion 2 rows created by the journal carry
  // calculatedOrderId; converted legacy ops (null) never qualify for v0.
  if (op.protocolVersion !== 2 || op.calculatedOrderId == null) {
    issues.push("Combine is not a native Protocol v2 operation.");
  }
  if (op.phase !== "COMPLETED") {
    issues.push(`Merge operation is not COMPLETED (phase ${op.phase ?? "unknown"}).`);
  }
  if (typeof op.opToken !== "string" || !op.opToken) {
    issues.push("Operation token missing; cancellation provenance cannot be re-checked.");
  }

  if (s.cancelPhase !== "CANCEL_VERIFIED" || s.done !== true) {
    issues.push(`Secondary cancellation is not verified (cancelPhase ${s.cancelPhase ?? "unknown"}).`);
  }
  if (typeof s.cancelledAt !== "string" || !s.cancelledAt) {
    issues.push("Verified cancellation timestamp missing from the secondary record.");
  }
  if (s.staffNoteMatched !== true) {
    issues.push("MergeShip staff-note provenance for the cancellation was not recorded.");
  }

  if (
    !input.mergeRecords.some(
      (r) =>
        r.mergedOrderId === s.id &&
        r.primaryOrderId === op.primaryOrderId &&
        r.operationId === op.id,
    )
  ) {
    issues.push("No MergeRecord links this secondary to the operation's primary.");
  }

  const expected = Array.isArray(op.expectedTransfer) ? op.expectedTransfer : [];
  const expectedEntry = expected.find(
    (e: any) => e && e.secondaryId === s.id && Array.isArray(e.lines) && e.lines.length > 0,
  );
  if (!expectedEntry) {
    issues.push("Frozen transfer manifest has no lines for this secondary.");
  }

  const applied = op.appliedEvidence;
  const appliedLines =
    applied && typeof applied === "object" && Array.isArray((applied as any).lines)
      ? ((applied as any).lines as any[])
      : [];
  if (!appliedLines.some((l) => l && l.secondaryId === s.id)) {
    issues.push("Applied transfer evidence has no lines for this secondary.");
  }

  const a = input.attempts;
  if (!a.some((x) => x.kind === "EDIT_COMMIT" && x.state !== "REJECTED")) {
    issues.push("No potentially dispatched order-edit commit attempt recorded.");
  }
  if (!a.some((x) => x.kind === "ORDER_CANCEL" && x.targetOrderId === s.id && x.state !== "REJECTED")) {
    issues.push("No potentially dispatched cancellation attempt for this secondary.");
  }

  return issues.length ? { eligible: false, issues } : { eligible: true };
}
