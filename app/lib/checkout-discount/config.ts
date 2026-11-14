// Shared constants for the checkout-first shipping discount. The message is
// ALSO the discountApplication title on consumed orders — it must equal the
// `message` field of the Function's $app:config metafield (see
// functions/checkout-shipping-discount/README.md).
import { ELIG_KEY, ELIG_NAMESPACE } from "./records";

export { ELIG_KEY, ELIG_NAMESPACE };

export const CHECKOUT_DISCOUNT_MESSAGE = "MergeShip: free shipping on your next order";

/** The merge window must span at least one full shop-local calendar day
 *  for an eligibility record to exist at all (expiryDateFor). Shops whose
 *  merge window is 1/6/12 h cannot use this feature — the gate reports
 *  `window-unsupported`. */
export const MIN_CHECKOUT_WINDOW_HOURS = 24;

/** The Function ignores records whose `win` differs from the discount
 *  config's `windowId`, so the id is derived from the shop's enable epoch:
 *  re-enabling (a fresh epoch) rotates the window and stale eligibility
 *  from a previous epoch can never grant again. */
export const checkoutDiscountWindowId = (enabledAt: Date): string =>
  `w${enabledAt.getTime()}`;

/** Max records kept in one customer's eligibility document. */
export const MAX_RECS = 5;
