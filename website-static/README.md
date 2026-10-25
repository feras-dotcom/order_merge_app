# MergeShip public website

Standalone static deployment for the public landing and privacy pages. This service is intentionally separate from the Shopify app service.

Railway service settings (repository configuration):

- Builder: Dockerfile
- Dockerfile path: `website-static/Dockerfile`
- Config file path: `/website-static/railway.toml` (specifies healthcheck `/privacy`)
- Health check: `/privacy` — note this is the repo-configured value; the live service manifest currently reports a null/absent healthcheck, so confirm the effective setting in Railway before relying on it.

## Local preview

No build step — the directory is served as-is. `/brand/*` assets live in the app repo's `public/brand`, so a generic static server won't resolve logos. Use the QA harness server, which mirrors the nginx routes exactly (directory `index.html` routes, `404.html` with status 404, `/brand` from `public/brand`):

```
node "C:\Users\feero\msqa\serve.cjs" "C:\Users\feero\Desktop\Mergeship Website\website-static" 4173
```

Production parity: `nginx.conf.template` maps `/`, `/demo`, `/privacy`, `/guides`, `/guides/<slug>` to `index.html`, serves `/brand` from `public/brand`, and returns `404.html` with status 404.

## Deployment safety

Before deploying or touching the Railway service, verify the live **service name → service ID** mapping — an ID/name inconsistency exists in project history. If the name does not resolve to the expected ID, **STOP — do not guess or proceed**.

Settled inputs (verified read-only from `railway status --json`):

- Project `ravishing-flexibility`: `0b59c13d-73b2-42b5-a126-309cc4a31238`
- Marketing service: `841c8321-32fd-42d2-b2e4-261dc5b1a1c8` (this exact ID — an earlier `e4b2` variant in notes was wrong)
- Environment `production`: `2dde885c-18aa-410a-870c-7961685a28d5`
- Service source: manual upload (`repo: null`, `image: null`); Dockerfile path `website-static/Dockerfile`; apex + Railway domains target port 8080.
- Repo config vs live manifest: `railway.toml` in this repo declares healthcheck `/privacy`, but the live service manifest currently reports `healthcheck: null` — treat the repo value as desired config, not confirmed live state.

After visual approval only (do not run without it), from the repository root:

```
railway up --project 0b59c13d-73b2-42b5-a126-309cc4a31238 --service 841c8321-32fd-42d2-b2e4-261dc5b1a1c8 --environment production --ci --message "Approved MergeShip marketing redesign <commit>"
```

Do not change `nginx.conf.template` routing, networking, or the www redirect without an explicit decision. The Dockerfile `COPY`s every site file it needs — new top-level assets must be added to the COPY list.
