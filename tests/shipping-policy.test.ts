import { describe, expect, it } from "vitest";
import { proposeShippingAdjustment, type ShippingAmounts } from "../app/lib/shipping-policy";

// Tax-exclusive baseline: customer paid 8.50 shipping + 0.68 shipping tax.
// Shopify's preview agrees: shipping 850, tax 68, total 918, payment cap 1000.
const amount = (o: Partial<ShippingAmounts> = {}): ShippingAmounts => ({
  currencyCode: "USD",
  sourceShippingPaidMinor: "850",
  previouslyRefundedShippingMinor: "0",
  maxShippingRefundableMinor: "850",
  maxPaymentRefundableMinor: "1000",
  completeRefundHistory: true,
  taxesIncluded: false,
  previewShippingMinor: "850",
  previewShippingTaxMinor: "68",
  previewTotalMinor: "918",
  ...o,
});

describe("Shipping v0 policy arithmetic (not mutation authorization)", () => {
  it("full shipping refund", () => {
    expect(proposeShippingAdjustment({ kind: "REFUND_ALL" }, amount())).toEqual({
      kind: "REFUND",
      shippingMinor: "850",
      shippingTaxMinor: "68",
      transactionMinor: "918",
      currencyCode: "USD",
      policyKind: "REFUND_ALL",
    });
  });
  it("retained fixed shipping is represented without redesign", () => {
    expect(proposeShippingAdjustment({ kind: "RETAIN_FIXED", retainedMinor: "250", currencyCode: "USD" }, amount({
      previewShippingMinor: "600", previewShippingTaxMinor: "48", previewTotalMinor: "648",
    })))
      .toEqual({
        kind: "REFUND",
        shippingMinor: "600",
        shippingTaxMinor: "48",
        transactionMinor: "648",
        currencyCode: "USD",
        policyKind: "RETAIN_FIXED",
      });
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
    expect(proposeShippingAdjustment({ kind: "REFUND_ALL" }, amount({ maxPaymentRefundableMinor: "917" })).kind)
      .toBe("REVIEW");
  });
  it("rejects malformed, negative or fractional minor units", () => {
    for (const s of ["-1", "8.5", "", "Infinity", "1e3", " 100"]) {
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
      currencyCode: "JOD", sourceShippingPaidMinor: "2250", maxShippingRefundableMinor: "2250",
      previewShippingMinor: "1000", previewShippingTaxMinor: "0", previewTotalMinor: "1000",
      maxPaymentRefundableMinor: "2250",
    }))).toEqual({
      kind: "REFUND",
      shippingMinor: "1000",
      shippingTaxMinor: "0",
      transactionMinor: "1000",
      currencyCode: "JOD",
      policyKind: "RETAIN_FIXED",
    });
  });
  it("rejects amount conflicts", () => {
    expect(proposeShippingAdjustment({ kind: "REFUND_ALL" }, amount({ previouslyRefundedShippingMinor: "999" })).kind)
      .toBe("REVIEW");
  });
  it("skips zero shipping instead of creating zero-dollar refunds", () => {
    expect(proposeShippingAdjustment({ kind: "REFUND_ALL" }, amount({
      sourceShippingPaidMinor: "0", maxShippingRefundableMinor: "0",
      previewShippingMinor: "0", previewShippingTaxMinor: "0", previewTotalMinor: "0",
    })).kind).toBe("SKIP");
  });

  // ── F1: unknown/missing/malformed policy kinds must REVIEW, never refund ──
  it("REVIEWs unknown, missing and malformed policy kinds (F1 regression)", () => {
    for (const bad of [
      { kind: "FOO" },
      { kind: "refund_all" },        // case-sensitive
      { kind: "REFUND_ALL " },       // whitespace
      { kind: 1 },
      { kind: null },
      {},                            // missing kind
      null,
      undefined,
      "REFUND_ALL",                  // not an object
    ]) {
      const d = proposeShippingAdjustment(bad, amount());
      expect(d.kind, JSON.stringify(bad)).toBe("REVIEW");
    }
  });

  // ── F2/F4: currency must have a known ISO precision (money.ts snapshot) ──
  it("REVIEWs currencies outside the ISO precision table (XXX, BGN)", () => {
    for (const c of ["XXX", "BGN", "usd", "US", "USDD", 840, null]) {
      const d = proposeShippingAdjustment({ kind: "REFUND_ALL" }, amount({ currencyCode: c as string }));
      expect(d.kind, String(c)).toBe("REVIEW");
    }
  });

  // ── F3: preview evidence must be consistent with taxesIncluded ──
  it("accepts a consistent tax-inclusive preview", () => {
    // Tax embedded in the shipping price: total equals the shipping amount.
    expect(proposeShippingAdjustment({ kind: "REFUND_ALL" }, amount({
      taxesIncluded: true, previewShippingTaxMinor: "68", previewTotalMinor: "850",
    }))).toEqual({
      kind: "REFUND",
      shippingMinor: "850",
      shippingTaxMinor: "68",
      transactionMinor: "850",
      currencyCode: "USD",
      policyKind: "REFUND_ALL",
    });
  });
  it("REVIEWs when the preview shipping differs from the policy amount", () => {
    expect(proposeShippingAdjustment({ kind: "REFUND_ALL" }, amount({ previewShippingMinor: "849" })).kind)
      .toBe("REVIEW");
  });
  it("REVIEWs an inconsistent tax-exclusive preview total", () => {
    // shipping 850 + tax 68 must total 918; anything else is ambiguous.
    expect(proposeShippingAdjustment({ kind: "REFUND_ALL" }, amount({ previewTotalMinor: "850" })).kind)
      .toBe("REVIEW");
    expect(proposeShippingAdjustment({ kind: "REFUND_ALL" }, amount({ previewTotalMinor: "919" })).kind)
      .toBe("REVIEW");
  });
  it("REVIEWs when taxesIncluded but the preview total exceeds shipping", () => {
    expect(proposeShippingAdjustment({ kind: "REFUND_ALL" }, amount({
      taxesIncluded: true, previewTotalMinor: "918",
    })).kind).toBe("REVIEW");
  });
  it("REVIEWs when the reported tax exceeds the (tax-inclusive) shipping amount", () => {
    expect(proposeShippingAdjustment({ kind: "REFUND_ALL" }, amount({
      taxesIncluded: true, previewShippingTaxMinor: "900", previewTotalMinor: "850",
    })).kind).toBe("REVIEW");
  });
  it("REVIEWs when taxesIncluded is not a real boolean", () => {
    const d = proposeShippingAdjustment(
      { kind: "REFUND_ALL" },
      amount({ taxesIncluded: undefined as unknown as boolean }),
    );
    expect(d.kind).toBe("REVIEW");
  });
  it("REVIEWs when the moving total exceeds the payment maximum", () => {
    expect(proposeShippingAdjustment({ kind: "REFUND_ALL" }, amount({ maxPaymentRefundableMinor: "900" })).kind)
      .toBe("REVIEW");
  });
});
