# Checkout-first runbook (deploy, Shopify version, pilot, operations, rollback)

Status (2026-11-15): phases 1-3A are DONE and verified; the pilot is NOT started.
* Phase 1: production runs commit `ffee277` (recovery line + checkout-first, all features OFF), 17 migrations.
* Phase 2: Shopify app version `checkout-first-1` is released (required scopes unchanged, optional scopes
  `write_customers`/`write_discounts`, 7 new webhook topics, the `checkout-shipping-discount` Function).
* Phase 3A: end-to-end validation on dev store `ordermergetest2` passed (real checkout, real webhooks,
  eligibility, consumption, shutdown). Everything was restored to OFF afterwards.
* Pending: deploy the pre-pilot corrections (branch `release/pre-pilot-corrections`, migration 18) before any
  pilot. Every step marked **[FOUNDER APPROVAL]** is consequential and must not be run without it.

| Item | Value |
|---|---|
| Railway project / environment / service | `0b59c13d-73b2-42b5-a126-309cc4a31238` / `production` / `MergeShip` (use `--service MergeShip`) |
| Production URL | `https://upbeat-reflection-production.up.railway.app` |
| Production app client id | `04b77142ce8ad421f49735b05c7d0a86` |
| Production code today | `ffee277b83a7fa582f24fbbc3effe3109a873261` (`origin/main`) |
| Current deployment (rollback target for the next deploy) | `4a817365-d5cc-4b3b-8093-cf1102d323ad`, image `sha256:4f4dd972499eb1726321c5bab7a1b861e42213e1ff93ad36cf8e9b7f21840346` |
| Active Shopify app version | `checkout-first-1` (previous: `mergeship-10`) |
| Local backup of the pre-Phase-1 database | `C:\Users\feero\MergeShip-backups\` (encrypted, see its `RECOVERY.md`) |

All commands below run from the repo checkout (Railway CLI is linked to it). On Windows the `railway` npm shim
cannot be spawned by other programs; pass the real binary, `C:/Users/feero/AppData/Roaming/npm/node_modules/@railway/cli/bin/railway.exe`.

## 0. How Railway actually behaves here (verified, not assumed)

* Pushing or merging to `main` does NOT deploy. The service has no GitHub deploy trigger
  (`deploymentTriggers` is empty). A deploy is done explicitly:
  `railway redeploy --service MergeShip --from-source --yes` (pulls the latest commit of the configured
  repo/branch, builds with the Dockerfile).
* `railway variables --set KEY=VALUE --service MergeShip` triggers a redeploy by itself (about 35 s).
  `railway variable delete KEY --service MergeShip` does NOT: follow it with
  `railway redeploy --service MergeShip --yes`, otherwise the running container keeps the old value.
* `railway.toml` sets `healthcheckPath=/healthz`, `healthcheckTimeout=180`. The new deployment goes live only
  after `/healthz` answers 2xx; the old one serves until then. One 502 sample was seen during the switch, so
  expect a blip of a few seconds. Config-as-code is deprecated by Railway after 2026-12-01: set the same two
  values in the service settings (Deploy -> Health check) before then.
* The container runs `prisma migrate deploy` before the server starts. A failing migration leaves the old
  deployment serving but blocks its next restart (see 5.3).
* Native Railway volume backups need a Pro workspace (this one is not): take a logical dump before a
  migration deploy (procedure in `C:\Users\feero\MergeShip-backups\RECOVERY.md`: `pg_dump -Fc` run on the
  Postgres service through `railway ssh`, encrypted in-stream, restored into a disposable PG18 to verify).
* Admin API calls from this PC are rejected (the app has an IP allowlist). Operator scripts that call Shopify
  must run inside the container: `railway ssh --service MergeShip -- npx --no-install vite-node scripts/<script>.ts <args>`.
  Pure database reads can use `railway ssh --service Postgres -- sh -c 'psql -U "$PGUSER" -d "$POSTGRES_DB" ...'`.
* Production `SCOPES` env must stay the four required scopes. Do not change it.

## 1. Shopify CLI (actual versions)

* The repo's own `@shopify/cli` is 4.8.0 and is removed from the production image. 4.8.0 cannot create a version
  containing this Function: Shopify rejects it with "input.variables: Variable definitions are missing".
* Use CLI 5.0.1 through npx, with the named config:
  `npx --yes -p @shopify/cli@5.0.1 shopify app <command> --config checkout-first ...`
* `--no-release` satisfies non-interactive mode for `app deploy` (there is no `--force`); `app release`
  needs `--allow-updates` (add `--allow-deletes` only if a deletion is intended). Build the Function first:
  `cd functions/checkout-shipping-discount && npm ci`, then run the CLI from the repo root.
* `app config pull --config readback` (then `git checkout -- shopify.app.readback.toml`) shows the ACTIVE
  remote config; use it to verify scopes/topics after a release. The default `shopify.app.toml` is untouched
  and inert for Functions.
* No Shopify version is needed for the pre-pilot corrections: they change app code and the database only.
  Re-release a version only if the Function or `shopify.app.checkout-first.toml` changes.
* Rollback of a version: `npx --yes -p @shopify/cli@5.0.1 shopify app release --config checkout-first --version mergeship-10 --allow-updates`
  (or Dev Dashboard -> Versions).

## 2. Deploy the pre-pilot corrections **[FOUNDER APPROVAL]**

Contents (branch `release/pre-pilot-corrections`): function lookup by handle; dry-run actually dry
(`shutdown`/`prepare-enable`/`activate` mutate only with `--apply`); consumer-order marker (an order that used
record A can never consume record C on reprocessing); pilot method approval; preflight webhook check; smoke
harness fixes. One additive migration: `20261116000000_checkout_pilot_restriction_and_consumer_marker`
(four nullable columns, metadata-only, no rewrite). Old code runs on the migrated schema.

Pre-checks (read-only):
```
git fetch origin
git rev-parse origin/main                 # must print ffee277b83a7fa582f24fbbc3effe3109a873261
git merge-base --is-ancestor origin/main origin/release/pre-pilot-corrections && echo FAST-FORWARD-OK
railway deployment list --service MergeShip --limit 2 --json   # 4a817365 must be SUCCESS (rollback target)
```
Take and verify a fresh logical backup (section 0). Then:
```
git push origin <approved sha>:refs/heads/main        # does NOT deploy
railway redeploy --service MergeShip --from-source --yes
railway deployment list --service MergeShip --limit 2 --json   # BUILDING -> DEPLOYING -> SUCCESS
railway logs --service MergeShip --deployment --lines 300      # one "Applying migration 20261116000000_..." line
curl -s https://upbeat-reflection-production.up.railway.app/healthz   # {"ok":true,"commit":"<first 7 of the sha>"}
```
Post-deploy (10 minutes): `/healthz` shows the new commit; no `P30xx`, `[healthz]`, `[worker] Checkout ... failed`
or 5xx lines; `_prisma_migrations` has 18 finished rows; `Settings`/`AppControl` flags unchanged (checkout and
shipping switches false, allowlists empty); the one auto-merge merchant's setting is unchanged. Stop conditions and
rollback: section 5.

## 3. Pilot activation (single merchant) **[FOUNDER APPROVAL]** per step group

Prerequisites: pilot merchant chosen and informed; section 2 deployed; the merchant has automatic merging ON,
onboarding complete, merge window >= 24 h, signed-in customers (guests never qualify), ONE stable shipping
method that will be approved by exact title (for example `Standard`), its maximum price, and the caps agreed
(proposal: 25 grants / USD 250 of discounted shipping, percentage 100.0). The founder sets the real numbers.
`ordermergetest2` already ran this flow end to end; repeat the dev-store smoke test with the deployed code first.

Until section 2 is deployed the deployed scripts still have two bugs: `create` needs `--function-id <id>` (look
it up with a read of `shopifyFunctions`), and a command WITHOUT `--apply` still executes for `shutdown`,
`prepare-enable` and `activate`. After section 2 neither applies.

3.1 Global enable: `railway variables --set MERGESHIP_CHECKOUT_DISCOUNT=enabled --service MergeShip` (redeploys).
With the AppControl switch off and an empty allowlist nothing activates for any shop.
3.2 `scripts/app-control.ts --checkout on --checkout-allow <pilot>.myshopify.com` (allowlist semantics inverted:
empty means NO shops; list only the pilot shop, and for a dev-store smoke only that dev store).
3.3 Scopes: the merchant opens the embedded app at `/app/checkout-access` and approves the two optional scopes
(the page 404s unless 3.1 and 3.2 are done). Re-open the app so the offline token is re-issued, then confirm
with `preflight` (its `scopes` check).
3.4 Dev store smoke (never a merchant): needs only `SHOPIFY_API_KEY` in a local env file, one signed-in customer
in the browser profile, and the dev store's storefront password if set:
```
npx vite-node scripts/smoke/checkout-discount-smoke.ts --store <dev>.myshopify.com --client-id 04b77142ce8ad421f49735b05c7d0a86 --env-file <file with SHOPIFY_API_KEY only> --discount-id <gid> --workspace <playwright workspace> --out <dir outside repo> --admin-via railway --railway-bin <railway.exe> --variant <cheap variant id> --customer <gid> --apply
```
(`--admin-via railway` is required because of the IP allowlist.) Expected: S1-S4 all PASS, discount returned to EXPIRED,
eligibility cleared. It never places orders.
3.5 Create, approve, verify, activate (each destructive command needs `--apply`):
```
... scripts/checkout-discount-control.ts create --shop <pilot> --apply                      # discount created INACTIVE, verified EXPIRED
... scripts/checkout-discount-control.ts prepare-enable --shop <pilot> --discount-id <gid> --method "Standard" --max-shipping 8.00 --currency USD --apply   # prints windowId
... scripts/checkout-discount-control.ts preflight --shop <pilot>                          # every check ok (warn lines are expected)
... scripts/checkout-discount-control.ts activate --shop <pilot> --window-id <w...> --apply
```
`prepare-enable` REQUIRES `--method`, `--max-shipping` and `--currency`; it records them with the new enable epoch,
and a fresh epoch always needs fresh approval. Only an order whose shipping line title equals the approved method
(case/whitespace-insensitive), in that currency, with an ORIGINAL shipping price <= the cap, ever gets an
eligibility record. Expedited-looking titles are refused at `prepare-enable`. There is no merchant-facing
setting for this.
Preflight notes: the `webhooks` check passes via the bundled declaration (`OK_DECLARED`) because Shopify's
Admin API never lists app-config webhooks; it adds `webhooks-release: VERIFY_RELEASED_VERSION` (warn). Verify
the released version once with `app config pull` (section 1) and with the first real delivery in the logs.
3.6 First 24 h: one real signed-in repeat order by the founder/merchant; observe the discount line, the merge,
and the report below.

## 4. Operations during the pilot

Daily (and after any incident):
```
... scripts/checkout-discount-monitor.ts                  # exit 0 clean, 1 warn, 2 CRITICAL
... scripts/checkout-discount-report.ts --shop <pilot> --since <pilot start ISO> --orders --cap-grants 25 --cap-amount 250.00
```
(`--cap-grants/--cap-amount` are only evaluated together with `--orders`.) Monitor findings: CRITICAL
`PENDING_SHUTDOWN`, `DISCOUNT_ACTIVE_WHILE_OFF`, `OVERDRAW_24H`, `DISCOUNT_WINDOW_ENDED`; WARN
`DISCOUNT_WINDOW_ENDS_SOON`, `WORK_STUCK`, `SWEEPER_STALE`. Overdraw now includes outcome `CONSUMED_OVER_CAP`
(a discounted order whose granted shipping exceeded the approved cap, for example because the merchant raised
the approved method's price after the record was issued). Greppable log prefixes: `[worker] Checkout shutdown
enforcement failed`, `[worker] Checkout work`, `[checkout] Could not record work`, `[checkout] Processing failed`,
JSON `{"evt":"checkout_elig"...}` (kinds PROJECTED, CONSUMED, REFUSED with code, RETRY, OVERDRAW, FEATURE_OFF).
No automated pager exists: run the monitor from a cron/Railway cron service or daily by hand.

Abort immediately (shutdown) on: any overdraw (including OVER_CAP), a cap breach, any grant order that is not
merged within its window, any Function failure in the Dev Dashboard, any discount line on an order with no
eligibility record. Do not change the approved method's price during the pilot.

Emergency shutdown (target < 5 minutes):
```
railway ssh --service MergeShip -- npx --no-install vite-node scripts/checkout-discount-control.ts shutdown --shop <pilot> --apply
```
It deactivates the recorded discount, verifies `EXPIRED`, and only then turns the shop flags off and clears the
method approval (a failed verification leaves the flags on and the sweeper retries every 5 minutes). Turning
automatic merging OFF in the app Settings (tested live) or lowering the merge window below its highest value this epoch
(unit-tested) triggers the same shutdown. If Railway or the CLI is unavailable: Shopify admin -> Discounts ->
deactivate "MergeShip checkout shipping discount" (works from anywhere), then run the shutdown command when possible.
Unsetting the environment variable or the AppControl switch alone does NOT stop an active discount.
To switch the feature fully off afterwards: `app-control.ts --checkout off`, `app-control.ts --checkout-allow ,`
(clears the allowlist), `railway variable delete MERGESHIP_CHECKOUT_DISCOUNT --service MergeShip`, then
`railway redeploy --service MergeShip --yes`; confirm with `printenv` inside the container.

### Eligibility timing (exact)

* A record is written when an order is paid (`orders/paid`), unfulfilled, low risk, signed-in customer, single
  shipping line of the approved method, created after the enable epoch. It is valid through the END of the
  shop-local calendar day `exp`, where `exp` = the shop-local date of (order created + merge window) minus one day
  (shop timezone from Shopify, DST-safe, no floor). Consequences: with a 24 h window the record is valid until the
  end of the order's own local day, so its lifetime is between 0 and 24 h (an order at 23:30 local gets 30
  minutes); 48 h window: 24-48 h; 72 h window: 48-72 h. A record never outlives the merge window.
* A record matches only the same exact shipping address (name, company, street, unit, city, province, zip, country),
  the same normalized method title, the same currency, and the enable-epoch window id. One use: the first
  discounted order consumes it; a second checkout is full price. Orders for a different method never create
  records. Refund, cancel, fulfil, partial fulfil, close, risk change or an address/shipping edit revoke an
  unused record (webhook, plus a recheck about every 10 minutes for lost webhooks).
* A consumer order records which record it consumed (durable marker), so reprocessing it can never consume a
  second record. A record consumed once can never be re-issued, even after eviction.
* The discount config `windowEnd` (default 14 days from creation) silently stops all discounting when it passes;
  the monitor warns before it does.

## 5. Rollback

5.1 Decision: any section 2 stop condition (deployment FAILED/CRASHED, `/healthz` not 200 after 180 s, error lines
repeating, merchant-visible regression), or an abort condition in section 4 (shut the feature down FIRST, then roll back).

R1 (preferred): Railway dashboard -> Deployments -> `4a817365` -> Rollback, if offered. Restores that image and
its variables. The database stays migrated; the previous image runs on the new schema (additive columns only,
rehearsed). Railway only offers Rollback inside the plan's retention window.
R2: redeploy the previous commit from source: push/force nothing; from a clean checkout of `ffee277`:
```
git worktree add ../mergeship-rollback ffee277b83a7fa582f24fbbc3effe3109a873261
cd ../mergeship-rollback && railway up --service MergeShip
```
Note `main` must not be pushed meanwhile, and a later `railway redeploy --from-source` rebuilds whatever
`origin/main` points at.
Data: restore a backup only as a founder decision into a NEW database (data written since the backup would be lost).
5.2 Shopify version rollback: section 1.
5.3 Failed migration (the one tested hazard): if a new deployment fails in `prisma migrate deploy`, the old
deployment keeps serving, but `_prisma_migrations` holds a failed row and a RESTART of the old deployment fails
with `P3009` until it is resolved:
```
railway ssh --service MergeShip -- npx prisma migrate status
railway ssh --service MergeShip -- npx prisma migrate resolve --rolled-back <failed_migration_name>
```
A failed migration is all-or-nothing (verified).

## 6. Known risks that remain (do not hide)

* One-use cannot be enforced atomically at checkout: simultaneous checkouts can each be discounted (caught
  afterwards as `OVERDRAW`). Exposure per entitlement = percentage x approved method price x simultaneous checkouts.
* The Function itself is not capped: if the merchant raises the approved method's price after a record exists, the
  discount at checkout follows the NEW price once; it is detected afterwards as `CONSUMED_OVER_CAP`. Keep the
  rate stable during the pilot.
* A discounted second order that is never merged leaves the merchant paying that shipping.
* Failed shutdown leaves the app flags on and relies on sweeper retries (monitor `PENDING_SHUTDOWN`).
* Operator scripts only work from inside Railway (IP allowlist); the emergency fallback is the Shopify admin.
* A failed migration leaves the `P3009` hazard (5.3). The config-as-code healthcheck is honored only until
  2026-12-01 (mirror it in service settings).
* Not verified here: Shopify review requirement for a future Function version, `orders/partially_fulfilled`
  delivery (same wrapper as the verified topics), concurrent double-grant, the refund engine on a merged
  discounted pair (refund engine stays disabled).
