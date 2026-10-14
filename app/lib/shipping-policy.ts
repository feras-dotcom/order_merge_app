/**
 * Shipping v0 policy arithmetic. Pure, no Shopify mutations and no floating point.
 *
 * Callers MUST establish the shipping amounts/currency from fresh Shopify
 * authoritative evidence, prove the source belongs to a COMPLETED v2 combine,
 * and obtain Shopify's current refund suggestion before dispatching any refund.
 * This function does not authorize a Shopify mutation by itself.
 */
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
}

export type ShippingDecision =
  | { kind: "SKIP"; reason: string }
  | { kind: "REFUND"; amountMinor: string; currencyCode: string; policyKind: ShippingPolicy["kind"] }
  | { kind: "REVIEW"; reason: string };

const parseMinor = (s: unknown): bigint | null =>
  typeof s === "string" && /^\d{1,40}$/.test(s) ? BigInt(s) : null;

/** Strictly arithmetic proposal; unknown/incomplete/over-cap states stop. */
export function proposeShippingAdjustment(
  policy: ShippingPolicy,
  amounts: ShippingAmounts,
): ShippingDecision {
  if (!amounts.completeRefundHistory) {
    return { kind: "REVIEW", reason: "Shipping refund history is incomplete." };
  }
  const { currencyCode } = amounts;
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    return { kind: "REVIEW", reason: "Shipping currency is unknown or malformed." };
  }
  const paid = parseMinor(amounts.sourceShippingPaidMinor);
  const already = parseMinor(amounts.previouslyRefundedShippingMinor);
  const shippingMax = parseMinor(amounts.maxShippingRefundableMinor);
  const paymentMax = parseMinor(amounts.maxPaymentRefundableMinor);
  if (paid === null || already === null || shippingMax === null || paymentMax === null) {
    return { kind: "REVIEW", reason: "Amounts are missing or not exact minor units." };
  }
  if (already > paid) {
    return { kind: "REVIEW", reason: "Previous shipping refunds exceed the verified charge." };
  }
  // In v0, do not race with, repeat, or alter someone else's partial refund.
  if (already > 0n) {
    return { kind: "REVIEW", reason: "Source shipping has already been partially or fully refunded." };
  }
  let retained = 0n;
  if (policy.kind === "RETAIN_FIXED") {
    if (policy.currencyCode !== currencyCode) {
      return { kind: "REVIEW", reason: "Policy and order shipping currencies differ." };
    }
    const parsed = parseMinor(policy.retainedMinor);
    if (parsed === null) {
      return { kind: "REVIEW", reason: "Retained shipping amount is invalid." };
    }
    retained = parsed;
  }
  const desired = paid > retained ? paid - retained : 0n;
  if (desired === 0n) return { kind: "SKIP", reason: "No refundable shipping amount under policy." };
  if (desired > shippingMax) {
    return { kind: "REVIEW", reason: "Desired shipping refund exceeds Shopify's shipping maximum." };
  }
  if (desired > paymentMax) {
    return { kind: "REVIEW", reason: "Desired shipping refund exceeds Shopify's payment maximum." };
  }
  return { kind: "REFUND", amountMinor: desired.toString(), currencyCode, policyKind: policy.kind };
}
