import { describe, expect, it } from "vitest";
import { assessRecoveryEvidence, type RecoverySnapshot } from "../app/lib/recovery-diagnostic";
const snapshot = (): RecoverySnapshot => ({
  operation: {
    id: "op1", protocolVersion: 2, phase: "COMPLETED", primaryOrderId: "primary",
    secondaries: [{ id: "source", cancelPhase: "CANCEL_VERIFIED" }],
    expectedTransfer: [{ secondaryId: "source", lines: [{}] }],
    appliedEvidence: { agreementId: "agreement" },
  },
  mutationAttempts: [
    { kind: "EDIT_COMMIT", targetOrderId: "primary", state: "SUCCEEDED" },
    { kind: "ORDER_CANCEL", targetOrderId: "source", state: "SUCCEEDED" },
  ],
  mergeRecords: [{ primaryOrderId: "primary", mergedOrderId: "source" }],
  durableLocks: [],
});
describe("Recovery v0 evidence diagnosis", () => {
  it("never authorizes automated undo even with all evidence", () => {
    expect(assessRecoveryEvidence(snapshot())).toEqual({
      status: "DIAGNOSTIC_EVIDENCE_PRESENT", issues: [], automaticRecoveryAuthorized: false,
    });
  });
  it("fails review if an operation has not completed", () => {
    const s = snapshot(); s.operation.phase = "REVIEW_REQUIRED";
    expect(assessRecoveryEvidence(s).status).toBe("INCOMPLETE_REQUIRES_REVIEW");
  });
  it("fails review for an unverified cancellation", () => {
    const s = snapshot(); s.operation.secondaries = [{ id: "source", cancelPhase: "CANCEL_IN_DOUBT" }];
    expect(assessRecoveryEvidence(s).status).toBe("INCOMPLETE_REQUIRES_REVIEW");
  });
  it("fails review with missing proof or history", () => {
    const s = snapshot(); s.operation.appliedEvidence = null; s.mergeRecords = [];
    expect(assessRecoveryEvidence(s).issues.length).toBeGreaterThan(0);
  });
  it("fails review while durable locks remain", () => {
    const s = snapshot(); s.durableLocks = [{ orderId: "source" }];
    expect(assessRecoveryEvidence(s).status).toBe("INCOMPLETE_REQUIRES_REVIEW");
  });
});
