/**
 * Shipping v0 evidence adapter. Pure — converts raw Shopify response fragments
 * (MoneyV2 objects, order flags) into the exact minor-unit ShippingAmounts the
 * policy arithmetic consumes. No Shopify I/O happens here; the caller assembles
 * the fields from bounded, fresh reads and asserts completeRefundHistory only
 * when every paged read reported hasNextPage === false.
 *
 * Fail-closed: any unparseable money value, mixed currencies (multi-currency
 * presentment orders are out of v0 scope), a non-boolean flag or a missing
 * piece of evidence returns { ok: false } — the caller maps that to REVIEW.
 */
import { getCurrencyPrecision, parseShopMoney } from "./money";
import type { ShippingAmounts } from "./shipping-policy";

export interface ShippingEvidenceInput {
  /** Order.currencyCode */
  orderCurrencyCode: unknown;
  /** Order.presentmentCurrencyCode */
  presentmentCurrencyCode: unknown;
  /** Order.taxesIncluded */
  taxesIncluded: unknown;
  /** Net shipping the customer paid — sum of the source order's bounded
   *  shippingLines presentment amounts (MoneyV2 produced by the caller). */
  sourceShippingPaid: unknown;
  /** Order.totalRefundedShippingSet.presentmentMoney */
  previouslyRefundedShipping: unknown;
  /** suggestedRefund.shipping.maximumRefundableSet.presentmentMoney */
  maxShippingRefundable: unknown;
  /** suggestedRefund.maximumRefundableSet.presentmentMoney */
  maxPaymentRefundable: unknown;
  /** suggestedRefund.shipping.amountSet.presentmentMoney */
  previewShipping: unknown;
  /** suggestedRefund.shipping.taxSet.presentmentMoney */
  previewShippingTax: unknown;
  /** suggestedRefund.amountSet.presentmentMoney */
  previewTotal: unknown;
  /** True only when every paged read completed (hasNextPage === false). */
  completeRefundHistory: unknown;
}

export type ShippingEvidenceResult =
  | { ok: true; amounts: ShippingAmounts }
  | { ok: false; reason: string };

export function buildShippingAmounts(input: ShippingEvidenceInput): ShippingEvidenceResult {
  if (typeof input.orderCurrencyCode !== "string" || getCurrencyPrecision(input.orderCurrencyCode) === null) {
    return { ok: false, reason: "Order currency is missing or unsupported." };
  }
  // Multi-currency presentment orders are out of v0 scope — never convert.
  if (input.orderCurrencyCode !== input.presentmentCurrencyCode) {
    return { ok: false, reason: "Shop and presentment currencies differ." };
  }
  if (typeof input.taxesIncluded !== "boolean") {
    return { ok: false, reason: "Order.taxesIncluded is missing." };
  }
  if (typeof input.completeRefundHistory !== "boolean") {
    return { ok: false, reason: "Refund-history completeness flag is missing." };
  }

  const money = (value: unknown, label: string): { ok: true; minor: string } | { ok: false; reason: string } => {
    const parsed = parseShopMoney(value);
    if (!parsed) return { ok: false, reason: `${label} is missing or not a valid MoneyV2.` };
    if (parsed.currencyCode !== input.orderCurrencyCode) {
      return { ok: false, reason: `${label} currency differs from the order currency.` };
    }
    return { ok: true, minor: parsed.minorUnits.toString() };
  };

  const fields = {
    sourceShippingPaidMinor: money(input.sourceShippingPaid, "sourceShippingPaid"),
    previouslyRefundedShippingMinor: money(input.previouslyRefundedShipping, "previouslyRefundedShipping"),
    maxShippingRefundableMinor: money(input.maxShippingRefundable, "maxShippingRefundable"),
    maxPaymentRefundableMinor: money(input.maxPaymentRefundable, "maxPaymentRefundable"),
    previewShippingMinor: money(input.previewShipping, "previewShipping"),
    previewShippingTaxMinor: money(input.previewShippingTax, "previewShippingTax"),
    previewTotalMinor: money(input.previewTotal, "previewTotal"),
  };
  for (const v of Object.values(fields)) if (!v.ok) return v;
  const minors = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, (v as any).minor]));

  return {
    ok: true,
    amounts: {
      currencyCode: input.orderCurrencyCode,
      taxesIncluded: input.taxesIncluded,
      completeRefundHistory: input.completeRefundHistory,
      ...(minors as Omit<ShippingAmounts, "currencyCode" | "taxesIncluded" | "completeRefundHistory">),
    },
  };
}
