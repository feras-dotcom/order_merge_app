# Checkout-first shipping discount: integration architecture

Status: implementation branch for independent review. NOT merged, NOT deployed, feature OFF for every merchant.
Baseline: `8178caf` (shipping recovery line). Validated spike: `94b6166` (branch `spike/checkout-first-shipping-discount`).
Evidence behind the mechanism: `docs/evidence/checkout-first/` on the spike branch (`e2-recovery.md`, `e1-matrix.json`, `e6-*`).
The earlier ~72 s propagation figure is INVALID (native free-shipping cart) and is not used anywhere.

## 1. What the mechanism is

1. A real paid order for customer C (address A, shipping method M) is projected into a record in C's customer metafield `$app:ship_elig`.
2. A native automatic shipping-discount Shopify Function reads that metafield at checkout. For a signed-in C with the exact same destination
   key and shipping method it discounts M. Guests never match (`buyerIdentity.isAuthenticated` must be true).
3. When the discounted order is placed, its own `orders/paid` event consumes the record.
4. The second order is then merged into the first by the existing merge engine; shipping was never paid twice, so no refund is needed.

## 2. Integration audit (read-only findings, baseline `8178caf`)

| Area | Finding | Consequence |
|---|---|---|
| `orders/create` route | Gated on `Settings.autoMergeEnabled` + onboarding. Inserts a leased `ProcessedWebhook` row keyed `(shop, orderId)`, acks, optionally processes inline. Sweeper (`background-worker.server.ts`) re-claims expired leases. | Durable, idempotent pattern to copy. Do not touch. |
| `ProcessedWebhook` | Unique `(shop, orderId)`; every PENDING row is claimed by `claimDue` and driven by `processOrderWork`, which runs the MERGE. Outcomes are merge outcomes. | **Cannot be reused for `orders/paid`.** Same order id would collide with the `orders/create` row, and any extra row would be claimed by the merge processor. |
| New durable path | Needed, but only ONE small table and a store/processor mirroring the existing pattern (same lease helpers: `withOwnershipTx`, `DB_WALL`, `dbWallPlus`, `LEASE_TTL_MS`, `newLeaseToken`). The existing sweeper gets one extra guarded step. No second worker framework. | Decision D1 below. |
| Merge eligibility rules | `orderStateIneligibility` (paid, open, UNFULFILLED, no fulfillments, LOW risk, supported currency, has customer) and `resolveMergeLocation` (location rule) in `eligibility.ts` / `merge.server.ts`. `buildAddressKey` / `normalizeShippingTitle` define "same address / same method". | Reuse these for "a compatible shipment can reasonably be established". The Function's destination key is a strict copy of `buildAddressKey` minus the customer slot. |
| Settings / gates | `Settings` per-shop booleans with epochs written only by dedicated setters (`setShippingAdjustmentEnabled`); `AppControl` singleton with kill switches and an INVERTED allowlist for shipping (empty = no shops); env `MERGESHIP_MUTATIONS`. | Mirror this exact pattern for the new flag. |
| Refund engine | `shipping-refund-*` consumes `ShippingAdjustment` rows of COMPLETED v2 merges and reads fresh Shopify evidence of shipping actually paid. | Untouched. `detectShippingDiscountGrant` is provided but NOT wired into the engine (see limitations). |
| Scopes / webhooks | `shopify.app.toml`: `read_customers,write_order_edits,write_orders,write_products`; webhooks `orders/create`, `app/uninstalled`, `app/scopes_update`. | New needs: `write_customers`, `write_discounts`, topics `orders/paid`, `orders/cancelled`, `orders/fulfilled`, `orders/partially_fulfilled`. `shopify.app.toml` is deliberately NOT edited on this branch (a `shopify app deploy` would push scopes/topics/Function); the required diff is documented in section 7. |
| Production `main` divergence | `origin/main` (`07773b5`, deployed) does NOT contain `8178caf`: it carries three commits not in the recovery line (dual-secret webhook validation `webhook-auth.server.ts`, offline-token migration). | New webhook routes call ONE shared helper so switching to `webhook-auth` after reconciling the two lines is a one-line change. |

## 3. Decisions

**D1. One new table `CheckoutEligibilityWork`, level-triggered reconciliation.** Each webhook (paid, cancelled, fulfilled, partially_fulfilled) only marks the
order "dirty": upsert on `(shop, orderId)` with `gen = gen + 1`, `status = PENDING`. The processor never trusts the payload or the topic: it loads the order fresh and
reconciles the desired state, so duplicates, reordering, delayed payment and restarts all converge. Completion is conditional on `gen` still equal to the generation
that was processed; a newer event that arrived mid-processing re-queues instead of being lost. The row stores only shop, order GID, outcome codes: **no PII**.

**D2. Gate (all must hold, checked at the webhook AND again in the processor; any failure = no write, row DONE `FEATURE_OFF`):**
env `MERGESHIP_CHECKOUT_DISCOUNT === "enabled"` AND `AppControl.checkoutDiscountEnabled` AND shop in `AppControl.checkoutDiscountAllowShops` (inverted: empty = NO shops)
AND `Settings.checkoutDiscountEnabled` with `checkoutDiscountEnabledAt` set AND `autoMergeEnabled` AND onboarding complete.
The discount is only worth giving when the merge engine will merge the second order, hence the merge-setting dependency (it does NOT require a completed merge).
`checkoutDiscountEnabledAt` is an enable epoch (stamped on the DB clock only by `setCheckoutDiscountEnabled`): orders created before it never produce records.
Defaults: all OFF. Uninstall resets the per-shop flag and epoch.

**D3. Desired-state rule for one order (processor `classify`):**
- CONSUME: the order carries the MergeShip shipping grant (`detectShippingDiscountGrant`, title token = `CHECKOUT_DISCOUNT_MESSAGE`, evidence ALLOCATION) and is not cancelled.
  The matching record in the customer's document is consumed for this order id (idempotent via `used`). A consumer order NEVER issues a record (no free-shipping chains).
  No matching record with `left > 0` = diagnostic `OVERDRAW` (the signature of simultaneous checkouts, see 5).
- ISSUE: `orderStateIneligibility` is null AND the location rule holds AND exactly one shipping line with original and discounted price > 0 AND no ambiguous shipping delta
  AND `createdAt >= enabledAt` AND now < `createdAt + mergeWindowHours` AND destination key (all nine fields incl. first/last name) is non-null.
  Record: `{id, win, dest, method, cur, left: 1, exp}`; `mergeRecords` lets an existing record win on `left`, so a replay can never reset a consumed grant.
- NOT ELIGIBLE (cancelled, closed, fulfilled/partially fulfilled, refunded, unpaid, risk not LOW, window passed, refused by rule): ensure the record is ABSENT
  (revoke an unused record; a used record stays as a `left = 0` tombstone until `exp`).
- RETRY (evidence not yet available: risk level still null, search/fulfillment data incomplete, Admin throttling/5xx, CAS conflict after retries): record unchanged, transient backoff.
  A transient state is NEVER treated as ineligible, so it can never revoke by accident.

**D4. Expiry (conservative, never longer than the merge window).** `exp` is a shop-local calendar date (the Function compares dates). `exp = localDate(createdAt + mergeWindowHours) - 1 day`,
floored at `localDate(createdAt)`. Effective lifetime is between `window - 24h` and `window`: it under-promises rather than lets a discount outlive the merge window. Shop timezone from `shop { ianaTimezone }`.
Records are capped at 5 per customer, expired and fully consumed records are pruned on every write.

**D5. Metafield writes** use `metafieldsSet` with `compareDigest` (real compare-and-set), re-read and retry on `STALE_OBJECT` with jittered backoff (5 tries), then a post-write read-back must show
the expected state before the work row is marked DONE. A failed or unverified write is a retry, never a success.

**D6. Diagnostics.** Structured one-line JSON events (`evt: "checkout_elig"`, shop, order GID, `kind` in PROJECTED / REFUSED / REVOKED / CONSUMED / OVERDRAW / NO_RECORD / RETRY / FAILED / FEATURE_OFF,
`code`, attempts, duration) through an injectable sink, plus `outcome`/`lastReason` persisted on the work row. Never addresses, names, e-mails or tokens.

**D7. Name matching stays maximally conservative.** The destination key includes first name, last name and company, exactly like merge. Consequence: a legitimate repeat purchase gets no discount if
the second checkout uses a different recipient name or spelling ("Jon" vs "Jonathan"), a company on one order only, a different unit/apartment line, or punctuation that survives normalisation differently.
It fails closed (full shipping, no financial exposure). It mirrors merge, which would not merge differently-addressed shipments anyway. Relaxing it needs evidence from a pilot.

**D8. The Function is not an extension on this branch.** Source lives in `functions/checkout-shipping-discount/` (outside `extensions/*`, so Shopify CLI does not discover or deploy it).
It is a validated copy of the spike Function with `selectionStrategy: "ALL"`. The strict regression test validates its output against a trimmed copy of Shopify's published
Function schema and fails on `"FIRST"`.

## 4. Files (for review)

See the final report / `git diff 8178caf..HEAD --stat`. Core: `app/lib/checkout-discount/*`, `prisma/schema.prisma` + migration, `app/lib/settings.server.ts`,
`app/lib/background-worker.server.ts` (one guarded step), four tiny webhook routes, `functions/checkout-shipping-discount/*`, tests `tests/checkout-discount-*.test.ts`.
Merge engine, refund engine, `order-work*`, `orders/create` route: unchanged.

## 5. What the Function CANNOT do (stated plainly)

A Shopify Function is stateless and read-only. It cannot atomically consume a one-use entitlement. Two simultaneous checkouts by the same signed-in customer both see `left = 1` and both are discounted
(measured on the spike store). Consumption happens only after an order exists (its `orders/paid` event). The record is consumed once, the second order is recorded as `OVERDRAW`, and the extra shipping
discount is a real cost to the merchant. Exposure per entitlement: one extra shipping charge per additional simultaneous checkout the customer manages to complete inside the propagation window.
Mitigations that DO exist: one record per paid order, short expiry, signed-in only, exact destination/method match, global/per-shop kill switches, deactivating the automatic discount.

## 6. Known limitations and financial exposure

| # | Limitation | Measured / basis | Exposure |
|---|---|---|---|
| L1 | One-use is NOT atomically enforceable at checkout (section 5). | Spike: two simultaneous checkouts both discounted. | One extra shipping discount per additional simultaneous completed checkout per entitlement. Detected afterwards as `OVERDRAW` (`CONSUMED_NO_RECORD`). |
| L2 | Propagation lag order paid -> discount visible. | Spike (valid re-run, 3 real orders): webhook 3.4-4.1 s, handler ~1.2 s, discount visible within the first checkout page load after the write (<= ~5.4 s, upper bound dominated by page-load time). About 11 s worst-case in a clean pipeline. | A buyer who re-checks out inside ~11 s sees full shipping: harmless (under-discount). |
| L3 | Revocation lag (cancel / fulfil / window end). | Direct trials: every checkout page load started after the clear showed baseline. NOT tested: a checkout page already rendered and then paid without reload after revocation. | At most one shipping charge per record. |
| L4 | Consumption is not restored when the consumer order is cancelled. | Design choice (fail closed). | Customer loses one discount; no merchant loss. |
| L5 | Discount is granted at checkout, the merge happens later. If the second order cannot be merged (first order fulfilled meanwhile, hold, location change, merge failure) the merchant bears the second order's shipping. | Records only for unfulfilled / paid / LOW-risk orders inside the window; revocation on cancel/fulfil topics; expiry <= merge window. | Up to `percentage x shipping price` per consumed entitlement whose merge does not complete. Monitor `orders with grant but no MergeRecord`. |
| L6 | Signed-in buyers only. Guests are never discounted (`isAuthenticated`), wallets (Shop Pay / Apple Pay / Google Pay) UNTESTABLE on the dev store. | Spike E3 (valid attribution run). | Lost conversions, not losses. |
| L7 | Exact name/company/address-line matching (D7). | Mirrors merge. | Legitimate repeat customers with a different recipient name, spelling, apartment line or a company on one order only get no discount. |
| L8 | Same shipping-method title required. Renaming a shipping rate between the two orders silently disables the match. | `normalizeShippingTitle` equality. | None (fail closed). |
| L9 | Residual stale-worker window. Lease is renewed immediately before each CAS write, and completion is fenced on `gen`, but a worker that stalls between `renew` and the write could still write a decision based on older state. | Lease TTL 90 s; record expiry <= window. | Bounded by the record lifetime. |
| L10 | The refund engine is untouched and `detectShippingDiscountGrant` is not wired into it. The engine reads fresh Shopify evidence of shipping actually paid, so a fully discounted shipping line leaves nothing to refund and a partial discount leaves the remainder refundable (E6 evidence on the spike store: #1001 8.00 -> 0, allocation 800; #1002 8.00 -> 4.00, allocation 400). This integration did not re-test that interaction and an explicit refund-engine test is a pre-pilot item. | Spike E6; no code change here. | Potential double benefit if the engine ever refunds shipping that the checkout discount already waived. Verify before pilot. |
| L11 | Not wired: nothing creates, updates or deactivates the Shopify automatic discount, and there is no merchant UI. Operators use `scripts/app-control.ts --checkout ...`, `setCheckoutDiscountEnabled` and the documented discount procedure. | Scope of this milestone. | n/a |
| L12 | No cleanup tool for stale eligibility metafields. Records expire (<= merge window) and are pruned on the next write; the fast kill is deactivating the discount. | | Stale records grant nothing once the discount is off. |

Data protection: the work table stores shop, order GID and outcome codes only. The destination key (normalised name + address) lives in the customer's own metafield on the
merchant's store and is deleted by Shopify with the customer. No names, addresses, e-mails or tokens enter logs or diagnostics (asserted by tests).

## 7. Deployment readiness (NOTHING below has been done; production is untouched)

### 7.1 Production public-app distribution eligibility: OUTSTANDING VERIFICATION
Shopify: stores on any plan can use Functions only from **public apps distributed through the Shopify App Store** (an unlisted / limited-visibility listing counts); custom apps with Functions require Shopify Plus.
The code runs in `AppDistribution.AppStore` mode, but the actual distribution method and App Store review state of client `04b77142...` live in the Dev Dashboard and could not be verified from the repo or without
dashboard access. Required before any pilot: confirm Distribution = public (listed or limited visibility) for the production app. A new app version containing a Function and new scopes may require Shopify review before release.

### 7.2 Additional scopes and merchant re-authorization
Needed: `write_customers` (customer metafield `metafieldsSet`), `write_discounts` (create/deactivate the automatic app discount). Order read access already exists (`write_orders`); the optional location scopes already exist.
Recommended: declare both as `optional_scopes` (same mechanism as the existing location scopes) so only the pilot merchant is prompted and no other install is affected; the app requests them in-context for the pilot shop.
If they were added as required `scopes`, every installed merchant would be prompted to re-approve on next open. Webhook topics to add: `orders/paid`, `orders/cancelled`, `orders/fulfilled`, `orders/partially_fulfilled`.
Required `shopify.app.toml` change (NOT applied on this branch, because `shopify app deploy` pushes scopes, topics and extensions together):
```toml
[access_scopes]
optional_scopes = [ "read_merchant_managed_fulfillment_orders", "read_locations", "write_customers", "write_discounts" ]

  [[webhooks.subscriptions]]
  uri = "/webhooks/orders/paid"
  topics = [ "orders/paid" ]
  [[webhooks.subscriptions]]
  uri = "/webhooks/orders/cancelled"
  topics = [ "orders/cancelled" ]
  [[webhooks.subscriptions]]
  uri = "/webhooks/orders/fulfilled"
  topics = [ "orders/fulfilled" ]
  [[webhooks.subscriptions]]
  uri = "/webhooks/orders/partially_fulfilled"
  topics = [ "orders/partially_fulfilled" ]
```
Reconcile first with production `main` (`07773b5`), which does not contain this line: its routes use `webhook-auth.server.ts` (dual-secret validation); the new routes must call the same helper.

### 7.3 Protected customer data
The pipeline needs customer data including **Name and Address** (Level 2): `Order.shippingAddress.firstName/lastName/...` in the processor, and the delivery-address fields inside the Function at checkout.
Public apps need Shopify's protected-customer-data review for those fields; dev stores do not. Observed on the spike app: with Name not enabled the Admin API returned `ACCESS_DENIED` for first/last name; enabling Name fixed it (read-only check on order #1037).
In this integration that failure is loud and safe: the order load throws, the work item retries and ends in REVIEW, and no record is written. Whether the production app's existing PCD approval covers Name and Address for these uses, and whether the Function's delivery-address
fields are unredacted in production checkout, is OUTSTANDING VERIFICATION (if redacted the destination key is null and the Function fails closed: no discount).

### 7.4 Safest Function deployment procedure
1. Develop and rehearse in a dev workspace only (the isolated spike app and store are the template). Copy `functions/checkout-shipping-discount/` into that workspace's `extensions/`. The `deploy` command deploys EVERYTHING in the project and REMOVES extensions that are absent locally, so never run it from the production workspace until the final step.
2. Build, run the repo tests (strict output-shape test) and the parity run against the built wasm.
3. Deploy to the dev app, then run the real-checkout smoke test (7.5) on the dev store.
4. For production: `shopify app deploy --no-release` with a `--message` naming the commit (creates a version, releases nothing), verify the version contents in the Dev Dashboard (scopes, webhooks, exactly one new Function), obtain any required Shopify review, then `shopify app release --version <name>` during a quiet period.
5. The Function does nothing until an automatic app discount that references it exists. Create that discount only for the pilot shop, with the config in `functions/checkout-shipping-discount/README.md` and `message === CHECKOUT_DISCOUNT_MESSAGE`; keep it deactivated until the gate levers are set.

### 7.5 Real-checkout smoke test (mandatory for EVERY Function deployment, including re-deploys of identical code)
On a development store with the same app version: below-native-free-shipping cart ($8 Standard / $15 Express), signed-in test customer.
(a) no record: Standard $8. (b) write a valid record (or place a real paid test order and let the webhook project it): a fresh checkout must show the exact `CHECKOUT_DISCOUNT_MESSAGE` AND Standard `$8.00 -> 0` with Express unchanged; both are required, and generic FREE, struck prices or a single text match never count.
(c) different street, other customer, or guest: no discount. (d) clear the record: baseline returns.
Offline tests do NOT prove the Function executes: the `selectionStrategy: "FIRST"` bug passed every offline test and Shopify silently discarded the result. The harness used on the spike branch (`spikes/.../experiments/signal.ts`, `e2-direct.ts`) is the reference; porting it into `scripts/` is a follow-up.

### 7.6 Rollback and kill switches (fastest first)
1. **Deactivate the automatic app discount** (`discountAutomaticDeactivate`): instant, stops ALL discounting regardless of metafields or app state. This is the primary kill switch.
2. **Change the discount config `windowId`** (or `MERGESHIP_CHECKOUT_DISCOUNT_WINDOW`): every existing record stops matching.
3. **`npx vite-node scripts/app-control.ts --checkout off`** (or remove the shop from `--checkout-allow`, or unset `MERGESHIP_CHECKOUT_DISCOUNT`, or `setCheckoutDiscountEnabled(shop, false)`): stops projection and consumption of new events. It does NOT remove already-projected records, so always pair it with step 1 when stopping discounts.
4. **Release the previous app version** (`shopify app release --version <previous>`): removes the Function from the active version.
The merge and refund engines do not depend on any of these and keep running.

## 8. Requirements for a single-merchant pilot (none is satisfied today)
1. Production app distribution confirmed public (7.1) and the app version with the Function released after any required review (7.4).
2. PCD Name + Address approved and verified on a real pilot checkout (7.3); `write_customers` and `write_discounts` granted on the pilot shop.
3. Merge automation ON and onboarding complete for the pilot shop; single fulfillment location, or location scopes granted.
4. Merge/refund interaction test (L10) done; an exposure report (orders carrying the MergeShip grant, their MergeRecord status, shipping discounted, `OVERDRAW` events) defined and run daily.
5. Gate levers set deliberately, in this order: discount deactivated -> env, `--checkout on`, `--checkout-allow <pilot shop>`, `setCheckoutDiscountEnabled` -> smoke test (7.5) on the pilot shop with a test customer -> activate the discount.
6. Guardrails: one shop, a consciously chosen percentage, one stable Standard shipping-rate title, a named owner watching `evt: "checkout_elig"` logs (RETRY / FAILED / OVERDRAW rates), abort criteria (any OVERDRAW burst, any grant with no merge, any unexplained discount) = step 1 of 7.6 immediately.
7. Merchant-facing copy that tells shoppers they must be signed in (guests never receive it).

## 9. Verification (this branch)
Baseline (`8178caf`) and final: `npm test` 1731 passed, 0 failed (398 env-gated skips); new files: function 44, records 27, projection 6, work-store 12, processor 33, gate 11, webhook 7, isolation 5 (145 total, also run under TZ America/Los_Angeles, Pacific/Kiritimati and UTC), plus 11 real-Postgres work-store tests on a fresh migrated disposable database.
`tsc --noEmit`: only the 7 pre-existing errors (`app/shopify.server.ts` 1, `scripts/shipping-refund-readback.ts` 6). `eslint`: no new problems. `npm run build` and `prisma validate` pass. `prisma migrate diff` shows only one pre-existing unrelated index-rename drift.
The order query used by the processor was validated read-only against the isolated spike dev store (Admin API 2026-04) on real discounted and undiscounted orders.
NOT verified: any production behaviour (Admin API connectivity under the Shopify IP allowlist remains an outstanding operational verification), distribution status, PCD approval for production, wallet checkouts.
