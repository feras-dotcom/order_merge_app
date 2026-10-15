# MergeShip Shipping v0 — Phase 2: financial-dispatch architecture specification

**Revision 3 (post G0 self-audit).** Documentation only. Nothing in this document is implemented, and nothing in it authorizes sending a refund, building the dispatcher, migrating production or deploying. **This revision has not been independently accepted:** the G0 self-audit that produced it was written in the same session as the specification and is not an independent review. G0 sign-off by a reviewer outside that session is still required before Stage S1 starts.

| Item | Value |
|---|---|
| Repository / branch | `feras-dotcom/order_merge_app`, `feature/shipping-v0-recovery-v0` |
| Accepted baseline | `28e886f7e46c5fed87201e5878054c794b5a9a1b` (Phase 1, 1.1, 1.2, 1.3 accepted) |
| Supersedes | Revision 2 (`66d896d19505edb988e22ce986fc4ceaaeaec0ae`) |
| Review inputs | The Phase 2 review findings B1, H1-H3, M1-M7, L1-L7 and the G0 self-audit findings N1-N16. Appendix A maps each to a section of this document; Appendix B is the N1-N16 closure table. |
| Next gate | G0: **independent** review of this revision. Stage S1 may start only after G0 and after the S1 entry conditions in section 19.0. |
| Query status | Every Shopify query document in section 12.1 is **UNVALIDATED** until the exact text has run successfully, read-only, on the approved development store (section 22). Nothing in this document records a successful API validation that has not been performed. |

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

---

## 3. Architecture and isolation

### 3.1 Components (all new files; no edits to accepted modules)

| Component | Responsibility | Shopify access | Stage |
|---|---|---|---|
| `shipping-refund-contract.ts` | Pinned mutation document, `documentSha256`, `wireHash`, input builders and validators. Exposes the document **text** through one accessor imported only by the dispatcher. | none | S1 |
| `shipping-refund-queries.ts` | The read-only GraphQL documents of section 12.1 as constants, each with a pinned sha256 and a validation-status field (UNVALIDATED until G-READBACK records otherwise) | none | S1 |
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
| `globalDailyCap` | Maximum dispatches in any trailing 24 hours across all shops. `0` means none (fail closed). |
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
| `maxRefundMinor` | Per-refund cap, text integer in `currencyCode`. `'0'` means none. |
| `dailyCap` | Per-shop trailing-24-hour dispatch cap. `0` means none. |
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
- **Gate snapshot** (recorded on each row at claim): `activationCutoffAt`, `admissionCutoffAt`, `dispatchEpochAtAdmission` (the live `dispatchEnabledAt`, or NULL), `approvalApprovedAt`, `approvalOptInEpoch`, `approvalAckVersion`.
- **Live gate check** (used at claim, freeze and T3) recomputes all of these under `FOR SHARE`/`FOR UPDATE` locks (section 4.10) and requires **deep equality** with the row's snapshot. Any difference means the row is aborted; it is never refreshed or re-stamped.

There is no policy epoch because the policy is not merchant-settable in v0. If `RETAIN_FIXED` ever becomes settable, a policy epoch must join the cutoff (PD10).

### 4.5 Lanes and the observation phase

At claim, the row gets an immutable `lane`:

- `EXECUTE` if `dispatchCutoff` is non-null **and** the combine's `createdAt >= dispatchCutoff`. `dispatchEpochAtAdmission` is then non-null.
- `OBSERVE` otherwise. `dispatchEpochAtAdmission` is NULL.

An `OBSERVE` row is evaluated exactly like an `EXECUTE` row (fresh Shopify reads included) but finishes in terminal status `OBSERVED` and **can never become executable**: database constraints forbid any dispatch-path status on an `OBSERVE` row, and the transition trigger forbids `QUEUED -> PREPARED` unless `lane='EXECUTE'`. This gives production eligibility evidence with zero money risk (stage S3.5).

**A combine admitted before dispatch activation never becomes executable when dispatch is enabled later**, for three independent reasons: its lane is `OBSERVE` and immutable; its `dispatchEpochAtAdmission` is NULL; and T3 requires the live `dispatchEnabledAt` to equal the row's snapshot. If dispatch is turned off and on again, the epoch changes and every older `EXECUTE` row aborts at T3.

### 4.6 Caps and operator approvals

- **Per refund:** `plannedShippingMinor <= approval.maxRefundMinor`, and the row's currency equals `approval.currencyCode`.
- **Per shop:** dispatches with `dispatchedAt` in the trailing 24 hours `< approval.dailyCap`.
- **Global:** the same count across all shops `< control.globalDailyCap`.
- **Pilot serialization (breaker, section 4.7):** at most one unresolved dispatched row exists globally.
- Defaults are all zero: a freshly approved shop can dispatch nothing until an operator sets explicit caps.
- **Operator approval per refund:** unless `approval.autoApprove`, an operator must record `approvedWireHash` equal to the row's `wireHash` (conditional on `status='PREPARED'`). The approval is bound to the exact wire request including the key.

### 4.7 Financial breaker (computed, no mutable state)

Inside T3, **after** acquiring the exclusive control-row lock, the gate refuses if any row exists with `dispatchedAt IS NOT NULL` and `status NOT IN ('VERIFIED','RESOLVED')`. Such a row is in one of `DISPATCHING`, `IN_DOUBT`, `REFUND_RECORDED` or `REVIEW_REQUIRED`: money may be in flight or unresolved. The breaker therefore trips and clears from authoritative records alone; nothing writes a breaker flag. This is the pilot posture (global serialization). Relaxing it to per-shop is PD9 and needs its own review.

**A tripped breaker waits; it never aborts a valid row (N5, required before S2).** A breaker refusal, a cap refusal and a missing operator approval are *capacity* conditions, not eligibility conditions. They leave the row where it is (`QUEUED` or `PREPARED`), reschedule it with a backoff of at most 15 minutes, and **do not increment `attempts`** (the 8-attempt evaluation budget counts only failed evaluations). Only a gate inequality, a document-hash mismatch, a policy change or the seven-day horizon (section 8.4) abort a row. Details are in sections 8.4 and 9.2.

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
| Identity | `id`, `shop`, `mergeOperationId`, `sourceOrderId`, `primaryOrderId`, `primaryOrderName`, `operationCreatedAt` |
| Lane and state | `lane` (`OBSERVE`/`EXECUTE`), `status` |
| Gate snapshot | `activationCutoffAt`, `admissionCutoffAt`, `dispatchEpochAtAdmission`, `approvalApprovedAt`, `approvalOptInEpoch`, `approvalAckVersion` |
| Policy | `policyKind` (CHECK `'REFUND_ALL'`) |
| Frozen financial facts | `currencyCode`, `plannedShippingMinor` (text integer), `parentTransactionId`, `gateway` |
| Frozen wire contract | `idempotencyKey` (unique), `marker` (unique), `documentSha256`, `wireVariables` (JSONB: `{idempotencyKey, input}`), `wireHash`, `mutationVersion`, `preEvidence` (JSONB), `preparedAt` |
| Operator approval | `approvedWireHash`, `approvedAt`, `approvedBy` |
| Dispatch | `dispatchToken`, `dispatchedAt`, `respondedAt`, `responseKind`, `responseSummary` (truncated, no secrets) |
| Settlement | `refundId` (unique), `refundCreatedAt`, `settlementState`, `settlementCheckAt`, `verifiedEvidence` (JSONB), `verifiedAt` |
| Ownership | `leaseToken`, `leasedUntil`, `nextCheckAt`, `attempts` (counts evaluation/read attempts, never dispatches) |
| Review | `reasonCode`, `reviewReason`, `resolvedAt`, `resolvedBy`, `resolution`, `resolutionNote` |
| Bookkeeping | `createdAt`, `updatedAt` |

`idempotencyKey` and `marker` are generated at claim (a UUIDv4 and `MS-SHIPREFUND-<uuid>`), never derived from anything else. `plannedShippingMinor` is the single amount: the transaction amount must equal it (no separate transaction column).

### 5.2 Other tables

- **`ShippingRefundEvent`** (append-only): `id`, `refundId`, `at`, `fromStatus`, `toStatus`, `actor`. Written only by the event trigger (section 5.4.5) in the same transaction as the status change; no evidence column.
- **`ShippingExecuteControl`** and **`ShippingExecuteApproval`**: section 4.

### 5.3 Constraints (CHECK where expressible)

Formats: `idempotencyKey` is a UUID; `marker ~ '^MS-SHIPREFUND-[0-9a-f-]{36}$'`; order ids `~ '^gid://shopify/Order/[0-9]+$'`; `parentTransactionId ~ '^gid://shopify/OrderTransaction/[0-9]+$'`; `refundId ~ '^gid://shopify/Refund/[0-9]+$'`; `currencyCode ~ '^[A-Z]{3}$'`; hashes `~ '^[0-9a-f]{64}$'`; `plannedShippingMinor ~ '^[1-9][0-9]{0,39}$'`.

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
- `dispatchedAt IS NOT NULL` requires `lane='EXECUTE'`, a non-null `dispatchToken`, and a status in `DISPATCHING, IN_DOUBT, REFUND_RECORDED, VERIFIED, REVIEW_REQUIRED, RESOLVED`.
- **Marker is in the note (N7).** For a set `wireVariables`: `position("marker" in "wireVariables"->'input'->>'note') > 0`. Without it the marker could never be matched at adoption.
- **Cutoff timestamps (N7).** Snapshot columns `activationCutoffAt` and `admissionCutoffAt` are `NOT NULL`. For every lane `"operationCreatedAt" >= "admissionCutoffAt"` and `"admissionCutoffAt" >= "activationCutoffAt"`. For `lane='EXECUTE'`: `"dispatchEpochAtAdmission" IS NOT NULL AND "operationCreatedAt" >= "dispatchEpochAtAdmission"`. This puts no-retroactivity (I8) into the database in addition to the application's gate checks.
- **Decimal amount format (N7).** For a set `wireVariables`, both `->'input'->'shipping'->>'amount'` and the transaction `amount` match the decimal-format pattern `^(0\.[0-9]{1,4}|[1-9][0-9]*(\.[0-9]{1,4})?)$` (no sign, no exponent, no superfluous leading zeros, at most four fractional digits; trailing zeros are allowed because Shopify amounts such as `0.50` and `12.00` are legitimate) **and** are strictly positive by a separate check, `("amount")::numeric > 0`. The application additionally requires the number of fractional digits to equal the currency's precision (zero-decimal currencies send no fractional part). Both checks fail closed: a value that does not parse as a number raises and the write is rejected.
- `OBSERVED, ABORTED, SKIPPED, INELIGIBLE` require `dispatchedAt IS NULL`.
- `REFUND_RECORDED, VERIFIED` require `refundId IS NOT NULL`; `VERIFIED` requires `settlementState='SUCCESS'` and `verifiedAt`.
- `RESOLVED` requires `resolvedBy`, `resolution` and `resolvedAt`.

### 5.4 Triggers

1. **Transition graph** (section 6): any `(old, new)` pair outside the graph raises. `QUEUED -> PREPARED` additionally requires `lane='EXECUTE'`; `QUEUED -> OBSERVED` requires `lane='OBSERVE'`. **The S1 migration's graph does not contain `PREPARED -> DISPATCHING` at all.** That edge is added by the separate S2 migration (section 21), so S1's non-dispatch property is enforced by the database, not only by code, mirroring the Phase 1.1 precedent that making a row executable needs an authorized schema change. An **insert trigger** allows only the initial statuses `QUEUED`, `SKIPPED`, `INELIGIBLE` and `REVIEW_REQUIRED` (the last three are the terminal claim outcomes of section 7.5).
2. **Frozen columns:**
   - always immutable: `shop`, `sourceOrderId`, `primaryOrderId`, `mergeOperationId`, `operationCreatedAt`, `lane`, `idempotencyKey`, `marker`, and the whole gate snapshot;
   - write-once at the freeze (NULL to value once, never again): `wireVariables`, `wireHash`, `documentSha256`, `mutationVersion`, `currencyCode`, `plannedShippingMinor`, `parentTransactionId`, `gateway`, `preEvidence`, `preparedAt`;
   - write-once at dispatch: `dispatchToken`, `dispatchedAt`.
3. **Shape trigger** from 5.3.
4. **No delete** on `ShippingRefund`; **no update or delete** on `ShippingRefundEvent`.
5. **Event trigger (N16).** An `AFTER INSERT OR UPDATE` trigger on `ShippingRefund` inserts the `ShippingRefundEvent` row (`fromStatus`, `toStatus`, `at` on the database clock, `actor` from `current_setting('mergeship.actor', true)` set with `SET LOCAL` by the store, `'unknown'` if unset) whenever the status is new or changed. This makes "one event per status change" a database guarantee instead of something every code path must remember. Event rows carry no evidence payload: evidence lives on the row itself (`preEvidence`, `verifiedEvidence`, `reviewReason`, `responseSummary`), which keeps the trigger trivial. The store never inserts events itself.

Triggers are new to this repository and deliberately stronger than its CHECK-only convention: a buggy caller must not be able to violate a financial rule. They are tested against real PostgreSQL only (section 20). A reviewer who prefers CHECK-only may drop trigger 1 at the cost of losing database-level transition enforcement (R11).

---

## 6. State machine

| Status | Meaning | Dispatched? |
|---|---|---|
| `QUEUED` | Claimed; evaluation pending | no |
| `PREPARED` | Wire request frozen; awaiting approval and T3 | no |
| `DISPATCHING` | Write-ahead committed; the send may or may not have happened | maybe |
| `IN_DOUBT` | No confirmed response; read-only reconciliation only | maybe |
| `REFUND_RECORDED` | A refund id is recorded; settlement not yet verified | yes |
| `VERIFIED` | Independent read-back passed; **terminal success** | yes |
| `OBSERVED` | `OBSERVE` lane; evaluation would have succeeded; **terminal, never executable** | no |
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
| `(none) -> QUEUED, SKIPPED, INELIGIBLE, REVIEW_REQUIRED` (claim and terminal claim outcomes) | S1 | insert trigger; snapshot and cutoff CHECKs |
| `QUEUED -> PREPARED / OBSERVED / SKIPPED / INELIGIBLE / ABORTED / REVIEW_REQUIRED` | S1 | lane CHECKs; write-once wire columns |
| `PREPARED -> ABORTED / REVIEW_REQUIRED` | S1 | none beyond the graph |
| **`PREPARED -> DISPATCHING`** | **S2 only** (the S1 migration's graph does not contain this edge; the S2 migration adds it) | `dispatchedAt` and `dispatchToken` set in the same update; `dispatchedAt IS NULL` beforehand |
| `DISPATCHING -> REFUND_RECORDED` (T4, from a send response) | **S2 only** (needs a real response) | `dispatchToken` fence; `refundId` valid and unique |
| `DISPATCHING -> IN_DOUBT` (time sweep) | S1 reconciliation code | `dispatchedAt` and `dispatchToken` non-null (CHECK); `dispatchedAt` older than 120 s |
| `IN_DOUBT -> REFUND_RECORDED` (adoption, section 12.3) | S1 reconciliation code | durable dispatch evidence (CHECK); `refundId` set and unique; adoption conditions including app attribution |
| `IN_DOUBT -> REVIEW_REQUIRED` | S1 reconciliation code | durable dispatch evidence not required for review, but the row is already post-dispatch here |
| `REFUND_RECORDED -> VERIFIED` | S1 reconciliation code | `refundId`, `settlementState='SUCCESS'`, `verifiedAt` (CHECK) |
| `REFUND_RECORDED -> REVIEW_REQUIRED` | S1 reconciliation code | none beyond the graph |
| `REVIEW_REQUIRED -> RESOLVED` | S1 operator CLI | `resolvedBy`, `resolution`, `resolvedAt` (CHECK) |

**S1 cannot create, authorize or enter `DISPATCHING`.** What S1 may do is read-only Shopify reconciliation plus the database transitions above for rows that **already carry valid durable dispatch evidence** (`dispatchedAt` and `dispatchToken` present). In S1 such rows exist only through explicitly controlled test fixtures on verified disposable databases (section 19.2); there is no S1 code path that produces one.

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
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(op."secondaries") = 'array'
           THEN op."secondaries" ELSE '[]'::jsonb END) s
    WHERE jsonb_typeof(s) = 'object'
      AND (s->>'id') ~ '^gid://shopify/Order/[0-9]+$'
      AND NOT EXISTS (
        SELECT 1 FROM "ShippingRefund" sr
        WHERE sr."shop" = op."shop" AND sr."sourceOrderId" = (s->>'id')
      )
  )
ORDER BY op."createdAt" ASC
LIMIT 50
```

The inner `NOT EXISTS` is against `ShippingRefund` **only**; the query never references `ShippingAdjustment`. The secondaries are deliberately **not** filtered by `cancelPhase` in SQL: a `COMPLETED` operation with an unverified secondary is a contradiction and must receive a durable `REVIEW_REQUIRED` row so it leaves the window, not be silently skipped forever.

**Malformed `secondaries` cannot block the scan (N10).** `jsonb_array_elements` raises on a non-array value, and one such operation would abort the whole query for the shop on every scan. The `CASE` turns a non-array value into an empty array; elements that are not objects, or whose `id` is not a well-formed order GID (the same pattern as the `sourceOrderId` CHECK), never match, so they can neither abort the query nor occupy the window. The id pattern in SQL must stay identical to the CHECK pattern, because an id that passed SQL but failed the CHECK would throw at claim and starve the scan; a test asserts the two patterns are the same string.

Such operations are not refunded (fail closed) and are never silently invisible: a second bounded query, `findMalformedOperations(shop, 25)`, lists v2 `COMPLETED` operations at or after the cutoff whose `secondaries` is not an array or contains an element that is not an object with a well-formed `id`. Each scan logs the count as `[shipping-refund] malformed-operations shop=<shop> count=<n>` for monitoring. No row is written for them because there is no valid `sourceOrderId` to key it on.

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
| `assessSecondaryEvidence` issues (merge-evidence contradiction) | `REVIEW_REQUIRED` |
| Transient failure (transport, top-level error, unusable session) | reschedule 5 minutes, `attempts + 1`; after **8** attempts `INELIGIBLE(EVAL_UNAVAILABLE)` |
| Claim returns gate-changed | no row; the next scan decides afresh |
| Claim returns conflict (another scanner won) | skip |
| Stopped or incomplete cleanup; combine before cutoff | never selected |

### 7.5 Claim transaction and concurrent scanners

The claim is one transaction: `FOR SHARE` on `AppControl`, `Settings`, `ShippingExecuteControl` and the approval row; recompute the live gate and require it to equal the snapshot about to be written; decide the lane; `INSERT ... 'QUEUED' ... ON CONFLICT ("shop","sourceOrderId") DO NOTHING RETURNING *`, with a new idempotency key and marker, `attempts = 1` and a lease of 180 seconds. The unique index is the only arbiter: of two concurrent scanners exactly one inserts each secondary's row; the other gets no row and moves on. Duplicate rows and duplicate financial candidates are impossible.

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

### 8.2 Execution recheck (new read-only document)

A separate read-only query adds checks the evaluator does not make. Its proposed document is **Q-RECHECK** in section 12.1 (**UNVALIDATED**), and the app identity is read with **Q-APPID**. Failure of any check gives `INELIGIBLE` (before freeze) or `ABORTED` (after). `Order.refunds` and `Order.transactions` are plain arrays, so completeness means "fewer than 50 entries", never `pageInfo`:

- The secondary's refund list is empty (it must be, since a PAID order has none; belt and braces for restore protection, I16).
- The secondary's transactions contain exactly one `SUCCESS` `CAPTURE` or `SALE`, at most one `AUTHORIZATION` (and only as that capture's parent), and nothing else (no `REFUND`, `VOID`, `CHANGE` or other kinds). Split payments, gift cards and multiple captures are ineligible.
- The primary order loads, `cancelledAt` is null, and `displayFinancialStatus` is neither `REFUNDED` nor `VOIDED`.
- A snapshot of the secondary's aggregates (`totalRefundedSet`, `totalRefundedShippingSet`, refund count, transaction ids) is recorded into `preEvidence`.

All new documents are **UNVALIDATED** and must be validated verbatim against API 2026-04 with read-only calls (G-READBACK) **before S1's recheck and reconciliation code is accepted** (section 18), not merely before S2.

### 8.3 Freeze (T2)

One transaction: lock the row `FOR UPDATE`; verify token and lease; recompute the live gate and require equality with the snapshot; then in **one** `UPDATE ... WHERE status='QUEUED'` write `wireVariables`, `wireHash`, `documentSha256`, `mutationVersion`, `currencyCode`, `plannedShippingMinor`, `parentTransactionId`, `gateway`, `preEvidence`, `preparedAt` and set `PREPARED` (or `OBSERVED` for lane `OBSERVE`). Every frozen field is write-once. The wire request is built from the evaluator's `RefundInput` plus the row's key.

### 8.4 Drift before dispatch

**`PREPARED` lifetime (N5).** A frozen wire request is safe to hold because its idempotency key has never been sent and R2 re-validates everything immediately before T3; the old 24-hour `STALE_PREPARED` abort protected nothing that R2 does not already protect, and it would have permanently aborted valid refunds that merely waited for the breaker, a cap or a slow operator approval. A `PREPARED` row is therefore bounded only by the **seven-day eligibility horizon** (E7: seven days after the secondary's verified `cancelledAt`); past it the row becomes `ABORTED(HORIZON_EXPIRED)`. Staleness of evidence is handled by R2, not by age.

**Waiting rows (N5, required before S2).** While dispatch is *unavailable for capacity reasons* (breaker tripped, a cap reached, operator approval pending) a row waits and is never aborted for that reason: an `EXECUTE`-lane `QUEUED` row is not frozen until a capacity precheck (database-only: breaker, caps, approval presence) passes, and a `PREPARED` row simply stays `PREPARED`. Waiting reschedules the row with a backoff of at most 15 minutes and **does not increment `attempts`**; the 8-attempt budget counts failed evaluations only. A gate inequality (control cycled, epoch changed, approval restamped, policy changed) is a different class and still aborts.

Immediately before T3, R2 re-runs R1 and the recheck. Results:

| R2 result | Row |
|---|---|
| READY, and the rebuilt `wireHash` equals the frozen one | proceed to T3 |
| READY but any difference (amount, parent, gateway, currency) | `ABORTED(DRIFT_BEFORE_DISPATCH)` |
| Evaluator SKIP or REVIEW, or recheck failure (for example a new refund appeared) | `ABORTED(<reason>)` |
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
| capacity precheck | DB reads only | Breaker, caps and approval presence (9.2). If any is unavailable the row waits; **no Shopify read is made and no attempt is consumed** |
| R2 | reads | Pre-dispatch re-evaluation (8.4), only after the capacity precheck passed |
| T3 | tx | Gate and write-ahead (9.2) |
| S1 | one request | The single send (9.3, section 10) |
| T4 | conditional `UPDATE` | Outcome, fenced by `dispatchToken` (9.4) |
| V | read-only | Verification and reconciliation (section 12) |

No network I/O happens inside any transaction. All timestamps use the database UTC clock (`DB_WALL`).

### 9.2 T3: gate and write-ahead (the point of no return)

Single transaction, `lock_timeout` 2 s:

1. Lock the row `FOR UPDATE`; lock `AppControl`, `Settings(shop)` `FOR SHARE`; lock `ShippingExecuteControl` `FOR UPDATE`; lock the approval row `FOR SHARE` (section 4.10).
2. Recompute the live gate; require **deep equality** with the row snapshot, `dispatchEnabled`, `lane='EXECUTE'`, `operationCreatedAt >= dispatchCutoff`, the process environment flag, and `Settings.shippingPolicy = 'REFUND_ALL'`.
3. Require `documentSha256` equals the pinned constant of **this build**, and recompute `wireHash` from the stored `wireVariables` and require equality (I18).
4. Require `autoApprove` or `approvedWireHash = wireHash`.
5. Caps (after the lock, 4.6): per refund, per shop, global; currency equals the approval currency.
6. Breaker (4.7): no unresolved dispatched row exists.
7. `UPDATE ... SET status='DISPATCHING', dispatchToken=<new uuid>, dispatchedAt=DB_WALL WHERE id=$id AND status='PREPARED' AND dispatchedAt IS NULL AND leaseToken=$t AND leasedUntil > DB_WALL`; require rowcount 1. The event row is written by the database trigger (section 5.4.5), not by the store.

**T3 refusal classes (N5).** A refusal is exactly one of:

| Class | Conditions | Effect on the row |
|---|---|---|
| **Abort** (eligibility) | Gate inequality, `dispatchEnabled` off or epoch changed, policy no longer `REFUND_ALL`, `documentSha256` differs from the build's pin, `wireHash` mismatch, `operationCreatedAt < dispatchCutoff`, seven-day horizon passed | `ABORTED(<reason>)` |
| **Wait** (capacity) | Breaker tripped, per-shop or global cap reached, operator approval not yet recorded | Row unchanged; reschedule with backoff of at most 15 minutes; `attempts` not incremented |
| **No decision** (infrastructure) | Lock timeout, transient database error, unknown commit | No send; the row is handled as in sections 9.3 and 13 |

**The S2 migration (S2 only).** The dispatch edge is a schema change: the S1 migration's transition trigger omits `PREPARED -> DISPATCHING` (section 5.4.1) and a separate S2 migration replaces the trigger function to allow it, adding no tables. It is reviewed with S2 and is part of the production-migration approval (G-MIGRATE-PROD) of whichever build first contains the dispatcher.

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

**Q-RECONCILE: refund reconciliation on the secondary (UNVALIDATED).**

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

`orderAdjustments` must be empty for our refund (a shipping-only refund carries no adjustments); a non-empty list is a contradiction.

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

**Validation register (honest status of every query the subsystem depends on):**

| Document | Used by | Status | Evidence required to change the status |
|---|---|---|---|
| Q-APPID | attribution, reconciliation | **UNVALIDATED for Phase 2** (identical text is in use by Protocol v2) | Exact text run read-only on the dev store; sanitized response archived |
| Q-RECHECK | admission, R2 | **UNVALIDATED** | same |
| Q-RECONCILE | adoption, verification, orphan audit | **UNVALIDATED** | same, against an order that holds an existing refund and one that holds none |
| Q-AGREEMENTS | attribution | **UNVALIDATED** | same, plus G-AGREEMENT (12.8) |
| `@idempotent` directive introspection | S2 document form | **UNVALIDATED** | G-INTROSPECT result archived |
| Evaluator queries (`SHADOW_ORDER_QUERY`, `SHADOW_PREVIEW_QUERY`) | admission R1 | **Reported validated in code comments (`shipping-shadow.server.ts:172-175`); evidence not archived** (F10) | Archive under G-EVIDENCE |
| Fixtures for transaction statuses `PENDING`, `AWAITING_RESPONSE`, `FAILURE`, `ERROR`, `UNKNOWN` | S1 fixtures | **Schema-derived, not observed.** Real-gateway behavior is G-REAL | Observed only after G-REAL |

**Assumptions stated, not relied on:** list order is **not** assumed (the whole bounded list is scanned and the refund selected by marker); a refund list of 50 or more, or any `hasNextPage` not exactly `false`, means completeness is unproven and goes to `REVIEW_REQUIRED`; immediate consistency is **not** assumed (next section). S1 test fixtures for these documents are built from the **sanitized responses archived after validation**, not invented from the reference documentation.

### 12.2 Visibility lag versus contradiction

| Class | Examples | Handling |
|---|---|---|
| **Lag** (retry; evidence may simply not be visible yet) | Marker refund not yet in the list; refund visible but its `transactions` not yet listed; transaction `PENDING` or `AWAITING_RESPONSE`; aggregates not yet moved | Stay in the current state, re-read on the schedule |
| **Contradiction** (review now) | Marker refund with a different shipping amount, currency, parent, gateway or tax; any `refundLineItems`; more than one transaction; two refunds with our marker; the recorded `refundId` differs from the marker refund; aggregates inconsistent with the sum of refund shipping lines; refund created outside the time window | `REVIEW_REQUIRED` with a specific reason code |
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
3. **App attribution (N3).** From a **complete, bounded** Q-AGREEMENTS read, exactly one `RefundAgreement` has `refund.id` equal to that refund's id, and its `app.id` equals the **verified current app id** from Q-APPID. Missing, incomplete, unavailable or inconsistent agreements are handled by the attribution classes in 12.2: pending investigation or `REVIEW_REQUIRED`, never adoption and never a resend.
4. **Amounts and currency.** Exactly one `refundShippingLines` entry with `subtotal == plannedShippingMinor`, `tax == 0`, in `currencyCode`; no `refundLineItems`; no `orderAdjustments`.
5. **Allocation.** Exactly one transaction, `kind = REFUND`, `parentTransaction.id = parentTransactionId`, `gateway = gateway`, `amount == plannedShippingMinor`, in `currencyCode`.
6. **Timing.** `processedAt` (non-null) and the agreement's `happenedAt` fall within `[dispatchedAt - 5 minutes, now]`. `createdAt` is nullable: when it is non-null it must fall in the same window, and when it is `null` it is recorded as null and is **not** used as evidence of anything. The five minutes allow for clock skew between Shopify and the database.

### 12.4 Verification (`REFUND_RECORDED` to `VERIFIED`)

One independent read-back must satisfy 12.3 (1)-(6) for the recorded `refundId` (including **app attribution through `RefundAgreement`**) **and** report the refund transaction `SUCCESS`. A refund whose attribution cannot be established is never `VERIFIED`.

**Aggregates are used only to detect anomalies, and only once the transaction is `SUCCESS` (N15).** A pending refund may not yet be counted in order aggregates (unverified assumption, section 22), so the aggregate comparison is not made while the transaction is `PENDING` or `AWAITING_RESPONSE`. Once it is `SUCCESS`, when our refund is the only refund on the secondary (the expected case, since the secondary had none), `totalRefundedShippingSet` must equal the planned amount and the order totals must be consistent; if other refunds exist (for example a later merchant refund) the aggregate check is skipped and the presence is recorded as information.

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
| No marker refund but another refund appeared | `REVIEW_REQUIRED(EXTERNAL_REFUND)` |
| Refund list 50 or more, or reads failing | Retry with backoff; the list size gives review; a row still `IN_DOUBT` after 7 days goes to review |

### 12.6 Human review and resolution

`scripts/shipping-refund-admin.ts review --id` prints the wire variables, hash, events, the latest read-back diffs and a recommendation. `resolve --id --resolution <r> --note --actor --confirm <hash prefix>` moves `REVIEW_REQUIRED` to `RESOLVED`:

- `VERIFIED_MANUALLY` requires a fresh passing read-back.
- `NOT_FOUND_ATTESTED`: the operator attests, after checking Shopify admin **and** the payment provider, that no refund exists. It is an attestation, never a system proof.
- `REFUNDED_MANUALLY` and `ACCEPT_ANOMALY`.

**No resolution reopens dispatch, and there is no automatic or operator retry of an ambiguous financial dispatch in v0.** A source whose refund did not happen is closed and the shipping is handled manually.

### 12.7 Protection against loss of local financial records (database restore or truncation)

A restore or bad truncation can erase the local record of a refund that was already sent. Defences, in order:

1. **Shopify-side guard (I16).** Admission and R2 require the secondary's refund list to be empty and `refundedShipping = 0`. A refund that exists in Shopify makes re-admission `INELIGIBLE` and makes a restored `PREPARED` row `ABORT` at R2, regardless of what the local database says. This is the final duplicate guard and is independent of local state.
2. **Epoch invalidation.** After any restore, dispatch is re-enabled only through the setter, which stamps a **new** `dispatchEnabledAt`. Every restored `EXECUTE` row has an older snapshot and aborts at T3.
3. **Orphan audit.** `shipping-refund-admin.ts audit-orphans --since <iso>` reads the recent cancelled secondaries of approved shops and reports (a) any refund whose note carries the `MS-SHIPREFUND-` prefix and (b) any refund attributed through `RefundAgreement.app.id` to our app, in either case with no matching local row or in a different state. The agreement-based finding does not depend on the note surviving unedited. It is read-only.
4. **Restore runbook (a G-OPS requirement):** before a restore, stop dispatch (env unset and restart, or stop the process); after the restore, keep dispatch off, run `audit-orphans`, reconcile every row, and only then re-enable dispatch.
5. A restore drill, with backups and point-in-time recovery confirmed, is a G-OPS gate.

### 12.8 G-AGREEMENT: does an app-created refund actually produce the required agreement? (N3)

The attribution rule (12.3 condition 3) assumes that a refund created by this app through `refundCreate` appears in `Order.agreements` as a `RefundAgreement` whose `app.id` is this app's id. **That is not yet known.** The reference documentation lists `app` on `RefundAgreement` ("the application that created the agreement"), but nothing here shows it is populated for refunds created through `refundCreate` by this app. It is verified in two parts and the design may not proceed past the points stated:

| Part | What | Kind | Outcome handling |
|---|---|---|---|
| **A (read-only)** | Run Q-APPID and Q-AGREEMENTS against the development-store orders that already hold the refunds created during experiments E1, E2 and E6. For each refund record: the refund id, the matching agreement's `__typename`, `app.id`, `happenedAt`, and whether `app.id` equals Q-APPID. The archive must also record **how each experiment refund was created** (which credentials or tool), because only a refund created with MergeShip's own app credentials counts as evidence | read-only; no mutation | **CONFIRMED**: every counted refund has exactly one `RefundAgreement` with the expected `app.id`. **NEGATIVE**: a refund created with the app's credentials has no agreement, or a null or different `app.id`. **INCONCLUSIVE**: provenance of the experiment refunds cannot be established |
| **B (inside G-E7)** | The first refund actually created by the dispatcher on the development store is read back with the same documents | uses the separately approved G-E7 refund | Must be CONFIRMED before S3 and before any later stage |

**Required handling:**

- **CONFIRMED (A):** proceed. B still gates S3.
- **INCONCLUSIVE (A):** S1 reconciliation may be accepted with attribution implemented and tested on **schema-derived** fixtures, and this fact recorded in the S1 review; B becomes mandatory and S2 acceptance depends on it.
- **NEGATIVE (A or B):** **stop.** The invariant is not weakened silently. A separately reviewed alternative provenance mechanism is required before S1 reconciliation is accepted (A) or before S3 (B). Until such an alternative is reviewed, the fail-closed behavior stands: automatic adoption is disabled, so every `IN_DOUBT` row ends in `REVIEW_REQUIRED` after its window and humans decide. Weaker alternatives (marker plus exact financial match only) are named here only so a reviewer can reject them; they are **not** approved.

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
| Merchant-initiated refunds after evaluation | R2 re-evaluates; Shopify validates the amount against what is refundable; any refund visible makes the row `ABORTED`; later refunds are recorded as information at verification |
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
| I4 | `plannedShippingMinor` is at most the discounted shipping paid, at most Shopify's maximum refundable, at most `approval.maxRefundMinor`, in the pinned currency. |
| I5 | No refund when any prior refund exists on the secondary, or when refund history is truncated or inconsistent. |
| I6 | `VERIFIED` requires an independent read-back (12.3 and 12.4) with a `SUCCESS` refund transaction. |
| I7 | No automatic or operator resend of an ambiguous dispatch, under any key. |
| I8 | No money moves for a combine created before the dispatch cutoff; the gate is recomputed under locks and must equal the row snapshot at claim, freeze and T3. |
| I9 | The subsystem never writes or locks merge tables; refund outcomes never alter merge state. |
| I10 | Key, marker and refund id are each attributed to at most one row. |
| I11 | Per-refund, per-shop and global caps, currency pin, serial dispatch and breaker are enforced inside T3 under the exclusive control-row lock. |
| I12 | All timestamps use the database UTC clock. |
| I13 | Terminal states are immutable; frozen columns are immutable after their write-once point; transitions follow the graph (trigger-enforced). |
| I14 | Reconciliation is read-only toward Shopify and runs regardless of every switch. |
| I15 | The only Shopify mutation in the subsystem is the one pinned `refundCreate` document; its text has one export, imported only by the dispatcher. |
| **I16** | The Shopify-side prior-refund guard at admission and R2 (secondary refund list empty, shipping refunded zero) is the final duplicate guard, independent of local database state. |
| **I17** | `input.orderId = transactions[0].orderId = sourceOrderId`, and `sourceOrderId <> primaryOrderId`; the source is a `CANCEL_VERIFIED` secondary of the row's own operation. |
| **I18** | The wire request is exactly the pinned document plus the stored `wireVariables`; `wireHash` covers the document hash, the key and the input, and is recomputed at T3. |
| **I19** | A send happens only after an in-process T3 success observed by the same process; a `DISPATCHING` row never triggers a send. |
| **I20** | Approval is valid only while its recorded merchant opt-in epoch equals the live one and its `ackVersion` equals `REQUIRED_ACK_VERSION`. **I20 is conditional on N4:** it is only as strong as the guarantee that an uninstall clears the opt-in epoch, which holds today only when the webhook reaches the reset (F15). That is a precondition of S3.5 and G-PILOT, not of S1. |
| **I21** | Execution code never reads, updates, promotes or depends on `ShippingAdjustment`. |
| **I22** | The refund worker never refreshes offline tokens. |
| **I23** | An unknown T3 commit result means no send. |
| I24 | A row in lane `OBSERVE` is never executable; no dispatch-path status or dispatch field can exist on it. |
| I25 | A row is dispatchable only while the live `dispatchEnabledAt` equals the row's `dispatchEpochAtAdmission`. |
| I26 | **Provenance.** A refund is adopted or verified only when it is linked by a `RefundAgreement` whose `app.id` equals the verified current app id **and** its marker and financial evidence agree. The marker alone is never provenance. Unavailable, incomplete or inconsistent attribution fails closed to pending investigation or `REVIEW_REQUIRED`, never to a resend. |
| I27 | **S1 non-dispatch is database-enforced.** The S1 migration's transition graph has no `PREPARED -> DISPATCHING` edge and the insert trigger admits only `QUEUED`, `SKIPPED`, `INELIGIBLE` and `REVIEW_REQUIRED`; entering `DISPATCHING` requires the separate S2 migration. |

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
- **for experiments that created a refund: how it was created** (which application credentials or which tool; admin UI creation is recorded as such), because G-AGREEMENT (12.8) counts only refunds created with MergeShip's own app credentials;
- **for every read-only query validation run (G-READBACK, G-AGREEMENT part A, G-INTROSPECT): the document's sha256, API version, development-store handle, UTC time, and pass or fail with the sanitized response.** A validation record for a document whose current sha256 differs from the recorded one is void.

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
| 1 | **G0** | **Independent** review of this Revision 3 (the self-audit does not count) |
| 2a | **S1 implementation** | Non-dispatch implementation (section 19), disposable databases only. May start after steps 0 and 1 |
| 2b | **G-EVIDENCE**, **G-INTROSPECT**, **G-READBACK**, **G-AGREEMENT part A** | Runs **in parallel with 2a**. Archive of E0/E1/E2/E6; read-only directive introspection; read-only validation of Q-APPID, Q-RECHECK, Q-RECONCILE and Q-AGREEMENTS on the approved development store; read-only attribution check on existing experiment refunds. All results recorded per section 17 |
| 3 | **S1 review** | Independent review of S1. **The reconciliation and recheck portions (and the attribution rule) cannot be accepted until step 2b has passed** for the exact document texts S1 pins. A NEGATIVE G-AGREEMENT stops acceptance (12.8); INCONCLUSIVE is accepted only as stated there |
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
2. **G0 is signed off by a reviewer outside the session that wrote this specification.** The Revision 3 self-audit does not satisfy it.
3. The working branch is `feature/shipping-v0-recovery-v0` (or a branch cut from it) and **no S1 change is in, or queued for, a deployed branch** (section 18, accidental-deployment paths).
4. A freshly provisioned disposable database passes the Phase 1.3 preflight, with the operator token coming from the operator's shell, never from a committed value.
5. The Revision 3 query documents (section 12.1) are the starting text; G-READBACK may still be pending (it is required for S1 **acceptance**, section 18, not for starting).

### 19.1 In scope

- **S1 migration** creating `ShippingExecuteControl`, `ShippingExecuteApproval`, `ShippingRefund`, `ShippingRefundEvent` with all constraints, indexes and triggers of section 5, the control singleton seeded off, and Prisma schema additions for the four models. Its transition trigger has **no `PREPARED -> DISPATCHING` edge** (section 5.4.1). No change to existing models.
- **Execution controls**: setters for the control and approvals (own module; `setControl` untouched); the admin CLI commands for controls, approvals, status, show, approve-hash, review, resolve and `audit-orphans` (read-only).
- **Direct admission**: scanner, claim, lanes, outcomes, due-row processing, all per section 7.
- **Pure gates** and the **contract module** (document constant, `documentSha256`, `wireHash`, builders and validators).
- **Stores** with fenced writes and event logging; **preparation** (R1, execution recheck, freeze, `OBSERVED`, drift handling).
- **The query-documents module** (`shipping-refund-queries.ts`) with the section 12.1 documents, their pinned hashes and their (UNVALIDATED) status fields.
- **Read-only reconciliation** (classifiers, adoption **with `RefundAgreement` attribution**, verification, polling schedule, orphan audit) and **only the database transitions of the S1 rows of section 6.1**, applied to rows that already carry valid durable dispatch evidence. Such rows exist in S1 only as fixtures (section 19.2).
- Documentation updates to `docs/RUNBOOK.md` for the new controls, the emergency stop and the restore procedure.

### 19.2 Exclusions (must not appear in S1)

- No dispatcher, no `sendRefund`, no `DispatchPermit`, no T3 write-ahead function, no worker or timer, no `admin.graphql` mutation call, and no module that imports the mutation text accessor.
- **S1 cannot create, authorize or enter `DISPATCHING`** (N1). No S1 code path writes `status = 'DISPATCHING'` (the reconciliation writer's type excludes it, section 3.2 rule 7), no S1 code writes `REFUND_RECORDED` from a send response (that is T4, S2), and the S1 migration's transition graph has no `PREPARED -> DISPATCHING` edge, so even a hand-written update fails in the database.
- **Dispatched rows exist in S1 only as controlled fixtures.** Reconciliation tests need rows already in `DISPATCHING`, `IN_DOUBT` or `REFUND_RECORDED`. They are created only by one helper under `tests/helpers/`, which (a) calls `preflightDisposableDatabase` first, (b) inserts inside one transaction that sets `SET LOCAL session_replication_role = replica` so the transition trigger does not apply, while **every CHECK constraint still applies**, so the fixture must carry valid durable dispatch evidence (`dispatchedAt`, `dispatchToken`, frozen wire columns, `lane='EXECUTE'`), and (c) is imported by no file under `app/` or `scripts/` (an architecture test asserts this).
- No change to Protocol v2, the shadow evaluator, `shipping-eligibility.ts`, `shipping-activation.ts`, `settings.server.ts`, `operation-store.server.ts` or any existing migration.
- No merchant-facing UI, no production database access or migration, no deployment, no merge into a deployed branch, no `refundCreate` call of any kind.

### 19.3 Acceptance criteria

All must hold for S1 to be accepted. Items 1-12 are executable test or inspection checks; item 13 is the validation prerequisite.

1. The S1 migration applies cleanly to a **freshly provisioned disposable database** through the Phase 1.3 preflight, and every constraint and trigger test passes against real PostgreSQL.
2. All S1 tests in section 20 pass; `npm test`, lint and the build pass; `tsc` shows only the known pre-existing `shopify.server.ts` error.
3. The architecture tests pass: no `ShippingAdjustment` string or SQL (including a query-log assertion); the allowed-import list; no `Merge*` writes; no S1 module imports the mutation text accessor; no `DispatchPermit`, `sendRefund`, worker or timer exists; no `'DISPATCHING'` assignment in non-test sources; the fixture helper is not imported from `app/` or `scripts/`; no non-test source references `setShippingAdjustmentEnabled`; every query document contains no `mutation` keyword and matches its pinned sha256.
4. **S1 non-dispatch proof (N1):** on a disposable database a raw `UPDATE ... SET status = 'DISPATCHING'` from `PREPARED` raises; the insert trigger rejects an insert in any post-dispatch status; the reconciliation writer refuses a row without `dispatchedAt` and `dispatchToken`; every S1 reconciliation transition of section 6.1 succeeds only from its stated source status and fails otherwise.
5. **Observation proof:** a combine admitted with dispatch off ends `OBSERVED` and can never be moved to `PREPARED` by any code or SQL path, including after dispatch is later enabled or after any control is cycled.
6. **Scanner non-starvation proofs:** 51 ineligible combines plus one eligible; a combine with more than 25 secondaries; transient failure exhaustion; concurrent scanners; **malformed `secondaries` values (non-array, element without a string `id`, element with a non-GID `id`) in one shop do not abort or stall the scan, and the malformed-operations report lists them (N10)**.
7. **Transactional claim proofs (N9):** terminal claim outcomes write no row when the gate has closed or changed mid-claim; written rows carry an immutable snapshot; the SQL secondary-id pattern equals the CHECK pattern.
8. **Approval semantics proofs (N8, N11):** the approval setter refuses a shop without a live opt-in epoch; first approval, re-approval, `autoApprove` false to true, currency change and `ackVersion` change restamp `approvedAt` and invalidate earlier candidates; cap edits and `autoApprove` true to false do not restamp; a cap edit never revives a terminal row.
9. **Database constraint proofs (N7):** the marker-in-note, cutoff-timestamp and decimal-format CHECKs reject their violations; the event trigger writes exactly one event per status change and none for non-status updates.
10. **Reconciliation proofs:** adoption, verification and every classification of sections 12.2-12.5 behave as specified on fixtures derived from the archived validated responses, including `RefundAgreement` attribution (missing, incomplete, unavailable, mismatched, duplicate); an unattributed refund is never adopted or verified; no test or code path resends.
11. `git diff` of the accepted files listed in 19.2 is empty; existing Phase 1 shadow tests are unchanged and pass.
12. S1 is not merged into any deployed branch, no S1 build was deployed through any path (including `railway up`), and the PR description states that merging or deploying it migrates production (F9).
13. **G-READBACK and G-AGREEMENT part A have been completed for the exact document texts S1 pins** (section 18, step 2b). Until then the reconciliation and recheck portions of S1 are **not accepted**, whatever the tests show, because the documents they depend on are UNVALIDATED.

### 19.4 Prerequisites (G-P0): known Phase 1.3 provisioning findings

These are **hard entry conditions for S1** (section 19.0, condition 1), not optional follow-ups: **no destructive PostgreSQL test may run, S1's included, until all five are corrected and their regression tests pass.** They are low severity individually, but S1 adds many destructive tests and they all go through these helpers. Corrections to the Phase 1.3 acceptance-review findings:

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
| **Real PostgreSQL: schema** | Trigger rejects every illegal transition (including anything into `DISPATCHING` from other than `PREPARED`, `IN_DOUBT -> DISPATCHING`, any exit from a terminal state, `QUEUED -> PREPARED` on an `OBSERVE` row); frozen and write-once columns; **JSONB CHECKs reject a malformed payload** (wrong order, two transactions, `fullRefund:true`, line items, wrong currency, key mismatch); shape trigger rejects extra keys; format CHECKs; `sourceOrderId <> primaryOrderId`; unique constraints; event table rejects update and delete; the control CHECK (`dispatchEnabled` implies `admissionEnabled`) |
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
| **Restore and truncation** | The local row is gone but Shopify (fake) holds a refund: re-admission gives `INELIGIBLE`; a restored `PREPARED` row aborts at R2 (fake) |
| **Read-back (seeded rows, fake Shopify)** | Lag (missing, then visible) does not go to review; contradictions do; adoption validates identity, amounts, currency, parent, gateway and timing; `PENDING`, `FAILURE`, `ERROR` and unsupported statuses are handled distinctly; absence never resolves; refund list of 50 or more goes to review; aggregate check is skipped when other refunds exist |
| **Session** | The worker never refreshes tokens; a shop with an expiring session is skipped |
| **Provisioning prerequisites** | Section 19.4 regression tests |
| **Operator CLI** | Dry-run default; `--apply` required; audit events written; `resolve` refuses without actor, note and hash confirmation |

### 20.2 Required for S2 (specified now)

Wire-count test (exactly one request under 429, 503, connection reset, abort and timeout); injected lost commit acknowledgement at T3 sends nothing; the permit is single-use and expires; no send from a `DISPATCHING` row; N workers racing at T3 yield one dispatch and the caps hold; response classification table with fault injection (response dropped after apply, 5xx before apply, slow response, duplicate echo, user errors, malformed body, `PENDING`/`FAILURE` transactions, extra refund appears, two refunds with our marker); two-process crash at each row of section 13; document hash and `documentSha256` pin; template-fallback rendering test if the fallback is chosen; **N5:** a tripped breaker, a reached cap or a missing approval leave the row waiting with `attempts` unchanged for longer than the old 24 hours and the row still dispatches once capacity returns, while a gate inequality aborts it; `PREPARED` rows abort only at the seven-day horizon; **N12:** two offline-looking session rows for one shop, the guard follows the library's `getOfflineId` lookup; the S2 migration test shows `PREPARED -> DISPATCHING` is accepted only after it is applied.

### 20.3 Dev-store sequence (S3)

Happy path; crash at each point using injected hooks; response lost through a local forwarding proxy that applies the request but drops the response; two workers racing; switch, opt-out and approval changes mid-flight; a manual merchant refund before dispatch; a prior shipping refund; taxed shipping (confirm refusal only); split payment, gift card and multiple captures; caps and breaker.

---

## 21. Migration safety and deployment sequencing

- **S1 migration**, `…_shipping_refund_execution`: additive. It creates only new objects and seeds the control singleton fully off. It touches no existing table, so it cannot affect merging. Its transition trigger deliberately omits `PREPARED -> DISPATCHING`.
- **S2 migration**, `…_shipping_refund_dispatch_edge`, created and reviewed with S2: replaces the transition trigger function to add that single edge. It adds no table and changes no data.
- The migration is tested on disposable databases only, through the Phase 1.3 preflight. A migration test confirms the triggers and constraints on a fresh database.
- **Production deployments run migrations automatically (F9), by a merge into a deployed branch or by a manual `railway up`.** Therefore: S1 and S2 stay on the feature branch; no merge into a deployed branch and no manual upload-and-deploy happens before G-MIGRATE-PROD; the pull request must say so; the approval covers the exact migration chain pending for production, including the existing Phase 1 shipping migrations if not yet applied, and both Phase 2 migrations if the build contains them. The operator rules and the inert-if-accidental analysis are in section 18.
- After a production migration the feature remains inert: control off, no approvals, no environment flag. Code rollback is safe because the tables are additive and unused when the controls are off.

---

## 22. Unresolved experiment and release gates

| Gate | What it resolves |
|---|---|
| G-EVIDENCE | E0/E1/E2/E6 evidence archived (section 17) |
| G-INTROSPECT | Read-only introspection confirming the `@idempotent` directive's `key: String!` argument and field location in 2026-04 |
| G-READBACK | Read-only validation of Q-APPID, Q-RECHECK, Q-RECONCILE and Q-AGREEMENTS (section 12.1), each by its exact text and sha256, on the approved development store. Confirms the array-versus-connection shapes, `nodes`/`pageInfo` handling, nullable `createdAt`, `processedAt`, presentment money and `RefundAgreement` selection. **Mandatory before S1's reconciliation and recheck portions are accepted** (moved ahead of S1 acceptance in Revision 3) |
| G-AGREEMENT | Part A (read-only): do the existing E1/E2/E6 app-created refunds carry a `RefundAgreement` with the expected `app.id`? Mandatory with G-READBACK before S1 acceptance. Part B (inside G-E7): first dispatcher-created refund. Mandatory before S3. NEGATIVE stops the design pending a separately reviewed alternative (section 12.8) |
| G-UNINSTALL (N4) | The reviewed uninstall fix and failure-injection tests (section 18.1). Mandatory before S3.5 and G-PILOT |
| G-E7 | Approved dev-store `refundCreate` experiment: variable-key acceptance, replay behavior, parameter mismatch, concurrent request, and the actual shape of idempotency errors (`userErrors` versus top-level) |
| G-REAL | Real-gateway refund behavior: `PENDING`, failed and declined refunds, transaction shapes, fees |
| G-GATEWAY-POLICY | Reviewed relaxation of the bogus-only policy |
| G-E3 | Taxable shipping (kept restricted: tax-bearing and tax-inclusive orders remain `INELIGIBLE`) |
| G-OPS, G-MERCHANT, G-MIGRATE-PROD, G-PILOT | Section 18 |

Standing unverified assumptions: whether the proposed queries run as written (all UNVALIDATED, section 12.1); whether an app-created refund produces a `RefundAgreement` with the app id (G-AGREEMENT); whether a refund `note` is returned verbatim and immutable (G-READBACK); whether pending refunds are counted in order aggregates (aggregates are therefore anomaly-only); how Shopify throttling interacts with an in-flight refund (any throttled response goes to `IN_DOUBT`, which at pilot volume means rare manual work).

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

### Query validation status at the time of this revision

| Document | Proposed in this revision | Independently validated |
|---|---|---|
| Q-APPID, Q-RECHECK, Q-RECONCILE, Q-AGREEMENTS | yes (section 12.1) | **no** |
| `@idempotent` variable form for `refundCreate` | yes (section 10.1) | **no** |
| Evaluator queries | existing code | reported in code comments, evidence not archived |

This revision records **no** successful API validation. Section 22 lists the gates that will produce it.
