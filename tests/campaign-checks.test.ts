// Focused tests for the G-E7/A-NEG campaign helpers (Fix 1-3 verification):
// scripts/lib/campaign-checks.ts verdict rules, the evidence-dir guard,
// manifest accumulation, and the checked-in request documents' byte-equality
// with the contract module. No network, no database.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkBaselineDelta, checkNewRefundFinancials, checkOrderGuard,
  collectCampaignArtifacts, observeAttribution, overallVerdict,
  parseMoneyMinor, resolveCampaignOutDir,
  type OrderBaseline,
} from "../scripts/lib/campaign-checks";
import {
  shippingRefundMutationDocument,
  shippingRefundMutationDocumentTemplate,
} from "../app/lib/shipping-refund-contract";

const ORDER = "gid://shopify/Order/8078037057783";
const REFUND = "gid://shopify/Refund/9999000000001";
const PARENT = "gid://shopify/OrderTransaction/10162809569527";
const APP = "gid://shopify/App/426185785345";
const REPO = process.cwd();

const money = (amount: string, cur = "USD") => ({ presentmentMoney: { amount: amount, currencyCode: cur } });

const okOrder = (over: Record<string, unknown> = {}) => ({
  id: ORDER, test: true, refundable: true, displayFinancialStatus: "PAID",
  paymentGatewayNames: ["bogus"],
  totalShippingPriceSet: { shopMoney: { amount: "8.00", currencyCode: "USD" } },
  totalRefundedShippingSet: { shopMoney: { amount: "3.00", currencyCode: "USD" } },
  transactions: [
    { id: PARENT, kind: "CAPTURE", status: "SUCCESS", gateway: "bogus", test: true },
    { id: "gid://shopify/OrderTransaction/1", kind: "AUTHORIZATION", status: "SUCCESS", gateway: "bogus", test: true },
  ],
  ...over,
});

const okRefundNode = (over: Record<string, unknown> = {}) => ({
  id: REFUND, note: "MS-SHIPREFUND-E7-x", createdAt: "2026-10-20T10:00:00Z",
  processedAt: "2026-10-20T10:00:00Z",
  order: { id: ORDER },
  totalRefundedSet: money("1.00"),
  duties: [],
  refundShippingLines: { nodes: [{ subtotalAmountSet: money("1.00"), taxAmountSet: money("0.00") }], pageInfo: { hasNextPage: false } },
  refundLineItems: { nodes: [], pageInfo: { hasNextPage: false } },
  orderAdjustments: { nodes: [], pageInfo: { hasNextPage: false } },
  transactions: {
    nodes: [{ id: "gid://shopify/OrderTransaction/9", kind: "REFUND", status: "SUCCESS", gateway: "bogus", test: true, amountSet: money("1.00"), parentTransaction: { id: PARENT } }],
    pageInfo: { hasNextPage: false },
  },
  ...over,
});

const baseline: OrderBaseline = {
  orderId: ORDER, runAtUtc: "2026-10-20T09:00:00Z",
  refundIds: ["gid://shopify/Refund/1123042787575"],
  totalRefundedMinor: "3000", totalRefundedShippingMinor: "3000",
};

const currentOrder = (refundIds: string[], ship = "4.00", total = "4.00") => ({
  id: ORDER,
  totalRefundedSet: money(total), totalRefundedShippingSet: money(ship),
  refunds: refundIds.map((id) => ({ id, totalRefundedSet: money("1.00") })),
});

describe("parseMoneyMinor", () => {
  it("parses decimal strings to minor units at <=3dp", () => {
    expect(parseMoneyMinor("1.00")).toBe(1000n);
    expect(parseMoneyMinor("4.0")).toBe(4000n);
    expect(parseMoneyMinor("0.5")).toBe(500n);
    expect(parseMoneyMinor("8")).toBe(8000n);
  });
  it("refuses malformed and >3dp values", () => {
    for (const v of ["1.0005", "x", "", "1.2.3", -1, 1.5, null, undefined, "−1.00"]) {
      expect(parseMoneyMinor(v)).toBeNull();
    }
  });
});

describe("checkOrderGuard", () => {
  const opts = { expectedStoreOrderStatuses: ["PAID", "PARTIALLY_REFUNDED"] as const, minAvailableShippingMinor: 1000n };
  it("passes a PAID bogus test order with capacity", () => {
    expect(overallVerdict(checkOrderGuard(okOrder(), opts))).toBe("PASS");
  });
  it("fails insufficient refundable shipping", () => {
    const o = okOrder({ totalRefundedShippingSet: { shopMoney: { amount: "7.50", currencyCode: "USD" } } });
    const items = checkOrderGuard(o, opts);
    expect(overallVerdict(items)).toBe("FAIL");
    expect(items.find((i) => i.name === "guard.shippingCapacity")!.verdict).toBe("FAIL");
  });
  it("fails an empty or non-test transaction read and missing parent", () => {
    expect(overallVerdict(checkOrderGuard(okOrder({ transactions: [] }), opts))).toBe("FAIL");
    const noParent = okOrder({ transactions: [{ id: "x", kind: "REFUND", status: "SUCCESS", gateway: "bogus", test: true }] });
    expect(checkOrderGuard(noParent, opts).find((i) => i.name === "guard.parent")!.verdict).toBe("FAIL");
    const manual = okOrder({ paymentGatewayNames: ["manual"], transactions: [{ id: "x", kind: "SALE", status: "SUCCESS", gateway: "manual", test: false }] });
    expect(overallVerdict(checkOrderGuard(manual, opts))).toBe("FAIL");
  });
  it("marks a read at the 50-transaction bound INCOMPLETE, not PASS", () => {
    const o = okOrder({ transactions: Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, kind: "SALE", status: "SUCCESS", gateway: "bogus", test: true })) });
    const items = checkOrderGuard(o, opts);
    expect(items.find((i) => i.name === "guard.transactions")!.verdict).toBe("INCOMPLETE");
    expect(overallVerdict(items)).toBe("INCOMPLETE");
  });
  it("fails wrong financial status, non-test order or non-refundable", () => {
    expect(overallVerdict(checkOrderGuard(okOrder({ displayFinancialStatus: "REFUNDED" }), opts))).toBe("FAIL");
    expect(overallVerdict(checkOrderGuard(okOrder({ test: false }), opts))).toBe("FAIL");
    expect(overallVerdict(checkOrderGuard(okOrder({ refundable: false }), opts))).toBe("FAIL");
  });
});

describe("checkBaselineDelta", () => {
  const opts = { newRefundId: REFUND, shippingDeltaMinor: 1000n, totalDeltaMinor: 1000n };
  it("passes exactly baseline + the new refund with the expected delta", () => {
    expect(overallVerdict(checkBaselineDelta(baseline, currentOrder([...baseline.refundIds, REFUND]), opts))).toBe("PASS");
  });
  it("fails on an unexpected extra refund", () => {
    const items = checkBaselineDelta(baseline, currentOrder([...baseline.refundIds, REFUND, "gid://shopify/Refund/7"]), opts);
    expect(items.find((i) => i.name === "delta.refundSet")!.verdict).toBe("FAIL");
  });
  it("fails when the expected new refund is absent (a create that did not land)", () => {
    const items = checkBaselineDelta(baseline, currentOrder([...baseline.refundIds], "3.00", "3.00"), opts);
    expect(items.find((i) => i.name === "delta.refundSet")!.verdict).toBe("FAIL");
    expect(items.find((i) => i.name === "delta.shipping")!.verdict).toBe("FAIL");
  });
  it("fails a wrong shipping or total delta", () => {
    const items = checkBaselineDelta(baseline, currentOrder([...baseline.refundIds, REFUND], "5.00", "4.00"), opts);
    expect(items.find((i) => i.name === "delta.shipping")!.verdict).toBe("FAIL");
    expect(items.find((i) => i.name === "delta.total")!.verdict).toBe("PASS");
  });
});

describe("checkNewRefundFinancials", () => {
  const opts = { refundId: REFUND, orderId: ORDER, parentTransactionId: PARENT, amountMinor: 1000n, currency: "USD" };
  it("passes a conforming shipping-only refund", () => {
    expect(overallVerdict(checkNewRefundFinancials(okRefundNode(), opts))).toBe("PASS");
  });
  it("fails a wrong transaction amount, gateway, test flag or parent", () => {
    const wrong = (mut: (t: Record<string, unknown>) => void) => {
      const n = okRefundNode();
      mut((n.transactions.nodes as Array<Record<string, unknown>>)[0]);
      return checkNewRefundFinancials(n, opts).find((i) => i.name === "refund.transactions")!.verdict;
    };
    expect(wrong((t) => { t.amountSet = money("2.00"); })).toBe("FAIL");
    expect(wrong((t) => { t.gateway = "manual"; })).toBe("FAIL");
    expect(wrong((t) => { t.test = false; })).toBe("FAIL");
    expect(wrong((t) => { t.parentTransaction = { id: "gid://shopify/OrderTransaction/0" }; })).toBe("FAIL");
    expect(wrong((t) => { t.status = "PENDING"; })).toBe("FAIL");
  });
  it("fails merchandise content and unexpected adjustments", () => {
    const n = okRefundNode({ refundLineItems: { nodes: [{ id: "x" }], pageInfo: { hasNextPage: false } } });
    expect(checkNewRefundFinancials(n, opts).find((i) => i.name === "refund.refundLineItems")!.verdict).toBe("FAIL");
  });
  it("distinguishes truncated evidence as INCOMPLETE, not FAIL or PASS", () => {
    const n = okRefundNode({ transactions: { nodes: [], pageInfo: { hasNextPage: true } } });
    expect(checkNewRefundFinancials(n, opts).find((i) => i.name === "refund.transactions")!.verdict).toBe("INCOMPLETE");
    expect(overallVerdict(checkNewRefundFinancials(n, opts))).toBe("INCOMPLETE");
  });
});

describe("observeAttribution", () => {
  const link = (appId: string | null, refundId = REFUND) => ({
    __typename: "RefundAgreement", id: "a1", reason: "REFUND", happenedAt: "h",
    app: appId ? { id: appId } : null, refund: { id: refundId },
  });
  it("reports app-attributed only for the expected app id", () => {
    expect(observeAttribution([link(APP)], true, REFUND, APP, true).kind).toBe("APP-ATTRIBUTED");
    expect(observeAttribution([link("gid://shopify/App/1")], true, REFUND, APP, true).kind).toBe("FOREIGN-APP");
    expect(observeAttribution([link(null)], true, REFUND, APP, true).kind).toBe("FOREIGN-APP");
  });
  it("is INCONCLUSIVE on incomplete pages or inside the visibility window", () => {
    expect(observeAttribution([link(APP)], false, REFUND, APP, true).kind).toBe("INCONCLUSIVE");
    expect(observeAttribution([link(APP)], true, REFUND, APP, false).kind).toBe("INCONCLUSIVE");
    expect(observeAttribution([], true, REFUND, APP, true).kind).toBe("NO-LINKED-AGREEMENT");
    expect(observeAttribution([link(APP), link(APP)], true, REFUND, APP, true).kind).toBe("DUPLICATE-LINKS");
  });
});

describe("resolveCampaignOutDir", () => {
  it("refuses the pinned S1 archive and its subdirectories", () => {
    for (const p of ["docs/evidence/shipping-v0", "docs/evidence/shipping-v0/sub", join(REPO, "docs", "evidence", "shipping-v0")]) {
      expect(resolveCampaignOutDir(REPO, p).ok).toBe(false);
    }
  });
  it("refuses repo-internal paths outside docs/evidence", () => {
    for (const p of ["app/lib/x", "scripts", ".", "docs"]) {
      expect(resolveCampaignOutDir(REPO, p).ok).toBe(false);
    }
  });
  it("accepts docs/evidence campaign dirs and outside-repo scratch dirs", () => {
    expect(resolveCampaignOutDir(REPO, "docs/evidence/shipping-v0-e7").ok).toBe(true);
    expect(resolveCampaignOutDir(REPO, join(tmpdir(), "ms-e7-scratch")).ok).toBe(true);
  });
});

describe("collectCampaignArtifacts (manifest accumulation)", () => {
  it("covers artifacts from consecutive runs plus operator files", () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-camp-"));
    // run 1
    for (const f of ["q-appid-a-identity.json", "baseline-8078.json", "validation-register-a.json", "MANIFEST.sha256"]) {
      writeFileSync(join(dir, f), "{}");
    }
    const run1 = collectCampaignArtifacts(dir);
    expect(run1).toContain("baseline-8078.json");
    expect(run1).not.toContain("MANIFEST.sha256");
    // operator mutation outputs land between runs
    writeFileSync(join(dir, "e7-1-concurrent-A.json"), "{}");
    writeFileSync(join(dir, "e7-1-concurrent-B.json"), "{}");
    // run 2 adds its artifacts
    writeFileSync(join(dir, "q-reconcile-b-order.json"), "{}");
    writeFileSync(join(dir, "validation-register-b.json"), "{}");
    const run2 = collectCampaignArtifacts(dir);
    for (const f of [...run1, "e7-1-concurrent-A.json", "e7-1-concurrent-B.json", "q-reconcile-b-order.json", "validation-register-b.json"]) {
      expect(run2).toContain(f);
    }
  });
});

describe("checked-in request documents", () => {
  const dir = join(REPO, "docs", "evidence", "shipping-v0-e7");
  it("e7-refund.graphql is byte-identical to the pinned contract document", () => {
    expect(readFileSync(join(dir, "e7-refund.graphql"), "utf8")).toBe(shippingRefundMutationDocument());
  });
  it("e7-refund-literal-template.graphql is byte-identical to the 10.3 template", () => {
    expect(readFileSync(join(dir, "e7-refund-literal-template.graphql"), "utf8")).toBe(shippingRefundMutationDocumentTemplate());
  });
});
