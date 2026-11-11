// Pure unit tests for approvalGateClosure (§4.4 approval-validity gate
// closure used by preparedCapacityPrecheck): a non-null detail exactly
// when the live approval state guarantees T3's gate recheck aborts
// GATE_CHANGED — missing, revoked, restamped or re-scoped approval, or a
// Settings opt-in epoch the approval no longer matches. The export is
// read through the module namespace so this file still loads — and its
// assertions still fail — against a baseline built without the export
// (the negative-control runs of the missing-approval fix).
import { describe, expect, it } from "vitest";
import * as dispatchModule from "../app/lib/shipping-refund-dispatch.server";

type GateRow = {
  approvedAt: Date;
  revokedAt: Date | null;
  merchantOptInEpoch: Date;
  ackVersion: string;
  dailyCap: number;
  currencyCode: string;
  maxRefundMinor: string;
  autoApprove: boolean;
};
type Closure = (
  approval: GateRow | null | undefined,
  snapshot: {
    approvalApprovedAt: Date;
    approvalOptInEpoch: Date;
    approvalAckVersion: string;
  },
  settingsEpoch: Date | null | undefined,
) => string | null;

const approvalGateClosure = (
  dispatchModule as unknown as { approvalGateClosure?: Closure }
).approvalGateClosure;

const E1 = new Date("2030-01-01T00:00:00Z"); // merchant opt-in epoch
const E5 = new Date("2030-01-05T00:00:00Z"); // approval approvedAt
const E6 = new Date("2030-01-06T00:00:00Z"); // a later stamp

const baseApproval = (): GateRow => ({
  approvedAt: new Date(E5.getTime()),
  revokedAt: null,
  merchantOptInEpoch: new Date(E1.getTime()),
  ackVersion: "v1",
  dailyCap: 1_000_000,
  currencyCode: "USD",
  maxRefundMinor: "10000",
  autoApprove: true,
});
const snapshot = {
  approvalApprovedAt: new Date(E5.getTime()),
  approvalOptInEpoch: new Date(E1.getTime()),
  approvalAckVersion: "v1",
};

describe("approvalGateClosure (pure)", () => {
  it("is exported as a function", () => {
    expect(typeof approvalGateClosure).toBe("function");
  });

  it("returns null for a valid approval matching the snapshot and the Settings epoch", () => {
    expect(approvalGateClosure!(baseApproval(), snapshot, new Date(E1.getTime()))).toBeNull();
    // Same instants, distinct Date objects — compared by getTime().
    expect(
      approvalGateClosure!(
        { ...baseApproval(), approvedAt: new Date(E5.getTime()) },
        {
          approvalApprovedAt: new Date(E5.getTime()),
          approvalOptInEpoch: new Date(E1.getTime()),
          approvalAckVersion: "v1",
        },
        new Date(E1.getTime()),
      ),
    ).toBeNull();
  });

  it("returns null for cap-only differences (dailyCap, currency, maxRefundMinor, autoApprove)", () => {
    expect(
      approvalGateClosure!(
        {
          ...baseApproval(),
          dailyCap: 0,
          currencyCode: "EUR",
          maxRefundMinor: "0",
          autoApprove: false,
        },
        snapshot,
        E1,
      ),
    ).toBeNull();
  });

  it.each([null, undefined])("a %s approval row is a closure naming 'approval'", (ap) => {
    const detail = approvalGateClosure!(ap, snapshot, E1);
    expect(detail).toEqual(expect.stringContaining("approval"));
  });

  it("a revoked approval is a closure naming 'approval'", () => {
    const detail = approvalGateClosure!(
      { ...baseApproval(), revokedAt: E6 },
      snapshot,
      E1,
    );
    expect(detail).toEqual(expect.stringContaining("approval"));
    expect(detail).toEqual(expect.stringContaining("revoked"));
  });

  it("a restamped approval (new approvedAt) is a closure", () => {
    const detail = approvalGateClosure!(
      { ...baseApproval(), approvedAt: E6 },
      snapshot,
      E1,
    );
    expect(detail).toEqual(expect.stringContaining("approval"));
  });

  it("a merchantOptInEpoch differing from the snapshot is a closure", () => {
    const detail = approvalGateClosure!(
      { ...baseApproval(), merchantOptInEpoch: E6 },
      snapshot,
      E6,
    );
    expect(detail).toEqual(expect.stringContaining("approval"));
  });

  it("an ackVersion differing from the snapshot is a closure", () => {
    const detail = approvalGateClosure!(
      { ...baseApproval(), ackVersion: "v2" },
      snapshot,
      E1,
    );
    expect(detail).toEqual(expect.stringContaining("approval"));
  });

  it("an ackVersion equal to the snapshot but not REQUIRED_ACK_VERSION is a closure", () => {
    const detail = approvalGateClosure!(
      { ...baseApproval(), ackVersion: "v2" },
      { ...snapshot, approvalAckVersion: "v2" },
      E1,
    );
    expect(detail).toEqual(expect.stringContaining("approval"));
  });

  it.each([null, undefined])("a %s Settings opt-in epoch is a closure", (epoch) => {
    const detail = approvalGateClosure!(baseApproval(), snapshot, epoch);
    expect(detail).toEqual(expect.stringContaining("approval"));
  });

  it("a Settings epoch the approval no longer matches is a closure", () => {
    const detail = approvalGateClosure!(baseApproval(), snapshot, E6);
    expect(detail).toEqual(expect.stringContaining("approval"));
  });

  it("every returned detail contains 'approval' and stays under the 2000-char reviewReason bound", () => {
    const cases: [GateRow | null | undefined, typeof snapshot, Date | null | undefined][] = [
      [null, snapshot, E1],
      [{ ...baseApproval(), revokedAt: E6 }, snapshot, E1],
      [{ ...baseApproval(), approvedAt: E6 }, snapshot, E1],
      [{ ...baseApproval(), merchantOptInEpoch: E6 }, snapshot, E1],
      [{ ...baseApproval(), ackVersion: "v2" }, snapshot, E1],
      [{ ...baseApproval(), ackVersion: "v2" }, { ...snapshot, approvalAckVersion: "v2" }, E1],
      [baseApproval(), snapshot, null],
      [baseApproval(), snapshot, E6],
    ];
    for (const [ap, snap, epoch] of cases) {
      const detail = approvalGateClosure!(ap, snap, epoch);
      expect(detail).not.toBeNull();
      expect(detail).toEqual(expect.stringContaining("approval"));
      expect(detail!.length).toBeLessThanOrEqual(2000);
    }
  });
});
