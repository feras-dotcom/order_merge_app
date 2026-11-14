# experiments/ — Phase 2 harness (isolated spike app only)

Run any script with:
```
SPIKE_APP_DIR="C:/Users/feero/Desktop/mergeship-checkout-spike/app/ms-checkout-spike-app" \
  npx jiti spikes/checkout-shipping-discount/experiments/<script>.ts
```

- `lib.ts` — loads `SPIKE_APP_DIR/.env` (written by `shopify app env pull`, git-ignored in the isolated app), asserts client_id + shop domain, requests a client-credentials token in memory, redacts `shp*_*` creds/tokens/secrets/Authorization from all output, saves sanitized evidence to `docs/evidence/checkout-first/`.
- `queries.ts` — every Admin GraphQL document (each validated with validate.mjs --api admin --version 2026-04; extracted copies under `experiments/q/`).
- `store-facts.ts` — read-only shop/profiles/products/locations facts.
- `list-functions.ts` — `shopifyFunctions` (source of the real function UUID).
- `setup-discount.ts` — creates the Function-owned automatic discount; `configValue()` produces the combined config+input-variables JSON; `SPIKE_FUNCTION_ID` env var supplies the UUID.
- `setup-customers.ts` — customerCreate C1/C2 (currently blocked by protected-customer-data approval).
- `probe-sf-token.ts` — storefrontAccessTokenCreate probe (blocked: no unauthenticated_* scopes).
- `vite-node.config.ts` — fs.allow config for vite-node (jiti is used instead; kept for reference).

## Handoff-2 scripts (live experiments; login required once)

- `verify-config.ts` — PCD + discount + window + metafield-definition verification (safe, idempotent).
- `smoke-browser.ts` — launches headed Chrome on the persisted profile, loads storefront, reports password/CF state. PASS: reached /password, no CF challenge.
- `login-session.ts` — THE interactive step: founder types storefront password + hosted-account sign-in (≤10 min wait, auto-detects /account or ENTER). Writes `login-state.json` marker only — no secrets/cookies logged.
- `seed-eligibility.ts` — seeds `$app:ship_elig` on `SPIKE_CUSTOMER_EMAIL` via the real projection code (buildRecord+mergeRecords+writeProjection CAS). `SPIKE_METHOD`, `SPIKE_EXP`, `SPIKE_LEFT`, `SPIKE_CLEAR=1` knobs.
- `checkout-trial.ts` — one browser checkout observation (cart permalink → /checkout → fill TEST_ADDRESS → scrape shipping/discount/total → evidence JSON + local screenshot).
- `e1-matrix.ts` — E1 scenarios (no-record, matching, other-customer, diff-street, expired-record, window-closed; restores state after).
- `e3-identity.ts` — signed-in vs guest (SPIKE_GUEST=1 uses browser-profile-guest; guest password entry is a second founder touch).
- `tunnel-webhooks.ts` — cloudflared quick tunnel + HMAC-verifying receiver + orders/paid+create subscriptions; `SPIKE_ACTION=stop` deletes subs.
- `e2-campaign.ts` — E2 trial loop skeleton (T1–T4 timing; order-pay click NOT automated — see report).
- `e6-order-evidence.ts` — reads a placed order and runs detectShippingDiscountGrant on real JSON.

Env for all: `SPIKE_APP_DIR=<isolated app>`; run `npx jiti spikes/checkout-shipping-discount/experiments/<file>.ts` from the repo root. Screenshots/cookies/profiles stay in the isolated workspace (`browser-profile*/`, `evidence-shots/` — gitignored, never committed).

## Live results (2026-11-12, dev store ms-checkout-spike-1111)

- ROOT CAUSE of the earlier "function never fires" failure: the Function
  emitted `selectionStrategy: "FIRST"`, but
  `DeliveryDiscountSelectionStrategy` has exactly ONE enum value, `ALL`.
  Shopify silently discards a schema-invalid result, so every deploy
  (real logic AND the unconditional probes) produced no discount.
  Fix: emit `ALL`. Verified live — `probe4` unconditionally discounted
  both delivery options after the fix.
- E1 matrix (signed-in customer, fresh checkouts): PASS on all six
  scenarios — no record ⇒ full price; matching 9-field dest key +
  method + open window ⇒ Standard $8.00→FREE only (Express $15.00);
  other-customer record, different street (same ZIP), expired record,
  and closed window ⇒ all full price. Evidence: e1-matrix.json +
  trial-e1-*.json.
- E6: real bogus-gateway orders #1001 (100%: shipping $8.00→$0.00,
  allocation 800) and #1002 (50%: $8.00→$4.00, allocation 400).
  `detectShippingDiscountGrant` returns ALLOCATION with the exact
  granted amount when titleToken = the config `message` ("MergeShip
  spike: shipping discount") — note the order's discountApplication
  title is the config message, NOT the discount node title. Partial
  case leaves the $4.00 remainder refundable. Evidence: e6-order.json,
  e6-place-order.json.
- **INVALID (retracted; see docs/evidence/checkout-first/INVALID-original-e2-e3/README.md): the E2 numbers below came from a cart where Standard was natively free and a synthetic seeded record.**
- E2 (INVALID): tunnel+HMAC receiver + orders/paid sub. Per-trial chain
  measured: Admin order visible ~76s after trial start (dominated by
  browser order placement), webhook receipt 5.5–6.3s after order
  creation, projection write 0.7–0.9s, checkout visibility of the new
  record ~72s after write (function/metafield propagation; reload
  re-evaluates the Function — verified). See e2-pipeline.json.
- Checkout payment-step fields live in cross-origin PCI iframes
  (`iframe[name^='card-fields-<field>']`, visible input ids
  #number/#name/#expiry/#verification_value); Test Payment Gateway
  card "1" approves.

### E2 campaign (26 trials, n=26, ms) — INVALID, DO NOT CITE
Retained only as a record of a flawed experiment: native free shipping on the $629.95 cart, synthetic record seeding, loose success text match. Superseded by e2-direct / e2-real runs.
| delta | p50 | p95 | max |
|---|---|---|---|
| order visible in Admin after trial start (incl. ~50s browser order placement) | 75685 | 77112 | 77264 |
| webhook receipt after order createdAt | 6159 | 7405 | 7954 |
| projection write after webhook | 818 | 1062 | 1079 |
| checkout-visible after write (function re-evaluates on reload; propagation floor) | 71773 | 72359 | 72622 |
Plus 3 earlier validation trials with the same profile (~5.7s webhook, ~72s visibility).
Competing-checkout: two simultaneous checkouts, same customer, ONE record —
BOTH render the discount (stateless Function cannot atomically consume a
one-use entitlement; webhook-side consumption is the only guard). Evidence:
e2-pipeline.json, e2-competing.json. Subscriptions deleted after the run
(webhookSubscriptions(first:10) now empty), tunnel/receiver stopped.

### E3
- (a) signed-in checkout: covered by E1/E2.
- (b) guest with existing customer's email: NOT RUN — needs the founder to
  re-enter the storefront password in a fresh/incognito context
  (e3-identity.ts is ready; SPIKE_GUEST=1 path).
- (c) accelerated wallets: UNTESTABLE IN THIS ENVIRONMENT — checkout offers
  only "Pay with credit card / Test Payment Gateway"; no Shop Pay / Apple Pay /
  Google Pay buttons in the DOM; shop.supportedDigitalWallets=[].
- (d) partial address: the signed-in checkout collapses the saved address
  ("Ship to … Default / Use a different address") and the discount already
  renders against the saved address. Typing in the "different address" form
  (partial fields) does NOT disturb the applied discount — the Function
  evaluates the selected delivery address, not the in-progress form.
  Field strictness is additionally proven by e1-diff-street (different
  street, same ZIP ⇒ no discount). Evidence: e3-partial.json.

### Function-observability limitation
Function execution is observable ONLY via checkout output — `shopify app logs`
was removed in CLI 5.0 and function logs are dashboard-only. A schema-invalid
result (e.g. selectionStrategy FIRST) is silently discarded: no discount and
no visible error anywhere an automation can reach.
