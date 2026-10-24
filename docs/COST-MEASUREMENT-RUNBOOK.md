# G-READBACK cost measurement — safe authorization runbook

Status: **pending operator authorization** (one interactive step). Nothing below
has been executed — the OAuth flow and the app-config push require explicit
operator approval first.

Goal: run the five pinned read-only documents with
`Shopify-GraphQL-Cost-Debug: 1` on `ordermergetest2.myshopify.com` as the
**existing** MergeShip app (`client_id 04b77142ce8ad421f49735b05c7d0a86`,
archived app id `gid://shopify/App/426185785345`), capturing
`extensions.cost.{requestedQueryCost,actualQueryCost,fields}` per document
and per agreement page.

## Why `shopify app dev` cannot be used as-is

- `shopify.web.toml` `dev` = `npm exec prisma migrate deploy && npm exec remix
  vite:dev` — runs migrations at dev startup. Safe **only** if `DATABASE_URL`
  points at a verified disposable database.
- `shopify.app.toml` `[build].automatically_update_urls_on_dev = true` —
  during `dev` the CLI rewrites the app's remote `application_url` and
  `redirect_urls` to the dev URL and restores them on clean exit.
- **The flaw found in the earlier proposal:** setting
  `automatically_update_urls_on_dev = false` keeps the configured callback at
  the Railway URL, so OAuth would complete against the *deployed* app and the
  session would land in the **production** database — the opposite of what we
  need. The URL update is *required* to route OAuth to the isolated instance.

## Recommended procedure (Plan B — explicit, minimal blast radius)

One additive remote change (an extra redirect URL), zero URL flapping, no
`prisma migrate deploy` inside any `shopify dev` hook — we run it ourselves
against a preflighted disposable DB.

**Step 1 — disposable database preflight**

```bash
# fresh disposable Postgres (or reuse an existing marked disposable DB)
node scripts/test-db-provision.ts --name mergeship_cost_readback --fingerprint mergeship_cost_readback@<host>:<port>
node scripts/test-db-provision.ts --confirm-db mergeship_cost_readback --fingerprint mergeship_cost_readback@<host>:<port>
export DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/mergeship_cost_readback
# verify: host must be loopback/172.x disposable, never Railway
npx prisma migrate deploy          # runs ONLY against the disposable DB
```

**Step 2 — additive redirect via isolated config (operator runs)**

`shopify.app.readback.toml` = copy of `shopify.app.toml` with:

```toml
[auth]
redirect_urls = [
  "https://upbeat-reflection-production.up.railway.app/auth/callback",
  "http://localhost:3000/auth/callback",          # added — enables local OAuth
]
[build]
automatically_update_urls_on_dev = false          # CLI must NOT flip URLs
```

`application_url` stays the Railway value → production embedding unchanged.
The only remote change is one extra allowed redirect.

```bash
shopify app config push --config readback         # operator: pushes the additive redirect
```

**Step 3 — local server + OAuth (operator, one browser action)**

```bash
DATABASE_URL=<disposable url from step 1> npx remix vite:dev   # port 3000
# browser: http://localhost:3000/auth/login?shop=ordermergetest2.myshopify.com
```

The app's `auth.login` route starts OAuth for that shop; Shopify validates the
`localhost` redirect (allowed by step 2); the callback writes the session row
`offline_ordermergetest2.myshopify.com` into the **disposable** DB. The app is
already installed on the store, so approval is typically a single click.

**Step 4 — token retrieval + cost run (agent, no token exposure)**

Read `accessToken` from the disposable DB's `Session` row locally; export it
to an env var (e.g. `MERGESHIP_READBACK_TOKEN`), then:

```bash
SHIPRB_TOKEN_ENV=MERGESHIP_READBACK_TOKEN npx vite-node --script scripts/shipping-refund-readback.ts
```

The runner's token channel: refuses stores other than `ordermergetest2`,
refuses any document containing `mutation`, re-verifies `currentAppInstallation
.app.id === gid://shopify/App/426185785345` before any order read, sends
`Shopify-GraphQL-Cost-Debug: 1`, and records `extensions.cost` per document and
per agreement page. The token never appears in output or artifacts.

**Step 5 — rollback**

```bash
shopify app config push                            # restores committed toml exactly
# drop mergeship_cost_readback; remove the env var
```

## Side effects, scoped and reversible

| Effect | Scope | Revert |
|---|---|---|
| Extra `localhost` redirect in app config | app config; inert for production OAuth (that flow uses the Railway redirect) | `config push` of stock toml |
| Session row `offline_ordermergetest2` | disposable DB only | drop DB |
| `prisma migrate deploy` | disposable DB only (preflighted; loopback verified) | drop DB |
| Dev-store app open during OAuth | store admin only; app already installed | none needed |

## Remaining uncertainty

- Whether Shopify presents an install/approve dialog on re-OAuth (app already
  installed — usually a single click or silent refresh).
- `config push` scope granularity: it pushes the whole config file; keeping
  `application_url` at the Railway value makes it safe.
- Fallback if step 2 is refused: Plan A — stock toml +
  `shopify app dev --use-localhost -s ordermergetest2.myshopify.com` with
  `DATABASE_URL` set to the disposable DB; transient remote URL update,
  auto-reverted on clean exit (hard-kill leaves localhost URLs — restore via
  `config push`).
