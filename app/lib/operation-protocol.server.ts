// ── Operation protocol driver (spec §5) ──────────────────────────────────────
// driveOperation runs an operation's phase machine until a waiting point: a
// terminal phase, or a nextCheckAt in the future. It is the ONLY path by which
// an order-affecting Shopify request is sent: every dispatch goes through
// ops.openDispatchGate (a write-ahead MergeMutationAttempt row exists before
// the request leaves), and every applied-edit or cancellation is reconciled
// from Shopify evidence — never assumed, never re-dispatched
// (RECOMMIT_SAME_CALC is off).
//
// The op lease is renewed (and deps.outerFence re-checked) before EVERY
// Shopify call. OwnershipLostError anywhere => return null and write nothing.

import { gql, ShopifyGraphqlError, type AdminClient } from "./graphql.server";
import { newLeaseToken, OwnershipLostError } from "./ownership.server";
import {
  evaluateMergeGroup,
  REVIEW_TAG,
  type OrderState,
} from "./eligibility";
import {
  fetchAllLineItems,
  fetchOrderStates,
  fetchLineItemsById,
  ORDER_STATE_QUERY,
  resolveMergeLocation,
  verifyCalculatedOrder,
  type MergeDeps,
} from "./merge.server";
import { resolveAppId, verifyTransferEvidence, type AppliedEvidence } from "./evidence.server";
import type {
  AttemptKind,
  MutationAttempt,
  OperationPatch,
  OperationRecord,
  OperationSecondary,
} from "./operation-store.server";

// Ladders and quiet periods (spec §5).
export const EVIDENCE_LADDER_MS = [30_000, 120_000, 300_000, 900_000, 3_600_000];
export const CANCEL_LADDER_MS = [30_000, 120_000, 300_000, 900_000, 3_600_000];
export const QUIET_PERIOD_MS = 15 * 60_000;
export const GATE_RETRY_MS = 60_000;
export const CANCEL_RETRY_MS = 120_000;
export const REVIEW_CHECK_MS = 24 * 60 * 60_000;
export const REVIEW_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export const SIDE_EFFECT_RETRY_MS = 300_000;
export const MAX_SIDE_EFFECT_PASSES = 3;
export const READ_RETRY_MS = 60_000;

const MERGED_TAG = "Merged";
const CONSOLIDATED_TAG = "Consolidated";

const COMMIT_MUTATION = `#graphql
  mutation MergeEditCommit($id: ID!, $staffNote: String) {
    orderEditCommit(id: $id, notifyCustomer: false, staffNote: $staffNote) {
      order { id }
      userErrors { field message }
    }
  }`;

const CANCEL_MUTATION = `#graphql
  mutation MergeCancelSecondary($orderId: ID!, $staffNote: String!) {
    orderCancel(
      orderId: $orderId
      reason: OTHER
      notifyCustomer: false
      restock: true
      refundMethod: { originalPaymentMethodsRefund: false }
      staffNote: $staffNote
    ) {
      job { id }
      orderCancelUserErrors { field message }
    }
  }`;

const JOB_QUERY = `#graphql
  query MergeJob($id: ID!) {
    job(id: $id) { done }
  }`;

const TAGS_ADD_MUTATION = `#graphql
  mutation MergeTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }`;

const NOTE_MUTATION = `#graphql
  mutation MergeAnnotateNote($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id note }
      userErrors { field message }
    }
  }`;

const CLOSE_MUTATION = `#graphql
  mutation MergeOrderClose($input: OrderCloseInput!) {
    orderClose(input: $input) {
      order { id closedAt }
      userErrors { field message }
    }
  }`;

// ── small helpers ────────────────────────────────────────────────────────────

type StepResult = "again" | "wait";

const reasonFromUnknown = (err: unknown): string =>
  err instanceof ShopifyGraphqlError ? err.message : err instanceof Error ? err.message : String(err);

interface SendResult {
  state: "SUCCEEDED" | "REJECTED" | "UNKNOWN";
  summary: string | null;
  /** The orderCancel job id when Shopify returned one. */
  jobId?: string | null;
}

/** Sends a Shopify mutation through the fenced client and classifies the
 *  outcome for the write-ahead attempt row. `ambiguous` maps a userErrors
 *  message to UNKNOWN when the wording does not prove rejection (e.g.
 *  "already been saved"). */
async function sendAttempt(
  fn: () => Promise<{ jobId?: string | null } | void>,
  ambiguous: (message: string) => boolean,
): Promise<SendResult> {
  try {
    const out = await fn();
    return { state: "SUCCEEDED", summary: null, jobId: out?.jobId ?? null };
  } catch (err) {
    if (err instanceof OwnershipLostError) throw err;
    const summary = reasonFromUnknown(err);
    if (err instanceof ShopifyGraphqlError && err.rejected) {
      return { state: ambiguous(summary) ? "UNKNOWN" : "REJECTED", summary };
    }
    return { state: "UNKNOWN", summary };
  }
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ""));

/** orderUpdate note append with the same de-duplication as v1: a line already
 *  present in the note is not repeated. */
const appendNote = (note: string | null | undefined, addition: string) => {
  const existing = (note ?? "").trim();
  return existing ? (existing.includes(addition) ? existing : `${existing}\n${addition}`) : addition;
};

/** A single order state read that tolerates a deleted order (nodes() returns
 *  null entries rather than failing). */
async function fetchOrderStateOrNull(admin: AdminClient, id: string): Promise<any | null> {
  const nodes = await gql<any[]>(admin, "Load order", ORDER_STATE_QUERY, { ids: [id] }, "nodes", null);
  return nodes?.find((n) => n?.id === id) ?? null;
}

const isWaiting = (op: OperationRecord, now: Date): boolean =>
  op.phase === "ABANDONED" ||
  (op.phase === "COMPLETED" && op.sideEffectsDone) ||
  op.nextCheckAt === null ||
  (op.nextCheckAt instanceof Date && op.nextCheckAt.getTime() > now.getTime());

// ── the driver ───────────────────────────────────────────────────────────────

/**
 * Runs `op` until a waiting point in ONE call — spec §5's fall-throughs (e.g.
 * commit dispatch → COMMIT_IN_DOUBT, or evidence APPLIED → the cancellation
 * step) happen in the same run. Returns the latest local copy of the op, or
 * null when the lease was lost mid-run.
 */
export async function driveOperation(
  op: OperationRecord,
  admin: AdminClient,
  deps: MergeDeps,
): Promise<OperationRecord | null> {
  const current: OperationRecord = { ...op };
  const fence = async () => {
    await deps.ops.renewOperation(current, deps.leaseTtlMs);
    await deps.outerFence?.();
  };
  const fenced: AdminClient = {
    graphql: async (query, options) => {
      await fence();
      return admin.graphql(query, options);
    },
  };
  let appIdPromise: Promise<string> | null = null;
  const appId = () =>
    (appIdPromise ??= deps.appId
      ? deps.appId(fenced, current.shop)
      : resolveAppId(fenced, current.shop));

  /** Lease/phase-conditional transition; also mirrors the patch locally. */
  const move = async (patch: OperationPatch): Promise<void> => {
    await deps.ops.transition(current, { expectedPhase: current.phase ?? undefined, ...patch });
    if (patch.phase !== undefined) current.phase = patch.phase;
    if (patch.secondaries !== undefined) current.secondaries = patch.secondaries;
    if (patch.appliedEvidence !== undefined) current.appliedEvidence = patch.appliedEvidence;
    if (patch.reviewReason !== undefined) current.reviewReason = patch.reviewReason;
    if (patch.lastError !== undefined) current.lastError = patch.lastError;
    if (patch.attempts !== undefined) current.attempts = patch.attempts;
    if (patch.firstDispatchAt === "now") current.firstDispatchAt = deps.now();
    if (patch.phase === "REVIEW_REQUIRED") current.reviewRequiredAt = deps.now();
    if (patch.phase === "COMPLETED") current.sideEffectsDone = false;
    if (patch.nextCheckAt !== undefined) {
      current.nextCheckAt =
        patch.nextCheckAt === null
          ? null
          : patch.nextCheckAt === "now"
            ? deps.now()
            : patch.nextCheckAt instanceof Date
              ? patch.nextCheckAt
              : new Date(deps.now().getTime() + patch.nextCheckAt);
    }
  };

  for (let i = 0; i < 40; i++) {
    try {
      switch (current.phase) {
        case "READY":
          if ((await stepReady()) === "wait") return current;
          break;
        case "COMMIT_IN_DOUBT":
          if ((await stepCommitInDoubt()) === "wait") return current;
          break;
        case "COMMIT_REJECTED":
          if ((await stepCommitRejected()) === "wait") return current;
          break;
        case "APPLIED":
          if ((await stepApplied()) === "wait") return current;
          break;
        case "COMPLETED":
          if ((await stepCompleted()) === "wait") return current;
          break;
        case "REVIEW_REQUIRED":
          if ((await stepReviewRequired()) === "wait") return current;
          break;
        default:
          return current; // terminal / unknown
      }
    } catch (err) {
      if (err instanceof OwnershipLostError) return null;
      if (err instanceof ShopifyGraphqlError && !err.rejected) {
        // Transient Shopify read failure: retry shortly, keep the phase.
        try {
          await move({ nextCheckAt: READ_RETRY_MS, lastError: err.message });
        } catch (inner) {
          if (inner instanceof OwnershipLostError) return null;
          throw inner;
        }
        return current;
      }
      throw err;
    }
    if (isWaiting(current, deps.now())) return current;
  }
  console.error(`[op ${current.id}] driveOperation exceeded its step bound; stopping`);
  return current;

  // ── READY: re-verify everything, gate, commit ───────────────────────────

  async function stepReady(): Promise<StepResult> {
    const failReason = await readyPreconditionFailure();
    if (failReason) {
      console.error(`[op ${current.id}] READY precondition failed → ABANDONED: ${failReason}`);
      await move({ phase: "ABANDONED", lastError: failReason, nextCheckAt: null });
      return "wait";
    }
    const dispatchToken = newLeaseToken();
    const attempt = await deps.ops.openDispatchGate({
      op: current,
      kind: "EDIT_COMMIT",
      targetOrderId: current.primaryOrderId,
      dispatchToken,
      requiredPhase: "READY",
    });
    if (!attempt) {
      await move({ nextCheckAt: GATE_RETRY_MS, lastError: "Dispatch gate refused the commit." });
      return "wait";
    }
    await deps.hooks?.afterDispatchGate?.();
    const names = current.secondaries.map((s) => s.name).join(", ");
    const staffNote = `MergeShip: merged items from ${names} · MS-${current.opToken}`;
    const result = await sendAttempt(
      () =>
        gql(
          fenced,
          `Commit merge ${current.primaryOrderName}`,
          COMMIT_MUTATION,
          { id: current.calculatedOrderId, staffNote },
          "orderEditCommit",
        ).then(() => undefined),
      (message) => /already been saved/i.test(message),
    );
    await deps.hooks?.afterSend?.();
    await deps.hooks?.beforeAttemptRecord?.();
    await deps.ops.recordAttempt(attempt.id, dispatchToken, result.state, result.summary);
    // The gate already flipped the phase to COMMIT_IN_DOUBT — mirror it and
    // fall through so the first evidence check happens in the same run.
    current.phase = "COMMIT_IN_DOUBT";
    if (current.firstDispatchAt == null) current.firstDispatchAt = deps.now();
    return "again";
  }

  /** Null when the op may commit; a failure reason → ABANDONED otherwise.
   *  An order that no longer exists is a precondition failure (the merge can
   *  never happen), while other read failures stay transient. */
  async function readyPreconditionFailure(): Promise<string | null> {
    let orders: OrderState[];
    try {
      orders = await fetchOrderStates(fenced, current.involvedOrderIds);
    } catch (err) {
      if (
        err instanceof ShopifyGraphqlError &&
        !err.rejected &&
        err.message.startsWith("Could not load every order")
      ) {
        return "An involved order could no longer be loaded — it may have been deleted.";
      }
      throw err;
    }
    const items = await fetchLineItemsById(fenced, orders);
    const evaluated = evaluateMergeGroup(orders, items);
    if (!evaluated.ok) return evaluated.reason;
    if (evaluated.primary.id !== current.primaryOrderId) {
      return "A different order would be the primary now; the recorded transfer no longer applies.";
    }
    const primaryItems = items.get(current.primaryOrderId) ?? [];
    const before = new Set(current.primaryLineItemIdsBefore);
    const nowIds = new Set(primaryItems.map((i) => i.id).filter(Boolean));
    if (before.size !== nowIds.size || [...before].some((id) => !nowIds.has(id))) {
      return "The primary order's line items changed since the merge was planned.";
    }
    const location = await resolveMergeLocation(fenced, orders, items);
    if (!location.ok) return location.reason;
    if ((location.locationId ?? null) !== (current.expectedLocationId ?? null)) {
      return "The fulfillment location changed since the merge was planned.";
    }
    return verifyCalculatedOrder(fenced, current.calculatedOrderId, current.expectedTransfer);
  }

  // ── COMMIT_IN_DOUBT: evidence ladder ────────────────────────────────────

  async function stepCommitInDoubt(): Promise<StepResult> {
    const attempts = await deps.ops.listAttempts(current.id, "EDIT_COMMIT");
    if (attempts.length > 0 && attempts.every((a) => a.state === "REJECTED")) {
      const last = Math.max(...attempts.map((a) => a.respondedAt?.getTime() ?? 0));
      await move({
        phase: "COMMIT_REJECTED",
        lastError: attempts.at(-1)?.responseSummary ?? "orderEditCommit was rejected.",
        nextCheckAt: new Date(last + QUIET_PERIOD_MS),
      });
      return "wait";
    }
    const evidence = await verifyTransferEvidence(fenced, current, await appId());
    if (evidence.kind === "APPLIED") {
      await move({
        phase: "APPLIED",
        appliedEvidence: evidence.evidence,
        secondaries: current.secondaries.map((s) =>
          s.cancelPhase === "CANCEL_VERIFIED" ? s : { ...s, cancelPhase: "CANCEL_READY" },
        ),
        nextCheckAt: "now",
      });
      return "again";
    }
    if (evidence.kind === "ANOMALY") {
      await move({
        phase: "REVIEW_REQUIRED",
        reviewReason: evidence.reason,
        nextCheckAt: "now",
      });
      return "again";
    }
    // NONE — next evidence-ladder slot, or REVIEW_REQUIRED once 60 minutes
    // have passed since the first dispatch (then daily checks for 7 days).
    const base = current.firstDispatchAt?.getTime();
    if (base == null) {
      await move({
        phase: "REVIEW_REQUIRED",
        reviewReason: "Commit outcome unknown and no dispatch time was recorded.",
        nextCheckAt: "now",
      });
      return "again";
    }
    const slot = EVIDENCE_LADDER_MS.find((t) => deps.now().getTime() - base < t);
    if (slot !== undefined) {
      await move({ nextCheckAt: new Date(base + slot) });
      return "wait";
    }
    await move({
      phase: "REVIEW_REQUIRED",
      reviewReason: "Commit outcome unknown; no evidence of the transfer after 60 minutes.",
      nextCheckAt: "now",
    });
    return "again";
  }

  // ── COMMIT_REJECTED: quiet-period evidence check ────────────────────────

  async function stepCommitRejected(): Promise<StepResult> {
    const evidence = await verifyTransferEvidence(fenced, current, await appId());
    if (evidence.kind === "APPLIED") {
      await move({
        phase: "APPLIED",
        appliedEvidence: evidence.evidence,
        secondaries: current.secondaries.map((s) =>
          s.cancelPhase === "CANCEL_VERIFIED" ? s : { ...s, cancelPhase: "CANCEL_READY" },
        ),
        reviewReason: null,
        nextCheckAt: "now",
      });
      return "again";
    }
    if (evidence.kind === "NONE" && !evidence.mergeShipAgreementInWindow) {
      await move({
        phase: "ABANDONED",
        lastError: "The commit was rejected and no transfer evidence appeared.",
        nextCheckAt: null,
      });
      return "wait";
    }
    await move({
      phase: "REVIEW_REQUIRED",
      reviewReason:
        evidence.kind === "ANOMALY"
          ? evidence.reason
          : "The commit was rejected but a MergeShip edit agreement exists — evidence is ambiguous.",
      nextCheckAt: "now",
    });
    return "again";
  }

  // ── APPLIED: cancellation protocol ──────────────────────────────────────

  async function stepApplied(): Promise<StepResult> {
    const cancelAttempts = await deps.ops.listAttempts(current.id, "ORDER_CANCEL");
    const secondaries: OperationSecondary[] = current.secondaries.map((s) => ({ ...s }));

    for (;;) {
      const s = secondaries.find((x) => x.cancelPhase !== "CANCEL_VERIFIED");
      if (!s) {
        await move({ phase: "COMPLETED", secondaries, nextCheckAt: SIDE_EFFECT_RETRY_MS });
        return "again";
      }
      const sAttempts = cancelAttempts.filter((a) => a.targetOrderId === s.id);
      const last = sAttempts.at(-1);
      const inDoubt = last != null && last.state !== "REJECTED";

      if (s.cancelPhase === "CANCEL_IN_DOUBT" || inDoubt) {
        // One verification read per run, on the per-attempt ladder.
        const outcome = await verifyCancel(s, secondaries);
        if (outcome === "verified") continue;
        if (outcome === "again") return "again";
        const base = (last?.dispatchedAt ?? deps.now()).getTime();
        if (last?.state === "SUCCEEDED" && last.jobId) {
          try {
            await gql(fenced, `Poll cancellation of ${s.name}`, JOB_QUERY, { id: last.jobId }, "job", null);
          } catch (err) {
            if (err instanceof OwnershipLostError) throw err;
            // A failed job read does not reset the ladder.
          }
        }
        const slot = CANCEL_LADDER_MS.find((t) => deps.now().getTime() - base < t);
        if (slot !== undefined) {
          await move({ secondaries, nextCheckAt: new Date(base + slot) });
          return "wait";
        }
        s.cancelPhase = "CANCEL_REVIEW";
        await move({
          phase: "REVIEW_REQUIRED",
          secondaries,
          reviewReason: `Cancellation of ${s.name} was requested but never confirmed.`,
          nextCheckAt: "now",
        });
        return "again";
      }

      if (sAttempts.filter((a) => a.state === "REJECTED").length >= 3) {
        s.cancelPhase = "CANCEL_REVIEW";
        await move({
          phase: "REVIEW_REQUIRED",
          secondaries,
          reviewReason: `Shopify rejected cancelling ${s.name} repeatedly.`,
          nextCheckAt: "now",
        });
        return "again";
      }

      // CANCEL_READY preconditions: token lines intact on the primary, the
      // secondary still open/unfulfilled/uncancelled.
      const precheck = await cancelPrecondition(s, secondaries);
      if (precheck === "verified") continue; // history already written
      if (precheck !== null) {
        s.cancelPhase = "CANCEL_REVIEW";
        await move({ phase: "REVIEW_REQUIRED", secondaries, reviewReason: precheck, nextCheckAt: "now" });
        return "again";
      }

      const dispatchToken = newLeaseToken();
      const attempt = await deps.ops.openDispatchGate({
        op: current,
        kind: "ORDER_CANCEL",
        targetOrderId: s.id,
        dispatchToken,
        requiredPhase: "APPLIED",
      });
      if (!attempt) {
        await move({ secondaries, nextCheckAt: GATE_RETRY_MS });
        return "wait";
      }
      await deps.hooks?.afterDispatchGate?.();
      const staffNote = `Repeat order merged into ${current.primaryOrderName} by MergeShip. Items transferred, inventory restocked, not refunded. Ref MS-${current.opToken}`;
      const result = await sendAttempt(async () => {
        const res = await gql<{ job?: { id?: string } | null }>(
          fenced,
          `Cancel ${s.name}`,
          CANCEL_MUTATION,
          { orderId: s.id, staffNote },
          "orderCancel",
          "orderCancelUserErrors",
        );
        return { jobId: res.job?.id ?? null };
      }, () => false);
      await deps.hooks?.afterSend?.();
      await deps.hooks?.beforeAttemptRecord?.();
      await deps.ops.recordAttempt(attempt.id, dispatchToken, result.state, result.summary, result.jobId);

      if (result.state === "REJECTED") {
        // Stay CANCEL_READY; the gate's <3-rejected guard bounds retries.
        await move({ secondaries, nextCheckAt: CANCEL_RETRY_MS });
        return "wait";
      }

      s.cancelPhase = "CANCEL_IN_DOUBT";
      await move({ secondaries, nextCheckAt: "now" });
      // Inline poll for the cancellation becoming visible before relying on
      // the ladder (orderCancel is asynchronous).
      for (let poll = 0; poll < deps.cancelPollAttempts; poll++) {
        if (poll > 0) await deps.sleep(deps.cancelPollIntervalMs);
        const outcome = await verifyCancel(s, secondaries);
        if (outcome === "verified") break;
        if (outcome === "again") return "again";
      }
      if ((s.cancelPhase as OperationSecondary["cancelPhase"]) === "CANCEL_VERIFIED") continue;
      const base = attempt.dispatchedAt.getTime();
      const slot = CANCEL_LADDER_MS.find((t) => deps.now().getTime() - base < t);
      if (slot !== undefined) {
        await move({ secondaries, nextCheckAt: new Date(base + slot) });
        return "wait";
      }
      s.cancelPhase = "CANCEL_REVIEW";
      await move({
        phase: "REVIEW_REQUIRED",
        secondaries,
        reviewReason: `Cancellation of ${s.name} was requested but never confirmed.`,
        nextCheckAt: "now",
      });
      return "again";
    }
  }

  /** Reads the secondary: "verified" = cancelled by us + history written;
   *  "again" = a review transition was taken; "pending" = still uncancelled. */
  async function verifyCancel(
    s: OperationSecondary,
    secondaries: OperationSecondary[],
  ): Promise<"verified" | "again" | "pending"> {
    const st = await fetchOrderStateOrNull(fenced, s.id);
    if (!st?.cancelledAt) return "pending";
    if (!(st.cancellation?.staffNote ?? "").includes(`MS-${current.opToken}`)) {
      s.cancelPhase = "CANCEL_REVIEW";
      await move({
        phase: "REVIEW_REQUIRED",
        secondaries,
        reviewReason: `${s.name} was cancelled outside MergeShip — check whether the customer was refunded.`,
        nextCheckAt: "now",
      });
      return "again";
    }
    await deps.hooks?.beforeHistoryTx?.();
    await deps.ops.recordHistoryAndVerifyCancel(
      { ...current, secondaries },
      s.id,
      { cancelledAt: iso(st.cancelledAt) },
    );
    s.cancelPhase = "CANCEL_VERIFIED";
    return "verified";
  }

  /** Null = safe to dispatch a cancel for `s`. "verified" = already cancelled
   *  by us and history written. A string = a reason for REVIEW_REQUIRED. */
  async function cancelPrecondition(
    s: OperationSecondary,
    secondaries: OperationSecondary[],
  ): Promise<string | "verified" | null> {
    const st = await fetchOrderStateOrNull(fenced, s.id);
    if (!st) return `${s.name} could no longer be loaded.`;
    if (st.cancelledAt) {
      if ((st.cancellation?.staffNote ?? "").includes(`MS-${current.opToken}`)) {
        await deps.hooks?.beforeHistoryTx?.();
        await deps.ops.recordHistoryAndVerifyCancel(
          { ...current, secondaries },
          s.id,
          { cancelledAt: iso(st.cancelledAt) },
        );
        s.cancelPhase = "CANCEL_VERIFIED";
        return "verified";
      }
      return `${s.name} was cancelled outside MergeShip — check whether the customer was refunded.`;
    }
    if (st.closed) return `${s.name} is closed; cancelling it is no longer possible.`;
    if (st.displayFulfillmentStatus !== "UNFULFILLED") {
      return `${s.name} shows fulfillment activity (${st.displayFulfillmentStatus ?? "unknown"}); a human must decide.`;
    }
    if ((st.fulfillments?.length ?? 0) > 0) {
      return `${s.name} has fulfillment objects; a human must decide.`;
    }
    const evidence = (current.appliedEvidence ?? null) as AppliedEvidence | null;
    const evLines = (evidence?.lines ?? []).filter((l) => l.secondaryId === s.id);
    if (!evLines.length) {
      return `No applied evidence was recorded for ${s.name}; its transferred lines cannot be verified.`;
    }
    const items = await fetchAllLineItems(fenced, current.primaryOrderId);
    for (const line of evLines) {
      const item = items.find((i) => i.id === line.lineItemId);
      const qty = item ? (item.currentQuantity ?? item.quantity) : null;
      if (!item || qty !== line.quantity) {
        return `A transferred line item for ${s.name} was edited on the primary; the transfer is not intact.`;
      }
    }
    return null;
  }

  // ── COMPLETED: one-shot side effects (§7) ───────────────────────────────

  async function stepCompleted(): Promise<StepResult> {
    if (current.sideEffectsDone) return "wait";
    const allDone = await completionSideEffects();
    if (allDone) {
      const ok = await deps.ops.markSideEffectsDone(current);
      if (!ok) throw new OwnershipLostError("Operation lease lost while finishing side effects.");
      current.sideEffectsDone = true;
      current.nextCheckAt = null;
      return "wait";
    }
    const attempts = (current.attempts ?? 0) + 1;
    if (attempts >= MAX_SIDE_EFFECT_PASSES) {
      console.error(`[op ${current.id}] side effects incomplete after ${attempts} passes; giving up`);
      await move({ attempts, nextCheckAt: null });
      return "wait";
    }
    await move({ attempts, nextCheckAt: SIDE_EFFECT_RETRY_MS });
    return "wait";
  }

  /** Runs every missing cosmetic side effect through the dispatch gate.
   *  Returns true when nothing remains (sent or its attempt cap reached). */
  async function completionSideEffects(): Promise<boolean> {
    const annotateAttempts = await deps.ops.listAttempts(current.id, "ANNOTATE");
    const closeAttempts = await deps.ops.listAttempts(current.id, "CLOSE");
    const states = await fetchOrderStates(fenced, current.involvedOrderIds);
    const byId = new Map(states.map((o) => [o.id, o]));
    let allDone = true;

    const done = (list: MutationAttempt[], targetId: string) =>
      list.some((a) => a.targetOrderId === targetId && a.state === "SUCCEEDED") ||
      list.filter((a) => a.targetOrderId === targetId && a.state === "REJECTED").length >= 3;

    const run = async (
      kind: AttemptKind,
      targetId: string,
      list: MutationAttempt[],
      send: () => Promise<void>,
    ): Promise<boolean> => {
      if (done(list, targetId)) return true;
      const dispatchToken = newLeaseToken();
      const attempt = await deps.ops.openDispatchGate({
        op: current,
        kind,
        targetOrderId: targetId,
        dispatchToken,
        requiredPhase: "COMPLETED",
      });
      if (!attempt) return false;
      await deps.hooks?.afterDispatchGate?.();
      const result = await sendAttempt(send, () => false);
      await deps.hooks?.afterSend?.();
      await deps.ops.recordAttempt(attempt.id, dispatchToken, result.state, result.summary);
      return result.state === "SUCCEEDED";
    };

    // Secondaries: tag "Merged" + consolidation note, then close.
    for (const s of current.secondaries.filter((x) => x.cancelPhase === "CANCEL_VERIFIED")) {
      const o = byId.get(s.id);
      if (!o) continue;
      const note = appendNote(
        o.note,
        `Consolidated into primary order ${current.primaryOrderName} by MergeShip`,
      );
      if (
        !(await run("ANNOTATE", s.id, annotateAttempts, async () => {
          await gql(fenced, `Tag ${s.name}`, TAGS_ADD_MUTATION, { id: s.id, tags: [MERGED_TAG] }, "tagsAdd");
          await gql(fenced, `Note ${s.name}`, NOTE_MUTATION, { input: { id: s.id, note } }, "orderUpdate");
        }))
      ) {
        allDone = false;
      }
      if (
        !(await run("CLOSE", s.id, closeAttempts, () =>
          gql(fenced, `Close ${s.name}`, CLOSE_MUTATION, { input: { id: s.id } }, "orderClose").then(
            () => undefined,
          ),
        ))
      ) {
        allDone = false;
      }
    }

    // Primary: carry the secondaries' merchant tags and note lines over.
    const p = byId.get(current.primaryOrderId);
    if (p) {
      const secondaryStates = current.secondaries
        .map((s) => ({ s, o: byId.get(s.id) }))
        .filter((x): x is { s: OperationSecondary; o: OrderState } => Boolean(x.o));
      const carriedNotes = secondaryStates.flatMap(({ s, o }) =>
        (o.note ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter(
            (line) =>
              line &&
              !line.startsWith("MergeShip") &&
              !line.startsWith("Consolidated into primary order"),
          )
          .map((line) => `Note from ${s.name}: ${line}`),
      );
      const carriedTags = secondaryStates
        .flatMap(({ o }) => o.tags ?? [])
        .filter((t) => !["merged", REVIEW_TAG.toLowerCase()].includes(t.trim().toLowerCase()));
      const names = current.secondaries.map((s) => s.name).join(", ");
      const note = [
        (p.note ?? "").trim(),
        ...carriedNotes.filter((line) => !(p.note ?? "").includes(line)),
        `MergeShip: merged items from ${names} (already paid; shipping was not refunded).`,
      ]
        .filter(Boolean)
        .join("\n");
      if (
        !(await run("ANNOTATE", p.id, annotateAttempts, async () => {
          await gql(
            fenced,
            `Tag ${p.name}`,
            TAGS_ADD_MUTATION,
            { id: p.id, tags: [...new Set([...carriedTags, CONSOLIDATED_TAG])] },
            "tagsAdd",
          );
          await gql(fenced, `Note ${p.name}`, NOTE_MUTATION, { input: { id: p.id, note } }, "orderUpdate");
        }))
      ) {
        allDone = false;
      }
    }
    return allDone;
  }

  // ── REVIEW_REQUIRED: tag once, re-check evidence, maybe resume ──────────

  async function stepReviewRequired(): Promise<StepResult> {
    const tagAttempts = await deps.ops.listAttempts(current.id, "REVIEW_TAG");
    const states = await fetchOrderStates(fenced, current.involvedOrderIds);
    const byId = new Map(states.map((o) => [o.id, o]));
    const targets = [
      current.primaryOrderId,
      ...current.secondaries.filter((s) => s.cancelPhase !== "CANCEL_VERIFIED").map((s) => s.id),
    ];
    for (const targetId of targets) {
      const tAttempts = tagAttempts.filter((a) => a.targetOrderId === targetId);
      // §7: at most 3 REVIEW_TAG attempts per order; a SUCCEEDED one is done.
      if (tAttempts.some((a) => a.state === "SUCCEEDED") || tAttempts.length >= 3) continue;
      const dispatchToken = newLeaseToken();
      const attempt = await deps.ops.openDispatchGate({
        op: current,
        kind: "REVIEW_TAG",
        targetOrderId: targetId,
        dispatchToken,
        requiredPhase: "REVIEW_REQUIRED",
      });
      if (!attempt) continue; // cap reached or completion disabled — retry later
      await deps.hooks?.afterDispatchGate?.();
      const o = byId.get(targetId);
      const name = o?.name ?? targetId;
      const note = appendNote(
        o?.note,
        `MergeShip: a merge involving this order needs review. (Ref MS-${current.opToken})`,
      );
      const result = await sendAttempt(async () => {
        await gql(fenced, `Tag ${name}`, TAGS_ADD_MUTATION, { id: targetId, tags: [REVIEW_TAG] }, "tagsAdd");
        if (note) {
          await gql(fenced, `Note ${name}`, NOTE_MUTATION, { input: { id: targetId, note } }, "orderUpdate");
        }
      }, () => false);
      await deps.hooks?.afterSend?.();
      await deps.ops.recordAttempt(attempt.id, dispatchToken, result.state, result.summary);
    }

    // Evidence re-check: a late-applying edit resumes the op automatically —
    // but only while every unverified secondary is still safely cancellable.
    const evidence = await verifyTransferEvidence(fenced, current, await appId());
    if (evidence.kind === "APPLIED") {
      const pending = current.secondaries.filter((s) => s.cancelPhase !== "CANCEL_VERIFIED");
      const allSafe = pending.every((s) => {
        // A CANCEL_REVIEW secondary was deliberately parked (failed
        // precondition or rejected-cancel cap) — resuming it would ping-pong
        // APPLIED ↔ REVIEW_REQUIRED forever.
        if (s.cancelPhase === "CANCEL_REVIEW") return false;
        const st = byId.get(s.id);
        return (
          st != null &&
          !st.cancelledAt &&
          !st.closed &&
          st.displayFulfillmentStatus === "UNFULFILLED" &&
          (st.fulfillments?.length ?? 0) === 0
        );
      });
      if (allSafe) {
        await move({
          phase: "APPLIED",
          appliedEvidence: current.appliedEvidence ?? evidence.evidence,
          secondaries: current.secondaries.map((s) =>
            s.cancelPhase === "CANCEL_VERIFIED" ? s : { ...s, cancelPhase: "CANCEL_READY" },
          ),
          reviewReason: null,
          nextCheckAt: "now",
        });
        return "again";
      }
    }

    const reviewedAt = current.reviewRequiredAt?.getTime() ?? deps.now().getTime();
    await move({
      nextCheckAt:
        deps.now().getTime() + REVIEW_CHECK_MS > reviewedAt + REVIEW_MAX_AGE_MS
          ? null
          : REVIEW_CHECK_MS,
    });
    return "wait";
  }
}
