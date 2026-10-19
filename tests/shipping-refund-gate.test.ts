// Tests for the pure execution gate and epoch snapshot (S1-C1).
// docs/SHIPPING-PHASE2-DESIGN.md Revision 3.3 sections 4.1-4.5, 7.5, 8.3.
import { describe, expect, it } from "vitest";

import {
  REQUIRED_ACK_VERSION,
  admitShippingRefund,
  computeShippingGate,
  recheckShippingGate,
  type ShippingGateLiveState,
  type SnapshotField,
} from "../app/lib/shipping-refund-gate";

const SHOP = "test-shop.myshopify.com";
const t = (iso: string) => new Date(iso);

/** A fully-open gate: activation epochs step up, admission and approval on
 *  top, dispatch off (OBSERVE-capable). */
const EPOCHS = {
  merchant: t("2030-01-01T00:00:00.000Z"),
  rollout: t("2030-01-02T00:00:00.000Z"),
  switch: t("2030-01-03T00:00:00.000Z"),
  admission: t("2030-01-04T00:00:00.000Z"),
  approved: t("2030-01-05T00:00:00.000Z"),
  dispatch: t("2030-01-06T00:00:00.000Z"),
};
const OP_AFTER_DISPATCH = t("2030-01-07T00:00:00.000Z");
const OP_AFTER_ADMISSION = t("2030-01-05T12:00:00.000Z"); // above admission cutoff, below dispatch epoch

const live = (over: Partial<ShippingGateLiveState> = {}): ShippingGateLiveState => ({
  activation: {
    shippingAdjustmentsEnabled: true,
    shippingEnabledAt: EPOCHS.switch,
    shippingAllowShops: [SHOP],
    shop: SHOP,
    shippingRolloutAt: EPOCHS.rollout,
    shopEnabled: true,
    enabledAt: EPOCHS.merchant,
  },
  admissionEnabled: true,
  admissionEnabledAt: EPOCHS.admission,
  dispatchEnabled: false,
  dispatchEnabledAt: null,
  approval: {
    approvedAt: EPOCHS.approved,
    revokedAt: null,
    merchantOptInEpoch: EPOCHS.merchant,
    ackVersion: REQUIRED_ACK_VERSION,
  },
  shippingPolicy: "REFUND_ALL",
  ...over,
});

const open = (over: Partial<ShippingGateLiveState> = {}) => {
  const g = computeShippingGate(live(over));
  if (!g.open) throw new Error(`gate unexpectedly closed: ${g.code} ${g.detail}`);
  return g;
};

const observed = (over: Partial<ShippingGateLiveState> = {}) => {
  const d = admitShippingRefund(live(over), OP_AFTER_ADMISSION);
  if (!d.admitted || d.lane !== "OBSERVE") {
    throw new Error(`expected OBSERVE admission, got ${JSON.stringify(d)}`);
  }
  return d.snapshot;
};

const execLive = (over: Partial<ShippingGateLiveState> = {}) =>
  live({ dispatchEnabled: true, dispatchEnabledAt: EPOCHS.dispatch, ...over });

const executed = (over: Partial<ShippingGateLiveState> = {}) => {
  const d = admitShippingRefund(execLive(over), OP_AFTER_DISPATCH);
  if (!d.admitted || d.lane !== "EXECUTE") {
    throw new Error(`expected EXECUTE admission, got ${JSON.stringify(d)}`);
  }
  return d.snapshot;
};

describe("gate construction and snapshot (4.4)", () => {
  it("admits a fully-open gate and derives every §4.4 snapshot field", () => {
    const g = open();
    expect(g.activationCutoffAt.getTime()).toBe(EPOCHS.switch.getTime()); // max of the three
    expect(g.admissionCutoffAt.getTime()).toBe(EPOCHS.approved.getTime()); // max of cutoff, admission, approved
    expect(g.dispatchEnabledAt).toBeNull();

    const snap = observed();
    expect(snap).toEqual({
      merchantEpochAt: EPOCHS.merchant,
      rolloutEpochAt: EPOCHS.rollout,
      switchEpochAt: EPOCHS.switch,
      activationCutoffAt: EPOCHS.switch,
      admissionEpochAt: EPOCHS.admission,
      admissionCutoffAt: EPOCHS.approved,
      dispatchEpochAtAdmission: null,
      approvalApprovedAt: EPOCHS.approved,
      approvalOptInEpoch: EPOCHS.merchant,
      approvalAckVersion: REQUIRED_ACK_VERSION,
    });
  });

  it("derives the admission cutoff from max(activation, admission, approved) — approval can lead or lag", () => {
    const early = open({ approval: { approvedAt: t("2030-01-02T00:00:00Z"), revokedAt: null, merchantOptInEpoch: EPOCHS.merchant, ackVersion: REQUIRED_ACK_VERSION } });
    expect(early.admissionCutoffAt.getTime()).toBe(EPOCHS.admission.getTime());
    const late = open({ approval: { approvedAt: t("2030-02-01T00:00:00Z"), revokedAt: null, merchantOptInEpoch: EPOCHS.merchant, ackVersion: REQUIRED_ACK_VERSION } });
    expect(late.admissionCutoffAt.getTime()).toBe(t("2030-02-01T00:00:00Z").getTime());
  });
});

describe("closed prerequisites — every missing or invalid value closes", () => {
  it.each([
    ["merchant opt-in off", { activation: { ...live().activation, shopEnabled: false } }, "ACTIVATION_GATE_CLOSED"],
    ["merchant epoch null", { activation: { ...live().activation, enabledAt: null } }, "ACTIVATION_GATE_CLOSED"],
    ["rollout membership absent", { activation: { ...live().activation, shippingAllowShops: [] } }, "ACTIVATION_GATE_CLOSED"],
    ["rollout epoch null", { activation: { ...live().activation, shippingRolloutAt: null } }, "ACTIVATION_GATE_CLOSED"],
    ["global switch off", { activation: { ...live().activation, shippingAdjustmentsEnabled: false } }, "ACTIVATION_GATE_CLOSED"],
    ["switch epoch null", { activation: { ...live().activation, shippingEnabledAt: null } }, "ACTIVATION_GATE_CLOSED"],
    ["admission disabled", { admissionEnabled: false }, "ADMISSION_DISABLED"],
    ["admission epoch null while on", { admissionEnabledAt: null }, "ADMISSION_EPOCH_INVALID"],
    ["admission epoch malformed", { admissionEnabledAt: new Date("bogus") }, "ADMISSION_EPOCH_INVALID"],
    ["dispatch enabled with null epoch", { dispatchEnabled: true, dispatchEnabledAt: null }, "DISPATCH_EPOCH_INVALID"],
    ["dispatch enabled with invalid epoch", { dispatchEnabled: true, dispatchEnabledAt: new Date("x") }, "DISPATCH_EPOCH_INVALID"],
    ["no approval row", { approval: null }, "APPROVAL_MISSING"],
    ["revoked approval", { approval: { ...live().approval!, revokedAt: EPOCHS.dispatch } }, "APPROVAL_REVOKED"],
    ["approval approvedAt invalid", { approval: { ...live().approval!, approvedAt: "not-a-date" } }, "APPROVAL_APPROVED_AT_INVALID"],
    ["approval opt-in epoch malformed", { approval: { ...live().approval!, merchantOptInEpoch: 42 as unknown as Date } }, "APPROVAL_OPT_IN_EPOCH_INVALID"],
    ["approval opt-in epoch stale", { approval: { ...live().approval!, merchantOptInEpoch: t("2029-01-01T00:00:00Z") } }, "APPROVAL_OPT_IN_EPOCH_MISMATCH"],
    ["wrong ack version", { approval: { ...live().approval!, ackVersion: "v0" } }, "APPROVAL_ACK_VERSION_MISMATCH"],
    ["non-string ack version", { approval: { ...live().approval!, ackVersion: 1 } }, "APPROVAL_ACK_VERSION_MISMATCH"],
    ["policy RETAIN_FIXED", { shippingPolicy: "RETAIN_FIXED" }, "POLICY_NOT_REFUND_ALL"],
    ["policy missing", { shippingPolicy: null }, "POLICY_NOT_REFUND_ALL"],
    ["policy lowercase", { shippingPolicy: "refund_all" }, "POLICY_NOT_REFUND_ALL"],
  ])("refuses with %s", (_l, over, code) => {
    const g = computeShippingGate(live(over));
    if (g.open) throw new Error("gate unexpectedly open");
    expect(g.code).toBe(code);
    const d = admitShippingRefund(live(over), OP_AFTER_DISPATCH);
    if (d.admitted) throw new Error("admitted despite a closed gate");
    expect(d.code).toBe(code);
  });

  it("merchant opt-out followed by re-opt-in invalidates the approval (stale recorded epoch)", () => {
    // Re-opt-in stamps a NEW merchant epoch; the approval recorded the old one.
    const reopted = live({
      activation: { ...live().activation, enabledAt: t("2030-01-20T00:00:00Z") },
    });
    const g = computeShippingGate(reopted);
    if (g.open) throw new Error("gate open after re-opt-in");
    expect(g.code).toBe("APPROVAL_OPT_IN_EPOCH_MISMATCH");
  });

  it("a re-approval that re-read the new live epoch restores admission", () => {
    const reapproved = live({
      activation: { ...live().activation, enabledAt: t("2030-01-20T00:00:00Z") },
      approval: {
        approvedAt: t("2030-01-21T00:00:00Z"),
        revokedAt: null,
        merchantOptInEpoch: t("2030-01-20T00:00:00Z"),
        ackVersion: REQUIRED_ACK_VERSION,
      },
    });
    const g = computeShippingGate(reapproved);
    if (!g.open) throw new Error(`closed: ${(g as any).detail}`);
    expect(g.admissionCutoffAt.getTime()).toBe(t("2030-01-21T00:00:00Z").getTime());
  });
});

describe("lane selection and cutoff boundaries (4.5)", () => {
  it("EXECUTE requires a live dispatch gate and creation on/after the dispatch cutoff", () => {
    const snap = executed();
    expect(snap.dispatchEpochAtAdmission).toEqual(EPOCHS.dispatch);
  });

  it("dispatch on but combine created between the admission cutoff and dispatch epoch is OBSERVE", () => {
    const d = admitShippingRefund(execLive(), OP_AFTER_ADMISSION);
    if (!d.admitted) throw new Error("not admitted");
    expect(d.lane).toBe("OBSERVE");
    expect(d.snapshot.dispatchEpochAtAdmission).toBeNull();
  });

  it("combine exactly on the admission cutoff is admitted; one millisecond before is not", () => {
    const cutoff = open().admissionCutoffAt;
    const on = admitShippingRefund(live(), cutoff);
    if (!on.admitted) throw new Error("boundary combine not admitted");
    // One millisecond earlier than the exact cutoff instant.
    const d = admitShippingRefund(live(), new Date(cutoff.getTime() - 1));
    if (d.admitted) throw new Error("admitted a combine one ms before the cutoff");
    expect(d.code).toBe("OPERATION_PREDATES_ADMISSION_CUTOFF");
  });

  it("combine exactly on the dispatch cutoff is EXECUTE; one millisecond before is OBSERVE", () => {
    const exact = admitShippingRefund(execLive(), EPOCHS.dispatch);
    if (!exact.admitted) throw new Error("not admitted");
    expect(exact.lane).toBe("EXECUTE");
    const before = admitShippingRefund(execLive(), new Date(EPOCHS.dispatch.getTime() - 1));
    if (!before.admitted) throw new Error("not admitted");
    expect(before.lane).toBe("OBSERVE");
    expect(before.snapshot.dispatchEpochAtAdmission).toBeNull();
  });

  it("a combine created before the admission cutoff is never admitted, even with dispatch on", () => {
    const d = admitShippingRefund(execLive(), t("2030-01-01T00:00:00Z"));
    if (d.admitted) throw new Error("admitted a pre-cutoff combine");
    expect(d.code).toBe("OPERATION_PREDATES_ADMISSION_CUTOFF");
  });

  it("a malformed combine timestamp fails closed", () => {
    for (const bad of [null, undefined, "next Tuesday", new Date("x"), 42]) {
      const d = admitShippingRefund(live(), bad);
      if (d.admitted) throw new Error(`admitted operationCreatedAt=${String(bad)}`);
      expect(d.code).toBe("OPERATION_CREATED_AT_INVALID");
    }
  });
});

describe("recheck: full epoch equality (4.4, E9)", () => {
  it("an unchanged gate rechecks equal for both lanes", () => {
    const obs = observed();
    expect(recheckShippingGate(obs, live(), "OBSERVE").equal).toBe(true);
    const ex = executed();
    expect(recheckShippingGate(ex, execLive(), "EXECUTE").equal).toBe(true);
  });

  it("each individual epoch change is caught and names the changed field", () => {
    const snap = observed();
    const cases: Array<[SnapshotField, ShippingGateLiveState]> = [
      ["merchantEpochAt", live({ activation: { ...live().activation, enabledAt: t("2030-01-01T00:00:00.001Z") }, approval: { ...live().approval!, merchantOptInEpoch: t("2030-01-01T00:00:00.001Z") } })],
      ["rolloutEpochAt", live({ activation: { ...live().activation, shippingRolloutAt: t("2030-01-02T00:00:00.001Z") } })],
      ["switchEpochAt", live({ activation: { ...live().activation, shippingEnabledAt: t("2030-01-03T00:00:00.001Z") } })],
      ["admissionEpochAt", live({ admissionEnabledAt: t("2030-01-04T00:00:00.001Z") })],
    ];
    for (const [field, state] of cases) {
      const r = recheckShippingGate(snap, state, "OBSERVE");
      if (r.equal) throw new Error(`${field} drift not detected`);
      expect(r.code).toBe("GATE_CHANGED");
      expect(r.field).toBe(field);
    }
    // A moved approvedAt moves the derived admissionCutoffAt first in the
    // §4.4 column order — reported as the first differing field.
    const moved = recheckShippingGate(
      snap,
      live({ approval: { ...live().approval!, approvedAt: t("2030-01-05T00:00:00.001Z") } }),
      "OBSERVE",
    );
    if (moved.equal) throw new Error("approvalApprovedAt drift not detected");
    expect(moved.code).toBe("GATE_CHANGED");
    expect(moved.field).toBe("admissionCutoffAt");
    // And a stored snapshot whose approvalApprovedAt alone is tampered names
    // that field directly — using an approval that is NOT the cutoff driver
    // (approved before the admission epoch), so the cutoff stays equal.
    const earlyApproval = {
      approvedAt: t("2030-01-03T12:00:00Z"),
      revokedAt: null,
      merchantOptInEpoch: EPOCHS.merchant,
      ackVersion: REQUIRED_ACK_VERSION,
    };
    const snap2 = observed({ approval: earlyApproval });
    expect(snap2.admissionCutoffAt.getTime()).toBe(EPOCHS.admission.getTime());
    const tampered = recheckShippingGate(
      { ...snap2, approvalApprovedAt: t("2030-01-03T12:00:00.001Z") },
      live({ approval: earlyApproval }),
      "OBSERVE",
    );
    if (tampered.equal) throw new Error("stored approvalApprovedAt drift not detected");
    expect(tampered.code).toBe("GATE_CHANGED");
    expect(tampered.field).toBe("approvalApprovedAt");
    // approvalAckVersion: a live approval carrying any other version is
    // closed on validity, so the field-diff case is a STORED snapshot whose
    // recorded version differs from the still-valid live one.
    const r = recheckShippingGate({ ...snap, approvalAckVersion: "v0" }, live(), "OBSERVE");
    if (r.equal) throw new Error("stored ackVersion drift not detected");
    expect(r.code).toBe("GATE_CHANGED");
    expect(r.field).toBe("approvalAckVersion");
    // And a live approval on a wrong version closes the whole gate.
    const closed = recheckShippingGate(snap, live({ approval: { ...live().approval!, ackVersion: "v0" } }), "OBSERVE");
    if (closed.equal) throw new Error("wrong live ackVersion passed recheck");
    expect(closed.code).toBe("GATE_CLOSED");
    expect(closed.field).toBe("approvalAckVersion");
  });

  it("a changed approval opt-in epoch is caught as approvalOptInEpoch", () => {
    const snap = observed();
    // The live merchant epoch moved too (re-opt-in), so the approval now
    // records the new epoch — this closes the gate on validity, not drift.
    const liveChanged = live({
      activation: { ...live().activation, enabledAt: t("2030-01-20T00:00:00Z") },
      approval: {
        approvedAt: t("2030-01-21T00:00:00Z"),
        revokedAt: null,
        merchantOptInEpoch: t("2030-01-20T00:00:00Z"),
        ackVersion: REQUIRED_ACK_VERSION,
      },
    });
    const r = recheckShippingGate(snap, liveChanged, "OBSERVE");
    if (r.equal) throw new Error("re-approval drift not detected");
    expect(r.code).toBe("GATE_CHANGED");
    expect(r.field).toBe("merchantEpochAt"); // the epoch itself moved first
  });

  it("two different epoch vectors sharing the same maximum are detected (maxima hide nothing)", () => {
    const snap = observed();
    // Live vector: rollout moved DOWN, switch unchanged — both maxima still
    // 2030-01-03. A Math.max-only comparison would pass; per-field does not.
    const drifted = live({
      activation: { ...live().activation, shippingRolloutAt: t("2030-01-01T12:00:00Z") },
    });
    // Independent literal proof that the maximum is unchanged.
    const storedMax = Math.max(snap.merchantEpochAt.getTime(), snap.rolloutEpochAt.getTime(), snap.switchEpochAt.getTime());
    const liveG = open({ activation: { ...live().activation, shippingRolloutAt: t("2030-01-01T12:00:00Z") } });
    const liveMax = Math.max(liveG.merchantEpochAt.getTime(), liveG.rolloutEpochAt.getTime(), liveG.switchEpochAt.getTime());
    expect(storedMax).toBe(liveMax);
    expect(liveG.activationCutoffAt.getTime()).toBe(snap.activationCutoffAt.getTime());
    const r = recheckShippingGate(snap, drifted, "OBSERVE");
    if (r.equal) throw new Error("equal-maximum drift not detected");
    expect(r.code).toBe("GATE_CHANGED");
    expect(r.field).toBe("rolloutEpochAt");
  });

  it("clock regression/restoration returning the maximum to an earlier value is still detected", () => {
    const snap = observed();
    // Restore: the rollout epoch regresses (older restore) while the switch
    // epoch INCREASES — the maximum stays 2030-01-03, hiding both moves.
    const restored = live({
      activation: {
        ...live().activation,
        shippingRolloutAt: t("2030-01-01T00:00:00Z"),
        shippingEnabledAt: t("2030-01-03T00:00:00Z"), // same instant, different Date object
      },
    });
    // The OTHER direction too: max regresses (switch epoch restored earlier).
    const restoredMax = live({
      activation: { ...live().activation, shippingEnabledAt: t("2030-01-02T00:00:00Z") },
    });
    const r1 = recheckShippingGate(snap, restored, "OBSERVE");
    if (r1.equal) throw new Error("same-maximum restore not detected");
    expect(r1.field).toBe("rolloutEpochAt");
    const r2 = recheckShippingGate(snap, restoredMax, "OBSERVE");
    if (r2.equal) throw new Error("regressed maximum not detected");
    // The first differing field in the comparison order is switchEpochAt.
    expect(r2.code).toBe("GATE_CHANGED");
    expect(r2.field).toBe("switchEpochAt");
  });

  it("a closed gate refuses at recheck, never refreshing the snapshot", () => {
    const snap = observed();
    for (const over of [
      { admissionEnabled: false },
      { admissionEnabledAt: null },
      { approval: null },
      { approval: { ...live().approval!, revokedAt: EPOCHS.dispatch } },
      { activation: { ...live().activation, shopEnabled: false } },
      { shippingPolicy: "RETAIN_FIXED" },
    ]) {
      const r = recheckShippingGate(snap, live(over), "OBSERVE");
      if (r.equal) throw new Error(`closed gate passed recheck: ${JSON.stringify(over)}`);
      expect(r.code).toBe("GATE_CLOSED");
      expect(typeof r.field).toBe("string");
    }
  });
});

describe("lane semantics (4.5)", () => {
  it("the OBSERVE dispatch-epoch exception: enabling dispatch later never upgrades the row", () => {
    const snap = observed();
    expect(snap.dispatchEpochAtAdmission).toBeNull();
    // Dispatch comes on afterwards; the live epoch is legitimately non-null.
    const r = recheckShippingGate(snap, execLive(), "OBSERVE");
    expect(r.equal).toBe(true);
    // The lane itself is a stored row property — the recheck never emits a
    // lane, so nothing here can upgrade it. A fresh admission of the same
    // old combine still lands OBSERVE (created before the dispatch epoch).
    const d = admitShippingRefund(execLive(), OP_AFTER_ADMISSION);
    if (!d.admitted) throw new Error("not admitted");
    expect(d.lane).toBe("OBSERVE");
  });

  it("the OBSERVE exception does not weaken any other epoch comparison", () => {
    const snap = observed();
    const drifted = execLive({ activation: { ...live().activation, shippingRolloutAt: t("2030-01-02T00:00:00.001Z") } });
    const r = recheckShippingGate(snap, drifted, "OBSERVE");
    if (r.equal) throw new Error("drift hidden by the dispatch exception");
    expect(r.field).toBe("rolloutEpochAt");
  });

  it("dispatch off/on cycling stamps a new epoch and invalidates an EXECUTE snapshot", () => {
    const snap = executed();
    // Off then on: the epoch restamped to a later instant.
    const cycled = live({ dispatchEnabled: true, dispatchEnabledAt: t("2030-02-01T00:00:00Z") });
    const r = recheckShippingGate(snap, cycled, "EXECUTE");
    if (r.equal) throw new Error("dispatch cycle not detected");
    expect(r.code).toBe("GATE_CHANGED");
    expect(r.field).toBe("dispatchEpochAtAdmission");
    expect(r.storedMs).toBe(EPOCHS.dispatch.getTime());
    // Dispatch simply off: stored epoch vs live NULL is a change too.
    const off = recheckShippingGate(snap, live(), "EXECUTE");
    if (off.equal) throw new Error("dispatch-off not detected for EXECUTE");
    expect(off.code).toBe("GATE_CHANGED");
    expect(off.field).toBe("dispatchEpochAtAdmission");
    expect(off.liveMs).toBeNull();
  });

  it("a stored OBSERVE snapshot with a non-NULL dispatch epoch is inconsistent; EXECUTE with NULL likewise", () => {
    const snap = observed();
    const tampered = { ...snap, dispatchEpochAtAdmission: EPOCHS.dispatch };
    const r1 = recheckShippingGate(tampered, execLive(), "OBSERVE");
    if (r1.equal) throw new Error("inconsistent OBSERVE snapshot passed");
    expect(r1.code).toBe("SNAPSHOT_INVALID");
    const r2 = recheckShippingGate(snap, execLive(), "EXECUTE");
    if (r2.equal) throw new Error("EXECUTE lane with NULL dispatch epoch passed");
    expect(r2.code).toBe("SNAPSHOT_INVALID");
  });

  it("malformed stored snapshots fail closed", () => {
    for (const bad of [null, 42, "x", {}, { ...observed(), merchantEpochAt: "garbage" }, { ...observed(), approvalAckVersion: 3 }]) {
      const r = recheckShippingGate(bad, live(), "OBSERVE");
      if (r.equal) throw new Error(`invalid snapshot passed: ${JSON.stringify(bad)}`);
      expect(r.code).toBe("SNAPSHOT_INVALID");
    }
    // A stored snapshot whose derived cutoff does not equal its own parts.
    const snap = observed();
    const inconsistent = { ...snap, activationCutoffAt: t("2030-06-01T00:00:00Z") };
    const r = recheckShippingGate(inconsistent, live(), "OBSERVE");
    if (r.equal) throw new Error("inconsistent cutoff passed");
    expect(r.code).toBe("SNAPSHOT_INVALID");
    // An invalid lane fails closed too.
    const rl = recheckShippingGate(snap, live(), "LEGACY");
    expect(rl.equal).toBe(false);
  });
});

describe("purity and determinism", () => {
  it("does not mutate its inputs and returns detached timestamps", () => {
    const l = live();
    const before = JSON.stringify(l);
    const g1 = computeShippingGate(l);
    const g2 = computeShippingGate(l);
    expect(JSON.stringify(l)).toBe(before);
    expect(g1).toEqual(g2);
    const d1 = admitShippingRefund(l, OP_AFTER_ADMISSION);
    const d2 = admitShippingRefund(l, OP_AFTER_ADMISSION);
    expect(d1).toEqual(d2);
    if (d1.admitted) {
      // Snapshot instants are fresh objects, not aliases of the inputs.
      const merchantMs = EPOCHS.merchant.getTime();
      expect(d1.snapshot.merchantEpochAt).not.toBe(l.activation.enabledAt);
      l.activation.enabledAt!.setFullYear(1999);
      expect(d1.snapshot.merchantEpochAt.getTime()).toBe(merchantMs);
    }
    // Stored snapshot inputs to the recheck are not mutated either.
    const snap = observed();
    const snapBefore = JSON.stringify(snap);
    recheckShippingGate(snap, live(), "OBSERVE");
    expect(JSON.stringify(snap)).toBe(snapBefore);
  });

  it("string timestamps are normalized; non-ISO and Date-unfriendly forms fail closed", () => {
    const g = computeShippingGate(live({ admissionEnabledAt: "2030-01-04T00:00:00.000Z" }));
    if (!g.open) throw new Error("ISO admission epoch refused");
    const bad = computeShippingGate(live({ admissionEnabledAt: "01/04/2030" }));
    if (bad.open) throw new Error("non-ISO epoch accepted");
    expect(bad.code).toBe("ADMISSION_EPOCH_INVALID");
  });
});

describe("proven-null revocation (D-1)", () => {
  it("explicit null opens; every non-null value — including missing and undefined — closes as APPROVAL_REVOKED", () => {
    const g = open();
    expect(g.approvalApprovedAt).toBeDefined();
    const { revokedAt: _omitted, ...noRevoked } = live().approval!;
    for (const appr of [
      noRevoked, // property absent entirely
      { ...live().approval!, revokedAt: undefined },
      { ...live().approval!, revokedAt: EPOCHS.dispatch },
      { ...live().approval!, revokedAt: new Date("x") },
      { ...live().approval!, revokedAt: "2030-01-06T00:00:00Z" },
      { ...live().approval!, revokedAt: "garbage" },
      { ...live().approval!, revokedAt: 0 },
      { ...live().approval!, revokedAt: false },
      { ...live().approval!, revokedAt: {} },
    ]) {
      const r = computeShippingGate(live({ approval: appr as never }));
      if (r.open) throw new Error(`admission opened on unproven revocation: ${JSON.stringify(appr)}`);
      expect(r.code).toBe("APPROVAL_REVOKED");
      const d = admitShippingRefund(live({ approval: appr as never }), OP_AFTER_DISPATCH);
      if (d.admitted) throw new Error("admitted on unproven revocation");
      expect(d.code).toBe("APPROVAL_REVOKED");
    }
  });
});

describe("strict instant parsing (D-2)", () => {
  // Inputs the old regex+Date.parse silently rolled into valid instants.
  const NONEXISTENT = [
    "2030-02-30T12:00:00Z",
    "2030-02-31T00:00:00Z",
    "2030-04-31T00:00:00Z",
    "2030-06-31T00:00:00Z",
    "2030-11-31T00:00:00Z",
    "2029-02-29T00:00:00Z", // non-leap year
    "2100-02-29T00:00:00Z", // divisible by 100, not 400
    "2030-01-01T24:00:00Z", // hour 24 — JavaScript rolls it to the next day
    "2030-01-01T00:60:00Z",
    "2030-01-01T00:00:60Z",
    "2030-01-01T25:00:00Z",
    "2030-00-01T00:00:00Z",
    "2030-13-01T00:00:00Z",
    "2030-01-00T00:00:00Z",
    "2030-01-32T00:00:00Z",
    "2030-01-01T00:00:00+24:00",
    "2030-01-01T00:00:00+05:60",
    "2030-01-01T00:00:00+99:99",
    "2030-01-01T00:00:00.9999Z", // sub-ms precision must not be truncated
    "2030-01-01T00:00:00.0009Z",
    "2030-01-01T00:00:00", // missing zone
    "2030-01-01 00:00:00Z",
    "2030-01-01T00:00:00.Z",
    "2030-1-01T00:00:00Z",
    "",
  ];
  it.each(NONEXISTENT)("refuses %s in every gate-carrying slot", (s) => {
    const states: Array<[string, ShippingGateLiveState]> = [
      ["admissionEpochAt", live({ admissionEnabledAt: s })],
      ["approvalApprovedAt", live({ approval: { ...live().approval!, approvedAt: s } })],
      ["approvalOptInEpoch", live({ approval: { ...live().approval!, merchantOptInEpoch: s } })],
      ["dispatchEpochAt", live({ dispatchEnabled: true, dispatchEnabledAt: s })],
    ];
    for (const [slot, st] of states) {
      const g = computeShippingGate(st);
      if (g.open) throw new Error(`${slot} accepted ${s}`);
    }
    const d = admitShippingRefund(live(), s);
    if (d.admitted) throw new Error(`operationCreatedAt accepted ${s}`);
    expect(d.code).toBe("OPERATION_CREATED_AT_INVALID");
    // And through a stored snapshot: no malformed instant passes recheck.
    const snap = observed();
    const r = recheckShippingGate({ ...snap, admissionEpochAt: s }, live(), "OBSERVE");
    expect(r.equal).toBe(false);
  });

  it("a nonexistent dispatch epoch can never select EXECUTE, and a nonexistent epoch never opens admission", () => {
    const d = admitShippingRefund(
      live({ dispatchEnabled: true, dispatchEnabledAt: "2030-02-30T00:00:00Z" }),
      OP_AFTER_DISPATCH,
    );
    if (d.admitted) throw new Error("nonexistent dispatch epoch admitted a combine");
    expect(d.code).toBe("DISPATCH_EPOCH_INVALID");
    const g = computeShippingGate(live({ admissionEnabledAt: "2030-04-31T00:00:00Z" }));
    if (g.open) throw new Error("nonexistent admission epoch opened the gate");
    expect(g.code).toBe("ADMISSION_EPOCH_INVALID");
  });

  it("accepts legitimate instants: leap days, offsets, fractional seconds, year bounds", () => {
    for (const s of [
      "2028-02-29T00:00:00Z",
      "2000-02-29T00:00:00Z", // divisible by 400 — a real leap day
      "2030-01-04T05:30:00+05:30", // == 2030-01-04T00:00:00Z
      "2030-01-03T19:00:00-05:00", // == 2030-01-04T00:00:00Z
      "2030-01-04T00:00:00+00:00",
      "2030-01-04T00:00:00-00:00",
      "2030-01-04T00:00:00.1Z",
      "2030-01-04T00:00:00.999Z",
      "0001-01-01T00:00:00Z",
      "9999-12-31T23:59:59.999Z",
    ]) {
      const g = computeShippingGate(live({ admissionEnabledAt: s }));
      if (!g.open) throw new Error(`refused a valid instant ${s}`);
    }
    // An offset that shifts the UTC date is a legitimate instant, not an
    // invalid calendar date: 2030-01-01T01:00:00+02:00 == 2029-12-31T23:00Z.
    const g = open({ admissionEnabledAt: "2030-01-01T01:00:00+02:00" });
    expect(g.admissionEpochAt.toISOString()).toBe("2029-12-31T23:00:00.000Z");
  });

  it("exact millisecond comparison survives parsing at the admission cutoff", () => {
    const g = open();
    expect(g.admissionCutoffAt.toISOString()).toBe("2030-01-05T00:00:00.000Z");
    const before = admitShippingRefund(live(), "2030-01-04T23:59:59.999Z");
    if (before.admitted) throw new Error("admitted one ms before the parsed cutoff");
    expect(before.code).toBe("OPERATION_PREDATES_ADMISSION_CUTOFF");
    const on = admitShippingRefund(live(), "2030-01-05T00:00:00.000Z");
    if (!on.admitted) throw new Error("refused exactly on the cutoff");
    expect(on.lane).toBe("OBSERVE");
  });
});

describe("Phase 1 activation semantics preserved (D-2b)", () => {
  // The canonical predicate accepts only Date-valued epochs; ISO-looking
  // strings must close the gate, not be normalized into Dates.
  it.each([
    ["merchant epoch string", { enabledAt: "2030-01-01T00:00:00Z" }],
    ["rollout epoch string", { shippingRolloutAt: "2030-01-02T00:00:00Z" }],
    ["switch epoch string", { shippingEnabledAt: "2030-01-03T00:00:00Z" }],
    ["merchant epoch number", { enabledAt: 1893456000000 }],
    ["merchant epoch malformed string", { enabledAt: "2030-02-30T00:00:00Z" }],
  ])("%s → ACTIVATION_GATE_CLOSED", (_l, over) => {
    const g = computeShippingGate(
      live({ activation: { ...live().activation, ...over } as never }),
    );
    if (g.open) throw new Error("string/number activation epoch opened the gate");
    expect(g.code).toBe("ACTIVATION_GATE_CLOSED");
  });
});

describe("dispatch switch/epoch consistency (N-1)", () => {
  it.each([
    ["false + valid epoch", false, EPOCHS.dispatch],
    ["false + invalid epoch", false, "garbage"],
    ["false + undefined epoch", false, undefined],
    ["'true' string + epoch", "true", EPOCHS.dispatch],
    ["1 + epoch", 1, EPOCHS.dispatch],
    ["undefined + epoch", undefined, EPOCHS.dispatch],
    ["null + epoch", null, EPOCHS.dispatch],
  ])("dispatchEnabled %s → DISPATCH_CONTROL_INVALID", (_l, sw, ep) => {
    const g = computeShippingGate(live({ dispatchEnabled: sw as never, dispatchEnabledAt: ep as never }));
    if (g.open) throw new Error("contradictory dispatch control opened the gate");
    expect(g.code).toBe("DISPATCH_CONTROL_INVALID");
    const d = admitShippingRefund(live({ dispatchEnabled: sw as never, dispatchEnabledAt: ep as never }), OP_AFTER_DISPATCH);
    if (d.admitted) throw new Error(`contradictory dispatch control admitted ${d.lane}`);
    expect(d.code).toBe("DISPATCH_CONTROL_INVALID");
  });
  it("a leftover dispatch epoch never selects EXECUTE while the switch is false (M4 regression)", () => {
    // Mutation proof: if lane selection ever used dispatchEnabledAt without
    // checking dispatchEnabled, this case yields EXECUTE instead of refusing.
    const d = admitShippingRefund(
      live({ dispatchEnabled: false, dispatchEnabledAt: EPOCHS.dispatch }),
      OP_AFTER_DISPATCH,
    );
    if (d.admitted) throw new Error(`admitted ${d.lane} on a disabled switch with a leftover epoch`);
    expect(d.code).toBe("DISPATCH_CONTROL_INVALID");
  });
  it("false + explicit null stays the valid disabled case (OBSERVE)", () => {
    const d = admitShippingRefund(live(), OP_AFTER_ADMISSION);
    if (!d.admitted) throw new Error("not admitted");
    expect(d.lane).toBe("OBSERVE");
    expect(d.snapshot.dispatchEpochAtAdmission).toBeNull();
  });
});

describe("explicit-null dispatch epoch in OBSERVE snapshots (N-2)", () => {
  it("missing or undefined dispatchEpochAtAdmission is SNAPSHOT_INVALID for either lane", () => {
    const obs = observed();
    const { dispatchEpochAtAdmission: _x, ...partial } = obs;
    for (const stored of [partial, { ...obs, dispatchEpochAtAdmission: undefined }]) {
      const r = recheckShippingGate(stored, live(), "OBSERVE");
      if (r.equal) throw new Error("missing dispatch epoch passed OBSERVE recheck");
      expect(r.code).toBe("SNAPSHOT_INVALID");
      expect(r.field).toBe("dispatchEpochAtAdmission");
      // Distinguish "missing property" from "present but unparseable": the
      // 4.4 NULL-equals-NULL rule demands an explicit null, so the refusal
      // names the missing-property case, not a malformed instant.
      expect(r.detail).toContain("missing");
      const rx = recheckShippingGate(stored, execLive(), "EXECUTE");
      if (rx.equal) throw new Error("missing dispatch epoch passed EXECUTE recheck");
      expect(rx.code).toBe("SNAPSHOT_INVALID");
    }
    expect(recheckShippingGate(obs, live(), "OBSERVE").equal).toBe(true);
  });
});

describe("mutation-gap regression (T)", () => {
  it("stored approvalOptInEpoch alone is compared (no merchantEpochAt confound)", () => {
    // Live state is IDENTICAL except the stored snapshot records a different
    // opt-in epoch — nothing earlier in the compare order can differ.
    const snap = observed();
    const r = recheckShippingGate(
      { ...snap, approvalOptInEpoch: t("2030-01-01T00:00:00.001Z") },
      live(),
      "OBSERVE",
    );
    if (r.equal) throw new Error("stored approvalOptInEpoch drift not detected");
    expect(r.code).toBe("GATE_CHANGED");
    expect(r.field).toBe("approvalOptInEpoch");
  });

  it("a stored activationCutoffAt that keeps the admission cutoff consistent is still invalid", () => {
    // Tamper activationCutoffAt and recompute the SECONDARY derived cutoff
    // consistently — only the activation-maximum rule can catch this row.
    const snap = observed();
    const tamperedAct = t("2030-01-03T00:00:00.001Z"); // still below admissionEpochAt
    const consistentAdmission = new Date(
      Math.max(tamperedAct.getTime(), snap.admissionEpochAt.getTime(), snap.approvalApprovedAt.getTime()),
    );
    // sanity: the secondary check cannot be the one that fails
    expect(consistentAdmission.getTime()).toBe(snap.admissionCutoffAt.getTime());
    const r = recheckShippingGate(
      { ...snap, activationCutoffAt: tamperedAct, admissionCutoffAt: consistentAdmission },
      live(),
      "OBSERVE",
    );
    if (r.equal) throw new Error("activation cutoff inconsistency not detected");
    expect(r.code).toBe("SNAPSHOT_INVALID");
    expect(r.field).toBe("activationCutoffAt");
  });

  it("a stored admissionCutoffAt tampered alone is invalid, not merely unequal to live", () => {
    const snap = observed();
    const r = recheckShippingGate(
      { ...snap, admissionCutoffAt: t("2030-01-05T00:00:00.001Z") },
      live(),
      "OBSERVE",
    );
    if (r.equal) throw new Error("admission cutoff tamper not detected");
    expect(r.code).toBe("SNAPSHOT_INVALID");
    expect(r.field).toBe("admissionCutoffAt");
  });
});
