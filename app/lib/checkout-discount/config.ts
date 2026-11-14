// Shared constants for the checkout-first shipping discount. The message is
// ALSO the discountApplication title on consumed orders — it must equal the
// `message` field of the Function's $app:config metafield (see
// functions/checkout-shipping-discount/README.md).
import { ELIG_KEY, ELIG_NAMESPACE } from "./records";

export { ELIG_KEY, ELIG_NAMESPACE };

export const CHECKOUT_DISCOUNT_MESSAGE = "MergeShip: free shipping on your next order";

export const checkoutDiscountWindowId = (): string =>
  process.env.MERGESHIP_CHECKOUT_DISCOUNT_WINDOW || "w1";

/** Max records kept in one customer's eligibility document. */
export const MAX_RECS = 5;
