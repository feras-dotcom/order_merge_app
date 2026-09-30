import { describe, expect, it } from "vitest";
import {
  buildGroupKey,
  evaluateMergeGroup,
  lineItemIneligibility,
  orderStateIneligibility,
  selectCompatibleOrders,
  shippingSignature,
  type ShippingLineInfo,
} from "../app/lib/eligibility";
import { customRate, makeLineItem, makeOrder, standardRate } from "./fake-shopify";

const addr = makeOrder(1).shippingAddress!;
const C = "gid://shopify/Customer/1";

describe("buildGroupKey", () => {
  it("matches the same customer, recipient, address and method regardless of case/punctuation", () => {
    expect(buildGroupKey(C, addr, ["Standard"])).toBe(
      buildGroupKey(C, { ...addr, address1: "1 MAIN ST.", city: " springfield " }, ["  standard "]),
    );
  });

  it("differs for a different recipient name or company", () => {
    const base = buildGroupKey(C, addr, ["Standard"]);
    expect(buildGroupKey(C, { ...addr, firstName: "John" }, ["Standard"])).not.toBe(base);
    expect(buildGroupKey(C, { ...addr, company: "Acme" }, ["Standard"])).not.toBe(base);
  });

  it("compares fields positionally so an empty field cannot shift and collide", () => {
    const a = buildGroupKey(C, { ...addr, address2: "Springfield", city: "" }, ["Standard"]);
    const b = buildGroupKey(C, { ...addr, address2: "", city: "Springfield" }, ["Standard"]);
    expect(a).not.toBe(b);
  });

  it("differs for a different customer at the same address", () => {
    expect(buildGroupKey("gid://shopify/Customer/2", addr, ["Standard"])).not.toBe(
      buildGroupKey(C, addr, ["Standard"]),
    );
  });

  it("is null without a customer, street, country, or exactly one shipping method", () => {
    expect(buildGroupKey(null, addr, ["Standard"])).toBeNull();
    expect(buildGroupKey(C, null, ["Standard"])).toBeNull();
    expect(buildGroupKey(C, { ...addr, address1: "" }, ["Standard"])).toBeNull();
    expect(buildGroupKey(C, { ...addr, countryCodeV2: null }, ["Standard"])).toBeNull();
    expect(buildGroupKey(C, addr, [])).toBeNull();
    expect(buildGroupKey(C, addr, ["Standard", "Express"])).toBeNull();
    expect(buildGroupKey(C, addr, [""])).toBeNull();
  });
});

describe("orderStateIneligibility", () => {
  it("accepts a paid, untouched, low-risk order", () => {
    expect(orderStateIneligibility(makeOrder(1))).toBeNull();
  });

  it.each([
    ["cancelled", { cancelledAt: "2026-10-01T00:00:00Z" }],
    ["closed", { closed: true }],
    ["partially paid", { displayFinancialStatus: "PARTIALLY_PAID" }],
    ["partially refunded", { displayFinancialStatus: "PARTIALLY_REFUNDED" }],
    ["partially fulfilled", { displayFulfillmentStatus: "PARTIALLY_FULFILLED" }],
    ["in progress at a fulfillment service", { displayFulfillmentStatus: "IN_PROGRESS" }],
    ["pending fulfillment", { displayFulfillmentStatus: "PENDING_FULFILLMENT" }],
    ["on hold", { displayFulfillmentStatus: "ON_HOLD" }],
    ["scheduled", { displayFulfillmentStatus: "SCHEDULED" }],
    ["with a fulfillment record", { fulfillments: [{ id: "f" }] }],
    ["medium risk", { riskLevel: "MEDIUM" }],
    ["unknown risk", { riskLevel: null }],
    ["without a customer", { customer: null }],
  ])("rejects an order that is %s", (_label, overrides) => {
    expect(orderStateIneligibility(makeOrder(1, overrides as any))).not.toBeNull();
  });
});

describe("lineItemIneligibility", () => {
  it.each([
    ["custom properties", { customAttributes: [{ key: "Engraving", value: "Hi" }] }],
    ["gift card", { isGiftCard: true }],
    ["subscription", { sellingPlan: { name: "Monthly" } }],
    ["bundle", { lineItemGroup: { id: "g" } }],
    ["no shipping required", { requiresShipping: false }],
    ["partially fulfilled item", { currentQuantity: 2, unfulfilledQuantity: 1 }],
    ["non-fulfillable quantity", { nonFulfillableQuantity: 1 }],
  ])("rejects an item with %s", (_label, overrides) => {
    expect(lineItemIneligibility("#1", [makeLineItem(overrides as any)], false)).not.toBeNull();
  });

  it("rejects a secondary item without a variant but allows it on the primary", () => {
    const custom = makeLineItem({ variant: null });
    expect(lineItemIneligibility("#2", [custom], true)).not.toBeNull();
    expect(lineItemIneligibility("#1", [custom], false)).toBeNull();
  });

  it("ignores items already removed from the order", () => {
    const removed = makeLineItem({ currentQuantity: 0, unfulfilledQuantity: 0, isGiftCard: true });
    expect(lineItemIneligibility("#1", [removed, makeLineItem()], true)).toBeNull();
  });

  it("rejects an order with nothing left to ship", () => {
    expect(lineItemIneligibility("#1", [makeLineItem({ currentQuantity: 0, unfulfilledQuantity: 0 })], true)).not.toBeNull();
  });
});

describe("evaluateMergeGroup", () => {
  const items = (...orders: ReturnType<typeof makeOrder>[]) =>
    new Map(orders.map((o) => [o.id, o.lineItems]));

  it("picks the oldest order as primary", () => {
    const a = makeOrder(1);
    const b = makeOrder(2);
    const result = evaluateMergeGroup([b, a], items(a, b));
    expect(result.ok && result.primary.id).toBe(a.id);
  });

  it("rejects different shipping methods, currencies or addresses", () => {
    const a = makeOrder(1);
    for (const b of [
      makeOrder(2, { shippingLines: { nodes: [{ title: "Express" }] } }),
      makeOrder(2, { presentmentCurrencyCode: "CAD" }),
      makeOrder(2, { shippingAddress: { ...a.shippingAddress!, zip: "99999" } }),
    ]) {
      expect(evaluateMergeGroup([a, b], items(a, b)).ok).toBe(false);
    }
  });

  it("rejects when any order's line items were not loaded", () => {
    const a = makeOrder(1);
    const b = makeOrder(2);
    expect(evaluateMergeGroup([a, b], new Map([[a.id, a.lineItems]])).ok).toBe(false);
  });
});

describe("shipping-method equivalence", () => {
  const withShipping = (n: number, ...lines: ShippingLineInfo[]) =>
    makeOrder(n, { shippingLines: { nodes: lines } });
  const pair = (a: ShippingLineInfo[], b: ShippingLineInfo[]) => {
    const o1 = withShipping(1, ...a);
    const o2 = withShipping(2, ...b);
    return evaluateMergeGroup([o1, o2], new Map([[o1.id, o1.lineItems], [o2.id, o2.lineItems]]));
  };

  it("identical standard rates → eligible", () => {
    expect(pair([standardRate()], [standardRate()]).ok).toBe(true);
  });

  it("same standard rate at a different cart-dependent price → eligible", () => {
    const pricier = standardRate({ originalPriceSet: { shopMoney: { amount: "9.0", currencyCode: "USD" } } });
    expect(pair([standardRate()], [pricier]).ok).toBe(true);
  });

  it.each([
    ["title", { title: "Express", code: "Express" }],
    ["code", { code: "Standard-2" }],
    ["source", { source: "usps" }],
    ["carrier", { carrierIdentifier: "abc123" }],
  ])("standard rates differing by %s → rejected", (_label, overrides) => {
    const result = pair([standardRate()], [standardRate(overrides as Partial<ShippingLineInfo>)]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/Shipping methods differ|do not share/);
  });

  it("identical Custom rates (same title and price) → eligible", () => {
    expect(pair([customRate("20.0")], [customRate("20.0")]).ok).toBe(true);
  });

  it("Custom rates only differing by source (null vs shopify, as seen live) → eligible", () => {
    expect(pair([customRate("5.0", { source: null })], [customRate("5.0")]).ok).toBe(true);
  });

  it("Custom rates at different prices → rejected, with a diagnosable reason", () => {
    const result = pair([customRate("10.0")], [customRate("20.0")]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('"Custom" custom rate (10.0 USD)');
    expect(!result.ok && result.reason).toContain("(20.0 USD)");
  });

  it("renamed Custom rates at the same price → rejected", () => {
    expect(pair([customRate("10.0", { title: "Rush" })], [customRate("10.0", { title: "Economy" })]).ok).toBe(false);
  });

  it("a Custom rate never matches a Shopify rate with the same title and price", () => {
    expect(pair([customRate("5.0", { title: "Standard" })], [standardRate()]).ok).toBe(false);
  });

  it("missing shipping method → rejected", () => {
    expect(pair([], []).ok).toBe(false);
  });

  it("more than one shipping method → rejected", () => {
    expect(pair([standardRate(), standardRate()], [standardRate()]).ok).toBe(false);
  });

  it.each([
    ["unknown custom flag", { custom: null }],
    ["custom rate without a price", { custom: true, originalPriceSet: null }],
    ["custom rate with an unreadable price", { custom: true, originalPriceSet: { shopMoney: { amount: "n/a", currencyCode: "USD" } } }],
    ["blank title", { title: "  " }],
  ])("ambiguous metadata (%s) → conservative rejection", (_label, overrides) => {
    const line = standardRate(overrides as Partial<ShippingLineInfo>);
    expect(shippingSignature(line)).toBeNull();
    expect(pair([line], [line]).ok).toBe(false);
  });
});

describe("selectCompatibleOrders", () => {
  const items = (...orders: ReturnType<typeof makeOrder>[]) => new Map(orders.map((o) => [o.id, o.lineItems]));

  it("keeps the anchor and matching orders, excluding a mismatched one instead of blocking", () => {
    const a = makeOrder(1, { shippingLines: { nodes: [customRate("20.0")] } });
    const b = makeOrder(2, { shippingLines: { nodes: [customRate("10.0")] } });
    const anchor = makeOrder(3, { shippingLines: { nodes: [customRate("20.0")] } });
    const result = selectCompatibleOrders(anchor.id, [anchor, b, a], items(a, b, anchor));
    expect(result.ok && result.orders.map((o) => o.name)).toEqual(["#3", "#1"]);
    expect(result.ok && result.excluded[0]).toMatchObject({ name: "#2" });
    expect(result.ok && result.excluded[0].reason).toContain("Different shipping method");
  });

  it("never proceeds when the anchor itself doesn't qualify", () => {
    const a = makeOrder(1);
    const anchor = makeOrder(2, { riskLevel: "HIGH" });
    expect(selectCompatibleOrders(anchor.id, [anchor, a], items(a, anchor)).ok).toBe(false);
  });

  it("explains why nothing could combine with the anchor", () => {
    const a = makeOrder(1, { shippingLines: { nodes: [customRate("15.0")] } });
    const anchor = makeOrder(2, { shippingLines: { nodes: [customRate("5.0")] } });
    const result = selectCompatibleOrders(anchor.id, [anchor, a], items(a, anchor));
    expect(!result.ok && result.reason).toMatch(/No other order can combine with #2: #1 — Different shipping method/);
  });
});
