# A-NEG + G-E7 development-store campaign runbook

Scope: `ordermergetest2.myshopify.com` only, Admin API `2026-04`, app
`gid://shopify/App/426185785345`. Two **separately authorized** experiments.
**Nothing in this file executes a mutation.** Each experiment has its own
approval checkpoint below; both must be signed before its first send.

References: design `docs/SHIPPING-PHASE2-DESIGN.md` §§10, 12.8, 17, 18, 20.1.1,
Appendix E (U1, U5); evidence `docs/evidence/shipping-v0/` (E0/E1/E2/E6
recovered records, validation register); contract
`app/lib/shipping-refund-contract.ts`; queries `app/lib/shipping-refund-queries.ts`.

---

## 1. Selected test objects (verified by read-only order scan, this session)

| Role | Order | State | Refundable shipping | Parent transaction |
|---|---|---|---|---|
| **Both experiments** | `#1133` `gid://shopify/Order/8078037057783` | `PARTIALLY_REFUNDED`, open (not cancelled, not closed), `test: true`, `refundable: true` | `8.00 − 3.00 = 5.00 USD` (E6 refunded 3.00) | CAPTURE `gid://shopify/OrderTransaction/10162809569527` (bogus, SUCCESS, test, 18.00) |

- `#1131`, `#1132`: fully refunded (8.00/8.00) — ineligible.
- Every other order on the store is a manual-gateway `$0`-shipping Protocol
  fixture (`test: false` transactions) — ineligible under the guard.
- **Amounts:** G-E7 `1.00 USD` (mirrors E6's bounded $3 test, smaller);
  A-NEG `2.00 USD`. Projected totals: ≤ `3.00` new test refund; final
  `totalRefundedShippingSet ≤ 6.00` of `8.00`. No real money moves (bogus,
  `test: true`).
- One order serves both experiments because refund-discrimination is per
  `refund.id` linkage in `Order.agreements`. A fresh second order is optional
  (needs its own checkout+payment); this runbook does not require it.

## 2. Preflight (read-only; run before each experiment and between sends)

Guard criteria — all must hold, else STOP:

- `shop.myshopifyDomain == ordermergetest2.myshopify.com` and
  `plan.partnerDevelopment == true`.
- `order.test == true`; every `paymentGatewayNames` is `bogus`; every
  transaction `test == true`.
- `order.refundable == true`; `displayFinancialStatus` ∈ {PAID, PARTIALLY_REFUNDED}.
- Refundable shipping ≥ planned amount (`totalShippingPriceSet −
  totalRefundedShippingSet`).
- Parent transaction: the recorded CAPTURE is `status: SUCCESS`,
  `kind: CAPTURE`, `gateway: bogus`, `test: true`.
- Baseline snapshot: `refunds(first: 50)` ids + count, `agreements` ids, and
  `totalRefundedSet`/`totalRefundedShippingSet` — persisted to the evidence
  dir before any send, so "one new refund only" is provable.
- No MergeShip merge operation, lock, claim or pending work item involves the
  order (read-only DB check per the E2 preflight; skip if shop has
  `autoMergeEnabled = false` anyway — verify, don't assume).

Read-only channel for all of it:

```bash
npx shopify app execute --store ordermergetest2.myshopify.com --version 2026-04 \
  --query-file <doc>.graphql [--variable-file <vars>.json]
```

Run from the app repository (`shopify.app.toml` selects the app). Queries and
mutations both go through this command; there is **no** `--allow-mutations`
flag (E1-1a proved it does not exist).

---

## 3. G-E7 — app-credential `refundCreate` + variable idempotency key

**Approval checkpoint E7-AUTH** (operator sign-off required before step 1).

Goal (design §22 / Appendix E U1, U2, U13): accept or reject the variable
`@idempotent(key: $idempotencyKey)` form; measure replay, mismatch,
concurrency and the exact error locations/shapes.

### 3.1 Persist BEFORE any send

Create evidence dir `docs/evidence/shipping-v0-e7/` (new archive — the S1
archive `docs/evidence/shipping-v0/` is manifest-pinned and **must not** gain
or lose files, or every fixture test fails until re-reviewed and re-pinned).

```bash
D=docs/evidence/shipping-v0-e7; mkdir -p "$D"
cat > "$D/e7-refund.graphql" <<'EOF'
mutation MergeShipShippingRefund($input: RefundInput!, $idempotencyKey: String!) {
  refundCreate(input: $input) @idempotent(key: $idempotencyKey) {
    refund {
      id
      note
      createdAt
      totalRefundedSet { presentmentMoney { amount currencyCode } }
    }
    userErrors { field message }
  }
}
EOF
```

This is exactly `REFUND_DOCUMENT` (10.1) — variable key, the U1 decision
point. If it is rejected, the designed fallback is the §10.3 template
(literal `key: "<uuid>"` rendered into the document); switching to it is a
recorded design branch, not a failure, and the experiment continues with the
literal form.

```bash
KEY=$(node -e 'console.log(require("crypto").randomUUID())')
echo "$KEY" > "$D/e7-idempotency-key.txt"        # persisted, never regenerated
cat > "$D/e7-vars-1.00.json" <<EOF
{"input":{"orderId":"gid://shopify/Order/8078037057783","note":"MS-SHIPREFUND-E7-$KEY","notify":false,"shipping":{"amount":"1.00"},"transactions":[{"orderId":"gid://shopify/Order/8078037057783","parentId":"gid://shopify/OrderTransaction/10162809569527","gateway":"bogus","kind":"REFUND","amount":"1.00"}]},"idempotencyKey":"$KEY"}
EOF
cat > "$D/e7-vars-changed-0.50.json" <<EOF
{"input":{"orderId":"gid://shopify/Order/8078037057783","note":"MS-SHIPREFUND-E7-$KEY","notify":false,"shipping":{"amount":"0.50"},"transactions":[{"orderId":"gid://shopify/Order/8078037057783","parentId":"gid://shopify/OrderTransaction/10162809569527","gateway":"bogus","kind":"REFUND","amount":"0.50"}]},"idempotencyKey":"$KEY"}
EOF
```

The key, the exact request document and both variable sets now exist before
the first send. **Never mint a new key because an outcome is ambiguous** —
read back instead.

### 3.2 Steps (each output tee'd to `$D/`)

| Step | Command / action | Expected | If unexpected |
|---|---|---|---|
| 0 Preflight | §2 checks; snapshot refunds/agreements/totals → `e7-0-baseline.json` | all pass | STOP |
| 1 Create | `shopify app execute … --query-file e7-refund.graphql --variable-file e7-vars-1.00.json \| tee $D/e7-1-create.json` | `refund.id` present, `userErrors: []` | variable-key rejection → record verbatim response, switch to §10.3 literal-key doc (`e7-refund-literal.graphql` rendered with `$KEY`), retry once; any other error → STOP, read back |
| 2 Read-back | Q-RECONCILE + Q-REFUND-DETAIL(ids=[new, existing-2]) + Q-AGREEMENTS via `SHIPRB_OUT=$D npx vite-node --script scripts/shipping-refund-readback.ts` | exactly one NEW refund `1.00`, REFUND/SUCCESS/bogus/test parent=CAPTURE; exactly one `RefundAgreement/REFUND` linked to it with `app.id = 426185785345` | mismatch → STOP, classify per 12.2 |
| 3 Replay | same command as step 1, tee `e7-3-replay.json` | same `refund.id`, original `createdAt`, `userErrors: []` | STOP if a second refund id appears |
| 4 Mismatch | `--variable-file e7-vars-changed-0.50.json` \| tee `e7-4-mismatch.json` | `refund: null`, userErrors idempotency-mismatch (E6 observed `field: null`, message "Idempotency key has been used with a different request payload.") — record the actual shape/location verbatim | record whatever Shopify returns; do not retry |
| 5 Concurrent | two background `shopify app execute` with the step-1 doc+vars in the same second (`&`-pair like E6-2/3), tee `e7-5-concurrent-A.json` / `…-B.json` | exactly one creates (A); the other `refund: null` + order-unavailable or idempotency userError — record which | two refunds → STOP, reconcile |
| 6 Final | repeat step-2 read-back → `e7-6-final.json`; refund ids = baseline ∪ {new} only; `refundCount` increased by exactly 1; totals `3.00→4.00` | pass | STOP, reconcile per §6 |

**Maximum financial effect: exactly one `1.00 USD` test refund** (bogus,
`test: true`). Steps 3–5 create nothing. Total order refunds afterwards: 2.

**Stop conditions (all sends halt):** non-empty `userErrors` not matching a
designed idempotency case; any transport ambiguity (timeout, THROTTLED,
dropped response — read back first, never resend); a second refund id; any
unexpected `RefundAgreement`; `refundCount` drift vs baseline.

## 4. A-NEG — staff-created Admin refund (negative control)

**Approval checkpoint ANEG-AUTH** (separate operator sign-off; a human
performs the Admin action — this cannot be automated and must not be done
with MergeShip credentials or scripts).

Goal (§12.8.1 NEG): one **comparable** staff refund — *shipping-only on a
PAID development-store test order* — so its `RefundAgreement` can
discriminate app-created from staff-created refunds.

### 4.1 Operator actions (Shopify Admin UI)

1. Sign in to `ordermergetest2` admin as a staff/collaborator account
   (role label only is recorded — never a staff identity, §17).
2. Open order **#1133** → **Refund**.
3. Leave every line-item quantity at **0**; set **Refund shipping** to
   **$2.00**; disable any "restock" and notification toggles offered;
   submit.
4. Record the refund id from the order timeline and the UTC time.

If the Admin UI **cannot produce a shipping-only refund** on this order
(e.g., the dialog requires a line item, or the shipping refund is
unavailable after a partial refund), that is the blocker to report — do
**not** substitute a merchandise or monetary-only refund; a non-comparable
shape is informative only and can never contribute to CONFIRMED (§12.8.1,
§12.8.2).

### 4.2 Evidence checks (read-back, §17 allowlist)

`SHIPRB_OUT=docs/evidence/shipping-v0-e7 npx vite-node --script scripts/shipping-refund-readback.ts`:

- Q-RECONCILE `#1133`: refund ids now baseline ∪ {G-E7 refund, NEG refund};
  NEG refund `note` as entered (or null), `totalRefundedSet = 2.00`,
  transactions REFUND/SUCCESS (`gateway` expected `bogus`, `test: true`,
  parent CAPTURE — record actuals verbatim, do not infer creator from it).
- Q-REFUND-DETAIL on the NEG refund id.
- Q-AGREEMENTS `#1133` (wait ≥ 15 min after `processedAt` before drawing a
  conclusion — visibility window §12.8.2): expected discriminator —
  a `RefundAgreement` linked to the NEG refund with `app: null` or
  `app.id ≠ 426185785345`. `app.id == ours` → NEGATIVE for the attribution
  rule; no linked agreement → INCONCLUSIVE.

### 4.3 Side effects

Exactly one `2.00 USD` test refund. Final order refunds: 3;
`totalRefundedShippingSet = 6.00` of `8.00`. Nothing reversible exists —
refunds are not undoable; a mistaken amount stays on the order and is
recorded, not "rolled back".

## 5. Part B sequencing clarification (proposal — not applied)

§18 step 6 and §22 place "G-AGREEMENT part B" *inside* G-E7 as "the first
dispatcher-created refund", but the dispatcher exists only in S2. The
minimal consistent reading, proposed for review (no acceptance condition
changed unilaterally):

- **G-E7** proves `refundCreate` and idempotency semantics through
  MergeShip's own app credentials — the same credential identity the S2
  dispatcher will use.
- **A-NEG** supplies the staff-created discriminator. POS (G-E7) + NEG
  (A-NEG) + BASE (already recorded) satisfy §12.8.2 for **CONFIRMED** of the
  attribution *rule* itself, provided the NEG agreement is comparable and
  read after the visibility window.
- **Dispatcher-origin attribution** — that a refund came from the S2
  dispatcher specifically rather than any other call under the same app —
  can only be exercised once S2 exists; it is already covered structurally
  by `RefundAgreement.app.id` plus the marker/financial/timing conjunction
  (§12.3), so the earliest faithful Part B is "first app-credential refund
  of the campaign" — which is exactly what G-E7 produces.
- Proposed one-line design clarification for the next reviewed revision:
  "G-AGREEMENT part B is satisfied by the first `refundCreate` issued with
  MergeShip app credentials in the G-E7 campaign; 'dispatcher-created' is
  shorthand for that same credential path and adds no distinguishable
  evidence." §12.8.4's B-before-S3 ordering is unchanged.

## 6. Stop / reconciliation / rollback

- Any ambiguous outcome: **stop all sends**, then reconcile by read-back
  (Q-RECONCILE, Q-REFUND-DETAIL, Q-AGREEMENTS) — never resend, never mint a
  new key, never issue a compensating refund.
- An unexplained refund or agreement, a missing marker, two refunds for one
  send, or totals diverging from the persisted baseline → campaign halts;
  the discrepancy is archived verbatim and classified per §12.2/§12.5.
- There is no financial rollback on Shopify: the remediation for a wrong
  refund is operator manual handling + evidence record, not code.

## 7. Evidence and manifest handling (§17)

- Archive dir: **`docs/evidence/shipping-v0-e7/`** (fresh; do not modify
  `docs/evidence/shipping-v0/` — the fixture suite pins its manifest hash).
- Allowlist only: documents + sha256, sanitized variables (order/transaction/
  refund GIDs, amounts, currency, gateway, `test` flags, the persisted
  idempotency key), verbatim responses, run metadata (UTC, API version,
  store, commit SHA of this branch, operator initials if the operator
  elects to record them), provenance of each created refund (tool +
  credentials path, or "Shopify Admin UI, role label only").
- **Exclude always:** tokens, headers, customer names/emails/addresses,
  customer GIDs, payment-instrument details.
- After the campaign: `buildManifestLines` (`scripts/lib/evidence-manifest.ts`)
  over every file in the new dir → `MANIFEST.sha256`; commit archive +
  manifest in one reviewed change.
- `.gitattributes` (`docs/evidence/** -text`) already pins byte-identical
  checkouts on Windows.

## 8. Cleanup

- `docs/evidence/shipping-v0-e7/` stays in the repo (it is the archive).
- Delete the operator's scratch working dir (`%TEMP%/ms-e7-prep`); it holds
  no secrets — keep it anyway for audit until the archive is committed.
- Drop the review-session disposable database
  (`mergeship_test_s1acc` on the local embedded Postgres, port 55439) and
  stop/uninstall the embedded instance; it is not part of the campaign.
- No development preview/storefront needs teardown — none was created.

## 9. Readiness summary

- **G-E7:** ready to execute on ANEG-independent approval (E7-AUTH): document,
  variables, key policy, commands and read-backs are all specified above.
- **A-NEG:** ready pending a human operator with Shopify Admin staff access
  to `ordermergetest2` (ANEG-AUTH). The only residual risk is that Admin
  may not offer a shipping-only refund on a partially refunded order —
  then the blocker is reported per §4.1 and no substitute is made.
