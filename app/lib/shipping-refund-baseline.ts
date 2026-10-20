// ── Shipping v0 Phase 2, S1-E: the §8.2 execution recheck and refund baseline ──
// docs/SHIPPING-PHASE2-DESIGN.md Revision 3.3, sections 8.2–8.2.6 and 8.4.
//
// Pure module: no I/O, no database, no Shopify, no timers. It consumes raw
// GraphQL response bodies (Q-RECHECK / Q-REFUND-DETAIL) obtained by the
// caller and returns data — never a write, never an authorization.
//
// The financial baseline is captured at the freeze and stored in
// `preEvidence.baseline`. `REFUND_BASELINE_MODE` is STRICT_EMPTY — the only
// mode S1 implements (8.2.3): any refund record at all, any prior monetary
// refund, or any previously refunded shipping is
// INELIGIBLE(PRIOR_REFUND_RECORD); completeness that cannot be proven is
// INELIGIBLE(BASELINE_UNVERIFIED). The tolerant mode is not coded.
//
// `compareBaselineAtR2` is the pure half of the S2 pre-dispatch recheck
// (8.2.5). In S1 it is contained and tested on controlled fixtures only; no
// runtime path may call it against a live PREPARED row (19.5 single rule).

import { getCurrencyPrecision, parseShopMoney } from "./money";
import { MARKER_PREFIX } from "./shipping-refund-contract";
import { validateExecRecheck } from "./shipping-refund-queries";

/** The only implemented baseline mode (8.2.3). Pinned by a test; a change to
 *  this constant is a reviewed change. There is no tolerant predicate. */
export const REFUND_BASELINE_MODE = "STRICT_EMPTY" as const;

// ── Reason codes (7.4 outcome vocabulary for the execution recheck) ───────

export type ExecRecheckReasonCode =
  | "BASELINE_UNVERIFIED"        // completeness/shape of history unproven
  | "PRIOR_REFUND_RECORD"        // any refund record / monetary refund / refunded shipping
  | "PRIOR_REFUNDED_SHIPPING"    // refunded-shipping aggregate or shipping lines nonzero
  | "CURRENCY_MISMATCH"          // source/primary or money currency disagreement
  | "PRIMARY_INELIGIBLE"         // primary cancelled, refunded or voided
  | "SOURCE_STATE_CHANGED"       // source no longer cancelled or no longer PAID
  | "TRANSACTION_EVIDENCE_UNSUPPORTED" // payment history outside 8.2.4's rule
  | "RECHECK_INCONSISTENT";      // two consecutive recheck reads disagree (transient)

// ── 8.2.4 Semantic requirements on the recheck body ────────────────────────

export interface RecheckTransactionEvidence {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly gateway: string;
  readonly test: boolean;
  readonly amountMinor: string | null;
  readonly parentTransactionId: string | null;
}

/** The parsed, verified evidence a successful §8.2 recheck yields. */
export interface ExecRecheckEvidence {
  readonly currencyCode: string;
  /** Refund ids on the secondary, in response order (< 50, unique). */
  readonly refundIds: readonly string[];
  /** Every transaction on the secondary (< 50, unique). */
  readonly transactions: readonly RecheckTransactionEvidence[];
  /** The one verified SUCCESS CAPTURE or SALE the refund allocates against. */
  readonly capture: RecheckTransactionEvidence;
  /** Its optional AUTHORIZATION parent. */
  readonly authorizationId: string | null;
  /** Order-level aggregates in minor units ("0" expected for both). */
  readonly totalRefundedMinor: string;
  readonly totalRefundedShippingMinor: string;
}

export type ExecRecheckOutcome =
  | { readonly ok: true; readonly evidence: ExecRecheckEvidence }
  | { readonly ok: false; readonly reasonCode: ExecRecheckReasonCode; readonly reason: string };

const fail = (reasonCode: ExecRecheckReasonCode, reason: string): ExecRecheckOutcome => ({
  ok: false,
  reasonCode,
  reason,
});

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Parse a transaction element; unparseable money is unclassifiable. */
const readTransaction = (
  t: unknown,
): RecheckTransactionEvidence | null => {
  if (!isObject(t) || typeof t.id !== "string") return null;
  const amount = parseShopMoney(
    isObject(t.amountSet) ? (t.amountSet as Record<string, unknown>).presentmentMoney : undefined,
  );
  if (amount === null) return null;
  const parent = isObject(t.parentTransaction) ? t.parentTransaction.id : null;
  return {
    id: t.id,
    kind: typeof t.kind === "string" ? t.kind : "",
    status: typeof t.status === "string" ? t.status : "",
    gateway: typeof t.gateway === "string" ? t.gateway : "",
    test: t.test === true,
    amountMinor: amount.minorUnits.toString(),
    parentTransactionId: typeof parent === "string" ? parent : null,
  };
};

/**
 * The §8.2 execution recheck over one Q-RECHECK response body: the shape
 * checks of validateExecRecheck, then the semantic requirements of 8.2.4 —
 * exactly one SUCCESS CAPTURE or SALE on the secondary, at most one
 * AUTHORIZATION and only as that capture's parent, and nothing else; the
 * primary present, not cancelled and neither REFUNDED nor VOIDED; the
 * source still cancelled and PAID; both orders in the same currency.
 *
 * Fail closed: anything ambiguous is an INELIGIBLE-class reason code —
 * completeness that cannot be proven is BASELINE_UNVERIFIED, a record of
 * money already moved is PRIOR_REFUND_RECORD, and the primary/source state
 * rules are their own codes. Transport and top-level errors are thrown by
 * the caller's `gql`-style client before this function runs; they never
 * reach it.
 */
export function analyzeExecRecheck(
  body: unknown,
  expected: { readonly sourceOrderId: string; readonly primaryOrderId: string },
): ExecRecheckOutcome {
  const shape = validateExecRecheck(body, expected);
  if (!shape.ok) return fail("BASELINE_UNVERIFIED", shape.reason);

  const data = (body as { data: Record<string, unknown> }).data;
  const source = data.source as Record<string, unknown>;
  const primary = data.primary as Record<string, unknown>;

  // Source state: the secondary must still be the cancelled PAID order the
  // evaluator verified — a changed state is financial drift, not a transient.
  if (typeof source.cancelledAt !== "string" || source.cancelledAt === "") {
    return fail("SOURCE_STATE_CHANGED", "recheck source order is no longer cancelled");
  }
  if (source.displayFinancialStatus !== "PAID") {
    return fail(
      "SOURCE_STATE_CHANGED",
      `recheck source financial status is ${JSON.stringify(source.displayFinancialStatus)}, not PAID`,
    );
  }
  const currency = source.currencyCode;
  if (typeof currency !== "string" || getCurrencyPrecision(currency) === null) {
    return fail("CURRENCY_MISMATCH", "recheck source currency is missing or unsupported");
  }

  // The primary: loads, not cancelled, neither REFUNDED nor VOIDED (8.2.4).
  if (primary.cancelledAt !== null) {
    return fail("PRIMARY_INELIGIBLE", "primary order is cancelled");
  }
  if (primary.displayFinancialStatus === "REFUNDED" || primary.displayFinancialStatus === "VOIDED") {
    return fail(
      "PRIMARY_INELIGIBLE",
      `primary financial status is ${JSON.stringify(primary.displayFinancialStatus)}`,
    );
  }
  if (primary.currencyCode !== currency) {
    return fail(
      "CURRENCY_MISMATCH",
      `primary currency ${JSON.stringify(primary.currencyCode)} differs from source ${JSON.stringify(currency)}`,
    );
  }

  // Order-level aggregates: both must be exactly zero in the order currency.
  const totalRefunded = parseShopMoney(
    isObject(source.totalRefundedSet)
      ? (source.totalRefundedSet as Record<string, unknown>).presentmentMoney
      : undefined,
  );
  const totalRefundedShipping = parseShopMoney(
    isObject(source.totalRefundedShippingSet)
      ? (source.totalRefundedShippingSet as Record<string, unknown>).presentmentMoney
      : undefined,
  );
  if (
    totalRefunded === null ||
    totalRefundedShipping === null ||
    totalRefunded.currencyCode !== currency ||
    totalRefundedShipping.currencyCode !== currency
  ) {
    return fail("BASELINE_UNVERIFIED", "order refunded aggregates are missing or in a foreign currency");
  }

  const refunds = source.refunds as unknown[];
  const refundIds = (refunds as { id: string }[]).map((r) => r.id);
  const transactionsRaw = source.transactions as unknown[];
  const transactions: RecheckTransactionEvidence[] = [];
  for (const [i, t] of transactionsRaw.entries()) {
    const parsed = readTransaction(t);
    if (parsed === null) {
      return fail("BASELINE_UNVERIFIED", `source.transactions[${i}] has missing or unparseable fields`);
    }
    transactions.push(parsed);
  }

  // §8.2.4: exactly one SUCCESS CAPTURE or SALE, at most one AUTHORIZATION
  // and only as that capture's parent, and nothing else — no REFUND, VOID,
  // CHANGE or any other kind.
  const captures = transactions.filter(
    (t) => t.status === "SUCCESS" && (t.kind === "CAPTURE" || t.kind === "SALE"),
  );
  if (captures.length !== 1) {
    return fail(
      "TRANSACTION_EVIDENCE_UNSUPPORTED",
      `expected exactly one SUCCESS CAPTURE/SALE transaction, found ${captures.length}`,
    );
  }
  const capture = captures[0];
  let authorizationId: string | null = null;
  for (const t of transactions) {
    if (t.id === capture.id) continue;
    if (t.kind === "AUTHORIZATION" && t.status === "SUCCESS" && capture.parentTransactionId === t.id) {
      authorizationId = t.id;
      continue;
    }
    return fail(
      "TRANSACTION_EVIDENCE_UNSUPPORTED",
      `transaction ${JSON.stringify(t.id)} (kind ${t.kind}, status ${t.status}) is outside the single-capture rule`,
    );
  }

  return {
    ok: true,
    evidence: {
      currencyCode: currency,
      refundIds,
      transactions,
      capture,
      authorizationId,
      totalRefundedMinor: totalRefunded.minorUnits.toString(),
      totalRefundedShippingMinor: totalRefundedShipping.minorUnits.toString(),
    },
  };
}

// ── Consistency between two consecutive recheck reads (8.2.2) ─────────────

/** The three fields whose equality proves the two reads saw one state:
 *  the refund-id set, the transaction-id set and both aggregates. */
export function compareRecheckReads(
  first: ExecRecheckEvidence,
  second: ExecRecheckEvidence,
): boolean {
  const ids = (a: readonly string[], b: readonly string[]) => {
    const as = [...a].sort();
    const bs = [...b].sort();
    return as.length === bs.length && as.every((x, i) => x === bs[i]);
  };
  return (
    first.currencyCode === second.currencyCode &&
    ids(first.refundIds, second.refundIds) &&
    ids(
      first.transactions.map((t) => t.id),
      second.transactions.map((t) => t.id),
    ) &&
    first.totalRefundedMinor === second.totalRefundedMinor &&
    first.totalRefundedShippingMinor === second.totalRefundedShippingMinor
  );
}

// ── 8.2.1 Refund-record classification ────────────────────────────────────

export type RefundRecordClass = "BASELINE_CANDIDATE" | "FINANCIAL" | "UNCLASSIFIABLE";

const connectionNodes = (v: unknown): unknown[] | null =>
  isObject(v) && Array.isArray(v.nodes) && isObject(v.pageInfo) && v.pageInfo.hasNextPage === false
    ? v.nodes
    : null;

/**
 * Classify one Q-REFUND-DETAIL node (8.2.1). A record is a Baseline
 * candidate only when every required field is proven: zero totalRefundedSet
 * in the order's currency, no transactions, no shipping lines, no order
 * adjustments, no duties and no MergeShip marker prefix in the note —
 * refund-line-item (restock) content is permitted. Any money, shipping,
 * payment component or own-marker refund is FINANCIAL; any unproven field
 * is UNCLASSIFIABLE.
 */
export function classifyRefundRecord(node: unknown, orderCurrency: string): RefundRecordClass {
  if (!isObject(node)) return "UNCLASSIFIABLE";
  const shipping = connectionNodes(node.refundShippingLines);
  const lineItems = connectionNodes(node.refundLineItems);
  const adjustments = connectionNodes(node.orderAdjustments);
  const transactions = connectionNodes(node.transactions);
  if (shipping === null || lineItems === null || adjustments === null || transactions === null) {
    return "UNCLASSIFIABLE";
  }
  if (!Array.isArray(node.duties)) return "UNCLASSIFIABLE";
  const total = parseShopMoney(
    isObject(node.totalRefundedSet)
      ? (node.totalRefundedSet as Record<string, unknown>).presentmentMoney
      : undefined,
  );
  if (total === null || total.currencyCode !== orderCurrency) return "UNCLASSIFIABLE";
  if (typeof node.note !== "string") return "UNCLASSIFIABLE";
  if (
    total.minorUnits !== 0n ||
    transactions.length > 0 ||
    shipping.length > 0 ||
    adjustments.length > 0 ||
    node.duties.length > 0 ||
    node.note.includes(MARKER_PREFIX)
  ) {
    return "FINANCIAL";
  }
  return "BASELINE_CANDIDATE";
}

// ── The baseline object frozen into preEvidence (8.2.2) ───────────────────

export interface BaselineRefundFingerprint {
  readonly id: string;
  readonly totalMinor: string;
  readonly transactionCount: number;
  readonly shippingLineCount: number;
  readonly adjustmentCount: number;
  readonly dutyCount: number;
  readonly refundLineItemCount: number;
}

export interface RefundBaseline {
  readonly capturedAt: string;
  readonly mode: string;
  readonly currency: string;
  readonly refunds: readonly BaselineRefundFingerprint[];
  readonly refundCount: number;
  readonly totalRefundedMinor: string;
  readonly totalRefundedShippingMinor: string;
  readonly transactionIds: readonly string[];
  readonly moneyTransactionCount: number;
}

/**
 * Build the canonical baseline JSON (8.2.2) from the recheck evidence and
 * the per-refund fingerprints (empty under STRICT_EMPTY — its accepted
 * baseline is the empty refund set). Refunds are sorted by id; transaction
 * ids sorted; `capturedAt` is the caller-supplied instant of the last read.
 */
export function buildRefundBaseline(params: {
  readonly capturedAt: string;
  readonly currency: string;
  readonly evidence: ExecRecheckEvidence;
  readonly fingerprints?: readonly BaselineRefundFingerprint[];
}): RefundBaseline {
  const fingerprints = [...(params.fingerprints ?? [])].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const transactionIds = params.evidence.transactions.map((t) => t.id).sort();
  const moneyTransactionCount = params.evidence.transactions.filter(
    (t) => t.amountMinor !== null && BigInt(t.amountMinor) !== 0n,
  ).length;
  return {
    capturedAt: params.capturedAt,
    mode: REFUND_BASELINE_MODE,
    currency: params.currency,
    refunds: fingerprints,
    refundCount: fingerprints.length,
    totalRefundedMinor: params.evidence.totalRefundedMinor,
    totalRefundedShippingMinor: params.evidence.totalRefundedShippingMinor,
    transactionIds,
    moneyTransactionCount,
  };
}

export type BaselineAdmission =
  | { readonly ok: true; readonly baseline: RefundBaseline }
  | { readonly ok: false; readonly reasonCode: ExecRecheckReasonCode; readonly reason: string };

/**
 * Admit the baseline under the active mode (8.2.3). Under STRICT_EMPTY the
 * refund set must be empty: any refund record is INELIGIBLE
 * (PRIOR_REFUND_RECORD). Prior refunded shipping and any prior monetary
 * refund (nonzero aggregate or any REFUND-kind transaction) also fail as
 * PRIOR_REFUND_RECORD.
 */
export function admitBaseline(baseline: RefundBaseline): BaselineAdmission {
  if (baseline.mode !== REFUND_BASELINE_MODE) {
    return { ok: false, reasonCode: "BASELINE_UNVERIFIED", reason: `unknown baseline mode ${baseline.mode}` };
  }
  if (baseline.refundCount > 0 || baseline.refunds.length > 0) {
    return {
      ok: false,
      reasonCode: "PRIOR_REFUND_RECORD",
      reason: `baseline contains ${baseline.refundCount} refund record(s) under STRICT_EMPTY`,
    };
  }
  if (BigInt(baseline.totalRefundedShippingMinor) !== 0n) {
    return {
      ok: false,
      reasonCode: "PRIOR_REFUNDED_SHIPPING",
      reason: "shipping was already partially or fully refunded",
    };
  }
  if (BigInt(baseline.totalRefundedMinor) !== 0n) {
    return {
      ok: false,
      reasonCode: "PRIOR_REFUND_RECORD",
      reason: "the order already carries a nonzero refunded aggregate",
    };
  }
  return { ok: true, baseline };
}

/** The bounded diagnostic text stored in reviewReason on a
 *  PRIOR_REFUND_RECORD row (8.2.3): refund ids and class names plus counts
 *  only — no note text, no customer data, at most 4,096 characters. */
export const PRIOR_REFUND_DIAGNOSTIC_LIMIT = 4096;

export function buildPriorRefundDiagnostic(
  entries: readonly { readonly id: string; readonly class: RefundRecordClass }[],
): string {
  const counts: Record<RefundRecordClass, number> = {
    BASELINE_CANDIDATE: 0,
    FINANCIAL: 0,
    UNCLASSIFIABLE: 0,
  };
  for (const e of entries) counts[e.class] += 1;
  let out = JSON.stringify({ records: entries, counts });
  if (out.length > PRIOR_REFUND_DIAGNOSTIC_LIMIT) {
    out = JSON.stringify({ recordsTruncated: true, counts });
  }
  return `prior-refund-diagnostic:${out}`;
}

// ── 8.2.6 preEvidence ──────────────────────────────────────────────────────

/** The `preEvidence` JSON frozen with the wire request (8.2.6): the
 *  secondary's aggregates, refund count, transaction ids, the verified
 *  capture (and authorization) ids and the baseline. */
export function buildPreEvidence(params: {
  readonly evidence: ExecRecheckEvidence;
  readonly baseline: RefundBaseline;
}): Record<string, unknown> {
  const e = params.evidence;
  return {
    secondaryAggregates: {
      totalRefundedMinor: e.totalRefundedMinor,
      totalRefundedShippingMinor: e.totalRefundedShippingMinor,
    },
    refundCount: e.refundIds.length,
    refundIds: [...e.refundIds],
    transactionIds: e.transactions.map((t) => t.id),
    captureTransactionId: e.capture.id,
    authorizationTransactionId: e.authorizationId,
    baseline: params.baseline,
  };
}

// ── 8.2.5 The pure R2 comparison (contained; not invoked on live rows) ────

export type BaselineR2Comparison =
  | { readonly equal: true }
  | {
      readonly equal: false;
      /** REFUND_APPEARED: a new id, changed fingerprint or changed aggregate.
       *  UNEXPECTED_OWN_MARKER: a refund carrying MS-SHIPREFUND- on a
       *  never-dispatched row (possible restore or double-send). */
      readonly kind: "REFUND_APPEARED" | "UNEXPECTED_OWN_MARKER" | "BASELINE_CHANGED";
      readonly detail: string;
    };

/**
 * Compare a freshly captured baseline-shaped read against the frozen
 * baseline (8.2.5). The refund-id set must equal the baseline exactly, every
 * baseline fingerprint must be unchanged, both aggregates must equal the
 * baseline (0 under STRICT_EMPTY) and the transaction-id set must match.
 * `freshRefundNotes` carries the note text per fresh refund id for the
 * marker check; a note carrying the MS-SHIPREFUND- prefix is
 * UNEXPECTED_OWN_MARKER, not an abort.
 *
 * EXTERNAL_REFUND is defined relative to the baseline (12.5): a refund id
 * absent from `stored.refunds` (and not the marker refund) or a changed
 * baseline fingerprint. A still-unchanged baseline record is ignored.
 */
export function compareBaselineAtR2(
  stored: RefundBaseline,
  fresh: {
    readonly refunds: readonly BaselineRefundFingerprint[];
    readonly totalRefundedMinor: string;
    readonly totalRefundedShippingMinor: string;
    readonly transactionIds: readonly string[];
    readonly refundNotes: Readonly<Record<string, string>>;
  },
): BaselineR2Comparison {
  for (const [id, note] of Object.entries(fresh.refundNotes)) {
    if (typeof note === "string" && note.includes(MARKER_PREFIX)) {
      return {
        equal: false,
        kind: "UNEXPECTED_OWN_MARKER",
        detail: `refund ${id} carries the ${MARKER_PREFIX} marker prefix on a never-dispatched row`,
      };
    }
  }
  const storedIds = stored.refunds.map((r) => r.id);
  const freshIds = fresh.refunds.map((r) => r.id);
  const newIds = freshIds.filter((id) => !storedIds.includes(id));
  if (newIds.length > 0) {
    return {
      equal: false,
      kind: "REFUND_APPEARED",
      detail: `new refund id(s) since the baseline: ${newIds.join(", ")}`,
    };
  }
  for (const s of stored.refunds) {
    const f = fresh.refunds.find((r) => r.id === s.id);
    if (
      !f ||
      f.totalMinor !== s.totalMinor ||
      f.transactionCount !== s.transactionCount ||
      f.shippingLineCount !== s.shippingLineCount ||
      f.adjustmentCount !== s.adjustmentCount ||
      f.dutyCount !== s.dutyCount
    ) {
      return {
        equal: false,
        kind: "REFUND_APPEARED",
        detail: `baseline refund ${s.id}'s fingerprint changed`,
      };
    }
  }
  if (
    fresh.totalRefundedMinor !== stored.totalRefundedMinor ||
    fresh.totalRefundedShippingMinor !== stored.totalRefundedShippingMinor
  ) {
    return {
      equal: false,
      kind: "REFUND_APPEARED",
      detail: "order refunded aggregates differ from the baseline",
    };
  }
  const storedTx = [...stored.transactionIds].sort();
  const freshTx = [...fresh.transactionIds].sort();
  if (storedTx.length !== freshTx.length || !storedTx.every((x, i) => x === freshTx[i])) {
    return {
      equal: false,
      kind: "REFUND_APPEARED",
      detail: "the transaction-id set differs from the baseline",
    };
  }
  return { equal: true };
}
