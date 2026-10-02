# Shopify app development

This app is scaffolded from a Shopify app template. See the README for framework-specific details.

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for all Shopify API and platform work. If missing, install it in the agent host per that page (or `npx skills add Shopify/shopify-ai-toolkit --list` for skill-compatible hosts) — do not add tooling to this repo.

## Verification

- `npm test` — Vitest unit/integration tests (merge engine runs against an in-memory fake Shopify in `tests/fake-shopify.ts`).
- `npx tsc --noEmit` — one pre-existing error in `app/shopify.server.ts` (duplicate `@shopify/shopify-api` session types) is known and unrelated.
- `npx eslint app tests scripts --ext .ts,.tsx`
- `npm run build`
- Real-Postgres store tests (claims, work items, operation leases; they run with the database session timezone set to Asia/Tokyo to prove the UTC clock discipline): `MERGESHIP_TEST_DATABASE_URL=postgresql://... npx vitest run tests/postgres-stores.test.ts`. The URL must point at a disposable database; the test runs `prisma migrate deploy` against it.
- Two-process contention test (two real workers, real Postgres, an in-test fake-Shopify HTTP server): `MERGESHIP_TEST_DATABASE_URL=postgresql://... npx vitest run tests/two-process.test.ts`. Run the two database-backed files one at a time: they truncate the same disposable database, so running them in one vitest invocation makes them interfere.
- Live protocol verification against a dev store (creates and cancels real test orders; token/agreement/staff-note evidence and the end-to-end merge path): `MERGESHIP_LIVE_STORE=<store>.myshopify.com npx vitest run tests/live-protocol.test.ts` (override fixtures with `MERGESHIP_LIVE_VARIANT`, `MERGESHIP_LIVE_VARIANT2`, `MERGESHIP_LIVE_CUSTOMER`).
- Operator scripts (legacy reconciliation, work requeue, backfill, kill switches, worker heartbeats) run with `npx vite-node scripts/<name>.ts`; they read `DATABASE_URL` and the Shopify environment from the operator's shell and print a clear error when `DATABASE_URL` is unset.
- Validate any new GraphQL against the pinned API version 2026-04 with `npx shopify app execute --store <store> --version 2026-04 --query-file <file>`. The app pins `ApiVersion.April26` in `app/shopify.server.ts`.

## Merge engine invariants

- Never replace, only reconcile. Once an order-affecting Shopify request may have been dispatched, no conflicting operation may touch those orders until the original is conclusively reconciled or parked in `REVIEW_REQUIRED`.
- Every merge-path Shopify call goes through `gql()` in `app/lib/graphql.server.ts` (fails on transport/top-level errors, missing payload, userErrors).
- Safety is durable, not in-memory: a `MergeOrderLock` row (one per order, unique) is held for the life of every v2 `MergeOperation`, and orders involved in a v1 PENDING_COMMIT / COMMITTED / NEEDS_REVIEW op are never merged again. Claims (`MergeClaim`, all-or-nothing, `app/lib/claims.server.ts`) only provide liveness — leases and their fences stop a stale worker from writing, but the durable lock is what keeps orders out of other merges.
- A `MergeMutationAttempt` row is written **before** every order-affecting Shopify request (write-ahead), via `openDispatchGate`. The gate checks the kill switches (`AppControl.newMergesEnabled` / `completionEnabled` / `MERGESHIP_MUTATIONS`) atomically with the attempt insert; the attempt is recorded SUCCEEDED / REJECTED / UNKNOWN from the response. A fence failure before `admin.graphql` is invoked is provably "not sent" and records REJECTED with `not dispatched: ownership lost before send`.
- Commit evidence is a `MergeCalculatedOrder` freeze plus, after commit, tokened line items: each transferred line carries a ManualDiscountApplication description `Merged from #S, already paid · MS-<opToken>-<idx>` and must appear as a `ProductSale` in one `OrderEditAgreement` attributed to this app (`currentAppInstallation.app.id`) with `happenedAt` inside the dispatch window. `appliedEvidence` stores `{ agreementId, happenedAt, lines[] }`.
- `orderCancel` is asynchronous and runs only after applied evidence exists for that secondary and the secondary is still untouched; it is proven by reading back `cancelledAt` plus a staff note containing `MS-<opToken>`. Ops converted from the v1 journal (`calculatedOrderId IS NULL`) additionally accept the v1 note `merged into #P by MergeShip` — v2-created ops never do.
- `RECOMMIT_SAME_CALC` stays false: a calculated order is committed at most once; a second `orderEditCommit` for the same calculation is never issued — doubt is resolved by re-reading evidence, not by re-sending.
- Every ownership-sensitive write is a token-conditional UPDATE on the database UTC wall clock (`clock_timestamp() AT TIME ZONE 'UTC'`, never a JS Date or bare `now()`); the evidence/retry ladders are absolute from `firstDispatchAt`/`dispatchedAt`. A worker that loses its lease (`OwnershipLostError`) stops without writing.
- `orders/create` records a PENDING `ProcessedWebhook` work item before answering 200; the sweeper (`app/lib/background-worker.server.ts`, from `entry.server.tsx`, disabled with `DISABLE_BACKGROUND_WORKER=true`) reaps claims, drives due operations, exhausts retryable items and claims new work. Outcomes are classified terminal vs contention/transient (`app/lib/order-work-processor.server.ts`); never mark work DONE on a transient failure. Siblings parked under a `REVIEW_REQUIRED` op (or a v1 NEEDS_REVIEW op) are excluded from matching; non-review locks and live claims keep them "busy".
- Automatic merging is opt-in (`Settings.autoMergeEnabled` defaults to false).
- Location rule (`resolveMergeLocation`): with the optional `read_merchant_managed_fulfillment_orders` scope (merchant grants it from Settings), every open fulfillment order of every order must be OPEN/UNSUBMITTED/unheld, share one assigned location, and account for every unfulfilled unit; without the scope, only single-active-location shops qualify. The `FulfillmentOrder.location` field does not exist — use `assignedLocation { location { id } }`.
