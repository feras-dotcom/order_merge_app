import { describe, expect, it } from "vitest";
import { executeMerge, resumeIncompleteMerges, REVIEW_TAG } from "../app/lib/merge.server";
import {
  advance,
  FakeShopify,
  makeLineItem,
  makeOrder,
  MemoryJournal,
  testDeps,
  topLevelError,
  userError,
} from "./fake-shopify";

const SHOP = "test.myshopify.com";
const IDS = ["gid://shopify/Order/2", "gid://shopify/Order/1"];

function setup(orders = [makeOrder(1), makeOrder(2)]) {
  const shopify = new FakeShopify(orders);
  const journal = new MemoryJournal();
  const deps = testDeps(journal);
  return { shopify, journal, deps };
}

const WRITES = ["MergeEditCommit", "MergeCancelSecondary", "MergeAnnotateOrder", "MergeCloseSecondary"];
const noWrites = (shopify: FakeShopify) => WRITES.every((w) => shopify.mutationCalls(w) === 0);

describe("executeMerge — happy path", () => {
  it("moves items to the oldest order, confirms the cancellation and records history once", async () => {
    const { shopify, journal, deps } = setup();
    const result = await executeMerge(shopify.admin, SHOP, IDS, deps);

    expect(result.outcome).toBe("merged");
    expect(result.primaryName).toBe("#1");
    expect(shopify.order(1).lineItems).toHaveLength(2);
    expect(shopify.order(2).cancelledAt).not.toBeNull();
    expect(shopify.order(2).cancelCount).toBe(1);
    expect(shopify.order(1).tags).toContain("Consolidated");
    expect(shopify.order(2).tags).toContain("Merged");
    expect(journal.only().status).toBe("COMPLETED");
    expect(journal.history).toHaveLength(1);
  });

  it("waits for an asynchronous cancellation to become visible", async () => {
    const { shopify, deps } = setup([makeOrder(1), makeOrder(2, { cancelDelayReads: 2 })]);
    const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
    expect(result.outcome).toBe("merged");
  });

  it("carries the secondary's customer note and tags to the primary", async () => {
    const { shopify, deps } = setup([makeOrder(1), makeOrder(2, { note: "Leave at back door", tags: ["VIP"] })]);
    await executeMerge(shopify.admin, SHOP, IDS, deps);
    expect(shopify.order(1).note).toContain("Note from #2: Leave at back door");
    expect(shopify.order(1).tags).toContain("VIP");
  });
});

describe("executeMerge — conservative eligibility (nothing changes)", () => {
  it.each([
    ["partially fulfilled secondary", [makeOrder(1), makeOrder(2, { displayFulfillmentStatus: "PARTIALLY_FULFILLED" })]],
    ["partially fulfilled line item", [makeOrder(1), makeOrder(2, { lineItems: [makeLineItem({ currentQuantity: 2, unfulfilledQuantity: 1 })] })]],
    ["primary on hold", [makeOrder(1, { displayFulfillmentStatus: "ON_HOLD" }), makeOrder(2)]],
    ["different recipient", [makeOrder(1), makeOrder(2, { shippingAddress: { ...makeOrder(2).shippingAddress!, firstName: "John" } })]],
    ["high fraud risk", [makeOrder(1), makeOrder(2, { riskLevel: "HIGH" })]],
    ["gift card", [makeOrder(1), makeOrder(2, { lineItems: [makeLineItem({ isGiftCard: true })] })]],
  ])("skips: %s", async (_label, orders) => {
    const { shopify, journal, deps } = setup(orders as any);
    const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
    expect(result.outcome).toBe("skipped");
    expect(shopify.mutationCalls("MergeEditBegin")).toBe(0);
    expect(noWrites(shopify)).toBe(true);
    expect(journal.ops.size).toBe(0);
  });

  it("skips multi-location shops", async () => {
    const { shopify, deps } = setup();
    shopify.activeLocations = 2;
    const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
    expect(result.outcome).toBe("skipped");
    expect(shopify.mutationCalls("MergeEditBegin")).toBe(0);
  });

  it("fails safely when the location count cannot be read", async () => {
    const { shopify, deps } = setup();
    shopify.on("MergeLocationCount", () => topLevelError("Access denied for locationsCount"));
    const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
    expect(result.outcome).toBe("failed");
    expect(noWrites(shopify)).toBe(true);
  });

  it("does not commit if an order changes while the edit is being built", async () => {
    const { shopify, journal, deps } = setup();
    shopify.on("MergeEditDiscount", () => {
      shopify.order(2).displayFulfillmentStatus = "PARTIALLY_FULFILLED";
      return undefined;
    });
    const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
    expect(result.outcome).toBe("skipped");
    expect(shopify.mutationCalls("MergeEditCommit")).toBe(0);
    expect(shopify.order(1).lineItems).toHaveLength(1);
    expect(journal.ops.size).toBe(0);
  });
});

describe("executeMerge — mutation failures before commit (nothing changes)", () => {
  it.each([
    ["top-level error on add", "MergeEditAddVariant", topLevelError()],
    ["userErrors on add", "MergeEditAddVariant", userError("orderEditAddVariant")],
    ["top-level error on discount", "MergeEditDiscount", topLevelError()],
    ["userErrors on discount", "MergeEditDiscount", userError("orderEditAddLineItemDiscount")],
    [
      "top-level error alongside an empty-userErrors payload on discount",
      "MergeEditDiscount",
      { errors: [{ message: "Throttled" }], data: { orderEditAddLineItemDiscount: { userErrors: [] } } },
    ],
    ["missing calculated order", "MergeEditBegin", { data: { orderEditBegin: { calculatedOrder: null, userErrors: [] } } }],
  ])("%s", async (_label, op, response) => {
    const { shopify, journal, deps } = setup();
    shopify.on(op, () => response);
    const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
    expect(result.outcome).toBe("failed");
    expect(shopify.mutationCalls("MergeEditCommit")).toBe(0);
    expect(shopify.order(2).cancelCount).toBe(0);
    expect(journal.ops.size).toBe(0);
  });

  it("does not commit when the journal cannot be written", async () => {
    const { shopify, journal, deps } = setup();
    journal.failCreate = true;
    const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
    expect(result.outcome).toBe("failed");
    expect(shopify.mutationCalls("MergeEditCommit")).toBe(0);
  });
});

describe("executeMerge — commit outcomes", () => {
  it("rejected commit: abandoned, secondaries untouched, orders unblocked", async () => {
    const { shopify, journal, deps } = setup();
    shopify.on("MergeEditCommit", () => userError("orderEditCommit"));
    const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
    expect(result.outcome).toBe("failed");
    expect(journal.only().status).toBe("ABANDONED");
    expect(shopify.order(2).cancelCount).toBe(0);
    expect((await journal.findBlockingOrderIds(SHOP)).size).toBe(0);
  });

  it("top-level error alongside an empty-userErrors commit payload is NOT treated as success", async () => {
    const { shopify, journal, deps } = setup();
    shopify.on("MergeEditCommit", () => ({
      errors: [{ message: "Internal error" }],
      data: { orderEditCommit: { order: null, userErrors: [] } },
    }));
    expect((await executeMerge(shopify.admin, SHOP, IDS, deps)).outcome).toBe("in_progress");
    expect(shopify.order(2).cancelCount).toBe(0);
    expect(journal.only().status).toBe("PENDING_COMMIT");
  });

  it("top-level error on commit is NOT treated as success: no cancellation", async () => {
    const { shopify, journal, deps } = setup();
    shopify.on("MergeEditCommit", () => topLevelError("Internal error"));
    const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
    expect(result.outcome).toBe("in_progress");
    expect(shopify.order(2).cancelCount).toBe(0);
    expect(journal.only().status).toBe("PENDING_COMMIT");
  });

  it("unknown commit outcome that DID apply: blocked, then resumed to completion after the grace period", async () => {
    const { shopify, journal, deps } = setup();
    shopify.on("MergeEditCommit", () => {
      shopify.applyCommit(shopify.lastCalcId()); // Shopify applied it...
      return topLevelError("Timeout"); // ...but we never saw the response.
    });
    expect((await executeMerge(shopify.admin, SHOP, IDS, deps)).outcome).toBe("in_progress");

    // A new merge attempt involving these orders must not run (no duplicate items).
    expect((await executeMerge(shopify.admin, SHOP, IDS, deps)).outcome).toBe("skipped");
    // Not reconciled while a slow commit might still be applying.
    expect(await resumeIncompleteMerges(shopify.admin, SHOP, deps)).toHaveLength(0);

    advance(deps, 6 * 60 * 1000);
    const [resumed] = await resumeIncompleteMerges(shopify.admin, SHOP, deps);
    expect(resumed.outcome).toBe("merged");
    expect(shopify.order(1).lineItems).toHaveLength(2);
    expect(shopify.order(2).cancelledAt).not.toBeNull();
    expect(journal.only().status).toBe("COMPLETED");
  });

  it("unknown commit outcome that did NOT apply: abandoned on resume, secondary untouched", async () => {
    const { shopify, journal, deps } = setup();
    shopify.on("MergeEditCommit", () => topLevelError("Timeout"));
    await executeMerge(shopify.admin, SHOP, IDS, deps);
    advance(deps, 6 * 60 * 1000);
    await resumeIncompleteMerges(shopify.admin, SHOP, deps);
    expect(journal.only().status).toBe("ABANDONED");
    expect(shopify.order(2).cancelCount).toBe(0);
    expect((await journal.findBlockingOrderIds(SHOP)).size).toBe(0);
  });

  it("unknown commit outcome with an unexplained line-item count: flagged for review", async () => {
    const { shopify, journal, deps } = setup();
    shopify.on("MergeEditCommit", () => {
      shopify.order(1).lineItems.push(makeLineItem(), makeLineItem()); // merchant edited it too
      return topLevelError("Timeout");
    });
    await executeMerge(shopify.admin, SHOP, IDS, deps);
    advance(deps, 6 * 60 * 1000);
    const [result] = await resumeIncompleteMerges(shopify.admin, SHOP, deps);
    expect(result.outcome).toBe("needs_review");
    expect(journal.only().status).toBe("NEEDS_REVIEW");
    expect(shopify.order(1).tags).toContain(REVIEW_TAG);
    expect(shopify.order(2).tags).toContain(REVIEW_TAG);
    expect(shopify.order(2).cancelCount).toBe(0);
  });
});

describe("executeMerge — after commit (secondary work)", () => {
  it("interrupted after commit: no false success, orders blocked, resume finishes without re-adding items", async () => {
    const { shopify, journal, deps } = setup();
    // Simulate the process losing the cancel call.
    shopify.on("MergeCancelSecondary", (_v, call) => (call === 1 ? topLevelError("Connection reset") : undefined));

    const first = await executeMerge(shopify.admin, SHOP, IDS, deps);
    expect(first.outcome).toBe("in_progress");
    expect(shopify.order(1).tags).not.toContain("Consolidated");
    expect(journal.history).toHaveLength(0);
    expect(journal.only().status).toBe("COMMITTED");

    // A later order for the same customer cannot re-merge the still-open secondary.
    expect((await executeMerge(shopify.admin, SHOP, IDS, deps)).outcome).toBe("skipped");

    // The lost request might have been accepted, so it is not re-issued yet.
    expect((await resumeIncompleteMerges(shopify.admin, SHOP, deps))[0].outcome).toBe("in_progress");
    expect(shopify.mutationCalls("MergeCancelSecondary")).toBe(1);

    advance(deps, 11 * 60 * 1000);
    const [resumed] = await resumeIncompleteMerges(shopify.admin, SHOP, deps);
    expect(resumed.outcome).toBe("merged");
    expect(shopify.order(1).lineItems).toHaveLength(2); // items added exactly once
    expect(shopify.order(2).cancelledAt).not.toBeNull();
    expect(journal.history).toHaveLength(1);
  });

  it("cancellation not yet visible: stays in progress, completes on a later resume", async () => {
    const { shopify, journal, deps } = setup([makeOrder(1), makeOrder(2, { cancelDelayReads: 5 })]);
    expect((await executeMerge(shopify.admin, SHOP, IDS, deps)).outcome).toBe("in_progress");
    expect(journal.only().status).toBe("COMMITTED");
    const [resumed] = await resumeIncompleteMerges(shopify.admin, SHOP, deps);
    expect(resumed.outcome).toBe("merged");
    expect(shopify.order(2).cancelCount).toBe(1); // never cancelled twice
  });

  it("repeatedly rejected cancellation escalates to review and flags both orders", async () => {
    const { shopify, journal, deps } = setup();
    shopify.on("MergeCancelSecondary", () => userError("orderCancel", "orderCancelUserErrors", "Cannot cancel"));
    expect((await executeMerge(shopify.admin, SHOP, IDS, deps)).outcome).toBe("in_progress");
    const [second] = await resumeIncompleteMerges(shopify.admin, SHOP, deps);
    expect(second.outcome).toBe("needs_review");
    expect(journal.only().status).toBe("NEEDS_REVIEW");
    expect(shopify.order(2).tags).toContain(REVIEW_TAG);
    expect(shopify.order(2).note).toContain("Do not fulfill");
    expect(await journal.findBlockingOrderIds(SHOP)).toContain("gid://shopify/Order/2");
  });

  it("secondary fulfilled after its items moved: flagged, not cancelled", async () => {
    const { shopify, journal, deps } = setup();
    shopify.on("MergeEditCommit", () => {
      shopify.applyCommit(shopify.lastCalcId());
      shopify.order(2).displayFulfillmentStatus = "FULFILLED";
      return { data: { orderEditCommit: { order: { id: "x" }, userErrors: [] } } };
    });
    const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
    expect(result.outcome).toBe("needs_review");
    expect(shopify.order(2).cancelCount).toBe(0);
    expect(journal.only().status).toBe("NEEDS_REVIEW");
  });

  it("annotation failures after a confirmed cancel do not affect the outcome", async () => {
    const { shopify, deps } = setup();
    shopify.on("MergeAnnotateOrder", () => topLevelError());
    shopify.on("MergeCloseSecondary", () => topLevelError());
    expect((await executeMerge(shopify.admin, SHOP, IDS, deps)).outcome).toBe("merged");
  });
});

describe("executeMerge — three orders", () => {
  it("merges two secondaries and records both", async () => {
    const { shopify, journal, deps } = setup([makeOrder(1), makeOrder(2), makeOrder(3)]);
    const result = await executeMerge(shopify.admin, SHOP, ["gid://shopify/Order/3", ...IDS], deps);
    expect(result.outcome).toBe("merged");
    expect(result.mergedCount).toBe(2);
    expect(shopify.order(1).lineItems).toHaveLength(3);
    expect(journal.history).toHaveLength(2);
  });

  it("second cancellation fails: first is recorded, op stays unfinished, resume completes only the second", async () => {
    const { shopify, journal, deps } = setup([makeOrder(1), makeOrder(2), makeOrder(3)]);
    shopify.on("MergeCancelSecondary", (vars, call) =>
      vars.orderId === "gid://shopify/Order/3" && call === 2 ? userError("orderCancel", "orderCancelUserErrors") : undefined,
    );
    const first = await executeMerge(shopify.admin, SHOP, ["gid://shopify/Order/3", ...IDS], deps);
    expect(first.outcome).toBe("in_progress");
    expect(journal.history.map((h) => h.mergedOrderName)).toEqual(["#2"]);

    const [resumed] = await resumeIncompleteMerges(shopify.admin, SHOP, deps);
    expect(resumed.outcome).toBe("merged");
    expect(shopify.order(2).cancelCount).toBe(1);
    expect(shopify.order(3).cancelCount).toBe(1); // the rejected request never reached Shopify
    expect(journal.history).toHaveLength(2);
  });
});
