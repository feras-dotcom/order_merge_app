/**
 * Shipping v0 policy arithmetic. Pure, no Shopify mutations and no floating point.
 *
 * Callers MUST establish the shipping amounts/currency from fresh Shopify
 * authoritative evidence, prove the source belongs to a COMPLETED v2 combine,
 * and obtain Shopify's current refund suggestion before dispatching any refund.
 * This function does not authorize a Shopify mutation by itself.
 *
 * Fail-closed contract:
 * - `policy` is untrusted runtime input (it arrives as a free-form DB string).
 *   Any missing, malformed or unsupported kind is REVIEW — never a silent
 *   fallback to REFUND_ALL.
 * - The Shopify preview evidence (suggestedRefund called with the desired
 *   shippingAmount) must agree with the policy arithmetic and be internally
 *   consistent with `taxesIncluded`. Ambiguity is REVIEW, never a guess.
 */
import { getCurrencyPrecision } from "./money";

export type ShippingPolicyKind = "REFUND_ALL" | "RETAIN_FIXED";
export type ShippingPolicy =
  | { kind: "REFUND_ALL" }
  | { kind: "RETAIN_FIXED"; retainedMinor: string; currencyCode: string };

export interface ShippingAmounts {
  currencyCode: string;
  /** Net amount of shipping the customer paid on the source, in minor units. */
  sourceShippingPaidMinor: string;
  /** All previously recorded shipping refunds on that source. */
  previouslyRefundedShippingMinor: string;
  /** Shopify's fresh maximum shipping refundable amount (same currency). */
  maxShippingRefundableMinor: string;
  /** Shopify's fresh available payment-refund balance (same currency). */
  maxPaymentRefundableMinor: string;
  /** Verified that all shipping refund history was read and reconciled. */
  completeRefundHistory: boolean;
  /** Order.taxesIncluded from the same fresh read — must be a real boolean. */
  taxesIncluded: boolean;
  /** suggestedRefund.shipping.amountSet — Shopify's shipping component for the
   *  requested shippingAmount. Must equal the policy-computed amount. */
  previewShippingMinor: string;
  /** suggestedRefund.shipping.taxSet — Shopify's shipping tax component. */
  previewShippingTaxMinor: string;
  /** suggestedRefund.amountSet — the total the refund would move. */
  previewTotalMinor: string;
}

export type ShippingDecision =
  | { kind: "SKIP"; reason: string }
  | {
      kind: "REFUND";
      /** RefundInput.shipping.amount, minor units (pre-tax component). */
      shippingMinor: string;
      /** Shipping tax component Shopify reported, minor units. */
      shippingTaxMinor: string;
      /** Total the payment transaction must move, minor units. */
      transactionMinor: string;
      currencyCode: string;
      policyKind: ShippingPolicyKind;
    }
  | { kind: "REVIEW"; reason: string };

const parseMinor = (s: unknown): bigint | null =>
  typeof s === "string" && /^\d{1,40}$/.test(s) ? BigInt(s) : null;

const review = (reason: string): ShippingDecision => ({ kind: "REVIEW", reason });

/** Strictly arithmetic proposal; unknown/incomplete/over-cap states stop. */
export function proposeShippingAdjustment(
  policy: unknown,
  amounts: ShippingAmounts,
): ShippingDecision {
  // F1: the policy kind is untrusted runtime input. Anything we do not
  // explicitly support is REVIEW — never a fallback to REFUND_ALL.
  const kind = (policy as { kind?: unknown } | null)?.kind;
  if (kind !== "REFUND_ALL" && kind !== "RETAIN_FIXED") {
    return review("Shipping policy kind is missing or not supported.");
  }

  if (amounts.completeRefundHistory !== true) {
    return review("Shipping refund history is incomplete.");
  }
  const { currencyCode } = amounts;
  // F2/F4: only currencies with a known minor-unit precision — the same SIX
  // ISO 4217 snapshot the merge engine uses. XXX and unmapped codes stop here.
  if (getCurrencyPrecision(currencyCode) === null) {
    return review("Shipping currency is unknown or unsupported.");
  }
  if (typeof amounts.taxesIncluded !== "boolean") {
    return review("Order tax-inclusion flag is missing.");
  }
  const paid = parseMinor(amounts.sourceShippingPaidMinor);
  const already = parseMinor(amounts.previouslyRefundedShippingMinor);
  const shippingMax = parseMinor(amounts.maxShippingRefundableMinor);
  const paymentMax = parseMinor(amounts.maxPaymentRefundableMinor);
  const previewShipping = parseMinor(amounts.previewShippingMinor);
  const previewTax = parseMinor(amounts.previewShippingTaxMinor);
  const previewTotal = parseMinor(amounts.previewTotalMinor);
  if (
    paid === null || already === null || shippingMax === null || paymentMax === null ||
    previewShipping === null || previewTax === null || previewTotal === null
  ) {
    return review("Amounts are missing or not exact minor units.");
  }
  if (already > paid) {
    return review("Previous shipping refunds exceed the verified charge.");
  }
  // In v0, do not race with, repeat, or alter someone else's partial refund.
  if (already > 0n) {
    return review("Source shipping has already been partially or fully refunded.");
  }
  let retained = 0n;
  if (kind === "RETAIN_FIXED") {
    const p = policy as { retainedMinor?: unknown; currencyCode?: unknown };
    if (p.currencyCode !== currencyCode) {
      return review("Policy and order shipping currencies differ.");
    }
    const parsed = parseMinor(p.retainedMinor);
    if (parsed === null) {
      return review("Retained shipping amount is invalid.");
    }
    retained = parsed;
  }
  const desired = paid > retained ? paid - retained : 0n;
  if (desired === 0n) return { kind: "SKIP", reason: "No refundable shipping amount under policy." };
  if (desired > shippingMax) {
    return review("Desired shipping refund exceeds Shopify's shipping maximum.");
  }

  // F3: Shopify's preview is the authority on tax treatment — the lib only
  // verifies the preview is internally consistent with the order's
  // taxesIncluded flag. We never reconstruct tax ourselves.
  if (previewShipping !== desired) {
    return review("Shopify's suggested shipping refund disagrees with the policy amount.");
  }
  if (amounts.taxesIncluded) {
    // Tax is embedded in the shipping price: the moving total IS the shipping
    // amount, and any reported tax component must fit inside it.
    if (previewTotal !== previewShipping || previewTax > previewShipping) {
      return review("Refund preview is inconsistent with tax-inclusive pricing.");
    }
  } else if (previewTotal !== previewShipping + previewTax) {
    return review("Refund preview is inconsistent with tax-exclusive pricing.");
  }
  if (previewTotal > paymentMax) {
    return review("Refund total (incl. tax) exceeds Shopify's payment maximum.");
  }
  return {
    kind: "REFUND",
    shippingMinor: desired.toString(),
    shippingTaxMinor: previewTax.toString(),
    transactionMinor: previewTotal.toString(),
    currencyCode,
    policyKind: kind,
  };
}
