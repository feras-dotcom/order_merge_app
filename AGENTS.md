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
- Real-Postgres store tests (claims, work items, operation leases; they run with the database session timezone set to Asia/Tokyo to prove the UTC clock discipline): `MERGESHIP_TEST_DATABASE_URL=postgresql://... npx vitest run tests/postgres-stores.test.ts`. The URL must point at a disposable database; the test runs `prisma migrate deploy` against it.
- Validate any new GraphQL against the served API version with `npx shopify app execute --store <store> --version 2025-10 --query-file <file>`. The app requests 2025-01, which is no longer supported, so Shopify serves the oldest supported version (2025-10 at the time of writing).

## Merge engine invariants

- Every merge-path Shopify call goes through `gql()` in `app/lib/graphql.server.ts` (fails on transport/top-level errors, missing payload, userErrors).
- A `MergeOperation` journal row is written before `orderEditCommit`; orders in PENDING_COMMIT / COMMITTED / NEEDS_REVIEW ops are never merged again.
- Every order a merge touches is claimed first (`MergeClaim`, all-or-nothing, `app/lib/claims.server.ts`). Claims, work items (`ProcessedWebhook`) and operations carry a lease token; every ownership-sensitive write is a token-conditional UPDATE on the database clock (`(now() AT TIME ZONE 'UTC')`, never a JS Date or bare `now()`), and every Shopify mutation is preceded by a fence that renews all leases held (`gql()` caps a call at 45s, the lease TTL is 90s). A worker that loses a lease stops without writing.
- `orders/create` records a PENDING work item before answering 200; processing happens in the background and the sweeper (`app/lib/background-worker.server.ts`, started from `entry.server.tsx`, disabled with `DISABLE_BACKGROUND_WORKER=true`) re-drives expired or retryable items and resumes unfinished operations. Outcomes are classified terminal vs contention/transient (`app/lib/order-work-processor.server.ts`); never mark work DONE on a transient failure.
- `orderCancel` is asynchronous — cancellations are confirmed by reading `cancelledAt` back.
- Automatic merging is opt-in (`Settings.autoMergeEnabled` defaults to false).
- Location rule (`resolveMergeLocation`): with the optional `read_merchant_managed_fulfillment_orders` scope (merchant grants it from Settings), every open fulfillment order of every order must be OPEN/UNSUBMITTED/unheld, share one assigned location, and account for every unfulfilled unit; without the scope, only single-active-location shops qualify. The `FulfillmentOrder.location` field does not exist — use `assignedLocation { location { id } }`.
