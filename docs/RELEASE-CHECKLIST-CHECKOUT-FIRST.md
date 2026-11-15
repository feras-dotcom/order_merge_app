# Checkout-first release checklist (deploy, Shopify version, pilot, rollback)

Status: PREPARED, NOT EXECUTED. Nothing below has been run against production.
Every step marked **[FOUNDER APPROVAL]** is consequential and must not be run
without explicit authorization. Everything else is read-only or local.

Identifiers used below:

| Item | Value |
|---|---|
| Railway project | `0b59c13d-73b2-42b5-a126-309cc4a31238` |
| Railway service (MergeShip) | `14804c74-aa4a-4bdb-b137-d967a9c757da`, environment `production`, region sfo, 1 replica |
| Production URL | `https://upbeat-reflection-production.up.railway.app` |
| Production app client id | `04b77142ce8ad421f49735b05c7d0a86` |
| Production code today | `07773b5d3bc6f186568e1c2d83c5ee673f875572` (= `origin/main`) |
| Current production deployment (rollback target) | `e58f90b8-f978-43c4-937a-a8e74fe58db1`, image `sha256:b6bfd96770b800d5848ea4be713e93090a88f88b4238435d80a9c35825c94c1c` |
| Release branch | `release/checkout-first-prep` (descendant of `main`, fast-forwardable) |

Shorthand: `RW="--service 14804c74-aa4a-4bdb-b137-d967a9c757da --environment production --project 0b59c13d-73b2-42b5-a126-309cc4a31238"`.

## 0. What a merge to `main` does (read first)

* The Railway service is connected to GitHub `feras-dotcom/order_merge_app`, branch `main`.
  **Pushing/merging to `main` IS a production deployment.** There is no separate deploy step.
* Today the service has no healthcheck, no pre-deploy command, restart policy ON_FAILURE x10.
  Without a healthcheck Railway makes a new deployment active as soon as its container starts.
  `railway.toml` (this release) adds `healthcheckPath=/healthz`, `healthcheckTimeout=180`: the new
  deployment becomes active only after `/healthz` returns 2xx; otherwise the old one keeps serving.
  Railway deprecates config-as-code after 2026-12-01; set the same two values in the service
  settings (Deploy -> Health check) afterwards so the safeguard survives. Config-as-code applies to the
  very first deploy of this release.
* The container runs `prisma migrate deploy` BEFORE starting the server (`npm run docker-start`).
  Seven additive migrations apply in about 0.25 s (rehearsed on PostgreSQL 18 with production-shaped
  data: metadata-only column adds, new empty tables, no triggers/indexes on existing tables, all
  original rows bit-identical afterwards).
* Everything new is OFF by default: `MERGESHIP_CHECKOUT_DISCOUNT` unset, `MERGESHIP_SHIPPING_REFUNDS`
  unset, AppControl switches false, allowlists empty. Idle cost: about 5 zero-row SQL statements per
  30 s sweep plus one `ShippingRefund` read per minute. No new Shopify calls.
* Merchant-visible code changes with flags off: (a) the merge protocol now preserves verified cancel
  evidence through COMPLETED (bug fix on the path every merging merchant uses), (b) the Settings save
  runs one extra no-op SQL statement first, (c) uninstall resets the new fields.
* Do NOT change the production `SCOPES` environment variable (it must stay the four required scopes).

## 1. Evidence already collected (no action)

* Full suite 1978 tests green on the release branch, `tsc` = the 7 baseline errors, build passes.
* Migration rehearsal on seeded PG18 data, idle-boot smoke, old-code-on-new-schema SQL: all pass.
* Container rehearsal with the real Dockerfile (old = `07773b5`, new = release tip):
  * overlap deploy: old image kept serving, 37/37 probes OK while the new image migrated; new `/healthz` 200;
  * rollback: the old image restarts and serves on the already-migrated database (`migrate deploy` tolerates
    the 7 unknown applied migrations); roll-forward afterwards works;
  * failing migration: the new image exits 1 and never opens its port, old keeps serving (see 5.3 for the
    one hazard this leaves and its tested remediation).
* Operator tooling: `app-control`, `checkout-discount-control` (status/create/preflight), `checkout-discount-report` and
  `checkout-discount-monitor` run correctly inside the production image with `npx --no-install vite-node` (about 6 s each,
  no devDependencies needed, read-only invocations write nothing). Note: `--cap-grants/--cap-amount` are only evaluated
  together with `--orders`.
* Refund engine: `test/checkout-refund-interaction` (5/5): a discounted shipping line (paid 0.00 or 4.00 of 8.00)
  plans refund 0 / exactly 4.00, never the original price.
* Function: the repo-built wasm passes 55/55 parity against the Node implementation, strict output shape
  (`selectionStrategy: "ALL"`).
* Shopify config: `shopify.app.checkout-first.toml` validates locally; required scopes byte-identical to
  production; production `shopify.app.toml` untouched.

## 2. Pre-merge checks (read-only, anyone)

```
git fetch origin
git rev-parse origin/main                     # must print 07773b5d3bc6f186568e1c2d83c5ee673f875572
git rev-parse origin/release/checkout-first-prep   # must equal the SHA in the approval request
git merge-base --is-ancestor origin/main origin/release/checkout-first-prep && echo FAST-FORWARD-OK
```

Founder checks (30 seconds, dashboard only):
1. Railway -> service -> Deployments: confirm the deployment `e58f90b8` shows a **Rollback** action
   (Railway hides it for deployments older than the plan retention; if it is hidden use rollback path R2).
2. Confirm a recent Postgres backup/snapshot exists (the migrations are additive, this is belt and braces).
3. If `main` moved since `07773b5`, stop: the release branch must be re-merged first.

## 3. Deploy **[FOUNDER APPROVAL]** (this is the one consequential action)

```
git switch main
git merge --ff-only origin/release/checkout-first-prep
git push origin main            # triggers the Railway production deployment
```

Watch (read-only):

```
railway deployment list $RW --limit 3 --json     # new deployment: BUILDING -> DEPLOYING -> SUCCESS
railway logs $RW --deployment --lines 200
curl -s https://upbeat-reflection-production.up.railway.app/healthz   # {"ok":true,"commit":"<first 7 chars of the release SHA>"}
```

Expected in the logs: seven `Applying migration` lines (`20261014000000_...` to `20261115020000_...`),
then the listen line. Within 180 s `/healthz` must answer 200 with the new commit. Until then the old
deployment keeps serving (`/healthz` is a 404 on the old code, which is how you can tell which one answers).

Post-deploy checks (10 minutes):
1. `/healthz` 200 with the release commit; open the embedded app in a store admin: dashboard loads (not the plan page).
2. Logs: no `[healthz]` errors, no `[worker] Checkout ... failed`, no `P30xx`, no `[billing] ... failed`.
3. A real or test `orders/create` still produces its normal `[work] ...` outcome line.

Stop conditions: deployment FAILED/CRASHED, `/healthz` not 200 after 180 s, any of the error lines above
repeating, or any merchant-visible regression. Go to section 5.

## 4. Shopify app version **[FOUNDER APPROVAL]** (only after section 3 is verified)

Order matters: the app code (webhook routes) must be live BEFORE the version that subscribes to the new
topics is released; otherwise Shopify delivers to missing routes (404) and counts failures.

4.1 Local, read-only:
```
cd functions/checkout-shipping-discount && npm ci && cd ../..
npx shopify app config validate --config checkout-first
npx shopify app build --config checkout-first          # wasm builds; 55/55 parity already proven for this source
```
4.2 Create the version WITHOUT releasing it (talks to the production app; creates a version only):
```
npx shopify app deploy --config checkout-first --no-release --version checkout-first-1 --message "Checkout shipping discount: optional scopes, 7 webhook topics, discount Function (inert until a discount is created)"
```
4.3 Dev Dashboard -> Versions -> `checkout-first-1`: check required scopes are still exactly
`read_customers,write_order_edits,write_orders,write_products` (no merchant re-prompt), optional scopes gained
`write_customers,write_discounts`, 7 new webhook subscriptions, one Function extension. If the dashboard
says the version needs Shopify review, submit it and stop until it is approved.
4.4 Release:
```
npx shopify app release --config checkout-first --version checkout-first-1
```
Effect on ALL merchants: they start receiving the 7 new webhook topics (about one extra delivery per order
event). With `MERGESHIP_CHECKOUT_DISCOUNT` unset every delivery is HMAC-verified (dual-secret wrapper) and
answered 200 without work. Optional scopes are only requested later, per shop. The Function exists but no
discount references it, so it never runs. Watch logs for 30 minutes for 401/500 on `/webhooks/orders/*`
and `/webhooks/refunds/create`.
4.5 Rollback of the version: Dev Dashboard -> Versions -> select the previously active version -> Release
(or find its name with `npx shopify app versions list` and run `npx shopify app release --version <previous>`
against the config that points at `shopify.app.toml`; pass the exact `--config` value the CLI accepts for it).

## 5. Rollback

5.1 Decision: any section 3 stop condition, or a regression after deploy.

R1 (preferred): Railway -> Deployments -> `e58f90b8` -> Rollback. Restores image and variables of the
old deployment (about the same time as a deploy). The database stays migrated: the old image boots on it
(rehearsed).

R2 (if Rollback is not offered): from a clean checkout of the old commit:
```
git worktree add ../mergeship-rollback 07773b5d3bc6f186568e1c2d83c5ee673f875572
cd ../mergeship-rollback && railway deployment up $RW
```
(Builds the old tree with its Dockerfile. Note the GitHub integration will redeploy `main` on the next push,
so do not push to `main` until the cause is understood or `main` itself is reverted.)

5.2 If sections 4/pilot were reached, shut the feature down FIRST (section 7), then roll back the code.

5.3 Failed migration (the one tested hazard). If a new deployment fails in `prisma migrate deploy`, the old
deployment keeps serving, but `_prisma_migrations` now holds a failed row and a RESTART of the old
deployment fails with `P3009` until the row is resolved. Remediation (tested): connect to the still-running
old deployment and mark the failed migration rolled back, then fix forward:
```
railway ssh $RW -- npx prisma migrate status
railway ssh $RW -- npx prisma migrate resolve --rolled-back <failed_migration_name>
```
A failed migration is all-or-nothing (verified: its statements roll back, earlier migrations stay).

## 6. Pilot activation (single merchant) **[FOUNDER APPROVAL]** per step group

Production operator scripts MUST run inside the Railway container (Shopify's IP allowlist rejects Admin calls
from anywhere else):
```
railway ssh $RW -- npx --no-install vite-node scripts/<script>.ts <args>
```
(The smoke harness is the exception: it runs on an operator machine against a DEV store only.)

Prerequisites: pilot merchant chosen and informed; sections 3 and 4 complete; the merchant has automatic
merging ON and onboarding complete, merge window >= 24 h, a single stable Standard rate, signed-in customers
(guests never qualify); financial caps agreed (proposal: 25 grants / USD 250 of discounted shipping,
discount percentage 100.0 for one named Standard rate). The founder sets the real numbers.

6.1 Global enable (production variable change + redeploy): set `MERGESHIP_CHECKOUT_DISCOUNT=enabled` on the
service. With AppControl off and an empty allowlist nothing activates for any shop yet. Then:
```
railway ssh $RW -- npx --no-install vite-node scripts/app-control.ts --checkout on --checkout-allow <smoke-dev-store>.myshopify.com
```
6.2 Smoke (dev store with the PRODUCTION app installed, same organization): grant the two optional scopes on
the dev store through `/app/checkout-access` inside its embedded app (the page 404s unless step 6.1 is done),
re-open the app so the offline token is re-issued, create its discount
(`... scripts/checkout-discount-control.ts create --shop <smoke> --apply`, needs the granted `write_discounts`),
then on the operator machine (needs the production
`SHOPIFY_API_KEY/SECRET` in a local env file; one customer sign-in in the persisted browser profile is the only
manual touch; the harness refuses non-dev stores, never places orders, and always restores state):
```
npx vite-node scripts/smoke/checkout-discount-smoke.ts --store <smoke>.myshopify.com --client-id 04b77142ce8ad421f49735b05c7d0a86 --env-file <path> --discount-id <gid> --workspace <playwright workspace> --out <dir outside repo> --apply
```
Required: S1 baseline, S2 Standard 0.00 + exact message with Express unchanged, S3 address mismatch baseline,
S4 deactivated discount baseline: overall PASS. Assumption this also proves for the first time on the
production app: the Function reads the `$app` customer metafield without a declarative definition (if S2 fails
only on that, add the definition from the spike config and re-version).
6.3 Pilot shop: add it to the allowlist (`--checkout-allow <smoke>,<pilot>`), merchant opens
`/app/checkout-access` and approves both scopes, wait for token re-issue (<= 1 h).
6.4 Create, enable, verify, activate (each dry-run first, then `--apply`):
```
... scripts/checkout-discount-control.ts create --shop <pilot> --apply          # created, deactivated, verified EXPIRED
... scripts/checkout-discount-control.ts prepare-enable --shop <pilot> --discount-id <gid> --apply   # prints windowId
... scripts/checkout-discount-control.ts preflight --shop <pilot>               # every check must be ok
... scripts/checkout-discount-control.ts activate --shop <pilot> --window-id <w...> --apply
```
6.5 First 24 h: one real signed-in repeat order on the pilot shop by the founder/merchant, observe the
discount line, the merge, and the report below.

## 7. Operations during the pilot

Daily (and after any incident):
```
... scripts/checkout-discount-monitor.ts                  # exit 0 clean, 1 warn, 2 CRITICAL
... scripts/checkout-discount-report.ts --shop <pilot> --since <pilot start ISO> --orders --cap-grants 25 --cap-amount 250.00
```
Monitor findings: CRITICAL `PENDING_SHUTDOWN`, `DISCOUNT_ACTIVE_WHILE_OFF`, `OVERDRAW_24H`,
`DISCOUNT_WINDOW_ENDED`; WARN `DISCOUNT_WINDOW_ENDS_SOON`, `WORK_STUCK`, `SWEEPER_STALE`.
Greppable log prefixes: `[worker] Checkout shutdown enforcement failed`, `[worker] Checkout work`,
`[checkout] Could not record work`, `[checkout] Processing failed`, JSON `{"evt":"checkout_elig"...}`.
No automated pager exists; the monitor exit code is meant for a cron/Railway cron service or a daily manual run.

Abort immediately (shutdown) on: any `OVERDRAW`, a cap breach, any grant order that is not merged within its
window, any Function failure in the Dev Dashboard, any discount line on an order with no eligibility record.

Emergency shutdown (target < 5 minutes):
```
railway ssh $RW -- npx --no-install vite-node scripts/checkout-discount-control.ts shutdown --shop <pilot> --apply
```
It deactivates the recorded discount, verifies `EXPIRED`, and only then turns the shop flags off (a failed
verification leaves the flags on and the sweeper retries every 5 minutes). If Railway or the CLI is
unavailable: Shopify admin -> Discounts -> deactivate "MergeShip checkout shipping discount" (works from
anywhere and stops discounting immediately), then run the shutdown command when possible. Unsetting the
environment variable or the AppControl switch alone does NOT stop an active discount.

## 8. Known risks that remain (do not hide)

* One-use cannot be enforced atomically at checkout: simultaneous checkouts can each be discounted
  (caught afterwards as `OVERDRAW`). Exposure per entitlement = percentage x Standard rate x simultaneous checkouts.
* A discounted second order that is never merged leaves the merchant paying that shipping.
* Failed shutdown leaves the app flags on and relies on sweeper retries (monitor `PENDING_SHUTDOWN`).
* Operator scripts only work from inside Railway (IP allowlist); emergency fallback is the Shopify admin.
* Discount `windowEnd` silently stops discounting when it passes (monitor warns 72 h ahead).
* A failed migration leaves the `P3009` hazard described in 5.3.
* Config-as-code healthcheck is honored only until 2026-12-01; mirror it in service settings.
* Not verified here: Shopify review requirement for the version with the Function, the declarative metafield
  definition assumption (smoke S2), production Admin connectivity beyond the founder's confirmation.
