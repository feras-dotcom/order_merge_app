# MergeShip Shipping v0 + Recovery v0 — implementation handoff

**Source:** `feras-dotcom/order_merge_app` at `main` SHA `ccfb4cca840ed57943c44ac0f91ce36f0597cf86` inspected 2026-10-14.

**GitHub limitation:** `create_branch(feature/shipping-v0-recovery-v0, base=main)` returned 403 `Resource not accessible by integration`. No branch, commit or PR was created. Apply this bundle using Codex once GitHub write integration is authorized. Do not run against production until live refund tests are complete.

## Non-negotiable boundaries

- Do not rewrite `app/lib/merge.server.ts`, `app/lib/operation-protocol.server.ts`, `app/lib/evidence.server.ts`, existing `AppControl` safety semantics, or cancellation handling.
- Normal merchandise combine must finish even if a shipping adjustment fails. A shipping failure never retries, reopens or reverses a combine automatically.
- New shipping adjustment records are created only from **completed v2 operations**, after every participating secondary has verified cancellation and a persisted MergeRecord. One adjustment per source (unique shop/sourceOrderId).
- Capture an immutable snapshot of merchant shipping policy at the moment an adjustment is enqueued; changing settings must not retroactively rewrite the refund target. Persist a merchant shipping enabled-at epoch and exclude operations created before that epoch, so activating the feature cannot retroactively refund historical combines.
- Initial UI: only `Automatically refund shipping after a successful combine` (off by default). Store policy kind and retained amount for future `RETAIN_FIXED` even though UI only supports `REFUND_ALL` initially.
- Merchant activation requires a separate explicit acknowledgement that the charge is taken at checkout and refunded only afterward, if eligible. `AUTO_MERGE` itself must remain independent.
- Shipping adjustment has its own kill switch / rollout allowlist, separate from the merge engine. Off until live verified.

## Recommended safe subsystem

1. Add `Settings.shippingAdjustmentEnabled`, `shippingAdjustmentEnabledAt`, `shippingPolicy`, `shippingRetainedMinor` and `shippingRetainedCurrency`; add `ShippingAdjustment` table as in `prisma/shipping-v0-schema.fragment.prisma`. Use exact integers stored as strings for minor currency units; do not use Float. Implement migration after reviewing main schema at branch creation.
2. Add a worker that scans recently **COMPLETED** v2 `MergeOperation` rows and creates immutable, idempotent `ShippingAdjustment` intents only when a shop was opted-in; the operation must have been created on/after the current shipping enable epoch; snapshot the policy at intent creation so settings changes cannot alter queued refund amounts. Do not modify existing operation state transitions.
3. For each pending intent, freshly read the cancelled source's shipping financials, existing refunds, successful payment transactions and Shopify `suggestedRefund` in the correct currency. Validate complete reads, no prior partial shipping refund, sufficient shipping/payment maximum, and no currency/tax ambiguity. Feed exact verified minor-unit amounts into `proposeShippingAdjustment`. An ambiguous state means `REVIEW_REQUIRED`, not a guessed cap or unbounded retry.
4. Preview actual refund proposal via Shopify `Order.suggestedRefund`, including taxes, suggested transaction allocation and maximum refundable. Refuse unsupported gateways, mixed presentment/shop currencies, unsupported currency precision and cases that cannot be proven.
5. Persist the immutable refund request / selected transaction allocation / UUID idempotency key and a DISPATCHING state transactionally **before** calling `refundCreate(input:) @idempotent(key: ...)`. Never dispatch a conflicting refund from a second worker. On timeout/rejected/unknown: hold the state for evidence inspection. Do not issue a second refund with a different key, do not automatically mutate shipping again.
6. Read back the refund by ID, matching note/reference and shipping/payment amounts and transaction settlement. Do not declare money returned from only a mutation success message; distinguish REFUND_RECORDED from VERIFIED. Inconsistent evidence => REVIEW_REQUIRED.
7. Add tests: opt-in OFF, operation not completed, cancelled secondary lacking proof, duplicate deliveries, concurrent scanners, missing/partial refund history, zero charge, partial prior refunds, refund amount and tax preview mismatch, unsupported currency, JOD/JPY minor units, unknown API outcome, timeout after send, idempotency key reuse, failed payment, refund completion, and no merge state mutations on any shipping path.

**Fixed retained shipping:** Core arithmetic and model support it. Leave merchant control OFF until an actual Shopify test proves tax/transaction behavior in shop and presentment currency. It is NOT trivial at the refund edge.

## Recovery v0 process

1. Run `npx vite-node scripts/recovery-inspect.ts --operation <id>` against the intended database (read-only). Check phase, attempts, expectedTransfer, appliedEvidence, source cancellation, MergeRecord and durable locks.
2. Freeze merge mutations for the isolated development store using the existing AppControl controls, and ensure no fulfillment integration can ship during the test. Do not disable or modify live production shops.
3. In dev store, construct a completed combine that is deliberately deemed incorrect. Record before/after variant inventory, primary/source Shopify state, fulfillment orders, payments, tax, shipping and refund records.
4. Identify transferred line items by the Protocol v2 `MS-<token>-<idx>` proof rather than variant/title (which could match normal merchandise). Manually edit the primary to remove ONLY those lines after verifying quantities and no fulfillment activity; verify whether `restock=true` is correct for this exact inventory scenario.
5. Source order is cancelled and cannot be uncancelled. Test a zero-balance draft/replacement order, but do not automate it, and do not assert financial equivalence until the new order's fulfillment, taxes, inventory and reporting are verified. Treat original payment and any shipping refund as separate financial facts; do not recharge automatically.
6. Record exact successful operator steps, Shopify screenshots/IDs, inventory deltas, order totals, fulfillment status and conditions where manual reconciliation fails. Add merchant-facing `Need help with this combine?` not `Undo`.
7. After dev-store success, update canonical `07 MergeShip Recovery Runbook` and mark test status with date/store/test order IDs. Until then, `Recovery v0: documented test plan, not verified procedure`.

## Checkout-time prevention remains OPEN

Sand Hill Yarns needs charges prevented before checkout, not refunded later. Shopify Discount Function network access is limited for general merchant distribution; customer state may be unavailable at guest checkout. Continue a later isolated technical investigation of Shopify-supported checkout-state mechanisms. Do not claim v0 solves this request.

## Operator verification on a branch

- `npm ci` ; `npx prisma validate` ; `npx prisma migrate deploy` **against disposable DB only**.
- `npm test` ; `npx tsc --noEmit` (repository documents a pre-existing duplicate session type error); `npx eslint app tests scripts --ext .ts,.tsx` ; `npm run build`.
- Run DB suites one by one with disposable `MERGESHIP_TEST_DATABASE_URL` (never against preserved live-evidence database).
- Shopify dev-store: verify refundCreate (2026-04), idempotency, gross/net shipping tax allocation, gateway settlement and actual source payment behavior. Until these pass: SHIPPING ADJUSTMENTS OFF.
- Recovery controlled test requires dev-store access; this environment has no Shopify session/database, so it has **not** been run here.

## Release gates

- Do not deploy just on unit tests. First dev-store e2e, database-backed race test, shipping/merge isolation test, and recovery evidence runbook.
- Keep separate shipping rollout allowlist; start with test shop, then opt-in pilot merchant.
- Monitoring: pending/unknown adjustment age and REVIEW_REQUIRED alerts. No auto-retry on ambiguous financial outcomes.
