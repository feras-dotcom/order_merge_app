# S3 Run 2 — blocked at admission (CANCELLED_AT_INVALID)

Outcome: **BLOCKED** — the combine completed and the secondary cancellation was
verified by Shopify, but admission classified the operation
`CANCELLED_AT_INVALID` and wrote a terminal REVIEW_REQUIRED ShippingRefund row.
No refund was prepared; `approve-hash`/`refundCreate` never ran.

Root cause (fixed in the commit introducing this directory): the `COMPLETED`
move in `stepApplied` wrote the in-memory `secondaries` array — which only
carried `cancelPhase` — over the richer entry `recordHistoryAndVerifyCancel`
had persisted, erasing `cancelledAt`/`staffNoteMatched`/`done` from the
durable record. `production main@07773b5` contains the same defect; no
production remediation was performed.

Index:
- r2-01: production isolation re-read (autoMergeEnabled=false, read-only tx)
- r2-00/02: disposable DB `mergeship_test_s3b` provision + clean baseline
- r2-03/04/05: Phase 1 controls, S2 controls, approval; opt-in epoch equality TRUE
- r2-06/07/08: CLI identity, store survey, granted scopes
- r2-10: independent order verification (#1135/#1136, PAID, $4.00 S3 Test Shipping)
- r2-11: backfill (exactly the two orders, switches off)
- r2-12/13: merge switches on (disposable DB), scoped sweep dry-run
- r2-14/15/16: single-tick combine → COMPLETED+sideEffectsDone; durable op/
  attempts/records; Shopify read-back (cancellation, MergeShip attribution,
  tokened line, order-cancel job)
- r2-17/18: admission dry-run + apply; the CANCELLED_AT_INVALID terminal row
  and the secondaries entry missing `cancelledAt`
- transport.jsonl: every CLI call (no variables/credentials); 10 merge
  mutations, 0 policy rejections
