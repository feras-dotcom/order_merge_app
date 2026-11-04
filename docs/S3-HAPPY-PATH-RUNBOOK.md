# S3 happy-path runbook — first controlled dev-store run

Design §§18 (stage 9) and 20.3 (happy path only; the failure-injection
scenarios stay in the subsequent S3 plan). No financial action may be
taken until the operator grants S3-AUTH for the scope at the bottom AND
the production-isolation prerequisite (Phase P) has been approved,
applied and verified.

Store: `ordermergetest2.myshopify.com` (development store; pinned as a
literal in `scripts/lib/s3-cli-admin.ts`, no override). App:
`gid://shopify/App/426185785345`. API version `2026-04`. Gateway:
**Bogus Gateway only**.

## Experiment limits

- One isolated combine: one primary + one secondary test order.
- Secondary carries **$4.00 USD paid, refundable shipping** (bogus capture).
- Maximum **one** `refundCreate`, shipping-only, ≤ $4.00 USD.
- `ShippingExecuteControl.globalDailyCap = 1`; approval `dailyCap = 1`,
  `maxRefundMinor = "400"`, `autoApprove = false`.
- Manual frozen wire-hash approval (`approve-hash`) — required before
  dispatch can mint a permit.
- No retries, no fallback send, no second idempotency key after ambiguity.

## Transport — Shopify CLI, not a stored offline session

The local run never uses `unauthenticated.admin()` and never runs
`shopify app dev`: the only app (`client_id 04b77142…`) is the production
app, and dev mode would rewrite its URLs/webhooks. Every Shopify call in
the S3 stages goes through `shopify app execute --store
ordermergetest2.myshopify.com --version 2026-04` (the channel that
created the attributed G-E7 refund; Shopify permits CLI mutations on dev
stores only), wrapped by `scripts/lib/s3-cli-admin.ts`:

- **Mode policy, enforced before any process is spawned:** `read-only`
  (identity, backfill, admission, reconcile — any mutation refused),
  `merge` (sweep — only the pinned Merge* order-edit/cancel/annotation
  mutations; refundCreate refused), `refund` (dispatch — only the exact
  `shippingRefundMutationDocument()` string, at most once per process).
- **Zero retries** for every call; `sendRefund`'s 45 s `AbortSignal`
  kills the CLI process tree and surfaces as a transport outcome
  (→ `IN_DOUBT`, reconciled, never resent).
- Frozen `wireVariables` (incl. the idempotency key) are written to the
  CLI variable file verbatim.
- Every call is appended to `<evidence>/transport.jsonl` (op type, name,
  root fields, duration, outcome — never variables or credentials). The
  mutation count for the run is read from these files.

**Offline-session guard.** The admission, dispatch and reconcile modules
check the canonical `offline_<shop>` Session row immediately before any
Shopify call (N12/I22). CLI auth has no stored Session row, and none is
created or copied. The S3 stages inject `createS3CliSessionLoader`
instead: on every invocation it runs the read-only
`shop { myshopifyDomain } currentAppInstallation { app { id } }` probe
through the CLI and reports the credential usable only when both equal
the pinned store and app id; any error or mismatch fails closed (shop
skipped / row rescheduled exactly as for an unusable session). The guard
is substituted, not disabled, and only in the S3 operator process — the
server wiring is unchanged.

## Phase P — production isolation (PREREQUISITE, separate approval)

Read-only inspection of production (Railway, deployment `main@07773b5`,
2026-11-04) showed every merge gate open for this store:
`AppControl.newMergesEnabled = true`, `completionEnabled = true`,
`allowShops = []` (all shops), `Settings.autoMergeEnabled = true` for
`ordermergetest2.myshopify.com` (onboarding complete, `mergeWindowHours =
1`), `MERGESHIP_MUTATIONS=enabled` in the running process, background
worker heartbeating, offline session present. The store's `orders/create`
webhook routes to production, so production would merge the S3 orders
itself.

Minimum shop-specific isolation: set production
`Settings.autoMergeEnabled = false` for `ordermergetest2.myshopify.com`
via the app's own Settings page (Shopify Admin of the dev store → Apps →
MergeShip → Settings → turn automatic merging off → Save). The production
work processor then settles the webhook items `DONE/AUTOMATION_OFF` before
any Shopify call (`order-work-processor.server.ts`, check 1). No global
switch, deployment or other shop is affected.

Before Phase 2, verify read-only (same `railway ssh` READ ONLY inspection)
that production `Settings.autoMergeEnabled = false` for the store. After
the run, production auto-merge for the dev store stays off until the
operator decides otherwise.

## Phase 0 — disposable database (no mutation)

Use a responsive local embedded Postgres on a loopback IP literal (the
2026-11-04 prep used `127.0.0.1:55537`; the older `:55499` instance
stopped answering the Postgres protocol and must not be used). Check it
answers before provisioning.

```bash
export MERGESHIP_SHADOW_TOKEN=<operator token>      # never committed
export PGPORT_S3=55537
npx vite-node --script scripts/test-db-provision.ts \
  --server postgresql://postgres@127.0.0.1:$PGPORT_S3/postgres \
  --name mergeship_test_s3a
# re-run with the --confirm-db value it prints
export DATABASE_URL="postgresql://postgres@127.0.0.1:$PGPORT_S3/mergeship_test_s3a"
export EVID=docs/evidence/shipping-v0-s3
```

Expected CLI latency is ~12–16 s per call (measured); every merge/refund
call stays inside the 45 s `GQL_TIMEOUT_MS`, and merge leases (120 s) are
renewed before each request.

Every DB-touching S3 stage runs the canonical `preflightDisposableDatabase`
first (no production env markers, loopback IP literal only, disposable
naming, the `mergeship-shadow-disposable:<token>` marker). Confirm the
CLI identity (read-only):

```bash
npx vite-node --script scripts/s3-cli.ts identity --evidence $EVID
# expect: shopDomain ordermergetest2.myshopify.com,
#         appId gid://shopify/App/426185785345, match true
```

## Phase 1 — controls BEFORE any order exists (disposable DB only)

The combine's `MergeOperation.createdAt` must be **on/after** the
activation cutoff = MAX(`AppControl.shippingEnabledAt`,
`Settings.shippingRolloutAt`, `Settings.shippingAdjustmentEnabledAt`)
(`shippingActivationCutoff`). Configure everything first; never backdate.
`shippingAllowShops` empty = NO shops; `allowShops` empty = ALL shops.

```sql
-- Settings: a fresh DB has no row — insert it (id is client-generated
-- by Prisma, so supply one).
INSERT INTO "Settings" ("id","shop","autoMergeEnabled","autoMergeAcknowledgedAt",
  "onboardingStartedAt","onboardingCompletedAt",
  "shippingAdjustmentEnabled","shippingAdjustmentEnabledAt","shippingRolloutAt")
VALUES ('s3-settings-ordermergetest2','ordermergetest2.myshopify.com', true,
  clock_timestamp() AT TIME ZONE 'UTC', clock_timestamp() AT TIME ZONE 'UTC',
  clock_timestamp() AT TIME ZONE 'UTC', true,
  clock_timestamp() AT TIME ZONE 'UTC', clock_timestamp() AT TIME ZONE 'UTC')
ON CONFLICT ("shop") DO UPDATE SET
  "autoMergeEnabled" = true,
  "autoMergeAcknowledgedAt" = EXCLUDED."autoMergeAcknowledgedAt",
  "onboardingStartedAt" = COALESCE("Settings"."onboardingStartedAt", EXCLUDED."onboardingStartedAt"),
  "onboardingCompletedAt" = COALESCE("Settings"."onboardingCompletedAt", EXCLUDED."onboardingCompletedAt"),
  "shippingAdjustmentEnabled" = true,
  "shippingAdjustmentEnabledAt" = EXCLUDED."shippingAdjustmentEnabledAt",
  "shippingRolloutAt" = EXCLUDED."shippingRolloutAt";

SELECT "shippingPolicy" FROM "Settings" WHERE "shop" = 'ordermergetest2.myshopify.com';
-- expect: REFUND_ALL (the column default; do not set it)

-- AppControl (seeded by migration): shipping kill switch + epoch +
-- rollout allowlist; merge allowlist pinned to the dev store. The merge
-- mutation switches stay OFF until after backfill (requireControlsOff).
UPDATE "AppControl" SET
  "shippingAdjustmentsEnabled" = true,
  "shippingEnabledAt" = clock_timestamp() AT TIME ZONE 'UTC',
  "shippingAllowShops" = ARRAY['ordermergetest2.myshopify.com']::text[],
  "allowShops" = ARRAY['ordermergetest2.myshopify.com']::text[],
  "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC'
  WHERE "id" = 'control';

-- Activation verification: all three epochs non-null, shop allowlisted.
SELECT "shippingAdjustmentsEnabled","shippingEnabledAt","shippingAllowShops",
       "newMergesEnabled","completionEnabled","allowShops"
  FROM "AppControl" WHERE "id" = 'control';
SELECT "shippingAdjustmentEnabled","shippingAdjustmentEnabledAt","shippingRolloutAt",
       "autoMergeEnabled","onboardingCompletedAt"
  FROM "Settings" WHERE "shop" = 'ordermergetest2.myshopify.com';
```

```bash
# S2 controls (dry-run, then --apply; stamps admission/dispatch epochs)
npx vite-node --script scripts/shipping-refund-admin.ts set-control \
  --admission on --dispatch on --global-cap 1 --note "S3 happy path" --by <operator>
npx vite-node --script scripts/shipping-refund-admin.ts set-control \
  --admission on --dispatch on --global-cap 1 --note "S3 happy path" --by <operator> --apply
npx vite-node --script scripts/shipping-refund-admin.ts set-approval \
  --shop ordermergetest2.myshopify.com --currency USD --max-minor 400 \
  --daily-cap 1 --auto-approve off --note "S3 happy path" --by <operator> --apply
npx vite-node --script scripts/shipping-refund-admin.ts status --shop ordermergetest2.myshopify.com
```

Record every epoch (`shippingEnabledAt`, `shippingRolloutAt`,
`shippingAdjustmentEnabledAt`, admission/dispatch control epochs,
approval `approvedAt`, `merchantOptInEpoch`) — all must precede the
orders. `merchantOptInEpoch` must equal `shippingAdjustmentEnabledAt`.

## Phase 2 — orders and the genuine Protocol v2 combine (requires S3-AUTH + Phase P)

No `MergeOperation` rows are inserted and nothing is cancelled via Admin.
The combine is the real pipeline: work item → `runSweepOnce` →
`executeMerge`/`driveOperation` Protocol v2 (write-ahead
`MergeMutationAttempt`, `orderEditCommit`, `MergeRecord`, tokened lines,
the app's own `orderCancel` with the canonical note, then COMPLETED
side-effects).

1. **Temporary shipping rate (operator, Shopify Admin):** Settings →
   Shipping and delivery → the shipping profile covering the test
   products → the zone containing the test address → Add rate → Flat
   rate, name **`S3 Test Shipping`**, price **$4.00 USD**, no conditions →
   Done → Save. No other shipping setting changes.
2. **Two storefront checkouts (operator):** on the online store, as the
   SAME freshly created test customer (unique email for this run, so the
   pair cannot match any historical order), same shipping address, choose
   `S3 Test Shipping`, pay with Bogus Gateway (card number `1` for
   success). Standard shippable product(s). Do not fulfil or refund.
3. **Read-only order verification** (pinned Q-RECONCILE via
   `scripts/shipping-refund-readback.ts` or an equivalent read-only
   query; save responses under `$EVID`): both orders
   `displayFinancialStatus = PAID`, unfulfilled, exactly one eligible
   successful Bogus Gateway CAPTURE/SALE allocation with `test = true` (a
   normal AUTHORIZATION + CAPTURE sequence is acceptable — count the
   capture), identical customer id, identical shipping address, shipping
   line title `S3 Test Shipping`; the **secondary's** discounted shipping
   amount exactly `$4.00` (400 minor units). Any deviation → STOP,
   BLOCKED. No other new orders exist for the customer.
4. **Backfill exactly these two orders** (merge switches still OFF):

   ```bash
   npx vite-node --script scripts/s3-cli.ts backfill \
     --orders <gid://shopify/Order/A>,<gid://shopify/Order/B> \
     --since <iso just before the first order> --evidence $EVID          # dry-run
   npx vite-node --script scripts/s3-cli.ts backfill \
     --orders <A>,<B> --since <iso> --evidence $EVID --apply
   ```

   Expect exactly two PENDING `ProcessedWebhook` rows.
5. **Enable the merge switches (disposable DB) and sweep:**

   ```sql
   UPDATE "AppControl" SET "newMergesEnabled" = true, "completionEnabled" = true,
     "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC' WHERE "id" = 'control';
   ```

   ```bash
   MERGESHIP_MUTATIONS=enabled npx vite-node --script scripts/s3-cli.ts sweep \
     --orders <gid://shopify/Order/A>,<gid://shopify/Order/B> \
     --ticks 1 --evidence $EVID --apply
   ```

   Every sweep invocation re-verifies the scope before mutating: exactly
   the two approved work items and at most one operation touching only
   those orders — it refuses anything else. Repeat single ticks,
   inspecting the printed op/work state between ticks, until the
   operation completes (the 120 s new-order index grace may hold work
   PENDING initially). Any `REVIEW_REQUIRED` → STOP.

   **Completion checkpoint — `APPLIED` is not enough.** Admission may
   start only when the operation is FULLY finished:

   ```sql
   SELECT "phase","sideEffectsDone","involvedOrderIds","createdAt","appliedEvidence"
     FROM "MergeOperation" WHERE "shop" = 'ordermergetest2.myshopify.com';
   ```

   Require: `phase = 'COMPLETED'` AND `sideEffectsDone = true`, plus the
   durable merge evidence: `MergeRecord` rows, `MergeMutationAttempt`
   SUCCEEDED rows for `EDIT_COMMIT` and `ORDER_CANCEL`, tokened primary
   lines, the secondary `cancelledAt` + canonical staff note,
   `OrderEditAgreement` attributed to `gid://shopify/App/426185785345`,
   `involvedOrderIds` exactly the two approved orders, `createdAt` after
   every Phase 1 epoch, and `transport.jsonl` showing only merge-mode
   mutations (orderEdit*/orderCancel/tagsAdd/orderUpdate/orderClose).
6. **Disable the merge switches** (same UPDATE with `false`).
7. **Wait 15 minutes** from the secondary's `cancelledAt` (admission
   settle delay).

## Phase 3 — admission → PREPARED

```bash
npx vite-node --script scripts/s3-cli.ts admission --evidence $EVID          # dry-run
npx vite-node --script scripts/s3-cli.ts admission --evidence $EVID --apply
npx vite-node --script scripts/shipping-refund-admin.ts status --shop ordermergetest2.myshopify.com
```

Expected: one `ShippingRefund` row → `PREPARED`, `lane='EXECUTE'`,
`policyKind='REFUND_ALL'`, `plannedShippingMinor='400'`, `wireHash`
frozen, epochs matching the live gate.

## Phase 4 — frozen wire inspection + operator approval

```bash
npx vite-node --script scripts/s3-cli.ts wire --row <ID>
# shipping-only refundCreate, $4.00 USD, parent = the secondary's bogus
# capture, idempotencyKey present. Record the wireHash.
npx vite-node --script scripts/shipping-refund-admin.ts approve-hash \
  --row <ID> --hash <wireHash> --by <operator> --apply
```

## Phase 5 — dispatch (T3 → single send → T4)

```bash
MERGESHIP_SHIPPING_REFUNDS=enabled npx vite-node --script scripts/s3-cli.ts dispatch \
  --row <ID> --source <secondary gid> --primary <primary gid> \
  --expect-db mergeship_test_s3a --evidence $EVID               # dry-run checks
MERGESHIP_SHIPPING_REFUNDS=enabled npx vite-node --script scripts/s3-cli.ts dispatch \
  --row <ID> --source <secondary gid> --primary <primary gid> \
  --expect-db mergeship_test_s3a --evidence $EVID --apply
```

The fail-closed preflight (`evaluateS3DispatchPreflight`): disposable DB
name, dev store, exactly one due PREPARED row and it is `--row`, expected
order ids, approved 64-hex wire hash, integer `plannedShippingMinor ≤
400`. Then the unchanged `runShippingRefundDispatchCycle` → T3 →
`DispatchPermit` → `sendRefund` → T4, with the refund-mode transport.
Expected: `PREPARED → DISPATCHING → REFUND_RECORDED`, `refundId` set,
exactly one `refund`-mode mutation line in `transport.jsonl`. Any
`WAIT`/`ABORTED`/`TRANSPORT`/`IN_DOUBT` → STOP, do not re-run dispatch.

## Phase 6 — read-back, reconciliation, verification

After the 15-minute visibility window:

```bash
npx vite-node --script scripts/s3-cli.ts reconcile --evidence $EVID --apply
```

Expected: `REFUND_RECORDED → VERIFIED`; Q-AGREEMENTS shows exactly one
`RefundAgreement` linked to the refund with `app.id =
gid://shopify/App/426185785345`. Independently read back Q-REFUND-DETAIL
and Q-AGREEMENTS with the pinned documents into `$EVID`. Run `reconcile`
again — idempotent, no new events.

## Evidence capture

`$EVID` (`docs/evidence/shipping-v0-s3/`): git SHA, identity probe,
production-isolation read-back, DB fingerprint + migration list, Phase 1
epochs, order verification reads, every stage's JSON result and
`transport.jsonl`, MergeOperation/MergeRecord/MergeMutationAttempt rows,
the `ShippingRefundEvent` journal (`∅→QUEUED→PREPARED→DISPATCHING→
REFUND_RECORDED→VERIFIED`), wire hash and approval row, refund GID, the
read-backs; sealed with `MANIFEST.sha256`.

## Emergency stop

```bash
npx vite-node --script scripts/shipping-refund-admin.ts set-control \
  --admission off --dispatch off --note "S3 halt" --by <operator> --apply
```

```sql
UPDATE "AppControl" SET "newMergesEnabled" = false, "completionEnabled" = false,
  "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC' WHERE "id" = 'control';
```

Unset `MERGESHIP_SHIPPING_REFUNDS` and `MERGESHIP_MUTATIONS`. Reconcile
remains safe (read-only toward Shopify). Never `resolve` a
`REVIEW_REQUIRED` row before review.

## Stop conditions (halt, keep evidence, report)

- Any second mutation, retry, or second idempotency key; any
  `rejected-by-policy` line in `transport.jsonl`.
- `IN_DOUBT` / `REVIEW_REQUIRED` anywhere; `ROW_ERROR` / `LEASE_LOST`.
- Missing/extra `RefundAgreement`, `app.id` ≠ MergeShip, refund id
  mismatch.
- A non-bogus or non-test transaction; any unexpected order or refund.
- Production auto-merge not verified off before the orders.

## Cleanup

Disable the disposable-DB controls (emergency-stop commands). Remove the
`S3 Test Shipping` rate (Shopify Admin → Settings → Shipping and
delivery → the profile → the zone → `S3 Test Shipping` → Delete → Save).
Drop the disposable database, unset env vars. Dev-store orders, merge
records and the refund remain as evidence.

## S3-AUTH — the authorization the operator must grant

Written approval for: **(a)** a temporary `S3 Test Shipping` $4.00 flat
rate plus two storefront checkouts paid through the Bogus Gateway;
**(b)** the app's own Protocol v2 combine (`orderEditCommit` +
`orderCancel`) on those orders, executed through the S3 CLI transport;
**(c)** admission/preparation of the secondary's shipping refund;
**(d)** exactly **one** `refundCreate`, shipping-only, ≤ $4.00 USD. Plus
the separate Phase P production setting change. Nothing else: no real
gateway, no other production change, no other shops, no additional
mutations.
