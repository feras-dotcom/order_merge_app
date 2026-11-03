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

## Phase 1 — controls BEFORE any order exists (local DB only)

Ordering requirement: the combine's `MergeOperation.createdAt` must be
**after** every cutoff (Phase 1 activation, admission, approval
`approvedAt`, dispatch). Configure everything first; never backdate.

```sql
-- Settings (local disposable DB fixture): merchant opt-in epoch + auto-merge
UPDATE "Settings" SET "shippingAdjustmentEnabled" = true,
  "shippingAdjustmentEnabledAt" = clock_timestamp() AT TIME ZONE 'UTC',
  "autoMergeEnabled" = true
  WHERE "shop" = 'ordermergetest2.myshopify.com';

-- AppControl: Phase 1 activation epochs + shipping allowlist
UPDATE "AppControl" SET
  "shippingEnabledAt" = clock_timestamp() AT TIME ZONE 'UTC',
  "shippingAllowShops" = ARRAY['ordermergetest2.myshopify.com']::text[],
  "rolloutAt" = clock_timestamp() AT TIME ZONE 'UTC',
  "newMergesEnabled" = true, "completionEnabled" = true,
  "allowShops" = ARRAY['ordermergetest2.myshopify.com']::text[],
  "refundPolicy" = 'REFUND_ALL'
  WHERE "id" = 'control';
```

```bash
# S2 controls (dry-run first, then --apply)
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

1. Operator creates the two test orders on the dev store via Bogus
   Gateway (primary any items; secondary with $4.00 paid shipping).
2. Start the app against the disposable DB with merge mutations enabled
   and the refund flag **unset** (admission/dispatch stay inert):

   ```bash
   DATABASE_URL=... MERGESHIP_MUTATIONS=enabled npm run dev
   # DISABLE_BACKGROUND_WORKER must NOT be set: the merge sweeper must run.
   # MERGESHIP_SHIPPING_REFUNDS stays unset — no refund worker activity.
   ```

3. Deliver the combine trigger (orders/create webhook via the dev tunnel,
   or `scripts/backfill-recent-orders.ts --since <order-create-iso> --apply`
   which reads real order ids from Shopify and upserts PENDING work items).
4. Wait for the sweeper to reach `APPLIED` with secondary cancelled.
   Expected durable evidence: `MergeOperation` terminal `APPLIED`,
   `MergeRecord` rows, `MergeMutationAttempt` SUCCEEDED rows for
   `EDIT_COMMIT` and `ORDER_CANCEL`, tokened lines on the primary, the
   secondary `cancelledAt` + canonical staff note + `RefundAgreement`/
   `OrderEditAgreement` attribution.
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

## Phase 5 — dispatch (T3 → single send → T4)

```bash
MERGESHIP_SHIPPING_REFUNDS=enabled \
npx vite-node --script scripts/shipping-refund-admin.ts worker --apply
```

Expected: `PREPARED` → `DISPATCHING` → `REFUND_RECORDED`, `refundId` set,
`dispatchedAt` set, exactly ONE mutation-document call logged, T4 writes
once. Any `WAIT`/`ABORTED` outcome → stop, inspect reason.

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

Drop the disposable database (`dropdb mergeship_test_s3a`), unset the
env vars. Dev-store artifacts (orders, merge records, the refund) are
normal dev-store data — leave them for the evidence archive.

## S3-AUTH — the authorization the operator must grant

Before Phase 2, written approval for: **(a)** creation of exactly two
development-store test orders via Bogus Gateway; **(b)** the app's own
Protocol v2 combine (`orderEditCommit` + `orderCancel`) on those orders;
**(c)** admission/preparation of the resulting secondary's shipping
refund; **(d)** exactly **one** `refundCreate`, shipping-only, ≤ $4.00
USD, on `ordermergetest2.myshopify.com` through the real dispatch path.
Nothing else: no real gateway, no production, no other shops, no
additional mutations.
