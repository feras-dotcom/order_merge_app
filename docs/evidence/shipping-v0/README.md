# Shipping v0 Phase 2 evidence archive — G-READBACK / G-AGREEMENT-A / G-INTROSPECT

Run: 2026-10-24 (UTC), store `ordermergetest2.myshopify.com`, pinned API `2026-04`,
verified app id `gid://shopify/App/426185785345` (Q-APPID, live read).
Channel: `shopify app execute` (authorized CLI session). Read-only queries only;
no mutations were sent. Runner: `scripts/shipping-refund-readback.ts`.
Manifest: `MANIFEST.sha256`. Register: `validation-register.json`.

## Results

| Document / gate | Verdict |
|---|---|
| Q-APPID | PASS — app id read from `currentAppInstallation` |
| Q-RECHECK (cancelled secondary + PAID primary) | PASS |
| Q-RECONCILE ×7 (no-refund, refunded, cancelled, NEG candidates) | PASS each |
| Q-REFUND-DETAIL (5 ids, worst-case bound; strict single) | PASS — `nodes(ids:)` accepts Refund GIDs; `duties` array; nested connections `hasNextPage:false`; positional id match |
| Q-AGREEMENTS ×6 (BASE/POS/NEG orders) | PASS — single page each, `hasNextPage:false` |
| G-INTROSPECT | PASS — `idempotent(key: String!)` at FIELD location on 2026-04 |
| Query cost | INCOMPLETE — `app execute` returns `data` only; `extensions.cost` not exposed by this channel |

## G-AGREEMENT Part A (§12.8.2): INCONCLUSIVE

- **BASE** `gid://shopify/Order/8052786135287` (MergeShip-cancelled secondary;
  OrderAgreement/ORDER carries our app id): `refunds: []`, `PAID`, `SALE` only.
  Restock cancellation leaves ZERO refund records → `STRICT_EMPTY` is safe.
- **POS** E1/E2/E6 refunds: each has exactly one `RefundAgreement/REFUND`,
  app = ours, linked refund id, shipping-only shape, SUCCESS REFUND txn,
  marker note. Provenance is inferred from the marker note + app-linked
  agreement; original E-run records were not recoverable.
- **NEG**: no staff-created Admin refund exists on this store. #1104's
  zero-value refund (10 line items, 0.00, no linked RefundAgreement) is a
  restock-shaped record — informative only. #1099's refund is app-attributed.
- **Classification: INCONCLUSIVE** — POS present but no comparable NEG, and
  POS provenance is inferred. `ATTRIBUTION_STATUS` stays `UNVERIFIED`.
