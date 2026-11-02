# A-NEG + G-E7 development-store campaign runbook

Scope: `ordermergetest2.myshopify.com` only, Admin API `2026-04`, app
`gid://shopify/App/426185785345`. Three **separately authorized** actions.
**Nothing in this file executes a mutation.** Each experiment has its own
approval checkpoint below; all must be signed before its first send.

References: design `docs/SHIPPING-PHASE2-DESIGN.md` §§10, 12.8, 17, 18, 20.1.1,
Appendix E (U1, U5); evidence `docs/evidence/shipping-v0/` (E0/E1/E2/E6
recovered records, validation register); contract
`app/lib/shipping-refund-contract.ts`; queries `app/lib/shipping-refund-queries.ts`;
campaign read-back `scripts/shipping-refund-campaign-readback.ts`.

---

## 1. Selected test objects

| Role | Order | State | Refundable shipping | Parent transaction |
|---|---|---|---|---|
| **G-E7** | `#1133` `gid://shopify/Order/8078037057783` | `PARTIALLY_REFUNDED`, open, `test: true`, `refundable: true` | `8.00 − 3.00 = 5.00 USD` | CAPTURE `gid://shopify/OrderTransaction/10162809569527` (bogus, SUCCESS, test, 18.00) |
| **A-NEG** | **a fresh order, created under checkpoint NEG-ORDER-AUTH** (§4.1) | must verify `PAID`, `test: true`, bogus transactions | ≥ `2.00 USD` | recorded after creation |

- `#1131`, `#1132`: fully refunded — ineligible.
- All other existing orders are manual-gateway `$0`-shipping Protocol
  fixtures (`test: false` transactions) — ineligible under the guard.
- **A-NEG eligibility correction:** §12.8.1 requires the NEG on a **PAID**
  order. `#1133` is `PARTIALLY_REFUNDED`, so it is **not** presented as a
  qualifying NEG order without an independently approved eligibility
  clarification — the runbook therefore provisions a separate fresh PAID
  bogus-gateway order instead (§4.1). `#1133` stays reserved for G-E7.
- **Amounts:** G-E7 `1.00 USD`; A-NEG `2.00 USD`. Maximum new financial
  effect: one `1.00` + one `2.00` test refund (bogus, `test: true`) — no
  real money moves.

## 2. Preflight (read-only; before each experiment and between sends)

Guard criteria — all must hold, else STOP:

- `shop.myshopifyDomain == ordermergetest2.myshopify.com` and
  `plan.partnerDevelopment == true` (checked by the campaign runner's
  identity gate before any order read).
- `order.test == true`; every `paymentGatewayNames` is `bogus`; every
  transaction `test == true`.
- `order.refundable == true`; `displayFinancialStatus` ∈ {PAID, PARTIALLY_REFUNDED}.
- Refundable shipping ≥ planned amount (`totalShippingPriceSet −
  totalRefundedShippingSet`).
- Parent transaction recorded as `kind: CAPTURE` (or `SALE`), `status:
  SUCCESS`, `gateway: bogus`, `test: true`.
- Baseline snapshot persisted to the evidence dir **before** any send:
  `refunds(first:50)` ids+count, agreement ids, totals — the proof that
  exactly one new refund was created.
- No MergeShip merge operation, lock, claim or pending work item involves
  the order.

Read-only channels:

```bash
# ad-hoc read
npx shopify app execute --store ordermergetest2.myshopify.com --version 2026-04 \
  --query-file <doc>.graphql [--variable-file <vars>.json]

# campaign read-back (identity-gated, manifest-writing, read-only)
npx vite-node --script scripts/shipping-refund-campaign-readback.ts \
  --label <name> [--order <gid> ...] [--refund <gid> ...] [--out docs/evidence/shipping-v0-e7]
```

The runner refuses to run unless `SHIPRB_STORE` is the approved store,
proves shop + app identity before any order read, classifies any
incomplete read as INCOMPLETE, writes sanitized artifacts +
`MANIFEST.sha256`, and never sends a mutation. Run it from the app
repository. Mutations use `npx shopify app execute` directly — there is
**no** `--allow-mutations` flag (E1-1a proved it does not exist).

---

## 3. G-E7 — app-credential `refundCreate` + variable idempotency key

**Approval checkpoint E7-AUTH** (operator sign-off required before step 1).

Goal (§22, Appendix E U1/U2/U13): accept or reject the variable
`@idempotent(key: $idempotencyKey)` form; observe **first-execution
concurrency**, identical replay, altered-payload mismatch, and the exact
error locations/shapes.

### 3.1 Persist BEFORE any send

Create evidence dir `docs/evidence/shipping-v0-e7/` (the pinned S1 archive
`docs/evidence/shipping-v0/` must not gain or lose files — the fixture
suite pins its manifest hash; the campaign runner writes here only).

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

This is exactly `REFUND_DOCUMENT` (10.1) — the variable form is U1. If it
is rejected, the documented fallback is the §10.3 template (literal
`key: "<uuid>"` rendered into the document; the template and renderer live
in `app/lib/shipping-refund-contract.ts`). Switching is a recorded design
branch, not a failure — **but only after proving no refund was created**
(§3.3 step F).

```bash
KEY=$(node -e 'console.log(require("crypto").randomUUID())')
echo "$KEY" > "$D/e7-idempotency-key.txt"        # persisted, never regenerated
cat > "$D/e7-vars-1.00.json" <<EOF
{"input":{"orderId":"gid://shopify/Order/8078037057783","note":"MS-SHIPREFUND-E7-$KEY","notify":false,"currency":"USD","shipping":{"fullRefund":false,"amount":"1.00"},"transactions":[{"orderId":"gid://shopify/Order/8078037057783","parentId":"gid://shopify/OrderTransaction/10162809569527","gateway":"bogus","kind":"REFUND","amount":"1.00"}]},"idempotencyKey":"$KEY"}
EOF
cat > "$D/e7-vars-changed-0.50.json" <<EOF
{"input":{"orderId":"gid://shopify/Order/8078037057783","note":"MS-SHIPREFUND-E7-$KEY","notify":false,"currency":"USD","shipping":{"fullRefund":false,"amount":"0.50"},"transactions":[{"orderId":"gid://shopify/Order/8078037057783","parentId":"gid://shopify/OrderTransaction/10162809569527","gateway":"bogus","kind":"REFUND","amount":"0.50"}]},"idempotencyKey":"$KEY"}
EOF
```

Payload conformity (§10.4, contract `buildRefundInput`/`validateRefundInput`):
the input carries `currency: "USD"`, `shipping.fullRefund: false`,
`notify: false`, exactly one `REFUND` transaction allocated to the verified
CAPTURE, amount equal to the shipping amount, no `refundLineItems`, no
restock, no `allowOverRefunding`, no refund methods, no store credit — both
amounts exactly `1.00 USD` in the create payload (`0.50` only in the
deliberately mismatched step). The accepted E6 payload predates the §10.4
contract and omitted `currency`/`fullRefund`; this campaign conforms to the
accepted contract. **If Shopify's schema rejects any of these fields, STOP
and record the verbatim rejection — never silently drop a contract field.**

### 3.2 Execution sequence

| Step | Action | Expected | If unexpected |
|---|---|---|---|
| 0 Preflight | §2 checks; persist baseline (refund ids/count, agreement ids, totals) → `e7-0-baseline.json` | all pass | STOP |
| **1 Concurrent create** | two **simultaneous** `shopify app execute` sends of `e7-refund.graphql` + `e7-vars-1.00.json` with the same fresh `KEY` (background `&`-pair, as in E6) → `e7-1-concurrent-A.json`, `e7-1-concurrent-B.json` | **exactly one new refund.** Either (a) both return the same `refund.id`, or (b) one returns the refund and the other `refund: null` + a concurrency/order-availability userError. **Classify the actual observed response — do not assume which process succeeded** | two different refund ids → STOP, reconcile §6; transport ambiguity → read back before any further send |
| 2 Read-back | `--label e7-2-after-create --order 8078037057783 --refund <new refund gid>` (runner) | refund count +1 vs baseline only; `1.00` REFUND/SUCCESS/bogus/test, parent CAPTURE; exactly one `RefundAgreement/REFUND` linked to it, `app.id = 426185785345` | STOP |
| 3 Identical replay | same doc + vars as step 1 → `e7-3-replay.json` | same `refund.id`, original `createdAt`, `userErrors: []`; refund count unchanged | new id → STOP |
| 4 Altered-payload mismatch | same key + `e7-vars-changed-0.50.json` → `e7-4-mismatch.json` | `refund: null` + idempotency-mismatch userError (E6 observed `field: null`, message "Idempotency key has been used with a different request payload."); record the actual shape/location verbatim | record verbatim; no retry |
| 5 Final | `--label e7-5-final` re-read: refund ids = baseline ∪ {step-1 refund}; count +1; `totalRefundedShippingSet` `3.00→4.00` | pass | STOP, reconcile §6 |

This ordering proves **first-execution concurrency** (the refund does not
yet exist when both processes send), unlike a concurrency test run after a
successful create.

### 3.3 Variable-key rejection branch (designed, not a failure)

If step 1 shows the variable `@idempotent(key: $idempotencyKey)` form is
**rejected** (schema/top-level error naming the directive or key — record
verbatim as the U1 answer):

**F.** Prove zero effect before fallback: read back the order
(Q-RECONCILE + Q-REFUND-DETAIL + Q-AGREEMENTS via the runner, `--label
e7-F-zero-proof`) and confirm refund ids/count == baseline, totals
unchanged, no new agreement. **Only then** render the §10.3 literal-key
document with the same persisted `KEY` (never a new key) into
`e7-refund-literal.graphql`, and re-run step 1's concurrent pair with it.
Record which form produced each artifact.

### 3.4 Bounds and stops

**Maximum financial effect: exactly one `1.00 USD` test refund.**
Steps 3–4 create nothing. If a literal-key retry were ever needed it runs
the same one-refund bound.

Stop conditions (all sends halt): non-empty `userErrors` not matching a
designed idempotency case; transport ambiguity (timeout, THROTTLED, dropped
response — read back first, never resend); two refund ids; an unexpected
`RefundAgreement`; count/totals drift vs baseline. **Never generate a
replacement key for an ambiguous outcome.**

---

## 4. A-NEG — staff-created Admin refund (negative control)

**Two approval checkpoints:** `NEG-ORDER-AUTH` (order creation) and
`ANEG-AUTH` (the staff refund itself — a human Admin UI action, never
scripted, never with MergeShip credentials).

Goal (§12.8.1 NEG): one **comparable** staff refund — shipping-only on a
**PAID** development-store test order — whose `RefundAgreement`
discriminates staff- from app-created refunds.

### 4.1 Create the NEG order (checkpoint NEG-ORDER-AUTH)

A fresh order is required because `#1133` is `PARTIALLY_REFUNDED`, not
`PAID`. Creation options (operator picks one; both stay inside the dev
store's Bogus test gateway so the guard passes):

- **Storefront checkout:** on `ordermergetest2` storefront, buy any product
  with a shipping method priced **≥ $2.00**, paying via the store's test
  gateway ("Bogus Gateway", card number `1`, any expiry/CVV). Completes as
  `PAID` with `test: true` transactions.
- **Admin → Orders → Create order:** add a product and a custom shipping
  charge ≥ `$2.00`; collect payment **through the test gateway** (test
  card `1`) — do **not** use "Mark as paid"/"Payment due later", which
  produce `manual`-gateway transactions the guard rejects.

After creation, run the campaign runner
(`--label neg-order-verify --order <new gid>`): the order must show
`displayFinancialStatus = PAID`, `test: true`, `refundable: true`, all
gateways `bogus`, all transactions `test: true`, and refundable shipping ≥
`2.00`. **If the guard fails, the order is not a NEG candidate — stop and
record; do not relax the guard.** Record the new order gid, its CAPTURE/SALE
transaction gid, and refundable shipping into the evidence dir.

### 4.2 Staff refund (checkpoint ANEG-AUTH — human action)

1. Sign in to `ordermergetest2` Admin as a staff/collaborator account —
   record **role label only** (e.g., "staff, store owner role"), never a
   staff identity or email (§17 exclusions).
2. Open the new order → **Refund**.
3. Leave every line-item quantity at **0** (no merchandise refund); set
   **Refund shipping** to **`$2.00`**; disable any restock and
   notification toggles; submit.
4. Record the new refund id from the order timeline and the UTC time as
   staff-provenance metadata in the evidence dir.

If the Admin UI **cannot produce a shipping-only refund** on this order,
that is the blocker to report — do **not** substitute a merchandise or
monetary-only refund; a non-comparable shape is informative only and can
never contribute to the attribution verdict (§12.8.1, §12.8.2).

### 4.3 Evidence checks (read-back)

Immediate (runner `--label aneg-post-refund --order <NEG order gid>
--refund <NEG refund gid>`):

- Refund ids on the order = exactly the one new refund; `totalRefundedSet =
  2.00`; REFUND transaction `SUCCESS`, `test: true`, `gateway` as observed
  (record verbatim — do not infer creator from gateway); parent = the
  order's CAPTURE/SALE.
- Q-REFUND-DETAIL on the new refund id (strict binding).

Then **wait ≥ 15 minutes after `processedAt`** (visibility window,
§12.8.2) and re-run the agreement reads (`--label aneg-agreements-recheck`):

- Expected discriminator: a `RefundAgreement` linked to the NEG refund
  with `app: null` or `app.id ≠ 426185785345`. `app.id == ours` →
  NEGATIVE for the rule; no linked agreement after the window →
  INCONCLUSIVE.
- The G-E7 order (`#1133`) agreement reads are re-run in the same pass so
  POS and NEG are compared under identical read conditions.

### 4.4 Side effects

Exactly one `2.00 USD` test refund on a dedicated order. Refunds are
irreversible: a wrong amount is recorded, not "rolled back".

## 5. Part B sequencing clarification (proposal — not applied)

§18 step 6 and §22 place "G-AGREEMENT part B" *inside* G-E7 as "the first
dispatcher-created refund", but the dispatcher exists only in S2. The
minimal consistent reading, proposed for review (no acceptance condition
changed unilaterally):

- **G-E7** proves `refundCreate` and idempotency semantics through
  MergeShip's own app credentials — the same credential identity the S2
  dispatcher will use.
- **A-NEG** supplies the staff-created discriminator. POS (G-E7) + NEG
  (A-NEG) + BASE (already recorded) satisfy §12.8.2 for **CONFIRMED** of
  the attribution *rule*, provided the NEG agreement is comparable and
  read after the visibility window.
- **Dispatcher-origin attribution** — that a refund came from the S2
  dispatcher specifically — can only be exercised once S2 exists; it is
  covered structurally by `RefundAgreement.app.id` + marker/financial/
  timing (§12.3), so the earliest faithful Part B is "first app-credential
  refund of the campaign" — exactly what G-E7 produces.
- Proposed one-line clarification for the next reviewed revision:
  "G-AGREEMENT part B is satisfied by the first `refundCreate` issued with
  MergeShip app credentials in the G-E7 campaign; 'dispatcher-created' is
  shorthand for that same credential path and adds no distinguishable
  evidence." §12.8.4's B-before-S3 ordering is unchanged.

## 6. Stop / reconciliation / rollback

- Any ambiguous outcome: **stop all sends**, reconcile by read-back only
  (campaign runner + Q-RECONCILE/Q-REFUND-DETAIL/Q-AGREEMENTS) — never
  resend, never mint a new key, never issue a compensating refund.
- An unexplained refund or agreement, a missing marker, two refunds for
  one send, or totals diverging from the persisted baseline → campaign
  halts; the discrepancy is archived verbatim and classified per §12.2/§12.5.
- No financial rollback exists on Shopify: remediation for a wrong refund
  is operator manual handling + evidence record, not code.

## 7. Evidence and manifest handling (§17)

- Archive dir: **`docs/evidence/shipping-v0-e7/`** (fresh; the S1 archive
  and its pinned manifest are never modified).
- Allowlist only: documents + sha256, sanitized variables (GIDs, amounts,
  currency, gateway, `test` flags, the persisted key), verbatim responses,
  run metadata (UTC, API version, store, commit SHA, operator initials if
  elected), refund-creation provenance (tool + credential path, or "Admin
  UI, role label only").
- **Exclude always:** tokens, headers, customer names/emails/addresses,
  customer GIDs, payment-instrument details, staff identities/emails.
- The campaign runner writes per-document artifacts + a labelled
  `validation-register-*.json` + `MANIFEST.sha256` (register first,
  manifest last). Mutation-send outputs (`e7-1-*.json` etc.) are added to
  the same dir and the manifest regenerated over every file before commit.
- `.gitattributes` (`docs/evidence/** -text`) pins byte-identical
  checkouts on Windows.

## 8. Cleanup

- `docs/evidence/shipping-v0-e7/` stays (it is the archive).
- Delete scratch dirs (`%TEMP%/ms-e7-prep`, `%TEMP%/shipc-*` temp query
  files the runner writes); they hold no secrets.
- Drop the prior review session's disposable DB (`mergeship_test_s1acc`,
  local embedded Postgres, port 55439) and stop the embedded instance —
  not part of the campaign.
- No development preview/storefront needs teardown — none was created.

## 9. Readiness summary

- **G-E7:** ready on E7-AUTH — document (pinned `REFUND_DOCUMENT`, §10.3
  fallback), payload (§10.4-conformant), key policy (persist once, never
  regen), concurrency-first sequence, runner, bounds (≤ 1 × $1.00).
- **A-NEG:** ready on **two** checkpoints — `NEG-ORDER-AUTH` (operator
  creates the fresh PAID bogus order per §4.1, guard-verified) and
  `ANEG-AUTH` (staff performs the Admin UI refund per §4.2). Residual
  risk: Admin may not offer shipping-only refund → report, no substitute.
- **Approvals are independent:** none of E7-AUTH, NEG-ORDER-AUTH, ANEG-AUTH
  implies another.
