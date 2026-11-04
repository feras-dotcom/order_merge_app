# S3 happy-path runbook — first controlled dev-store run

Design §§18 (stage 9) and 20.3 (happy path only; the failure-injection
scenarios stay in the subsequent S3 plan). Preparation document — no
financial action may be taken until the operator grants the S3-AUTH scope
at the bottom.

Store: `ordermergetest2.myshopify.com` (development store only; the staged
CLI commands hard-refuse any other shop). App:
`gid://shopify/App/426185785345`. Gateway: **Bogus Gateway only**.

## Experiment limits

- One isolated combine: one primary + one secondary test order.
- Secondary carries **$4.00 USD paid, refundable shipping** (bogus capture).
- Maximum **one** `refundCreate`, shipping-only, ≤ $4.00 USD.
- `ShippingExecuteControl.globalDailyCap = 1`; approval `dailyCap = 1`,
  `maxRefundMinor = "400"`, `autoApprove = false`.
- Manual frozen wire-hash approval (`approve-hash`) — required before
  dispatch can mint a permit.
- No retries, no fallback send, no second idempotency key after ambiguity.

## Phase 0 — disposable database and sessions (no mutation)

```bash
export MERGESHIP_SHADOW_TOKEN=<operator token>
npx vite-node --script scripts/test-db-provision.ts \
  --server postgresql://postgres@127.0.0.1:55499/postgres \
  --name mergeship_test_s3a \
  --confirm-db 'mergeship_test_s3a@127.0.0.1:55499'
export DATABASE_URL='postgresql://postgres@127.0.0.1:55499/mergeship_test_s3a'
```

Provision the offline session for the dev store into this DB
(`shopify app dev --use-localhost` run once against `DATABASE_URL`, or
copy the `offline_ordermergetest2.myshopify.com` Session row). Verify:

```bash
npx vite-node --script scripts/shipping-refund-admin.ts status
```

**Database preflight (before Phase 1):** every staged S3 command
(`admission`, `reconcile`, `dispatch`) runs the canonical
`preflightDisposableDatabase` checks before any write — no production
env markers, loopback host only, disposable-name rules and the
`mergeship-shadow-disposable:<token>` marker — so `MERGESHIP_SHADOW_TOKEN`
must match the provisioning token and `DATABASE_URL` must be the
loopback disposable URL (a name prefix alone is not the guard).

## Phase 1 — controls BEFORE any order exists (local DB only)

Ordering requirement: the combine's `MergeOperation.createdAt` must be
**on/after** the activation cutoff — the MAX of three epochs
(`shippingActivationCutoff`): `AppControl.shippingEnabledAt` (kill switch),
`Settings.shippingRolloutAt` (rollout membership), and
`Settings.shippingAdjustmentEnabledAt` (merchant opt-in). Configure
everything first; never backdate. NOTE: `shippingAllowShops` has INVERTED
semantics — empty means NO shops; `allowShops` empty means ALL shops.

```sql
-- Settings (local disposable DB fixture): merchant opt-in epoch, rollout
-- membership epoch, onboarding + auto-merge prerequisites
UPDATE "Settings" SET
  "shippingAdjustmentEnabled" = true,
  "shippingAdjustmentEnabledAt" = clock_timestamp() AT TIME ZONE 'UTC',
  "shippingRolloutAt" = clock_timestamp() AT TIME ZONE 'UTC',
  "autoMergeEnabled" = true,
  "autoMergeAcknowledgedAt" = clock_timestamp() AT TIME ZONE 'UTC',
  "onboardingStartedAt" = COALESCE("onboardingStartedAt", clock_timestamp() AT TIME ZONE 'UTC'),
  "onboardingCompletedAt" = COALESCE("onboardingCompletedAt", clock_timestamp() AT TIME ZONE 'UTC')
  WHERE "shop" = 'ordermergetest2.myshopify.com';

-- Verify the policy is the REFUND_ALL default; do NOT set anything else.
SELECT "shippingPolicy" FROM "Settings" WHERE "shop" = 'ordermergetest2.myshopify.com';
-- expect: REFUND_ALL

-- AppControl: shipping kill switch ON with its epoch, rollout allowlist.
-- Merge mutation switches stay OFF until Phase 2 step 3 (backfill
-- requires them off).
UPDATE "AppControl" SET
  "shippingAdjustmentsEnabled" = true,
  "shippingEnabledAt" = clock_timestamp() AT TIME ZONE 'UTC',
  "shippingAllowShops" = ARRAY['ordermergetest2.myshopify.com']::text[],
  "allowShops" = ARRAY['ordermergetest2.myshopify.com']::text[]
  WHERE "id" = 'control';

-- Activation verification: every epoch non-null, shop allowlisted —
-- shippingActivationCutoff() and the admission gate (computeShippingGate)
-- open only with all three stamped.
SELECT "shippingAdjustmentsEnabled", "shippingEnabledAt", "shippingAllowShops"
  FROM "AppControl" WHERE "id" = 'control';
SELECT "shippingAdjustmentEnabled", "shippingAdjustmentEnabledAt", "shippingRolloutAt"
  FROM "Settings" WHERE "shop" = 'ordermergetest2.myshopify.com';
```

```bash
# S2 controls (dry-run first, then --apply; stamps admission/dispatch epochs)
npx vite-node --script scripts/shipping-refund-admin.ts set-control \
  --admission on --dispatch on --global-cap 1 \
  --note "S3 happy path" --by <operator>
npx vite-node --script scripts/shipping-refund-admin.ts set-control \
  --admission on --dispatch on --global-cap 1 \
  --note "S3 happy path" --by <operator> --apply

# Operator approval bound to the live opt-in epoch
npx vite-node --script scripts/shipping-refund-admin.ts set-approval \
  --shop ordermergetest2.myshopify.com --currency USD \
  --max-minor 400 --daily-cap 1 --auto-approve off \
  --note "S3 happy path" --by <operator> --apply
```

## Phase 2 — the genuine Protocol v2 combine (requires S3-AUTH)

Do NOT insert `MergeOperation` rows or cancel via Admin. The combine runs
the real pipeline: `orders/create` work item → sweeper → `executeMerge`
Protocol v2 (`orderEditCommit`, `MergeMutationAttempt` write-ahead,
`MergeRecord`, tokened transferred lines, then the app's own `orderCancel`
on the secondary with the canonical note and its attempt row).

**Temporary shipping rate (before the orders, part of S3-AUTH setup):**
the dev store's existing checkout rate is $8 Standard — not used. The
operator creates a temporary flat rate in Shopify Admin → Settings →
Shipping and delivery → the profile covering the test products/zone:
name **`S3 Test Shipping`**, price **$4.00 USD**. After the run the rate
is removed in the same screen (cleanup step below). No other shipping
setting is changed.

**Order setup (all operator actions on the dev store):** two **normal
storefront checkouts** on `ordermergetest2.myshopify.com` paid through
the Bogus Gateway, both under the SAME freshly created test customer
(unique email/phone this run — a new customer guarantees the pair
cannot combine with any historical test order), the same shipping
address, and the same `S3 Test Shipping` method on both. Standard
shippable product(s); left UNFULFILLED; never refunded. The merge
window (`mergeWindowHours`, default 24h) plus the customer/address
match is what pairs them.

**Order verification (read-only, before the combine):** confirm on both
orders — `displayFinancialStatus = PAID`, `fulfillmentStatus` empty/
UNFULFILLED, exactly **one eligible successful Bogus Gateway
CAPTURE/SALE allocation** with `test = true` (a normal
AUTHORIZATION + CAPTURE transaction sequence is acceptable — count the
capture, not the authorization), identical `customer` id, identical
shipping address, shipping line title `S3 Test Shipping`. Confirm the
**secondary's** shipping line price is exactly `$4.00` (400 minor
units) before the combine starts — if it is not, STOP and report
BLOCKED rather than proceeding at a different amount (approval
`maxRefundMinor` is 400). Suggested read: the pinned Q-RECONCILE
document or an equivalent read-only order read; capture the responses
as evidence.

**Sequencing — the webhook path is preferred; backfill only while merge
switches are OFF (`requireControlsOff`):**

1. Operator creates the `S3 Test Shipping` $4.00 flat rate (Admin →
   Settings → Shipping and delivery), then places the two storefront
   checkouts through Bogus Gateway, then runs the read-only order
   verification above.
2a. **Webhook path (preferred):** start the app dev tunnel so the real
   `orders/create` webhook writes the PENDING `ProcessedWebhook` items:

   ```bash
   DATABASE_URL=... npm run dev   # shopify app dev tunnel
   # DISABLE_BACKGROUND_WORKER must NOT be set: the merge sweeper must run.
   # MERGESHIP_MUTATIONS stays UNSET while items are recorded — nothing merges.
   # MERGESHIP_SHIPPING_REFUNDS stays unset — no refund worker activity.
   ```

   Verify two PENDING `ProcessedWebhook` rows exist.
2b. **Backfill alternative:** with merge switches OFF, run
   `scripts/backfill-recent-orders.ts --since <order-create-iso> --apply`
   — it refuses while `newMergesEnabled`/`completionEnabled` are on, so
   leave them off until items exist, then enable.
3. Enable the merge switches for the sweeper run only:

   ```sql
   UPDATE "AppControl" SET "newMergesEnabled" = true,
     "completionEnabled" = true WHERE "id" = 'control';
   ```

   ```bash
   DATABASE_URL=... MERGESHIP_MUTATIONS=enabled npm run dev
   ```

4. Wait for the sweeper to reach `APPLIED` with secondary cancelled.
   Expected durable evidence: `MergeOperation` terminal `APPLIED`,
   `MergeRecord` rows, `MergeMutationAttempt` SUCCEEDED rows for
   `EDIT_COMMIT` and `ORDER_CANCEL`, tokened lines on the primary, the
   secondary `cancelledAt` + canonical staff note + `RefundAgreement`/
   `OrderEditAgreement` attribution. Then disable the merge switches
   again (same UPDATE with `false`) and stop `npm run dev`.
5. **Wait 15 minutes** — the admission settle delay
   (`sourceCancelledAt + 15min`) must pass before the scan can admit.

## Phase 3 — admission → PREPARED

```bash
npx vite-node --script scripts/shipping-refund-admin.ts admission \
  --shop ordermergetest2.myshopify.com            # dry-run
npx vite-node --script scripts/shipping-refund-admin.ts admission \
  --shop ordermergetest2.myshopify.com --apply
npx vite-node --script scripts/shipping-refund-admin.ts status \
  --shop ordermergetest2.myshopify.com
```

Expected: `ShippingRefund` row `QUEUED` → `PREPARED`, `lane='EXECUTE'`,
`wireHash` frozen, `policy=REFUND_ALL`, epochs matching the live gate.

## Phase 4 — frozen wire inspection + operator approval

```bash
npx vite-node --script scripts/shipping-refund-admin.ts wire --row <ID>
# inspect wireVariables: refundCreate input — shipping-only, $4.00 USD,
# idempotencyKey present. Record the wireHash for evidence.
npx vite-node --script scripts/shipping-refund-admin.ts approve-hash \
  --row <ID> --hash <wireHash> --by <operator> --apply
```

## Phase 5 — dispatch (T3 → single send → T4) with S3 preflight

The `dispatch` staged command wraps the same
`runShippingRefundDispatchCycle` sender (DispatchPermit unchanged) behind
a fail-closed preflight: disposable-DB identity, dev-store identity,
exactly one due PREPARED row, expected order ids, approved wire hash and
`plannedShippingMinor <= 400`. It runs the checks read-only first and
refuses on any failure.

```bash
MERGESHIP_SHIPPING_REFUNDS=enabled \
npx vite-node --script scripts/shipping-refund-admin.ts dispatch \
  --shop ordermergetest2.myshopify.com \
  --row <ID> --source <gid://shopify/Order/secondary> \
  --primary <gid://shopify/Order/primary> \
  --expect-db mergeship_test_s3a --apply
```

Expected: all `checks` true → `PREPARED` → `DISPATCHING` →
`REFUND_RECORDED`, `refundId` set, `dispatchedAt` set, exactly ONE
mutation-document call logged, T4 writes once. Any `WAIT`/`ABORTED`
outcome or failed check → stop, inspect reason.

## Phase 6 — read-back + reconciliation + verification

After the 15-minute visibility window:

```bash
npx vite-node --script scripts/shipping-refund-admin.ts reconcile \
  --shop ordermergetest2.myshopify.com --apply
```

Expected: `REFUND_RECORDED` → `VERIFIED`; Q-AGREEMENTS shows exactly one
`RefundAgreement`/`REFUND` with `app.id = gid://shopify/App/426185785345`
linked to the refund id; settlement state classified; `VERIFIED` is
journaled. Run `reconcile` again — idempotent, no new events.

## Evidence capture

Write each command's JSON output and `status` snapshots to
`docs/evidence/shipping-v0-s3/` at execution time; capture the
`ShippingRefundEvent` journal (`∅→QUEUED→PREPARED→DISPATCHING→
REFUND_RECORDED→VERIFIED`), the refund GID, wire hash and the Q-documents'
read-backs; seal with `MANIFEST.sha256`.

## Emergency stop

```bash
npx vite-node --script scripts/shipping-refund-admin.ts set-control \
  --admission off --dispatch off --note "S3 halt" --by <operator> --apply
```

Unsetting `MERGESHIP_SHIPPING_REFUNDS` also stops dispatch immediately.
Reconciliation remains safe to run (read-only toward Shopify). A row in
`REVIEW_REQUIRED` is never `resolve`d until the finding is reviewed.

## Stop conditions (halt, keep evidence, report)

- Any second mutation-document call, any retry, a second key.
- `IN_DOUBT` persisting past its window without adoption evidence.
- Missing/extra `RefundAgreement`, `app.id` ≠ MergeShip, or linked
  `refund.id` mismatch.
- A non-bogus transaction or non-test gateway anywhere in evidence.
- Any T4 write failure left unrecovered; any `ROW_ERROR`/`LEASE_LOST`.

## Cleanup

Remove the temporary `S3 Test Shipping` rate in Shopify Admin → Settings
→ Shipping and delivery. Drop the disposable database
(`dropdb mergeship_test_s3a`), unset the env vars. Dev-store artifacts
(orders, merge records, the refund) are normal dev-store data — leave
them for the evidence archive.

## S3-AUTH — the authorization the operator must grant

Before Phase 2, written approval for: **(a)** a temporary `S3 Test
Shipping` $4.00 flat rate on the dev store plus two storefront
checkouts paid through the Bogus Gateway; **(b)** the app's own
Protocol v2 combine (`orderEditCommit` + `orderCancel`) on those
orders; **(c)** admission/preparation of the resulting secondary's
shipping refund; **(d)** exactly **one** `refundCreate`, shipping-only,
≤ $4.00 USD, on `ordermergetest2.myshopify.com` through the real
dispatch path. Nothing else: no real gateway, no production, no other
shops, no additional mutations.
