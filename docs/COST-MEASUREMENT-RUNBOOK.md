# G-READBACK cost measurement — operator runbook

Status: **awaiting explicit operator approval for step 6** (the only
interactive, dev-store-scoped step). Everything before it is local and
reversible. Verified against Shopify CLI **4.8.0** (`shopify app dev --help`)
and the current repo tooling — `shopify app config push` is **not** used (it is
unsupported) and nothing deploys or touches production.

Goal: run the five pinned read-only documents (`Q-APPID`, `Q-RECHECK`,
`Q-RECONCILE`, `Q-REFUND-DETAIL`, `Q-AGREEMENTS` — exact texts and sha256 from
`app/lib/shipping-refund-queries.ts`) with `Shopify-GraphQL-Cost-Debug: 1` on
`ordermergetest2.myshopify.com` as the existing MergeShip app
(`gid://shopify/App/426185785345`), archiving
`extensions.cost.{requestedQueryCost,actualQueryCost,fields}` per document and
per agreement page. Acceptance: `requestedQueryCost <= 500` each.

## Why `shopify app dev --use-localhost`

- Officially supported, development-store-scoped preview. The CLI runs the app
  locally behind a local HTTPS proxy and gives the **dev store** a preview URL.
- The app uses Shopify-managed embedded auth with token exchange; a dev
  preview exercises the **real** authentication flow — no `/auth/login`
  guesses. With the app already installed on the store, opening the preview
  issues/refreshes an **expiring offline token** stored by
  `PrismaSessionStorage` in whatever `DATABASE_URL` points at — here, the
  disposable database created below.
- `shopify.web.toml` runs `npm exec prisma migrate deploy` at dev start, so
  `DATABASE_URL` isolation (step 3) is what makes it safe — migrations land in
  the disposable database only.
- GraphiQL option evaluated: the dev preview's Admin GraphiQL is convenient
  for spot reads but **cannot attach the `Shopify-GraphQL-Cost-Debug` header**,
  so it cannot produce the required field-level breakdown. The runner's token
  channel remains the measurement path. (If the dev GraphiQL happens to show
  `extensions.cost` anyway, treat it as a cross-check only.)

## Steps

### 1. Create the disposable database (loopback only)

Requires a local Postgres the provisioner can reach (e.g. the docker postgres
used for test suites, bound to `127.0.0.1`). Pick a fresh operator token.

```bash
export MERGESHIP_SHADOW_TOKEN=<fresh-random-token>   # operator's shell only
npx vite-node --script scripts/test-db-provision.ts \
  --server postgresql://postgres:<pw>@127.0.0.1:<port>/postgres \
  --name mergeship_test_cost_readback
# prints a live fingerprint like mergeship_test_cost_readback@172.17.0.x:5432
npx vite-node --script scripts/test-db-provision.ts \
  --server postgresql://postgres:<pw>@127.0.0.1:<port>/postgres \
  --name mergeship_test_cost_readback \
  --confirm-db <exact fingerprint from previous output>
```

The provisioner creates, disposable-marks and **migrates** the database itself.
Verification: `psql` → `obj_description('mergeship_test_cost_readback')`
carries `mergeship-shadow-disposable:<token>`.

### 2. Confirm no production path

```bash
echo "$DATABASE_URL"        # must be UNSET or the disposable URL — never Railway/railway.app
export DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/mergeship_test_cost_readback
```

### 3. Environment isolation

Only the dev shell gets: `DATABASE_URL` (disposable). `SHOPIFY_APP_URL` and the
API key/secret are injected by `shopify app dev` — do **not** set them. `.env`
contains only `BYPASS_BILLING` (unaffected).

### 4. STOP — operator approval

The next command changes a transient dev-preview URL on the app (auto-reverted
on clean exit) and performs dev-store authentication. Requires explicit
operator go-ahead.

### 5. Dev preview on the dev store (operator runs)

```bash
cd <repo root>
shopify app dev --use-localhost --localhost-port 3000 -s ordermergetest2.myshopify.com
# first run may prompt: shopify app dev --install-mkcert (local HTTPS proxy cert)
```

- `--use-localhost` is supported in CLI 4.8.0 — a local HTTPS proxy, no
  third-party tunnel.
- `automatically_update_urls_on_dev = true` (current config) lets the CLI point
  the app's preview URL at `https://localhost:3000` **for the duration of the
  session** and restores it on exit. This is transient and dev-store-scoped;
  it is the supported mechanism that routes the auth flow into the local app.
- The CLI prints the preview link. Open it (or `https://localhost:3000` +
  select the store) — the app's embedded auth runs; since the app is already
  installed on `ordermergetest2`, expect a silent session refresh or a single
  approval click.

### 6. Verify the offline session (agent, read-only on disposable DB)

```sql
SELECT id, shop, "isOnline", expires, scope FROM "Session";
-- expect: id = 'offline_ordermergetest2.myshopify.com', isOnline = false,
--         scope = app's configured scopes, accessToken present.
```

Belonging check is hard-enforced by the runner itself: it refuses unless the
token yields `currentAppInstallation.app.id === gid://shopify/App/426185785345`
and the store is `ordermergetest2.myshopify.com`.

### 7. Run the cost measurement (agent)

```bash
# token read from the disposable Session row into an env var — never printed
export MERGESHIP_READBACK_TOKEN=<accessToken value>
SHIPRB_TOKEN_ENV=MERGESHIP_READBACK_TOKEN \
  npx vite-node --script scripts/shipping-refund-readback.ts
```

Runner behaviour on this channel: refuses non-`ordermergetest2` stores; refuses
any document containing `mutation`; verifies app identity before any order
read; sends `Shopify-GraphQL-Cost-Debug: 1`; archives `extensions.cost`
per document and per agreement page; the register computes `costGate`
(PASS/FAIL/UNMEASURED — missing data is never a pass). The token is never
written to output or evidence.

Note: token-exchange sessions can be **expiring** — run promptly after step 5;
if the token is rejected, reopen the dev preview to refresh it.

### 8. Cleanup

```bash
# Ctrl+C the dev process — CLI restores the app's configured URLs on exit.
# verify: git diff shopify.app.toml  → must be empty
# drop mergeship_test_cost_readback; unset MERGESHIP_READBACK_TOKEN DATABASE_URL
```

## Expected outcomes

- `docs/evidence/shipping-v0/` artifacts now carry `cost` objects;
  `validation-register.json` reports `costVerdicts` per document and page and
  `costGate: PASS` iff every `requestedQueryCost <= 500`.
- Any document over 500: report verbatim; do **not** edit the pinned text —
  over-limit is evidence, not an error to hide.

## Rollback / side-effect ledger

| Effect | Scope | Revert |
|---|---|---|
| Preview URL pointed at localhost proxy | app dev config, transient | auto-restored on dev exit; `git diff` of toml stays empty |
| `prisma migrate deploy` | disposable DB only | drop DB |
| `offline_*` Session row | disposable DB only | drop DB |
| mkcert local CA | operator machine | `shopify app dev` docs / OS cert store removal |

## Remaining uncertainty

- Re-auth UX on an already-installed dev store (usually silent, may be one
  approval click).
- Whether `shopify dev` on this CLI version writes its own `offline_` session
  row on preview open vs. requiring an explicit app open — the session check
  in step 6 answers it either way.
- Offline-token lifetime under token exchange: unknown until observed; the
  runner fails closed on a rejected token.
