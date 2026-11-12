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
