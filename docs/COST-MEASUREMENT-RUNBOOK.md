# G-READBACK cost measurement — operator runbook

Status: **awaiting explicit operator approval for step 4**. Steps 1–3 are
local and reversible. Verified against Shopify CLI **4.8.0** and the repo's own
provisioner. No `config push`, no deploy, no production contact.

Goal: run the five pinned read-only documents (exact texts + sha256 from
`app/lib/shipping-refund-queries.ts`) with `Shopify-GraphQL-Cost-Debug: 1` on
`ordermergetest2.myshopify.com` as the existing MergeShip app
(`gid://shopify/App/426185785345`), archiving
`extensions.cost.{requestedQueryCost,actualQueryCost,fields}` per document and
per agreement page. Acceptance: `requestedQueryCost <= 500` each.

## Key mechanics (read first)

- `shopify app dev --use-localhost` starts **two** listeners:
  - the **Vite app server** on its own port (this app uses 3000);
  - the **local HTTPS reverse proxy** on the *proxy* port — **default 3458**.
  `--localhost-port` sets the *proxy* port, not the app's. We do not pass it;
  the default 3458 is used. The preview URL the CLI prints is the one to open.
- `automatically_update_urls_on_dev = true` lets the CLI give the **dev store**
  a preview pointing at the local proxy for the session. A development preview
  **persists after `app dev` exits** — Ctrl+C does NOT restore the released
  config; cleanup is an explicit `shopify app dev clean` (step 7).
- The app uses Shopify-managed embedded auth with token exchange; the preview
  runs the **real** flow. With the app already installed, opening the preview
  mints/refreshes an **expiring offline token**, stored by
  `PrismaSessionStorage` in `DATABASE_URL`'s `Session` table — here, the
  disposable DB.
- `shopify.web.toml` runs `npm exec prisma migrate deploy` inside the `dev`
  command — safe only because `DATABASE_URL` is the disposable DB (step 2).
- The dev preview's Admin GraphiQL cannot attach the cost-debug header → the
  token-channel runner is the measurement path (GraphiQL is optional
  cross-check only).

## Steps

### 1. Provision the disposable database (loopback only)

```bash
export MERGESHIP_SHADOW_TOKEN=<fresh-random-token>   # operator shell only
npx vite-node --script scripts/test-db-provision.ts \
  --server postgresql://postgres:<pw>@127.0.0.1:<port>/postgres \
  --name mergeship_test_cost_readback
# prints a live fingerprint, e.g. mergeship_test_cost_readback@172.17.0.x:5432
npx vite-node --script scripts/test-db-provision.ts \
  --server postgresql://postgres:<pw>@127.0.0.1:<port>/postgres \
  --name mergeship_test_cost_readback --confirm-db <exact fingerprint>
```

Provisioner itself marks and migrates the DB. Verify:
`obj_description('mergeship_test_cost_readback')` =
`mergeship-shadow-disposable:<token>`.

### 2. Isolate environment — no production path

```bash
export DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/mergeship_test_cost_readback
echo "$DATABASE_URL"   # must show the loopback host only — never railway.app
```

- Only this shell gets `DATABASE_URL`. `SHOPIFY_APP_URL` and API credentials
  are CLI-injected — do not set them.
- Put passwords/tokens in env vars and reference `$VARS` in commands — never
  literal credentials in a pasted command or recorded history.
- **Run `shopify app dev` on the operator's own machine** — the browser must
  reach `https://localhost:3458`. A remote workspace's localhost will not work.

### 3. STOP — pre-flight checks + operator approval

- Operator checks the store's Dev Console for an **existing development
  preview** on `ordermergetest2`. If one belongs to another developer, it must
  NOT be overwritten or cleaned without their authorization.
- Then approve step 4 (transient dev-preview URL + dev-store auth).

### 4. Dev preview on the dev store (operator runs, on own machine)

```bash
cd <repo root>
shopify app dev --use-localhost -s ordermergetest2.myshopify.com
# first run may prompt for: --install-mkcert (local HTTPS proxy CA)
```

The CLI prints the preview URL (on the proxy port). Open it in a browser on
the same machine; the app's real embedded auth runs — app already installed,
so expect a silent refresh or a single approval click.

### 5. Verify the offline session (agent, disposable DB only)

```sql
SELECT id, shop, "isOnline", expires, scope FROM "Session";
-- expect 'offline_ordermergetest2.myshopify.com', isOnline=false,
-- app scopes, accessToken present.
```

### 6. Run the cost measurement (agent)

```bash
export MERGESHIP_READBACK_TOKEN=<accessToken value>   # never echoed further
SHIPRB_TOKEN_ENV=MERGESHIP_READBACK_TOKEN \
  npx vite-node --script scripts/shipping-refund-readback.ts
```

Runner enforces: store must be `ordermergetest2.myshopify.com`; no document
may contain `mutation`; `currentAppInstallation.app.id` must equal
`gid://shopify/App/426185785345` before any order read; sends
`Shopify-GraphQL-Cost-Debug: 1`; archives cost per document **and** per
agreement page; `costGate` = PASS only if all measured within 500 —
missing/malformed cost data is UNMEASURED, never a pass.

Tokens may be short-lived — run promptly; if rejected, reopen the preview.

### 7. Cleanup (operator runs)

```bash
# stop the dev process, then explicitly clean the persisted preview:
shopify app dev clean -s ordermergetest2.myshopify.com
# verify in Shopify Dev Console that the released configuration is active.
```

Note: `dev clean` removes preview-only state; if another developer's preview
existed (step 3), leave it — do not clean without their authorization.
Finally: drop `mergeship_test_cost_readback`; unset `MERGESHIP_READBACK_TOKEN`
and `DATABASE_URL`.

## Expected outcomes

- Evidence JSONs gain real `cost` objects (top-level
  `requestedQueryCost`/`actualQueryCost` + `fields[]` with
  `path`/`definedCost`/`requestedTotalCost`/`requestedChildrenCost`, nulls
  allowed); register reports `costVerdicts` and `costGate`.
- Any document over 500 is reported verbatim — over-limit is evidence, not an
  error to hide.

## Side-effect ledger

| Effect | Scope | Revert |
|---|---|---|
| Dev-store preview → localhost proxy | dev store only, persists until cleaned | `shopify app dev clean -s ordermergetest2.myshopify.com` |
| `prisma migrate deploy` | disposable DB only | drop DB |
| `offline_*` Session row | disposable DB only | drop DB |
| mkcert local CA | operator machine | OS cert-store removal |

## Remaining uncertainty

- Re-auth UX on an installed dev store (silent vs one click).
- Whether the preview writes `offline_*` session on open vs on explicit app
  open — step 5 answers it.
- Offline-token lifetime; runner fails closed on rejection.
