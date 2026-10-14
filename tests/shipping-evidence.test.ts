import { describe, expect, it } from "vitest";
import {
  buildShippingAmounts,
  type ShippingEvidenceInput,
} from "../app/lib/shipping-evidence";

const m = (amount: string, currencyCode = "USD") => ({ amount, currencyCode });

const evidence = (o: Partial<ShippingEvidenceInput> = {}): ShippingEvidenceInput => ({
  orderCurrencyCode: "USD",
  presentmentCurrencyCode: "USD",
  taxesIncluded: false,
  completeRefundHistory: true,
  sourceShippingPaid: m("8.50"),
  previouslyRefundedShipping: m("0.00"),
  maxShippingRefundable: m("8.50"),
  maxPaymentRefundable: m("10.00"),
  previewShipping: m("8.50"),
  previewShippingTax: m("0.68"),
  previewTotal: m("9.18"),
  ...o,
});

describe("Shipping v0 evidence adapter (MoneyV2 → minor units, fail-closed)", () => {
  it("converts a consistent USD evidence set", () => {
    const r = buildShippingAmounts(evidence());
    expect(r).toEqual({
      ok: true,
      amounts: {
        currencyCode: "USD",
        taxesIncluded: false,
        completeRefundHistory: true,
        sourceShippingPaidMinor: "850",
        previouslyRefundedShippingMinor: "0",
        maxShippingRefundableMinor: "850",
        maxPaymentRefundableMinor: "1000",
        previewShippingMinor: "850",
        previewShippingTaxMinor: "68",
        previewTotalMinor: "918",
      },
    });
  });
  it("rejects multi-currency presentment orders (no conversion)", () => {
    expect(buildShippingAmounts(evidence({ presentmentCurrencyCode: "EUR" })).ok).toBe(false);
  });
  it("rejects any money field whose currency differs from the order", () => {
    expect(buildShippingAmounts(evidence({ previewTotal: m("9.18", "EUR") })).ok).toBe(false);
    expect(buildShippingAmounts(evidence({ sourceShippingPaid: m("8.50", "CAD") })).ok).toBe(false);
  });
  it("rejects unsupported currencies via the ISO precision table", () => {
    expect(buildShippingAmounts(evidence({ orderCurrencyCode: "XXX", presentmentCurrencyCode: "XXX" })).ok).toBe(false);
    expect(buildShippingAmounts(evidence({ orderCurrencyCode: "BGN", presentmentCurrencyCode: "BGN" })).ok).toBe(false);
  });
  it("rejects malformed or missing MoneyV2 values", () => {
    for (const bad of [undefined, null, {}, { amount: "abc", currencyCode: "USD" }, { amount: "8.50" }, { amount: "8.555", currencyCode: "USD" }]) {
      expect(buildShippingAmounts(evidence({ previewTotal: bad })).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it("rejects non-boolean evidence flags", () => {
    expect(buildShippingAmounts(evidence({ taxesIncluded: undefined })).ok).toBe(false);
    expect(buildShippingAmounts(evidence({ taxesIncluded: "false" })).ok).toBe(false);
    expect(buildShippingAmounts(evidence({ completeRefundHistory: "yes" })).ok).toBe(false);
  });
  it("passes an incomplete-history flag through for the policy layer to REVIEW", () => {
    const r = buildShippingAmounts(evidence({ completeRefundHistory: false }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.amounts.completeRefundHistory).toBe(false);
  });
  it("converts non-two-decimal currencies exactly (JOD, JPY)", () => {
    const jod = evidence({
      orderCurrencyCode: "JOD", presentmentCurrencyCode: "JOD",
      sourceShippingPaid: m("2.250", "JOD"), previouslyRefundedShipping: m("0", "JOD"),
      maxShippingRefundable: m("2.250", "JOD"), maxPaymentRefundable: m("9.999", "JOD"),
      previewShipping: m("2.250", "JOD"), previewShippingTax: m("0.360", "JOD"),
      previewTotal: m("2.610", "JOD"),
    });
    const r = buildShippingAmounts(jod);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.amounts.sourceShippingPaidMinor).toBe("2250");
      expect(r.amounts.previewTotalMinor).toBe("2610");
    }
    const jpy = evidence({
      orderCurrencyCode: "JPY", presentmentCurrencyCode: "JPY",
      sourceShippingPaid: m("850", "JPY"), previouslyRefundedShipping: m("0", "JPY"),
      maxShippingRefundable: m("850", "JPY"), maxPaymentRefundable: m("1000", "JPY"),
      previewShipping: m("850", "JPY"), previewShippingTax: m("0", "JPY"), previewTotal: m("850", "JPY"),
    });
    const rj = buildShippingAmounts(jpy);
    expect(rj.ok).toBe(true);
    if (rj.ok) expect(rj.amounts.sourceShippingPaidMinor).toBe("850");
  });
});
