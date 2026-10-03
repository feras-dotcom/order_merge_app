import { describe, expect, it } from "vitest";
import { executeMerge, REVIEW_TAG } from "../app/lib/merge.server";
import { driveOperation } from "../app/lib/operation-protocol.server";
import { ClaimContentionError, newLeaseToken } from "../app/lib/ownership.server";
import {
  customRate,
  LOC_A,
  LOC_B,
  makeFulfillmentOrder,
  makeHarness,
  makeLineItem,
  makeOrder,
  topLevelError,
  userError,
} from "./fake-shopify";

const IDS = ["gid://shopify/Order/2", "gid://shopify/Order/1"];
const id = (n: number) => `gid://shopify/Order/${n}`;

type Harness = ReturnType<typeof makeHarness>;

const setup = (orders = [makeOrder(1), makeOrder(2)]) => makeHarness(orders);

/** Runs one due-operation step (clearing a still-live lease first, as a
 *  crashed worker's successor would see it). */
async function driveOnce(h: Harness, opId: string) {
  const row = h.ops.ops.get(opId);
  if (row?.leasedUntil && row.leasedUntil.getTime() >= h.clock().getTime()) {
    row.leasedUntil = null;
    row.leaseToken = null;
  }
  const op = await h.ops.acquireOperationLease(opId, newLeaseToken(), h.deps.leaseTtlMs);
  return op ? driveOperation(op, h.shopify.admin, h.deps) : null;
}

/** Plans the merge and drives the created operation to a stopping point. */
async function runMerge(h: Harness, ids: string[] = IDS, maxMs?: number) {
  const result = await executeMerge(h.shopify.admin, h.SHOP, ids, h.deps);
  const op = result.operationId ? await h.driveUntilIdle(result.operationId, maxMs) : null;
  return { result, op };
}

// Order-affecting and cosmetic writes; none may run when the planning says no.
const WRITES = [
  "MergeEditCommit",
  "MergeCancelSecondary",
  "MergeTagsAdd",
  "MergeAnnotateNote",
  "MergeOrderClose",
  "MergeAnnotateOrder",
  "MergeCloseSecondary",
];
const noWrites = (h: Harness) => WRITES.every((w) => h.shopify.mutationCalls(w) === 0);

describe("executeMerge — kill switch", () => {
  it("returns MERGES_DISABLED before any Shopify read when new merges are off", async () => {
    const h = setup();
    await h.ops.setControl({ newMergesEnabled: false });
    const result = await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    expect(result).toMatchObject({ outcome: "skipped", code: "MERGES_DISABLED" });
    expect(h.shopify.calls).toHaveLength(0); // not even a read reached Shopify
    expect(h.ops.ops.size).toBe(0);
  });

  it("scopes to the allowlist — a shop not listed is MERGES_DISABLED", async () => {
    const h = setup();
    await h.ops.setControl({ newMergesEnabled: true, allowShops: ["other.myshopify.com"] });
    const result = await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    expect(result).toMatchObject({ outcome: "skipped", code: "MERGES_DISABLED" });
    expect(h.shopify.calls).toHaveLength(0);
  });

  it("durable blockers still take precedence over the kill switch", async () => {
    const h = setup();
    await h.claims.acquire(h.SHOP, [id(1)], "holder", h.deps.leaseTtlMs);
    await h.ops.createOperation({
      shop: h.SHOP,
      claimToken: "holder",
      opToken: "HOLDERTK",
      involvedOrderIds: [id(1)],
      primaryOrderId: id(1),
      primaryOrderName: "#1",
      customerId: null,
      primaryLineItemCountBefore: 1,
      addedLineItemCount: 1,
      secondaries: [],
      calculatedOrderId: null,
      expectedTransfer: [],
      expectedLocationId: null,
      primaryLineItemIdsBefore: [],
      leaseToken: "holder-op",
      ttlMs: 60_000,
    });
    await h.claims.release(h.SHOP, [id(1)], "holder"); // lock stays; claim gone
    await h.ops.setControl({ newMergesEnabled: false });
    const result = await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    expect(result).toMatchObject({ outcome: "skipped", code: "LOCKED" });
  });

  it("createOperation itself is gated — the durable boundary throws when merges are off", async () => {
    const h = setup();
    await h.claims.acquire(h.SHOP, [id(1), id(2)], "tok", h.deps.leaseTtlMs);
    await h.ops.setControl({ newMergesEnabled: false });
    await expect(
      h.ops.createOperation({
        shop: h.SHOP,
        claimToken: "tok",
        opToken: "OPTK",
        involvedOrderIds: [id(1), id(2)],
        primaryOrderId: id(1),
        primaryOrderName: "#1",
        customerId: null,
        primaryLineItemCountBefore: 1,
        addedLineItemCount: 1,
        secondaries: [{ id: id(2), name: "#2", items: 1, cancelPhase: "TRANSFER_PENDING" }],
        calculatedOrderId: null,
        expectedTransfer: [],
        expectedLocationId: null,
        primaryLineItemIdsBefore: [],
        leaseToken: "op-tok",
        ttlMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(ClaimContentionError);
    expect(h.ops.ops.size).toBe(0);
    expect(h.ops.locks.size).toBe(0);
  });
});

describe("executeMerge — happy path", () => {
  it("creates the operation, then drives it: items moved, cancellation confirmed, history recorded once", async () => {
    const h = setup();
    const { result, op } = await runMerge(h);

    expect(result.outcome).toBe("operation_created");
    expect(result.primaryName).toBe("#1");
    expect(op?.phase).toBe("COMPLETED");
    expect(h.shopify.order(1).lineItems).toHaveLength(2);
    expect(h.shopify.order(2).cancelledAt).not.toBeNull();
    expect(h.shopify.order(2).cancelCount).toBe(1);
    expect(h.shopify.order(1).tags).toContain("Consolidated");
    expect(h.shopify.order(2).tags).toContain("Merged");
    expect(h.journal.history).toHaveLength(1);
    expect(h.ops.locks.size).toBe(0); // terminal transition released the locks
  });

  it("waits for an asynchronous cancellation to become visible", async () => {
    const h = setup([makeOrder(1), makeOrder(2, { cancelDelayReads: 2 })]);
    const { op } = await runMerge(h);
    expect(op?.phase).toBe("COMPLETED");
    expect(h.shopify.order(2).cancelCount).toBe(1);
  });

  it("carries the secondary's customer note and tags to the primary", async () => {
    const h = setup([makeOrder(1), makeOrder(2, { note: "Leave at back door", tags: ["VIP"] })]);
    const { op } = await runMerge(h);
    expect(op?.phase).toBe("COMPLETED");
    expect(h.shopify.order(1).note).toContain("Note from #2: Leave at back door");
    expect(h.shopify.order(1).tags).toContain("VIP");
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
    const h = setup(orders as any);
    const result = await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    expect(result.outcome).toBe("skipped");
    expect(result.disposition).toBe("terminal");
    expect(h.shopify.mutationCalls("MergeEditBegin")).toBe(0);
    expect(noWrites(h)).toBe(true);
    expect(h.ops.ops.size).toBe(0);
  });

  it("skips multi-location shops", async () => {
    const h = setup();
    h.shopify.activeLocations = 2;
    const result = await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    expect(result.outcome).toBe("skipped");
    expect(h.shopify.mutationCalls("MergeEditBegin")).toBe(0);
  });

  it("fails safely when the location count cannot be read", async () => {
    const h = setup();
    h.shopify.on("MergeLocationCount", () => topLevelError("Access denied for locationsCount"));
    const result = await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    expect(result.outcome).toBe("failed");
    expect(noWrites(h)).toBe(true);
  });

  it("does not commit if an order changes while the edit is being built", async () => {
    const h = setup();
    h.shopify.on("MergeEditDiscount", () => {
      h.shopify.order(2).displayFulfillmentStatus = "PARTIALLY_FULFILLED";
      return undefined;
    });
    const result = await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    expect(result).toMatchObject({ outcome: "skipped", disposition: "transient" });
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(0);
    expect(h.shopify.order(1).lineItems).toHaveLength(1);
    expect(h.ops.ops.size).toBe(0);
  });
});

describe("executeMerge — mutation failures before the operation exists (nothing durable changes)", () => {
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
    const h = setup();
    h.shopify.on(op, () => response);
    const result = await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    expect(result.outcome).toBe("failed");
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(0);
    expect(h.shopify.order(2).cancelCount).toBe(0);
    expect(h.ops.ops.size).toBe(0); // no operation, no locks
  });

  it("does not dispatch a commit when the operation row cannot be written", async () => {
    const h = setup();
    h.deps.ops.createOperation = async () => {
      throw new Error("db down");
    };
    await expect(executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps)).rejects.toThrow("db down");
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(0);
    expect(h.ops.ops.size).toBe(0);
    expect(h.ops.locks.size).toBe(0);
  });
});

describe("operation protocol — commit outcomes", () => {
  it("rejected commit: COMMIT_REJECTED, quiet period, then ABANDONED; secondaries untouched, locks released", async () => {
    const h = setup();
    h.shopify.commitMode.set("*", "reject");
    const { result, op } = await runMerge(h);
    expect(result.outcome).toBe("operation_created");
    expect(op?.phase).toBe("ABANDONED");
    expect(h.shopify.order(2).cancelCount).toBe(0);
    expect(h.ops.locks.size).toBe(0);
    expect(h.shopify.order(1).lineItems).toHaveLength(1);
  });

  it("commit response lost and never applied: COMMIT_IN_DOUBT ladder ends in REVIEW_REQUIRED, locks held", async () => {
    const h = setup();
    h.shopify.commitMode.set("*", "lose-never");
    const { op } = await runMerge(h);
    expect(op?.phase).toBe("REVIEW_REQUIRED");
    expect(h.shopify.mutationCalls("MergeCancelSecondary")).toBe(0);
    expect(h.ops.locks.size).toBe(2); // review keeps the orders protected
    expect(h.shopify.order(1).tags).toContain(REVIEW_TAG);
    expect(h.shopify.order(2).tags).toContain(REVIEW_TAG);
  });

  it("a top-level error on an empty-userErrors commit payload is an UNKNOWN attempt, never a success", async () => {
    const h = setup();
    h.shopify.on("MergeEditCommit", () => ({
      errors: [{ message: "Internal error" }],
      data: { orderEditCommit: { order: null, userErrors: [] } },
    }));
    const result = await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    const op = await driveOnce(h, result.operationId!);
    expect(op?.phase).toBe("COMMIT_IN_DOUBT");
    expect(h.ops.attempts).toEqual([
      expect.objectContaining({ kind: "EDIT_COMMIT", state: "UNKNOWN" }),
    ]);
    expect(h.shopify.order(2).cancelCount).toBe(0);
  });

  it("commit response lost but applied later: reconciles from evidence and completes exactly once", async () => {
    const h = setup();
    const result = await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    h.shopify.commitMode.set(h.shopify.lastCalcId(), "lose-apply-later");

    // A second merge attempt while the op is undecided hits the durable locks.
    const blocked = await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    expect(blocked).toMatchObject({ outcome: "skipped", code: "LOCKED" });

    let op = await driveOnce(h, result.operationId!);
    expect(op?.phase).toBe("COMMIT_IN_DOUBT");
    h.shopify.deliverPendingCommit(h.shopify.lastCalcId());
    op = (await h.driveUntilIdle(result.operationId!)) ?? null;
    expect(op?.phase).toBe("COMPLETED");
    expect(h.shopify.order(1).lineItems).toHaveLength(2); // applied exactly once
    expect(h.shopify.order(2).cancelledAt).not.toBeNull();
    expect(h.journal.history).toHaveLength(1);
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(1);
  });
});

describe("operation protocol — after commit (secondary work)", () => {
  it("a lost cancel response is verified by cancelledAt + staffNote and never re-issued", async () => {
    const h = setup();
    h.shopify.cancelMode.set(id(2), "lose");
    const { op } = await runMerge(h);
    expect(op?.phase).toBe("COMPLETED");
    expect(h.shopify.order(2).cancelCount).toBe(1); // one orderCancel call ever
    expect(h.shopify.order(2).cancelledAt).not.toBeNull();
    expect(h.journal.history).toHaveLength(1);
  });

  it("cancellation not yet visible: waits on the ladder, then verifies", async () => {
    const h = setup([makeOrder(1), makeOrder(2, { cancelDelayReads: 5 })]);
    const { op } = await runMerge(h);
    expect(op?.phase).toBe("COMPLETED");
    expect(h.shopify.order(2).cancelCount).toBe(1);
  });

  it("a cancel userError is ambiguous — never retried, escalates to review and flags both orders", async () => {
    const h = setup();
    h.shopify.cancelMode.set(id(2), "reject");
    const { op } = await runMerge(h);
    expect(op?.phase).toBe("REVIEW_REQUIRED");
    expect(op?.reviewReason).toMatch(/never confirmed/i);
    expect(h.shopify.order(2).cancelledAt).toBeNull();
    // A userError never proves a cancel was NOT applied, so it is recorded
    // UNKNOWN and the orderCancel is never re-issued.
    expect(h.ops.attempts.filter((a) => a.kind === "ORDER_CANCEL")).toEqual([
      expect.objectContaining({ state: "UNKNOWN" }),
    ]);
    expect(h.shopify.mutationCalls("MergeCancelSecondary")).toBe(1);
    expect(h.shopify.order(1).tags).toContain(REVIEW_TAG);
    expect(h.shopify.order(2).tags).toContain(REVIEW_TAG);
    expect(h.ops.locks.size).toBe(2); // review holds the locks
  });

  it("secondary fulfilled after its items moved: flagged for review, not cancelled", async () => {
    const h = setup();
    h.shopify.on("MergeEditCommit", (vars) => {
      h.shopify.applyCommit(vars.id);
      h.shopify.order(2).displayFulfillmentStatus = "FULFILLED";
      return { data: { orderEditCommit: { order: { id: id(1) }, userErrors: [] } } };
    });
    const { op } = await runMerge(h);
    expect(op?.phase).toBe("REVIEW_REQUIRED");
    expect(h.shopify.order(2).cancelCount).toBe(0);
    expect(h.ops.locks.size).toBe(2);
  });

  it("cosmetic side-effect failures after a confirmed cancel do not affect the outcome", async () => {
    const h = setup();
    h.shopify.on("MergeTagsAdd", () => topLevelError());
    h.shopify.on("MergeAnnotateNote", () => topLevelError());
    h.shopify.on("MergeOrderClose", () => topLevelError());
    const { op } = await runMerge(h);
    expect(op?.phase).toBe("COMPLETED");
    expect(h.shopify.order(2).cancelledAt).not.toBeNull();
    expect(h.journal.history).toHaveLength(1);
  });
});

describe("operation protocol — three orders", () => {
  it("merges two secondaries and records both", async () => {
    const h = setup([makeOrder(1), makeOrder(2), makeOrder(3)]);
    const { result, op } = await runMerge(h, [id(3), ...IDS]);
    expect(result.outcome).toBe("operation_created");
    expect(result.operation!.secondaries).toHaveLength(2);
    expect(op?.phase).toBe("COMPLETED");
    expect(h.shopify.order(1).lineItems).toHaveLength(3);
    expect(h.journal.history).toHaveLength(2);
  });

  it("one sibling's cancellation keeps failing: the verified sibling is recorded, the op parks in review", async () => {
    const h = setup([makeOrder(1), makeOrder(2), makeOrder(3)]);
    h.shopify.cancelMode.set(id(3), "reject");
    const { op } = await runMerge(h, [id(3), ...IDS]);
    expect(op?.phase).toBe("REVIEW_REQUIRED");
    expect(h.journal.history.map((x) => x.mergedOrderName)).toEqual(["#2"]);
    expect(h.shopify.order(2).cancelCount).toBe(1);
    expect(h.shopify.order(2).cancelledAt).not.toBeNull();
    expect(h.shopify.order(3).cancelledAt).toBeNull(); // rejected — never cancelled
    expect(h.shopify.order(1).lineItems).toHaveLength(3);
  });
});

describe("executeMerge — fulfillment location rule", () => {
  function multiLocation(orders = [makeOrder(1), makeOrder(2)], scope = true) {
    const h = setup(orders);
    h.shopify.activeLocations = 4;
    h.shopify.fulfillmentOrdersScope = scope;
    h.shopify.locationsScope = scope;
    return h;
  }

  it("fulfillment orders granted but read_locations missing: skipped with Shopify's reason (live regression)", async () => {
    const h = multiLocation();
    h.shopify.locationsScope = false;
    const result = await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toContain("read_locations");
    expect(noWrites(h)).toBe(true);
    expect(h.ops.ops.size).toBe(0);
  });

  it("single-location shop with only the fulfillment-orders scope: falls back and still merges", async () => {
    const h = setup();
    h.shopify.fulfillmentOrdersScope = true;
    const { op } = await runMerge(h);
    expect(op?.phase).toBe("COMPLETED");
  });

  it("multi-location shop: merges when every item of both orders is at the same location, anchoring added items there", async () => {
    const h = multiLocation([makeOrder(1, { location: LOC_B }), makeOrder(2, { location: LOC_B })]);
    const { result, op } = await runMerge(h);
    expect(result.outcome).toBe("operation_created");
    expect(op?.phase).toBe("COMPLETED");
    expect(h.shopify.addVariantLocations).toEqual([LOC_B]);
    expect(h.shopify.mutationCalls("MergeLocationCount")).toBe(0);
  });

  it("multi-location shop without the optional scope: skipped, nothing changed", async () => {
    const h = multiLocation(undefined, false);
    const result = await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    expect(result).toMatchObject({ outcome: "skipped", disposition: "terminal", code: "LOCATION_ACCESS" });
    expect(result.reason).toContain("allow location access");
    expect(noWrites(h)).toBe(true);
    expect(h.ops.ops.size).toBe(0);
  });

  it("single-location shop without the optional scope: still merges (existing behaviour)", async () => {
    const h = setup();
    const { op } = await runMerge(h);
    expect(op?.phase).toBe("COMPLETED");
    expect(h.shopify.addVariantLocations).toEqual([null]);
  });

  const skipCases: [string, () => ReturnType<typeof makeOrder>[]][] = [
    ["orders at different locations", () => [makeOrder(1, { location: LOC_A }), makeOrder(2, { location: LOC_B })]],
    [
      "one order split across two locations",
      () => {
        const items = [makeLineItem(), makeLineItem()];
        return [
          makeOrder(1),
          makeOrder(2, {
            lineItems: items,
            fulfillmentOrders: [makeFulfillmentOrder(LOC_A, [items[0]]), makeFulfillmentOrder(LOC_B, [items[1]])],
          }),
        ];
      },
    ],
    [
      "units routed to a fulfillment service (invisible to the scope)",
      () => {
        const item = makeLineItem({ quantity: 2, currentQuantity: 2, unfulfilledQuantity: 2 });
        return [
          makeOrder(1),
          makeOrder(2, { lineItems: [item], fulfillmentOrders: [makeFulfillmentOrder(LOC_A, [{ id: item.id, currentQuantity: 1 }])] }),
        ];
      },
    ],
    [
      "an order with no visible fulfillment orders",
      () => [makeOrder(1), makeOrder(2, { fulfillmentOrders: [] })],
    ],
    [
      "fulfillment order on hold",
      () => {
        const item = makeLineItem();
        return [
          makeOrder(1),
          makeOrder(2, {
            lineItems: [item],
            fulfillmentOrders: [makeFulfillmentOrder(LOC_A, [item], { status: "ON_HOLD", fulfillmentHolds: [{ reason: "OTHER" }] })],
          }),
        ];
      },
    ],
    [
      "fulfillment order with a hold but still OPEN",
      () => {
        const item = makeLineItem();
        return [
          makeOrder(1),
          makeOrder(2, { lineItems: [item], fulfillmentOrders: [makeFulfillmentOrder(LOC_A, [item], { fulfillmentHolds: [{ reason: "OTHER" }] })] }),
        ];
      },
    ],
    [
      "fulfillment request already submitted",
      () => {
        const item = makeLineItem();
        return [
          makeOrder(1),
          makeOrder(2, { lineItems: [item], fulfillmentOrders: [makeFulfillmentOrder(LOC_A, [item], { requestStatus: "SUBMITTED" })] }),
        ];
      },
    ],
    [
      "scheduled (pre-order) fulfillment",
      () => {
        const item = makeLineItem();
        return [
          makeOrder(1),
          makeOrder(2, { lineItems: [item], fulfillmentOrders: [makeFulfillmentOrder(LOC_A, [item], { status: "SCHEDULED" })] }),
        ];
      },
    ],
    [
      "fulfillment order without an assigned location",
      () => {
        const item = makeLineItem();
        return [makeOrder(1), makeOrder(2, { lineItems: [item], fulfillmentOrders: [makeFulfillmentOrder(null, [item])] })];
      },
    ],
  ];

  it.each(skipCases)("skips: %s", async (_label, build) => {
    const h = multiLocation(build());
    const result = await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    expect(result.outcome).toBe("skipped");
    expect(h.shopify.mutationCalls("MergeEditBegin")).toBe(0);
    expect(noWrites(h)).toBe(true);
    expect(h.ops.ops.size).toBe(0);
  });

  it("ignores closed/cancelled fulfillment orders when the open ones match", async () => {
    const item = makeLineItem();
    const h = multiLocation([
      makeOrder(1),
      makeOrder(2, {
        lineItems: [item],
        fulfillmentOrders: [makeFulfillmentOrder(LOC_B, [], { status: "CLOSED" }), makeFulfillmentOrder(LOC_A, [item])],
      }),
    ]);
    const { op } = await runMerge(h);
    expect(op?.phase).toBe("COMPLETED");
  });

  it("the stricter rule also applies to single-location shops once the scope is granted", async () => {
    const item = makeLineItem();
    const h = setup([
      makeOrder(1),
      makeOrder(2, { lineItems: [item], fulfillmentOrders: [makeFulfillmentOrder(LOC_A, [item], { status: "SCHEDULED" })] }),
    ]);
    h.shopify.fulfillmentOrdersScope = true;
    h.shopify.locationsScope = true;
    expect((await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps)).outcome).toBe("skipped");
  });

  it("does not commit if the location changes while the edit is being built", async () => {
    const h = multiLocation();
    h.shopify.on("MergeEditDiscount", () => {
      h.shopify.order(2).location = LOC_B;
      return undefined;
    });
    const result = await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    expect(result.outcome).toBe("skipped");
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(0);
    expect(h.ops.ops.size).toBe(0);
  });

  it("fails safely (no writes) when fulfillment orders can't be loaded for another reason", async () => {
    const h = multiLocation();
    h.shopify.on("MergeFulfillmentOrders", () => topLevelError("Throttled"));
    const result = await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    expect(result.outcome).toBe("failed");
    expect(h.shopify.mutationCalls("MergeEditBegin")).toBe(0);
    expect(noWrites(h)).toBe(true);
  });
});

describe("executeMerge — live regressions (ordermergetest2, Custom shipping)", () => {
  // Shapes taken from the live orders: Custom lines are title "Custom", code
  // "custom", custom=true; "The 3p Fulfilled Snowboard" is routed to a
  // fulfillment service, so no fulfillment order is visible for it.
  const threePl = (n: number, amount: string) =>
    makeOrder(n, { shippingLines: { nodes: [customRate(amount)] }, fulfillmentOrders: [] });
  const shopLocation = (n: number, amount: string, source: string | null = "shopify") =>
    makeOrder(n, { shippingLines: { nodes: [customRate(amount, { source })] }, location: LOC_A });
  const multi = (orders: ReturnType<typeof makeOrder>[]) => {
    const h = setup(orders);
    h.shopify.activeLocations = 3;
    h.shopify.fulfillmentOrdersScope = true;
    h.shopify.locationsScope = true;
    return h;
  };

  it("Karine #1021–#1023: the matching $20 Custom pair combines; the 3PL $10 order is left untouched", async () => {
    const h = multi([threePl(1021, "10.0"), shopLocation(1022, "20.0"), shopLocation(1023, "20.0")]);
    const { result, op } = await runMerge(h, [id(1023), id(1022), id(1021)]);
    expect(result).toMatchObject({ outcome: "operation_created", primaryName: "#1022" });
    expect(result.operation!.secondaries).toHaveLength(1);
    expect(op?.phase).toBe("COMPLETED");
    expect(h.shopify.order(1023).cancelledAt).not.toBeNull();
    expect(h.shopify.order(1021).cancelCount).toBe(0);
    expect(h.shopify.order(1021).lineItems).toHaveLength(1);
  });

  it("Russell, anchor #1020 (3PL): nothing is touched", async () => {
    const orders = [shopLocation(1017, "15.0", null), threePl(1018, "5.0"), shopLocation(1019, "5.0"), threePl(1020, "5.0")];
    const h = multi(orders);
    const result = await executeMerge(h.shopify.admin, h.SHOP, [id(1020), id(1019), id(1018), id(1017)], h.deps);
    expect(result.outcome).toBe("skipped");
    expect(h.shopify.mutationCalls("MergeEditBegin")).toBe(0);
    expect(h.ops.ops.size).toBe(0);
  });

  it("Russell, anchor #1019 ($5 Custom): $15 Custom and 3PL orders don't qualify, so nothing is touched", async () => {
    const orders = [shopLocation(1017, "15.0", null), threePl(1018, "5.0"), shopLocation(1019, "5.0")];
    const h = multi(orders);
    const result = await executeMerge(h.shopify.admin, h.SHOP, [id(1019), id(1018), id(1017)], h.deps);
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toMatch(/No other order/);
    expect(h.shopify.mutationCalls("MergeEditBegin")).toBe(0);
  });

  it("a second $5 Custom order at the shop location does combine with #1019", async () => {
    const orders = [shopLocation(1017, "15.0", null), shopLocation(1019, "5.0"), shopLocation(1025, "5.0")];
    const h = multi(orders);
    const { result, op } = await runMerge(h, [id(1025), id(1019), id(1017)]);
    expect(result).toMatchObject({ outcome: "operation_created", primaryName: "#1019" });
    expect(result.operation!.secondaries).toHaveLength(1);
    expect(op?.phase).toBe("COMPLETED");
    expect(h.shopify.order(1017).cancelCount).toBe(0);
  });

  it("an excluded order is re-verified away: the pre-op recheck only covers the combined orders", async () => {
    const h = multi([threePl(1021, "10.0"), shopLocation(1022, "20.0"), shopLocation(1023, "20.0")]);
    // #1021 changing mid-merge must not affect the #1022/#1023 combine.
    h.shopify.on("MergeEditDiscount", () => {
      h.shopify.order(1021).displayFulfillmentStatus = "FULFILLED";
      return undefined;
    });
    const { op } = await runMerge(h, [id(1023), id(1022), id(1021)]);
    expect(op?.phase).toBe("COMPLETED");
  });
});

describe("executeMerge — per-order exclusion is general (standard shipping)", () => {
  const multi = (orders: ReturnType<typeof makeOrder>[]) => {
    const h = setup(orders);
    h.shopify.activeLocations = 3;
    h.shopify.fulfillmentOrdersScope = true;
    h.shopify.locationsScope = true;
    return h;
  };

  it("a standard-shipping order at a fulfillment service doesn't block a compatible standard pair", async () => {
    const h = multi([makeOrder(1, { fulfillmentOrders: [] }), makeOrder(2), makeOrder(3)]);
    const { result, op } = await runMerge(h, [id(3), id(2), id(1)]);
    expect(result).toMatchObject({ outcome: "operation_created", primaryName: "#2" });
    expect(result.operation!.secondaries).toHaveLength(1);
    expect(op?.phase).toBe("COMPLETED");
    expect(h.shopify.order(1).cancelCount).toBe(0);
    expect(h.shopify.order(1).lineItems).toHaveLength(1);
  });

  it("a standard-shipping order at a different location doesn't block a compatible standard pair", async () => {
    const h = multi([makeOrder(1, { location: LOC_B }), makeOrder(2), makeOrder(3)]);
    const { result, op } = await runMerge(h, [id(3), id(2), id(1)]);
    expect(result).toMatchObject({ outcome: "operation_created", primaryName: "#2" });
    expect(op?.phase).toBe("COMPLETED");
    expect(h.shopify.order(1).cancelCount).toBe(0);
  });
});
