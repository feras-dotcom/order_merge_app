# MergeShip Shipping v0 — Phase 2: financial-dispatch architecture specification

**Revision 3.1 (post independent G0 review).** Documentation only. Nothing in this document is implemented, and nothing in it authorizes sending a refund, building the dispatcher, migrating production or deploying.

**Independent G0 status: CONDITIONAL GO, not unconditional acceptance.** An independent reviewer (a session separate from the one that authored Revisions 1 to 3) reviewed Revision 3 and returned **CONDITIONAL GO for Stage S1 only, the non-dispatch stage, with no BLOCKER or HIGH findings**, subject to three conditions:

- **C1** G-P0 (section 19.4) is complete and independently confirmed. It was **not** complete at the reviewed commit.
- **C2** The text corrections NEW-1 to NEW-7 (and the recommended NEW-8 to NEW-11) are made in this specification before any S1 migration, store or fixture-helper code is written.
- **C3** G-AGREEMENT (section 12.8) is amended so that a positive match alone cannot certify app attribution.

This Revision 3.1 is the text delivered for C2 and C3. **It does not by itself satisfy them and does not change the G0 verdict, which remains conditional until every condition in Appendix D is recorded as satisfied.** Disclosure: the session that wrote Revision 3.1 is the same session that performed the independent review. It therefore **cannot confirm its own corrections**; C2 and C3 must be confirmed by a reviewer who did not write Revision 3.1, before S1 coding starts (section 19.0 condition 2). Nothing here claims that any Shopify query, directive or behavior has been validated (Appendix E).

| Item | Value |
|---|---|
| Repository / branch | `feras-dotcom/order_merge_app`, `feature/shipping-v0-recovery-v0` |
| Accepted baseline | `28e886f7e46c5fed87201e5878054c794b5a9a1b` (Phase 1, 1.1, 1.2, 1.3 accepted) |
| Supersedes | Revision 3 (`ed8f5666044d7e553319fc0b9d70e6362398b501`); Revision 2 (`66d896d19505edb988e22ce986fc4ceaaeaec0ae`) |
| Review inputs | The Phase 2 review findings B1, H1-H3, M1-M7, L1-L7; the G0 self-audit findings N1-N16 (Appendix B); the independent G0 findings NEW-1 to NEW-11 (Appendix C). Appendix A maps the first set to sections. |
| Next gate | Conditions C1 to C3 (Appendix D), then the S1 entry conditions in section 19.0. Stage S1 may start only after all of them. |
| Query status | Every Shopify query document in section 12.1 is **UNVALIDATED** until the exact text has run successfully, read-only, on the approved development store (section 22). Nothing in this document records a successful API validation that has not been performed. Appendix E lists every unvalidated Shopify assumption. |

---

## 1. Purpose, scope and non-goals

**Purpose.** After a native Protocol v2 combine has fully completed, refund the shipping that the customer paid on each cancelled secondary order, exactly once, with durable write-ahead evidence, independent financial verification, and no ability to disturb the merge engine.

**Initial scope (deliberately narrow):**
- Policy `REFUND_ALL` only. `RETAIN_FIXED` is refused by a database CHECK and is not exposed in any merchant control.
- Zero shipping tax and `taxesIncluded=false` (E3 restriction, see section 22).
- Exactly one shipping-only refund allocation to exactly one verified successful `CAPTURE`/`SALE`.
- Gateway and test-order restrictions as enforced by the unmodified evaluator (currently `bogus` on `test=true` orders only; see section 18, G-REAL).

**Non-goals (v0):** automatic or operator resend of an ambiguous dispatch; undo of a refund; merchant-facing UI (a future gate, G-MERCHANT); shipping-tax refunds; retained-shipping policies; checkout-time prevention; any change to Protocol v2, the shadow evaluator or `ShippingAdjustment`.

---

## 2. Verified baseline facts

Each fact was verified in code or documentation when this revision was written.

| # | Fact | Source |
|---|---|---|
| F1 | `evaluateShadowSource` is an exported, read-only function. It evaluates a **cancelled, closed, PAID secondary**: bounded complete reads; discounted shipping in one currency; zero shipping tax; `taxesIncluded=false`; no prior shipping refund; refund history reconciled with the order aggregate; a single exact `SUGGESTED_REFUND` allocation to a successful `CAPTURE`/`SALE`; gateway `bogus`; `test=true`. It returns the `RefundInput` it would send (`notify:false`, `shipping:{amount,fullRefund:false}`, one `REFUND` transaction). | `app/lib/shipping-shadow.server.ts:681-950`, gateway `:867-879`, payload `:889-907` |
| F2 | `assessSecondaryEvidence` is an exported pure function that re-checks all merge evidence for one secondary (native v2, `COMPLETED`, `CANCEL_VERIFIED`, staff-note provenance, `MergeRecord`, transfer manifest, applied evidence, dispatched `EDIT_COMMIT` and `ORDER_CANCEL` attempts). | `app/lib/shipping-eligibility.ts:56-128` |
| F3 | `shippingActivationCutoff` is an exported pure function over the three Phase 1 epochs (merchant opt-in, rollout membership, global switch). The shadow module's `liveCutoff` is **not** exported, so Phase 2 implements its own transactional recomputation. | `app/lib/shipping-activation.ts:64-80`, `shipping-shadow.server.ts:363` |
| F4 | The shadow store refuses every persistent write under `NODE_ENV=production`, any `RAILWAY_*` variable, or without a disposable-database marker. Nothing in the application runtime wires the shadow evaluator. **No `ShippingAdjustment` rows can exist in production.** | `shipping-shadow.server.ts:408-442` |
| F5 | The "cancelled secondary is no longer PAID, a human must check" rule runs only while cancellation is being verified, before `COMPLETED`. After `COMPLETED && sideEffectsDone` the operation is terminal: `stepCompleted` returns `wait`. A shipping refund therefore cannot be re-interpreted by Protocol v2. | `operation-protocol.server.ts:670, 759, 791-807, 939-957`, `isWaiting :220-224` |
| F6 | `write_orders` is already granted to every installed merchant, so the capability to refund exists today. Only code and controls stand between the app and real money. | `shopify.app.toml:10` |
| F7 | Shopify Admin GraphQL 2026-04 **requires** `@idempotent(key:)` on `refundCreate`. Keys are retained 24 hours. A replay returns a response rebuilt from current records, which can differ from the original. Concurrent duplicates return `IDEMPOTENCY_CONCURRENT_REQUEST`; key reuse with different parameters returns `IDEMPOTENCY_KEY_PARAMETER_MISMATCH`. Shopify documents the **variable form** of the key (`@idempotent(key: $idempotencyKey)`) in its bulk-operation guide; the synchronous `refundCreate` examples use a string literal. | shopify.dev: `refundCreate` (2026-04), Implementing idempotency |
| F8 | Client retries: `shopify-app-remix` passes `retries: options?.tries ? options.tries - 1 : 0`; `@shopify/graphql-client` defaults `retries = 0` and retries only HTTP 429 and 503, and only when `retries > 0`. A request made with no `tries` option is sent once. | `node_modules/@shopify/shopify-app-remix/dist/esm/server/clients/admin/graphql.mjs:14`, `@shopify/graphql-client/.../graphql-client.mjs:5`, `constants.mjs:17` |
| F9 | `docker-start` runs `prisma migrate deploy` before the server starts, so **any deployment of a build containing new migrations migrates the production database automatically.** That covers a merge into a deployed branch **and** a manual `railway up` (or any other command that uploads a checkout and builds the `Dockerfile`), which deploys whatever is in the working directory regardless of branch. | `package.json:13-14`, `Dockerfile:21` |
| F10 | The experimental evidence for E0, E1, E2 and E6 is **not in the repository**; only code comments and `docs/SHIPPING-RECOVERY-V0-PLAN.md` mention the experiments. Section 17 specifies the sanitized archive. | `shipping-shadow.server.ts:172-175, :881-888` |
| F11 | The plain `UserError` type on `refundCreate` has `field` and `message` only; the existing code base already records that `code` exists only on specific subtypes. Phase 2 selects no `code`. | `app/lib/graphql.server.ts` |
| F12 | **Offline session identity.** `unauthenticated.admin(shop)` calls `ensureValidOfflineSession`, which loads the session by id `api.session.getOfflineId(shop)` (`config.sessionStorage.loadSession(offlineSessionId)`) and then `ensureOfflineTokenIsNotExpired`. The existing dry-run script instead uses `db.session.findFirst({ where: { shop, isOnline: false } })`, a different lookup. | `node_modules/@shopify/shopify-app-remix/dist/esm/server/helpers/create-or-load-offline-session.mjs`, `ensure-valid-offline-session.mjs`; `scripts/shipping-shadow-eval.ts:109` |
| F13 | **Order read shapes (2026-04 reference).** `Order.refunds` is `[Refund!]!` and `Order.transactions` is `[OrderTransaction!]!`: plain arrays that accept `first` only to truncate, with **no** `pageInfo`. `Order.agreements` is a `SalesAgreementConnection`. `Refund.transactions`, `Refund.refundShippingLines`, `Refund.refundLineItems` and `Refund.orderAdjustments` are connections. `Refund.createdAt` is **nullable**; `Refund.processedAt` is non-null. The `SalesAgreement` interface exposes `app`, `happenedAt`, `id`, `reason`, `sales` and `user`; `RefundAgreement` adds `refund`. `OrderTransactionStatus` is exactly `AWAITING_RESPONSE`, `ERROR`, `FAILURE`, `PENDING`, `SUCCESS`, `UNKNOWN`. Shopify states that a `Refund` object does not prove money moved; the transaction status does. | shopify.dev 2026-04: `Order`, `Refund`, `RefundAgreement`, `SalesAgreement`, `OrderTransactionStatus` |
| F14 | **Existing agreement and app-identity precedent.** The accepted merge path already reads `order.agreements(first: 50, after: $after) { nodes { __typename id happenedAt app { id } ... } pageInfo }` with `nextPageCursor`/`IncompletePageError` pagination guards, and obtains the app id with `currentAppInstallation { app { id } }` (`CURRENT_APP_QUERY`). This is a pattern to follow; it is **not** validation of the new Phase 2 documents. | `app/lib/evidence.server.ts:51-58, 107-110, 241-258`; `app/lib/graphql.server.ts` |
| F15 | **Uninstall ordering.** `webhooks.app.uninstalled` calls `cancelSubscription(shopGid)` **before** `resetAutomationForUninstall`. `cancelSubscription` returns `false` for handled failures, but `partnerApiRequest` performs an unguarded `fetch` and `response.json()`, so a network failure or a non-JSON body throws and the reset (which clears the merchant opt-in epoch) is skipped for that delivery. | `app/routes/webhooks.app.uninstalled.tsx:27-38`; `app/lib/billing.server.ts:126-151, 278-304` |
| F16 | **What Protocol v2's cancellation may leave on the secondary (NEW-1).** Protocol v2 cancels with `orderCancel(reason: OTHER, notifyCustomer: false, restock: true, refundMethod: { originalPaymentMethodsRefund: false }, staffNote)`. Whether Shopify records a `Refund` object (and a `RefundAgreement`) for a restocking cancellation that moves no money is **not established anywhere in this repository or in the documents read for this revision**. Revision 3 asserted that a PAID secondary has no refunds; that assertion was unverified. This revision neither assumes such records exist nor assumes they do not (section 8.2). | `app/lib/operation-protocol.server.ts:86-94`; section 8.2; Appendix E U4 |
| F17 | **The Phase 1 evaluator does not reject every prior refund.** It rejects a non-empty refund list only when its shipping lines do not reconcile with `totalRefundedShippingSet`, when refunded shipping is non-zero, or when the list reaches 50. A refund with no shipping line is tolerated, and it does not inspect `totalRefundedSet` or refund transactions. Phase 2 must therefore add its own baseline checks rather than inherit "no prior refund" from F1. | `app/lib/shipping-shadow.server.ts:719-727, 753-769, 786-788` |
| F18 | **Single-query cost limit.** The GraphQL Admin API rejects any single query whose *requested* cost exceeds 1,000 points before executing it; connection cost is sized by `first`/`last`; cost can be inspected with the `Shopify-GraphQL-Cost-Debug=1` header. How a plain array field with nested connections is priced is not stated in the documents read and is measured, not assumed (section 12.1.2). The evaluator's order query that the code reports as validated contains one nested connection per refund; the proposed Q-RECONCILE of Revision 3 contained four. | shopify.dev: GraphQL Admin API rate limits (requested cost, single query limit); `shipping-shadow.server.ts:172-223` |
| F19 | **Refund and agreement schema facts used by the 3.1 documents (2026-04 reference, read, not run).** `Refund` implements `Node` (so `nodes(ids:)` with `... on Refund` is a candidate detail read); `Refund.duties` is `[RefundDuty!]` and `RefundDuty.amountSet` is a non-null `MoneyBag`; `OrderActionType` has the values `ORDER`, `ORDER_EDIT`, `REFUND`, `RETURN`, `UNKNOWN`; `RefundAgreement.app` is nullable and documented only as "the application that created the agreement". The documentation does not say that `app` identifies the caller of `refundCreate`; that is exactly what G-AGREEMENT tests (section 12.8). | shopify.dev 2026-04: `Refund`, `RefundDuty`, `OrderActionType`, `RefundAgreement` |

---

## 3. Architecture and isolation

### 3.1 Components (all new files; no edits to accepted modules)

| Component | Responsibility | Shopify access | Stage |
|---|---|---|---|
| `shipping-refund-contract.ts` | Pinned mutation document, `documentSha256`, `wireHash`, input builders and validators. Exposes the document **text** through one accessor imported only by the dispatcher. | none | S1 |
| `shipping-refund-queries.ts` | The read-only GraphQL documents of section 12.1 as constants, each with a pinned sha256, a validation-status field (UNVALIDATED until G-READBACK records otherwise) and the worst-case bounds it was designed for (so measured cost can be compared) | none | S1 |
| `tests/helpers/shipping-refund-fixture.ts` (**test-only**) | The one helper allowed to create synthetic post-dispatch rows (section 19.2). Lives under `tests/`; never imported by `app/` or `scripts/` | none | S1 |
| `shipping-refund-gate.ts` (pure) | Cutoffs, lane decision, approval validity, caps arithmetic, eligibility predicates, response and read-back classifiers | none | S1 |
| `shipping-refund-store.server.ts` | All SQL for the four new tables; fenced writes; admission claim; freeze; lease; event log; scanner queries | none | S1 |
| `shipping-refund-admission.server.ts` | Direct admission scanner, evaluation, freeze/observe outcomes | read-only (`readOnlyAdmin`) | S1 |
| `shipping-refund-reconcile.server.ts` | Read-back, adoption by marker **and `RefundAgreement` app attribution**, settlement polling, restore audit | read-only (`readOnlyAdmin`) | S1 |
| `scripts/shipping-refund-admin.ts` | Operator CLI: set controls, approve or revoke a shop, approve a wire hash, inspect, resolve, audit | read-only | S1 |
| `shipping-refund-dispatch.server.ts` | T3 write-ahead gate, `DispatchPermit`, the single send, T4 outcome write | mutation, one request per row | S2 |
| `shipping-refund-worker.server.ts` | Own loop and timer; requires `MERGESHIP_SHIPPING_REFUNDS=enabled` | | S2 |

### 3.2 Import and dependency rules (enforced by architecture tests)

1. **Execution code must not read, update, promote or depend on `ShippingAdjustment`.** No execution module's source contains the string `ShippingAdjustment`. An S1 test also runs an admission cycle with a Prisma query logger and fails if any executed SQL mentions it.
2. Execution modules may import only these names from `shipping-shadow.server.ts`: `evaluateShadowSource`, `readOnlyAdmin`, `canonicalJson`, `minorToDecimal`, `dryRunSessionUsable`. They must not import `makeShippingShadowStore`, `runShadowScan`, `ShadowDatabaseNotAllowedError` or anything else. From `shipping-eligibility.ts` only `assessSecondaryEvidence`; from `shipping-activation.ts` only `shippingActivationCutoff`.
3. The two reused functions are **not relaxed**. Any change to `evaluateShadowSource` or `assessSecondaryEvidence` is a Phase 1 change requiring its own review. Golden-snapshot tests in the Phase 2 suite pin their outputs for a fixed fixture set, so a silent change to either fails Phase 2 tests.
4. Execution reads of `MergeOperation`, `MergeRecord` and `MergeMutationAttempt` use plain unlocked `SELECT`s implemented inside the execution store (the shadow store's `listMergeRecords` is not imported).
5. The mutation document **text** is exported only through one accessor in the contract module. It is imported only by the dispatcher (S2) and the contract's own tests. No S1 module imports it.
6. `sendRefund` can be called only with a `DispatchPermit` (section 9.3).
7. **S1 reconciliation cannot enter `DISPATCHING`.** In S1 the store's reconciliation writer is typed with `ReconcileTarget = 'IN_DOUBT' | 'REFUND_RECORDED' | 'VERIFIED' | 'REVIEW_REQUIRED' | 'RESOLVED'`; `'DISPATCHING'` is not representable. An architecture test scans non-test S1 sources for any SQL or literal that assigns `status = 'DISPATCHING'` and fails on a match.
8. **Query documents are pinned.** Each document in `shipping-refund-queries.ts` has a sha256 asserted by a test, so a change to its text is a visible, reviewable event that also resets that document's validation status to UNVALIDATED.
9. **The Shopify GraphQL read documents never contain the word `mutation`** (the reconciliation modules use `readOnlyAdmin`, which already rejects it); a test asserts it for every document.
10. **Trigger-bypass isolation (NEW-2).** The strings `session_replication_role`, `DISABLE TRIGGER`, `DISABLE ALL`, `ENABLE REPLICA` and `ENABLE ALWAYS` appear **nowhere** in `app/`, `scripts/` or `prisma/migrations/`, and under `tests/` only in `tests/helpers/shipping-refund-fixture.ts` (and in the architecture test that searches for them). The fixture helper is imported by no file under `app/` or `scripts/`. Both are architecture tests (section 19.3 item 3).
11. **Triggers must be live at runtime (NEW-2, defence in depth).** At the start of every admission and reconciliation cycle the store reads `pg_trigger` for the named triggers of section 5.4 on `ShippingRefund` and `ShippingRefundEvent` and requires `tgenabled = 'O'` for each and `current_setting('session_replication_role') = 'origin'`. If any trigger is missing or not enabled, the cycle does nothing, logs `[shipping-refund] triggers-not-intact`, and is retried next cycle. This is read-only and detects a trigger that was dropped or disabled outside a test transaction; it is not a substitute for restricting who can alter the schema.

### 3.3 Protocol v2 isolation

- No writes to and no row locks on `MergeOperation`, `MergeOrderLock`, `MergeClaim`, `MergeRecord`, `MergeMutationAttempt` or `ProcessedWebhook`. A static scan of the new modules for write statements against `Merge*` tables is an S1 test.
- Reading a `COMPLETED && sideEffectsDone` operation without locks is safe because that state is terminal (F5).
- Refund outcomes never feed back into merge phases. A merge stays `COMPLETED` whatever happens to its refund.
- The subsystem takes no `MergeClaim` or `MergeOrderLock` and adds no blocking condition for any merge. The secondary is cancelled and closed and can never be re-merged.
- Merge kill switches and the shipping switches are independent.
- The subsystem never calls Protocol v2's `openDispatchGate`; it has its own gate (section 9.2).
- The refund loop is its own module and timer, never inside `runSweepOnce`; its failures are caught at the loop boundary and cannot propagate.

### 3.4 Worker placement and session safety (M3)

- S2 runs the refund loop **in-process** behind `MERGESHIP_SHIPPING_REFUNDS=enabled`. A separately deployed service would share each shop's offline session with the merge worker and risk a token-refresh race, which is the one place the two subsystems could interfere.
- **The refund worker never refreshes tokens (I22).** Before any Shopify call for a shop it loads the offline session row and requires `dryRunSessionUsable` (at least 30 minutes of remaining life, six times the library's five-minute refresh threshold). Otherwise it skips the shop (`SESSION_UNUSABLE`, logged) and retries later; the merge worker or the app being opened refreshes the session.
- **Session identity (N12, required before S2).** The guard must check **the same row Shopify will use**. It loads the session by the offline id (`getOfflineId(shop)`, the library's `loadSession` key, F12) through the same session storage the library uses, **not** by `findFirst({ shop, isOnline: false })`. It then runs immediately before the Shopify call and uses that same row's `expires`. A test seeds two offline-looking rows for one shop and proves the guard follows the library's lookup. The existing dry-run script's `findFirst` lookup is a Phase 1 item and is not changed by this document.
- Whether an independently stoppable separate service is worth its deployment cost is product decision PD6.

---

## 4. Controls, epochs, approvals, caps and emergency stop

### 4.1 Existing Phase 1 controls (unchanged)

Merchant opt-in (`Settings.shippingAdjustmentEnabled` / `shippingAdjustmentEnabledAt`), rollout membership (`AppControl.shippingAllowShops` / `Settings.shippingRolloutAt`) and the global shipping switch (`AppControl.shippingAdjustmentsEnabled` / `shippingEnabledAt`) remain exactly as accepted. `shippingActivationCutoff` over these three is the **activation cutoff**. The global shipping switch remains the master kill switch for both shadow evaluation and execution.

### 4.2 `ShippingExecuteControl` (singleton `id='control'`, seeded fully off)

| Column | Meaning |
|---|---|
| `admissionEnabled`, `admissionEnabledAt` | Admission switch and epoch. Epoch stamped on the **database** clock on a false-to-true change, cleared on disable. |
| `dispatchEnabled`, `dispatchEnabledAt` | Dispatch switch and epoch, same discipline. |
| `globalDailyCap` | Maximum dispatches in any trailing 24 hours across all shops, `INTEGER`, CHECK `>= 0`. `0` means none (fail closed). |
| `note`, `updatedAt` | Operator note. |

CHECK: `dispatchEnabled` implies `admissionEnabled`, and an epoch is non-null exactly when its switch is on. The setter clears the dispatch switch whenever it clears the admission switch, in one statement. The two switches have independent epochs.

### 4.3 `ShippingExecuteApproval` (PK `shop`)

| Column | Meaning |
|---|---|
| `approvedAt`, `approvedBy`, `note` | Operator approval; `approvedAt` on the database clock. A re-approval stamps a **new** `approvedAt`. |
| `revokedAt` | Set on revocation. |
| `merchantOptInEpoch` | The live `Settings.shippingAdjustmentEnabledAt` instant read in the same transaction as the approval. |
| `ackVersion`, `ackRecordedAt` | The merchant-disclosure version the merchant accepted. Until the merchant UI exists (G-MERCHANT) this is operator-recorded. |
| `currencyCode` | The single currency this shop may refund in. |
| `maxRefundMinor` | Per-refund cap, text integer in `currencyCode`'s minor units. `'0'` means none. Format CHECK `^(0\|[1-9][0-9]{0,39})$`; compared **numerically** only (section 4.6.1). |
| `dailyCap` | Per-shop trailing-24-hour dispatch cap, `INTEGER`, CHECK `>= 0`. `0` means none. |
| `autoApprove` | Default `false`: each refund needs an operator to approve its wire hash. |

An empty table means **no shops** (inverted allowlist, as `shippingAllowShops`).

**No opt-in path in S1, and operators never opt merchants in (N8).** S1 adds no code or script that sets `Settings.shippingAdjustmentEnabled` or its epoch, and no operator command opts a merchant in on their behalf. The approval setter only **reads** the live opt-in epoch and refuses (`MERCHANT_NOT_OPTED_IN`) when it is null. A scan test asserts that no non-test S1 source and no new script references `setShippingAdjustmentEnabled`. The merchant opt-in arrives only with G-MERCHANT (which precedes S3.5), so no real merchant can have an approvable epoch before then.

**Approval edit semantics (N11).** An approval edit either changes *authority* or only *limits*:

| Edit | Effect on `approvedAt` | Effect on existing candidates |
|---|---|---|
| First approval; re-approval after revocation | Stamps a **fresh** `approvedAt` and re-reads the live merchant epoch | Every earlier row has a different `approvalApprovedAt` snapshot and aborts at its next gate check |
| `autoApprove` false to true | Stamps a fresh `approvedAt` | Previously admitted rows abort; auto-approval applies only to combines admitted afterwards. It never converts existing `PREPARED` rows into auto-dispatchable ones |
| `currencyCode` change; `ackVersion` change | Stamps a fresh `approvedAt` | Earlier rows abort |
| `autoApprove` true to false | No restamp (it reduces authority) | Takes effect immediately: rows then need `approvedWireHash` |
| Cap edits (`maxRefundMinor`, `dailyCap`, `globalDailyCap`) | **No restamp** | Caps are read live at T3 only. They never change an epoch, never revive a terminal row (`ABORTED`, `OBSERVED`, `INELIGIBLE`, `SKIPPED`) and never make a combine eligible that the activation, admission or dispatch cutoffs excluded. A raised cap lets an already-eligible waiting row proceed; a lowered cap blocks immediately |
| Note edits | No restamp | None |

### 4.4 Cutoffs and the gate snapshot (formal definitions)

Let `activation = shippingActivationCutoff(live Phase 1 state)`.

- **Approval validity (pure):** an approval row exists, `revokedAt IS NULL`, `merchantOptInEpoch` equals the live `Settings.shippingAdjustmentEnabledAt` (same instant), and `ackVersion` equals the code constant `REQUIRED_ACK_VERSION`. Uninstall clears the merchant epoch; a later re-opt-in stamps a new one; either invalidates every earlier approval **without needing a hook in the refund subsystem, provided the existing uninstall reset actually runs. Today it can be skipped (F15), which is why section 18.1 (N4) requires an independent fix before S3.5 and G-PILOT.** Bumping `REQUIRED_ACK_VERSION` invalidates all approvals.
- **admissionCutoff(shop)** = `max(activation, control.admissionEnabledAt, approval.approvedAt)`; null unless `admissionEnabled`, approval valid, `activation` non-null and `Settings.shippingPolicy = 'REFUND_ALL'`.
- **dispatchCutoff(shop)** = `max(admissionCutoff, control.dispatchEnabledAt)`; null unless `dispatchEnabled` and `admissionCutoff` non-null.
- **Gate snapshot (NEW-8)** (recorded on each row at claim). The snapshot stores **each individual epoch, not only their maxima**, because equality of a maximum can hide a change (a clock regression after a restore, or two different epoch vectors that share a maximum, including at the `TIMESTAMP(3)` millisecond):

  | Snapshot column | Source |
  |---|---|
  | `merchantEpochAt` | `Settings.shippingAdjustmentEnabledAt` |
  | `rolloutEpochAt` | `Settings.shippingRolloutAt` |
  | `switchEpochAt` | `AppControl.shippingEnabledAt` |
  | `activationCutoffAt` | `max` of the three above (derived; stored for readability and CHECKed against them) |
  | `admissionEpochAt` | `ShippingExecuteControl.admissionEnabledAt` |
  | `admissionCutoffAt` | `max(activationCutoffAt, admissionEpochAt, approvalApprovedAt)` (derived, CHECKed) |
  | `dispatchEpochAtAdmission` | the live `dispatchEnabledAt`, or NULL for `OBSERVE` |
  | `approvalApprovedAt`, `approvalOptInEpoch`, `approvalAckVersion` | the approval row |

- **Live gate check** (used at claim, freeze and T3) recomputes **every column above individually**, under `FOR SHARE`/`FOR UPDATE` locks (section 4.10), and requires **deep equality of each** with the row's snapshot (instants compared by exact millisecond value; NULL equals NULL only where the snapshot allows NULL). Equality of the derived cutoffs is also required but is never sufficient on its own. Any difference means the row is aborted; it is never refreshed or re-stamped.

There is no policy epoch because the policy is not merchant-settable in v0. If `RETAIN_FIXED` ever becomes settable, a policy epoch must join the cutoff (PD10).

### 4.5 Lanes and the observation phase

At claim, the row gets an immutable `lane`:

- `EXECUTE` if `dispatchCutoff` is non-null **and** the combine's `createdAt >= dispatchCutoff`. `dispatchEpochAtAdmission` is then non-null.
- `OBSERVE` otherwise. `dispatchEpochAtAdmission` is NULL.

An `OBSERVE` row is evaluated exactly like an `EXECUTE` row (fresh Shopify reads included) but finishes in terminal status `OBSERVED` and **can never become executable**: database constraints forbid any dispatch-path status on an `OBSERVE` row, and the transition trigger forbids `QUEUED -> PREPARED` unless `lane='EXECUTE'`. This gives production eligibility evidence with zero money risk (stage S3.5).

**A combine admitted before dispatch activation never becomes executable when dispatch is enabled later**, for three independent reasons: its lane is `OBSERVE` and immutable; its `dispatchEpochAtAdmission` is NULL; and T3 requires the live `dispatchEnabledAt` to equal the row's snapshot. If dispatch is turned off and on again, the epoch changes and every older `EXECUTE` row aborts at T3.

### 4.6 Caps and operator approvals

- **Per refund:** `plannedShippingMinor <= approval.maxRefundMinor` (numeric, section 4.6.1), and the row's currency equals `approval.currencyCode`.
- **Per shop:** dispatches with `dispatchedAt` in the trailing 24 hours `< approval.dailyCap`.
- **Global:** the same count across all shops `< control.globalDailyCap`.
- **Pilot serialization (breaker, section 4.7):** at most one unresolved dispatched row exists globally.
- Defaults are all zero: a freshly approved shop can dispatch nothing until an operator sets explicit caps.
- **Operator approval per refund:** unless `approval.autoApprove`, an operator must record `approvedWireHash` equal to the row's `wireHash` (conditional on `status='PREPARED'` and `lane='EXECUTE'`). The approval is bound to the exact wire request including the key, so **it can only be recorded after the freeze** (the hash does not exist before it). An `OBSERVED` row can never be approved (its status is not `PREPARED`).

#### 4.6.1 Numeric comparison of text-stored money (NEW-11)

`plannedShippingMinor` and `maxRefundMinor` are text integers (arbitrary-length minor units). They are **never compared as strings**: `'9' > '10'` lexicographically.

- **Format first, then parse.** A value is parsed only after it matches its format: `plannedShippingMinor ~ '^[1-9][0-9]{0,39}$'` (already a CHECK) and `maxRefundMinor ~ '^(0|[1-9][0-9]{0,39})$'` (new CHECK). Leading zeros, signs, whitespace, exponents and decimal points are rejected. A value that fails the format, in either the row or the approval, **refuses the dispatch** (class: Abort for a bad row, Wait for a bad approval, with a logged error) and is never treated as 0 or as unlimited.
- **Application:** parse with `BigInt` after the regex test and compare the `BigInt`s. **SQL:** where a comparison must happen in the database, cast **both** sides with `::numeric` after the format guarantee (the CHECK) holds. `maxRefundMinor = '0'` means none: every refund exceeds it.
- **Architecture test:** no non-test source compares `plannedShippingMinor` or `maxRefundMinor` with `<`, `<=`, `>`, `>=` or `ORDER BY` without a numeric cast, and the application comparison helper is the single place those values are parsed.
- **Tests:** `'9'` vs `'10'`, `'0'`, `'01'`, `''`, `'-1'`, `'1e3'`, a 41-digit value, and a currency mismatch between row and approval.

### 4.7 Financial breaker (computed, no mutable state)

Inside T3, **after** acquiring the exclusive control-row lock, the gate refuses if any row exists with `dispatchedAt IS NOT NULL` and `status NOT IN ('VERIFIED','RESOLVED')`. Such a row is in one of `DISPATCHING`, `IN_DOUBT`, `REFUND_RECORDED` or `REVIEW_REQUIRED`: money may be in flight or unresolved. The breaker therefore trips and clears from authoritative records alone; nothing writes a breaker flag. This is the pilot posture (global serialization). Relaxing it to per-shop is PD9 and needs its own review.

**A tripped breaker waits; it never aborts a valid row (N5, NEW-4; required before S2).** A breaker refusal, a cap refusal and a missing operator hash approval are *capacity* conditions, not eligibility conditions. They leave the row where it is (`QUEUED` or `PREPARED`), reschedule it with a backoff of at most 15 minutes, and **do not increment `attempts`** (the 8-attempt evaluation budget counts only failed evaluations). Only a gate inequality, a document-hash mismatch, a policy change, a changed refund baseline or the seven-day horizon (section 8.4, which applies to both `QUEUED` and `PREPARED` rows) abort a row. Details are in sections 8.4 and 9.2.

### 4.8 Emergency stop (ordered, each step independent)

1. `scripts/shipping-refund-admin.ts set-control --dispatch off` (one statement; effective for every subsequent T3).
2. `--admission off` (also clears dispatch).
3. Global shipping switch off via `scripts/app-control.ts --shipping off` (existing).
4. Revoke shop approvals.
5. Hard stop: unset `MERGESHIP_SHIPPING_REFUNDS` and restart, or stop the process. The environment cannot change at runtime, so this step needs a restart.

**What stopping does not do:** it does not reverse any refund, and the reconciler keeps running regardless of every switch so that in-flight rows still reach a conclusion. A request whose T3 committed before the stop may still be in flight; this boundary is documented and accepted (same as the merge gate).

### 4.9 Operator actions are audited

Every operator command that changes a refund row's status sets the actor with `SET LOCAL mergeship.actor`, so the event trigger (section 5.4.5) records who did it. Control and approval changes (switches, caps, approvals, revocations) record the actor and reason in the row's `note` and emit a structured `[shipping-refund] control-change` log line with actor and timestamp; no additional audit table is introduced. Mutating CLI commands are dry-run by default and require `--apply`.

### 4.10 Lock order (global, acyclic)

`ShippingRefund` row, then `AppControl`, then `Settings`, then `ShippingExecuteControl`, then `ShippingExecuteApproval`.

| Path | Locks, in order |
|---|---|
| T3 gate | row `FOR UPDATE`; `AppControl` `FOR SHARE`; `Settings(shop)` `FOR SHARE`; `ShippingExecuteControl` `FOR UPDATE`; approval `FOR SHARE` |
| Admission claim | `AppControl` `FOR SHARE`; `Settings` `FOR SHARE`; control `FOR SHARE`; approval `FOR SHARE`; then insert the new row |
| Existing `setControl` | `AppControl` `FOR UPDATE`; `Settings` (unchanged) |
| Execution control setter | control `FOR UPDATE` |
| Approval setter | `Settings` `FOR SHARE`; control `FOR SHARE`; approval `FOR UPDATE` |
| Wire-hash approval, reconcile, lease | row only |

No path acquires a lock earlier in this order after a later one. T3's `FOR UPDATE` on the control row serializes dispatches with each other and with control changes. Dispatch is rare, so contention is negligible. In READ COMMITTED each statement sees data committed before the statement started, so the cap and breaker queries must run **after** the lock is held; this is a stated requirement and a test.

---

## 5. Data model

Four new tables in one additive migration. **No existing table, constraint or index changes.**

### 5.1 `ShippingRefund` (unique `(shop, sourceOrderId)`)

| Group | Columns |
|---|---|
| Identity | `id`, `shop`, `mergeOperationId`, `sourceOrderId`, `primaryOrderId`, `primaryOrderName`, `operationCreatedAt`, `sourceCancelledAt` (the verified `cancelledAt` of the secondary copied from the operation at claim; immutable; the origin of the seven-day horizon, section 8.4; NULL only on a terminal row claimed because that timestamp was missing) |
| Lane and state | `lane` (`OBSERVE`/`EXECUTE`), `status` |
| Gate snapshot (NEW-8) | `merchantEpochAt`, `rolloutEpochAt`, `switchEpochAt`, `activationCutoffAt`, `admissionEpochAt`, `admissionCutoffAt`, `dispatchEpochAtAdmission`, `approvalApprovedAt`, `approvalOptInEpoch`, `approvalAckVersion` (section 4.4) |
| Policy | `policyKind` (CHECK `'REFUND_ALL'`) |
| Frozen financial facts | `currencyCode`, `plannedShippingMinor` (text integer), `parentTransactionId`, `gateway` |
| Frozen wire contract | `idempotencyKey` (unique), `marker` (unique), `documentSha256`, `wireVariables` (JSONB: `{idempotencyKey, input}`), `wireHash`, `mutationVersion`, `preEvidence` (JSONB; includes the refund **baseline**, section 8.2.2), `preparedAt` |
| Operator approval | `approvedWireHash`, `approvedAt`, `approvedBy` |
| Dispatch | `dispatchToken`, `dispatchedAt`, `respondedAt`, `responseKind`, `responseSummary` (truncated, no secrets) |
| Settlement | `refundId` (unique), `refundCreatedAt`, `settlementState`, `settlementCheckAt`, `verifiedEvidence` (JSONB), `verifiedAt` |
| Ownership | `leaseToken`, `leasedUntil`, `nextCheckAt`, `attempts` (counts evaluation/read attempts, never dispatches) |
| Review | `reasonCode`, `reviewReason`, `resolvedAt`, `resolvedBy`, `resolution`, `resolutionNote` |
| Bookkeeping | `createdAt`, `updatedAt` |

`idempotencyKey` and `marker` are generated at claim (a UUIDv4 and `MS-SHIPREFUND-<uuid>`), never derived from anything else. `plannedShippingMinor` is the single amount: the transaction amount must equal it (no separate transaction column).

### 5.2 Other tables

- **`ShippingRefundEvent`** (append-only): `id`, `shippingRefundId` (foreign key to `ShippingRefund.id`; **named `shippingRefundId`, never `refundId` (NEW-10)**, because `ShippingRefund.refundId` already holds Shopify's `gid://shopify/Refund/...` id and the two must never be confused in code, SQL or review), `at`, `fromStatus`, `toStatus`, `actor`. Written only by the event trigger (section 5.4.5) in the same transaction as the status change; no evidence column.
- **`ShippingExecuteControl`** and **`ShippingExecuteApproval`**: section 4.

### 5.3 Constraints (CHECK where expressible)

Formats: `idempotencyKey` is a UUID; `marker ~ '^MS-SHIPREFUND-[0-9a-f-]{36}$'`; order ids (`sourceOrderId`, `primaryOrderId`) `~ '^gid://shopify/Order/[0-9]+$'` (**one pattern constant, `ORDER_GID_PATTERN`, is used verbatim by these CHECKs and by every SQL predicate and application validator that guards them**, section 7.2); `parentTransactionId ~ '^gid://shopify/OrderTransaction/[0-9]+$'`; `refundId ~ '^gid://shopify/Refund/[0-9]+$'`; `currencyCode ~ '^[A-Z]{3}$'`; hashes `~ '^[0-9a-f]{64}$'`; `plannedShippingMinor ~ '^[1-9][0-9]{0,39}$'`.

Financial shape:

- `"sourceOrderId" <> "primaryOrderId"`.
- `wireVariables`, when set:
  - `->>'idempotencyKey' = "idempotencyKey"`;
  - `->'input'->>'orderId' = "sourceOrderId"`;
  - `jsonb_array_length(->'input'->'transactions') = 1`;
  - that transaction's `orderId = "sourceOrderId"`, `parentId = "parentTransactionId"`, `gateway = "gateway"`, `kind = 'REFUND'`;
  - `->'input'->'shipping'->'fullRefund' = 'false'::jsonb`;
  - `->'input'->'shipping'->>'amount'` equals the transaction `amount`;
  - `->'input'->'notify' = 'false'::jsonb` (changing it is PD1 and needs a migration);
  - `->'input'->>'currency' = "currencyCode"`;
  - the input has no `refundLineItems` key.
- **Shape trigger** (an SRF or subquery cannot sit in a CHECK): the key sets of `wireVariables`, `input`, `shipping` and the transaction are exactly the allowed sets, so no merchandise, restock, `allowOverRefunding` or refund-method fields can ever appear. The decimal-string amount equals `minorToDecimal(plannedShippingMinor, precision)`; precision is application knowledge, so this is an application invariant with tests.

State consistency:

- Statuses `PREPARED, DISPATCHING, IN_DOUBT, REFUND_RECORDED, VERIFIED` require `lane='EXECUTE'`, `dispatchEpochAtAdmission IS NOT NULL`, and non-null `wireVariables`, `wireHash`, `documentSha256`.
- **Durable dispatch evidence (N1).** Statuses `DISPATCHING, IN_DOUBT, REFUND_RECORDED, VERIFIED` require `dispatchedAt IS NOT NULL` **and** `dispatchToken IS NOT NULL`. A row can therefore not even be inserted in a post-dispatch state without valid write-ahead evidence, and the S1 reconciliation writer's database preconditions are exactly these CHECKs.
- `dispatchedAt IS NOT NULL` requires `lane='EXECUTE'`, a non-null `dispatchToken`, and a status in `DISPATCHING, IN_DOUBT, REFUND_RECORDED, VERIFIED, REVIEW_REQUIRED, RESOLVED`; and `dispatchedAt IS NULL` is equivalent to `dispatchToken IS NULL`. **A CHECK cannot see the old row, so the rule that these two columns may first become non-null only during `PREPARED -> DISPATCHING` is enforced by the evidence-integrity trigger (5.4.6, NEW-6), not by this CHECK.** A `REVIEW_REQUIRED` or `RESOLVED` row with `dispatchedAt IS NULL` is a **pre-dispatch** review row: it is not "dispatched" and does not trip the breaker (4.7).
- **Insert integrity (NEW-6).** On insert, **every** dispatch, response, settlement, refund, verification and resolution column is NULL: `dispatchToken, dispatchedAt, respondedAt, responseKind, responseSummary, refundId, refundCreatedAt, settlementState, settlementCheckAt, verifiedEvidence, verifiedAt, resolvedAt, resolvedBy, resolution, resolutionNote`; and `approvedWireHash`, `approvedAt`, `approvedBy` are NULL; and the frozen wire columns (`wireVariables, wireHash, documentSha256, mutationVersion, parentTransactionId, gateway, plannedShippingMinor, currencyCode, preEvidence, preparedAt`) are NULL, because a claim never freezes. The insert trigger (5.4.1) enforces this; it is what stops a `claimTerminal(REVIEW_REQUIRED)` insert from manufacturing dispatch evidence.
- `sourceCancelledAt IS NOT NULL` for statuses `QUEUED, PREPARED, DISPATCHING, IN_DOUBT, REFUND_RECORDED, VERIFIED, OBSERVED` (the horizon must be computable for every non-terminal row).
- **Marker is in the note (N7).** For a set `wireVariables`: `position("marker" in "wireVariables"->'input'->>'note') > 0`. Without it the marker could never be matched at adoption.
- **Cutoff timestamps (N7, NEW-8).** Snapshot columns `merchantEpochAt`, `rolloutEpochAt`, `switchEpochAt`, `activationCutoffAt`, `admissionEpochAt`, `admissionCutoffAt`, `approvalApprovedAt`, `approvalOptInEpoch` and `approvalAckVersion` are `NOT NULL`. Derived columns must agree with their parts: `"activationCutoffAt" = GREATEST("merchantEpochAt","rolloutEpochAt","switchEpochAt")` and `"admissionCutoffAt" = GREATEST("activationCutoffAt","admissionEpochAt","approvalApprovedAt")`. For every lane `"operationCreatedAt" >= "admissionCutoffAt"`. For `lane='EXECUTE'`: `"dispatchEpochAtAdmission" IS NOT NULL AND "operationCreatedAt" >= "dispatchEpochAtAdmission"`; for `lane='OBSERVE'`: `"dispatchEpochAtAdmission" IS NULL`. This puts no-retroactivity (I8) into the database in addition to the application's gate checks.
- **Decimal amount format (N7).** For a set `wireVariables`, both `->'input'->'shipping'->>'amount'` and the transaction `amount` match the decimal-format pattern `^(0\.[0-9]{1,4}|[1-9][0-9]*(\.[0-9]{1,4})?)$` (no sign, no exponent, no superfluous leading zeros, at most four fractional digits; trailing zeros are allowed because Shopify amounts such as `0.50` and `12.00` are legitimate) **and** are strictly positive by a separate check, `("amount")::numeric > 0`. The application additionally requires the number of fractional digits to equal the currency's precision (zero-decimal currencies send no fractional part). Both checks fail closed: a value that does not parse as a number raises and the write is rejected.
- `OBSERVED, ABORTED, SKIPPED, INELIGIBLE` require `dispatchedAt IS NULL`.
- `REFUND_RECORDED, VERIFIED` require `refundId IS NOT NULL`; `VERIFIED` requires `settlementState='SUCCESS'` and `verifiedAt`.
- `RESOLVED` requires `resolvedBy`, `resolution` and `resolvedAt`.

### 5.4 Triggers

1. **Transition graph (MANDATORY, NEW-3)** (section 6): any `(old, new)` pair outside the graph raises. `QUEUED -> PREPARED` additionally requires `lane='EXECUTE'`; `QUEUED -> OBSERVED` requires `lane='OBSERVE'`. **The S1 migration's graph does not contain `PREPARED -> DISPATCHING` at all.** That edge is added only by the separate, separately authorized S2 migration (section 21), so S1's non-dispatch property is enforced by the database, not only by code, mirroring the Phase 1.1 precedent that making a row executable needs an authorized schema change. This trigger is **not optional**: it is the sole database-level enforcement of I27, and a CHECK constraint cannot replace it because a CHECK cannot see the old row. An **insert trigger** (same function family, same mandatory status) allows only the initial statuses `QUEUED`, `SKIPPED`, `INELIGIBLE` and `REVIEW_REQUIRED` (the last three are the terminal claim outcomes of section 7.5) and requires every column listed under "Insert integrity" in 5.3 to be NULL.
2. **Frozen columns:**
   - always immutable: `shop`, `sourceOrderId`, `primaryOrderId`, `mergeOperationId`, `operationCreatedAt`, `lane`, `idempotencyKey`, `marker`, and the whole gate snapshot;
   - write-once at the freeze (NULL to value once, never again): `wireVariables`, `wireHash`, `documentSha256`, `mutationVersion`, `currencyCode`, `plannedShippingMinor`, `parentTransactionId`, `gateway`, `preEvidence`, `preparedAt`;
   - write-once at dispatch: `dispatchToken`, `dispatchedAt`.
3. **Shape trigger** from 5.3.
4. **No delete and no truncate (NEW-10).** `BEFORE DELETE` row triggers on `ShippingRefund` (always raise) and `BEFORE UPDATE OR DELETE` row triggers on `ShippingRefundEvent` (always raise); plus **`BEFORE TRUNCATE` statement triggers on both `ShippingRefund` and `ShippingRefundEvent` that always raise**, because row-level triggers do not fire on `TRUNCATE` and a restore or maintenance script could otherwise erase the financial journal silently. `TRUNCATE ... CASCADE` from a referencing table is covered by the same triggers. Test cleanup therefore **cannot** `DELETE` or `TRUNCATE` these two tables and **no test-reset switch exists in the triggers** (a switch the triggers honored would be a runtime-reachable bypass). S1 tests isolate by a unique `shop` value per test and obtain an empty journal only by creating a fresh scratch database through the preflight-branded helper (`withScratchDatabase`, after LOW-4), which is dropped as a whole. Existing suites that truncate other tables are unaffected.
5. **Event trigger (N16).** An `AFTER INSERT OR UPDATE` trigger on `ShippingRefund` inserts the `ShippingRefundEvent` row (`shippingRefundId`, `fromStatus`, `toStatus`, `at` on the database clock, `actor` from `current_setting('mergeship.actor', true)` set with `SET LOCAL` by the store, `'unknown'` if unset) whenever the status is new or changed. This makes "one event per status change" a database guarantee instead of something every code path must remember. Event rows carry no evidence payload: evidence lives on the row itself (`preEvidence`, `verifiedEvidence`, `reviewReason`, `responseSummary`), which keeps the trigger trivial. The store never inserts events itself.
6. **Evidence-integrity trigger (MANDATORY, NEW-6).** A `BEFORE UPDATE` trigger on `ShippingRefund`, **implemented as its own function, separate from the transition-graph function** (so a statement that suspends the transition trigger, section 19.2, does not suspend this one), enforces what a CHECK cannot because it needs `OLD`:
   - `dispatchToken` and `dispatchedAt` may change from NULL to non-NULL **only** in an update where `OLD.status = 'PREPARED'` and `NEW.status = 'DISPATCHING'`, both set in that same update, with `OLD.lane = 'EXECUTE'`. Every other update that would set either column raises. Once set they never change (write-once).
   - Response and settlement evidence (`respondedAt, responseKind, responseSummary, refundId, refundCreatedAt, settlementState, settlementCheckAt, verifiedEvidence, verifiedAt`) may change from NULL to non-NULL only when `OLD.status IN ('DISPATCHING','IN_DOUBT','REFUND_RECORDED')`. A pre-dispatch row (`QUEUED`, `PREPARED`) or any terminal pre-dispatch row can never receive them. `refundId` once set never changes.
   - `approvedWireHash` may be set only when `OLD.status = 'PREPARED'`, `lane='EXECUTE'`, and the value equals `wireHash`.
   - Consequence: a terminal `REVIEW_REQUIRED` (or `ABORTED`, `SKIPPED`, `INELIGIBLE`) row reached from `QUEUED` or `PREPARED` cannot carry dispatch evidence, so it cannot trip the financial breaker (4.7) or be mistaken for a dispatched row.
   - **Relation to I27:** this trigger *names* the `PREPARED -> DISPATCHING` update because it is the only update that may stamp dispatch evidence, but it does not *authorize* that update: the S1 transition-graph trigger (1) still rejects it. Entering `DISPATCHING` needs both the S2 migration and this trigger's condition. S1 therefore contains the condition without the capability.

**Mandatory triggers and tests.** Triggers 1 (including the insert trigger), 4, 5 and 6 are mandatory; trigger 2 (frozen columns) and trigger 3 (shape) are mandatory as well. They are new to this repository and deliberately stronger than its CHECK-only convention: a buggy caller must not be able to violate a financial rule, and CHECK-only enforcement cannot express the old-row rules of triggers 1, 2 and 6. **No reviewer option exists to drop or weaken a trigger without re-opening I27, I13 and the G0 review for that rule.** They are tested against real PostgreSQL only (section 20). A migration test asserts that each named trigger exists, is enabled (`pg_trigger.tgenabled = 'O'`), and that the S1 transition function accepts no `PREPARED -> DISPATCHING` update. Triggers protect against defective application code and test code; they do not protect against a database role that is allowed to alter the schema, which is why 3.2 rule 11 adds a runtime read-only check and why schema-altering privileges stay with the migration role.

---

## 6. State machine

| Status | Meaning | Dispatched? |
|---|---|---|
| `QUEUED` | Claimed; evaluation pending | no |
| `PREPARED` | Wire request frozen; awaiting operator hash approval, capacity and T3; bounded by the seven-day horizon | no |
| `DISPATCHING` | Write-ahead committed; the send may or may not have happened | maybe |
| `IN_DOUBT` | No confirmed response; read-only reconciliation only | maybe |
| `REFUND_RECORDED` | A refund id is recorded; settlement not yet verified | yes |
| `VERIFIED` | Independent read-back passed; **terminal success** | yes |
| `OBSERVED` | `OBSERVE` lane; evaluation would have succeeded; **terminal, never executable**. It may carry the frozen request columns as a record of what *would* have been sent; those columns are **not dispatch authorization** (section 8.3) | no |
| `SKIPPED` | Evaluator says nothing refundable under the policy; terminal | no |
| `INELIGIBLE` | Unsupported financial evidence or evaluation unavailable; terminal, no human action required | no |
| `ABORTED` | Pre-dispatch drift or gate change; terminal; provably unsent | no |
| `REVIEW_REQUIRED` | Needs a human; automation stops | maybe |
| `RESOLVED` | A human closed a review row; terminal | maybe |

```
                                      claim (lane = EXECUTE)
 completed v2 combine ──claim──►  QUEUED ─────────────► PREPARED ──T3 write-ahead──► DISPATCHING
 (MergeOperation, not                │ │ │ │                │  │                        │    │
  ShippingAdjustment)                │ │ │ │                │  │ response ok            │    │ no or bad response,
                                     │ │ │ │                │  └─► ABORTED              │    │ timeout, unknown
                                     │ │ │ │                └────► REVIEW_REQUIRED      ▼    ▼
                                     │ │ │ └─► REVIEW_REQUIRED          REFUND_RECORDED◄─ IN_DOUBT ─► REVIEW_REQUIRED
                                     │ │ └───► INELIGIBLE                    │   adopt by marker  (24h, anomaly)
                                     │ └─────► SKIPPED                       │ verify
                                     └─ lane = OBSERVE ──► OBSERVED          ▼
                                                                         VERIFIED         REVIEW_REQUIRED ──human──► RESOLVED
```

Allowed transitions (trigger-enforced; everything else raises):

| From | To |
|---|---|
| `QUEUED` | `PREPARED` (EXECUTE only), `OBSERVED` (OBSERVE only), `SKIPPED`, `INELIGIBLE`, `ABORTED`, `REVIEW_REQUIRED` |
| `PREPARED` | `DISPATCHING`, `ABORTED`, `REVIEW_REQUIRED` |
| `DISPATCHING` | `REFUND_RECORDED`, `IN_DOUBT` |
| `IN_DOUBT` | `REFUND_RECORDED` (adopted), `REVIEW_REQUIRED` |
| `REFUND_RECORDED` | `VERIFIED`, `REVIEW_REQUIRED` |
| `REVIEW_REQUIRED` | `RESOLVED` (human only) |
| terminal states | none |

### 6.1 Which stage may perform which transition (N1)

| Transition | Stage that implements it | Database precondition (CHECK/trigger) |
|---|---|---|
| `(none) -> QUEUED, SKIPPED, INELIGIBLE, REVIEW_REQUIRED` (claim and terminal claim outcomes) | S1 | insert trigger (statuses, all dispatch/response/refund/approval/wire columns NULL); snapshot and cutoff CHECKs |
| `QUEUED -> PREPARED / OBSERVED / SKIPPED / INELIGIBLE / ABORTED / REVIEW_REQUIRED` | S1 | lane CHECKs; write-once wire columns; evidence-integrity trigger (no dispatch evidence can be stamped) |
| `PREPARED -> ABORTED / REVIEW_REQUIRED` | S1 | evidence-integrity trigger (no dispatch evidence can be stamped) |
| **`PREPARED -> DISPATCHING`** | **S2 only** (the S1 migration's graph does not contain this edge; the S2 migration adds it) | evidence-integrity trigger: `dispatchedAt` and `dispatchToken` first set in this very update (the only update allowed to set them); `dispatchedAt IS NULL` beforehand |
| `DISPATCHING -> REFUND_RECORDED` (T4, from a send response) | **S2 only** (needs a real response) | `dispatchToken` fence; `refundId` valid and unique |
| `DISPATCHING -> IN_DOUBT` (time sweep) | S1 reconciliation code | `dispatchedAt` and `dispatchToken` non-null (CHECK); `dispatchedAt` older than 120 s |
| `IN_DOUBT -> REFUND_RECORDED` (adoption, section 12.3) | S1 reconciliation code | durable dispatch evidence (CHECK); `refundId` set and unique; adoption conditions including app attribution |
| `IN_DOUBT -> REVIEW_REQUIRED` | S1 reconciliation code | durable dispatch evidence not required for review, but the row is already post-dispatch here |
| `REFUND_RECORDED -> VERIFIED` | S1 reconciliation code | `refundId`, `settlementState='SUCCESS'`, `verifiedAt` (CHECK) |
| `REFUND_RECORDED -> REVIEW_REQUIRED` | S1 reconciliation code | none beyond the graph |
| `REVIEW_REQUIRED -> RESOLVED` | S1 operator CLI | `resolvedBy`, `resolution`, `resolvedAt` (CHECK) |

**S1 cannot create, authorize or enter `DISPATCHING`.** What S1 may do is read-only Shopify reconciliation plus the database transitions above for rows that **already carry valid durable dispatch evidence** (`dispatchedAt` and `dispatchToken` present). In S1 such rows exist only through the single test-only fixture helper on verified disposable databases (section 19.2), which keeps every trigger except the named transition trigger live and suspends that one only inside a single transaction that re-enables and verifies it before commit; there is no S1 code path under `app/` or `scripts/` that produces one.

**There is no re-freeze state and no path back into `PREPARED` or `DISPATCHING`.** Drift between freeze and dispatch aborts the row (or goes to `REVIEW_REQUIRED` if it indicates a merge-integrity contradiction); a new payload is never frozen onto an existing row. One financial dispatch per source order is therefore structural: one row per `(shop, sourceOrderId)`, one entry into `DISPATCHING` per row.

---

## 7. Direct admission (resolves B1 and H3)

Execution admission is driven directly by `MergeOperation` records. There is **no dependency on persisted shadow evidence**: no `shadowAdjustmentId`, no 24-hour shadow age rule, no comparison with a shadow plan. Existing shadow data can never become executable because no column, query or code path connects it to execution (rule 3.2.1).

### 7.1 Eligibility (all required; failure always fails closed)

| # | Predicate | Evaluated where | Failure result |
|---|---|---|---|
| E1 | Native Protocol v2: `protocolVersion = 2` and `calculatedOrderId IS NOT NULL` | scanner SQL, claim | not selected |
| E2 | `phase = 'COMPLETED'` and `sideEffectsDone = true` | scanner SQL, re-read at R1 | not selected |
| E3 | `createdAt >= admissionCutoff` (naive-UTC binding) | scanner SQL, claim | not selected, **no row written** |
| E4 | Shop-level gates open: `admissionEnabled`, approval valid, `Settings.shippingPolicy = 'REFUND_ALL'`, activation cutoff non-null, usable offline session | before selection | nothing selected or written (cannot pin the window) |
| E5 | Fresh merge and cancellation evidence: `assessSecondaryEvidence` over freshly read operation, `MergeRecord` and `MergeMutationAttempt` rows | claim, R1 | contradiction gives `REVIEW_REQUIRED` |
| E6 | Settle delay: at least 15 minutes after the secondary's verified `cancelledAt` | code | wait (time-bounded, see 7.6) |
| E7 | Not stale: at most 7 days after `cancelledAt` | code | `SKIPPED(STALE_COMBINE)` |
| E8 | Fresh Shopify evidence through the unmodified `evaluateShadowSource` plus the execution recheck (section 8) | R1, R2 | per the outcome table |
| E9 | Gate snapshot deep equality | claim, freeze, T3 | `ABORTED(GATE_CHANGED)` |

Operations whose cleanup is incomplete (`sideEffectsDone = false`) or permanently stopped (`sideEffectsDone = false` and `nextCheckAt IS NULL`) **never qualify** (E2). They get no row and cannot occupy any window. If cleanup later completes, the combine becomes selectable, subject to E3.

### 7.2 Scanner selection (exact, bounded)

Per approved shop, only after the shop-level gates (E4) pass:

```sql
SELECT op.*
FROM "MergeOperation" op
WHERE op."shop" = $shop
  AND op."protocolVersion" = 2
  AND op."calculatedOrderId" IS NOT NULL
  AND op."phase" = 'COMPLETED'
  AND op."sideEffectsDone" = true
  AND op."createdAt" >= ($admissionCutoff::timestamptz AT TIME ZONE 'UTC')
  AND op."primaryOrderId" ~ '^gid://shopify/Order/[0-9]+$'
  AND (op."createdAt", op."id") > ($afterCreatedAt::timestamptz AT TIME ZONE 'UTC', $afterId)
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(op."secondaries") = 'array'
           THEN op."secondaries" ELSE '[]'::jsonb END) s
    WHERE jsonb_typeof(s) = 'object'
      AND jsonb_typeof(s->'id') = 'string'
      AND (s->>'id') ~ '^gid://shopify/Order/[0-9]+$'
      AND (s->>'id') <> op."primaryOrderId"
      AND NOT EXISTS (
        SELECT 1 FROM "ShippingRefund" sr
        WHERE sr."shop" = op."shop" AND sr."sourceOrderId" = (s->>'id')
      )
  )
ORDER BY op."createdAt" ASC, op."id" ASC
LIMIT 50
```

`$afterCreatedAt`/`$afterId` start at the minimum and advance as a keyset cursor (see "Paging" below). The inner `NOT EXISTS` is against `ShippingRefund` **only**; the query never references `ShippingAdjustment`. The secondaries are deliberately **not** filtered by `cancelPhase` in SQL: a `COMPLETED` operation with an unverified secondary is a contradiction and must receive a durable `REVIEW_REQUIRED` row so it leaves the window, not be silently skipped forever.

**Every value that is copied into a CHECK-constrained column is validated in the scanner SQL first (N10, NEW-7).** A claim `INSERT` that violates a CHECK would throw on every scan and leave its operation at the front of the window forever. The values copied from an operation into a `ShippingRefund` row that have a CHECK are exactly: `sourceOrderId` (order-GID pattern, and `<> primaryOrderId`) and `primaryOrderId` (order-GID pattern). The scanner therefore requires, in SQL: `primaryOrderId` matches the order-GID pattern; the secondary `id` is a JSON **string** (the `jsonb_typeof` guard avoids the implicit cast of a number to text) matching the same pattern; and the secondary `id` differs from `primaryOrderId`. Together with the `CASE` that turns a non-array `secondaries` into an empty array and the object-type guard, one malformed operation can neither abort the whole query nor occupy the window. The order-GID pattern is **one constant (`ORDER_GID_PATTERN`) shared by the CHECKs, the scanner SQL and the application validators**; a test asserts that all occurrences are the same string, and a second test inserts operations whose `primaryOrderId` is malformed, whose secondary equals the primary, whose secondary `id` is numeric, `null` or missing, and proves the scan neither errors nor stalls.

**Paging and claim isolation (defence in depth).** The scan advances through the cursor for at most **4 pages (200 operations) per shop per scan**, so a page whose operations all produce no row cannot hold back later pages within a scan. A constraint violation (SQLSTATE class 23) raised by one claim is caught at the per-secondary boundary, logged `[shipping-refund] claim-rejected shop=<shop> op=<id> sqlstate=<code>`, and counted in the malformed-operations report; it never aborts the scan of other secondaries or operations. If a page budget is exhausted while a full page remains, the scan logs `[shipping-refund] scan-window-saturated shop=<shop>`, a monitoring alert condition (G-OPS). The cursor restarts from the beginning each scan, so no operation is skipped permanently.

Such operations are not refunded (fail closed) and are never silently invisible: a second bounded query, `findMalformedOperations(shop, 25)`, lists v2 `COMPLETED` operations at or after the cutoff that fail any of the following: `secondaries` is not an array; an element is not an object; an element's `id` is missing, not a string or not a well-formed order GID; an element's `id` equals the operation's `primaryOrderId`; the operation's `primaryOrderId` is not a well-formed order GID; plus, from the claim path, operations whose claim was rejected by a database constraint. A secondary whose `sourceOrderId` is already claimed by a row of a **different** `mergeOperationId` is also reported (`source-claimed-by-other-operation`): the unique key makes it safe, since only one refund can ever exist per source, but it contradicts the one-merge-per-secondary invariant and a human should know. Each scan logs the counts as `[shipping-refund] malformed-operations shop=<shop> count=<n>` for monitoring. No row is written for them because there is no valid key to write.

Second query, due rows: `SELECT * FROM "ShippingRefund" WHERE "shop" = $shop AND "status" = 'QUEUED' AND ("nextCheckAt" IS NULL OR "nextCheckAt" <= DB_WALL) AND ("leasedUntil" IS NULL OR "leasedUntil" < DB_WALL) ORDER BY "nextCheckAt" ASC NULLS FIRST LIMIT 25`.

### 7.3 Processing algorithm (per shop, per scan)

1. Evaluate E4; if closed, stop (write nothing).
2. **Part A, due `QUEUED` rows** (outside any new-row cap): lease, re-evaluate, settle.
3. **Part B, new rows.** For each selected operation:
   - read `MergeRecord` and `MergeMutationAttempt` rows and the existing `ShippingRefund` rows for its secondaries;
   - `rowFree` = secondaries with no row. Existing rows of any status never consume the allowance;
   - take at most **25** `rowFree` secondaries per operation per scan;
   - respect a per-shop per-scan budget of **25** Shopify evaluations (bounds API cost);
   - for each secondary:
     - if `assessSecondaryEvidence` reports issues, `claimTerminal(REVIEW_REQUIRED)` (no Shopify read);
     - if E6 not met, leave it unclaimed;
     - if E7 fails, `claimTerminal(SKIPPED, STALE_COMBINE)`;
     - otherwise claim (7.5), evaluate (section 8), settle.

### 7.4 Outcomes

| Result | Row |
|---|---|
| Evaluator READY and execution recheck passes, lane `EXECUTE` | `QUEUED -> PREPARED` (freeze, section 8.3) |
| Evaluator READY and recheck passes, lane `OBSERVE` | `QUEUED -> OBSERVED` |
| Evaluator SKIP (nothing refundable, policy skip) | `SKIPPED` |
| Evaluator REVIEW or recheck failure (unsupported financial evidence: gateway, tax, currency, prior refund, split payment, truncated history, primary cancelled, etc.) | `INELIGIBLE` with the evaluator's reason |
| Refund baseline not established or not acceptable under the active `REFUND_BASELINE_MODE` (a refund record exists under `STRICT_EMPTY`; history incomplete; any prior monetary refund; any prior refunded shipping), section 8.2 | `INELIGIBLE(PRIOR_REFUND_RECORD)` or `INELIGIBLE(BASELINE_UNVERIFIED)` |
| A `QUEUED` row whose seven-day horizon (`sourceCancelledAt + 7 days`) has passed | `ABORTED(HORIZON_EXPIRED)` (provably unsent; also applies to `OBSERVE` rows still `QUEUED`) |
| `assessSecondaryEvidence` issues (merge-evidence contradiction) | `REVIEW_REQUIRED` |
| Transient failure (transport, top-level error, unusable session) | reschedule 5 minutes, `attempts + 1`; after **8** attempts `INELIGIBLE(EVAL_UNAVAILABLE)` |
| Claim returns gate-changed | no row; the next scan decides afresh |
| Claim returns conflict (another scanner won) | skip |
| Stopped or incomplete cleanup; combine before cutoff | never selected |

### 7.5 Claim transaction and concurrent scanners

The claim is one transaction: `FOR SHARE` on `AppControl`, `Settings`, `ShippingExecuteControl` and the approval row; recompute the live gate (every individual epoch of 4.4, not only the cutoffs) and require it to equal the snapshot about to be written; decide the lane; `INSERT ... 'QUEUED' ... ON CONFLICT ("shop","sourceOrderId") DO NOTHING RETURNING *`, with a new idempotency key and marker, `sourceCancelledAt` copied from the operation's verified secondary record, every dispatch/response/refund/approval/wire column NULL (5.3 insert integrity), `attempts = 1` and a lease of 180 seconds. The unique index is the only arbiter: of two concurrent scanners exactly one inserts each secondary's row; the other gets no row and moves on. Duplicate rows and duplicate financial candidates are impossible.

**Terminal claim outcomes use the same transaction (N9).** `claimTerminal(status, reason)` is the same transaction as the claim with a terminal status in the insert (`SKIPPED`, `INELIGIBLE` or `REVIEW_REQUIRED`): `FOR SHARE` locks, fresh live-gate recomputation, equality with the snapshot being written, lane decision, and `INSERT ... ON CONFLICT DO NOTHING`. If the gate is closed or has changed, **no row is written**. A terminal row therefore always carries a gate snapshot that was true at the instant it was written, and the snapshot columns are immutable afterwards. Settling an already-claimed row to a non-money terminal state (`OBSERVED`, `SKIPPED`, `INELIGIBLE`) is a lease-fenced update that needs no new gate check, because those states authorize nothing; only the freeze to `PREPARED` rechecks the gate (section 8.3).

### 7.6 Progression and non-starvation guarantees

- **Rows leave the window at claim.** A claimed row has a `ShippingRefund` entry, so its secondary no longer matches the `NOT EXISTS`. Repeated evaluation failures therefore cannot hold the window; they retry through the due-row query and are capped at 8 attempts.
- **Terminal rows never re-enter.** Terminal rows exist for every secondary that was decided.
- **More than 25 secondaries.** The sibling search allows up to 50 (`order-work-processor.server.ts:51-52`). Each scan claims at most 25 new rows per operation, previously decided secondaries never consume that allowance, so a 50-secondary combine finishes in at most two scans.
- **Historical combines** are excluded in SQL and never produce rows.
- **Settle delay (E6)** is time-bounded: it can defer a secondary for at most 15 minutes after its cancellation and cannot pin the window beyond that.
- **Monotonic progress:** each scan with any eligible secondary creates at least one row, rows are never deleted, and the number of unclaimed secondaries is finite, so every eligible secondary is reached.

---

## 8. Evaluation and freeze (read-only until T3)

### 8.1 R1: fresh evidence

`evaluateShadowSource(readOnlyAdmin(admin), { sourceOrderId, policy: { kind: 'REFUND_ALL' }, marker: row.marker, primaryOrderName: row.primaryOrderName })`. Its validations are not relaxed (F1). Note that the marker embedded in the refund `note` is the **execution** marker generated at claim.

### 8.2 Execution recheck and the refund baseline (new read-only documents; NEW-1)

A separate read-only query adds checks the evaluator does not make (F17). Its proposed documents are **Q-RECHECK**, **Q-RECONCILE** and **Q-REFUND-DETAIL** in section 12.1 (all **UNVALIDATED**), and the app identity is read with **Q-APPID**. Failure of any check gives `INELIGIBLE` (before freeze) or `ABORTED` (after). `Order.refunds` and `Order.transactions` are plain arrays, so completeness means "fewer than 50 entries", never `pageInfo`.

#### 8.2.1 The problem and the stance

Revision 3 required the secondary's refund list to be empty on the premise that a PAID order has no refunds. **That premise is unverified (F16).** Protocol v2 cancels the secondary with `restock: true` and `originalPaymentMethodsRefund: false`; Shopify may or may not record a `Refund` object (and a `RefundAgreement`) for that restocking cancellation, with no money moved. This design does **not** assume such records exist and does **not** assume they do not. It separates three things and makes the final rule a function of evidence that G-READBACK must collect.

**Classification of refund records on the secondary** (computed from Q-RECONCILE plus Q-REFUND-DETAIL; `UNVALIDATED`):

| Class | Definition | Meaning |
|---|---|---|
| **Baseline record (candidate)** | A `Refund` present when the baseline is captured at freeze, with **all** of: `totalRefundedSet` equal to 0 in the order's currency, **no** `transactions`, **no** `refundShippingLines`, **no** `orderAdjustments`, **no** `duties`, and a `note` that does not contain the prefix `MS-SHIPREFUND-`. The refund-line-item content (restock) is permitted for this class only | The shape a non-monetary, cancellation-generated record would have. Whether Shopify produces one is unknown |
| **Financial refund** | Any refund that has at least one transaction, or a non-zero `totalRefundedSet`, or a shipping line, or an order adjustment, or a duty, **or** a note containing `MS-SHIPREFUND-` | Money (or a shipping/payment component) moved or is moving. Never part of an acceptable baseline |
| **Unclassifiable** | Any needed field missing or null, any nested connection with `hasNextPage` not exactly `false`, a refund list of 50 or more, or a currency that differs from the order currency | Completeness unproven; fails closed |

#### 8.2.2 The baseline (captured at freeze, stored in `preEvidence.baseline`)

The baseline is captured **in the same read** whose result is frozen, and stored as a sorted, canonical JSON object:

`{ capturedAt, mode, currency, refunds: [ { id, totalMinor, transactionCount, shippingLineCount, adjustmentCount, dutyCount, refundLineItemCount } ... sorted by id ], refundCount, totalRefundedMinor, totalRefundedShippingMinor, transactionIds: [...sorted], moneyTransactionCount }`

Requirements before a row may freeze (all must hold; each failure is `INELIGIBLE` with the stated reason):

1. **Complete history:** `refunds` and `transactions` arrays shorter than 50; every nested connection read has `hasNextPage === false`; no unclassifiable record (`BASELINE_UNVERIFIED`).
2. **Zero previously refunded shipping:** `totalRefundedShippingSet = 0` **and** the sum of all `refundShippingLines` subtotal and tax is 0 (the evaluator already requires the reconciliation; Phase 2 requires it too).
3. **No previous monetary refund:** `totalRefundedSet = 0`, **no** transaction of kind `REFUND` anywhere in `transactions`, and no refund classified as a Financial refund (`PRIOR_REFUND_RECORD`).
4. **Baseline records acceptable under the active mode** (8.2.3).
5. The single successful `CAPTURE` or `SALE` rule of section 8.2.4 holds.

#### 8.2.3 The active rule and how it is finalized (fail closed until then)

The rule is governed by one code constant, `REFUND_BASELINE_MODE`, pinned by a test and changeable only by a reviewed change:

- **`STRICT_EMPTY` (the only mode S1 implements and the default).** The baseline refund set must be **empty**: any refund record at all makes the row `INELIGIBLE(PRIOR_REFUND_RECORD)`. This is exactly Revision 3's behavior and is the fail-closed position. If Shopify does record a cancellation refund, every row becomes `INELIGIBLE` under this mode. That is safe and loud: S1 records, for each such row, a best-effort diagnostic of the record's class (read-only, never altering the outcome) so the shape is visible in the data, and the status CLI reports the count of `PRIOR_REFUND_RECORD` rows.
- **`BASELINE_TOLERANT` (specified, not implemented in S1).** The baseline may contain records that satisfy the Baseline-record definition above and nothing else. It is **not enabled by default and not coded in S1**. It can be introduced only by a reviewed amendment that has all of: (a) G-READBACK evidence, archived per section 17, of what `orderCancel(restock: true, originalPaymentMethodsRefund: false)` actually leaves on a development-store secondary, including every field in the table above and any `RefundAgreement`; (b) a decision recorded in this specification stating the exact predicate the evidence supports (it may be narrower than the definition above, for example by also requiring `refundLineItemCount > 0`); (c) golden tests built from the archived responses; (d) review of the change to the constant. **If the evidence shows that no cancellation refund record exists, `STRICT_EMPTY` becomes the permanent rule and this tolerant mode is deleted from the design.**
- S1 is structured so that this finalization touches only the admission predicate: the baseline is always captured and compared **by refund-id set and per-record fingerprint** (8.2.5), and under `STRICT_EMPTY` that set is simply empty. No other S1 module changes when the mode changes.

Consequence for the stage plan: S1 may be accepted under `STRICT_EMPTY`, but S3.5 (production observation) cannot produce `OBSERVED` rows for real combines if cancellations leave records, so G-READBACK's cancellation finding must be resolved before S3.5 and is recorded in the S1 review (Appendix E U4).

#### 8.2.4 Other execution-recheck requirements (unchanged in substance)

- The secondary's transactions contain exactly one `SUCCESS` `CAPTURE` or `SALE`, at most one `AUTHORIZATION` (and only as that capture's parent), and nothing else (no `REFUND`, `VOID`, `CHANGE` or other kinds). Split payments, gift cards and multiple captures are ineligible.
- The primary order loads, `cancelledAt` is null, and `displayFinancialStatus` is neither `REFUNDED` nor `VOIDED`.

#### 8.2.5 Detecting change before T3 (R2) and defining EXTERNAL_REFUND

R2 re-reads and compares to `preEvidence.baseline`:

- The refund-id set must equal the baseline set exactly, and every baseline record's fingerprint (`totalMinor`, `transactionCount`, `shippingLineCount`, `adjustmentCount`, `dutyCount`) must be unchanged; `totalRefundedMinor` and `totalRefundedShippingMinor` must equal the baseline (both 0); `transactionIds` must equal the baseline. A **new refund id**, a changed baseline fingerprint or changed aggregate on a never-dispatched row gives `ABORTED(REFUND_APPEARED)`.
- A refund whose note carries the `MS-SHIPREFUND-` prefix on a row that was **never dispatched** is a contradiction (a possible restore or double-send) and gives `REVIEW_REQUIRED(UNEXPECTED_OWN_MARKER)`, not an abort.
- **`EXTERNAL_REFUND` is defined relative to the baseline** (section 12.5): for a dispatched row, a refund id **not in `preEvidence.baseline.refunds`** that is not the marker refund, or a baseline record whose fingerprint changed, is `EXTERNAL_REFUND`. The mere presence of refund records is never an external refund; a baseline record that is still unchanged is ignored.

#### 8.2.6 What is recorded

`preEvidence` also records: the secondary's aggregates (`totalRefundedSet`, `totalRefundedShippingSet`), refund count, transaction ids, the capture and (if any) authorization transaction ids, and the baseline above.

All new documents are **UNVALIDATED** and must be validated verbatim against API 2026-04 with read-only calls (G-READBACK) **before S1's recheck and reconciliation code is accepted** (section 18), not merely before S2. G-READBACK must also read a MergeShip-cancelled secondary to settle F16 (section 22).

### 8.3 Freeze (T2)

One transaction: lock the row `FOR UPDATE`; verify token and lease; recompute the live gate (every individual epoch, 4.4) and require equality with the snapshot; then in **one** `UPDATE ... WHERE status='QUEUED'` write `wireVariables`, `wireHash`, `documentSha256`, `mutationVersion`, `currencyCode`, `plannedShippingMinor`, `parentTransactionId`, `gateway`, `preEvidence` (including the baseline, 8.2.2), `preparedAt` and set `PREPARED` (or `OBSERVED` for lane `OBSERVE`). Every frozen field is write-once. The wire request is built from the evaluator's `RefundInput` plus the row's key.

**Frozen request columns on an `OBSERVED` row are a record, not an authorization.** An `OBSERVED` row carries the same frozen columns so that the evidence shows exactly what would have been sent. It is not dispatch authorization, for independent reasons: its `lane` is `OBSERVE` and immutable; `OBSERVED` is terminal and has no outgoing edge in the transition graph; `QUEUED -> PREPARED` requires `lane='EXECUTE'`; the operator hash approval can be recorded only on a `PREPARED` `EXECUTE` row (5.4.6); its `dispatchEpochAtAdmission` is NULL; and the evidence-integrity trigger forbids stamping dispatch evidence on it. A test asserts that no update of any kind moves an `OBSERVED` row, including with a hand-written `UPDATE`.

### 8.4 Drift before dispatch

**The seven-day horizon applies to `QUEUED` and `PREPARED` rows alike (N5, NEW-4).** A frozen wire request is safe to hold because its idempotency key has never been sent and R2 re-validates everything immediately before T3; the old 24-hour `STALE_PREPARED` abort protected nothing that R2 does not already protect, and it would have permanently aborted valid refunds that merely waited for the breaker, a cap or a slow operator approval. Every non-terminal pre-dispatch row, whether `QUEUED` or `PREPARED`, is therefore bounded only by the **seven-day eligibility horizon**: `DB_WALL > sourceCancelledAt + 7 days` makes the row `ABORTED(HORIZON_EXPIRED)` (a lease-fenced update; provably unsent). The horizon is computed from the row's own immutable `sourceCancelledAt` (5.1), so it needs no Shopify read and is checked at every lease, at the capacity precheck and inside T3. Staleness of evidence is handled by R2, not by age.

**The ordering of approval, capacity and fresh evidence (N5, NEW-4).** An operator cannot approve a `wireHash` that does not exist yet, so the only coherent order is:

1. **freeze** (T2, 8.3): the wire request, hash and baseline now exist;
2. **operator hash approval** (4.6): the operator records `approvedWireHash` for exactly this `wireHash` (skipped when `autoApprove`);
3. **capacity precheck** (database only): breaker, shop and global caps, per-refund cap and currency pin;
4. **pre-dispatch fresh evidence** (R2, below);
5. **T3** (9.2).

**What a capacity check may cover before the freeze.** Before the freeze, an `EXECUTE`-lane `QUEUED` row may wait on a narrower, database-only precheck covering **only** the breaker and the per-shop and global daily caps (its purpose is to avoid spending Shopify reads on a row that cannot dispatch soon). It must **not** require operator approval of the current `wireHash`, and it must **not** evaluate the per-refund cap (the planned amount is not known until evaluation). Approval presence and the per-refund cap are post-freeze checks.

**Waiting rows (N5, NEW-4; required before S2).** While dispatch is *unavailable for capacity reasons* (breaker tripped, a cap reached, operator hash approval not yet recorded) a row waits and is never aborted for that reason: a `QUEUED` row stays `QUEUED` and a `PREPARED` row stays `PREPARED`. Waiting reschedules the row with a backoff of at most 15 minutes and **does not increment `attempts`**; the 8-attempt budget counts failed evaluations only, so capacity and approval delays never consume it. A gate inequality (control cycled, epoch changed, approval restamped, policy changed) or a changed refund baseline is a different class and still aborts.

Immediately before T3, R2 re-runs R1 and the recheck, and compares to the baseline (8.2.5). Results:

| R2 result | Row |
|---|---|
| READY, and the rebuilt `wireHash` equals the frozen one | proceed to T3 |
| READY but any difference (amount, parent, gateway, currency) | `ABORTED(DRIFT_BEFORE_DISPATCH)` |
| Evaluator SKIP or REVIEW, or recheck failure (for example a new refund id or a changed baseline fingerprint appeared, 8.2.5) | `ABORTED(<reason>)` (`REFUND_APPEARED` for baseline changes) |
| A refund carrying our marker prefix on a never-dispatched row | `REVIEW_REQUIRED(UNEXPECTED_OWN_MARKER)` |
| `assessSecondaryEvidence` now reports issues | `REVIEW_REQUIRED` |
| Transient failure | retry later while `PREPARED` (bounded by the seven-day horizon; does not abort) |

A drifted row is never re-frozen. Whether an operator may re-admit a never-dispatched `ABORTED` or `INELIGIBLE` source is PD4; in v0 there is no re-admission path.

---

## 9. Dispatch (Stage S2; specified now so S1 schema and gate are compatible)

### 9.1 Sequence

| Step | Kind | Content |
|---|---|---|
| T0 | tx | Admission claim (7.5) |
| T1 | conditional `UPDATE` | Lease: status `QUEUED` or `PREPARED`, expired lease, due `nextCheckAt`, TTL **180 s** on the database clock; renewed between Shopify reads |
| R1 | reads | Evaluation (8.1, 8.2) |
| T2 | tx | Freeze (8.3) |
| approval | CLI | Operator records `approvedWireHash` unless `autoApprove` |
| capacity precheck | DB reads only | Breaker, shop and global caps, per-refund cap, currency pin and the recorded hash approval (9.2). If any is unavailable the row waits; **no Shopify read is made and no attempt is consumed**. (A narrower breaker-and-daily-caps-only precheck may run before the freeze, 8.4; the hash approval can only come after the freeze) |
| R2 | reads | Pre-dispatch re-evaluation (8.4), only after the capacity precheck passed |
| T3 | tx | Gate and write-ahead (9.2) |
| S1 | one request | The single send (9.3, section 10) |
| T4 | conditional `UPDATE` | Outcome, fenced by `dispatchToken` (9.4) |
| V | read-only | Verification and reconciliation (section 12) |

No network I/O happens inside any transaction. All timestamps use the database UTC clock (`DB_WALL`).

### 9.2 T3: gate and write-ahead (the point of no return)

Single transaction, `lock_timeout` 2 s:

1. Lock the row `FOR UPDATE`; lock `AppControl`, `Settings(shop)` `FOR SHARE`; lock `ShippingExecuteControl` `FOR UPDATE`; lock the approval row `FOR SHARE` (section 4.10).
2. Recompute the live gate; require **deep equality of every individual epoch (4.4)** with the row snapshot, `dispatchEnabled`, `lane='EXECUTE'`, `operationCreatedAt >= dispatchCutoff`, the process environment flag, `Settings.shippingPolicy = 'REFUND_ALL'`, and `DB_WALL <= sourceCancelledAt + 7 days`.
3. Require `documentSha256` equals the pinned constant of **this build**, and recompute `wireHash` from the stored `wireVariables` and require equality (I18).
4. Require `autoApprove` or `approvedWireHash = wireHash`.
5. Caps (after the lock, 4.6): per refund, per shop, global; currency equals the approval currency. The per-refund comparison is numeric (4.6.1); a value failing its format refuses the dispatch.
6. Breaker (4.7): no unresolved dispatched row exists.
7. `UPDATE ... SET status='DISPATCHING', dispatchToken=<new uuid>, dispatchedAt=DB_WALL WHERE id=$id AND status='PREPARED' AND dispatchedAt IS NULL AND leaseToken=$t AND leasedUntil > DB_WALL`; require rowcount 1. The event row is written by the database trigger (section 5.4.5), not by the store.

**T3 refusal classes (N5).** A refusal is exactly one of:

| Class | Conditions | Effect on the row |
|---|---|---|
| **Abort** (eligibility) | Gate inequality, `dispatchEnabled` off or epoch changed, policy no longer `REFUND_ALL`, `documentSha256` differs from the build's pin, `wireHash` mismatch, `operationCreatedAt < dispatchCutoff`, seven-day horizon passed | `ABORTED(<reason>)` |
| **Wait** (capacity) | Breaker tripped, per-shop or global cap reached, operator approval not yet recorded | Row unchanged; reschedule with backoff of at most 15 minutes; `attempts` not incremented |
| **No decision** (infrastructure) | Lock timeout, transient database error, unknown commit | No send; the row is handled as in sections 9.3 and 13 |

**The S2 migration (S2 only).** The dispatch edge is a schema change: the S1 migration's transition trigger omits `PREPARED -> DISPATCHING` (section 5.4.1) and a **separate, separately authorized** S2 migration replaces **only the transition-graph trigger function** to allow it, adding no tables. The evidence-integrity trigger (5.4.6), the frozen-column, shape, no-delete/no-truncate and event triggers, and all CHECKs are unchanged by it. The S2 migration is the only artifact that may introduce this edge; no S1 change, no fixture, no script and no hand-applied SQL may add it. It is reviewed with S2 and is part of the production-migration approval (G-MIGRATE-PROD) of whichever build first contains the dispatcher.

### 9.3 Send permission (I19, I23)

- **If the T3 commit acknowledgement is unknown, the process MUST NOT send.** Any exception from the transaction call, including a timeout, a connection loss at `COMMIT`, or a serialization or lock error, means no send. The worst case is a `DISPATCHING` row that nobody sent; it follows the `IN_DOUBT` path and ends in human review. No request ever left the process.
- **Sending is permitted only from the same process and call stack that observed the successful T3 commit.** `openDispatchGate` returns a `DispatchPermit` only after the transaction promise resolves successfully. The permit is a module-private class (one construction site), carries the row id, token and a monotonic issue time, and is single-use.
- `sendRefund(permit)` marks the permit consumed **before** calling `admin.graphql`, so no exception path can reuse it; it refuses a consumed permit and refuses a permit older than **10 seconds** (monotonic clock). If the permit expires unused the row simply stays `DISPATCHING`.
- **A `DISPATCHING` row found in the database never causes a send.** There is no code path from a status read to a send. An architecture test enforces that `new DispatchPermit` appears once and `sendRefund` is referenced only by the worker.

### 9.4 T4: outcome write

Fenced by `dispatchToken`, **not** by the lease, deliberately unlike the merge protocol: `WHERE dispatchToken = $tok AND status IN ('DISPATCHING','IN_DOUBT')`. Reasoning: only one process can hold a given token; the write only adds information and cannot move money; losing a durable refund id is worse than a late write. The refund id is also logged (`[shipping-refund] dispatched row=<id> refund=<gid>`) before the write. The write is retried in process three times with backoff holding the response in memory; if the database stays unavailable the process falls back to the `IN_DOUBT` recovery path.

### 9.5 `DISPATCHING` to `IN_DOUBT`

A sweep moves a row to `IN_DOUBT` when `status = 'DISPATCHING'` and `dispatchedAt` is older than 120 s with no outcome (conditional update). 120 s exceeds the 45 s request abort, and a late T4 from the original sender remains valid because it is fenced by token and accepts `IN_DOUBT`.

---

## 10. Shopify request contract (resolves H1)

### 10.1 Constant document with a key variable

```graphql
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
```

- The document is a single constant in the contract module. Its text is normalized (LF line endings, no trailing whitespace) and its `documentSha256` is pinned by a test.
- **`userErrors` selects only `field` and `message`.** Selecting `code` is not done (F11); idempotency anomalies are detected best-effort from the message text and always also handled by the generic `IN_DOUBT` path.
- Whether the directive accepts a variable for synchronous `refundCreate` in 2026-04 is **not yet proven**. Shopify documents the variable form in the bulk-operation guide only (F7). It is confirmed by two separate future gates: **G-INTROSPECT** (read-only `__schema { directives { name locations args { name type { kind name ofType { kind name } } } } }` against 2026-04, confirming the `key: String!` argument and a field location) and **G-E7** (an approved dev-store `refundCreate` experiment confirming runtime acceptance).

### 10.2 The frozen wire request

```
wireHash = sha256( canonicalJson( { documentSha256, variables: { idempotencyKey, input } } ) )
```

- `canonicalJson` is the existing exported sorted-key serializer.
- `wireVariables = { idempotencyKey, input }` and `documentSha256` and `wireHash` are frozen at the freeze and recomputed at T3. The dispatcher sends exactly the stored `wireVariables` with the pinned document. **The frozen record therefore describes the exact wire request, not merely `RefundInput`** (I18).
- **Scope of the hash (N13).** `wireHash` covers the canonical *semantic* request (document hash, key and input) under the sorted-key serializer. The bytes actually sent are produced by serializing the same stored object; nothing in the design depends on byte-for-byte equality of that transport serialization, and nothing may compare against it.
- `T3` refuses a row whose `documentSha256` differs from the build's pinned constant. This also covers a row prepared before a document change.

### 10.3 Validated-template fallback (if the variable form is rejected)

Decided before S2 by G-INTROSPECT and G-E7:

- `REFUND_DOCUMENT_TEMPLATE` carries `@idempotent(key: "__IDEMPOTENCY_KEY__")` with exactly **one** occurrence of the placeholder; the template's own hash is pinned.
- The key must match the strict UUIDv4 pattern `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` before rendering; anything else refuses.
- Rendering replaces the single placeholder; a test asserts the rendered document differs from the template **only** at that position.
- `documentSha256` is the hash of the **rendered** document; the variables contain `input` only; `wireHash` keeps the same formula with `idempotencyKey` included so the stored record is uniform.

### 10.4 `RefundInput` (retained shape; reported validated by experiments E1/E2, evidence not yet archived, F10)

`orderId` (the cancelled secondary), `notify: false`, `note` (carries the marker), `currency`, `shipping: { amount, fullRefund: false }`, and `transactions: [ { orderId (the same secondary), parentId (verified successful CAPTURE/SALE), gateway, kind: 'REFUND', amount } ]`.

Never: `refundLineItems`, restock, `allowOverRefunding`, refund methods, store credit, or `RefundShippingInput` (that belongs to the returns API).

### 10.5 Transport

- Raw `admin.graphql(DOCUMENT, { variables, signal })` with a 45 s abort (the existing `GQL_TIMEOUT_MS`) and **no `tries` option**, so retries are 0 (F8). The dispatcher does not use the `gql()` wrapper because it must parse the raw response itself.
- A counting fake-HTTP test proves exactly one wire request per dispatch for responses 429, 503, connection reset, abort and timeout.
- The key is persisted before the first and only send, so the 24-hour retention window is irrelevant: nothing ever sends again.

---

## 11. Response classification

Every non-success response leaves the row `IN_DOUBT`. Nothing resends under any key, and a response that looks like a rejection is never proof that nothing happened.

| Outcome | Condition | Result |
|---|---|---|
| Accepted | 2xx; no top-level `errors`; `refund.id` is a valid Refund GID; `userErrors` empty | `REFUND_RECORDED`; `refundId`, `respondedAt`, `responseSummary`. Not proof of settlement. |
| Duplicate echo | Refund id equals the recorded one | no-op |
| Duplicate suspected | A second refund carries our marker, or the id is attached to another row | `REVIEW_REQUIRED(DUPLICATE_SUSPECTED)`, paged |
| User errors | `refund` null with non-empty `userErrors`, or `refund` and `userErrors` both present | `IN_DOUBT`, `responseKind = USER_ERRORS`; messages stored |
| Idempotency anomaly | Message text matches the documented idempotency messages | `IN_DOUBT` plus an alert: a single send cannot produce these, so an invariant was violated |
| Top-level errors | Throttle, access denied, schema error | `IN_DOUBT`, `TOP_LEVEL_ERRORS` |
| No answer | Transport error, abort, timeout, non-200, non-JSON or malformed body | `IN_DOUBT`, `TRANSPORT` |

How Shopify surfaces idempotency errors for `refundCreate` (as `userErrors` or as top-level errors) is unverified and affects only labels. It is covered by G-E7.

---

## 12. Verification and reconciliation (read-only; runs regardless of every switch)

### 12.1 Read-back documents

**Every document below is a PROPOSAL and is UNVALIDATED.** None of them has been executed against Shopify. Shapes were taken from the 2026-04 reference documentation (F13) and from the pattern already used by the accepted merge path (F14); that is not validation. A document becomes validated only when its **exact text** (identified by its sha256) has run successfully, read-only, on the approved development store and the sanitized request and response are archived under `docs/evidence/shipping-v0/` (section 17). Any edit to a document's text resets it to UNVALIDATED.

**Schema distinctions the documents rely on (F13):**

| Field | Kind | Completeness rule |
|---|---|---|
| `Order.refunds`, `Order.transactions` | **plain arrays**; `first` only truncates | There is no `pageInfo`. Fewer than 50 entries is complete; **50 or more means completeness is unproven** and goes to review |
| `Order.agreements` | connection | `nodes` and `pageInfo { hasNextPage endCursor }`; paginate with `nextPageCursor` (F14), at most 5 pages, otherwise review |
| `Refund.transactions`, `Refund.refundShippingLines`, `Refund.refundLineItems`, `Refund.orderAdjustments` | connections | Read `nodes`; `pageInfo.hasNextPage` must be exactly `false`, otherwise review |
| `Refund.createdAt` | nullable | `null` is **not** treated as a date; see 12.3 |
| `Refund.processedAt` | non-null | The authoritative timestamp for the timing window |
| Money | `MoneyBag` | Always read `presentmentMoney { amount currencyCode }` (matches the accepted evaluator); the amount and the currency code are both compared |

**Q-APPID: the verified current app id (UNVALIDATED for Phase 2).**

```graphql
query ShippingRefundAppIdentity {
  currentAppInstallation { app { id } }
}
```

The identical selection is already used by the accepted merge path (`CURRENT_APP_QUERY`, `evidence.server.ts:107-110`). The id used for attribution must come from this live read through the shop's own session at reconciliation time, never from an environment variable.

**Q-RECHECK: execution recheck on the secondary and the primary (UNVALIDATED).**

```graphql
query ShippingRefundExecRecheck($source: ID!, $primary: ID!) {
  source: order(id: $source) {
    id
    cancelledAt
    closed
    displayFinancialStatus
    currencyCode
    totalRefundedSet { presentmentMoney { amount currencyCode } }
    totalRefundedShippingSet { presentmentMoney { amount currencyCode } }
    refunds(first: 50) { id }
    transactions(first: 50) {
      id
      kind
      status
      gateway
      test
      amountSet { presentmentMoney { amount currencyCode } }
      parentTransaction { id }
    }
  }
  primary: order(id: $primary) {
    id
    cancelledAt
    displayFinancialStatus
    currencyCode
  }
}
```

`refunds` and `transactions` are arrays: the application rejects a length of 50 or more as "completeness unproven". An absent `source` or `primary` (null) is a transient or review outcome, never a pass.

#### 12.1.2 Cost-aware reconciliation: a cheap list, then a bounded by-id detail (NEW-9)

Revision 3's single reconciliation document read up to 50 refunds each with four nested connections (`first: 10`). Shopify rejects a single query whose *requested* cost exceeds 1,000 points before running it, and prices connections by their `first` argument (F18). How a plain array field of 50 objects with nested connections is priced is not documented in what was read, and the one comparable evaluator query that the code reports as validated has **one** nested connection per refund. Rather than guess, the design **splits the read**:

- **Q-RECONCILE (list, UNVALIDATED)**: scalars only per refund, no nested connections. It answers "which refunds exist, which carry our marker, what are the aggregates".
- **Q-REFUND-DETAIL (by id, UNVALIDATED)**: the nested connections, for a **bounded set of refund ids** taken from the list: the marker refund(s), the recorded `refundId`, and (for baseline classification, 8.2) the refunds present at freeze, at most **5 ids per request and 2 requests (10 refunds) per evaluation**. More than 10 refunds on the secondary is `BASELINE_UNVERIFIED`; more than 5 ids needs a second request, never a larger one.

**Q-RECONCILE: refund list on the secondary (UNVALIDATED).**

```graphql
query ShippingRefundReconcile($source: ID!) {
  order(id: $source) {
    id
    cancelledAt
    closed
    displayFinancialStatus
    currencyCode
    totalRefundedSet { presentmentMoney { amount currencyCode } }
    totalRefundedShippingSet { presentmentMoney { amount currencyCode } }
    refunds(first: 50) {
      id
      note
      createdAt
      processedAt
      totalRefundedSet { presentmentMoney { amount currencyCode } }
    }
    transactions(first: 50) {
      id
      kind
      status
      gateway
      test
      amountSet { presentmentMoney { amount currencyCode } }
      parentTransaction { id }
    }
  }
}
```

**Q-REFUND-DETAIL: nested records for specific refunds (UNVALIDATED).** `Refund` implements `Node` (F19), so the candidate form is `nodes(ids:)`. That `nodes(ids:)` accepts `Refund` ids, and that `duties { amountSet }` is a valid selection, are themselves unvalidated (Appendix E U9).

```graphql
query ShippingRefundDetail($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Refund {
      id
      note
      createdAt
      processedAt
      order { id }
      totalRefundedSet { presentmentMoney { amount currencyCode } }
      duties { amountSet { presentmentMoney { amount currencyCode } } }
      refundShippingLines(first: 10) {
        nodes {
          subtotalAmountSet { presentmentMoney { amount currencyCode } }
          taxAmountSet { presentmentMoney { amount currencyCode } }
        }
        pageInfo { hasNextPage }
      }
      refundLineItems(first: 10) {
        nodes { id }
        pageInfo { hasNextPage }
      }
      orderAdjustments(first: 10) {
        nodes { id }
        pageInfo { hasNextPage }
      }
      transactions(first: 10) {
        nodes {
          id
          kind
          status
          gateway
          test
          amountSet { presentmentMoney { amount currencyCode } }
          parentTransaction { id }
        }
        pageInfo { hasNextPage }
      }
    }
  }
}
```

Response handling is fail-closed: the `nodes` array length must equal the number of requested ids; each element must be an object with an `id` equal to a requested id (a non-matching fragment returns an object without `id`; a missing id returns `null`), ids must be unique, and `order.id` must equal the row's `sourceOrderId`. Anything else is "completeness unproven" (lag class, then review). `orderAdjustments` must be empty for our refund (a shipping-only refund carries no adjustments); a non-empty list is a contradiction.

**Measurement requirement (G-READBACK).** For **every** document in 12.1, at its designed worst-case bounds (50-element arrays, 5 ids, `first: 10`, 5 agreement pages), run it read-only with the header `Shopify-GraphQL-Cost-Debug=1` and archive `requestedQueryCost`, `actualQueryCost` and the per-field breakdown (section 17). **Design acceptance rule:** `requestedQueryCost` must be at most **500** (half the platform's 1,000 limit, leaving bucket headroom); if a document exceeds it, its bounds are reduced (fewer ids per request, smaller `first`), its text changes, its sha256 changes, and it is re-measured. This threshold is a design margin chosen here, **not** a Shopify-published figure. The split design is adopted because the combined query's cost is unknown, not because it was measured to fail. Throttled responses (`THROTTLED` top-level errors) are transient and never contribute evidence.

**Q-AGREEMENTS: refund attribution through `RefundAgreement` (UNVALIDATED).**

```graphql
query ShippingRefundAgreements($source: ID!, $after: String) {
  order(id: $source) {
    agreements(first: 50, after: $after) {
      nodes {
        __typename
        id
        happenedAt
        reason
        app { id }
        ... on RefundAgreement {
          refund { id }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```

It reuses the merge path's pagination discipline: independent document, `nextPageCursor`/`IncompletePageError`, at most 5 pages (250 agreements), anything incomplete fails closed. It is a separate document from Q-RECONCILE so a connection that cannot be completed never invalidates the refund read.

**Attribution requires the agreement to be typed and reasoned (NEW-5).** A node counts as attribution for a refund only when `__typename === 'RefundAgreement'` **and** `reason === 'REFUND'` (the enum value exists, F19) **and** `refund.id` equals the refund **and** `app.id` equals the verified current app id. Any other `__typename` (including `OrderEditAgreement`, which MergeShip's own edits produce), any other `reason`, or a missing `refund` never counts. Which agreement types and reasons an app-created refund produces is itself unvalidated (Appendix E U5).

**Validation register (honest status of every query the subsystem depends on):**

| Document | Used by | Status | Evidence required to change the status |
|---|---|---|---|
| Q-APPID | attribution, reconciliation | **UNVALIDATED for Phase 2** (identical text is in use by Protocol v2) | Exact text run read-only on the dev store; sanitized response archived |
| Q-RECHECK | admission, R2 | **UNVALIDATED** | same, plus a measured `requestedQueryCost` |
| Q-RECONCILE (list) | baseline, adoption, verification, orphan audit | **UNVALIDATED** | same, against an order that holds an existing refund and one that holds none, **and against a MergeShip-cancelled secondary (F16)**; plus a measured cost |
| Q-REFUND-DETAIL (by id) | baseline classification, adoption, verification | **UNVALIDATED** | same, including that `nodes(ids:)` accepts Refund ids and that `duties { amountSet }` is valid; plus a measured cost |
| Q-AGREEMENTS | attribution | **UNVALIDATED** | same, plus G-AGREEMENT (12.8) including its controls; plus a measured cost |
| `@idempotent` directive introspection | S2 document form | **UNVALIDATED** | G-INTROSPECT result archived |
| Evaluator queries (`SHADOW_ORDER_QUERY`, `SHADOW_PREVIEW_QUERY`) | admission R1 | **Reported validated in code comments (`shipping-shadow.server.ts:172-175`); evidence not archived** (F10) | Archive under G-EVIDENCE |
| Fixtures for transaction statuses `PENDING`, `AWAITING_RESPONSE`, `FAILURE`, `ERROR`, `UNKNOWN` | S1 fixtures | **Schema-derived, not observed.** Real-gateway behavior is G-REAL | Observed only after G-REAL |

**Assumptions stated, not relied on:** list order is **not** assumed (the whole bounded list is scanned and the refund selected by marker); a refund list of 50 or more, or any `hasNextPage` not exactly `false`, means completeness is unproven and goes to `REVIEW_REQUIRED`; immediate consistency is **not** assumed (next section). S1 test fixtures for these documents follow the provenance rules of section 20.1.1: fixtures may start as **schema-derived** and are labelled as such, but the S1 *acceptance* of the reconciliation and recheck portions requires **archived** (sanitized real-response) fixtures for every response shape that can be observed on the development store; only shapes that cannot be observed before G-REAL remain schema-derived, on a reviewed allowlist.

### 12.2 Visibility lag versus contradiction

| Class | Examples | Handling |
|---|---|---|
| **Lag** (retry; evidence may simply not be visible yet) | Marker refund not yet in the list; refund visible but its `transactions` not yet listed; transaction `PENDING` or `AWAITING_RESPONSE`; aggregates not yet moved | Stay in the current state, re-read on the schedule |
| **Contradiction** (review now) | Marker refund with a different shipping amount, currency, parent, gateway or tax; marker refund whose `totalRefundedSet` differs from the planned amount, or that has duties; any `refundLineItems` on the marker refund; more than one transaction; two refunds with our marker; the recorded `refundId` differs from the marker refund; aggregates inconsistent with the sum of refund shipping lines; refund created outside the time window | `REVIEW_REQUIRED` with a specific reason code |
| **Failed settlement** | Transaction `FAILURE` or `ERROR` | `REVIEW_REQUIRED(SETTLEMENT_FAILED)`: Shopify records a refund but the gateway reported failure; the customer may not have been paid |
| **Unsupported status** | Any transaction status outside the closed allowlist (`SUCCESS`; pending class `PENDING`, `AWAITING_RESPONSE`; failed class `FAILURE`, `ERROR`) including `UNKNOWN` | `REVIEW_REQUIRED(UNSUPPORTED_TXN_STATUS)` |

Visibility windows: a row in `REFUND_RECORDED` whose own refund is still not visible 15 minutes after `respondedAt`, or whose transaction is not visible, goes to `REVIEW_REQUIRED(NOT_VISIBLE_AFTER_WINDOW)`.

**Attribution (N3) uses the same split:**

| Class | Examples | Handling |
|---|---|---|
| **Lag or unavailable** (retry) | Q-AGREEMENTS fails, is throttled, is incomplete (page budget exhausted, `pageInfo` malformed) or returns no `RefundAgreement` for the refund yet; Q-APPID fails | Row stays `IN_DOUBT` or `REFUND_RECORDED` and is re-read. **No adoption and no verification happen on an unattributed refund.** After the visibility window (15 minutes after `respondedAt`, or `dispatchedAt` + 24 hours for an `IN_DOUBT` row) the row goes to `REVIEW_REQUIRED(ATTRIBUTION_UNAVAILABLE)` |
| **Contradiction** (review now) | A `RefundAgreement` links the refund but its `app.id` is null or differs from the verified current app id; two agreements link the same refund; an agreement whose `refund.id` differs from the refund carrying our marker; an agreement `happenedAt` outside the timing window | `REVIEW_REQUIRED(ATTRIBUTION_MISMATCH)`, paged |

### 12.3 Adoption by marker, attribution and financial evidence (`IN_DOUBT` to `REFUND_RECORDED`)

**The marker alone is not proof of provenance.** A note is free text that anyone with access can copy, which is exactly the rule the repository already applies to merge evidence ("a copied `MS-<token>` mention is never provenance", `AGENTS.md`). Adoption therefore requires **app attribution through `RefundAgreement`** in addition to the marker and the financial evidence. All of the following must hold; otherwise the row is not adopted:

1. **Marker.** Exactly one refund on the secondary has a `note` containing the row's marker.
2. **Identity.** Its id is a valid Refund GID and is not attached to any other row (unique `refundId`).
3. **App attribution (N3, NEW-5).** From a **complete, bounded** Q-AGREEMENTS read, exactly one agreement with `__typename = 'RefundAgreement'` and `reason = 'REFUND'` has `refund.id` equal to that refund's id, and its `app.id` equals the **verified current app id** from Q-APPID. Missing, incomplete, unavailable or inconsistent agreements are handled by the attribution classes in 12.2: pending investigation or `REVIEW_REQUIRED`, never adoption and never a resend. **This condition is only in force once G-AGREEMENT is CONFIRMED (12.8): while the attribution status is `UNVERIFIED` the automatic path is disabled and rows go to `REVIEW_REQUIRED(ATTRIBUTION_UNVERIFIED)` at their window.**
4. **Amounts and currency.** Exactly one `refundShippingLines` entry with `subtotal == plannedShippingMinor`, `tax == 0`, in `currencyCode`; no `refundLineItems`; no `orderAdjustments`; no `duties`; **and the refund's own `totalRefundedSet` equals `plannedShippingMinor` in `currencyCode` (NEW-9 cross-check: it catches a duty, fee or store-credit component the line-level checks do not select).** The cross-check is a design requirement; whether Shopify reports `totalRefundedSet` this way is part of what G-READBACK validates.
5. **Allocation.** Exactly one transaction, `kind = REFUND`, `parentTransaction.id = parentTransactionId`, `gateway = gateway`, `amount == plannedShippingMinor`, in `currencyCode`.
6. **Timing.** `processedAt` (non-null) and the agreement's `happenedAt` fall within `[dispatchedAt - 5 minutes, now]`. `createdAt` is nullable: when it is non-null it must fall in the same window, and when it is `null` it is recorded as null and is **not** used as evidence of anything. The five minutes allow for clock skew between Shopify and the database.
7. **Baseline exclusion (NEW-1).** The refund is **not** one of the ids in `preEvidence.baseline.refunds`.

**What attribution proves, and what it does not.** At most, a matching agreement proves "created through this app installation". It does **not** prove that the dispatcher issued the refund: MergeShip's own `orderCancel` calls run under the same app and may produce agreements carrying the same `app.id` (F16). The proof of *this* refund is the conjunction of the unique marker, the refund-id link to a typed `RefundAgreement`, the exact financial match including the refund total, the timing window, and exclusion from the baseline. A matching agreement without the others is never adoption, and a positive attribution observation alone never certifies the attribution rule itself (12.8).

### 12.4 Verification (`REFUND_RECORDED` to `VERIFIED`)

One independent read-back must satisfy 12.3 (1)-(6) for the recorded `refundId` (including **app attribution through `RefundAgreement`**) **and** report the refund transaction `SUCCESS`. A refund whose attribution cannot be established is never `VERIFIED`.

**Aggregates are used only to detect anomalies, and only once the transaction is `SUCCESS` (N15).** A pending refund may not yet be counted in order aggregates (unverified assumption, section 22), so the aggregate comparison is not made while the transaction is `PENDING` or `AWAITING_RESPONSE`. Once it is `SUCCESS`, when our refund is the only refund **not in the baseline** (the expected case: the baseline had no financial refund and zero totals, 8.2.2), `totalRefundedShippingSet` and `totalRefundedSet` must each equal the planned amount (baseline totals were 0) and the order totals must be consistent; if other non-baseline refunds exist (for example a later merchant refund) the aggregate check is skipped and the presence is recorded as information.

- Transaction status `PENDING` or `AWAITING_RESPONSE`: stay `REFUND_RECORDED`; poll at 5 minutes, 1 hour and 6 hours, to a 72-hour horizon, then `REVIEW_REQUIRED(SETTLEMENT_TIMEOUT)`.
- Transaction status `FAILURE` or `ERROR`: `REVIEW_REQUIRED(SETTLEMENT_FAILED)`.
- `SUCCESS` means Shopify records a successful gateway refund transaction. **It is not proof that the customer's bank has received the funds**; that is unobservable and is a documented limit.

### 12.5 `IN_DOUBT` and the meaning of absence

**The absence of a marker is never proof that no refund exists.** It may be visibility lag, a read problem, a bounded list, or an edited note.

| Read-back finds | Action |
|---|---|
| Exactly one marker refund passing **every** condition of 12.3, including app attribution | Adopt, then verify |
| Exactly one marker refund, financial evidence matches, but attribution is missing, unavailable or incomplete | Not adopted. Stay `IN_DOUBT` and re-read (lag class); at the visibility window go to `REVIEW_REQUIRED(ATTRIBUTION_UNAVAILABLE)`. Never resend |
| Exactly one marker refund, financial evidence matches, but attribution contradicts (wrong or null app, duplicate or mismatched agreement) | `REVIEW_REQUIRED(ATTRIBUTION_MISMATCH)`, paged |
| Marker refund visible but incomplete (transactions missing) | Lag: stay `IN_DOUBT` until the window, then review |
| More than one marker refund | `REVIEW_REQUIRED(DUPLICATE_SUSPECTED)`, paged |
| One marker refund failing 12.3 | `REVIEW_REQUIRED(ANOMALY)` |
| No marker refund | Stay `IN_DOUBT`; re-read every 5 minutes for the first hour, then every 15 minutes. At `dispatchedAt + 24 hours` go to `REVIEW_REQUIRED(ABSENT_AFTER_WINDOW)`; the reason text states that absence is **not** proof that nothing was refunded |
| No marker refund, but a refund id **not in `preEvidence.baseline.refunds`** appeared, or a baseline record's fingerprint changed (`EXTERNAL_REFUND` is defined **relative to the baseline**, 8.2.5; the mere existence of refund records, or an unchanged baseline record, is not an external refund) | `REVIEW_REQUIRED(EXTERNAL_REFUND)` |
| Refund list 50 or more, or reads failing | Retry with backoff; the list size gives review; a row still `IN_DOUBT` after 7 days goes to review |

### 12.6 Human review and resolution

`scripts/shipping-refund-admin.ts review --id` prints the wire variables, hash, events, the latest read-back diffs and a recommendation. `resolve --id --resolution <r> --note --actor --confirm <hash prefix>` moves `REVIEW_REQUIRED` to `RESOLVED`:

- `VERIFIED_MANUALLY` requires a fresh passing read-back.
- `NOT_FOUND_ATTESTED`: the operator attests, after checking Shopify admin **and** the payment provider, that no refund exists. It is an attestation, never a system proof.
- `REFUNDED_MANUALLY` and `ACCEPT_ANOMALY`.

**No resolution reopens dispatch, and there is no automatic or operator retry of an ambiguous financial dispatch in v0.** A source whose refund did not happen is closed and the shipping is handled manually.

### 12.7 Protection against loss of local financial records (database restore or truncation)

A restore or bad truncation can erase the local record of a refund that was already sent. Defences, in order:

1. **Shopify-side guard (I16, NEW-1).** Admission requires the baseline of 8.2.2 (complete history, `refundedShipping = 0`, no previous monetary refund, baseline acceptable under `REFUND_BASELINE_MODE`) and R2 requires the refund set and aggregates to be **unchanged from the baseline**. A financial refund that exists in Shopify (in particular a refund with a transaction, a shipping line or our marker prefix) makes re-admission `INELIGIBLE` and makes a restored `PREPARED` row `ABORT` (or `REVIEW_REQUIRED` for our marker) at R2, regardless of what the local database says. After a restore the baseline is re-derived from Shopify, so a refund our lost row sent is itself a Financial refund and blocks. This is the final duplicate guard and is independent of local state.
2. **Epoch invalidation.** After any restore, dispatch is re-enabled only through the setter, which stamps a **new** `dispatchEnabledAt`. Every restored `EXECUTE` row has an older snapshot and aborts at T3.
3. **Orphan audit.** `shipping-refund-admin.ts audit-orphans --since <iso>` reads the recent cancelled secondaries of approved shops and reports, in three categories: **(a) HIGH:** any refund whose note carries the `MS-SHIPREFUND-` prefix; **(b) HIGH:** any refund attributed through `RefundAgreement.app.id` to our app that is a **Financial refund** (it has a transaction, a shipping line, an order adjustment, a duty or a non-zero total); in either case with no matching local row or in a different state; **(c) INFORMATIONAL, never an alert:** a refund attributed to our app whose shape is a zero-value, non-monetary record (a candidate cancellation-class record, 8.2.1), because MergeShip's own cancellations may legitimately produce them and flagging every merge would bury real findings. The agreement-based findings do not depend on the note surviving unedited. It is read-only.
4. **Restore runbook (a G-OPS requirement):** before a restore, stop dispatch (env unset and restart, or stop the process); after the restore, keep dispatch off, run `audit-orphans`, reconcile every row, and only then re-enable dispatch.
5. A restore drill, with backups and point-in-time recovery confirmed, is a G-OPS gate.

### 12.8 G-AGREEMENT: does an app-created refund actually produce the required agreement? (N3)

The attribution rule (12.3 condition 3) assumes that an app-created refund appears in `Order.agreements` as a `RefundAgreement` whose `app.id` is this app's id **and that this distinguishes it from refunds created by anyone else**. **Neither half is known.** The reference documentation lists `app` on `RefundAgreement` ("the application that created the agreement", nullable) but does not say it identifies the caller of `refundCreate` (F19). A positive observation alone is therefore worthless as a test: if `app.id` were always MergeShip's id on every refund (or on every refund of every creator), a positive match would "confirm" a rule that identifies nothing. Revision 3's experiment had no way to be wrong. The amended experiment has three controls and defines outcomes so that a positive match alone can never certify attribution.

#### 12.8.1 Required evidence items

| Item | What | Provenance requirement |
|---|---|---|
| **BASE** (baseline read) | Q-RECONCILE, Q-REFUND-DETAIL and Q-AGREEMENTS on at least one development-store secondary that **MergeShip itself cancelled** with Protocol v2 (`restock: true`, no refund). Record every refund record and every agreement: `__typename`, `reason`, `app.id`, `happenedAt`, and the refund shape (8.2.1). This settles F16 and shows whether MergeShip's own cancellations produce agreements carrying the app's id | read-only |
| **POS** (positive control) | A refund created through `refundCreate` **with MergeShip's own app credentials**, shipping-only in shape. Read back: exactly one agreement with `__typename = RefundAgreement`, `reason = REFUND`, `refund.id` equal to the refund, `app.id` equal to Q-APPID, and the financial evidence (amount, currency, parent, gateway, marker in the note) matching what was sent | The archive records **how the refund was created** (credentials and tool); a refund created in any other way does not count as POS |
| **NEG** (negative control) | A refund created **by a staff member in Shopify Admin** on a development-store order, of the same relevant type (shipping-only on a PAID test order, where Admin permits it; otherwise the closest shape, recorded as such). Read back the same documents. Expected for a discriminating rule: its `RefundAgreement.app` is **null or differs** from MergeShip's id | The archive records that it was created through the Admin UI by staff (role label only, no staff identity). A refund created with app credentials never counts as NEG |

All three use the same read-only documents, each by its recorded sha256 (section 17).

#### 12.8.2 Outcome definitions

- **CONFIRMED** requires **all** of: BASE recorded; POS satisfies every field above; **and** NEG shows `app` null or different from MergeShip's id; **and** the typed match (`__typename = RefundAgreement`, `reason = REFUND`, matching `refund.id`, `app.id`, financial evidence) holds for POS. **A positive match without a discriminating negative control is never CONFIRMED.**
- **NEGATIVE** if **any** of: POS has no agreement, or an agreement of another `__typename` or `reason`, or a null or different `app.id`; **or** NEG shows `app.id` equal to MergeShip's id (the rule cannot tell staff refunds from app refunds); **or** two agreements link one refund; **or** the agreement's refund id or financial evidence disagrees with what was sent.
- **INCONCLUSIVE** otherwise: for example POS present but no NEG; NEG present but no POS; provenance of any counted refund unrecorded or inferred; agreement lists incomplete (page budget exhausted); a document used differs from its recorded sha256; BASE not recorded.

#### 12.8.3 Parts, and when a mutation is needed

| Part | What | Kind |
|---|---|---|
| **A (read-only)** | BASE, plus POS and NEG **only if suitable refunds already exist** on the development store: refunds from experiments E1, E2 and E6 may serve as POS **if** the archive proves they were created with MergeShip's own credentials; any pre-existing staff-created Admin refund on a development-store order may serve as NEG. Run Q-APPID, Q-AGREEMENTS and the refund documents against them | read-only; no mutation |
| **A-NEG (separately approved, only if needed)** | If no suitable pre-existing staff refund exists for NEG, a **separately approved** experiment creates the negative control in Shopify Admin on a development-store test order. That is a state-changing action with a (test) financial effect; it requires its own approval and runbook, is **not performed by this revision or by S1 work**, and is never run on a production merchant | experiment, approval required |
| **B (inside G-E7)** | The first refund the dispatcher actually creates on the development store is read back with the same documents, with NEG still on record | uses the separately approved G-E7 refund |

#### 12.8.4 Required handling

- **CONFIRMED (A):** the attribution status constant becomes eligible to move to `CONFIRMED` through a reviewed change; B still gates S3.
- **INCONCLUSIVE (A):** S1 may be implemented and reviewed, but with the **attribution status `UNVERIFIED`**, a code constant (a parameter of the pure classifier; production wiring passes the pinned value; tests exercise both values). While `UNVERIFIED`, `IN_DOUBT -> REFUND_RECORDED` adoption and `REFUND_RECORDED -> VERIFIED` verification are **disabled**: those rows wait their window and then go to `REVIEW_REQUIRED(ATTRIBUTION_UNVERIFIED)`; no row is adopted or verified automatically. The adoption and verification code paths are still implemented and tested under the `CONFIRMED` value on fixtures labelled schema-derived. Moving the constant to `CONFIRMED` requires the CONFIRMED outcome recorded and a reviewed change. S2 acceptance depends on B being CONFIRMED; S3 cannot start before then. Under this handling nothing is accepted on the strength of an unproven rule.
- **NEGATIVE (A or B):** **stop.** The invariant is not weakened silently. A separately reviewed alternative provenance mechanism is required before S1 reconciliation is accepted (A) or before S3 (B). Until such an alternative is reviewed, the fail-closed behavior stands: the attribution status stays `UNVERIFIED`, automatic adoption is disabled, and every `IN_DOUBT` row ends in `REVIEW_REQUIRED` after its window and humans decide. Weaker alternatives (marker plus exact financial match only) are named here only so a reviewer can reject them; they are **not** approved.

#### 12.8.5 Reconciling archived responses with schema-derived fixtures

Section 20.1.1 defines fixture provenance. In short: S1 development may begin with schema-derived fixtures, but S1 **acceptance** needs archived real-response fixtures for every observable shape, and the attribution paths remain disabled (`UNVERIFIED`) until CONFIRMED. The earlier wording that allowed S1 reconciliation to be accepted on schema-derived fixtures when A is INCONCLUSIVE is replaced by the `UNVERIFIED` rule above.

---

## 13. Crash and recovery decision table

| Crash or failure point | Durable state | Next worker sees | Automated action | Forbidden |
|---|---|---|---|---|
| During claim | nothing, or `QUEUED` (atomic) | no row, or `QUEUED` | next scan claims | |
| `QUEUED`, during R1 | `QUEUED`, lease expiring | expired lease | re-lease, redo reads | |
| After T2, before T3 | `PREPARED` | expired lease | re-lease, R2, T3 | |
| Inside T3, before commit | `PREPARED` (rollback) | same | same | |
| **T3 commit acknowledgement unknown** | `PREPARED` or `DISPATCHING` | either | the process **does not send** (9.3). If `DISPATCHING`, the sweep moves it to `IN_DOUBT`; reads find nothing; review after 24 h | **any send** |
| After T3 commit, before or during the send | `DISPATCHING` | no response, lease may expire | after 120 s `IN_DOUBT`, read-back | any send |
| Shopify applied, response lost | `DISPATCHING` or `IN_DOUBT` | same | read-back adopts only with marker, financial evidence **and** app attribution (12.3); otherwise stays `IN_DOUBT` then review | any send |
| Response received, crash before T4 | `DISPATCHING` | same; refund id only in logs | adopt under the same 12.3 conditions | any send |
| T4 committed, before verification | `REFUND_RECORDED` | verify sweep | read-only verify | |
| Database unavailable at T4, process alive | `DISPATCHING` | | three in-process retries, then the rows above | |
| Two workers race at T3 | one winner | loser sees rowcount 0 | drop | |
| Worker resumes after its lease was taken over | newer owner | token mismatch | stop without writing | |
| Switch, opt-out, epoch or approval changes before T3 | `PREPARED` | gate inequality | `ABORTED(GATE_CHANGED)` | |
| Changes between T3 commit and the send | `DISPATCHING` | | the send proceeds (documented boundary); reconciler runs regardless of switches | |
| Deployment or SIGTERM | as above | | stop taking new rows; never abort an in-flight send | |
| `IN_DOUBT` older than 24 h | `IN_DOUBT` | | `REVIEW_REQUIRED(ABSENT_AFTER_WINDOW)` | any resend |
| Database restored | older state | stale `EXECUTE` rows | epoch invalidation, R2, audit (12.7) | dispatch before the restore runbook |

**Tradeoff accepted.** A crash or a lost commit acknowledgement between T3 and the send can leave a refund unsent and unresolved, ending in human review after 24 hours. Automatic completion of that single refund is permanently foregone, the customer is never refunded twice, and the merchant refunds manually. Writing a "send started" marker would not help: a crash after that write is equally ambiguous. A same-key status probe, which Shopify recommends, is prohibited in v0.

---

## 14. Concurrency and control interactions

| Threat | Control |
|---|---|
| Two refund workers | Conditional `PREPARED -> DISPATCHING` update (one winner); unique `(shop, sourceOrderId)`, key, marker, refund id; single unresolved dispatch globally (breaker) |
| Crashes, expired leases, process replacement | Leases give liveness only; after T3 the token and reconciliation by marker; sends only from the in-process permit |
| Duplicate merge events | `MergeRecord` is unique on `(shop, mergedOrderId)` and merges hold durable locks; execution is unique on `(shop, sourceOrderId)` |
| Merchant opt-out, uninstall, reinstall | Opt-in epoch clears or changes; approval validity breaks; gate snapshot differs; claims stop, T3 refuses, `PREPARED` rows abort. **For uninstall this holds only if `resetAutomationForUninstall` actually runs, and today it can be skipped (F15, N4).** See section 18.1 (N4): an independently reviewed fix is required before S3.5 and G-PILOT |
| Rollout removal, global switch off | Activation cutoff becomes null or changes; same effect |
| Admission or dispatch switch off, emergency stop | Section 4.8; reconciliation continues |
| Merchant-initiated refunds after evaluation | R2 re-evaluates; Shopify validates the amount against what is refundable; any refund not in the baseline (8.2.5) makes the row `ABORTED(REFUND_APPEARED)`; later refunds are recorded as information at verification |
| Refund-history truncation, inconsistent aggregates | Lists of 50 or more and any incomplete `pageInfo` are review; the list is reconciled with order aggregates |
| 24-hour idempotency retention | Nothing resends; `IN_DOUBT` older than 24 h goes to review |
| Delayed gateway settlement | `REFUND_RECORDED` is not `VERIFIED`; polling to 72 h then review |
| Multiple captures, split payments | Execution recheck requires exactly one successful capture and no other money transactions |
| Session expiry | Worker never refreshes; skips shops with under 30 minutes of token life |
| Restore | Section 12.7 |

Residual risk accepted: a merchant refund landing between R2 and the send is bounded by Shopify's own refundable-amount validation and by the caps.

---

## 15. Financial invariants

| # | Invariant |
|---|---|
| I1 | At most one `refundCreate` wire request per `ShippingRefund`, ever. |
| I2 | Every wire request is preceded by a durable `DISPATCHING` row holding the exact `wireVariables`, `wireHash`, `documentSha256`, key and marker. |
| I3 | Payload shape is fixed: shipping only, `fullRefund=false`, one `REFUND` transaction allocated to a verified successful `CAPTURE`/`SALE`, transaction amount equal to the shipping amount, no merchandise, no over-refund. |
| I4 | `plannedShippingMinor` is at most the discounted shipping paid, at most Shopify's maximum refundable, at most `approval.maxRefundMinor` (numeric comparison, I29), in the pinned currency. |
| I5 | No refund when a prior **financial** refund exists on the secondary (any refund with a transaction, a non-zero total, a shipping line, an adjustment, a duty or our marker prefix), when any shipping was previously refunded, or when refund history is truncated, unclassifiable or inconsistent. Whether non-monetary cancellation-class records are tolerated is governed by `REFUND_BASELINE_MODE` (8.2.3); the default `STRICT_EMPTY` tolerates none. |
| I6 | `VERIFIED` requires an independent read-back (12.3 and 12.4) with a `SUCCESS` refund transaction. |
| I7 | No automatic or operator resend of an ambiguous dispatch, under any key. |
| I8 | No money moves for a combine created before the dispatch cutoff; the gate is recomputed under locks and must equal the row snapshot at claim, freeze and T3. |
| I9 | The subsystem never writes or locks merge tables; refund outcomes never alter merge state. |
| I10 | Key, marker and refund id are each attributed to at most one row. |
| I11 | Per-refund, per-shop and global caps, currency pin, serial dispatch and breaker are enforced inside T3 under the exclusive control-row lock. |
| I12 | All timestamps use the database UTC clock. |
| I13 | Terminal states are immutable; frozen columns are immutable after their write-once point; transitions follow the graph; dispatch and response evidence can be stamped only by the transitions that own them (5.4.6). All trigger-enforced, with no test-reset or bypass switch reachable from runtime code. |
| I14 | Reconciliation is read-only toward Shopify and runs regardless of every switch. |
| I15 | The only Shopify mutation in the subsystem is the one pinned `refundCreate` document; its text has one export, imported only by the dispatcher. |
| **I16** | The Shopify-side guard is the final duplicate guard, independent of local database state: at admission the baseline of 8.2.2 holds (complete history, shipping refunded zero, no monetary refund, baseline acceptable under `REFUND_BASELINE_MODE`) and at R2 the refund set, fingerprints and aggregates are unchanged from `preEvidence.baseline`. It is defined against the stored baseline, not against an assumption that cancelled orders have no refund records (F16). |
| **I17** | `input.orderId = transactions[0].orderId = sourceOrderId`, and `sourceOrderId <> primaryOrderId`; the source is a `CANCEL_VERIFIED` secondary of the row's own operation. |
| **I18** | The wire request is exactly the pinned document plus the stored `wireVariables`; `wireHash` covers the document hash, the key and the input, and is recomputed at T3. |
| **I19** | A send happens only after an in-process T3 success observed by the same process; a `DISPATCHING` row never triggers a send. |
| **I20** | Approval is valid only while its recorded merchant opt-in epoch equals the live one and its `ackVersion` equals `REQUIRED_ACK_VERSION`. **I20 is conditional on N4:** it is only as strong as the guarantee that an uninstall clears the opt-in epoch, which holds today only when the webhook reaches the reset (F15). That is a precondition of S3.5 and G-PILOT, not of S1. |
| **I21** | Execution code never reads, updates, promotes or depends on `ShippingAdjustment`. |
| **I22** | The refund worker never refreshes offline tokens. |
| **I23** | An unknown T3 commit result means no send. |
| I24 | A row in lane `OBSERVE` is never executable; no dispatch-path status or dispatch field can exist on it. |
| I25 | A row is dispatchable only while the live `dispatchEnabledAt` equals the row's `dispatchEpochAtAdmission`. |
| I26 | **Provenance.** A refund is adopted or verified only when it is linked by a typed `RefundAgreement` (`reason = REFUND`) whose `app.id` equals the verified current app id **and** its marker, financial evidence (including the refund total), timing and baseline exclusion agree **and** the attribution status is `CONFIRMED` (12.8). The marker alone is never provenance, and a positive match without a discriminating negative control never confirms the rule. Unavailable, incomplete, inconsistent or unverified attribution fails closed to pending investigation or `REVIEW_REQUIRED`, never to a resend. |
| I27 | **S1 non-dispatch is database-enforced, by a mandatory trigger.** The S1 migration's transition-graph trigger has no `PREPARED -> DISPATCHING` edge and the insert trigger admits only `QUEUED`, `SKIPPED`, `INELIGIBLE` and `REVIEW_REQUIRED`; entering `DISPATCHING` requires the separate, separately authorized S2 migration. The trigger cannot be made optional (5.4) and a CHECK cannot substitute for it. |
| **I28** | **Dispatch-evidence integrity.** `dispatchToken` and `dispatchedAt` first become non-null only in a `PREPARED -> DISPATCHING` update; an insert carries no dispatch, response, settlement, refund, approval or wire evidence; a pre-dispatch terminal row can never carry dispatch evidence and therefore can never trip the breaker. |
| **I29** | **Numeric money comparison.** Text-stored money (`plannedShippingMinor`, `maxRefundMinor`) is compared only as parsed integers after a format check; a malformed value refuses the dispatch; lexicographic comparison is forbidden and architecture-tested. |
| **I30** | **Fixture isolation.** The only code that can suspend a trigger is the test-only fixture helper; it suspends only the named transition trigger, inside one transaction that re-enables and verifies it before commit; no runtime module can reach it (3.2 rules 10 and 11, 19.2). |

---

## 16. Merchant and product-facing policy (preconditions, not implemented in v0)

- **Merchant acknowledgement (G-MERCHANT).** Before any real-merchant pilot, the merchant must explicitly acknowledge that shipping is charged at checkout and refunded afterwards only if the combine completes and the refund is eligible; that refunds are not reversible by the app; the notification behavior; and any payment-fee consequences. The accepted text is versioned (`REQUIRED_ACK_VERSION`); changing the text bumps the version and invalidates all approvals.
- **Payment fees.** Gateways may not return processing fees on a refund, and a separate shipping refund may therefore carry a non-refundable fee. This must be verified per gateway during G-REAL and disclosed.
- **Customer notification.** `notify` is frozen to `false` (the payload shape reported validated by experiments E1/E2; evidence not yet archived, F10). Customers therefore receive no refund email; the refund appears on the order's timeline and on their payment statement. Changing this is PD1 and requires re-validating the payload and a migration.
- **Customer-visible effect.** The refund is recorded against a **cancelled** secondary order and appears on the customer's statement as a refund of that order. Merchant and customer communication is PD11.
- **Merchant UI and opt-in (N8).** None in v0. S1 creates **no** merchant opt-in path, and operators never opt a merchant in on their behalf; nothing in the app or its scripts calls `setShippingAdjustmentEnabled`. The opt-in (flag and epoch) arrives with G-MERCHANT, which precedes S3.5. Until then no real merchant has an approvable opt-in epoch, so an approval cannot be created for one (section 4.3).
- **Monitoring and recovery.** Status counts, the age of the oldest `DISPATCHING`, `IN_DOUBT` and `REFUND_RECORDED` rows, any `REVIEW_REQUIRED`, the breaker condition, and daily dispatch totals against caps are reported by a status CLI and a `[shipping-refund]` log prefix. The alert path and an on-call owner are G-OPS requirements.

---

## 17. Evidence archive (sanitized E0/E1/E2/E6 and later experiments)

The completed E0, E1, E2 and E6 evidence is outside the repository (F10). Before G-READBACK it is archived at `docs/evidence/shipping-v0/E<n>.json` with a `MANIFEST.sha256`.

**Retain per experiment (allowlist; write only these keys):**
- run metadata: experiment id, UTC timestamps, API version, application commit SHA, development-store handle, operator initials;
- the exact GraphQL documents as text with their sha256;
- sanitized variables: order, transaction and refund GIDs, amounts, currency, gateway name, `test` flags, idempotency key;
- full response bodies for the documented fields and read-back results with expected versus observed values and pass or fail;
- **for experiments that created a refund: how it was created** (which application credentials or which tool; Admin UI creation by staff is recorded as such, with a role label only, never a staff identity), because G-AGREEMENT (12.8) counts a refund as POS only if created with MergeShip's own app credentials and as NEG only if created by staff in Admin;
- **for every read-only query validation run (G-READBACK, G-AGREEMENT part A, G-INTROSPECT): the document's sha256, API version, development-store handle, UTC time, and pass or fail with the sanitized response.** A validation record for a document whose current sha256 differs from the recorded one is void;
- **for every document run under G-READBACK: the measured `requestedQueryCost` and `actualQueryCost` (and the per-field breakdown from `Shopify-GraphQL-Cost-Debug=1`) at its designed worst-case bounds** (12.1.2);
- **for the BASE read (12.8.1): every refund record and agreement present on a MergeShip-cancelled secondary**, with the fields listed there, so that `REFUND_BASELINE_MODE` can be finalized from evidence (8.2.3);
- **a fixture provenance tag** for every response later used as a test fixture (20.1.1): the experiment id, the document sha256 and the manifest hash it was derived from.

**Exclude, always:** access and refresh tokens, session rows, request and response headers, customer names, emails, addresses, phone numbers, customer GIDs, IP addresses, payment instrument details.

Rules: archive generation is allowlist-based, not denylist-based; the archive is **development-store data only** (never a production merchant); a reviewer verifies the manifest hashes before G-EVIDENCE passes. E3 (taxable shipping) and the real-gateway experiments will be archived the same way when they run.

---

## 18. Stages, gates and ordering

A production deployment automatically runs migrations (F9). **Any deployment of a build that contains new migrations migrates the production database, and therefore requires its own production-migration approval (G-MIGRATE-PROD).** Two accidental paths exist and both are covered:

1. **Merging into a deployed branch.** Stages S1 and S2 live on the feature branch only until G-MIGRATE-PROD passes. The pull request description must state that merging migrates production.
2. **A manual `railway up` (or any upload-and-build command) from a developer checkout.** It deploys the working directory regardless of which branch is checked out, and the container's `docker-start` then runs `prisma migrate deploy`. Operator rules until G-MIGRATE-PROD: never run `railway up`, `railway deploy` or an equivalent from a checkout that contains these migrations against the production service or its environment; confirm which branch and environment the production service tracks before any deployment; run migrations only against disposable databases.

**Residual effect of an accidental deployment.** An accidental S1 deployment would be inert: S1 contains no worker, no routes and no dispatcher; the control singleton is seeded fully off; there are no approvals; the environment flag is unset. Its only effect would be that the additive migration (and any earlier unapplied Phase 1 shipping migrations in the chain) is applied, which cannot be undone automatically. A candidate mitigation for G-MIGRATE-PROD to evaluate (not decided here, and a deployment-entry change needing its own review) is a pre-migration guard in `setup` that refuses to run when the pending migration set contains names outside an explicitly approved list. Operator action under that gate must also confirm which earlier migrations (including the existing Phase 1 shipping migrations on this branch) production has already applied.

| Order (relative sequence; numbers are not contiguous) | Stage or gate | Content |
|---|---|---|
| 0 | **G-P0** (hard S1 entry condition) | Phase 1.3 provisioning fixes (section 19.4). **No destructive database-backed test of any kind may run before G-P0 is complete**, including S1's own |
| 1 | **G0** | **Independent** review of the specification. **Status: CONDITIONAL GO for S1 (non-dispatch) on Revision 3; conditions C1 to C3 open (Appendix D).** The Revision 3 self-audit did not count. Revision 3.1 is the text delivered for C2/C3; it must be confirmed by a reviewer who did not write it |
| 2a | **S1 implementation** | Non-dispatch implementation (section 19), disposable databases only. May start only after steps 0 and 1 **and** the confirmation of C2/C3 (19.0) |
| 2b | **G-EVIDENCE**, **G-INTROSPECT**, **G-READBACK** (including the BASE read of a MergeShip-cancelled secondary and the query-cost measurements), **G-AGREEMENT part A** (with its controls) | Runs **in parallel with 2a**. Archive of E0/E1/E2/E6; read-only directive introspection; read-only validation of Q-APPID, Q-RECHECK, Q-RECONCILE, Q-REFUND-DETAIL and Q-AGREEMENTS on the approved development store; read-only attribution check on existing experiment refunds. All results recorded per section 17 |
| 2c | **A-NEG** (only if part A found no pre-existing staff refund) | A **separately approved** development-store experiment creating the G-AGREEMENT negative control (12.8.3). Not part of S1 and not performed by this document |
| 3 | **S1 review** | Independent review of S1. **The reconciliation and recheck portions (and the attribution rule) cannot be accepted until step 2b has passed** for the exact document texts S1 pins. A NEGATIVE G-AGREEMENT stops acceptance (12.8); INCONCLUSIVE is accepted only with the attribution status `UNVERIFIED` as stated there. `REFUND_BASELINE_MODE` is accepted only as `STRICT_EMPTY` unless the 8.2.3 amendment has been made |
| 6 | **G-E7** | Separately approved dev-store `refundCreate` experiment: variable-key acceptance, replay, parameter mismatch, concurrent request, error shapes, and **G-AGREEMENT part B** (the first app-created refund's attribution) |
| 7 | **S2** | Dispatcher, `DispatchPermit`, T3/T4, worker, the S2 migration; tested with fake Shopify and fault injection only. Includes the N5 and N12 changes (18.1) |
| 8 | **S2 review** | Independent review of S2 |
| 9 | **S3** | Controlled dev-store tests with Bogus Gateway on a disposable local database. Requires G-AGREEMENT part B CONFIRMED |
| 10 | **G-REAL** | Real-gateway validation: Shopify Payments (test mode) refund `PENDING`, failed and declined behavior where reproducible; refund transaction shapes; fee behavior |
| 11 | **G-GATEWAY-POLICY** | Separately reviewed change to the gateway and test-flag policy (a parameter on the evaluator or an execution-specific wrapper, defaulting to today's bogus-only behavior, with golden tests) |
| 12 | **S3b** | End-to-end dev-store run on the real gateway |
| 13 | **G-OPS** | Monitoring and alert path with an owner; emergency-stop drill; restore drill; confirmed backups and point-in-time recovery |
| 14 | **G-MERCHANT** | Opt-in UI, acknowledgement copy and version, payment-fee and notification disclosures |
| 14b | **G-UNINSTALL** (N4) | The reviewed uninstall fix of 18.1 with failure-injection tests. **Mandatory before S3.5 and before G-PILOT** |
| 15 | **G-MIGRATE-PROD** | Explicit approval of the production migration (including trigger and constraint behavior, both migrations, and the accidental-deployment paths above) |
| 16 | **S3.5** | Production observation: admission on, dispatch off. `OBSERVE` lane only; no refund can be sent |
| 17 | **G-PILOT**, **S4** | Written authorization of named shops, caps and duration; per-refund operator approval; per-shop and global caps; serial dispatch |
| later | **G-E3** | Taxable shipping accepted; required before any scope extension |

### 18.1 Later-stage fixes documented now and not implemented here

| ID | Required before | Requirement |
|---|---|---|
| **N4** | S3.5 and G-PILOT (G-UNINSTALL) | Make the uninstall opt-in invalidation **independent of the Partner API subscription cancellation**. Today `webhooks.app.uninstalled.tsx:27-38` calls `cancelSubscription` and only then `resetAutomationForUninstall`, and `partnerApiRequest` can throw (F15), so a failed cancellation can skip the reset and leave the opt-in epoch, and with it a stale approval, intact across a reinstall. The fix is narrow and separately reviewed: the reset runs first, or in a `finally`/independent step, so no failure of the billing call can skip it; a failure of the **reset itself** must make the webhook respond with an error so Shopify retries; the same reset may also revoke the shop's `ShippingExecuteApproval` as defence in depth (it must not become the only protection). Failure-injection tests: the Partner API call throws, returns a non-JSON body, returns an error status, has missing environment variables; the database reset fails once and then succeeds on retry; each leaves the shop with a cleared opt-in epoch after the delivery that completes. This touches accepted Phase 1 files and is therefore its own change |
| **N5** | S2 | Capacity waiting instead of aborting (sections 4.7, 8.4, 9.2): `PREPARED` bounded by the seven-day horizon, not 24 hours; capacity refusals wait without consuming `attempts`; only gate inequalities and the horizon abort |
| **N12** | S2 | The no-refresh session guard identifies the same session row the Shopify library loads (section 3.4, F12) |

**No real-merchant pilot may precede real-gateway acceptance.** The unmodified evaluator accepts only gateway `bogus` on `test=true` orders, so before G-REAL and G-GATEWAY-POLICY a real-merchant pilot could only produce ineligible rows. A quiet evaluator change to make it "work" is prohibited; the change is its own reviewed gate.

---

## 19. Stage S1: scope, exclusions and acceptance

### 19.0 Exact S1 entry conditions

S1 implementation work (any code, any destructive test) may begin only when **all** of the following are true:

1. **G-P0 is complete and independently confirmed**: all five Phase 1.3 provisioning fixes of section 19.4 are merged on the feature branch with their regression tests, and **no destructive database-backed test has been run since the last change to the provisioning or preflight helpers without passing them**. This is a hard condition: until it holds, S1 may write documents and pure (non-database) code only.
2. **G0 is signed off by a reviewer outside the session that wrote this specification, and C2 and C3 are confirmed by a reviewer outside the session that wrote Revision 3.1.** The independent review of Revision 3 returned CONDITIONAL GO; Revision 3.1 was written in the same session as that review, which therefore cannot confirm its own corrections. The Revision 3 self-audit does not satisfy this condition either. Until the confirmation is recorded (Appendix D), the verdict stays conditional.
3. The working branch is `feature/shipping-v0-recovery-v0` (or a branch cut from it) and **no S1 change is in, or queued for, a deployed branch** (section 18, accidental-deployment paths).
4. A freshly provisioned disposable database passes the Phase 1.3 preflight, with the operator token coming from the operator's shell, never from a committed value.
5. The Revision 3.1 query documents (section 12.1) are the starting text; G-READBACK may still be pending (it is required for S1 **acceptance**, section 18, not for starting). `REFUND_BASELINE_MODE` starts as `STRICT_EMPTY` and the attribution status starts as `UNVERIFIED`.

### 19.1 In scope

- **S1 migration** creating `ShippingExecuteControl`, `ShippingExecuteApproval`, `ShippingRefund`, `ShippingRefundEvent` with all constraints, indexes and the **mandatory** triggers of section 5 (transition graph and insert, frozen columns, shape, no-delete and no-truncate, event, evidence-integrity), the control singleton seeded off, and Prisma schema additions for the four models. Its transition trigger has **no `PREPARED -> DISPATCHING` edge** (section 5.4.1). No change to existing models.
- **The refund baseline** (8.2): capture at freeze, comparison at R2, `REFUND_BASELINE_MODE = STRICT_EMPTY`, and the cost-aware reconciliation documents (12.1.2). **The tolerant mode is not implemented in S1.**
- **The runtime trigger-integrity check** (3.2 rule 11) and the scanner liveness guards (7.2).
- **Execution controls**: setters for the control and approvals (own module; `setControl` untouched); the admin CLI commands for controls, approvals, status, show, approve-hash, review, resolve and `audit-orphans` (read-only).
- **Direct admission**: scanner, claim, lanes, outcomes, due-row processing, all per section 7.
- **Pure gates** and the **contract module** (document constant, `documentSha256`, `wireHash`, builders and validators).
- **Stores** with fenced writes and event logging; **preparation** (R1, execution recheck, freeze, `OBSERVED`, drift handling).
- **The query-documents module** (`shipping-refund-queries.ts`) with the section 12.1 documents, their pinned hashes and their (UNVALIDATED) status fields.
- **Read-only reconciliation** (classifiers, adoption **with `RefundAgreement` attribution**, verification, polling schedule, orphan audit) and **only the database transitions of the S1 rows of section 6.1**, applied to rows that already carry valid durable dispatch evidence. Such rows exist in S1 only as fixtures (section 19.2).
- Documentation updates to `docs/RUNBOOK.md` for the new controls, the emergency stop and the restore procedure.

### 19.2 Exclusions (must not appear in S1)

- No dispatcher, no `sendRefund`, no `DispatchPermit`, no T3 write-ahead function, no worker or timer, no `admin.graphql` mutation call, and no module that imports the mutation text accessor.
- **S1 cannot create, authorize or enter `DISPATCHING`** (N1). No S1 code path writes `status = 'DISPATCHING'` (the reconciliation writer's type excludes it, section 3.2 rule 7), no S1 code writes `REFUND_RECORDED` from a send response (that is T4, S2), and the S1 migration's transition graph has no `PREPARED -> DISPATCHING` edge, so even a hand-written update fails in the database. (The only exception is the single suspended-trigger transaction of the test-only fixture helper, 19.2.1, which can run only on a preflight-verified disposable database and is unreachable from `app/` and `scripts/`.)
- **Dispatched rows exist in S1 only as controlled fixtures, created by a narrowly scoped test-only mechanism (NEW-2).** Reconciliation tests need rows already in `DISPATCHING`, `IN_DOUBT` or `REFUND_RECORDED`. **`SET LOCAL session_replication_role = replica` is not used and is forbidden** (Revision 3 proposed it; it was rejected because `replica` mode suspends *every* ordinary trigger, including the shape, frozen-column, evidence-integrity, no-delete and event triggers and foreign-key enforcement, so a fixture could hold rows production can never produce; it also needs superuser-level privilege and leaves the connection in a weakened mode if misused outside a transaction). The mechanism is **section 19.2.1**.
- No change to Protocol v2, the shadow evaluator, `shipping-eligibility.ts`, `shipping-activation.ts`, `settings.server.ts`, `operation-store.server.ts` or any existing migration.
- No merchant-facing UI, no production database access or migration, no deployment, no merge into a deployed branch, no `refundCreate` call of any kind.

### 19.2.1 The fixture mechanism (test-only; NEW-2)

**Evaluation of the independent reviewer's proposal: adopted, with the additions below.** It is acceptable because PostgreSQL DDL is transactional: `ALTER TABLE ... DISABLE TRIGGER <name>` takes effect for other sessions only at commit and is undone by a rollback or a lost connection, and it requires only table ownership. It suspends **one named trigger**, so every other safeguard keeps running. It is acceptable only while the restoration can be proven; section 19.2.2 states what happens if it cannot.

**One helper, `tests/helpers/shipping-refund-fixture.ts`.** It creates a dispatched fixture in this order:

1. **Branded input.** It accepts only a `PreflightedDatabase` produced by `preflightDisposableDatabase` (the branded result that LOW-4 introduces; a class with a module-private constructor, so a hand-built object is rejected). The helper therefore cannot be written before LOW-4 exists.
2. **Same-connection verification.** Inside the fixture transaction, on the very connection that will run the DDL, it re-checks: `current_database()` equals the brand's database name and matches the disposable-name pattern; `inet_server_addr()` is loopback, unix or private; the database comment equals `mergeship-shadow-disposable:<token>` for the operator's `MERGESHIP_SHADOW_TOKEN`; `NODE_ENV` is not `production`; no `RAILWAY_*` variable is set; and the connected role owns `"ShippingRefund"`. Any failure aborts before any DDL.
3. **Legal creation.** It creates the row through the real store: insert as `QUEUED` (insert trigger live), then the real freeze to `PREPARED` (shape and frozen-column triggers live). It sets `SET LOCAL mergeship.actor = 'test-fixture'` so the event trigger records the actor.
4. **The one synthetic transition, in one transaction** (`lock_timeout` 2 s, `statement_timeout` 10 s):
   1. `LOCK TABLE "ShippingRefund" IN SHARE ROW EXCLUSIVE MODE` (so no other session can write during the window);
   2. `ALTER TABLE "ShippingRefund" DISABLE TRIGGER <the named transition trigger>`: that trigger only, never `ALL` or `USER`;
   3. **exactly one** `UPDATE ... SET status = 'DISPATCHING', "dispatchedAt" = <chosen instant, not before preparedAt>, "dispatchToken" = <uuid> WHERE id = $id AND status = 'PREPARED'`, asserting a row count of 1. The evidence-integrity, shape, frozen-column and event triggers stay **enabled** and run on this update; the evidence-integrity trigger allows it because it is exactly a `PREPARED -> DISPATCHING` update;
   4. `ALTER TABLE "ShippingRefund" ENABLE TRIGGER <the same named trigger>`;
   5. **verification:** the set of non-internal triggers on `ShippingRefund` and `ShippingRefundEvent` equals the expected set of section 5.4 **exactly** (no missing, no extra) and every one has `tgenabled = 'O'`; `current_setting('session_replication_role') = 'origin'`; the row is `DISPATCHING` with the intended evidence; exactly one event row exists for the transition, with actor `test-fixture`. Any mismatch **throws, rolling back the whole transaction** (including the disable and the update);
   6. commit.
5. **Everything after that is real.** `DISPATCHING -> IN_DOUBT`, `IN_DOUBT -> REFUND_RECORDED` (adoption), `-> VERIFIED`, `-> REVIEW_REQUIRED` and `-> RESOLVED` are driven through the real S1 reconciliation writer and the real trigger graph. `DISPATCHING -> REFUND_RECORDED` is an S2 transition (T4) and is **never fixtured**; a `REFUND_RECORDED` fixture reaches that state only through the S1 adoption path from `IN_DOUBT`.
6. **No other bypass.** The helper contains no other `DISABLE`, no `ALTER ... REPLICA`, no `session_replication_role`, no `TRUNCATE`, no `DELETE`. The helper records every SQL statement issued inside step 4; a test asserts the exact allowlist (the `LOCK`, the two `ALTER TABLE` statements for the named trigger, the one `UPDATE`, and read-only verification queries).

**Required tests (all against a real, preflight-verified disposable PostgreSQL; none against any other database):**

| Test | Proves |
|---|---|
| Refuses without the brand; refuses a forged plain object; refuses a database without the marker, with the wrong token, with a non-test name, a non-local server address, `NODE_ENV=production`, or any `RAILWAY_*` variable | It cannot run against production or an unverified database |
| **Failure injection at each point:** error after the lock; after `DISABLE`; after the update; after `ENABLE`; during verification; connection terminated (`pg_terminate_backend` from a second session) after `DISABLE` | After each, a **fresh connection** sees all triggers `tgenabled = 'O'`, the row still `PREPARED`, no event row, no dispatch evidence: nothing leaks out of the transaction |
| **Verification-failure test:** a test double makes the `ENABLE` a no-op | The verification step detects the still-disabled trigger and the transaction rolls back |
| **Concurrent-writer test:** a second session attempts a raw `PREPARED -> DISPATCHING` on another row during the window | It blocks on the lock and, once the helper finishes, **raises** (the trigger is back); a raw edge update is rejected after the helper returns |
| **Privilege tests:** run as a non-owner role without superuser: the helper fails with `insufficient_privilege` before writing anything; run as a superuser role: it still passes and its statement log contains no `session_replication_role` | It does not depend on, and does not use, superuser-level bypass; failure to obtain the needed privilege fails closed |
| Trigger-liveness during the update: `shape`, `frozen-column`, `evidence-integrity` and `event` triggers each reject a deliberately malformed variant of the fixture update | The helper does not weaken any safeguard other than the one named |
| Architecture tests (19.3 item 3) | No runtime module can reach it; the forbidden strings appear nowhere else |

### 19.2.2 If restoration cannot be guaranteed

If, after the failure-injection tests, restoration of the named trigger **cannot be demonstrated for every failure mode**, the helper above is **not shipped** and the bypass is **not broadened**. The safer alternative is **Fixture B**: reconciliation tests run on a scratch database (created by the branded `withScratchDatabase`, never the suite database, dropped as a whole afterwards) in which the transition function is replaced, by `CREATE OR REPLACE FUNCTION` executed inside that scratch database only, by a copy that additionally permits exactly `PREPARED -> DISPATCHING`: that is, a database in the state the S2 migration will produce, with no trigger ever disabled. Every other trigger and CHECK is identical. S1's own graph (the edge absent) is then proven on a different, untouched database by the non-dispatch tests of 19.3 item 4. The cost is that the later-transition tests run against a function that equals S1's graph plus one edge; that is accepted, and is strictly narrower than suspending a trigger.

### 19.3 Acceptance criteria

All must hold for S1 to be accepted. Items 1-12 and 14-18 are executable test or inspection checks; item 13 is the validation prerequisite.

1. The S1 migration applies cleanly to a **freshly provisioned disposable database** through the Phase 1.3 preflight, and every constraint and trigger test passes against real PostgreSQL.
2. All S1 tests in section 20 pass; `npm test`, lint and the build pass; `tsc` shows only the known pre-existing `shopify.server.ts` error.
3. The architecture tests pass: no `ShippingAdjustment` string or SQL (including a query-log assertion); the allowed-import list; no `Merge*` writes; no S1 module imports the mutation text accessor; no `DispatchPermit`, `sendRefund`, worker or timer exists; no `'DISPATCHING'` assignment in non-test sources under `app/` or `scripts/`; **`session_replication_role`, `DISABLE TRIGGER`, `DISABLE ALL`, `ENABLE REPLICA` and `ENABLE ALWAYS` appear nowhere under `app/`, `scripts/` or `prisma/migrations/`, and under `tests/` only in the fixture helper and the architecture test (NEW-2)**; the fixture helper is not imported from `app/` or `scripts/`; no non-test source references `setShippingAdjustmentEnabled`; every query document contains no `mutation` keyword and matches its pinned sha256; **no non-test source compares `plannedShippingMinor` or `maxRefundMinor` without a numeric cast (NEW-11)**.
4. **S1 non-dispatch proof (N1, NEW-3, NEW-6):** on a disposable database a raw `UPDATE ... SET status = 'DISPATCHING'` from `PREPARED` raises; the insert trigger rejects an insert in any post-dispatch status **and any insert carrying dispatch, response, refund, approval or wire evidence**; an update of a `QUEUED` or `PREPARED` row that sets `dispatchedAt` or `dispatchToken` (including a `QUEUED -> REVIEW_REQUIRED`, `PREPARED -> REVIEW_REQUIRED` or `-> ABORTED` update) raises; a `claimTerminal(REVIEW_REQUIRED)` row has no dispatch evidence and does not trip the breaker query; the reconciliation writer refuses a row without `dispatchedAt` and `dispatchToken`; every S1 reconciliation transition of section 6.1 succeeds only from its stated source status and fails otherwise; the migration test asserts the named triggers exist and are enabled and that the transition function contains no `PREPARED -> DISPATCHING` edge; `TRUNCATE` and `DELETE` on `ShippingRefund` and `ShippingRefundEvent` raise.
5. **Observation proof:** a combine admitted with dispatch off ends `OBSERVED` and can never be moved to `PREPARED` by any code or SQL path, including after dispatch is later enabled or after any control is cycled.
6. **Scanner non-starvation proofs:** 51 ineligible combines plus one eligible; a combine with more than 25 secondaries; transient failure exhaustion; concurrent scanners; **malformed `secondaries` values (non-array, element without a string `id`, element with a numeric, `null` or non-GID `id`) in one shop do not abort or stall the scan, and the malformed-operations report lists them (N10)**; **operations with a malformed `primaryOrderId`, or whose secondary `id` equals the primary, are excluded by SQL, listed by the report, and do not occupy the window (NEW-7)**; more than 50 operations rejected at claim by an injected constraint failure do not stop a later eligible operation from being reached within the page budget; the order-GID pattern is one string across the CHECKs, the scanner SQL and the validators.
7. **Transactional claim proofs (N9):** terminal claim outcomes write no row when the gate has closed or changed mid-claim; written rows carry an immutable snapshot; the SQL secondary-id pattern equals the CHECK pattern.
8. **Approval semantics proofs (N8, N11, NEW-4):** the approval setter refuses a shop without a live opt-in epoch; first approval, re-approval, `autoApprove` false to true, currency change and `ackVersion` change restamp `approvedAt` and invalidate earlier candidates; cap edits and `autoApprove` true to false do not restamp; a cap edit never revives a terminal row; **`approvedWireHash` can be recorded only on a `PREPARED` `EXECUTE` row and only equal to its `wireHash`; it cannot be recorded on a `QUEUED` row (no hash exists) or an `OBSERVED` row.**
9. **Database constraint proofs (N7, NEW-6, NEW-8, NEW-10, NEW-11):** the marker-in-note, cutoff-timestamp, derived-cutoff (`GREATEST`) and decimal-format CHECKs reject their violations; the `maxRefundMinor` format CHECK rejects `''`, `'01'`, `'-1'`, `'1e3'` and 41 digits; the event trigger writes exactly one event per status change and none for non-status updates; the event table's foreign key is `shippingRefundId`.
10. **Reconciliation proofs:** adoption, verification and every classification of sections 12.2-12.5 behave as specified on fixtures whose provenance satisfies 20.1.1, including `RefundAgreement` attribution (missing, incomplete, unavailable, mismatched, duplicate, **wrong `__typename`, wrong `reason`**); an unattributed refund is never adopted or verified; **with the attribution status `UNVERIFIED` no row is adopted or verified and rows end in `REVIEW_REQUIRED(ATTRIBUTION_UNVERIFIED)`**; adoption requires the refund total to equal the planned amount and the refund to be outside the baseline; no test or code path resends.
11. `git diff` of the accepted files listed in 19.2 is empty; existing Phase 1 shadow tests are unchanged and pass.
12. S1 is not merged into any deployed branch, no S1 build was deployed through any path (including `railway up`), and the PR description states that merging or deploying it migrates production (F9).
13. **G-READBACK and G-AGREEMENT part A have been completed for the exact document texts S1 pins** (section 18, step 2b), including the BASE read of a MergeShip-cancelled secondary, the query-cost measurements, and the archived fixtures required by 20.1.1. Until then the reconciliation and recheck portions of S1 are **not accepted**, whatever the tests show, because the documents they depend on are UNVALIDATED. A G-AGREEMENT outcome other than CONFIRMED leaves the attribution status `UNVERIFIED` (12.8.4).
14. **Refund baseline proofs (NEW-1):** a freeze stores `preEvidence.baseline` with the fields of 8.2.2; under `STRICT_EMPTY` any refund record gives `INELIGIBLE(PRIOR_REFUND_RECORD)`; prior refunded shipping, prior monetary refund, a `REFUND`-kind transaction, an unclassifiable record, 50 or more refunds and 11 or more refunds each fail closed; R2 aborts on a new refund id, a changed baseline fingerprint or changed aggregate; our marker prefix on a never-dispatched row gives `REVIEW_REQUIRED(UNEXPECTED_OWN_MARKER)`; `EXTERNAL_REFUND` fires only for ids outside the baseline (tested with a synthetic baseline of one unchanged record, which is ignored); the mode constant is pinned by a test and no tolerant predicate is present in S1 code.
15. **Waiting and horizon proofs (NEW-4):** a `QUEUED` row and a `PREPARED` row each wait without aborting and without incrementing `attempts` when the breaker is tripped, a cap is reached, or hash approval is missing, for longer than 24 hours of simulated time; each becomes `ABORTED(HORIZON_EXPIRED)` exactly when `DB_WALL > sourceCancelledAt + 7 days`; a gate inequality still aborts; the pre-freeze precheck consults only the breaker and daily caps.
16. **Fixture proofs (NEW-2):** every test of 19.2.1 passes, or Fixture B (19.2.2) is used and its own tests pass.
17. **Snapshot proofs (NEW-8):** the live gate check compares each individual epoch; two epoch vectors with the same maximum, and a clock regression that restores an equal maximum, both abort.
18. **Numeric-comparison proofs (NEW-11):** the cap comparison tests of 4.6.1 pass and the architecture test of item 3 passes.

### 19.4 Prerequisites (G-P0): known Phase 1.3 provisioning findings

These are **hard entry conditions for S1** (section 19.0, condition 1; independent condition **C1**), not optional follow-ups: **no destructive PostgreSQL test may run, S1's included, until all five are corrected and their regression tests pass, and the completion is independently confirmed.** They are low severity individually, but S1 adds many destructive tests and they all go through these helpers. **Status observed by the independent review at commit `ed8f566`: all five open** (`scripts/test-db-provision.ts:102-115` proceeds against an existing database and runs `migrate deploy` before the emptiness check; `:129` prints the full URL; `:114` and `tests/helpers/disposable-db.ts:148,152` build URLs by string replacement; `withScratchDatabase` takes a bare URL; `tests/disposable-db.test.ts` asserts `writes.length === 0` in only two refusal tests and its "outside schema" test accepts either error). The fixture helper of 19.2.1 additionally depends on LOW-4. Corrections to the Phase 1.3 acceptance-review findings:

| ID | Fix |
|---|---|
| LOW-1 | `scripts/test-db-provision.ts`: refuse when the target database already exists (provisioning only ever creates fresh databases; existing ones go through `shadow-db-bootstrap.ts`), so `migrate deploy` never runs against an unverified database |
| LOW-2 | Do not print the database password: parse the URL and clear `password` before printing |
| LOW-3 | Build database URLs by setting `URL.pathname`, not string replacement, in `test-db-provision.ts` and `tests/helpers/disposable-db.ts`, and re-run `assertSafeTestDatabaseUrl` on the result |
| LOW-4 | `withScratchDatabase` must require evidence that the preflight passed (a branded result) and verify the maintenance connection's server address and port against it |
| LOW-5 | Add the missing fail-before-write assertions (`writes.length === 0` on every refusal), reach the "misplaced tables" branch, and add a regression test that the preflight runs before the migration and that suites cannot stamp their own marker |

---

## 20. Test matrix

### 20.1 Required S1 tests

| Area | Cases |
|---|---|
| **Pure** | Cutoff definitions (max of epochs, null propagation); approval validity (revoked, opt-in epoch mismatch, ack version mismatch); lane decision; caps arithmetic; wire hash reproducibility and sensitivity (key, document hash, each input field); classifiers (read-back lag vs contradiction, status allowlist); golden snapshots pinning `evaluateShadowSource` and `assessSecondaryEvidence` outputs |
| **Real PostgreSQL: schema** | Trigger rejects every illegal transition (including `PREPARED -> DISPATCHING` itself under the S1 migration, anything into `DISPATCHING` from other than `PREPARED`, `IN_DOUBT -> DISPATCHING`, any exit from a terminal state, `QUEUED -> PREPARED` on an `OBSERVE` row, any update of an `OBSERVED` row); frozen and write-once columns; **JSONB CHECKs reject a malformed payload** (wrong order, two transactions, `fullRefund:true`, line items, wrong currency, key mismatch); shape trigger rejects extra keys; format CHECKs; `sourceOrderId <> primaryOrderId`; unique constraints; event table rejects update and delete; the control CHECK (`dispatchEnabled` implies `admissionEnabled`) |
| **Real PostgreSQL: admission** | SQL predicate excludes pre-epoch, deferred-cleanup and stopped-cleanup combines; **51 ineligible combines plus one eligible** reaches the eligible one; **a combine with more than 25 secondaries** completes in two scans; terminal rows never consume the allowance; **transient failures exhaust to `INELIGIBLE(EVAL_UNAVAILABLE)` and leave the window**; two concurrent scanners create exactly one row per secondary; claim recomputes the gate under locks (control change during claim gives no row); settle-delay and stale rules |
| **Real PostgreSQL: controls** | Observation: an `OBSERVE` row ends `OBSERVED`, cannot be advanced by any path, and does not become executable after dispatch is enabled; dispatch off then on stamps a new epoch and orphans older rows; **approval goes stale after uninstall, re-opt-in or reinstall** and after an `ackVersion` bump; per-shop and global caps defaults to zero; lock-order tests with `setControl` races (no deadlock); cap and breaker queries run after the lock |
| **S1 non-dispatch (N1)** | Raw `UPDATE` to `DISPATCHING` from `PREPARED` raises under the S1 migration; insert trigger rejects post-dispatch statuses; reconciliation writer refuses rows without `dispatchedAt` and `dispatchToken`; each S1 reconciliation transition (6.1) succeeds only from its source status; fixtures come only from the preflight-guarded helper and CHECKs still apply to them |
| **Scanner robustness (N9, N10)** | Malformed `secondaries` (non-array, `null`, scalar, element without `id`, numeric `id`, non-GID `id`) neither abort nor stall the shop's scan; malformed-operations report; SQL id pattern equals the CHECK pattern; terminal claim outcomes write no row when the gate closes mid-claim and carry immutable snapshots |
| **Approval edits (N8, N11)** | Setter refuses a shop with no live opt-in epoch; which edits restamp and which do not (4.3); a cap edit never revives a terminal row; no non-test source references `setShippingAdjustmentEnabled` |
| **Constraints (N7, N16)** | Marker-in-note, cutoff-timestamp and decimal-format CHECKs (accepts `0.50`, `12.00`, `300`; rejects `0.00`, `-1`, `1e2`, `01.5`, `1.23456`, `abc`); event trigger writes one event per status change (actor from `mergeship.actor`, `'unknown'` when unset) and none otherwise |
| **Attribution (N3)** | Adoption and verification require exactly one `RefundAgreement` for the refund with the verified app id; missing, incomplete (page budget exhausted), unavailable, wrong-app, null-app, duplicate and mismatched-refund agreements each give the specified handling; an unattributed refund is never adopted; Q-APPID failure is lag |
| **Query documents (N2, N6)** | Each document matches its pinned sha256 and contains no `mutation`; arrays are treated as arrays (no `pageInfo` assumption; length 50 or more is review); connections require `hasNextPage === false`; null `createdAt` is accepted and unused; `processedAt` drives the timing window; presentment amount and currency are both compared |
| **Isolation** | **Execution code never reads `ShippingAdjustment`** (source scan and query-log assertion); the import allowlist; no write statements against `Merge*` tables; a full merge-plus-admission run leaves merge tables untouched; the refund loop failing does not affect merges |
| **Existing shadow rows** | Pre-existing `ShippingAdjustment` rows have no effect on admission; `mode='SHADOW'` CHECK still holds |
| **Restore and truncation** | The local row is gone but Shopify (fake) holds a financial refund: re-admission gives `INELIGIBLE`; a restored `PREPARED` row aborts at R2 (fake) because the refund set differs from its baseline |
| **Read-back (seeded rows, fake Shopify)** | Lag (missing, then visible) does not go to review; contradictions do; adoption validates identity, amounts, currency, parent, gateway and timing; `PENDING`, `FAILURE`, `ERROR` and unsupported statuses are handled distinctly; absence never resolves; refund list of 50 or more goes to review; aggregate check is skipped when other refunds exist |
| **Session** | The worker never refreshes tokens; a shop with an expiring session is skipped |
| **Provisioning prerequisites** | Section 19.4 regression tests |
| **Operator CLI** | Dry-run default; `--apply` required; audit events written; `resolve` refuses without actor, note and hash confirmation |
| **Fixture isolation (NEW-2)** | Every test of 19.2.1 (brand and identity refusals, failure injection at each step, verification failure, concurrent writer, privilege, trigger liveness, statement allowlist), or Fixture B (19.2.2) |
| **Dispatch-evidence integrity (NEW-6)** | Insert with any dispatch/response/refund/approval/wire column raises; stamping `dispatchedAt` or `dispatchToken` outside `PREPARED -> DISPATCHING` raises; response evidence outside `DISPATCHING`/`IN_DOUBT`/`REFUND_RECORDED` raises; `claimTerminal(REVIEW_REQUIRED)` carries none and the breaker query ignores it |
| **Refund baseline (NEW-1)** | The cases of 19.3 item 14, including `EXTERNAL_REFUND` relative to a synthetic baseline and the mode-constant pin |
| **Waiting and horizon (NEW-4)** | The cases of 19.3 item 15 with a simulated clock |
| **Snapshot (NEW-8)** | Per-epoch equality; equal-maximum vectors; clock regression |
| **Numeric caps (NEW-11)** | The cases of 4.6.1, in application code and in SQL |
| **Truncate protection (NEW-10)** | `TRUNCATE` (also `CASCADE`) and `DELETE` on both journal tables raise; the event foreign key is `shippingRefundId` |
| **Query cost (NEW-9)** | Each document's bounds constant matches the bounds under which its cost was measured; the by-id detail refuses more than 5 ids per request and more than 2 requests per evaluation; the response validator rejects wrong length, missing, duplicate, non-matching and wrong-order ids |
| **G-AGREEMENT classifier (NEW-5)** | A pure function classifies a set of evidence items into CONFIRMED, NEGATIVE or INCONCLUSIVE; tests include positive-only (INCONCLUSIVE), positive plus negative control showing a different app (CONFIRMED), negative control showing our app id (NEGATIVE), unrecorded provenance (INCONCLUSIVE), wrong `__typename` or `reason` (NEGATIVE) |

#### 20.1.1 Fixture provenance (reconciling archived and schema-derived fixtures)

Every Shopify response fixture carries a provenance tag, asserted by a test: **`archived`** (derived from a sanitized response in `docs/evidence/shipping-v0/`, with the experiment id, the document sha256 and the manifest hash) or **`schema-derived`** (written from the 2026-04 reference documentation).

- **Development may start with `schema-derived` fixtures.** Tests built on them are valid for logic, but are not evidence that Shopify returns that shape.
- **S1 acceptance (19.3 item 13) requires `archived` fixtures** for every response shape that can be observed on the development store through read-only calls: the order and refund shapes, the empty and non-empty `refunds` arrays, the transaction shapes that exist, the agreement shapes seen in BASE/POS/NEG, `createdAt` null and non-null where observed, and the cost measurements.
- **Only shapes that cannot be observed before G-REAL may remain `schema-derived`**, and only if listed on a reviewed allowlist `SCHEMA_DERIVED_ALLOWED`: transaction statuses `PENDING`, `AWAITING_RESPONSE`, `FAILURE`, `ERROR`, `UNKNOWN` (register, section 12.1) and, while G-AGREEMENT is not CONFIRMED, the agreement shapes the attribution paths need. A test fails if a `schema-derived` fixture is used for a shape not on the allowlist, or if the allowlist changed without review.
- A fixture whose recorded document sha256 differs from the document now pinned is void and fails the test.

### 20.2 Required for S2 (specified now)

Wire-count test (exactly one request under 429, 503, connection reset, abort and timeout); injected lost commit acknowledgement at T3 sends nothing; the permit is single-use and expires; no send from a `DISPATCHING` row; N workers racing at T3 yield one dispatch and the caps hold; response classification table with fault injection (response dropped after apply, 5xx before apply, slow response, duplicate echo, user errors, malformed body, `PENDING`/`FAILURE` transactions, extra refund appears, two refunds with our marker); two-process crash at each row of section 13; document hash and `documentSha256` pin; template-fallback rendering test if the fallback is chosen; **N5/NEW-4:** a tripped breaker, a reached cap or a missing hash approval leave the row waiting with `attempts` unchanged for longer than the old 24 hours and the row still dispatches once capacity returns, while a gate inequality or a changed baseline aborts it; `QUEUED` and `PREPARED` rows abort only at the seven-day horizon; **N12:** two offline-looking session rows for one shop, the guard follows the library's `getOfflineId` lookup; the S2 migration test shows `PREPARED -> DISPATCHING` is accepted only after it is applied.

### 20.3 Dev-store sequence (S3)

Happy path; crash at each point using injected hooks; response lost through a local forwarding proxy that applies the request but drops the response; two workers racing; switch, opt-out and approval changes mid-flight; a manual merchant refund before dispatch; a prior shipping refund; taxed shipping (confirm refusal only); split payment, gift card and multiple captures; caps and breaker.

---

## 21. Migration safety and deployment sequencing

- **S1 migration**, `…_shipping_refund_execution`: additive. It creates only new objects and seeds the control singleton fully off. It touches no existing table, so it cannot affect merging. Its transition trigger deliberately omits `PREPARED -> DISPATCHING`.
- **S2 migration**, `…_shipping_refund_dispatch_edge`, created and reviewed with S2 and **separately authorized**: replaces **only** the transition-graph trigger function to add that single edge. It adds no table, changes no data and touches no other trigger or CHECK (in particular not the evidence-integrity trigger). It does not exist in S1 and no S1 artifact may stand in for it.
- The migration is tested on disposable databases only, through the Phase 1.3 preflight. A migration test confirms the triggers and constraints on a fresh database.
- **Production deployments run migrations automatically (F9), by a merge into a deployed branch or by a manual `railway up`.** Therefore: S1 and S2 stay on the feature branch; no merge into a deployed branch and no manual upload-and-deploy happens before G-MIGRATE-PROD; the pull request must say so; the approval covers the exact migration chain pending for production, including the existing Phase 1 shipping migrations if not yet applied, and both Phase 2 migrations if the build contains them. The operator rules and the inert-if-accidental analysis are in section 18.
- After a production migration the feature remains inert: control off, no approvals, no environment flag. Code rollback is safe because the tables are additive and unused when the controls are off.

---

## 22. Unresolved experiment and release gates

| Gate | What it resolves |
|---|---|
| G-EVIDENCE | E0/E1/E2/E6 evidence archived (section 17) |
| G-INTROSPECT | Read-only introspection confirming the `@idempotent` directive's `key: String!` argument and field location in 2026-04 |
| G-READBACK | Read-only validation of Q-APPID, Q-RECHECK, Q-RECONCILE, Q-REFUND-DETAIL and Q-AGREEMENTS (section 12.1), each by its exact text and sha256, on the approved development store. Confirms the array-versus-connection shapes, `nodes`/`pageInfo` handling, nullable `createdAt`, `processedAt`, presentment money, `RefundAgreement` selection, that `nodes(ids:)` accepts Refund ids and `duties { amountSet }` is valid, and **records `requestedQueryCost` and `actualQueryCost` for every document at its worst-case bounds (acceptance threshold 500, 12.1.2)**. **Must also read a MergeShip-cancelled secondary (the BASE item of 12.8.1) and archive exactly what the `restock: true` cancellation left (F16)**, which is the evidence for finalizing `REFUND_BASELINE_MODE` (8.2.3). **Mandatory before S1's reconciliation and recheck portions are accepted** |
| G-AGREEMENT | Amended (NEW-5), section 12.8: BASE read, POS control, NEG control, typed match (`__typename = RefundAgreement`, `reason = REFUND`), and the CONFIRMED / NEGATIVE / INCONCLUSIVE definitions in which a positive match alone never confirms. Part A (read-only, using pre-existing refunds where suitable) is mandatory with G-READBACK before S1 acceptance; if no pre-existing staff refund exists, **A-NEG** (a separately approved experiment) creates the negative control; part B (inside G-E7): first dispatcher-created refund, mandatory before S3. NEGATIVE stops the design pending a separately reviewed alternative; anything short of CONFIRMED leaves the attribution status `UNVERIFIED` |
| G-UNINSTALL (N4) | The reviewed uninstall fix and failure-injection tests (section 18.1). Mandatory before S3.5 and G-PILOT |
| G-E7 | Approved dev-store `refundCreate` experiment: variable-key acceptance, replay behavior, parameter mismatch, concurrent request, and the actual shape of idempotency errors (`userErrors` versus top-level) |
| G-REAL | Real-gateway refund behavior: `PENDING`, failed and declined refunds, transaction shapes, fees |
| G-GATEWAY-POLICY | Reviewed relaxation of the bogus-only policy |
| G-E3 | Taxable shipping (kept restricted: tax-bearing and tax-inclusive orders remain `INELIGIBLE`) |
| G-OPS, G-MERCHANT, G-MIGRATE-PROD, G-PILOT | Section 18 |

Standing unverified assumptions: the full register is **Appendix E**. In summary: whether the proposed queries run as written and within the cost limit (all UNVALIDATED, section 12.1); whether Shopify records a refund for a restocking cancellation and what it looks like (F16, BASE); whether an app-created refund produces a `RefundAgreement` with the app id and whether that distinguishes it from staff refunds (G-AGREEMENT); whether a refund `note` is returned verbatim and immutable (G-READBACK); whether pending refunds are counted in order aggregates (aggregates are therefore anomaly-only); how Shopify throttling interacts with an in-flight refund (any throttled response goes to `IN_DOUBT`, which at pilot volume means rare manual work).

---

## 23. Product decisions required

| ID | Question | Default until decided |
|---|---|---|
| PD1 | Notify the customer by email (`notify`)? | `false` (payload shape from experiments E1/E2, evidence not yet archived); changing needs payload re-validation and a migration |
| PD2 | Payment-fee disclosure wording and who bears the fee | None; resolved during G-REAL and G-MERCHANT |
| PD3 | Where the merchant acknowledgement is stored once the UI exists (new `Settings` columns versus the approval row) | Operator-recorded `ackVersion` on the approval |
| PD4 | May an operator re-admit a never-dispatched `ABORTED` or `INELIGIBLE` source? | No re-admission in v0 |
| PD5 | Who resolves `REVIEW_REQUIRED` rows, within what time, and through which alert channel | G-OPS must name an owner |
| PD6 | In-process loop versus a separately stoppable service | In-process |
| PD7 | Pilot caps, shops and duration | All caps zero until set |
| PD8 | Merchant visibility of refund status | None in v0 |
| PD9 | Whether global serialization relaxes to per-shop after the pilot | Global |
| PD10 | A policy epoch if `RETAIN_FIXED` ever becomes merchant-settable | `RETAIN_FIXED` stays refused |
| PD11 | Customer and merchant communication about a refund recorded against a cancelled order | None in v0 |
| PD12 | Which alternative provenance mechanism to adopt if G-AGREEMENT is NEGATIVE (12.8) | None approved: automatic adoption stays disabled and every `IN_DOUBT` row ends in review |

**None of these decisions blocks S1.** Every one has a conservative default that is safe to leave in place (notify off, no re-admission, caps at zero, in-process worker, operator-recorded acknowledgement version, global serialization, no automatic adoption without attribution). They block only the stage named in their row (mostly G-MERCHANT, G-OPS and G-PILOT).

---

## Appendix A: review findings mapped to this specification

| Finding | Severity | Resolution | Section |
|---|---|---|---|
| B1 Production admission impossible via shadow rows | BLOCKER | Shadow dependency removed; direct admission from `MergeOperation`; execution never touches `ShippingAdjustment` | 1, 3.2, 7 |
| H1 Constant document versus literal key; hash scope | HIGH | Constant document with `$idempotencyKey`; `wireHash` over document hash, key and input; template fallback; `code` not selected | 10 |
| H2 Gate order; real-gateway before real pilot | HIGH | Corrected order; G-REAL and G-GATEWAY-POLICY precede any real-merchant pilot; G-MERCHANT, G-MIGRATE-PROD, S3.5 added | 18, 22 |
| H3 Admission scanner unspecified | HIGH | Exact SQL, caps, outcomes, claim, progression guarantees | 7 |
| M1 Read-back consistency assumptions | MEDIUM | Lag versus contradiction; adoption validation; aggregates anomaly-only; closed status allowlist | 12 |
| M2 Lost T3 commit acknowledgement | MEDIUM | Explicit no-send rule, permit, crash row | 9.3, 13 |
| M3 Worker and session refresh race | MEDIUM | In-process worker; never refreshes tokens; 30-minute margin | 3.4, I22 |
| M4 Approval survives uninstall/reinstall | MEDIUM | Approval bound to merchant opt-in epoch and ack version | 4.3, 4.4, I20 |
| M5 Missing payload constraints | MEDIUM | JSONB CHECKs, shape trigger, format CHECKs | 5.3, 5.4 |
| M6 Deployment migrates production | MEDIUM | G-MIGRATE-PROD; stages stay on the feature branch | 18, 21, F9 |
| M7 No production observation phase | MEDIUM | Separate admission and dispatch switches and epochs; `OBSERVE` lane; S3.5 | 4.2, 4.5, 18 |
| L1 Re-freeze complexity | LOW | Removed; drift aborts | 6, 8.4 |
| L2 Mutable breaker | LOW | Computed from authoritative rows | 4.7 |
| L3 Lease versus slow reads | LOW | 180 s lease, renewed between reads | 9.1 |
| L4 Resolution wording | LOW | `NOT_FOUND_ATTESTED` | 12.6 |
| L5 Mixed clocks in settle delay | LOW | Stated as skew-tolerant (15 minutes against a five-minute skew allowance); timing windows use a five-minute allowance | 7.1, 12.3 |
| L6 Coarse caps | LOW | Per-shop caps on the approval; global count cap on the control | 4.2, 4.3, 4.6 |
| L7 Local record loss | LOW | Shopify-side guard, epoch invalidation, orphan audit, restore runbook | 12.7, I16 |

### Correction checklist items (S1-tagged and others)

| Checklist item | Section |
|---|---|
| [S1] B1: direct admission; remove `shadowAdjustmentId`; architecture test for `ShippingAdjustment` | 3.2, 5.1, 7, 20.1 |
| [S1] H3: scanner SQL, 25-per-combine cap, terminal outcomes, `INELIGIBLE` | 6, 7 |
| [S1] M7: split admission and dispatch controls with epochs; T3 dispatch-epoch check | 4.2, 4.4, 4.5, 9.2 |
| [S1] M4: approval bound to opt-in epoch and ack version; per-shop caps | 4.3, 4.4, 4.6 |
| [S1] M5: JSONB, identifier-format and state constraints | 5.3, 5.4 |
| [S1] M6: disposable-only S1, not merged to a deployed branch | 18, 19.2, 21 |
| [S1] L1, L2: remove re-freeze; computed breaker | 4.7, 6 |
| [S1] I16-I23 and tests | 15, 20.1 |
| [S2] H1: constant document, `wireHash`, no `code`, template fallback | 10 |
| [S2] M2: lost-commit row | 9.3, 13 |
| [S2] M3: in-process worker, no token refresh | 3.4 |
| [S2] M1: lag versus contradiction; adoption validation | 12 |
| [S2] L3, L4, L5 | 9.1, 12.6, Appendix A |
| [Gates] H2: corrected order, G-MERCHANT, S3.5, evaluator change as its own gate | 18 |
| [Gates] Archive sanitized E0/E1/E2/E6 evidence | 17 |
| Phase 1.3 LOW provisioning fixes as prerequisites | 19.4 |

## Appendix B: G0 self-audit findings N1-N16, closure table (Revision 3)

This table is the **Revision 3 self-audit record**, kept unchanged in substance. The independent G0 review found N1, N3, N5 and N10 only **partially** closed and N2/N15/N16 with notes; those residuals are NEW-1 to NEW-11 and are addressed in Appendix C. Where Appendix B and Appendix C disagree, Appendix C governs.

"Required at" is the first stage or gate that must have the item done. "Documented" means this revision specifies it; "implemented" is always a later stage.

| ID | Severity | Change made in this revision | Sections | Required at |
|---|---|---|---|---|
| N1 | MEDIUM | S1 cannot create, authorize or enter `DISPATCHING`. S1 may perform only read-only Shopify reconciliation and the listed database transitions for rows that already carry durable dispatch evidence (`dispatchedAt`, `dispatchToken`); such rows exist in S1 only as preflight-guarded fixtures. The S1 migration's graph lacks `PREPARED -> DISPATCHING` (S2 migration adds it); the writer is typed to exclude it; CHECKs make post-dispatch statuses require dispatch evidence. Sections 19.1, 19.2 and the acceptance tests are consistent | 3.2.7, 5.3, 5.4.1, 6.1, 19.1-19.3, 20.1, I27 | **S1** |
| N2 | MEDIUM | Complete proposed query documents added (Q-APPID, Q-RECHECK, Q-RECONCILE, Q-AGREEMENTS), all labelled UNVALIDATED with a validation register; **G-READBACK moved ahead of accepting S1 reconciliation** (parallel with S1 implementation, mandatory before S1 acceptance) | 12.1, 18, 19.3 item 13, 22 | **S1 acceptance** |
| N3 | MEDIUM | `RefundAgreement` app attribution required for adoption, verification and the orphan audit; marker alone is not provenance; unavailable or inconsistent attribution fails closed; read-only G-AGREEMENT experiment (part A) plus part B inside G-E7; NEGATIVE requires a separately reviewed alternative | 12.2-12.5, 12.7, 12.8, I26 | **S1 acceptance** (part A); S3 (part B) |
| N4 | MEDIUM | Documented the skip hazard in the uninstall webhook (F15) and the narrowly reviewed fix with failure-injection tests; reset independent of the Partner API call; I20 marked conditional on it | F15, 14, 15, 18.1, 22 | **Before S3.5 and G-PILOT** |
| N5 | MEDIUM | `PREPARED` bounded by the seven-day horizon, not 24 hours; capacity conditions (breaker, caps, approval pending) wait without aborting and without consuming `attempts`; T3 refusal classes; capacity precheck before R2 reads. The 24-hour `STALE_PREPARED` abort is removed | 4.7, 8.4, 9.1, 9.2, 18.1 | **S2** (the horizon change is also stated for S1) |
| N6 | LOW | Arrays versus connections stated and applied in every document: `Order.refunds` and `Order.transactions` arrays with a "50 or more" rule; `Refund.*` connections with `nodes`/`pageInfo`; nullable `createdAt` not used as evidence; `processedAt` for timing; `orderAdjustments` must be empty; presentment amount and currency compared | 12.1, 12.3 | **S1 acceptance** |
| N7 | LOW | Added CHECKs: marker inside the note, cutoff timestamps (`operationCreatedAt` against the admission cutoff and the dispatch epoch, non-null snapshots), positive-decimal amount format, dispatch-evidence preconditions | 5.3, 20.1 | **S1** |
| N8 | LOW | S1 adds no opt-in path; operators never opt merchants in; approval setter only reads the live epoch and refuses when it is null; scan test for `setShippingAdjustmentEnabled` | 4.3, 16, 19.3, 20.1 | **S1** |
| N9 | LOW | Terminal claim outcomes are written in the claim transaction with a fresh gate check and an immutable snapshot (`claimTerminal`); no row when the gate closed | 7.3, 7.5, 19.3 item 7 | **S1** |
| N10 | LOW | Scanner SQL guards non-array `secondaries` and malformed elements (including an id pattern identical to the CHECK pattern); bounded malformed-operations report and monitoring log; tests | 7.2, 19.3 item 6, 20.1 | **S1** |
| N11 | LOW | Approval-edit semantics: first approval, re-approval, `autoApprove` enable, currency or ack change restamp `approvedAt`; cap edits and `autoApprove` disable do not and never revive terminal rows | 4.3, 19.3 item 8 | **S1** |
| N12 | LOW | No-refresh session guard must use the library's `getOfflineId` lookup, not `findFirst` (F12); test with two offline-looking rows | 3.4, 18.1 | **S2** |
| N13 | LOW | `wireHash` clarified as covering the canonical semantic request; transport bytes are not compared | 10.2 | text only (this revision) |
| N14 | LOW | G-P0 made a hard S1 entry condition (no destructive test before it); `railway up` and any upload-and-build deployment path added alongside branch merges, with operator rules and an inert-if-accidental analysis | 18, 19.0, 19.4, 21 | **S1 entry** |
| N15 | LOW | Aggregate anomaly check made only once the refund transaction is `SUCCESS`; skipped while `PENDING` or `AWAITING_RESPONSE` | 12.4 | **S1** |
| N16 | LOW | Incorporated in minimal form: an `AFTER INSERT OR UPDATE` trigger writes the event row (status, time, actor from `mergeship.actor`); evidence stays on the row; events carry no payload and the store never inserts events | 5.2, 5.4.5, 4.9, 20.1 | **S1** |

## Appendix C: independent G0 findings NEW-1 to NEW-11, closure matrix (Revision 3.1)

Findings are those of the independent G0 review of Revision 3 (CONDITIONAL GO, no BLOCKER or HIGH). **"Specified" means this revision states the rule in text. It does not mean the finding is closed:** closure of C2 and C3 needs confirmation by a reviewer who did not write Revision 3.1 (Appendix D). No row below claims Shopify behavior is validated.

| ID | Severity | Revision 3.1 change | Sections | Stage that implements it | Experimental dependency | Status |
|---|---|---|---|---|---|---|
| NEW-1 | MEDIUM | The "refund list is empty" premise is withdrawn as unverified (F16, F17). Refund records are classified (baseline candidate / financial / unclassifiable); the baseline (ids, fingerprints, aggregates) is stored in `preEvidence`; zero prior refunded shipping, complete history and no prior monetary refund are required; R2 detects change before T3; `EXTERNAL_REFUND` and the restore guard are defined relative to the baseline; the orphan audit separates financial from informational records. `REFUND_BASELINE_MODE = STRICT_EMPTY` (fail closed) until evidence finalizes the rule, or deletes the tolerant mode | F16, F17, 8.2, 8.3, 12.2-12.5, 12.7, I5, I16, 19.3 item 14 | S1 implements baseline capture/compare under `STRICT_EMPTY`; finalization (8.2.3) is a reviewed amendment before S3.5 | **G-READBACK BASE read** of a MergeShip-cancelled secondary (U4) | Specified; confirmation pending; **rule stays `STRICT_EMPTY` until the evidence exists** |
| NEW-2 | MEDIUM | `session_replication_role = replica` removed and forbidden. Replacement: one test-only helper, branded preflight input, same-connection identity and marker verification, legal QUEUED/PREPARED creation, one transaction that disables **only** the named transition trigger, makes one synthetic update, re-enables, verifies all triggers, then commits; every other trigger stays live. Required failure-injection, rollback, privilege and trigger-restoration tests. Fixture B is the specified fallback if restoration cannot be proven. Runtime trigger-integrity check | 3.2 rules 10-11, 5.4, 19.1, 19.2, 19.2.1, 19.2.2, 19.3 items 3 and 16, 20.1, I30 | S1, **only after LOW-4 (G-P0)** | none | Specified; confirmation pending |
| NEW-3 | MEDIUM | All language making trigger 1 optional is removed. The transition-graph and insert triggers are mandatory; a CHECK cannot replace them; the S1 graph has no `PREPARED -> DISPATCHING`; only a separately authorized S2 migration, replacing only that function, may add it | 5.4, 5.4.1, 9.2, 21, I27 | S1 (graph), S2 (edge) | none | Specified; confirmation pending |
| NEW-4 | MEDIUM | Circularity removed. Order: freeze, then operator hash approval, then capacity precheck, then fresh evidence (R2), then T3. The pre-freeze precheck covers breaker and daily caps only. The seven-day horizon applies to `QUEUED` and `PREPARED` rows via the new immutable `sourceCancelledAt`. Capacity and approval waits never consume `attempts` | 4.6, 4.7, 5.1, 5.3, 7.4, 8.4, 9.1, 9.2, 19.3 items 8 and 15 | S1: horizon, `sourceCancelledAt`, freeze order; S2: capacity waits, approval flow, T3 | none | Specified; confirmation pending |
| NEW-5 | MEDIUM | G-AGREEMENT amended: BASE read, POS control, NEG control (staff refund in Admin), typed match (`__typename = RefundAgreement`, `reason = REFUND`), CONFIRMED/NEGATIVE/INCONCLUSIVE defined so that a positive match alone never confirms. Pre-existing staff refund keeps part A read-only; otherwise a **separately approved** A-NEG experiment (not performed). Anything short of CONFIRMED leaves attribution `UNVERIFIED` (adoption/verification disabled). Archived-versus-schema-derived fixture rules reconciled | 12.3, 12.8, 17, 19.3 items 10 and 13, 20.1, 20.1.1, 22, I26 | S1 acceptance (A, with controls); S3 (B) | **G-AGREEMENT A, A-NEG (if needed), B** (U5) | Specified; confirmation pending |
| NEW-6 | LOW | Dispatch evidence can first become non-null only in a `PREPARED -> DISPATCHING` update (new evidence-integrity trigger, separate from the transition trigger); inserts carry no dispatch, response, settlement, refund, approval or wire evidence; terminal pre-dispatch rows cannot trip the breaker | 5.3, 5.4.1, 5.4.6, 6.1, I28, 19.3 items 4 and 9 | S1 | none | Specified; confirmation pending |
| NEW-7 | LOW | Scanner SQL requires a valid `primaryOrderId`, a string, valid secondary GID and `secondary <> primary`; one shared `ORDER_GID_PATTERN`; keyset paging (4 pages), per-secondary claim isolation, expanded malformed-operations report and tests | 5.3, 7.2, 19.3 item 6, 20.1 | S1 | none | Specified; confirmation pending |
| NEW-8 | LOW | The gate snapshot stores each individual epoch (merchant, rollout, switch, admission, dispatch, approval) plus the derived cutoffs (CHECKed against their parts); every live check compares each individually | 4.4, 5.1, 5.3, 7.5, 8.3, 9.2, 19.3 item 17 | S1 | none | Specified; confirmation pending |
| NEW-9 | LOW | Reconciliation split into a cheap list (Q-RECONCILE) and a bounded by-id detail (Q-REFUND-DETAIL: 5 ids per request, 2 requests per evaluation); measurement of requested cost under `Shopify-GraphQL-Cost-Debug=1` required with a design threshold of 500; refund-total cross-check (and duties) added to adoption | F18, F19, 12.1.2, 12.3 item 4, 12.4, 17, 22 | S1 acceptance (measurement); S1 implements the split | **G-READBACK** cost measurement, `nodes(ids:)` on Refund, `duties` selection (U8, U9) | Specified; confirmation pending; **no Shopify behavior claimed validated** |
| NEW-10 | LOW | `BEFORE TRUNCATE` statement triggers on both journal tables; the event foreign key is named `shippingRefundId`; test isolation by unique shop and scratch databases (no cleanup bypass in triggers) | 5.2, 5.4.4, 19.3 item 9, 20.1 | S1 | none | Specified; confirmation pending |
| NEW-11 | LOW | Caps are compared numerically only (BigInt in code, `::numeric` in SQL after a format CHECK); malformed values refuse the dispatch; format CHECK for `maxRefundMinor`; integer caps; architecture test forbids string comparison | 4.2, 4.3, 4.6, 4.6.1, 9.2, I29, 19.3 items 3 and 18 | S1 (formats, helper), S2 (T3 comparison) | none | Specified; confirmation pending |
| Info | n/a | Frozen request columns on `OBSERVED` rows are a record, not dispatch authorization; reasons enumerated; test asserts no update moves an `OBSERVED` row | 6, 8.3, 19.3 | S1 | none | Specified; confirmation pending |

Effect on the self-audit rows: N1 (see NEW-2, NEW-3, NEW-6), N3 (NEW-5), N5 (NEW-4) and N10 (NEW-7) were the independent review's PARTIALLY CLOSED items; this revision supplies their remaining text, and they remain **partially closed until confirmed**.

## Appendix D: independent G0 conditions C1-C3, acceptance checklist, G-P0 and S1 authorization boundaries

**Verdict of the independent G0 review: CONDITIONAL GO for Stage S1 only. That verdict remains conditional until every row below is recorded as satisfied. Nothing in this document converts it into unconditional acceptance.**

### D.1 Checklist

| Cond. | Requirement | Evidence required to mark satisfied | Status |
|---|---|---|---|
| **C1** | G-P0 (19.4): LOW-1 to LOW-5 merged on the feature branch with regression tests, and independently confirmed; no destructive database-backed test run since the last change to the provisioning or preflight helpers without passing them | The five fixes and their tests in the repository; an independent confirmation recorded; the fixtures that depend on LOW-4 (19.2.1) not started before it | **OPEN.** All five were open at `ed8f566`; this revision changes no code |
| **C2** | Text corrections NEW-1 to NEW-7 made (and NEW-8 to NEW-11, recommended, also made) before any S1 migration, store or fixture-helper code is written | Appendix C rows specified in this revision; **confirmation by a reviewer who did not write Revision 3.1** that each is complete and internally consistent | **TEXT DELIVERED; CONFIRMATION PENDING.** The author session is the session that performed the independent review and cannot confirm its own text |
| **C3** | G-AGREEMENT designed so that a positive match alone cannot certify attribution (12.8) | Section 12.8 amended; **confirmation by a reviewer who did not write Revision 3.1**; the experiments themselves (G-AGREEMENT A, A-NEG if needed, B) remain open and are not claimed | **TEXT DELIVERED; CONFIRMATION PENDING;** experiments **OPEN** |

S1 entry conditions of 19.0 (all five) also apply. **S1 coding may not begin while C1, C2 or C3 is open.**

### D.2 Exact G-P0 prerequisites (all five, hard entry conditions)

| ID | Required fix | Files |
|---|---|---|
| LOW-1 | Refuse when the target database already exists; provisioning only creates fresh databases; `migrate deploy` never runs against an unverified database | `scripts/test-db-provision.ts` |
| LOW-2 | Do not print the database password (parse the URL, clear `password` before printing) | `scripts/test-db-provision.ts` |
| LOW-3 | Build database URLs by setting `URL.pathname`, not string replacement, and re-run `assertSafeTestDatabaseUrl` on the result | `scripts/test-db-provision.ts`, `tests/helpers/disposable-db.ts` |
| LOW-4 | `withScratchDatabase` requires a branded preflight result and verifies the maintenance connection's server address and port against it (also the input type of the fixture helper, 19.2.1) | `tests/helpers/disposable-db.ts` |
| LOW-5 | `writes.length === 0` on every refusal; reach the "misplaced tables" branch; regression test that preflight runs before migration and suites cannot stamp their own marker | `tests/disposable-db.test.ts` |

### D.3 S1 authorization boundaries (once C1, C2 and C3 are satisfied)

**Allowed** (non-dispatch only; feature branch; verified disposable databases only):
- the S1 migration with the mandatory triggers and CHECKs of section 5, the transition graph without `PREPARED -> DISPATCHING`;
- pure gates, the contract module, the query-documents module (all UNVALIDATED), stores, admission, freeze, the `OBSERVE`/`OBSERVED` lane, the refund baseline under `STRICT_EMPTY`;
- read-only reconciliation with attribution implemented but the attribution status `UNVERIFIED` unless G-AGREEMENT is CONFIRMED;
- the admin CLI (dry-run default), the runtime trigger-integrity check, runbook documentation;
- the single test-only fixture helper (or Fixture B), only after LOW-4.

**Forbidden in S1:**
- the S2 migration; a dispatcher, `DispatchPermit`, T3 write-ahead function, worker or timer; any import of the mutation-text accessor; any Shopify mutation or `refundCreate` call;
- writing `DISPATCHING` anywhere except the fixture helper's single transaction;
- `session_replication_role`, `DISABLE TRIGGER` outside the helper, `TRUNCATE`/`DELETE` of the journal tables;
- any merchant opt-in path or call to `setShippingAdjustmentEnabled`;
- the tolerant baseline mode; any change to Protocol v2, the shadow evaluator, `shipping-eligibility.ts`, `shipping-activation.ts`, `settings.server.ts`, `operation-store.server.ts` or an existing migration;
- any destructive database test before C1; any production database access, deployment, `railway up`, or merge into a deployed branch.

**A GO for S1 does not override G-P0, authorize real refunds, authorize production deployment or authorize financial execution.** Real-gateway validation (G-REAL, G-GATEWAY-POLICY) precedes any real-merchant pilot, and the reviewed uninstall fix (G-UNINSTALL, N4) precedes S3.5 and G-PILOT.

## Appendix E: unvalidated Shopify assumptions (register; no unsupported PASS claims)

Everything below is **unvalidated** at the time of this revision. "Read from documentation" means the 2026-04 reference text was read, not that any request was run.

| ID | Assumption | Relied on in | Status | Resolved by |
|---|---|---|---|---|
| U1 | `@idempotent(key: $idempotencyKey)` (variable form) is accepted on synchronous `refundCreate` in 2026-04 | 10.1 | Not proven. Documented form for synchronous examples is a string literal; the variable form is documented for bulk operations | G-INTROSPECT, G-E7 |
| U2 | How idempotency errors surface for `refundCreate` (user errors or top-level) | 11 | Unknown; affects labels only | G-E7 |
| U3 | Q-APPID, Q-RECHECK, Q-RECONCILE, Q-REFUND-DETAIL and Q-AGREEMENTS run as written | 12.1 | **UNVALIDATED**; shapes read from documentation | G-READBACK |
| U4 | Whether `orderCancel(restock: true, originalPaymentMethodsRefund: false)` creates a `Refund` object and/or `RefundAgreement`, and their shape | 8.2, F16 | **Unknown** | G-READBACK BASE read |
| U5 | `RefundAgreement.app` identifies the creator of a `refundCreate` refund and is null or different for staff-created refunds; which `__typename`/`reason` values result | 12.3, 12.8, I26 | **Unknown.** Documentation says only "the application that created the agreement" | G-AGREEMENT (A, A-NEG, B) |
| U6 | A refund `note` is returned verbatim and is immutable for the purposes of marker matching | 12.3 | Unverified | G-READBACK |
| U7 | A pending refund is (or is not) counted in order aggregates | 12.4 | Unverified; aggregates are anomaly-only | G-READBACK, G-REAL |
| U8 | Each document's requested query cost is within the limit, and a plain array of 50 objects with nested connections is priced as assumed | 12.1.2 | **Unmeasured** (threshold 500 is a design margin, not a Shopify figure) | G-READBACK cost measurement |
| U9 | `Refund` ids are accepted by `nodes(ids:)`; `Refund.duties { amountSet { presentmentMoney } }` is a valid selection | Q-REFUND-DETAIL | `Refund` implements `Node` and `RefundDuty.amountSet` exists per documentation; runtime acceptance unproven | G-READBACK |
| U10 | `Order.refunds` and `Order.transactions` (plain arrays) are complete below 50 entries and `first` truncates silently | 8.2 | Read from documentation | G-READBACK |
| U11 | Real-gateway transaction statuses and shapes (`PENDING`, `AWAITING_RESPONSE`, `FAILURE`, `ERROR`, `UNKNOWN`) and processing fees | 12.2, 12.4, 16 | Schema-derived only | G-REAL |
| U12 | `Refund.processedAt` and `RefundAgreement.happenedAt` fall inside the timing window; `createdAt` null behavior | 12.3 | Unobserved | G-READBACK, G-E7 |
| U13 | How Shopify throttling interacts with an in-flight refund | 11, 13 | Unknown; any throttled response goes to `IN_DOUBT` | G-E7 |
| U14 | The evaluator queries are valid as the code comments report | 8.1, F1 | Reported validated in code comments; **evidence not archived** | G-EVIDENCE |
| U15 | Taxable and tax-inclusive shipping behavior | scope | Out of scope; refused | G-E3 |
| U16 | A 15-minute settle delay after cancellation is sufficient for the cancellation to be fully visible | 7.1 E6 | Assumed | G-READBACK |

### Query validation status at the time of this revision

| Document | Proposed in this revision | Independently validated |
|---|---|---|
| Q-APPID, Q-RECHECK, Q-RECONCILE, Q-REFUND-DETAIL, Q-AGREEMENTS | yes (section 12.1) | **no** |
| `@idempotent` variable form for `refundCreate` | yes (section 10.1) | **no** |
| Evaluator queries | existing code | reported in code comments, evidence not archived |

This revision records **no** successful API validation, no measured query cost, and no confirmed behavior of cancellation refunds or `RefundAgreement`. Sections 18 and 22 list the gates that will produce them.
