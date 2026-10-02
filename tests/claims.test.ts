// Lease/claim behaviour of the merge engine (spec §5/§9): two simulated
// workers share one FakeShopify, one MemoryClaimStore, one MemoryJournal and
// one fake clock; async interceptors pause a worker mid-call so the other
// can run "concurrently".

import { describe, expect, it } from "vitest";
import { executeMerge } from "../app/lib/merge.server";
import type { NewMergeOperation } from "../app/lib/merge-journal.server";
import { OwnershipLostError } from "../app/lib/ownership.server";
import {
  makeHarness,
  makeOrder,
  MemoryClaimStore,
  MemoryJournal,
} from "./fake-shopify";

const SHOP = "test.myshopify.com";
const IDS = ["gid://shopify/Order/2", "gid://shopify/Order/1"];
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

function setup(orders = [makeOrder(1), makeOrder(2)]) {
  return makeHarness(orders);
}

/** v2: planning returns the operation; driving it performs the merge. */
async function finish(h: ReturnType<typeof setup>, operationId: string) {
  return h.driveUntilIdle(operationId);
}

const newOp = (overrides: Partial<NewMergeOperation> = {}): NewMergeOperation => ({
  shop: SHOP,
  status: "PENDING_COMMIT",
  primaryOrderId: id(1),
  primaryOrderName: "#1",
  customerId: null,
  primaryLineItemCountBefore: 1,
  addedLineItemCount: 1,
  secondaries: [{ id: id(2), name: "#2", items: 1, done: false }],
  involvedOrderIds: [id(1), id(2)],
  ...overrides,
});

describe("claims — contention between workers", () => {
  it("blocked v1 journal row: skipped/contention/LOCKED, claims released on the way out", async () => {
    const h = setup();
    await h.journal.create(newOp({ status: "NEEDS_REVIEW" }), "tok", 60_000);
    const result = await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    expect(result).toMatchObject({ outcome: "skipped", disposition: "contention", code: "LOCKED" });
    expect(h.shopify.mutationCalls("MergeEditBegin")).toBe(0);
    expect(h.claims.claims.size).toBe(0);
  });

  // Spec §9 #10.
  it("lease expiry after worker death mid-edit: second worker merges once; the first worker's late fence throws", async () => {
    const h = setup();
    const g = gate();
    h.shopify.on("MergeEditAddVariant", async (_v, call) => {
      if (call === 1) {
        g.reached();
        await g.release;
      }
      return undefined;
    });

    const first = executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    await g.at; // worker 1 holds the claims and sits inside the edit
    h.advance(121_000); // its claims expire (lease TTL is 120s)

    const second = await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    expect(second.outcome).toBe("operation_created");
    expect((await finish(h, second.operationId!))?.phase).toBe("COMPLETED");

    g.open();
    await expect(first).resolves.toMatchObject({
      outcome: "failed",
      disposition: "contention",
      code: "OWNERSHIP_LOST",
    });
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(1);
    expect(h.shopify.order(1).lineItems).toHaveLength(2); // items moved exactly once
    expect(h.shopify.order(2).cancelCount).toBe(1);
    expect(h.ops.ops.get(second.operationId!)?.phase).toBe("COMPLETED");
  });

  // Spec §9 #11.
  it("two workers on the same group: exactly one acquires; the other gets CLAIM_CONFLICT and its retry is a no-op", async () => {
    const h = setup();
    const g = gate();
    h.shopify.on("MergeEditBegin", async (_v, call) => {
      if (call === 1) {
        g.reached();
        await g.release;
      }
      return undefined;
    });

    const first = executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    await g.at; // worker 1 holds the claims

    const loser = await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    expect(loser).toMatchObject({ outcome: "skipped", disposition: "contention", code: "CLAIM_CONFLICT" });

    g.open();
    const winner = await first;
    expect(winner.outcome).toBe("operation_created");
    expect((await finish(h, winner.operationId!))?.phase).toBe("COMPLETED");
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(1);

    // Retried later: order 2 is already cancelled, so nothing happens twice.
    expect((await executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps)).outcome).toBe("skipped");
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(1);
    expect(h.shopify.order(1).lineItems).toHaveLength(2);
  });

  // Spec §9 #12.
  it("overlapping order sets {A,B} vs {B,C}: exactly one wins; the retry merges the remainder without duplicating items", async () => {
    const h = setup([makeOrder(1), makeOrder(2), makeOrder(3)]);
    const g = gate();
    h.shopify.on("MergeEditBegin", async (_v, call) => {
      if (call === 1) {
        g.reached();
        await g.release;
      }
      return undefined;
    });

    const first = executeMerge(h.shopify.admin, h.SHOP, [id(2), id(1)], h.deps);
    await g.at; // holds {1, 2}

    const loser = await executeMerge(h.shopify.admin, h.SHOP, [id(3), id(2)], h.deps);
    expect(loser).toMatchObject({ outcome: "skipped", disposition: "contention", code: "CLAIM_CONFLICT" });

    g.open();
    const winner = await first;
    expect(winner.outcome).toBe("operation_created");
    expect((await finish(h, winner.operationId!))?.phase).toBe("COMPLETED");
    expect(h.shopify.order(1).lineItems).toHaveLength(2);

    // The original set no longer qualifies — order 2 was merged away.
    expect((await executeMerge(h.shopify.admin, h.SHOP, [id(3), id(2)], h.deps)).outcome).toBe("skipped");
    // The still-eligible remainder merges on retry.
    const second = await executeMerge(h.shopify.admin, h.SHOP, [id(3), id(1)], h.deps);
    expect(second.outcome).toBe("operation_created");
    expect((await finish(h, second.operationId!))?.phase).toBe("COMPLETED");

    expect(h.shopify.order(1).lineItems).toHaveLength(3);
    expect(new Set(h.shopify.order(1).lineItems.map((i) => i.id)).size).toBe(3);
    expect(h.shopify.order(2).cancelledAt).not.toBeNull();
    expect(h.shopify.order(3).cancelledAt).not.toBeNull();
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(2);
  });

  // Spec §9 #13.
  it("stalled worker: its next fence throws after the lease lapsed and another worker took the claims; no commit issued", async () => {
    const h = setup();
    const g = gate();
    h.shopify.on("MergeEditBegin", async (_v, call) => {
      if (call === 1) {
        g.reached();
        await g.release;
      }
      return undefined;
    });

    const first = executeMerge(h.shopify.admin, h.SHOP, IDS, h.deps);
    await g.at; // stalled between its fence and the mutation

    h.advance(121_000); // the claims expire (lease TTL is 120s)
    expect(await h.claims.acquire(SHOP, IDS, "other-worker", 60_000)).toBe(true); // taken over

    g.open();
    await expect(first).resolves.toMatchObject({
      outcome: "failed",
      disposition: "contention",
      code: "OWNERSHIP_LOST",
    });
    expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(0);
    // The stale worker's release cannot remove the other worker's claims.
    expect(h.claims.claims.size).toBe(2);
    expect([...h.claims.claims.values()].every((c) => c.token === "other-worker")).toBe(true);
  });
});

// Spec §9 #20.
describe("stale-token guards (memory stores)", () => {
  it("MemoryClaimStore: renew/release with a wrong or expired token never modify state", async () => {
    let t = 0;
    const store = new MemoryClaimStore();
    store.clock = () => new Date(t);
    const ids = ["o1", "o2"];

    expect(await store.acquire(SHOP, ids, "token-a", 60_000)).toBe(true);
    await expect(store.renew(SHOP, ids, "token-b", 60_000)).rejects.toBeInstanceOf(OwnershipLostError);
    await store.release(SHOP, ids, "token-b");
    expect(store.claims.size).toBe(2); // untouched

    // Expired claims can be taken over; the stale token stays dead.
    t = 61_000;
    expect(await store.acquire(SHOP, ids, "token-b", 60_000)).toBe(true);
    await expect(store.renew(SHOP, ids, "token-a", 60_000)).rejects.toBeInstanceOf(OwnershipLostError);
    await store.release(SHOP, ids, "token-a");
    expect(store.claims.size).toBe(2);

    // Partial renews count every id: one missing claim => ownership lost.
    await store.release(SHOP, ["o1"], "token-b");
    await expect(store.renew(SHOP, ids, "token-b", 60_000)).rejects.toBeInstanceOf(OwnershipLostError);

    // An expired lease cannot be renewed, and reaping removes it.
    t = 200_000;
    await expect(store.renew(SHOP, ["o2"], "token-b", 60_000)).rejects.toBeInstanceOf(OwnershipLostError);
    expect(await store.reapExpired()).toBe(1);
    expect(store.claims.size).toBe(0);
  });

  it("MemoryJournal: update/renew with a stale or expired token throw and change nothing", async () => {
    let t = 0;
    const journal = new MemoryJournal();
    journal.clock = () => new Date(t);

    const op = await journal.create(newOp(), "token-a", 60_000);
    await expect(
      journal.update({ id: op.id, leaseToken: "bogus" }, { status: "COMPLETED" }),
    ).rejects.toBeInstanceOf(OwnershipLostError);
    expect(journal.only().status).toBe("PENDING_COMMIT");
    await expect(journal.renew({ id: op.id, leaseToken: "bogus" }, 60_000)).rejects.toBeInstanceOf(
      OwnershipLostError,
    );

    // A live lease cannot be taken over; after expiry it can, and the stale
    // token stays dead.
    expect(await journal.acquireLease(op.id, "token-b", 60_000)).toBeNull();
    t = 61_000;
    const leased = await journal.acquireLease(op.id, "token-b", 60_000);
    expect(leased?.leaseToken).toBe("token-b");
    await expect(journal.update(op, { status: "COMPLETED" })).rejects.toBeInstanceOf(OwnershipLostError);
    await expect(journal.renew(op, 60_000)).rejects.toBeInstanceOf(OwnershipLostError);
    expect(journal.only().status).toBe("PENDING_COMMIT");
    expect(await journal.acquireLease(op.id, "token-c", 60_000)).toBeNull();

    await journal.update(leased!, { status: "COMMITTED" });
    expect(journal.only().status).toBe("COMMITTED");

    // An expired lease blocks conditional writes but can be re-acquired.
    t = 200_000;
    await expect(journal.update(leased!, { lastError: "x" })).rejects.toBeInstanceOf(OwnershipLostError);
    const reacquired = await journal.acquireLease(op.id, "token-c", 60_000);
    expect(reacquired?.leaseToken).toBe("token-c");
  });
});
