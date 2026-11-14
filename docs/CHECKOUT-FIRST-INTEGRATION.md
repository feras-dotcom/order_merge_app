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

**D1. One new table `CheckoutEligibilityWork`, level-triggered reconciliation.** `orders/paid` upserts a row on `(shop, orderId)`; every other topic (section 3a) only TOUCHES an existing row
(`gen = gen + 1`, `status = PENDING`); an order that never became work has nothing to revoke. The processor never trusts the payload or the topic: it loads the order fresh and
reconciles the desired state, so duplicates, reordering, delayed payment and restarts all converge. Completion is conditional on `gen` still equal to the generation
that was processed; a newer event that arrived mid-processing re-queues instead of being lost. The row stores only shop, order GID, outcome codes: **no PII**.

**D2. Gate (all must hold, checked at the webhook AND again in the processor).**
env `MERGESHIP_CHECKOUT_DISCOUNT === "enabled"` AND `AppControl.checkoutDiscountEnabled` AND shop in `AppControl.checkoutDiscountAllowShops` (inverted: empty = NO shops)
AND `Settings.checkoutDiscountEnabled` with `checkoutDiscountEnabledAt` set AND `autoMergeEnabled` AND onboarding complete AND `mergeWindowHours >= 24` (`window-unsupported` otherwise, see D4).
The discount is only worth giving when the merge engine will merge the second order, hence the merge-setting dependency (it does NOT require a completed merge).
`checkoutDiscountEnabledAt` is an enable epoch (stamped on the DB clock only by `setCheckoutDiscountEnabled`): orders created before it never produce records, and the Function window id is derived from it (`w<epochMs>`), so a re-enable rotates the window and old eligibility can never grant again.
Defaults: all OFF. Uninstall resets the per-shop flag and epoch.
A CONFIRMED off answer (any lever above) means: HTTP 200, no row, no Admin call, row DONE `FEATURE_OFF`. A gate that cannot be READ (a dependency threw) is `unknown`, never a decision:
the webhook retries the read 3 times (100 ms, 300 ms) and then answers 500 so Shopify redelivers; the processor retries with backoff and never settles `FEATURE_OFF` on an unreadable gate.
IMPORTANT: this gate only controls whether the APP projects, consumes and revokes records. It does not stop checkout discounting. Only the Shopify automatic discount's status does (section 7.6).

**D3. Desired-state rule for one order (processor `classify`):**
- CONSUME: the order carries the MergeShip shipping grant (`detectShippingDiscountGrant`, title token = `CHECKOUT_DISCOUNT_MESSAGE`, evidence ALLOCATION) and is not cancelled.
  The matching record in the customer's document is consumed for this order id (idempotent via `used`). A consumer order NEVER issues a record (no free-shipping chains).
  No matching record with `left > 0` = diagnostic `OVERDRAW` (the signature of simultaneous checkouts, see 5).
- ISSUE: `orderStateIneligibility` is null AND the location rule holds AND exactly one shipping line with original and discounted price > 0 AND no ambiguous shipping delta
  AND `createdAt >= enabledAt` AND now < `createdAt + mergeWindowHours` AND destination key (all nine fields incl. first/last name) is non-null.
  Record: `{id, win, dest, method, cur, left: 1, exp}`; re-projecting an id that already exists refreshes `win/dest/method/cur` (an edited address must update the record), moves `exp` EARLIER only, and keeps the existing `left`/`used`, so a replay can never reset a consumed grant.
- NOT ELIGIBLE (cancelled, closed, fulfilled/partially fulfilled, refunded, unpaid, risk not LOW, window passed, refused by rule): ensure the record is ABSENT
  (revoke an unused record; a used record stays as a `left = 0` tombstone until `exp`).
- RETRY (evidence not yet available: risk level still null, search/fulfillment data incomplete, Admin throttling/5xx, CAS conflict after retries): record unchanged, transient backoff.
  A transient state is NEVER treated as ineligible, so it can never revoke by accident.

**D4. Expiry (never longer than the merge window; corrected after independent review).** The Function can only compare shop-local dates (`shop.localTime.date`; there is no per-record time of day), so a record is valid through the END of local day `exp`.
That is safe iff local midnight after `exp` is not later than `createdAt + window`, which holds exactly for `exp = localDate(createdAt + mergeWindowHours) - 1 calendar day`. There is NO floor: the earlier floor at the order date let windows shorter than a day outlive the window.
When that date precedes the order's own local date (no full local day fits, which also happens on a 25 h DST day with a 24 h window) the order gets `ABSENT WINDOW_TOO_SHORT` and no record. Shop timezone from `shop { ianaTimezone }`.
Consequences by merge window (effective lifetime is in `(window - 24 h, window]`):

| Merge window | Result |
|---|---|
| 1 h, 6 h, 12 h | Feature DISABLED for the shop by the gate (`window-unsupported`); most orders would otherwise get no record and the rest an erratic one |
| 24 h | Supported; effective lifetime between ~0 and 24 h (mean about 12 h); never beyond the window |
| 72 h | Supported; effective lifetime between 48 h and 72 h |
Proven by a property test (tests/checkout-discount-records.test.ts): windows 1/6/12/24/48/72/168 h x 7 time zones (UTC, New York, Los Angeles, London, Kolkata, Kiritimati, Chatham) x ~200 instants each incl. DST transitions: the end of local day `exp` is never later than `createdAt + window`.
Core merge-window settings are unchanged. Records are capped at 5 per customer; expired, fully consumed and old-window records are pruned on every write.
Known limit: lowering the merge window AFTER a record was issued does not shorten that record (its expiry was fixed at issue time); rotate the window (shutdown + prepare-enable, section 7.6) to invalidate outstanding records.

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

### 3a. Revocation coverage (audit after independent review)
A record exists for an order that was PAID, open, UNFULFILLED, LOW risk, single shipping line, in the merge window. Every way that can stop being true, and what notices it:

| Disqualifier | Shopify signal | Subscribed | Backstop |
|---|---|---|---|
| Cancellation | `orders/cancelled` (also `orders/updated`) | yes | recheck |
| Closed | `orders/updated` | yes | recheck |
| Refund / void (financial status leaves PAID) | `refunds/create` (also `orders/updated`) | yes | recheck |
| Fulfilled / partially fulfilled | `orders/fulfilled`, `orders/partially_fulfilled` (also `orders/updated`) | yes | recheck |
| Risk no longer LOW | `orders/risk_assessment_changed` | yes | recheck |
| Shipping address / method / shipping lines edited | `orders/updated` (all order edits fire it; `orders/edited` is therefore redundant and NOT subscribed) | yes | recheck |
| Fulfillment hold, location change | none that carries order state | no | recheck (the location rule runs again on every re-verification) |
| Window end | none needed | n/a | record `exp` + `WINDOW_PASSED` |
| Any lost or late delivery | n/a | n/a | recheck |

Recheck = `reopenOutstanding` in the existing sweeper step: every `PROJECTED` row older than 10 minutes (and younger than 8 days) is re-opened and reprocessed from fresh Shopify state (no new worker). Shopify documents that webhook delivery is not guaranteed and tells apps to reconcile periodically. Worst-case lag for a missed revocation is about 10 minutes plus one sweep tick, plus Admin latency.
Cost: about 5-6 Admin calls per outstanding record every 10 minutes (single pilot shop: negligible; revisit before wider rollout).
`orders/updated`, `refunds/create` and `orders/risk_assessment_changed` only touch rows that already exist, so the all-orders streams cost one cheap check per event while the feature is confirmed off for the shop (the first check is the env flag, which needs no database read).
Tests prove, with the REAL Function evaluating the projected metafield, that after each disqualifier the order no longer grants (and after an address edit grants only at the new address): tests/checkout-discount-revocation.test.ts.

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
If they were added as required `scopes`, every installed merchant would be prompted to re-approve on next open. Webhook topics to add: `orders/paid`, `orders/cancelled`, `orders/fulfilled`, `orders/partially_fulfilled`, `orders/updated`, `refunds/create`, `orders/risk_assessment_changed` (`orders/edited` is deliberately not subscribed, section 3a).
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
  [[webhooks.subscriptions]]
  uri = "/webhooks/orders/updated"
  topics = [ "orders/updated" ]
  [[webhooks.subscriptions]]
  uri = "/webhooks/refunds/create"
  topics = [ "refunds/create" ]
  [[webhooks.subscriptions]]
  uri = "/webhooks/orders/risk_assessment_changed"
  topics = [ "orders/risk_assessment_changed" ]
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

### 7.6 Disablement: two independent switches, and the verified shutdown procedure
There are TWO different things, and only one of them stops shoppers receiving a discount:
- **App-side gate** (env, `AppControl`, allowlist, `Settings` flag): stops the app from projecting, consuming and revoking records. Records that already sit in customers' metafields stay there and, while the Shopify discount is ACTIVE, keep granting until they expire (at most one merge window).
- **Shopify automatic discount status** (`ACTIVE` vs `EXPIRED`): the ONLY thing that stops checkout discounting, regardless of which records exist and regardless of the app's state.
Therefore a shutdown must deactivate and VERIFY the Shopify discount first, and only then turn the app flags off. `scripts/checkout-discount-control.ts` (library `app/lib/checkout-discount/discount-control.server.ts`) implements it; it is dry-run by default and needs `--apply`:
1. `shutdown --shop S --discount-id D --apply`: `discountAutomaticDeactivate`, re-read, REQUIRE `status === "EXPIRED"` (anything else, including `ACTIVE`, `SCHEDULED` or a failed read, aborts with `ShutdownNotVerifiedError` and leaves the app flags untouched), then `setCheckoutDiscountEnabled(S, false)`. Idempotent.
2. Re-enable without resurrecting stale eligibility: `prepare-enable` requires the discount to be inactive, stamps a fresh enable epoch, derives `windowId = w<epochMs>`, writes it into the discount config (all other config fields preserved) and verifies the read-back, leaving the discount INACTIVE. The Function ignores every record of an older window and the next projection write prunes them; a consumed record never grants again. Then run the real-checkout smoke test (7.5) and only then `activate`, which refuses unless the stored config `windowId` equals the app's expected one and the app gate is on, and requires `status === "ACTIVE"` afterwards.
Proven in tests/checkout-discount-control.test.ts (fake Admin with discount status transitions + the real Function): shutdown order, flags untouched on failed verification, refusal to prepare an ACTIVE discount, window mismatch refusal, and the full epoch1 -> project -> shutdown -> epoch2 scenario where the old record is not discounted, not consumable and pruned, and a consumed epoch-1 record never grants after re-enable.
Faster/other levers, in order: (a) deactivate the discount by hand in Shopify admin; (b) change the config `windowId` (invalidates every record at once); (c) `npx vite-node scripts/app-control.ts --checkout off` / remove the shop from `--checkout-allow` / unset `MERGESHIP_CHECKOUT_DISCOUNT` (stops app-side processing only: pair with (a)); (d) release the previous app version (`shopify app release --version <previous>`), which removes the Function.
Silent stop: the config `windowEnd` passing makes the Function return nothing for everyone (the Function's `inWindow` check); it must be maintained, and its expiry is an alert condition, not a feature.
The merge and refund engines do not depend on any of these and keep running.

## 8. Requirements for a single-merchant pilot (none is satisfied today)
1. Production app distribution confirmed public (7.1) and the app version with the Function released after any required review (7.4).
2. PCD Name + Address approved and verified on a real pilot checkout (7.3); `write_customers` and `write_discounts` granted on the pilot shop.
3. Merge automation ON and onboarding complete for the pilot shop; single fulfillment location, or location scopes granted.
4. Merge/refund interaction test (L10) done; an exposure report (orders carrying the MergeShip grant, their MergeRecord status, shipping discounted, `OVERDRAW` events) defined and run daily.
5. Gate levers set deliberately, in this order: discount deactivated -> env, `--checkout on`, `--checkout-allow <pilot shop>`, then `prepare-enable` (7.6) -> smoke test (7.5) on the pilot shop with a test customer -> `activate`. The shop's merge window must be at least 24 h.
6. Guardrails: one shop, a consciously chosen percentage, one stable Standard shipping-rate title, a named owner watching `evt: "checkout_elig"` logs (RETRY / FAILED / OVERDRAW rates), abort criteria (any OVERDRAW burst, any grant with no merge, any unexplained discount) = step 1 of 7.6 immediately.
7. Merchant-facing copy that tells shoppers they must be signed in (guests never receive it).

## 9. Verification (this branch)
Final: `npm test` 1792 passed, 0 failed (404 env-gated skips). Checkout-discount suite: 206 tests in 10 files (function 30, records 36, processor 31, webhook 19, revocation 18, work-store 17, gate 13, control 11, projection 6, isolation 5) plus 17 real-Postgres work-store tests on a freshly migrated disposable database (including `touchExisting` and `reopenOutstanding` incl. concurrent SKIP LOCKED re-open); the expiry proof and the new tests also pass under TZ America/Los_Angeles, Pacific/Kiritimati and UTC.
`tsc --noEmit`: only the 7 pre-existing errors (`app/shopify.server.ts` 1, `scripts/shipping-refund-readback.ts` 6). `eslint`: clean on every touched file. `npm run build` and `prisma validate` pass.
Function (functions/checkout-shipping-discount): sources are byte-identical to the live-validated spike deployment and to spike commit 94b6166, `shopify.extension.toml` is identical field for field, a scratch rebuild exports the required entrypoint `cart-delivery-options-discounts-generate-run`, and all 55 parity fixtures give the same result in the rebuilt wasm (Shopify CLI function runner) as in the Node implementation. The rebuilt wasm file hash differs from the deployed one although the sources are identical (build-toolchain output is not byte-reproducible, not source drift); behaviour is covered by the 55/55 parity result. The runner also proved that `percentage: "100.0"` (string) discounts and `percentage: 100` (number) yields no operation, which is why the earlier README example was wrong. The local runner cannot validate the DateTimeWithoutTimezone query variables (Shopify resolves them), so only the live-validated format is documented.
Test-suite note: `tests/shipping-refund-trigger-manifest.test.ts > no source mutates the replication role...` is a source-scanning test with the default 5 s timeout; it takes about 1.7 s alone (the same with and without the new checkout tests) but exceeded 5 s in 2 of 4 full parallel runs on the development machine under CPU load, and passed in the others. It is unrelated to this change (not modified here).
NOT verified: any production behaviour (Admin API connectivity under the Shopify IP allowlist remains an outstanding operational verification), distribution status, PCD approval for production, wallet checkouts, the new CLI against any real shop (never executed).

## 10. Production divergence and the reconciliation strategy
Facts (verified): production `origin/main` (`07773b5`, deployed on Railway) does NOT contain the recovery line `8178caf` (merge base `ccfb4cc`). `main` carries three commits this line lacks: dual-secret webhook validation (`app/lib/webhook-auth.server.ts`, `authenticateWebhook`), offline-token session migration (`session-migration.server.ts`, `scripts/migrate-offline-tokens.ts`, RUNBOOK section) and the conversion of six webhook routes to `authenticateWebhook`. This line carries the whole shipping v0 recovery work plus this feature.
- A trial merge of `main` into this branch has NO textual conflicts. It has ONE semantic conflict: the checkout webhook helper authenticates with the SDK's `authenticate.webhook`, which after a merge would bypass the production dual-secret validation for all seven new routes.
- Prepared and tested result: branch `reconcile/checkout-first-on-main-07773b5` = `feat/checkout-first-integration` + `git merge --no-ff origin/main` + one fix commit that routes the checkout helper through `authenticateWebhook`, adjusts the two checkout test mocks, and adds `tests/webhook-auth-coverage.test.ts`: a static guard (every `app/routes/webhooks.*.tsx` must reach `authenticateWebhook`; nothing may call `authenticate.webhook(` or import `authenticate` from `shopify.server` outside the wrapper) plus end-to-end proofs through the REAL `authenticateWebhook` (a body signed only with `SHOPIFY_API_SECRET_PREVIOUS` is accepted and projected; a body signed with neither secret is rejected like the SDK rejects it; with the variable unset it is a pass-through).
- Evidence on that branch: `webhook-auth.server.ts`, `session-migration.server.ts`, `migrate-offline-tokens.ts`, main's two test files and the RUNBOOK are byte-identical to `07773b5` (empty `git diff`); main's own tests pass unchanged (`webhook-dual-secret` 9/9, `session-migration` 15/15, `two-process` 7/7 on real Postgres); full `npm test` 1821 passed / 0 failed; `tsc` only the 7 pre-existing errors; the whole migration chain (main + recovery line + this feature) applies cleanly on an empty disposable Postgres.
Strategy (nothing below has been done; `main` and production were not touched):
1. Use MERGE, never rebase or squash, so production's commit SHAs and the production-only files stay intact; re-run the trial (`git merge-tree --write-tree <branch> origin/main`) whenever `main` moves; any new main commit that touches a webhook route must be followed by the coverage guard.
2. `reconcile/checkout-first-on-main-07773b5` is the tested merge result, not a merge into `main`. Merging it ships the entire recovery line AND the feature (all gates OFF, no subscription, no Function, inert) into production code in one step; that is a founder decision. If the recovery line is to land separately first, merge `main` into it the same way, then rebase this feature's reconciliation on top and repeat the guard + suite.
3. A deploy of the merged code runs `prisma migrate deploy` at container start (`docker-start`), which applies the additive checkout migration (one table, four defaulted columns). That is a production database change at deploy time and belongs to the deployment decision, not to the merge.
4. Keep the guard test in `main` permanently: it makes it impossible for a later route (this feature's or any other) to silently bypass the dual-secret validation during a secret rotation.
