# S3 Run 3 — execution + reconciliation: PASS (VERIFIED)

Separate from the frozen-wire evidence in `../shipping-v0-s3-run3/` (unchanged).

Result: exactly ONE `refundCreate` (transport.jsonl: 1 mutation total),
refund `gid://shopify/Refund/1127322779895`, USD 4.00 shipping-only on #1138,
parent capture `gid://shopify/OrderTransaction/10262841229559`, refund
transaction `gid://shopify/OrderTransaction/10263222714615` (SUCCESS,
test:true, bogus), RefundAgreement attributed to
`gid://shopify/App/426185785345`. Journal:
∅→QUEUED→PREPARED→DISPATCHING→REFUND_RECORDED→VERIFIED; reconcile re-run
idempotent (no new events, row unchanged).

Index:
- x-01: production isolation re-read (autoMergeEnabled=false, read-only tx)
- x-02: canonical preflight + frozen row re-read — byte-identical to r3-23
- x-03: Shopify #1138 pre-dispatch (0 refunds, original test capture)
- x-04/05: approve-hash dry-run, apply, persisted approval == frozen wire hash
- x-06: S3 dispatch preflight dry-run (--expect-db mergeship_test_s3c), 7/7 checks
- x-07: single guarded dispatch (DISPATCHED:ACCEPTED), start/end timestamps
- x-08: post-dispatch row (REFUND_RECORDED)
- x-09: immediate Shopify read-back
- x-10: reconcile after the 15-min window → VERIFIED (settlementState SUCCESS)
- x-11/12/13: verified row + idempotent reconcile re-run
- x-14: final Shopify read-back
- transport.jsonl: every CLI call of this phase (metadata only)

Known discrepancy (not a gate; recorded as-is): stored
`ShippingRefund.refundCreatedAt` = 2026-11-05T18:57:09 vs Shopify
createdAt 2026-11-05T15:57:09Z (+3h). Cause:
`shipping-refund-dispatch.server.ts` T4 write binds `new Date(...)` into a
naive timestamp column under the Asia/Amman session timezone (the store
layer's equivalent write uses naiveUtc()). Reconciliation does not read
this column; the VERIFIED decision is unaffected.
