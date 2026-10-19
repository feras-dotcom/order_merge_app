import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  AGREEMENTS_MAX_PAGES,
  AGREEMENTS_PAGE_SIZE,
  DETAIL_CONNECTION_FIRST,
  DETAIL_IDS_PER_REQUEST,
  DETAIL_REQUESTS_PER_EVALUATION,
  PLAIN_ARRAY_COMPLETENESS_LIMIT,
  Q_AGREEMENTS,
  Q_APPID,
  Q_RECHECK,
  Q_RECONCILE,
  Q_REFUND_DETAIL,
  QUERY_COST_ACCEPTANCE_LIMIT,
  SHIPPING_REFUND_QUERY_DOCUMENTS,
  validateAgreementPageBudget,
  validateAgreementsPage,
  validateAppIdentity,
  validateCompleteConnection,
  validateDetailRequestBudget,
  validateDetailRequestIds,
  validateExecRecheck,
  validatePlainArrayField,
  validateRefundDetailResponse,
  validateRefundList,
} from "../app/lib/shipping-refund-queries";

const SOURCE_GID = "gid://shopify/Order/4002";
const PRIMARY_GID = "gid://shopify/Order/4001";
const APP_GID = "gid://shopify/App/777";
const REFUND_GID = "gid://shopify/Refund/5001";

describe("document registry (12.1, 3.2 rules 8 and 9)", () => {
  it("holds exactly the five section 12.1 documents, each UNVALIDATED", () => {
    expect(SHIPPING_REFUND_QUERY_DOCUMENTS.map((d) => d.name)).toEqual([
      "Q-APPID",
      "Q-RECHECK",
      "Q-RECONCILE",
      "Q-REFUND-DETAIL",
      "Q-AGREEMENTS",
    ]);
    for (const doc of SHIPPING_REFUND_QUERY_DOCUMENTS) {
      expect(doc.validationStatus).toBe("UNVALIDATED");
      expect(doc.document).not.toContain("\r");
      expect(doc.document).not.toMatch(/[ \t]+\n/);
    }
  });

  it("pins each document's sha256 — any text edit is a visible event and resets validation", () => {
    expect(Q_APPID.documentSha256).toBe(
      "616d5da0b45467c102c60e368a7f339fbbb4b2f7f68a5d145c50c2c8175caf16",
    );
    expect(Q_RECHECK.documentSha256).toBe(
      "56d35112e5308721d82124fad1f80fe99a9ef711e7c7377426cef6879cefb12b",
    );
    expect(Q_RECONCILE.documentSha256).toBe(
      "b8b1389b8049215c84b164725dd4d4a54b4b0070d7e8e4c1330de7bf3f5685b4",
    );
    expect(Q_REFUND_DETAIL.documentSha256).toBe(
      "819d87965b0ec68238f3900d7de82b75839e24901a7f5aa858a2fc6a93a754e6",
    );
    expect(Q_AGREEMENTS.documentSha256).toBe(
      "26055b83248131155c8d8d53929bc755bb3435b01d3ab4575448b130d58014c8",
    );
  });

  it("no read document contains the word 'mutation' or the mutation path name", () => {
    for (const doc of SHIPPING_REFUND_QUERY_DOCUMENTS) {
      expect(doc.document.toLowerCase()).not.toContain("mutation");
      expect(doc.document).not.toContain("refundCreate");
      expect(doc.document.startsWith("query ")).toBe(true);
    }
  });

  it("records the designed worst-case bounds the G-READBACK measurement compares against", () => {
    expect(Q_RECHECK.bounds).toEqual({ refunds: 50, transactions: 50 });
    expect(Q_RECONCILE.bounds).toEqual({ refunds: 50, transactions: 50 });
    expect(Q_REFUND_DETAIL.bounds).toEqual({
      idsPerRequest: DETAIL_IDS_PER_REQUEST,
      requestsPerEvaluation: DETAIL_REQUESTS_PER_EVALUATION,
      nestedConnectionFirst: DETAIL_CONNECTION_FIRST,
    });
    expect(Q_AGREEMENTS.bounds).toEqual({
      pageSize: AGREEMENTS_PAGE_SIZE,
      maxPages: AGREEMENTS_MAX_PAGES,
    });
    // The bounds constants match the literals inside the documents.
    expect(Q_RECHECK.document).toContain("refunds(first: 50)");
    expect(Q_RECONCILE.document).toContain("transactions(first: 50)");
    expect(Q_REFUND_DETAIL.document).toContain("refundShippingLines(first: 10)");
    expect(Q_AGREEMENTS.document).toContain("agreements(first: 50, after: $after)");
    expect(DETAIL_IDS_PER_REQUEST).toBe(5);
    expect(DETAIL_REQUESTS_PER_EVALUATION).toBe(2);
    expect(DETAIL_CONNECTION_FIRST).toBe(10);
    expect(PLAIN_ARRAY_COMPLETENESS_LIMIT).toBe(50);
    expect(AGREEMENTS_PAGE_SIZE).toBe(50);
    expect(AGREEMENTS_MAX_PAGES).toBe(5);
    expect(QUERY_COST_ACCEPTANCE_LIMIT).toBe(500);
  });
});

describe("plain-array completeness (12.1 schema table)", () => {
  it("fewer than 50 entries is complete; 50 or more is unproven", () => {
    expect(validatePlainArrayField([], "x").ok).toBe(true);
    expect(validatePlainArrayField(new Array(49).fill(0), "x").ok).toBe(true);
    expect(validatePlainArrayField(new Array(50).fill(0), "x").ok).toBe(false);
    expect(validatePlainArrayField(new Array(51).fill(0), "x").ok).toBe(false);
    expect(validatePlainArrayField(null, "x").ok).toBe(false);
    expect(validatePlainArrayField({ nodes: [] }, "x").ok).toBe(false);
    expect(validatePlainArrayField("[]", "x").ok).toBe(false);
  });
});

describe("connection completeness", () => {
  it("requires pageInfo.hasNextPage to be exactly false", () => {
    const conn = (hasNextPage: unknown) => ({ nodes: [], pageInfo: { hasNextPage } });
    expect(validateCompleteConnection(conn(false), "c").ok).toBe(true);
    expect(validateCompleteConnection(conn(true), "c").ok).toBe(false);
    expect(validateCompleteConnection(conn(null), "c").ok).toBe(false);
    expect(validateCompleteConnection({ nodes: [] }, "c").ok).toBe(false);
    expect(validateCompleteConnection({ pageInfo: { hasNextPage: false } }, "c").ok).toBe(false);
    expect(validateCompleteConnection(null, "c").ok).toBe(false);
  });
});

describe("Q-APPID validator", () => {
  it("accepts the live app id and rejects anything else", () => {
    expect(validateAppIdentity({ data: { currentAppInstallation: { app: { id: APP_GID } } } })).toEqual({
      ok: true,
      appId: APP_GID,
    });
    for (const body of [
      { data: { currentAppInstallation: null } },
      { data: { currentAppInstallation: { app: null } } },
      { data: { currentAppInstallation: { app: { id: "not-a-gid" } } } },
      { data: { currentAppInstallation: { app: { id: "gid://shopify/App/" } } } },
      { data: { currentAppInstallation: { app: { id: "gid://shopify/App/abc" } } } },
      { data: { currentAppInstallation: { app: { id: "gid://shopify/App/777/extra" } } } },
      { data: { currentAppInstallation: { app: { id: 123 } } } },
      { data: {} },
      {},
      null,
      { errors: [{ message: "x" }], data: { currentAppInstallation: { app: { id: APP_GID } } } },
    ]) {
      expect(validateAppIdentity(body).ok).toBe(false);
    }
  });
});

describe("Q-RECHECK validator", () => {
  const order = (id: string, extra: object = {}) => ({
    id,
    cancelledAt: "2030-01-05T10:00:00Z",
    closed: true,
    displayFinancialStatus: "PAID",
    currencyCode: "USD",
    totalRefundedSet: { presentmentMoney: { amount: "0.00", currencyCode: "USD" } },
    totalRefundedShippingSet: { presentmentMoney: { amount: "0.00", currencyCode: "USD" } },
    refunds: [],
    transactions: [{ id: "gid://shopify/OrderTransaction/1", kind: "SALE", status: "SUCCESS", gateway: "bogus", test: true, amountSet: { presentmentMoney: { amount: "12.00", currencyCode: "USD" } }, parentTransaction: null }],
    ...extra,
  });
  const body = (overrides: object = {}) => ({
    data: {
      source: order(SOURCE_GID),
      primary: {
        id: PRIMARY_GID,
        cancelledAt: null,
        displayFinancialStatus: "PAID",
        currencyCode: "USD",
      },
      ...overrides,
    },
  });
  const expected = { sourceOrderId: SOURCE_GID, primaryOrderId: PRIMARY_GID };

  it("accepts a complete response", () => {
    expect(validateExecRecheck(body(), expected).ok).toBe(true);
  });

  it.each([
    ["null source", { source: null }],
    ["missing source", { source: undefined }],
    ["wrong source id", { source: order("gid://shopify/Order/9999") }],
    ["null primary", { primary: null }],
    ["wrong primary id", { primary: { id: "gid://shopify/Order/9999" } }],
    ["refunds at the bound", { source: order(SOURCE_GID, { refunds: new Array(50).fill({ id: "gid://shopify/Refund/1" }) }) }],
    ["a refund element with a non-GID id", { source: order(SOURCE_GID, { refunds: [{ id: "x" }] }) }],
    ["a refund element without an id", { source: order(SOURCE_GID, { refunds: [{ note: "n" }] }) }],
    ["duplicated refund ids", { source: order(SOURCE_GID, { refunds: [{ id: "gid://shopify/Refund/1" }, { id: "gid://shopify/Refund/1" }] }) }],
    ["transactions at the bound", { source: order(SOURCE_GID, { transactions: new Array(50).fill({}) }) }],
    ["a transaction with a non-GID id", { source: order(SOURCE_GID, { transactions: [{ id: "x" }] }) }],
    ["duplicated transaction ids", { source: order(SOURCE_GID, { transactions: [{ id: "gid://shopify/OrderTransaction/1" }, { id: "gid://shopify/OrderTransaction/1" }] }) }],
    ["refunds not an array", { source: order(SOURCE_GID, { refunds: { nodes: [] } }) }],
    ["transactions null", { source: order(SOURCE_GID, { transactions: null }) }],
  ])("rejects %s", (_label, overrides) => {
    expect(validateExecRecheck(body(overrides), expected).ok).toBe(false);
  });

  it("rejects malformed bodies and top-level errors", () => {
    for (const b of [null, {}, { data: null }, { errors: [{ message: "THROTTLED" }], data: body().data }]) {
      expect(validateExecRecheck(b, expected).ok).toBe(false);
    }
  });
});

describe("Q-RECONCILE validator", () => {
  const refund = (id: string) => ({
    id,
    note: null,
    createdAt: null,
    processedAt: "2030-01-05T10:00:00Z",
    totalRefundedSet: { presentmentMoney: { amount: "0.50", currencyCode: "USD" } },
  });
  const body = (refunds: unknown, transactions: unknown = []) => ({
    data: {
      order: {
        id: SOURCE_GID,
        cancelledAt: "2030-01-05T10:00:00Z",
        closed: true,
        displayFinancialStatus: "PAID",
        currencyCode: "USD",
        totalRefundedSet: { presentmentMoney: { amount: "0.00", currencyCode: "USD" } },
        totalRefundedShippingSet: { presentmentMoney: { amount: "0.00", currencyCode: "USD" } },
        refunds,
        transactions,
      },
    },
  });

  it("accepts empty and populated lists; a null createdAt is legal", () => {
    expect(validateRefundList(body([]), { sourceOrderId: SOURCE_GID }).ok).toBe(true);
    expect(validateRefundList(body([refund(REFUND_GID)]), { sourceOrderId: SOURCE_GID }).ok).toBe(true);
  });

  it.each([
    ["order absent", { data: { order: null } }],
    ["wrong order id", { data: { order: { ...body([], []).data.order, id: PRIMARY_GID } } }],
    ["refunds at the bound", body(new Array(50).fill(refund("gid://shopify/Refund/7")))],
    ["a refund element with a non-GID id", body([{ id: "x" }])],
    ["duplicated refund ids", body([refund(REFUND_GID), refund(REFUND_GID)])],
    ["transactions at the bound", body([], new Array(50).fill({}))],
    ["a transaction element with a non-GID id", body([], [{ id: "x" }])],
    ["duplicated transaction ids", body([], [{ id: "gid://shopify/OrderTransaction/1" }, { id: "gid://shopify/OrderTransaction/1" }])],
    ["a non-object transaction element", body([], ["txn!"])],
    ["refunds null", body(null)],
    ["a refund element without an id", body([{ note: "x" }])],
    ["a non-object refund element", body(["refund!"])],
  ])("rejects %s", (_label, b) => {
    expect(validateRefundList(b, { sourceOrderId: SOURCE_GID }).ok).toBe(false);
  });
});

describe("Q-REFUND-DETAIL bounds and response", () => {
  const detailNode = (id: string, over: object = {}) => ({
    id,
    note: null,
    createdAt: "2030-01-05T10:00:00Z",
    processedAt: "2030-01-05T10:00:00Z",
    order: { id: SOURCE_GID },
    totalRefundedSet: { presentmentMoney: { amount: "0.50", currencyCode: "USD" } },
    // Refund.duties is a nullable [RefundDuty!] list (F19) — a real array,
    // not the MoneyBag the money fields are.
    duties: [],
    refundShippingLines: { nodes: [], pageInfo: { hasNextPage: false } },
    refundLineItems: { nodes: [], pageInfo: { hasNextPage: false } },
    orderAdjustments: { nodes: [], pageInfo: { hasNextPage: false } },
    transactions: { nodes: [], pageInfo: { hasNextPage: false } },
    ...over,
  });
  const ids = ["gid://shopify/Refund/1", "gid://shopify/Refund/2", "gid://shopify/Refund/3"];
  const goodBody = () => ({ data: { nodes: ids.map((id) => detailNode(id)) } });

  it("refuses more than 5 ids per request and more than 2 requests per evaluation", () => {
    expect(validateDetailRequestIds(ids).ok).toBe(true);
    expect(validateDetailRequestIds([...ids, "gid://shopify/Refund/4", "gid://shopify/Refund/5"]).ok).toBe(true);
    expect(validateDetailRequestIds([...ids, "gid://shopify/Refund/4", "gid://shopify/Refund/5", "gid://shopify/Refund/6"]).ok).toBe(false);
    expect(validateDetailRequestIds(["a", "b"]).ok).toBe(false);
    expect(validateDetailRequestIds(["gid://shopify/Order/1"]).ok).toBe(false);
    expect(validateDetailRequestIds([]).ok).toBe(false);
    expect(validateDetailRequestIds([...ids, ids[0]]).ok).toBe(false);
    expect(validateDetailRequestIds("gid://shopify/Refund/1").ok).toBe(false);
    expect(validateDetailRequestIds([1, 2]).ok).toBe(false);
    expect(validateDetailRequestBudget(0).ok).toBe(true);
    expect(validateDetailRequestBudget(2).ok).toBe(true);
    expect(validateDetailRequestBudget(3).ok).toBe(false);
  });

  it("accepts an exact response", () => {
    expect(validateRefundDetailResponse(goodBody(), ids, { sourceOrderId: SOURCE_GID }).ok).toBe(true);
  });

  it.each([
    ["wrong node count", { data: { nodes: [detailNode(ids[0])] } }],
    ["a null node", { data: { nodes: [detailNode(ids[0]), null, detailNode(ids[2])] } }],
    ["a node for a different id", { data: { nodes: [detailNode(ids[0]), detailNode("gid://shopify/Refund/9"), detailNode(ids[2])] } }],
    ["duplicate ids", { data: { nodes: [detailNode(ids[0]), detailNode(ids[0]), detailNode(ids[2])] } }],
    ["nodes out of request order", { data: { nodes: [detailNode(ids[1]), detailNode(ids[0]), detailNode(ids[2])] } }],
    ["a fragment with no id", { data: { nodes: [detailNode(ids[0]), { __typename: "Order" }, detailNode(ids[2])] } }],
    ["wrong order.id", { data: { nodes: ids.map((id) => detailNode(id, { order: { id: PRIMARY_GID } })) } }],
    ["missing order", { data: { nodes: ids.map((id) => detailNode(id, { order: null })) } }],
    ["hasNextPage true", { data: { nodes: ids.map((id) => detailNode(id, { transactions: { nodes: [], pageInfo: { hasNextPage: true } } })) } }],
    ["hasNextPage missing", { data: { nodes: ids.map((id) => detailNode(id, { orderAdjustments: { nodes: [], pageInfo: {} } })) } }],
    ["nodes array missing", { data: { nodes: ids.map((id) => detailNode(id, { refundLineItems: { pageInfo: { hasNextPage: false } } })) } }],
    ["duties null", { data: { nodes: ids.map((id) => detailNode(id, { duties: null })) } }],
    ["duties an object", { data: { nodes: ids.map((id) => detailNode(id, { duties: { amountSet: {} } })) } }],
    ["duties missing", { data: { nodes: ids.map((id) => detailNode(id, { duties: undefined })) } }],
    ["no data", {}],
    ["top-level errors", { errors: [{ message: "x" }], data: { nodes: ids.map((id) => detailNode(id)) } }],
  ])("rejects %s", (_label, b) => {
    expect(validateRefundDetailResponse(b, ids, { sourceOrderId: SOURCE_GID }).ok).toBe(false);
  });

  it("rejects a non-empty orderAdjustments on OUR refund only (contradiction)", () => {
    const withAdjustment = {
      data: {
        nodes: ids.map((id, i) =>
          detailNode(id, i === 1 ? { orderAdjustments: { nodes: [{ id: "gid://shopify/OrderAdjustment/1" }], pageInfo: { hasNextPage: false } } } : {}),
        ),
      },
    };
    // Another refund carrying an adjustment is not our concern at this layer.
    expect(
      validateRefundDetailResponse(withAdjustment, ids, {
        sourceOrderId: SOURCE_GID,
        ownRefundId: "gid://shopify/Refund/9",
      }).ok,
    ).toBe(true);
    // Ours carrying one is a contradiction: a shipping-only refund has none.
    expect(
      validateRefundDetailResponse(withAdjustment, ids, {
        sourceOrderId: SOURCE_GID,
        ownRefundId: ids[1],
      }).ok,
    ).toBe(false);
  });
});

describe("Q-AGREEMENTS pagination bounds", () => {
  const agreement = (over: object = {}) => ({
    __typename: "RefundAgreement",
    id: "gid://shopify/SalesAgreement/1",
    happenedAt: "2030-01-05T10:00:00Z",
    reason: "REFUND",
    app: { id: APP_GID },
    refund: { id: REFUND_GID },
    ...over,
  });
  // The approved Q-AGREEMENTS document selects only `agreements` under `order`
  // — no `order.id` — so fixtures model exactly that selection set.
  const page = (nodes: unknown, pageInfo: unknown) => ({
    data: { order: { agreements: { nodes, pageInfo } } },
  });

  it("accepts a well-formed page, mid-page and final", () => {
    expect(
      validateAgreementsPage(page([agreement()], { hasNextPage: true, endCursor: "cursor-1" }), {
        sourceOrderId: SOURCE_GID,
      }).ok,
    ).toBe(true);
    expect(
      validateAgreementsPage(page([], { hasNextPage: false, endCursor: null }), {
        sourceOrderId: SOURCE_GID,
      }).ok,
    ).toBe(true);
  });

  it.each([
    ["a null order", { data: { order: null } }],
    ["order not an object", { data: { order: "x" } }],
    ["missing pageInfo", page([agreement()], undefined)],
    ["non-boolean hasNextPage", page([], { hasNextPage: "false" })],
    ["hasNextPage without endCursor", page([agreement()], { hasNextPage: true, endCursor: null })],
    ["untyped agreement node", page([{ id: "x" }], { hasNextPage: false, endCursor: null })],
    ["an agreement node with a non-string id", page([{ __typename: "RefundAgreement", id: 7 }], { hasNextPage: false, endCursor: null })],
    ["agreements not a connection", { data: { order: { agreements: [] } } }],
    ["agreements missing", { data: { order: {} } }],
  ])("rejects %s", (_label, b) => {
    expect(validateAgreementsPage(b, { sourceOrderId: SOURCE_GID }).ok).toBe(false);
  });

  it("enforces the five-page budget", () => {
    expect(validateAgreementPageBudget(1).ok).toBe(true);
    expect(validateAgreementPageBudget(AGREEMENTS_MAX_PAGES).ok).toBe(true);
    expect(validateAgreementPageBudget(AGREEMENTS_MAX_PAGES + 1).ok).toBe(false);
  });
});

describe("module isolation", () => {
  it("the registry contains no Shopify client, transport or mutation text", () => {
    const src = readFileSync(
      join(__dirname, "../app/lib/shipping-refund-queries.ts"),
      "utf8",
    );
    for (const token of [
      "admin.graphql",
      "shopify.server",
      "graphql.server",
      "db.server",
      "refundCreate",
      "DispatchPermit",
    ]) {
      expect(src).not.toContain(token);
    }
  });
});
