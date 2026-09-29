# Shopify app development

This app is scaffolded from a Shopify app template. See the README for framework-specific details.

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for all Shopify API and platform work. If missing, install it in the agent host per that page (or `npx skills add Shopify/shopify-ai-toolkit --list` for skill-compatible hosts) — do not add tooling to this repo.

## Verification

- `npm test` — Vitest unit/integration tests (merge engine runs against an in-memory fake Shopify in `tests/fake-shopify.ts`).
- `npx tsc --noEmit` — one pre-existing error in `app/shopify.server.ts` (duplicate `@shopify/shopify-api` session types) is known and unrelated.
- `npx eslint app tests --ext .ts,.tsx`
- `npm run build`
- Live end-to-end merge against a dev store (creates and cancels real test orders; overrides only the single-location check):
  `MERGESHIP_LIVE_STORE=<store>.myshopify.com MERGESHIP_LIVE_VARIANT=<variant gid> MERGESHIP_LIVE_CUSTOMER=<customer gid> npx vitest run tests/live-e2e.test.ts`
- Validate any new GraphQL against the served API version with `npx shopify app execute --store <store> --version 2025-10 --query-file <file>`. The app requests 2025-01, which is no longer supported, so Shopify serves the oldest supported version (2025-10 at the time of writing).

## Merge engine invariants

- Every merge-path Shopify call goes through `gql()` in `app/lib/graphql.server.ts` (fails on transport/top-level errors, missing payload, userErrors).
- A `MergeOperation` journal row is written before `orderEditCommit`; orders in PENDING_COMMIT / COMMITTED / NEEDS_REVIEW ops are never merged again.
- `orderCancel` is asynchronous — cancellations are confirmed by reading `cancelledAt` back.
- Automatic merging is opt-in (`Settings.autoMergeEnabled` defaults to false) and only runs in shops with exactly one active location.
