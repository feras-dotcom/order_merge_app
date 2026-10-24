# Shipping v0 Phase 2 evidence archive — G-READBACK / G-AGREEMENT-A / G-INTROSPECT

Runs: 2026-10-24 (UTC, two runs; current artifacts are from the corrected runner
`scripts/shipping-refund-readback.ts`, run 2+). Store `ordermergetest2.myshopify.com`,
pinned API `2026-04`, verified app id `gid://shopify/App/426185785345` (Q-APPID
live read). Channel: `shopify app execute` (authorized CLI session) — returns
`data` only; `extensions.cost` is not exposed by this channel, so cost fields
remain unmeasured (see below). Read-only queries only; no mutations were sent.
Manifest: `MANIFEST.sha256` covers every file in this directory including this
README and the register; `tests/evidence-manifest.test.ts` verifies it.
Register: `validation-register.json`.

## Document results

| Document / run | Verdict |
|---|---|
| Q-APPID | PASS — app id read from `currentAppInstallation` |
| Q-RECHECK (cancelled secondary + PAID primary) | PASS |
| Q-RECONCILE ×7 (no-refund, refunded, cancelled, NEG candidates) | PASS each |
| Q-REFUND-DETAIL, 5 ids | **INCOMPLETE (honest)** — document executes and all identities/order associations are correct, but refund `1120895828215` (`#1104`, zero-value restock-shaped record) reports `refundLineItems.pageInfo.hasNextPage = true`, so its nested evidence is not complete. `nodes(ids:)` accepts Refund GIDs; `duties` array; E6 refund fully complete. |
| Q-REFUND-DETAIL, strict single (E6) | PASS via `validateRefundDetailResponse` |
| Q-AGREEMENTS ×6 (BASE/POS/NEG orders) | PASS — one page each, `pageInfo.hasNextPage: false`; raw per-page responses archived under `rawPages` (E-2 fix) |
| G-INTROSPECT | PASS — `idempotent(key: String!)` at FIELD location, 2026-04 |
| Query cost (all 5) | **INCOMPLETE** — channel cannot expose `extensions.cost`; see cost gap below |

## G-AGREEMENT Part A (§12.8.2): INCONCLUSIVE

- **BASE** `gid://shopify/Order/8052786135287`: `refunds: []`, `PAID`,
  `SALE`-only transactions; its only agreement is `OrderAgreement/ORDER`
  carrying our app id. **Cancellation provenance VERIFIED** via
  `base-cancel-events.json`: order events `MergeShip restocked 1 line item.`
  and `MergeShip canceled this order.` (appTitle `MergeShip`,
  `2026-10-05T10:32:57Z` = `cancelledAt`) — a Protocol v2 `restock: true`
  cancellation leaving zero refund records → `STRICT_EMPTY` is safe **for this
  tested secondary** (no claim that all cancellations behave identically).
- **POS** E1/E2/E6 refunds: each has exactly one `RefundAgreement/REFUND` with
  our app id and linked refund id, shipping-only shape, one SUCCESS REFUND
  transaction, marker note. Creation provenance remains **inferred** — original
  E-run records are unrecoverable; the RefundAgreement itself does not
  establish who called `refundCreate`.
- **NEG**: no staff-created Admin refund exists on the store. #1104's
  zero-value/10-line-item refund (no linked RefundAgreement) is restock-shaped,
  informative only; #1099's refund is app-attributed.
- **Classification: INCONCLUSIVE** — POS present but no comparable NEG and POS
  provenance is inferred. `ATTRIBUTION_STATUS` stays `UNVERIFIED`.

## Cost gap (open)

`shopify app execute` prints only `data`; `extensions.cost` requires a
header-capable session (`Shopify-GraphQL-Cost-Debug: 1`). A stale CLI dev
session token exists but returns 401. The runner supports a token channel
(`SHIPRB_TOKEN_ENV=<env name>`) for when a valid offline session exists;
`cost` fields will then be populated per document. The smallest unblocking
operator step is listed in the delivery report.
