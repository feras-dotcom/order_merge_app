// Pure tests for the §8.2 execution recheck and refund baseline
// (app/lib/shipping-refund-baseline.ts): STRICT_EMPTY admission, the
// refund-record classes, the two-read consistency check and the contained
// R2 comparison. No database, no I/O.

import { describe, expect, it } from "vitest";
import {
  admitBaseline,
  analyzeExecRecheck,
  buildPreEvidence,
  buildPriorRefundDiagnostic,
  buildRefundBaseline,
  classifyRefundRecord,
  compareBaselineAtR2,
  compareRecheckReads,
  REFUND_BASELINE_MODE,
  PRIOR_REFUND_DIAGNOSTIC_LIMIT,
  type ExecRecheckEvidence,
  type RefundBaseline,
} from "../app/lib/shipping-refund-baseline";

const SRC = "gid://shopify/Order/200";
const PRI = "gid://shopify/Order/100";
const TXN_CAP = "gid://shopify/OrderTransaction/901";
const TXN_AUTH = "gid://shopify/OrderTransaction/900";
const MONEY = (amount: string, currencyCode = "USD") => ({ amount, currencyCode });
const PM = (amount: string, currencyCode = "USD") => ({
  presentmentMoney: MONEY(amount, currencyCode),
});

const capture = (over: any = {}) => ({
  id: TXN_CAP,
  kind: "CAPTURE",
  status: "SUCCESS",
  gateway: "bogus",
  test: true,
  amountSet: PM("18.00"),
  parentTransaction: { id: TXN_AUTH },
  ...over,
});
const auth = () => ({
  id: TXN_AUTH,
  kind: "AUTHORIZATION",
  status: "SUCCESS",
  gateway: "bogus",
  test: true,
  amountSet: PM("18.00"),
  parentTransaction: null,
});

function recheckBody(over: { source?: any; primary?: any } = {}): any {
  return {
    data: {
      source: {
        id: SRC,
        cancelledAt: "2026-10-15T09:30:00Z",
        closed: true,
        displayFinancialStatus: "PAID",
        currencyCode: "USD",
        totalRefundedSet: PM("0.00"),
        totalRefundedShippingSet: PM("0.00"),
        refunds: [],
        transactions: [auth(), capture()],
        ...over.source,
      },
      primary: {
        id: PRI,
        cancelledAt: null,
        displayFinancialStatus: "PAID",
        currencyCode: "USD",
        ...over.primary,
      },
    },
  };
}

const ids = { sourceOrderId: SRC, primaryOrderId: PRI };

describe("execution recheck (§8.2.4)", () => {
  it("REFUND_BASELINE_MODE is STRICT_EMPTY — the only mode", () => {
    expect(REFUND_BASELINE_MODE).toBe("STRICT_EMPTY");
  });

  it("a clean body yields the parsed evidence", () => {
    const r = analyzeExecRecheck(recheckBody(), ids);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.evidence.currencyCode).toBe("USD");
    expect(r.evidence.capture.id).toBe(TXN_CAP);
    expect(r.evidence.authorizationId).toBe(TXN_AUTH);
    expect(r.evidence.refundIds).toEqual([]);
    expect(r.evidence.transactions.map((t) => t.id)).toEqual([TXN_AUTH, TXN_CAP]);
  });

  it("fails closed when the shape is malformed or ids mismatch", () => {
    expect(analyzeExecRecheck(null, ids).ok).toBe(false);
    expect(analyzeExecRecheck({ data: {} }, ids).ok).toBe(false);
    const wrongId = recheckBody({ source: { id: "gid://shopify/Order/999" } });
    const r = analyzeExecRecheck(wrongId, ids);
    expect(r).toMatchObject({ ok: false, reasonCode: "BASELINE_UNVERIFIED" });
  });

  it("requires exactly one SUCCESS CAPTURE/SALE", () => {
    const r = analyzeExecRecheck(
      recheckBody({ source: { transactions: [auth()] } }),
      ids,
    );
    expect(r).toMatchObject({ ok: false, reasonCode: "TRANSACTION_EVIDENCE_UNSUPPORTED" });
    const two = analyzeExecRecheck(
      recheckBody({
        source: { transactions: [auth(), capture(), capture({ id: "gid://shopify/OrderTransaction/902" })] },
      }),
      ids,
    );
    expect(two).toMatchObject({ ok: false, reasonCode: "TRANSACTION_EVIDENCE_UNSUPPORTED" });
  });

  it("rejects extra transaction kinds — a REFUND, VOID or CHANGE fails", () => {
    for (const kind of ["REFUND", "VOID", "CHANGE"]) {
      const r = analyzeExecRecheck(
        recheckBody({
          source: {
            transactions: [
              auth(),
              capture(),
              {
                id: "gid://shopify/OrderTransaction/903",
                kind,
                status: "SUCCESS",
                gateway: "bogus",
                test: true,
                amountSet: PM("8.00"),
                parentTransaction: { id: TXN_CAP },
              },
            ],
          },
        }),
        ids,
      );
      expect(r).toMatchObject({ ok: false, reasonCode: "TRANSACTION_EVIDENCE_UNSUPPORTED" });
    }
  });

  it("an authorization unrelated to the capture fails", () => {
    const strayAuth = {
      id: "gid://shopify/OrderTransaction/904",
      kind: "AUTHORIZATION",
      status: "SUCCESS",
      gateway: "bogus",
      test: true,
      amountSet: PM("1.00"),
      parentTransaction: null,
    };
    const r = analyzeExecRecheck(
      recheckBody({ source: { transactions: [auth(), capture(), strayAuth] } }),
      ids,
    );
    expect(r).toMatchObject({ ok: false, reasonCode: "TRANSACTION_EVIDENCE_UNSUPPORTED" });
  });

  it("primary cancelled or refunded/voided fails", () => {
    expect(
      analyzeExecRecheck(recheckBody({ primary: { cancelledAt: "2026-10-15T09:31:00Z" } }), ids),
    ).toMatchObject({ ok: false, reasonCode: "PRIMARY_INELIGIBLE" });
    for (const st of ["REFUNDED", "VOIDED"]) {
      expect(
        analyzeExecRecheck(recheckBody({ primary: { displayFinancialStatus: st } }), ids),
      ).toMatchObject({ ok: false, reasonCode: "PRIMARY_INELIGIBLE" });
    }
  });

  it("source no longer cancelled or not PAID fails", () => {
    expect(
      analyzeExecRecheck(recheckBody({ source: { cancelledAt: null } }), ids),
    ).toMatchObject({ ok: false, reasonCode: "SOURCE_STATE_CHANGED" });
    expect(
      analyzeExecRecheck(recheckBody({ source: { displayFinancialStatus: "PENDING" } }), ids),
    ).toMatchObject({ ok: false, reasonCode: "SOURCE_STATE_CHANGED" });
  });

  it("currency disagreement between source and primary fails", () => {
    expect(
      analyzeExecRecheck(recheckBody({ primary: { currencyCode: "EUR" } }), ids),
    ).toMatchObject({ ok: false, reasonCode: "CURRENCY_MISMATCH" });
  });

  it("a nonzero refunded aggregate is parsed but not admitted under STRICT_EMPTY", () => {
    const r = analyzeExecRecheck(
      recheckBody({ source: { totalRefundedSet: PM("2.50") } }),
      ids,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const baseline = buildRefundBaseline({
      capturedAt: "2026-10-16T00:00:00Z",
      currency: "USD",
      evidence: r.evidence,
    });
    expect(admitBaseline(baseline)).toMatchObject({
      ok: false,
      reasonCode: "PRIOR_REFUND_RECORD",
    });
  });

  it("nonzero refunded SHIPPING fails as PRIOR_REFUNDED_SHIPPING", () => {
    const r = analyzeExecRecheck(
      recheckBody({ source: { totalRefundedShippingSet: PM("1.00") } }),
      ids,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      admitBaseline(
        buildRefundBaseline({ capturedAt: "2026-10-16T00:00:00Z", currency: "USD", evidence: r.evidence }),
      ),
    ).toMatchObject({ ok: false, reasonCode: "PRIOR_REFUNDED_SHIPPING" });
  });

  it("unparseable aggregates are BASELINE_UNVERIFIED", () => {
    expect(
      analyzeExecRecheck(
        recheckBody({ source: { totalRefundedSet: { presentmentMoney: { amount: "x", currencyCode: "USD" } } } }),
        ids,
      ),
    ).toMatchObject({ ok: false, reasonCode: "BASELINE_UNVERIFIED" });
  });
});

describe("refund-record classification (§8.2.1)", () => {
  const node = (over: any = {}) => ({
    id: "gid://shopify/Refund/1",
    note: "",
    createdAt: "2026-10-15T10:00:00Z",
    processedAt: "2026-10-15T10:00:00Z",
    order: { id: SRC },
    totalRefundedSet: PM("0.00"),
    duties: [],
    refundShippingLines: { nodes: [], pageInfo: { hasNextPage: false } },
    refundLineItems: { nodes: [{ id: "x" }], pageInfo: { hasNextPage: false } },
    orderAdjustments: { nodes: [], pageInfo: { hasNextPage: false } },
    transactions: { nodes: [], pageInfo: { hasNextPage: false } },
    ...over,
  });

  it("a zero-total empty refund is a BASELINE_CANDIDATE (restock-only)", () => {
    expect(classifyRefundRecord(node(), "USD")).toBe("BASELINE_CANDIDATE");
  });

  it("money, transactions, shipping lines, adjustments, duties or the marker are FINANCIAL", () => {
    expect(classifyRefundRecord(node({ totalRefundedSet: PM("1.00") }), "USD")).toBe("FINANCIAL");
    expect(
      classifyRefundRecord(
        node({ transactions: { nodes: [{ id: "t" }], pageInfo: { hasNextPage: false } } }),
        "USD",
      ),
    ).toBe("FINANCIAL");
    expect(
      classifyRefundRecord(
        node({ refundShippingLines: { nodes: [{ x: 1 }], pageInfo: { hasNextPage: false } } }),
        "USD",
      ),
    ).toBe("FINANCIAL");
    expect(classifyRefundRecord(node({ duties: [{ a: 1 }] }), "USD")).toBe("FINANCIAL");
    expect(classifyRefundRecord(node({ note: "x MS-SHIPREFUND-abc y" }), "USD")).toBe("FINANCIAL");
  });

  it("missing fields, truncated connections and wrong currency are UNCLASSIFIABLE", () => {
    expect(
      classifyRefundRecord(node({ refundLineItems: { nodes: [], pageInfo: { hasNextPage: true } } }), "USD"),
    ).toBe("UNCLASSIFIABLE");
    expect(classifyRefundRecord(node({ duties: null }), "USD")).toBe("UNCLASSIFIABLE");
    expect(classifyRefundRecord(node({ totalRefundedSet: PM("0.00", "EUR") }), "USD")).toBe(
      "UNCLASSIFIABLE",
    );
    expect(classifyRefundRecord(null, "USD")).toBe("UNCLASSIFIABLE");
  });
});

describe("the STRICT_EMPTY baseline (§8.2.2/8.2.3)", () => {
  const evidence: ExecRecheckEvidence = {
    currencyCode: "USD",
    refundIds: [],
    transactions: [
      { id: TXN_AUTH, kind: "AUTHORIZATION", status: "SUCCESS", gateway: "bogus", test: true, amountMinor: "1800", parentTransactionId: null },
      { id: TXN_CAP, kind: "CAPTURE", status: "SUCCESS", gateway: "bogus", test: true, amountMinor: "1800", parentTransactionId: TXN_AUTH },
    ],
    capture: { id: TXN_CAP, kind: "CAPTURE", status: "SUCCESS", gateway: "bogus", test: true, amountMinor: "1800", parentTransactionId: TXN_AUTH },
    authorizationId: TXN_AUTH,
    totalRefundedMinor: "0",
    totalRefundedShippingMinor: "0",
  };

  it("builds the canonical empty baseline and admits it", () => {
    const baseline = buildRefundBaseline({
      capturedAt: "2026-10-16T00:00:00Z",
      currency: "USD",
      evidence,
    });
    expect(baseline.mode).toBe("STRICT_EMPTY");
    expect(baseline.refundCount).toBe(0);
    expect(baseline.transactionIds).toEqual([TXN_AUTH, TXN_CAP]);
    expect(baseline.moneyTransactionCount).toBe(2);
    expect(admitBaseline(baseline).ok).toBe(true);
  });

  it("preEvidence carries aggregates, counts, transaction and capture ids", () => {
    const baseline = buildRefundBaseline({ capturedAt: "t", currency: "USD", evidence });
    const ev = buildPreEvidence({ evidence, baseline });
    expect(ev).toMatchObject({
      refundCount: 0,
      transactionIds: [TXN_AUTH, TXN_CAP],
      captureTransactionId: TXN_CAP,
      authorizationTransactionId: TXN_AUTH,
    });
  });

  it("two-read consistency requires identical refund ids, transaction ids and aggregates", () => {
    const second: ExecRecheckEvidence = { ...evidence };
    expect(compareRecheckReads(evidence, second)).toBe(true);
    expect(
      compareRecheckReads(evidence, { ...second, refundIds: ["gid://shopify/Refund/7"] }),
    ).toBe(false);
    expect(compareRecheckReads(evidence, { ...second, totalRefundedMinor: "1" })).toBe(false);
    expect(
      compareRecheckReads(evidence, {
        ...second,
        transactions: second.transactions.slice(0, 1),
      }),
    ).toBe(false);
  });

  it("the diagnostic is bounded and carries no note text", () => {
    const many = Array.from({ length: 49 }, (_, i) => ({
      id: `gid://shopify/Refund/${i + 1}`,
      class: "FINANCIAL" as const,
    }));
    const out = buildPriorRefundDiagnostic(many);
    expect(out.length).toBeLessThanOrEqual(PRIOR_REFUND_DIAGNOSTIC_LIMIT + 64);
    expect(out).not.toContain("customer");
  });
});

describe("the contained R2 comparison (§8.2.5)", () => {
  const stored: RefundBaseline = {
    capturedAt: "2026-10-16T00:00:00Z",
    mode: "STRICT_EMPTY",
    currency: "USD",
    refunds: [],
    refundCount: 0,
    totalRefundedMinor: "0",
    totalRefundedShippingMinor: "0",
    transactionIds: [TXN_AUTH, TXN_CAP],
    moneyTransactionCount: 2,
  };
  const fresh = (over: any = {}) => ({
    refunds: [],
    totalRefundedMinor: "0",
    totalRefundedShippingMinor: "0",
    transactionIds: [TXN_AUTH, TXN_CAP],
    refundNotes: {},
    ...over,
  });

  it("an identical state compares equal", () => {
    expect(compareBaselineAtR2(stored, fresh()).equal).toBe(true);
  });

  it("a new refund id is REFUND_APPEARED (EXTERNAL_REFUND)", () => {
    const r = compareBaselineAtR2(
      stored,
      fresh({
        refunds: [
          {
            id: "gid://shopify/Refund/9",
            totalMinor: "800",
            transactionCount: 1,
            shippingLineCount: 1,
            adjustmentCount: 0,
            dutyCount: 0,
            refundLineItemCount: 0,
          },
        ],
        totalRefundedMinor: "800",
      }),
    );
    expect(r).toMatchObject({ equal: false, kind: "REFUND_APPEARED" });
  });

  it("a MergeShip-marker refund on a never-dispatched row is UNEXPECTED_OWN_MARKER", () => {
    const r = compareBaselineAtR2(
      stored,
      fresh({
        refunds: [
          {
            id: "gid://shopify/Refund/8",
            totalMinor: "800",
            transactionCount: 1,
            shippingLineCount: 1,
            adjustmentCount: 0,
            dutyCount: 0,
            refundLineItemCount: 0,
          },
        ],
        refundNotes: { "gid://shopify/Refund/8": "note MS-SHIPREFUND-x" },
      }),
    );
    expect(r).toMatchObject({ equal: false, kind: "UNEXPECTED_OWN_MARKER" });
  });

  it("changed aggregates or transaction set are REFUND_APPEARED", () => {
    expect(
      compareBaselineAtR2(stored, fresh({ totalRefundedMinor: "5" })),
    ).toMatchObject({ equal: false, kind: "REFUND_APPEARED" });
    expect(
      compareBaselineAtR2(stored, fresh({ transactionIds: [TXN_AUTH] })),
    ).toMatchObject({ equal: false, kind: "REFUND_APPEARED" });
  });

  it("a changed baseline fingerprint is REFUND_APPEARED", () => {
    const withRefund: RefundBaseline = {
      ...stored,
      refunds: [
        {
          id: "gid://shopify/Refund/1",
          totalMinor: "0",
          transactionCount: 0,
          shippingLineCount: 0,
          adjustmentCount: 0,
          dutyCount: 0,
          refundLineItemCount: 1,
        },
      ],
      refundCount: 1,
    };
    const same = compareBaselineAtR2(
      withRefund,
      fresh({
        refunds: [
          {
            id: "gid://shopify/Refund/1",
            totalMinor: "0",
            transactionCount: 0,
            shippingLineCount: 0,
            adjustmentCount: 0,
            dutyCount: 0,
            refundLineItemCount: 1,
          },
        ],
      }),
    );
    expect(same.equal).toBe(true);
    const changed = compareBaselineAtR2(
      withRefund,
      fresh({
        refunds: [
          {
            id: "gid://shopify/Refund/1",
            totalMinor: "500",
            transactionCount: 1,
            shippingLineCount: 0,
            adjustmentCount: 0,
            dutyCount: 0,
            refundLineItemCount: 1,
          },
        ],
      }),
    );
    expect(changed).toMatchObject({ equal: false, kind: "REFUND_APPEARED" });
  });
});
