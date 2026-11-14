# E3 attribution — why the first guest run showed free Standard shipping

Store: ms-checkout-spike-1111 (spike app only). No orders placed. All values sanitized (no emails, no checkout URLs).

## Finding
The "guest received the discount" result on 2026-11-12 was NOT a MergeShip authorization defect.
The cart used ($629.95 Multi-managed Snowboard, variant 68100324327791) already gets **native free Standard shipping**
from the store's own shipping rates (price threshold; delivery profiles are not readable with the spike's scopes, so the
exact threshold is unknown but lies between $24.95 and $629.95).

## Evidence
| # | Cart | Spike discount | Eligibility record | Viewer | Standard shown |
|---|------|----------------|--------------------|--------|----------------|
| 1 | $629.95 | active | none (Admin readback `recs: []`) | guest, customer's email | FREE (native) |
| 2 | $629.95 | EXPIRED (deactivated) | none | guest, customer's email | FREE (native) |
| 3 | $24.95 (variant 68100323508591) | EXPIRED | none | guest, customer's email | $8.00 |
| 4 | $24.95 | active | none | guest, customer's email | $8.00 |
| 5 | $24.95 | active | present (method `standard`, test address) | signed-in customer | $8.00 -> FREE, "MERGESHIP SPIKE: SHIPPING DISCOUNT", savings $8.00 |
| 6 | $24.95 | active | present | guest, customer's email, "Sign in" link shown | $8.00 (no discount) |
| 7 | $24.95 | active | present | guest, never-seen email | $8.00 (no discount) |

Files: `e3-attrib-*.json`, `INVALID-original-e2-e3/e3-signed-in-control.json`, `INVALID-original-e2-e3/e3-guest.json` (the invalid first run), `orders-audit.json`,
`variants-audit.json`, `store-discounts-audit.json`, `discount-state-*.json`.

## Corrections to earlier reports (retractions)
* **E2 latency table is INVALID.** Orders #1011-#1036 (all 26 campaign trials) used the $629.95 cart where Standard was
  natively $0.00 (`orders-audit.json`: `Standard:0.0->0.0`), so there was nothing for the Function to discount and the
  "~72 s T3->T4" figure does not measure Function visibility. E2 must be re-run on a cart below the native free-shipping
  threshold, with the corrected price parser (it must read the struck-through original AND the final price).
* **E3 signed-in control and first guest run (snowboard cart) are INVALID** for the same reason.
* **E1 (matching/negative matrix) and E6 (orders #1001/#1002) remain valid**: they used the $9.95 cart (Standard $8.00).
* Seeding pitfall (my error): `seed-eligibility.ts` defaulted the method to `Standard Shipping`, but the Function compares
  the normalized delivery option title (`standard`) for exact equality. Use `SPIKE_METHOD=Standard`.
* Test-harness pitfall: re-writing cookies (`FRESH_CART`) can break the signed-in session; use `CART_CLEAR=1`
  (`/cart/clear`) for a fresh cart instead.

## Not established
* Function inputs (`isAuthenticated`, customer object, `ship_elig`, operation) were NOT inspected: `shopify app logs` was
  removed in CLI 5.0 and Function run logs are only in the Dev Dashboard UI behind the founder's sign-in. Guest behaviour is
  inferred from checkout output only (cases 6 and 7).
* Whether Shopify ever reports `isAuthenticated=true` for an unauthenticated checkout with a known email: not observed.
