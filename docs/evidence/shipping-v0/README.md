# Shipping v0 Phase 2 evidence archive — G-READBACK / G-AGREEMENT-A / G-INTROSPECT

Runs: 2026-10-24/25 (UTC). Store `ordermergetest2.myshopify.com`, pinned API
`2026-04`, verified app id `gid://shopify/App/426185785345` (Q-APPID live
read). Channels: `shopify app execute` (shape validation) and
`admin-graphql-http` with `Shopify-GraphQL-Cost-Debug: 1` over an expiring
offline session minted via `shopify app dev --use-localhost` into disposable
DB `mergeship_test_cost_readback` (cost measurement). Read-only only; no
mutations sent. Runner: `scripts/shipping-refund-readback.ts` — enforces
store, app id and no-`mutation` before any order read. Manifest:
`MANIFEST.sha256` covers every file; `tests/evidence-manifest.test.ts`
verifies it. Register: `validation-register.json`.

## Document results

| Document / run | Verdict |
|---|---|
| Q-APPID | PASS — app id from `currentAppInstallation`; requested/actual cost 2/2 |
| Q-RECHECK (cancelled secondary + PAID primary) | PASS — cost 5/5 |
| Q-RECONCILE ×7 | PASS — cost 4/4 each |
| Q-REFUND-DETAIL, 5 ids | **INCOMPLETE (honest)** — executes, identities/order-association correct, costs 31/27; refund `1120895828215` (`#1104`, zero-value restock-shaped) reports `refundLineItems.hasNextPage = true`, nested evidence incomplete |
| Q-REFUND-DETAIL, strict single (E6) | PASS via `validateRefundDetailResponse` — cost 31/21 |
| Q-AGREEMENTS ×6 | PASS — one page each, `hasNextPage: false`, raw pages archived; cost 24/4 per page |
| G-INTROSPECT | PASS — `idempotent(key: String!)` at FIELD location |
| **Query cost gate (12.1.2)** | **PASS — every document and every agreement page far below `requestedQueryCost <= 500`** |

## G-AGREEMENT Part A (§12.8.2): INCONCLUSIVE

- **BASE** `gid://shopify/Order/8052786135287`: `refunds: []`, `PAID`,
  `SALE`-only; only `OrderAgreement/ORDER` with our app id. Cancellation
  provenance VERIFIED via `base-cancel-events.json` (MergeShip restock +
  cancel events at `cancelledAt`) — `STRICT_EMPTY` supported for this
  secondary.
- **POS** E1/E2/E6: each exactly one `RefundAgreement/REFUND` with our app id,
  shipping-only shape, SUCCESS REFUND txn, marker note. Provenance remains
  inferred (run records unrecoverable).
- **NEG**: none exists on the store; #1104's zero-value restock-shaped refund
  and #1099's app-attributed refund are informative only.
- `ATTRIBUTION_STATUS` stays `UNVERIFIED`.
