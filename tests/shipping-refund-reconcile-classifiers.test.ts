// Pure unit tests for the S1-F read-only reconciliation classifiers
// (app/lib/shipping-refund-gate.ts, §§12.2–12.5, 12.3.1, 12.8).
//
// Every input is a hand-built, clearly schema-derived value — no Shopify
// response here is claimed to be archived development-store evidence.
// No database, no network: the classifiers are pure and read-only.

import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_STATUS,
  classifyGAgreementEvidence,
  classifyInDoubtReadback,
  classifyRefundVerification,
  classifyTransactionStatus,
  evaluateRefundAttribution,
  inDoubtPollDelayMs,
  reconcileRetryDelayMs,
  settlementPollDelayMs,
  IN_DOUBT_ABSENT_WINDOW_MS,
  IN_DOUBT_POLL_FIRST_HOUR_MS,
  IN_DOUBT_POLL_AFTER_MS,
  IN_DOUBT_FIRST_HOUR_MS,
  READ_FAILURE_RETRY_MS,
  REFUND_RECORDED_VISIBILITY_MS,
  RECONCILE_TIMING_SKEW_MS,
  SETTLEMENT_HORIZON_MS,
  SETTLEMENT_POLL_MARKS_MS,
  SETTLEMENT_POLL_CADENCE_MS,
  type AttributionStatus,
  type GAgreementObservation,
  type ReconcileAgreement,
  type ReconcileReads,
  type ReconcileRefundDetail,
  type ReconcileRowFacts,
} from "../app/lib/shipping-refund-gate";

// ── Builders (schema-derived shapes) ──────────────────────────────────────

const APP_ID = "gid://shopify/App/424242";
const MARKER = "MS-SHIPREFUND-11111111-2222-3333-4444-555555555555";
const REFUND_ID = "gid://shopify/Refund/777";
const T_DISPATCH = new Date("2026-10-20T10:00:00.000Z");
const T_NOW = new Date("2026-10-20T10:10:00.000Z"); // 10 min after dispatch

const rowFacts = (over: Partial<ReconcileRowFacts> = {}): ReconcileRowFacts => ({
  marker: MARKER,
  dispatchedAt: T_DISPATCH,
  respondedAt: null,
  refundId: null,
  plannedShippingMinor: "800",
  currencyCode: "USD",
  parentTransactionId: "gid://shopify/OrderTransaction/901",
  gateway: "bogus",
  baselineRefundIds: [],
  ...over,
});

const money = (minor: bigint, currencyCode = "USD") => ({
  minorUnits: minor,
  currencyCode,
});

const listEntry = (over: Record<string, unknown> = {}) => ({
  id: REFUND_ID,
  note: `Shipping refund ${MARKER}`,
  createdAt: "2026-10-20T10:00:30.000Z",
  processedAt: "2026-10-20T10:00:31.000Z",
  totalRefunded: money(800n),
  ...over,
});

const detailTxn = (over: Record<string, unknown> = {}) => ({
  id: "gid://shopify/OrderTransaction/950",
  kind: "REFUND",
  status: "SUCCESS",
  gateway: "bogus",
  amountMinor: 800n,
  currencyCode: "USD",
  parentTransactionId: "gid://shopify/OrderTransaction/901",
  ...over,
});

const refundDetail = (over: Partial<ReconcileRefundDetail> = {}): ReconcileRefundDetail => ({
  id: REFUND_ID,
  note: `Shipping refund ${MARKER}`,
  createdAt: "2026-10-20T10:00:30.000Z",
  processedAt: "2026-10-20T10:00:31.000Z",
  totalRefunded: money(800n),
  dutiesCount: 0,
  shippingLines: [{ subtotal: money(800n), taxMinor: 0n }],
  refundLineItemCount: 0,
  orderAdjustmentCount: 0,
  transactions: [detailTxn()],
  ...over,
});

const agreement = (over: Partial<ReconcileAgreement> = {}): ReconcileAgreement => ({
  id: "gid://shopify/RefundAgreement/1",
  typename: "RefundAgreement",
  reason: "REFUND",
  appId: APP_ID,
  refundId: REFUND_ID,
  happenedAt: "2026-10-20T10:00:32.000Z",
  ...over,
});

const reads = (over: Partial<ReconcileReads> = {}): ReconcileReads => ({
  list: {
    ok: true,
    refunds: [listEntry()],
    transactions: [],
    totalRefunded: money(800n),
    totalRefundedShipping: money(800n),
  },
  detail: { ok: true, refund: refundDetail() },
  agreements: { ok: true, agreements: [agreement()] },
  appId: { ok: true, id: APP_ID },
  baselineFingerprintChanged: false,
  ...over,
});

const ctx = (attributionStatus: AttributionStatus, now = T_NOW) => ({
  now,
  attributionStatus,
});

// ── The pinned attribution status (12.3.1) ────────────────────────────────

describe("ATTRIBUTION_STATUS", () => {
  it("is pinned to UNVERIFIED in production code", () => {
    expect(ATTRIBUTION_STATUS).toBe("UNVERIFIED");
    // The declared type admits "CONFIRMED" only so test fixtures can
    // exercise the 12.8.2 branch through the injected seam; the value
    // itself can never move — there is no setter, env read or row read.
  });
});

// ── Transaction status classes (12.2) ─────────────────────────────────────

describe("classifyTransactionStatus", () => {
  it("maps the known statuses and fails closed on unknown ones", () => {
    expect(classifyTransactionStatus("SUCCESS")).toBe("SUCCESS");
    expect(classifyTransactionStatus("PENDING")).toBe("PENDING_CLASS");
    expect(classifyTransactionStatus("AWAITING_RESPONSE")).toBe("PENDING_CLASS");
    expect(classifyTransactionStatus("FAILURE")).toBe("FAILED_CLASS");
    expect(classifyTransactionStatus("ERROR")).toBe("FAILED_CLASS");
    expect(classifyTransactionStatus("UNKNOWN")).toBe("UNSUPPORTED");
    expect(classifyTransactionStatus("")).toBe("UNSUPPORTED");
    expect(classifyTransactionStatus("pending")).toBe("UNSUPPORTED");
  });
});

// ── Attribution verdict (12.3 condition 3) ────────────────────────────────

describe("evaluateRefundAttribution", () => {
  const base = {
    refundId: REFUND_ID,
    windowStartMs: T_DISPATCH.getTime() - RECONCILE_TIMING_SKEW_MS,
    nowMs: T_NOW.getTime(),
  };

  it("is LAG when the app id cannot be verified", () => {
    const v = evaluateRefundAttribution({
      ...base,
      agreements: { ok: true, agreements: [agreement()] },
      appId: null,
    });
    expect(v.kind).toBe("LAG");
    const v2 = evaluateRefundAttribution({
      ...base,
      agreements: { ok: true, agreements: [agreement()] },
      appId: { ok: false, detail: "x" },
    });
    expect(v2.kind).toBe("LAG");
  });

  it("is LAG when the agreement list is unread or unproven", () => {
    for (const agreements of [null, { ok: false, detail: "x" }] as const) {
      const v = evaluateRefundAttribution({
        ...base,
        agreements,
        appId: { ok: true, id: APP_ID },
      });
      expect(v.kind).toBe("LAG");
    }
  });

  it("is ATTRIBUTED for exactly one typed agreement matching the verified app id", () => {
    const v = evaluateRefundAttribution({
      ...base,
      agreements: { ok: true, agreements: [agreement()] },
      appId: { ok: true, id: APP_ID },
    });
    expect(v).toEqual({ kind: "ATTRIBUTED", agreementId: "gid://shopify/RefundAgreement/1" });
  });

  it("is LAG while no RefundAgreement links the refund", () => {
    const v = evaluateRefundAttribution({
      ...base,
      agreements: { ok: true, agreements: [] },
      appId: { ok: true, id: APP_ID },
    });
    expect(v.kind).toBe("LAG");
  });

  it("is MISMATCH when a RefundAgreement links a different refund", () => {
    const v = evaluateRefundAttribution({
      ...base,
      agreements: {
        ok: true,
        agreements: [agreement({ refundId: "gid://shopify/Refund/999" })],
      },
      appId: { ok: true, id: APP_ID },
    });
    expect(v.kind).toBe("MISMATCH");
  });

  it("is MISMATCH when two RefundAgreements link the refund", () => {
    const v = evaluateRefundAttribution({
      ...base,
      agreements: {
        ok: true,
        agreements: [agreement(), agreement({ id: "gid://shopify/RefundAgreement/2" })],
      },
      appId: { ok: true, id: APP_ID },
    });
    expect(v.kind).toBe("MISMATCH");
  });

  it("is MISMATCH for a null or foreign app id", () => {
    for (const appId of [null, "gid://shopify/App/999"]) {
      const v = evaluateRefundAttribution({
        ...base,
        agreements: { ok: true, agreements: [agreement({ appId })] },
        appId: { ok: true, id: APP_ID },
      });
      expect(v.kind).toBe("MISMATCH");
    }
  });

  it("is MISMATCH when happenedAt is absent or outside the window", () => {
    for (const happenedAt of [
      null,
      "not-a-date",
      "2026-10-20T09:50:00.000Z", // before dispatchedAt - skew
      "2026-10-20T11:00:00.000Z", // after now
    ]) {
      const v = evaluateRefundAttribution({
        ...base,
        agreements: { ok: true, agreements: [agreement({ happenedAt })] },
        appId: { ok: true, id: APP_ID },
      });
      expect(v.kind).toBe("MISMATCH");
    }
  });

  it("ignores non-RefundAgreement typenames and non-REFUND reasons for linkage", () => {
    const v = evaluateRefundAttribution({
      ...base,
      agreements: {
        ok: true,
        agreements: [
          agreement({ typename: "OrderEditAgreement", refundId: REFUND_ID }),
          agreement({ reason: "ORDER_EDIT", refundId: REFUND_ID }),
          agreement(), // the real one
        ],
      },
      appId: { ok: true, id: APP_ID },
    });
    expect(v.kind).toBe("ATTRIBUTED");
  });
});

// ── IN_DOUBT read-back (12.5) ─────────────────────────────────────────────

describe("classifyInDoubtReadback", () => {
  it("Waits when the refund list read failed", () => {
    const d = classifyInDoubtReadback(
      rowFacts(),
      reads({
        list: { ok: false, completenessUnproven: false, detail: "transport" },
      }),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "WAIT", lag: "reads" });
  });

  it("reviews when completeness of the refund list is unproven", () => {
    const d = classifyInDoubtReadback(
      rowFacts(),
      reads({
        list: { ok: false, completenessUnproven: true, detail: "truncated" },
      }),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "REVIEW", reasonCode: "READBACK_INCOMPLETE" });
  });

  it("waits while no marker refund is visible inside the absent window", () => {
    const d = classifyInDoubtReadback(
      rowFacts(),
      reads({
        list: {
          ok: true,
          refunds: [],
          transactions: [],
          totalRefunded: money(0n),
          totalRefundedShipping: money(0n),
        },
      }),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "WAIT", lag: "visibility" });
  });

  it("reviews (never clears) when the absent window has passed", () => {
    const late = new Date(T_DISPATCH.getTime() + IN_DOUBT_ABSENT_WINDOW_MS + 1);
    const d = classifyInDoubtReadback(
      rowFacts(),
      reads({
        list: {
          ok: true,
          refunds: [],
          transactions: [],
          totalRefunded: money(0n),
          totalRefundedShipping: money(0n),
        },
      }),
      ctx("CONFIRMED", late),
    );
    expect(d).toMatchObject({ action: "REVIEW", reasonCode: "ABSENT_AFTER_WINDOW" });
    if (d.action === "REVIEW") {
      expect(d.detail).toMatch(/not proof/i);
    }
  });

  it("reviews EXTERNAL_REFUND for a non-baseline refund without the marker", () => {
    const d = classifyInDoubtReadback(
      rowFacts(),
      reads({
        list: {
          ok: true,
          refunds: [
            { id: "gid://shopify/Refund/555", note: "other", createdAt: null, processedAt: null, totalRefunded: money(100n) },
          ],
          transactions: [],
          totalRefunded: money(100n),
          totalRefundedShipping: money(0n),
        },
      }),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "REVIEW", reasonCode: "EXTERNAL_REFUND" });
  });

  it("does not flag a baseline-listed refund as external", () => {
    const baselineId = "gid://shopify/Refund/111";
    const d = classifyInDoubtReadback(
      rowFacts({ baselineRefundIds: [baselineId] }),
      reads({
        list: {
          ok: true,
          refunds: [
            { id: baselineId, note: "baseline", createdAt: null, processedAt: null, totalRefunded: money(100n) },
          ],
          transactions: [],
          totalRefunded: money(100n),
          totalRefundedShipping: money(0n),
        },
      }),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "WAIT", lag: "visibility" });
  });

  it("reviews a changed baseline fingerprint", () => {
    const baselineId = "gid://shopify/Refund/111";
    const d = classifyInDoubtReadback(
      rowFacts({ baselineRefundIds: [baselineId] }),
      reads({
        baselineFingerprintChanged: true,
        list: {
          ok: true,
          refunds: [
            { id: baselineId, note: "baseline", createdAt: null, processedAt: null, totalRefunded: money(100n) },
          ],
          transactions: [],
          totalRefunded: money(100n),
          totalRefundedShipping: money(0n),
        },
      }),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "REVIEW", reasonCode: "EXTERNAL_REFUND" });
  });

  it("reviews DUPLICATE_SUSPECTED for two marker refunds", () => {
    const d = classifyInDoubtReadback(
      rowFacts(),
      reads({
        list: {
          ok: true,
          refunds: [
            listEntry(),
            listEntry({ id: "gid://shopify/Refund/778" }),
          ],
          transactions: [],
          totalRefunded: money(1600n),
          totalRefundedShipping: money(1600n),
        },
      }),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "REVIEW", reasonCode: "DUPLICATE_SUSPECTED" });
  });

  it("reviews ANOMALY when the marker refund predates the baseline", () => {
    const d = classifyInDoubtReadback(
      rowFacts({ baselineRefundIds: [REFUND_ID] }),
      reads(),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "REVIEW", reasonCode: "ANOMALY" });
  });

  it("waits while the detail read is incomplete, reviews after the window", () => {
    const early = classifyInDoubtReadback(
      rowFacts(),
      reads({ detail: null }),
      ctx("CONFIRMED"),
    );
    expect(early).toMatchObject({ action: "WAIT", lag: "evidence" });
    const late = classifyInDoubtReadback(
      rowFacts(),
      reads({ detail: { ok: false, detail: "validator" } }),
      ctx("CONFIRMED", new Date(T_DISPATCH.getTime() + IN_DOUBT_ABSENT_WINDOW_MS + 1)),
    );
    expect(late).toMatchObject({ action: "REVIEW", reasonCode: "INCOMPLETE_AFTER_WINDOW" });
  });

  it("reviews ANOMALY when the detail read returns another refund id", () => {
    const d = classifyInDoubtReadback(
      rowFacts(),
      reads({ detail: { ok: true, refund: refundDetail({ id: "gid://shopify/Refund/999" }) } }),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "REVIEW", reasonCode: "ANOMALY" });
  });

  it("reviews ANOMALY when the detail no longer carries the marker", () => {
    const d = classifyInDoubtReadback(
      rowFacts(),
      reads({ detail: { ok: true, refund: refundDetail({ note: "unrelated" }) } }),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "REVIEW", reasonCode: "ANOMALY" });
  });

  it("reviews ANOMALY on financial contradictions", () => {
    const cases: Partial<ReconcileRefundDetail>[] = [
      { totalRefunded: money(801n) }, // wrong total
      { totalRefunded: money(800n, "EUR") }, // wrong currency
      { shippingLines: [{ subtotal: money(700n), taxMinor: 0n }] }, // amount
      { shippingLines: [{ subtotal: money(800n), taxMinor: 5n }] }, // taxed
      { shippingLines: [] }, // no shipping line on a nonzero refund
      { shippingLines: [{ subtotal: money(400n), taxMinor: 0n }, { subtotal: money(400n), taxMinor: 0n }] },
      { refundLineItemCount: 1 },
      { orderAdjustmentCount: 1 },
      { dutiesCount: 1 },
      { transactions: [detailTxn({ kind: "CAPTURE" })] },
      { transactions: [detailTxn({ parentTransactionId: "gid://shopify/OrderTransaction/999" })] },
      { transactions: [detailTxn({ gateway: "other" })] },
      { transactions: [detailTxn({ amountMinor: 700n })] },
      { transactions: [detailTxn({ currencyCode: "EUR" })] },
      { transactions: [detailTxn(), detailTxn({ id: "gid://shopify/OrderTransaction/951" })] },
    ];
    for (const over of cases) {
      const d = classifyInDoubtReadback(
        rowFacts(),
        reads({ detail: { ok: true, refund: refundDetail(over) } }),
        ctx("CONFIRMED"),
      );
      expect(
        d,
        JSON.stringify(over, (_, v) => (typeof v === "bigint" ? `${v}n` : v)),
      ).toMatchObject({
        action: "REVIEW",
        reasonCode: "ANOMALY",
      });
    }
  });

  it("reviews SETTLEMENT_FAILED for a failed refund transaction", () => {
    const d = classifyInDoubtReadback(
      rowFacts(),
      reads({
        detail: {
          ok: true,
          refund: refundDetail({ transactions: [detailTxn({ status: "FAILURE" })] }),
        },
      }),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "REVIEW", reasonCode: "SETTLEMENT_FAILED" });
  });

  it("reviews UNSUPPORTED_TXN_STATUS for an unrecognized status", () => {
    const d = classifyInDoubtReadback(
      rowFacts(),
      reads({
        detail: {
          ok: true,
          refund: refundDetail({ transactions: [detailTxn({ status: "NEUTRAL" })] }),
        },
      }),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "REVIEW", reasonCode: "UNSUPPORTED_TXN_STATUS" });
  });

  it("waits on a pending transaction, reviews after the absent window", () => {
    const pending = reads({
      detail: {
        ok: true,
        refund: refundDetail({ transactions: [detailTxn({ status: "PENDING" })] }),
      },
    });
    const early = classifyInDoubtReadback(rowFacts(), pending, ctx("CONFIRMED"));
    expect(early).toMatchObject({ action: "WAIT", lag: "evidence" });
    const late = classifyInDoubtReadback(
      rowFacts(),
      pending,
      ctx("CONFIRMED", new Date(T_DISPATCH.getTime() + IN_DOUBT_ABSENT_WINDOW_MS + 1)),
    );
    expect(late).toMatchObject({ action: "REVIEW", reasonCode: "INCOMPLETE_AFTER_WINDOW" });
  });

  it("reviews ANOMALY on a refund whose timing contradicts dispatch", () => {
    const d = classifyInDoubtReadback(
      rowFacts(),
      reads({
        detail: {
          ok: true,
          refund: refundDetail({ processedAt: "2026-10-20T09:00:00.000Z" }),
        },
      }),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "REVIEW", reasonCode: "ANOMALY" });
  });

  it("under UNVERIFIED, complete evidence can never ADOPT — wait, then review", () => {
    const early = classifyInDoubtReadback(rowFacts(), reads(), ctx("UNVERIFIED"));
    expect(early).toMatchObject({ action: "WAIT", lag: "attribution" });
    const late = classifyInDoubtReadback(
      rowFacts(),
      reads(),
      ctx("UNVERIFIED", new Date(T_DISPATCH.getTime() + IN_DOUBT_ABSENT_WINDOW_MS + 1)),
    );
    expect(late).toMatchObject({ action: "REVIEW", reasonCode: "ATTRIBUTION_UNVERIFIED" });
    expect(late.action).not.toBe("ADOPT");
  });

  it("under CONFIRMED, complete evidence ADOPTs", () => {
    const d = classifyInDoubtReadback(rowFacts(), reads(), ctx("CONFIRMED"));
    expect(d).toMatchObject({
      action: "ADOPT",
      refundId: REFUND_ID,
      settlementState: "SUCCESS",
    });
  });

  it("under CONFIRMED, contradictory attribution reviews ATTRIBUTION_MISMATCH", () => {
    const d = classifyInDoubtReadback(
      rowFacts(),
      reads({
        agreements: {
          ok: true,
          agreements: [agreement({ appId: "gid://shopify/App/999" })],
        },
      }),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "REVIEW", reasonCode: "ATTRIBUTION_MISMATCH" });
  });

  it("under CONFIRMED, missing attribution reviews UNAVAILABLE after the window", () => {
    const d = classifyInDoubtReadback(
      rowFacts(),
      reads({ agreements: { ok: true, agreements: [] } }),
      ctx("CONFIRMED", new Date(T_DISPATCH.getTime() + IN_DOUBT_ABSENT_WINDOW_MS + 1)),
    );
    expect(d).toMatchObject({ action: "REVIEW", reasonCode: "ATTRIBUTION_UNAVAILABLE" });
  });
});

// ── REFUND_RECORDED verification (12.4) ───────────────────────────────────

describe("classifyRefundVerification", () => {
  const recorded = (over: Partial<ReconcileRowFacts> = {}) =>
    rowFacts({
      refundId: REFUND_ID,
      respondedAt: new Date("2026-10-20T10:01:00.000Z"),
      ...over,
    });

  it("reviews ANOMALY when the recorded row carries no refundId", () => {
    const d = classifyRefundVerification(
      recorded({ refundId: null }),
      reads(),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "REVIEW", reasonCode: "ANOMALY" });
  });

  it("waits while the recorded refund is not yet visible", () => {
    const d = classifyRefundVerification(
      recorded(),
      reads({
        list: {
          ok: true,
          refunds: [],
          transactions: [],
          totalRefunded: money(0n),
          totalRefundedShipping: money(0n),
        },
        detail: null,
        agreements: null,
      }),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "WAIT", lag: "not-visible" });
  });

  it("reviews NOT_VISIBLE_AFTER_WINDOW once the visibility window lapses", () => {
    const late = new Date(
      recorded().respondedAt!.getTime() + REFUND_RECORDED_VISIBILITY_MS + 1,
    );
    const d = classifyRefundVerification(
      recorded(),
      reads({
        list: {
          ok: true,
          refunds: [],
          transactions: [],
          totalRefunded: money(0n),
          totalRefundedShipping: money(0n),
        },
        detail: null,
        agreements: null,
      }),
      ctx("CONFIRMED", late),
    );
    expect(d).toMatchObject({ action: "REVIEW", reasonCode: "NOT_VISIBLE_AFTER_WINDOW" });
  });

  it("reviews ANOMALY when the marker names a different refund than recorded", () => {
    const d = classifyRefundVerification(
      recorded(),
      reads({
        list: {
          ok: true,
          refunds: [
            listEntry(),
            listEntry({ id: "gid://shopify/Refund/778", note: `dup ${MARKER}` }),
          ],
          transactions: [],
          totalRefunded: money(1600n),
          totalRefundedShipping: money(1600n),
        },
      }),
      ctx("CONFIRMED"),
    );
    // Two marker refunds → DUPLICATE_SUSPECTED first.
    expect(d).toMatchObject({ action: "REVIEW", reasonCode: "DUPLICATE_SUSPECTED" });
  });

  it("reviews ANOMALY when the recorded refund is not the marker refund", () => {
    const d = classifyRefundVerification(
      recorded(),
      reads({
        list: {
          ok: true,
          refunds: [listEntry({ id: "gid://shopify/Refund/999", note: `x ${MARKER}` })],
          transactions: [],
          totalRefunded: money(800n),
          totalRefundedShipping: money(800n),
        },
      }),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "REVIEW", reasonCode: "ANOMALY" });
  });

  it("reviews ANOMALY when the recorded refund is visible but carries no marker (C-1)", () => {
    // §12.4 must satisfy §12.3 condition (1): the recorded refund must still
    // be the UNIQUE marker refund. The note was written when the refund was
    // created — its absence on a visible recorded refund is a
    // contradiction, never lag, and never VERIFY (the pre-fix defect
    // verified a marker-less refund outright).
    for (const note of [null, "a refund without our note"] as const) {
      const d = classifyRefundVerification(
        recorded(),
        reads({
          list: {
            ok: true,
            refunds: [listEntry({ note })],
            transactions: [],
            totalRefunded: money(800n),
            totalRefundedShipping: money(800n),
          },
          detail: { ok: true, refund: refundDetail({ note }) },
        }),
        ctx("CONFIRMED"),
      );
      expect(d, JSON.stringify(note)).toMatchObject({
        action: "REVIEW",
        reasonCode: "ANOMALY",
      });
      expect(d.action).not.toBe("VERIFY");
    }
  });

  it("reviews ANOMALY when the recorded refund carries a different marker (C-1)", () => {
    const foreign = "Shipping refund MS-SHIPREFUND-99999999-0000-0000-0000-000000000000";
    const d = classifyRefundVerification(
      recorded(),
      reads({
        list: {
          ok: true,
          refunds: [listEntry({ note: foreign })],
          transactions: [],
          totalRefunded: money(800n),
          totalRefundedShipping: money(800n),
        },
        detail: { ok: true, refund: refundDetail({ note: foreign }) },
      }),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "REVIEW", reasonCode: "ANOMALY" });
  });

  it("reviews ANOMALY when the detail no longer carries the marker although the list entry does (C-1)", () => {
    const d = classifyRefundVerification(
      recorded(),
      reads({
        detail: { ok: true, refund: refundDetail({ note: "unrelated" }) },
      }),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "REVIEW", reasonCode: "ANOMALY" });
    expect(d.action).not.toBe("VERIFY");
  });

  it("still waits while the recorded refund is not visible even with no marker anywhere", () => {
    // Marker absence only contradicts a VISIBLE recorded refund — an
    // invisible one keeps the lag semantics.
    const d = classifyRefundVerification(
      recorded(),
      reads({
        list: {
          ok: true,
          refunds: [listEntry({ id: "gid://shopify/Refund/555", note: "other" })],
          transactions: [],
          totalRefunded: money(100n),
          totalRefundedShipping: money(100n),
        },
        detail: null,
        agreements: null,
      }),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "WAIT", lag: "not-visible" });
  });

  it("waits on a pending settlement, reviews at the 72-hour horizon", () => {
    const pending = reads({
      detail: {
        ok: true,
        refund: refundDetail({ transactions: [detailTxn({ status: "PENDING" })] }),
      },
    });
    const early = classifyRefundVerification(recorded(), pending, ctx("CONFIRMED"));
    expect(early).toMatchObject({ action: "WAIT", lag: "settlement" });
    const late = classifyRefundVerification(
      recorded(),
      pending,
      ctx("CONFIRMED", new Date(T_DISPATCH.getTime() + SETTLEMENT_HORIZON_MS + 1)),
    );
    expect(late).toMatchObject({ action: "REVIEW", reasonCode: "SETTLEMENT_TIMEOUT" });
  });

  it("reviews SETTLEMENT_FAILED / UNSUPPORTED_TXN_STATUS", () => {
    for (const [status, reasonCode] of [
      ["FAILURE", "SETTLEMENT_FAILED"],
      ["OOB", "UNSUPPORTED_TXN_STATUS"],
    ] as const) {
      const d = classifyRefundVerification(
        recorded(),
        reads({
          detail: {
            ok: true,
            refund: refundDetail({ transactions: [detailTxn({ status })] }),
          },
        }),
        ctx("CONFIRMED"),
      );
      expect(d, status).toMatchObject({ action: "REVIEW", reasonCode });
    }
  });

  it("reviews ANOMALY when order aggregates contradict the planned refund", () => {
    const d = classifyRefundVerification(
      recorded(),
      reads({
        list: {
          ok: true,
          refunds: [listEntry()],
          transactions: [],
          totalRefunded: money(900n),
          totalRefundedShipping: money(800n),
        },
      }),
      ctx("CONFIRMED"),
    );
    expect(d).toMatchObject({ action: "REVIEW", reasonCode: "ANOMALY" });
  });

  it("under UNVERIFIED, the recorded refund can never VERIFY", () => {
    const early = classifyRefundVerification(recorded(), reads(), ctx("UNVERIFIED"));
    expect(early.action).not.toBe("VERIFY");
    expect(early).toMatchObject({ action: "WAIT", lag: "attribution" });
    const late = classifyRefundVerification(
      recorded(),
      reads(),
      ctx("UNVERIFIED", new Date(
        recorded().respondedAt!.getTime() + REFUND_RECORDED_VISIBILITY_MS + 1,
      )),
    );
    expect(late).toMatchObject({ action: "REVIEW", reasonCode: "ATTRIBUTION_UNVERIFIED" });
  });

  it("under CONFIRMED, fully consistent evidence VERIFYs with its evidence record", () => {
    const d = classifyRefundVerification(recorded(), reads(), ctx("CONFIRMED"));
    expect(d.action).toBe("VERIFY");
    if (d.action === "VERIFY") {
      expect(d.evidence).toMatchObject({
        refundId: REFUND_ID,
        agreementId: "gid://shopify/RefundAgreement/1",
        appId: APP_ID,
        refundTransactionId: "gid://shopify/OrderTransaction/950",
        amountMinor: "800",
        currencyCode: "USD",
        aggregateCheck: "verified",
      });
    }
  });

  it("skips the aggregate check when other non-baseline refunds exist", () => {
    const d = classifyRefundVerification(
      recorded(),
      reads({
        list: {
          ok: true,
          refunds: [
            listEntry(),
            { id: "gid://shopify/Refund/555", note: "other refund", createdAt: null, processedAt: null, totalRefunded: money(50n) },
          ],
          transactions: [],
          totalRefunded: money(850n),
          totalRefundedShipping: money(800n),
        },
      }),
      ctx("CONFIRMED"),
    );
    expect(d.action).toBe("VERIFY");
    if (d.action === "VERIFY") {
      expect(d.evidence.aggregateCheck).toBe("skipped-other-refunds");
    }
  });
});

// ── Retry cadences (12.4/12.5) ────────────────────────────────────────────

describe("reconcile cadences", () => {
  it("polls IN_DOUBT every 5 min in the first hour, then every 15", () => {
    const within = new Date(T_DISPATCH.getTime() + IN_DOUBT_FIRST_HOUR_MS - 1);
    const after = new Date(T_DISPATCH.getTime() + IN_DOUBT_FIRST_HOUR_MS + 1);
    expect(inDoubtPollDelayMs(T_DISPATCH, within)).toBe(IN_DOUBT_POLL_FIRST_HOUR_MS);
    expect(inDoubtPollDelayMs(T_DISPATCH, after)).toBe(IN_DOUBT_POLL_AFTER_MS);
  });

  it("schedules settlement checks at the 5m/1h/6h marks then 6h cadence", () => {
    const at0 = new Date(T_DISPATCH.getTime());
    expect(settlementPollDelayMs(T_DISPATCH, at0)).toBe(SETTLEMENT_POLL_MARKS_MS[0]);
    const at10m = new Date(T_DISPATCH.getTime() + 10 * 60_000);
    expect(settlementPollDelayMs(T_DISPATCH, at10m)).toBe(
      SETTLEMENT_POLL_MARKS_MS[1] - 10 * 60_000,
    );
    const past = new Date(T_DISPATCH.getTime() + 7 * 3_600_000);
    expect(settlementPollDelayMs(T_DISPATCH, past)).toBe(SETTLEMENT_POLL_CADENCE_MS);
  });

  it("maps lag kinds onto the documented delays", () => {
    expect(
      reconcileRetryDelayMs(
        "reads",
        { dispatchedAt: T_DISPATCH, status: "IN_DOUBT" },
        T_NOW,
      ),
    ).toBe(READ_FAILURE_RETRY_MS);
    expect(
      reconcileRetryDelayMs(
        "settlement",
        { dispatchedAt: T_DISPATCH, status: "REFUND_RECORDED" },
        T_NOW,
      ),
    ).toBe(SETTLEMENT_POLL_MARKS_MS[1] - 10 * 60_000);
    expect(
      reconcileRetryDelayMs(
        "visibility",
        { dispatchedAt: T_DISPATCH, status: "IN_DOUBT" },
        T_NOW,
      ),
    ).toBe(IN_DOUBT_POLL_FIRST_HOUR_MS);
  });
});

// ── G-AGREEMENT evidence classifier (12.8.2) ──────────────────────────────

describe("classifyGAgreementEvidence", () => {
  const READ_AFTER = new Date("2026-10-20T11:00:00.000Z").getTime();
  const obs = (over: Partial<GAgreementObservation> = {}): GAgreementObservation => ({
    refundId: REFUND_ID,
    processedAt: "2026-10-20T10:00:31.000Z",
    agreements: [agreement()],
    verifiedAppId: APP_ID,
    readAtMs: READ_AFTER,
    ...over,
  });
  const negObs = (over: Partial<GAgreementObservation> = {}): GAgreementObservation =>
    obs({
      refundId: "gid://shopify/Refund/888",
      agreements: [
        agreement({
          id: "gid://shopify/RefundAgreement/9",
          refundId: "gid://shopify/Refund/888",
          appId: null, // staff-created: attributed to no app
        }),
      ],
      ...over,
    });

  const base = {
    baseRecorded: true,
    pos: obs(),
    negComparable: true,
    neg: negObs(),
  };

  it("CONFIRMED: positive match + negative control for a different app", () => {
    expect(classifyGAgreementEvidence(base).outcome).toBe("CONFIRMED");
    expect(
      classifyGAgreementEvidence({
        ...base,
        neg: negObs({
          agreements: [
            agreement({
              id: "gid://shopify/RefundAgreement/9",
              refundId: "gid://shopify/Refund/888",
              appId: "gid://shopify/App/OTHER",
            }),
          ],
        }),
      }).outcome,
    ).toBe("CONFIRMED");
  });

  it("INCONCLUSIVE: positive-only evidence", () => {
    expect(
      classifyGAgreementEvidence({ ...base, neg: null }).outcome,
    ).toBe("INCONCLUSIVE");
    expect(
      classifyGAgreementEvidence({ ...base, pos: null }).outcome,
    ).toBe("INCONCLUSIVE");
    expect(
      classifyGAgreementEvidence({ ...base, baseRecorded: false }).outcome,
    ).toBe("INCONCLUSIVE");
  });

  it("NEGATIVE: the negative control shows our own app id", () => {
    expect(
      classifyGAgreementEvidence({
        ...base,
        neg: negObs({
          verifiedAppId: APP_ID,
          agreements: [
            agreement({
              id: "gid://shopify/RefundAgreement/9",
              refundId: "gid://shopify/Refund/888",
              appId: APP_ID, // a staff refund shows OUR app — the rule fails
            }),
          ],
        }),
      }).outcome,
    ).toBe("NEGATIVE");
  });

  it("INCONCLUSIVE: unrecorded provenance (null agreement lists)", () => {
    expect(
      classifyGAgreementEvidence({ ...base, pos: obs({ agreements: null }) }).outcome,
    ).toBe("INCONCLUSIVE");
    expect(
      classifyGAgreementEvidence({ ...base, neg: negObs({ agreements: null }) }).outcome,
    ).toBe("INCONCLUSIVE");
  });

  it("NEGATIVE: wrong __typename or reason on the positive link", () => {
    for (const over of [
      { typename: "OrderEditAgreement" },
      { reason: "ORDER_EDIT" },
    ] as const) {
      const pos = obs({
        agreements: [agreement(over)],
      });
      expect(
        classifyGAgreementEvidence({ ...base, pos }).outcome,
        JSON.stringify(over),
      ).toBe("NEGATIVE");
    }
  });

  it("INCONCLUSIVE: a non-comparable negative control", () => {
    expect(
      classifyGAgreementEvidence({ ...base, negComparable: false }).outcome,
    ).toBe("INCONCLUSIVE");
  });

  it("INCONCLUSIVE: negative refund has no linked agreement", () => {
    expect(
      classifyGAgreementEvidence({
        ...base,
        neg: negObs({ agreements: [] }),
      }).outcome,
    ).toBe("INCONCLUSIVE");
  });

  it("NEGATIVE: no positive agreement after the visibility window", () => {
    expect(
      classifyGAgreementEvidence({
        ...base,
        pos: obs({ agreements: [] }),
      }).outcome,
    ).toBe("NEGATIVE");
  });

  it("INCONCLUSIVE: a positive read taken inside the visibility window", () => {
    const early = new Date("2026-10-20T10:05:00.000Z").getTime(); // within 15m of processedAt
    expect(
      classifyGAgreementEvidence({ ...base, pos: obs({ readAtMs: early }) }).outcome,
    ).toBe("INCONCLUSIVE");
    expect(
      classifyGAgreementEvidence({ ...base, neg: negObs({ readAtMs: early }) }).outcome,
    ).toBe("INCONCLUSIVE");
  });
});
