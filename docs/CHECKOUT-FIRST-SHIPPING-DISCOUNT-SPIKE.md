> **E2/E3 INVALIDATION NOTICE (2026-11-13):** the original live E2 latency campaign and the first live E3 guest run are INVALID (native free Standard shipping on the $629.95 cart; synthetic seeding). The claimed ~72 s propagation figure is retracted and the guest result was NOT an authorization defect. Valid live evidence: E1 matrix, E6 orders #1001/#1002, and the controlled attribution runs. See docs/evidence/checkout-first/e3-attribution.md and docs/evidence/checkout-first/INVALID-original-e2-e3/README.md.

# Checkout-first shipping discount — feasibility spike

Branch `spike/checkout-first-shipping-discount`, baseline `8178caf`. Offline only: no deploy, no Shopify
contact, no orders, no production data, no change to the refund engine (`app/`, `prisma/`, `scripts/`
untouched). Everything new is under `spikes/checkout-shipping-discount/` plus
`tests/spike-checkout-shipping-discount.test.ts`.

## 1. Verdict: MODIFY

A checkout-time shipping discount **works for signed-in customers** and is the right primary mechanism.
It does **not** work for guest checkout (Shopify gives the Function no customer), and per-customer expiry
is **day-granular**, not instant. The design must be narrowed to what the platform can actually do:

| Claim in the brief | Finding |
|---|---|
| Target `cart.delivery-options.discounts.generate.run` exists | Verified, API 2026-04 and 2026-10 (query validated against both schemas). |
| Public app can read a customer metafield in that Function | Verified in schema: `cart.buyerIdentity.customer.metafield(namespace,key){jsonValue}`; `$app` resolves to the app's reserved namespace. Combined with `deliveryGroups`, `deliveryAddress`, `deliveryOptions`, `discount.metafield`, `shop.localTime` in ONE valid query. |
| Works for guests | **No.** `customer` is `null` unless the buyer is signed in (`isAuthenticated`). |
| Exact per-record expiry | **No.** Function has no clock; only `shop.localTime.date` (day) and `dateTimeBetween/After/Before` with arguments that are static per discount. |
| Works across ordinary plans | **Yes, if MergeShip is a public App Store app.** Custom apps with Functions are Shopify Plus only. |
| Needs live proof | **Yes** for five runtime behaviours (section 11); none can be shown offline. |

Not BLOCKED: nothing found prevents the signed-in path. Not PROCEED: the guest gap and the unverified runtime
behaviours change the product promise and need dev-store evidence first.

## 2. Verified facts (with source)

- Input schema fields and types: validated with the Shopify AI Toolkit validator, `functions_discount` @2026-04 and @2026-10 — `Overall Status: VALID`.
- Guest = null customer: Shopify's published `BuyerIdentity` schema text ("If the customer isn't authenticated, then the `customer` field returns `null`") and a Shopify staff reply (community.shopify.dev, 2 Jun 2026: "for a guest checkout that field is `null`. It only populates once the buyer is signed in").
- `buyerIdentity.email` exists for guests but is unauthenticated and spoofable (known community report of buyers typing a qualifying customer's email). The prototype deliberately never uses it.
- Functions are pure: no network, clock or randomness (`shopify.dev/docs/api/functions`). Discount Function `fetch` target is Enterprise-only and unavailable on dev stores — not used.
- A failing run discards its output and checkout continues undiscounted (no `blockOnFailure`) — a Function bug fails open to "no discount", never blocks checkout.
- Limits: 25 active discount Functions per store; Functions run concurrently with no knowledge of each other.
- Plan availability: "Stores on any plan can use public apps distributed through the Shopify App Store and contain functions. Only stores on a Shopify Plus plan can use custom apps that contain Shopify Function APIs." (`shopify.dev/docs/apps/build/functions`).
- Accelerated checkout (Apple/Google Pay): Function runs first with a partial address (`countryCode`, `provinceCode`, `city`, `zip` only), again with the full address after authorization (documented for delivery customization; the discount page lists accelerated checkout as supported).
- `metafieldsSet` supports compare-and-set (`compareDigest`, 2024-07+); `null` digest = create only if absent; mismatch returns `STALE_OBJECT`.
- Scopes: `metafieldsSet` on a customer needs `write_customers`; `discountAutomaticAppCreate` needs `write_discounts` (doc text "Requires write_discounts access scope"); Function run details need scopes derived from the input query fields; customer name/address/phone/email fields are protected customer data Level 2 (public apps: Partner Dashboard review; allowed on dev stores in the same Partner org until reviewed).
- Existing app (`shopify.app.toml`): scopes `read_customers,write_order_edits,write_orders,write_products`; Admin API pinned `ApiVersion.April26` (2026-04); webhooks block says `2026-10` (pre-existing mismatch, unrelated). **Missing for this feature: `write_customers`, `write_discounts`.**
- Admin evidence query (order shipping lines, discount allocations, discount applications) validated VALID @2026-04 — see section 8.

## 3. What was built

`spikes/checkout-shipping-discount/` (isolated; a static test asserts nothing imports from `app/`):

- `extension/shopify.extension.toml`, `src/*.graphql`, `src/cart_delivery_options_discounts_generate_run.ts`, `src/dest-key.ts` — the Function, dependency-free ES2020.
- `projection/records.ts`, `write.ts`, `grant.ts`, `fake-admin.ts`, `projection-read.graphql`, `projection-write.graphql` — record building/merging/consumption, CAS writer, grant detector, CAS-faithful fake Admin client.
- `tests/spike-checkout-shipping-discount.test.ts` — 55 offline tests, all passing; full `npm test` still green; no new `tsc` errors (the 7 known ones are unchanged); ESLint clean.

Function rules (all must hold, otherwise `{operations: []}`): SHIPPING class; config `v1` with decimal percentage in (0,100]; `shop.localTime.inWindow`; **authenticated non-null customer**; **exactly one delivery group**; non-null destination key; a record with matching `win`, `exp >= today`, `left > 0`, destination, currency and a SHIPPING option with the same normalized title. Exactly one record, one candidate, `selectionStrategy: FIRST`, targeting only the matching option handle(s).

## 4. Eligibility data and lifecycle

Customer metafield `$app:ship_elig` (json):

```json
{ "v": 1, "recs": [ { "id": "<order numeric id>", "win": "<windowId>", "dest": "<country|province|zip|city, normalized>",
  "method": "<normalized shipping title>", "cur": "USD", "left": 1, "exp": "YYYY-MM-DD", "used": ["<order id>"] } ] }
```

Discount metafield `$app:config` `{v,windowId,percentage,message}`; variables metafield `$app:window` `{windowStart,windowEnd}` (shop-local `DateTimeWithoutTimezone`) feeds `dateTimeBetween`.

Lifecycle: (1) `orders/create` for a qualifying paid, uncancelled, single-shipping-line order with a customer → `buildRecord`; (2) `writeProjection` merges into the metafield (read digest → `mergeRecords` → `metafieldsSet` with `compareDigest`; no write when byte-identical; jittered retry on `STALE_OBJECT`; typed `ProjectionConflictError` after N tries so webhook redelivery takes over); (3) the second checkout reads it; (4) the discounted order's `orders/create` calls `consumeRecord(recordId, byOrderId)` (idempotent per consuming order); (5) expired / exhausted records are pruned on the next write; consumed records keep a tombstone until `exp` so a replayed webhook cannot resurrect them.

Source of truth for production should be an app DB row per (shop, customer, source order) with the metafield as a deterministic projection rebuilt from it; the spike proves the projection and CAS behaviour, not that table.

## 5. Race analysis: first order confirmation → second checkout

1. **Projection lag (the main unknown).** Webhook delivery + Admin write + propagation to Function input. Unmeasured; a buyer who starts a second checkout within seconds may see no discount. Safe failure (no discount, never a wrong one). Measured in experiment E2.
2. **Concurrent webhooks for the same customer.** Handled: CAS + merge-by-id; tests force the collision and assert one retry and no lost update.
3. **Webhook replay.** Handled: existing ids never reset `left`; `consumeRecord` is idempotent per consuming order.
4. **Parallel checkouts using one record.** NOT preventable: Functions are stateless and cannot reserve. Exposure is bounded by `left` × the shipping fee per parallel checkout; settled after the fact when `consumeRecord` runs, and surplus grants are visible by `detectShippingDiscountGrant`. Accept or cap per customer; cannot be eliminated at checkout.
5. **Metafield edited by a merchant/another app.** `$app` namespace is app-owned (view-only in admin by default); CAS detects a concurrent change; garbage is treated as empty by both Function and projection.

## 6. Time and drop-window expiration

- Window boundary: one automatic discount per window; `dateTimeBetween(windowStart, windowEnd)` evaluated in shop time zone (deterministic, no clock needed). Shopify's own `startsAt`/`endsAt` on the discount node are a second, independent boundary (UTC ISO).
- Per-customer expiry: day-granular via `shop.localTime.date` vs `exp` (inclusive). A mid-day, per-customer expiry cannot be expressed; use a window discount for time-of-day precision.
- Limits to test, not assume: `DateTimeWithoutTimezone` across DST gaps/overlaps; delay between `endsAt` and the Function seeing it; whether a checkout that was priced before the boundary is re-priced at submit (E4).
- Decision: expiry is evaluated at checkout price time. A buyer who prices a cart before the boundary and pays after it may still receive the discount unless Shopify re-runs Functions at submission (E4 decides).

## 7. Scenario matrix

| Scenario | Result | Why |
|---|---|---|
| Signed-in customer, matching address and method | Discounted | Happy path. |
| Guest checkout (even with a known email) | **No discount** | `customer` is null; email spoofable, deliberately unused. |
| Accelerated checkout (Apple/Google Pay, Shop Pay) | **Unproven** | Partial address before authorization; customer identity depends on whether the buyer is signed in. Missing zip/city ⇒ no discount (never wildcard). Needs E3. |
| Different destination | No discount | `dest` mismatch. |
| Different shipping method | No discount on the other method | Only options with the first order's normalized title are targeted. |
| Split delivery groups / mixed pickup+shipping | No discount | Exactly-one-group rule; MergeShip's own engine needs exactly one shipping line. |
| Another discount (code or automatic) | Merchant combination rules decide | Our discount is a SHIPPING-class candidate; stacking governed by `combinesWith.shippingDiscounts` on both nodes. Untested conflict outcomes: E5. |
| Merchant free-shipping automation already applies | Likely redundant | A second shipping candidate may not stack; E5. |
| `exp` day equals today | Eligible | Inclusive. |

Known coarsening: the Function can see delivery title and method type but not the carrier code/source the merge engine uses in `shippingSignature`, nor the recipient name/`address1` in partial-address mode. Checkout eligibility is therefore deliberately broader than merge eligibility; the later merge decision (and refund fallback evidence check) remains the authority for combining.

## 8. "Shipping discount already granted" — so the fallback never pays twice

Evidence available on the placed order (query validated): `shippingLines.discountAllocations`, `originalPriceSet − discountedPriceSet`, `discountApplications` (`targetType = SHIPPING_LINE`, `AutomaticDiscountApplication.title`). `detectShippingDiscountGrant` returns `{granted, grantedMinor, evidence: ALLOCATION|PRICE_DELTA|NONE, ambiguous}`; ambiguous (a shipping price delta not attributable to our title token) means **treat as granted**.

Existing refund engine today already computes its target from the **discounted** shipping price (`app/lib/shipping-shadow.server.ts`, "What the customer actually paid for shipping is the DISCOUNTED price"). Consequences:
- 100% checkout discount ⇒ shipping paid = 0 ⇒ nothing refundable; no double payment possible.
- Partial discount ⇒ the fallback would still refund the *remaining paid* shipping. If the product promise is "one shipping benefit per combine", the fallback must instead SKIP any order for which `granted` is true. That is a refund-engine change and is **not made here**; it is the smallest recommended follow-up (one new SKIP reason before planning, consulting the detector).
- The refund can never exceed shipping actually paid, so a double payment of more than the fee cannot occur either way.

Unknown until E6: which string Shopify exposes as the application `title` for a Function-generated discount (message vs discount title). The detector therefore has the fail-safe PRICE_DELTA path.

## 9. Independence from the combine engine

- The checkout discount reads only the customer metafield, the cart and the discount config. It does not call, wait for, or depend on `executeMerge`, claims, locks or the shipping-refund tables.
- The fallback refund keeps requiring independent combine evidence (`assessSecondaryEvidence` / merge records) exactly as today; the discount never creates or implies combine evidence, and a discounted order that is never merged is simply a discounted order.
- Neither system writes the other's state. The only shared artifact is the order's shipping-line facts, read-only.

## 10. Blockers and smallest alternatives

| Blocker | Evidence | Smallest alternative |
|---|---|---|
| Guest checkout has no customer | Shopify schema text + staff reply | Require/encourage sign-in (customer accounts) for the offer; or a unique single-use discount code per eligible customer, emailed after order 1 (works for guests; not automatic; needs `write_discounts`; one code node per record). |
| Instant per-customer expiry impossible | No clock in Functions; `localTime.date` is day-granular | Day-granular `exp` plus a window discount for time-of-day. |
| Parallel checkouts can overspend one record | Functions stateless | Accept bounded exposure (`left` × fee) or cap grants per customer per window. |
| New scopes needed | Section 2 | Add `write_customers`, `write_discounts` (merchant re-consent); Level 2 protected-data review for address fields (dev store exempt). |
| Distribution | Custom apps need Plus | Must be the public App Store app for non-Plus merchants (distribution mode of the production client not verified here). |

## 11. Measurable dev-store experiment plan (needs authorization, not run)

**Required authorization (exact):** a NEW Partner-dashboard development app (its own `client_id`, never `04b77142ce8ad421f49735b05c7d0a86`) installed on a NEW development store in the same Partner organization, with a separate `shopify.app.spike.toml`; scopes `read_customers, write_customers, write_discounts, read_discounts, write_orders` (+ protected customer data Level 2 on the dev store); `shopify app dev` / `deploy` allowed ONLY against that dev app; bogus-gateway test orders on that dev store only. No production store, no production app version, no real payment.

| # | Question | Procedure | Pass criterion |
|---|---|---|---|
| E1 | Does the Function run and read the customer metafield, buyer, address, groups, window? | Deploy spike to dev app, create automatic discount with config + window metafields, seed `ship_elig` on a customer, run signed-in checkout. | Discount appears on the matching option only; Function log shows non-null customer + record. |
| E2 | Projection → checkout latency | Place order 1, record t0; fire `writeProjection`; poll checkout every 1 s until discounted (or via Function logs). 30 trials. | Report p50/p95; PROCEED needs p95 below the product's stated "second checkout" delay. |
| E3 | Guest / accelerated / Shop Pay identity | Guest checkout (known email), Apple Pay/Google Pay simulator, Shop Pay, signed-in classic and new customer accounts. | Record per path: `isAuthenticated`, `customer` null?, address fields present before/after authorization, discount shown, total charged vs total displayed. |
| E4 | Time boundaries | Discount with 3-minute window; price a cart 30 s before end, submit 30 s after; same at DST gap/overlap in a DST shop timezone; `startsAt`/`endsAt` propagation delay. | Document whether submit re-runs the Function; measure boundary skew (s). |
| E5 | Combination conflicts | Entered code (non-combining and combining), merchant free-shipping rule, second automatic discount. | Which wins/stacks per `combinesWith` settings; no negative shipping, no double discount. |
| E6 | Grant evidence on the order | Complete a discounted order; run the validated Admin order query. | `discountApplications` title/shape for a Function discount; `detectShippingDiscountGrant` returns `granted` with `evidence` ALLOCATION (or documents the PRICE_DELTA fallback). |
| E7 | Split groups & pickup | Cart with two shipping profiles; shipping + pickup. | Zero discount; Function log shows `deliveryGroups.length > 1`. |
| E8 | Runtime parity | Run `shopify app function build/run` with fixtures on the dev app; compare against offline outputs, including `String.prototype.normalize("NFKD")` and non-ASCII city. | Byte-identical output; if `normalize` is absent, switch `normText` to fail-closed ASCII (non-ASCII destinations simply get no discount). |

## 12. Not verifiable offline (explicit)

Javy/QuickJS runtime behaviour (`String.prototype.normalize`), `DateTimeWithoutTimezone` runtime evaluation and DST handling, projection latency, accelerated/guest/Shop Pay identity in real checkout, combination outcomes, the order-side `title` of a Function discount, whether submit re-runs Functions, and whether the production client is a public App Store app. All are listed above with the experiment that settles them.

## 13. Recommendation

**MODIFY.** Build checkout-first for signed-in customers with day-granular expiry and a one-delivery-group rule; keep the refund fallback for everyone else (guests, accelerated checkout, split carts), and add the single follow-up SKIP-if-granted check to the refund engine under separate review. Run E1–E3 and E6 first; they decide whether the signed-in path is commercially useful (E2, E3) and how the fallback must recognize grants (E6).
