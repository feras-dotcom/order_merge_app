// Durable order work items: the webhook only records the row; processing
// (processOrderWork) and recovery (runSweepOnce) are exercised end to end
// against the in-memory stores and FakeShopify. Spec §9 tests #1-9, #14-19.

import { describe, expect, it, vi } from "vitest";
import { SessionNotFoundError } from "@shopify/shopify-app-remix/server";
import { OwnershipLostError } from "../app/lib/ownership.server";
import {
  INDEX_LAG_GRACE_MS,
  MAX_ATTEMPTS,
  retryDelayMs,
} from "../app/lib/order-work.server";
import {
  makeHarness,
  makeOrder,
  MemoryWorkStore,
  topLevelError,
  userError,
} from "./fake-shopify";

const id = (n: number) => `gid://shopify/Order/${n}`;

/** Pauses an intercepted call until released; `at` resolves once reached. */
function gate() {
  let reached!: () => void;
  let release!: () => void;
  return {
    at: new Promise<void>((r) => (reached = r)),
    release: new Promise<void>((r) => (release = r)),
    reached,
    open: release,
  };
}

describe("order work items (spec §9)", () => {
  it("#1 duplicate webhook delivery: the second insert returns null and nothing is processed twice", async () => {
    const h = makeHarness([makeOrder(1), makeOrder(2)]);
    expect(await h.webhook(id(2))).not.toBeNull();
    expect(await h.webhook(id(2))).toBeNull();
    expect(h.stats.processCalls).toBe(1);
    expect([...h.work.items.values()]).toHaveLength(1);
    // v2: creating the operation settles the work item; the op carries it on.
    expect(await h.work.find(h.SHOP, id(2))).toMatchObject({ status: "DONE", outcome: "MERGED" });
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(1);
  });

  it("#2 a delivery that dies before creating the row is recreated and processed on redelivery", async () => {
    const h = makeHarness([makeOrder(1), makeOrder(2)]);
    expect(await h.work.find(h.SHOP, id(2))).toBeNull(); // crashed before the insert
    const item = await h.webhook(id(2));
    expect(item).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(await h.work.find(h.SHOP, id(2))).toMatchObject({ status: "DONE", outcome: "MERGED" });
    expect(h.shopify.order(1).lineItems).toHaveLength(2);
  });

  it("#3 death after work creation: the sweeper re-leases the expired item and completes it", async () => {
    const h = makeHarness([makeOrder(1), makeOrder(2)]);
    const item = await h.webhook(id(2), false); // row created, worker died before processing
    expect(item).toMatchObject({ status: "PENDING", attempts: 1 });
    h.advance(121_000); // the webhook lease expires (TTL is 120s)
    await h.sweep();
    expect(await h.work.find(h.SHOP, id(2))).toMatchObject({
      status: "DONE",
      outcome: "MERGED",
      attempts: 2,
    });
    expect(h.shopify.order(1).lineItems).toHaveLength(2);
    expect(h.shopify.order(2).cancelledAt).not.toBeNull();
  });

  it("#4 transient GraphQL failure during candidate load: retried by the sweep, then merges", async () => {
    const h = makeHarness([makeOrder(1), makeOrder(2)]);
    h.shopify.on("MergeCandidateOrders", (_v, call) =>
      call === 1 ? topLevelError("Service unavailable") : undefined,
    );
    await h.webhook(id(2));
    const pending = await h.work.find(h.SHOP, id(2));
    expect(pending).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(pending!.retryAfter!.getTime()).toBeGreaterThan(h.clock().getTime());
    expect(pending!.lastReason).toMatch(/Load customer orders/);
    expect(h.shopify.mutationCalls("MergeEditBegin")).toBe(0);

    h.advance(60_000);
    await h.sweep();
    expect(await h.work.find(h.SHOP, id(2))).toMatchObject({ status: "DONE", outcome: "MERGED" });
    expect(h.shopify.order(1).lineItems).toHaveLength(2);
  });

  it("#5 throttled orderEditAddVariant: transient retry merges without duplicating line items", async () => {
    const h = makeHarness([makeOrder(1), makeOrder(2)]);
    h.shopify.on("MergeEditAddVariant", (_v, call) => (call === 1 ? topLevelError() : undefined));
    await h.webhook(id(2));
    expect(await h.work.find(h.SHOP, id(2))).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(h.ops.ops.size).toBe(0); // failed before the operation row existed

    h.advance(60_000);
    await h.sweep();
    expect(await h.work.find(h.SHOP, id(2))).toMatchObject({ status: "DONE", outcome: "MERGED" });
    expect(h.shopify.order(1).lineItems).toHaveLength(2);
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(1);
  });

  it("#6 index lag: an unseen sibling is retried at createdAt+2min, then the sweep merges", async () => {
    const h = makeHarness([makeOrder(1), makeOrder(2)]);
    h.shopify.hiddenFromSearch.add(id(1));
    await h.webhook(id(2));
    const pending = await h.work.find(h.SHOP, id(2));
    expect(pending).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(pending!.retryAfter!.getTime()).toBe(pending!.createdAt.getTime() + INDEX_LAG_GRACE_MS);
    expect(pending!.lastReason).toContain("search index");

    h.shopify.hiddenFromSearch.delete(id(1));
    h.advance(INDEX_LAG_GRACE_MS + 1_000);
    await h.sweep();
    expect(await h.work.find(h.SHOP, id(2))).toMatchObject({ status: "DONE", outcome: "MERGED" });
    expect(h.shopify.order(1).lineItems).toHaveLength(2);
  });

  it("#6b zero siblings past the index-lag grace: DONE NO_SIBLINGS", async () => {
    const h = makeHarness([makeOrder(5)]);
    await h.webhook(id(5));
    expect(await h.work.find(h.SHOP, id(5))).toMatchObject({ status: "PENDING" }); // grace first
    h.advance(INDEX_LAG_GRACE_MS + 1_000);
    await h.sweep();
    const item = await h.work.find(h.SHOP, id(5));
    expect(item).toMatchObject({ status: "DONE", outcome: "NO_SIBLINGS" });
    expect(item!.lastReason).toContain("24h");
  });

  it("#7 A <- B <- C during an active merge: C retries contention, then the chain completes", async () => {
    const h = makeHarness([makeOrder(1)]);
    await h.webhook(id(1)); // alone so far: index-lag retry at +2min

    // B arrives and starts merging into A; C lands while the edit is open.
    h.shopify.orders.set(id(2), makeOrder(2));
    const g = gate();
    h.shopify.on("MergeEditAddVariant", async (_v, call) => {
      if (call === 1) {
        h.shopify.orders.set(id(3), makeOrder(3));
        g.reached();
        await g.release;
      }
      return undefined;
    });
    const bMerge = h.webhook(id(2));
    await g.at; // B's worker holds the claims on A and B mid-edit

    await h.webhook(id(3));
    const cItem = await h.work.find(h.SHOP, id(3));
    expect(cItem).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(cItem!.lastReason).toMatch(/holding one of the orders|unfinished merge/);
    expect(cItem!.retryAfter!.getTime()).toBeGreaterThan(h.clock().getTime());

    g.open();
    await bMerge;
    expect(await h.work.find(h.SHOP, id(2))).toMatchObject({ status: "DONE", outcome: "MERGED" });
    expect(h.shopify.order(2).cancelledAt).not.toBeNull();

    h.advance(30_000); // past C's contention retry (~15s)
    await h.sweep();
    expect(await h.work.find(h.SHOP, id(3))).toMatchObject({ status: "DONE", outcome: "MERGED" });
    expect(h.shopify.order(3).cancelledAt).not.toBeNull();

    h.advance(INDEX_LAG_GRACE_MS); // A's own work item is due again
    await h.sweep();
    expect(await h.work.find(h.SHOP, id(1))).toMatchObject({ status: "DONE", outcome: "NO_SIBLINGS" });

    expect(h.shopify.order(1).lineItems).toHaveLength(3);
    expect(new Set(h.shopify.order(1).lineItems.map((i) => i.id)).size).toBe(3);
    expect(h.shopify.order(2).cancelCount).toBe(1);
    expect(h.shopify.order(3).cancelCount).toBe(1);
    expect([...h.ops.ops.values()].map((o) => o.phase)).toEqual(["COMPLETED", "COMPLETED"]);
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(2);
  });

  it("#8 sibling under a durable operation lock: contention retry; the abandoned op frees it", async () => {
    const h = makeHarness([makeOrder(1), makeOrder(2)]);
    // A stuck v2 operation holds order 1's durable lock.
    await h.claims.acquire(h.SHOP, [id(1)], "holder", h.deps.leaseTtlMs);
    const holder = await h.ops.createOperation({
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

    await h.webhook(id(2));
    const pending = await h.work.find(h.SHOP, id(2));
    expect(pending).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(pending!.lastReason).toContain("unfinished merge");
    expect(h.shopify.mutationCalls("MergeEditBegin")).toBe(0);

    // The stuck op is abandoned: its lock and claim release order 1.
    await h.ops.transition(
      { id: holder.id, leaseToken: "holder-op", workItemId: null },
      { phase: "ABANDONED", lastError: "gave up" },
    );
    await h.claims.release(h.SHOP, [id(1)], "holder");
    h.advance(120_000);
    await h.sweep();
    expect([...h.ops.ops.values()].map((o) => o.phase)).toEqual(["ABANDONED", "COMPLETED"]);
    expect(await h.work.find(h.SHOP, id(2))).toMatchObject({ status: "DONE", outcome: "MERGED" });
    expect(h.shopify.order(1).lineItems).toHaveLength(2);
    expect(h.shopify.order(2).cancelledAt).not.toBeNull();
  });

  it("#8b sibling locked by a REVIEW_REQUIRED op is dropped — DONE NO_PARTNER after the lag grace", async () => {
    const h = makeHarness([makeOrder(1), makeOrder(2)]);
    // Order 1 is parked: a v2 op in REVIEW_REQUIRED retains its durable lock.
    await h.claims.acquire(h.SHOP, [id(1)], "holder", h.deps.leaseTtlMs);
    const holder = await h.ops.createOperation({
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
    await h.ops.transition(
      { id: holder.id, leaseToken: "holder-op", workItemId: null },
      { expectedPhase: "READY", phase: "REVIEW_REQUIRED", reviewReason: "test parked" },
    );
    await h.claims.release(h.SHOP, [id(1)], "holder");
    expect(h.ops.locks.size).toBe(1); // review keeps its lock

    // Anchor 2's only compatible sibling is parked: the item waits out the
    // index-lag grace once, then terminates instead of churning on the lock.
    await h.webhook(id(2));
    let wi = await h.work.find(h.SHOP, id(2));
    expect(wi?.status).toBe("PENDING"); // inside the 2-minute index-lag grace
    h.advance(130_000);
    await h.sweep();
    wi = await h.work.find(h.SHOP, id(2));
    expect(wi).toMatchObject({ status: "DONE", outcome: "NO_PARTNER" });
    expect(h.shopify.mutationCalls("MergeEditBegin")).toBe(0); // never touched
    expect([...h.ops.ops.values()]).toHaveLength(1); // no merge op for order 2
  });

  it("#8c compatible sibling in an ACTIVE v2 op + incompatible free sibling: contention retry, not NO_PARTNER", async () => {
    const h = makeHarness([makeOrder(1), makeOrder(2, { riskLevel: "HIGH" }), makeOrder(3)]);
    // Order 1 is held by a v2 op in READY — its legacy status shield reads
    // NEEDS_REVIEW, but that shield must not count as a v1 review parking
    // (the journal queries filter protocolVersion=1). If the filter is ever
    // dropped this test degrades to DONE NO_PARTNER after the lag grace.
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
      ttlMs: 600_000, // outlives the time advance — the sweep never takes it
    });
    expect([...h.ops.ops.values()][0].status).toBe("NEEDS_REVIEW"); // the shield

    // Anchor 3: #1 is busy (active op), #2 is free but HIGH-risk — the item
    // retries on contention and stays PENDING past the index-lag grace.
    await h.webhook(id(3));
    let wi = await h.work.find(h.SHOP, id(3));
    expect(wi?.status).toBe("PENDING");
    expect(wi?.lastReason).toContain("unfinished merge");

    h.advance(130_000);
    await h.sweep();
    wi = await h.work.find(h.SHOP, id(3));
    expect(wi?.status).toBe("PENDING"); // contention — never NO_PARTNER
    expect(wi?.lastReason).toContain("unfinished merge");
  });

  it("#8d kill switch: MERGES_DISABLED parks the item on a 5-minute transient retry", async () => {
    const h = makeHarness([makeOrder(1), makeOrder(2)]);
    await h.ops.setControl({ newMergesEnabled: false });
    await h.webhook(id(2));
    const wi = await h.work.find(h.SHOP, id(2));
    expect(wi).toMatchObject({ status: "PENDING", outcome: null });
    expect(wi!.lastReason).toBe("New merges are disabled.");
    expect(wi!.retryAfter!.getTime() - h.clock().getTime()).toBe(5 * 60_000);
    expect(h.shopify.mutationCalls("MergeEditBegin")).toBe(0);
  });

  it("#9 death after orderEditCommit: the sweep reconciles the in-doubt op from evidence, cancels the secondary", async () => {
    const h = makeHarness([makeOrder(1), makeOrder(2)]);
    const g = gate();
    h.shopify.on("MergeEditCommit", async (vars, call) => {
      if (call === 1) {
        h.shopify.applyCommit(vars.id); // the commit was applied
        g.reached();
        await new Promise(() => {}); // ...and then the worker dies forever
      }
      return undefined;
    });
    void h.webhook(id(2));
    await g.at; // committed, worker hung — the attempt row is stuck DISPATCHING

    h.advance(121_000); // op lease expires (TTL is 120s)
    await h.sweep();

    const op = [...h.ops.ops.values()][0];
    expect(op.phase).toBe("COMPLETED");
    expect(h.journal.history).toHaveLength(1);
    expect(h.shopify.order(1).lineItems).toHaveLength(2); // items moved exactly once
    expect(h.shopify.order(2).cancelledAt).not.toBeNull();
    // The work item was settled atomically when the operation was created.
    expect(await h.work.find(h.SHOP, id(2))).toMatchObject({ status: "DONE", outcome: "MERGED" });
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(1);
  });

  it("#14 retry exhaustion: repeated transient failures end REVIEW EXHAUSTED", async () => {
    const h = makeHarness([makeOrder(1), makeOrder(2)]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    h.shopify.on("MergeCandidateOrders", () => topLevelError("still down"));
    try {
      await h.webhook(id(2));
      let item = await h.work.find(h.SHOP, id(2));
      let sweeps = 0;
      while (item?.status === "PENDING" && sweeps < MAX_ATTEMPTS + 5) {
        h.advance(1_900_000); // past the longest transient delay (30min)
        await h.sweep();
        sweeps += 1;
        item = await h.work.find(h.SHOP, id(2));
      }
      // v2: exhaustDue converts the item to REVIEW — a human decides; the
      // stale-owner guards then refuse any further writes on it.
      expect(item).toMatchObject({ status: "REVIEW", outcome: "EXHAUSTED" });
      expect(item!.attempts).toBeGreaterThan(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Exhausted"));
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  it("#15 terminal ineligibility: HIGH-risk anchor is DONE INELIGIBLE with no retry and no writes", async () => {
    const h = makeHarness([makeOrder(1), makeOrder(2, { riskLevel: "HIGH" })]);
    await h.webhook(id(2));
    const item = await h.work.find(h.SHOP, id(2));
    expect(item).toMatchObject({ status: "DONE", outcome: "INELIGIBLE" });
    expect(item!.retryAfter).toBeNull();
    expect(item!.lastReason).toMatch(/fraud risk/);
    expect(h.shopify.calls).toEqual(["MergeOrderState"]); // the anchor load only
    expect(h.ops.ops.size).toBe(0);
  });

  it("#16 successful merge: DONE MERGED, op COMPLETED, history recorded", async () => {
    const h = makeHarness([makeOrder(1), makeOrder(2)]);
    await h.webhook(id(2));
    expect(await h.work.find(h.SHOP, id(2))).toMatchObject({ status: "DONE", outcome: "MERGED" });
    expect([...h.ops.ops.values()].map((o) => o.phase)).toEqual(["COMPLETED"]);
    expect(h.journal.history).toHaveLength(1);
    expect(h.shopify.order(1).lineItems).toHaveLength(2);
    expect(h.shopify.order(2).cancelledAt).not.toBeNull();
  });

  it("#17 rejected commit: the op parks in COMMIT_REJECTED then abandons; the requeued work item merges cleanly", async () => {
    const h = makeHarness([makeOrder(1), makeOrder(2)]);
    let rejects = true;
    h.shopify.on("MergeEditCommit", () =>
      rejects ? userError("orderEditCommit") : undefined,
    );
    await h.webhook(id(2)); // op created + driven inline → COMMIT_REJECTED, work row settled
    const rejected = [...h.ops.ops.values()][0];
    expect(rejected.phase).toBe("COMMIT_REJECTED");
    expect(await h.work.find(h.SHOP, id(2))).toMatchObject({ status: "DONE", outcome: "OPERATION_CREATED" });
    expect(h.shopify.order(1).lineItems).toHaveLength(1); // rejected = not applied

    h.advance(16 * 60_000); // past the 15-minute quiet period
    rejects = false;
    // The sweep abandons the op, requeues the work item and (same tick)
    // processes it into a fresh operation that merges cleanly.
    await h.sweep();
    expect(h.ops.ops.get(rejected.id)!.phase).toBe("ABANDONED");
    expect(h.ops.locks.size).toBe(0);
    expect(await h.work.find(h.SHOP, id(2))).toMatchObject({ status: "DONE", outcome: "MERGED" });
    expect([...h.ops.ops.values()].map((o) => o.phase)).toEqual(["ABANDONED", "COMPLETED"]);
    expect(h.shopify.order(1).lineItems).toHaveLength(2);
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(2);
  });

  it("#18 uninstalled shop: no offline session ends DONE SHOP_UNINSTALLED", async () => {
    const h = makeHarness([makeOrder(1), makeOrder(2)]);
    await h.webhook(id(2), false); // row exists; the delivering worker is gone
    h.advance(121_000);
    await h.sweep({
      adminFactory: async () => {
        throw new SessionNotFoundError(`Could not find a session for shop ${h.SHOP}`);
      },
    });
    expect(await h.work.find(h.SHOP, id(2))).toMatchObject({
      status: "DONE",
      outcome: "SHOP_UNINSTALLED",
    });
    expect(h.shopify.calls).toHaveLength(0); // no Shopify traffic without a session
  });

  it("#19 multi-location shop without location access: DONE LOCATION_ACCESS", async () => {
    const h = makeHarness([makeOrder(1), makeOrder(2)]);
    h.shopify.activeLocations = 3; // fulfillmentOrdersScope stays false -> access denied
    await h.webhook(id(2));
    const item = await h.work.find(h.SHOP, id(2));
    expect(item).toMatchObject({ status: "DONE", outcome: "LOCATION_ACCESS" });
    expect(item!.lastReason).toContain("allow location access");
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(0);
  });
});

describe("retryDelayMs", () => {
  const steady = () => 0.5; // jitter factor exactly 1.0

  it("follows the spec backoff tables and clamps at the last entry", () => {
    expect(retryDelayMs("contention", 1, steady)).toBe(15_000);
    expect(retryDelayMs("contention", 2, steady)).toBe(30_000);
    expect(retryDelayMs("contention", 3, steady)).toBe(60_000);
    expect(retryDelayMs("contention", 4, steady)).toBe(120_000);
    expect(retryDelayMs("contention", 5, steady)).toBe(300_000);
    expect(retryDelayMs("contention", 20, steady)).toBe(300_000);

    expect(retryDelayMs("transient", 1, steady)).toBe(30_000);
    expect(retryDelayMs("transient", 2, steady)).toBe(60_000);
    expect(retryDelayMs("transient", 3, steady)).toBe(120_000);
    expect(retryDelayMs("transient", 4, steady)).toBe(300_000);
    expect(retryDelayMs("transient", 5, steady)).toBe(600_000);
    expect(retryDelayMs("transient", 6, steady)).toBe(1_200_000);
    expect(retryDelayMs("transient", 7, steady)).toBe(1_800_000);
    expect(retryDelayMs("transient", 20, steady)).toBe(1_800_000);
  });

  it("jitters ±25%", () => {
    expect(retryDelayMs("contention", 1, () => 0)).toBe(11_250);
    expect(retryDelayMs("contention", 1, () => 1)).toBe(18_750);
  });
});

describe("runSweepOnce", () => {
  it("runs reap -> op-drive -> exhaust -> claimDue -> purge and isolates a failing step", async () => {
    const h = makeHarness([makeOrder(1), makeOrder(2)]);
    const order: string[] = [];
    const mark = (name: string) => {
      if (!order.includes(name)) order.push(name);
    };
    const reaping = h.claims.reapExpired.bind(h.claims);
    h.claims.reapExpired = async () => {
      mark("reap");
      return reaping();
    };
    const acquiring = h.ops.acquireOperationLease.bind(h.ops);
    h.ops.acquireOperationLease = async (opId, token, ttl) => {
      if (!order.includes("ops-scan")) {
        mark("ops-scan");
        throw new Error("db down"); // must not stop the rest of the tick
      }
      return acquiring(opId, token, ttl);
    };
    const exhausting = h.work.exhaustDue.bind(h.work);
    h.work.exhaustDue = async () => {
      mark("exhaust");
      return exhausting();
    };
    const claiming = h.work.claimDue.bind(h.work);
    h.work.claimDue = async (l, t) => {
      mark("claimDue");
      return claiming(l, t);
    };
    const purging = h.work.purgeDone.bind(h.work);
    h.work.purgeDone = async (ms) => {
      mark("purge");
      return purging(ms);
    };

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await h.sweep();
      expect(order).toEqual(["reap", "ops-scan", "exhaust", "claimDue", "purge"]);
      expect(err).toHaveBeenCalledWith(expect.stringContaining("db down"));
    } finally {
      err.mockRestore();
    }
  });

  it("defers an op +1h while the shop has no session, then flags REVIEW after 7 days", async () => {
    const h = makeHarness([makeOrder(1), makeOrder(2)]);
    // Park the op mid-flight: the commit response never arrives.
    h.shopify.commitMode.set("*", "lose-never");
    await h.webhook("gid://shopify/Order/2");
    const opId = [...h.ops.ops.keys()][0];
    expect(h.ops.ops.get(opId)?.phase).toBe("COMMIT_IN_DOUBT");

    const noSession = async () => null;
    h.advance(h.deps.leaseTtlMs + 1_000); // past the first ladder slot AND the op lease
    await h.sweep({ adminFactory: noSession });
    let op = (await h.ops.getOperation(opId))!;
    expect(op.phase).toBe("COMMIT_IN_DOUBT");
    expect(op.lastError).toContain("no offline session");
    expect(op.nextCheckAt!.getTime() - h.clock().getTime()).toBe(60 * 60_000);

    // Repeatedly deferred for 7 days: escalate to REVIEW_REQUIRED (locks stay).
    h.advance(7 * 24 * 60 * 60_000 + 1_000);
    await h.sweep({ adminFactory: noSession });
    op = (await h.ops.getOperation(opId))!;
    expect(op.phase).toBe("REVIEW_REQUIRED");
    expect(h.ops.locks.size).toBe(2);
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(1);
  });
});

describe("MemoryWorkStore stale-token guards", () => {
  it("conditional writes with a wrong or expired token never modify the row", async () => {
    let t = 0;
    const work = new MemoryWorkStore();
    work.clock = () => new Date(t);
    const item = (await work.insertLeased("s", "o1", "token-a", 60_000, 600_000))!;

    await expect(work.renew(item.id, "token-b", 60_000)).rejects.toBeInstanceOf(OwnershipLostError);
    expect(await work.markDone(item.id, "token-b", "MERGED", "x")).toBe(false);
    expect(await work.scheduleRetry(item.id, "token-b", 1_000, "x")).toBe(false);
    expect(item.status).toBe("PENDING");

    // An expired lease is taken over; the stale token stays dead.
    t = 61_000;
    const [claimed] = await work.claimDue(5, 60_000);
    expect(claimed.id).toBe(item.id);
    expect(claimed.leaseToken).not.toBe("token-a");
    expect(claimed.attempts).toBe(2);
    await expect(work.renew(item.id, "token-a", 60_000)).rejects.toBeInstanceOf(OwnershipLostError);
    expect(await work.markDone(item.id, "token-a", "MERGED", "x")).toBe(false);
    expect(await work.scheduleRetry(item.id, "token-a", 1_000, "x")).toBe(false);

    // The new owner finishes it; a DONE row accepts no further writes.
    expect(await work.markDone(claimed.id, claimed.leaseToken!, "MERGED", "x")).toBe(true);
    expect(await work.scheduleRetry(claimed.id, claimed.leaseToken!, 1_000, "x")).toBe(false);
    await expect(work.renew(claimed.id, claimed.leaseToken!, 60_000)).rejects.toBeInstanceOf(
      OwnershipLostError,
    );
  });

  it("purgeDone removes overlap-era DONE rows (doneAt null) by their createdAt", async () => {
    let t = 0;
    const work = new MemoryWorkStore();
    work.clock = () => new Date(t);
    const old = (await work.insertLeased("s", "o1", "tok", 60_000, 600_000))!;
    await work.markDone(old.id, "tok", "MERGED", "x");
    work.items.get(old.id)!.doneAt = null; // overlap-era row: doneAt was never set
    t = 40 * 24 * 60 * 60 * 1000;
    const recent = (await work.insertLeased("s", "o2", "tok", 60_000, 600_000))!;
    await work.markDone(recent.id, "tok", "MERGED", "x");
    expect(await work.purgeDone(30 * 24 * 60 * 60 * 1000)).toBe(1);
    expect(await work.find("s", "o1")).toBeNull();
    expect(await work.find("s", "o2")).toMatchObject({ status: "DONE" });
  });
});
