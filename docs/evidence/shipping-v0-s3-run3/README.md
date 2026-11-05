# S3 Run 3 — PASS to the frozen-wire checkpoint (no refund sent)

Outcome: admission froze a single shipping-only refund (PREPARED); execution
stopped at the checkpoint. `approve-hash`/`refundCreate`/dispatch never ran —
row `sr_0472d4e2c869467e841ccd8415759147`, wire hash
`b25ed9574e16123b44943b98c41b2eae3c6da1d78ef436e029661fdba5f4c327`.

Index:
- r3-01/07: production isolation re-reads (autoMergeEnabled=false, read-only tx)
- r3-00/02/08: disposable DB mergeship_test_s3c provision, baseline, resume preflight
- r3-03/04/05: Phase 1, S2 controls, approval; opt-in epoch equality TRUE
- r3-06: CLI identity (store + app id match)
- r3-10: independent order verification (#1137/#1138, PAID, $4.00 S3 Test Shipping)
- r3-11: backfill — exactly the two approved orders, merge switches off
- r3-12/13: merge switches on (disposable DB), scoped sweep dry-run
- r3-14/15/16: third listed order investigated — #1135 (run 2 primary, other
  customer) over-matched by unquoted created_at day granularity; switches
  held OFF during the check; not a new order
- r3-17/18/19: switches re-enabled, scope re-verified, single-tick combine
- r3-20/21: COMPLETED+sideEffectsDone; all four persisted secondary fields
  (cancelledAt=2026-11-05T15:04:13Z == Shopify); Shopify read-back with
  MergeShip attribution, tokened line, order-cancel job, no refunds
- r3-22: admission dry-run + apply (>15min settle); QUEUED→PREPARED
- r3-23/24: full frozen row + wire stage output (frozen request as approved
  for review — hash unchanged)
- transport.jsonl: 10 merge mutations (approved documents only), 0 refund-
  mode calls, 0 policy rejections; no variables/credentials recorded
