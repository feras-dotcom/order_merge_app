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
verifies it. Register: `validation-register.json`. Line endings are pinned by
`.gitattributes` (`docs/evidence/** -text`) so the hashed bytes are identical
on every checkout.

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
  `SALE`-only; only `OrderAgreement/ORDER` with our app id.
  `base-cancel-events.json` shows `BasicEvent`s with `appTitle: "MergeShip"`
  ("MergeShip restocked 1 line item.", "MergeShip canceled this order.") at
  `cancelledAt`. Those events name the app by display title, not app GID, and
  do not establish the exact `orderCancel` arguments or that the Protocol v2
  execution path issued the cancel. What the record does show — a
  MergeShip-labelled cancel and restock that left no refund record and no
  `RefundAgreement` — supports `STRICT_EMPTY` for this secondary.
- **POS** E1/E2/E6: each exactly one `RefundAgreement/REFUND` with our app id,
  shipping-only shape, SUCCESS REFUND txn, marker note. Creation records are
  recovered from contemporaneous session logs (`E1.json`, `E2.json`,
  `E6.json`: `refundCreate` sent via `shopify app execute` in the MergeShip app
  repository). Whether they satisfy the §12.8.1 POS provenance requirement is
  for independent review.
- **NEG**: none exists on the store. #1104's zero-value restock-shaped refund
  has no linked `RefundAgreement` and no recorded creator (informative only).
  #1099's refund was created by an agent-run Scenario 5A driver using
  MergeShip's own client-credentials token (`refund-1099-provenance.json`): it
  is app-created, so it is not a NEG and cannot establish NEGATIVE.
- `ATTRIBUTION_STATUS` stays `UNVERIFIED`.

## G-EVIDENCE: E0/E1/E2/E6 (§17)

The original evidence directory (`%TEMP%/mergeship-shipping-feas/evidence/`,
33 files) no longer exists. `E0.json`, `E1.json`, `E2.json` and `E6.json` are
allowlist extracts from the contemporaneous Devin session transcripts and the
agent host's command logs; every item carries its source, message or shell
session id, and the sha256 of the unsanitized excerpt and source file.

| Recovered | Not recoverable |
|---|---|
| exact mutation documents and variables (cancel/close byte-exact; refund documents reconstructed from the logged commands), idempotency keys, execution tool and credentials path, verbatim `orderCancel` / `orderClose` / `refundCreate` responses incl. E6 concurrent A/B, replay and changed-payload results, request/response UTC stamps, original PASS reports | the 33 original files as files; raw read-back responses (only the projected summaries printed at the time survive, except the E2-5 preview); raw E0 introspection; operator initials (never recorded) |

Later G-READBACK reads of the same orders are separate observations, not
E-experiment evidence.
