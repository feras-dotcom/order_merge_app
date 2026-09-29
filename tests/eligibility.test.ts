import { describe, expect, it } from "vitest";
import {
  buildGroupKey,
  evaluateMergeGroup,
  lineItemIneligibility,
  orderStateIneligibility,
} from "../app/lib/eligibility";
import { makeLineItem, makeOrder } from "./fake-shopify";

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
