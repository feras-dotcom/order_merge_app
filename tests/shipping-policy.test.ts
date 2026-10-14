import { describe, expect, it } from "vitest";
import { proposeShippingAdjustment, type ShippingAmounts } from "../app/lib/shipping-policy";

const amount = (o: Partial<ShippingAmounts> = {}): ShippingAmounts => ({
  currencyCode: "USD",
  sourceShippingPaidMinor: "850",
  previouslyRefundedShippingMinor: "0",
  maxShippingRefundableMinor: "850",
  maxPaymentRefundableMinor: "850",
  completeRefundHistory: true,
  ...o,
});

describe("Shipping v0 policy arithmetic (not mutation authorization)", () => {
  it("full shipping refund", () => {
    expect(proposeShippingAdjustment({ kind: "REFUND_ALL" }, amount())).toEqual({
      kind: "REFUND", amountMinor: "850", currencyCode: "USD", policyKind: "REFUND_ALL",
    });
  });
  it("retained fixed shipping is represented without redesign", () => {
    expect(proposeShippingAdjustment({ kind: "RETAIN_FIXED", retainedMinor: "250", currencyCode: "USD" }, amount()))
      .toEqual({ kind: "REFUND", amountMinor: "600", currencyCode: "USD", policyKind: "RETAIN_FIXED" });
  });
  it("does not refund if the fixed amount exceeds the paid shipping", () => {
    expect(proposeShippingAdjustment({ kind: "RETAIN_FIXED", retainedMinor: "900", currencyCode: "USD" }, amount()).kind)
      .toBe("SKIP");
  });
  it("fails closed on any prior shipping refund", () => {
    expect(proposeShippingAdjustment({ kind: "REFUND_ALL" }, amount({ previouslyRefundedShippingMinor: "100" })).kind)
      .toBe("REVIEW");
  });
  it("fails closed on incomplete refund history", () => {
    expect(proposeShippingAdjustment({ kind: "REFUND_ALL" }, amount({ completeRefundHistory: false })).kind)
      .toBe("REVIEW");
  });
  it("never silently caps an unsafe refund", () => {
    expect(proposeShippingAdjustment({ kind: "REFUND_ALL" }, amount({ maxShippingRefundableMinor: "849" })).kind)
      .toBe("REVIEW");
    expect(proposeShippingAdjustment({ kind: "REFUND_ALL" }, amount({ maxPaymentRefundableMinor: "849" })).kind)
      .toBe("REVIEW");
  });
  it("rejects malformed, negative or fractional minor units", () => {
    for (const s of ["-1", "8.5", "", "Infinity", "1e3", "\u00a0100"]) {
      expect(proposeShippingAdjustment({ kind: "REFUND_ALL" }, amount({ sourceShippingPaidMinor: s })).kind)
        .toBe("REVIEW");
    }
  });
  it("rejects currency mismatch and does not convert silently", () => {
    expect(proposeShippingAdjustment({ kind: "RETAIN_FIXED", retainedMinor: "100", currencyCode: "JOD" }, amount()).kind)
      .toBe("REVIEW");
  });
  it("handles non-two-decimal currency integers exactly", () => {
    expect(proposeShippingAdjustment({ kind: "RETAIN_FIXED", retainedMinor: "1250", currencyCode: "JOD" }, amount({
      currencyCode: "JOD", sourceShippingPaidMinor: "2250", maxShippingRefundableMinor: "2250", maxPaymentRefundableMinor: "2250",
    }))).toEqual({ kind: "REFUND", amountMinor: "1000", currencyCode: "JOD", policyKind: "RETAIN_FIXED" });
  });
  it("rejects amount conflicts", () => {
    expect(proposeShippingAdjustment({ kind: "REFUND_ALL" }, amount({ previouslyRefundedShippingMinor: "999" })).kind)
      .toBe("REVIEW");
  });
  it("skips zero shipping instead of creating zero-dollar refunds", () => {
    expect(proposeShippingAdjustment({ kind: "REFUND_ALL" }, amount({
      sourceShippingPaidMinor: "0", maxShippingRefundableMinor: "0", maxPaymentRefundableMinor: "0",
    })).kind).toBe("SKIP");
  });
});
