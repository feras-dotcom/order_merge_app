// Deterministic regression tests for protocol v2 (spec §12). Each test is a
// named counterexample the old count/lease architecture got wrong; assertions
// target the specific invariant (exactly one orderEditCommit, no MergeRecord
// after takeover, locks held/absent per phase, no re-dispatch in doubt).

import { expect, it } from "vitest";
import { executeMerge, type MergeDeps } from "../app/lib/merge.server";
import { driveOperation, sourceManifestMismatch } from "../app/lib/operation-protocol.server";
import { ClaimContentionError, newLeaseToken, OwnershipLostError } from "../app/lib/ownership.server";
import type { NewOperationV2, OperationRecord } from "../app/lib/operation-store.server";
import {
  advance,
  FakeShopify,
  MemoryJournal,
  makeLineItem,
  makeOrder,
  testDeps,
  topLevelError,
  userError,
  type FakeOrder,
  type MemoryOperationStore,
  type MemoryWorkStore,
} from "./fake-shopify";

const SHOP = "test.myshopify.com";
const id = (n: number) => `gid://shopify/Order/${n}`;
const IDS = [id(2), id(1)];

type Deps = MergeDeps & { ops: MemoryOperationStore; workStore: MemoryWorkStore };

function setup(orders = [makeOrder(1), makeOrder(2)], overrides: Partial<MergeDeps> = {}) {
  const shopify = new FakeShopify(orders);
  const journal = new MemoryJournal();
  const deps = testDeps(journal, overrides) as Deps;
  shopify.clock = deps.now;
  return { shopify, journal, deps, ops: deps.ops, work: deps.workStore };
}
type Ctx = ReturnType<typeof setup>;

/** Lease (if expired) + drive one pass. */
async function drive(ctx: Ctx, op: OperationRecord | string): Promise<OperationRecord | null> {
  const rec = typeof op === "string" ? await ctx.ops.getOperation(op) : op;
  if (!rec) return null;
  const now = ctx.deps.now().getTime();
  const driveable =
    rec.leasedUntil && rec.leasedUntil.getTime() > now
      ? rec
      : await ctx.ops.acquireOperationLease(rec.id, newLeaseToken(), ctx.deps.leaseTtlMs);
  if (!driveable) return rec;
  return driveOperation(driveable, ctx.shopify.admin, ctx.deps);
}

/** Drive until terminal / REVIEW_REQUIRED / an over-limit wait, advancing the
 *  fake clock to each scheduled check (the sweeper's acquire path). */
async function driveToIdle(
  ctx: Ctx,
  op: OperationRecord | string,
  maxMs = 8 * 24 * 60 * 60_000,
): Promise<OperationRecord | null> {
  let rec = typeof op === "string" ? await ctx.ops.getOperation(op) : op;
  let elapsed = 0;
  for (let i = 0; i < 300; i++) {
    if (!rec) return null;
    if (
      rec.phase === "ABANDONED" ||
      rec.phase === "REVIEW_REQUIRED" ||
      (rec.phase === "COMPLETED" && rec.sideEffectsDone)
    ) {
      return rec;
    }
    const now = ctx.deps.now().getTime();
    if (rec.nextCheckAt && rec.nextCheckAt.getTime() > now) {
      const waitMs = rec.nextCheckAt.getTime() - now;
      if (elapsed + waitMs > maxMs) return rec;
      advance(ctx.deps, waitMs);
      elapsed += waitMs;
      rec = await ctx.ops.getOperation(rec.id);
      continue;
    }
    const held = rec.leasedUntil != null && rec.leasedUntil.getTime() > now;
    let leased = held
      ? rec
      : await ctx.ops.acquireOperationLease(rec.id, newLeaseToken(), ctx.deps.leaseTtlMs);
    if (!leased) {
      // Boundary case: the lease may be expiring exactly now while the strict
      // SQL `leasedUntil < now` keeps it un-claimable — the next tick takes it.
      advance(ctx.deps, 1_000);
      leased = await ctx.ops.acquireOperationLease(rec.id, newLeaseToken(), ctx.deps.leaseTtlMs);
      if (!leased) return rec;
    }
    rec = (await driveOperation(leased, ctx.shopify.admin, ctx.deps)) ?? (await ctx.ops.getOperation(rec.id));
  }
  return rec;
}

/** A work item owned by this "worker", for executeMerge's workItem handoff. */
async function linkedWork(ctx: Ctx, orderId: string) {
  const item = await ctx.work.insertLeased(SHOP, orderId, "wt", ctx.deps.leaseTtlMs, 6 * 3600_000);
  return item!;
}

const opInput = (ctx: Ctx, overrides: Partial<NewOperationV2> = {}): NewOperationV2 => ({
  shop: SHOP,
  claimToken: "claim",
  involvedOrderIds: [id(1), id(2)],
  primaryOrderId: id(1),
  primaryOrderName: "#1",
  customerId: "gid://shopify/Customer/1",
  primaryLineItemCountBefore: 1,
  addedLineItemCount: 1,
  secondaries: [{ id: id(2), name: "#2", items: 1, cancelPhase: "TRANSFER_PENDING" }],
  opToken: "TESTTEST",
  calculatedOrderId: null,
  expectedTransfer: [],
  expectedLocationId: null,
  primaryLineItemIdsBefore: [],
  leaseToken: "op-lease",
  ttlMs: 60_000,
  ...overrides,
});

// ── 1. Late commit applies after client timeout ──────────────────────────────

it("1. lose-apply-later: ladder checks, delivery at +3m, APPLIED at +5m, one commit ever", async () => {
  const ctx = setup();
  const { shopify, deps, ops, journal } = ctx;
  const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
  expect(result.code).toBe("OPERATION_CREATED");
  const calcId = shopify.lastCalcId();
  shopify.commitMode.set(calcId, "lose-apply-later");

  let op = await drive(ctx, result.operation!);
  expect(op?.phase).toBe("COMMIT_IN_DOUBT");
  const base = op!.firstDispatchAt!.getTime();
  expect(op?.nextCheckAt?.getTime()).toBe(base + 30_000);
  expect(ops.attempts.filter((a) => a.kind === "EDIT_COMMIT")).toMatchObject([{ state: "UNKNOWN" }]);

  advance(deps, 30_000);
  op = await drive(ctx, op!.id);
  expect(op?.phase).toBe("COMMIT_IN_DOUBT");
  expect(op?.nextCheckAt?.getTime()).toBe(base + 120_000);

  // The lost response was actually applied, ~3 minutes after dispatch.
  advance(deps, 180_000);
  shopify.deliverPendingCommit(calcId);

  const final = await driveToIdle(ctx, op!.id);
  expect(final?.phase).toBe("COMPLETED");
  expect(final?.sideEffectsDone).toBe(true);
  // The critical invariant: one begin/commit pair, one cancel, one record.
  expect(shopify.mutationCalls("MergeEditBegin")).toBe(1);
  expect(shopify.mutationCalls("MergeEditCommit")).toBe(1);
  expect(shopify.order(2).cancelCount).toBe(1);
  expect(shopify.order(2).cancelledAt).not.toBeNull();
  expect(ops.records).toHaveLength(1);
  expect(journal.history).toHaveLength(1);
  expect(ops.locks.size).toBe(0); // terminal ops release their locks
});

// ── 2. Commit never applies ──────────────────────────────────────────────────

it("2. lose-never: REVIEW_REQUIRED at +60m, locks held, no cancel, work item OPERATION_REVIEW", async () => {
  const ctx = setup();
  const { shopify, deps, ops, work } = ctx;
  const wi = await linkedWork(ctx, id(2));
  const result = await executeMerge(shopify.admin, SHOP, IDS, {
    ...deps,
    workItem: { id: wi.id, token: "wt" },
  });
  expect(result.code).toBe("OPERATION_CREATED");
  // The work item settled inside createOperation.
  expect((await work.find(SHOP, id(2)))?.outcome).toBe("OPERATION_CREATED");
  shopify.commitMode.set(shopify.lastCalcId(), "lose-never");

  const final = await driveToIdle(ctx, result.operation!);
  expect(final?.phase).toBe("REVIEW_REQUIRED");
  expect(final?.reviewReason).toContain("no evidence");
  // Durable locks stay — the orders are off-limits until a human reconciles.
  expect(ops.locks.size).toBe(2);
  expect(shopify.mutationCalls("MergeCancelSecondary")).toBe(0);
  // Never a second commit.
  expect(ops.attempts.filter((a) => a.kind === "EDIT_COMMIT")).toHaveLength(1);
  expect(shopify.mutationCalls("MergeEditCommit")).toBe(1);
  expect((await work.find(SHOP, id(2)))?.outcome).toBe("OPERATION_REVIEW");
  // Review side effects: both orders tagged for review.
  expect(shopify.order(1).tags).toContain("MergeShip-Review");
  expect(shopify.order(2).tags).toContain("MergeShip-Review");
});

// ── 3. Unrelated merchant edit matching the count ────────────────────────────

it("3. merchant edit matching the count: ABANDONED pre-dispatch / never cancel post-dispatch", async () => {
  // (a) The edit lands between op creation and the READY step: the primary's
  //     recorded line-item ids no longer match => ABANDONED, nothing sent,
  //     the work item goes back to PENDING.
  {
    const ctx = setup();
    const { shopify, deps, ops, work } = ctx;
    const wi = await linkedWork(ctx, id(2));
    const result = await executeMerge(shopify.admin, SHOP, IDS, {
      ...deps,
      workItem: { id: wi.id, token: "wt" },
    });
    shopify.merchantAddLine(id(1)); // a line with NO MergeShip token
    const op = await drive(ctx, result.operation!);
    expect(op?.phase).toBe("ABANDONED");
    expect(ops.attempts.filter((a) => a.kind === "EDIT_COMMIT")).toHaveLength(0);
    expect(shopify.mutationCalls("MergeEditCommit")).toBe(0);
    expect(ops.locks.size).toBe(0);
    expect(await work.find(SHOP, id(2))).toMatchObject({ status: "PENDING", outcome: null });
  }
  // (b) The edit lands after dispatch while the commit never applies: the
  //     primary's line count now equals what the merge would have produced,
  //     but no token exists => NONE on the ladder, REVIEW at +60m, the
  //     secondary is never cancelled.
  {
    const ctx = setup();
    const { shopify, deps, ops } = ctx;
    const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
    shopify.commitMode.set(shopify.lastCalcId(), "lose-never");
    // The merchant's untokened edit lands AFTER the commit was dispatched.
    let op = await drive(ctx, result.operation!);
    expect(op?.phase).toBe("COMMIT_IN_DOUBT");
    shopify.merchantAddLine(id(1)); // count now matches the expected post-merge count
    const final = await driveToIdle(ctx, op!);
    expect(final?.phase).toBe("REVIEW_REQUIRED");
    expect(shopify.mutationCalls("MergeCancelSecondary")).toBe(0);
    expect(shopify.order(2).cancelledAt).toBeNull();
    expect(ops.locks.size).toBe(2);
  }
});

// ── 4. Crash/claim-takeover before the operation insert ─────────────────────

it("4. claims taken over at beforeOpInsert: no op row, no locks, no commit", async () => {
  const ctx = setup();
  const { shopify, deps, ops } = ctx;
  deps.hooks = {
    beforeOpInsert: async () => {
      advance(deps, deps.leaseTtlMs + 1);
      await deps.claims.acquire(SHOP, IDS, "worker-b", deps.leaseTtlMs);
    },
  };
  const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
  expect(result).toMatchObject({ outcome: "failed", code: "OWNERSHIP_LOST" });
  expect(ops.ops.size).toBe(0);
  expect(ops.locks.size).toBe(0);
  expect(ops.attempts).toHaveLength(0);
  expect(shopify.mutationCalls("MergeEditCommit")).toBe(0);
});

// ── 5. Takeover while the op is READY ────────────────────────────────────────

it("5. paused at afterOpInsert: takeover drives; exactly one EDIT_COMMIT; stale gate returns null", async () => {
  const ctx = setup();
  const { shopify, deps, ops } = ctx;
  deps.hooks = {
    afterOpInsert: async () => {
      // Worker A stalls here; its op lease expires and worker B takes over.
      advance(deps, deps.leaseTtlMs + 1);
      const opId = [...ops.ops.keys()][0];
      const taken = await ops.acquireOperationLease(opId, "worker-b", deps.leaseTtlMs);
      const done = await driveToIdle(ctx, taken!);
      expect(done?.phase).toBe("COMPLETED");
    },
  };
  const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
  expect(result.code).toBe("OPERATION_CREATED");

  // The stale worker's copy cannot do anything: renew fails, the gate refuses.
  expect(await driveOperation(result.operation!, shopify.admin, deps)).toBeNull();
  const gate = await ops.openDispatchGate({
    op: result.operation!,
    kind: "EDIT_COMMIT",
    targetOrderId: id(1),
    dispatchToken: "stale",
    requiredPhase: "READY",
  });
  expect(gate).toBeNull();
  expect(ops.attempts.filter((a) => a.kind === "EDIT_COMMIT")).toHaveLength(1);
  expect(shopify.mutationCalls("MergeEditCommit")).toBe(1);
  expect(shopify.order(2).cancelCount).toBe(1);
});

// ── 6. Takeover between dispatch and the attempt record ─────────────────────

it("6. paused at afterSend: the stale dispatcher's fact is still recorded; op APPLIED once", async () => {
  const ctx = setup();
  const { shopify, deps, ops } = ctx;
  let took = false;
  deps.hooks = {
    afterSend: async () => {
      if (took) return; // the takeover drive below also fires this hook
      took = true;
      advance(deps, deps.leaseTtlMs + 1);
      const opId = [...ops.ops.keys()][0];
      const taken = await ops.acquireOperationLease(opId, "worker-b", deps.leaseTtlMs);
      // B sees the DISPATCHING attempt, reads evidence, and completes the op.
      const done = await driveToIdle(ctx, taken!);
      expect(done?.phase).toBe("COMPLETED");
    },
  };
  const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
  // A resumes, writes its write-once fact, then every further write fails.
  expect(await driveOperation(result.operation!, shopify.admin, deps)).toBeNull();
  expect(ops.attempts.find((a) => a.kind === "EDIT_COMMIT")).toMatchObject({ state: "SUCCEEDED" });
  expect(ops.records).toHaveLength(1); // recorded exactly once (by B)
  expect(shopify.mutationCalls("MergeEditCommit")).toBe(1);
  expect(shopify.order(2).cancelCount).toBe(1);
});

// ── 7. Lease TTL vs. slow reads ──────────────────────────────────────────────

it("7. three 40s reads under a 120s TTL complete; a 130s stall loses ownership and writes nothing", async () => {
  {
    const ctx = setup(undefined, { leaseTtlMs: 120_000 });
    const { shopify, deps, ops } = ctx;
    // Every MergeOrderState read takes 40s; the fence renews claims before each.
    shopify.on("MergeOrderState", (_v, call) => {
      if (call <= 3) advance(deps, 40_000);
      return undefined;
    });
    const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
    expect(result.code).toBe("OPERATION_CREATED");
    const op = await driveToIdle(ctx, result.operation!);
    expect(op?.phase).toBe("COMPLETED");
    expect(shopify.order(2).cancelCount).toBe(1);
    expect(ops.records).toHaveLength(1);
  }
  {
    const ctx = setup(undefined, { leaseTtlMs: 120_000 });
    const { shopify, deps, ops } = ctx;
    // One read stalls for 130s: the claims expire mid-read and the next
    // fence throws before anything durable is written.
    shopify.on("MergeOrderState", (_v, call) => {
      if (call === 2) advance(deps, 130_000);
      return undefined;
    });
    const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
    expect(result).toMatchObject({ outcome: "failed", code: "OWNERSHIP_LOST" });
    expect(ops.ops.size).toBe(0);
    expect(ops.locks.size).toBe(0);
    expect(shopify.mutationCalls("MergeEditCommit")).toBe(0);
  }
});

// ── 8. Overlapping sets + lock uniqueness ────────────────────────────────────

it("8. overlapping sets {1,2} vs {2,3}: one op only; the second run is LOCKED", async () => {
  const ctx = setup([makeOrder(1), makeOrder(2), makeOrder(3)]);
  const { shopify, deps, ops } = ctx;
  const a = await executeMerge(shopify.admin, SHOP, [id(2), id(1)], deps);
  expect(a.code).toBe("OPERATION_CREATED");
  expect(ops.locks.size).toBe(2);

  // Claims were released on the way out; the durable lock still blocks B.
  const b = await executeMerge(shopify.admin, SHOP, [id(3), id(2)], deps);
  expect(b).toMatchObject({ outcome: "skipped", disposition: "contention", code: "LOCKED" });
  expect(ops.ops.size).toBe(1);

  // And the store itself refuses a duplicate lock for an overlapping set.
  await deps.claims.acquire(SHOP, [id(2), id(3)], "b", deps.leaseTtlMs);
  await expect(
    ops.createOperation(opInput(ctx, { claimToken: "b", involvedOrderIds: [id(2), id(3)], primaryOrderId: id(2) })),
  ).rejects.toThrow(ClaimContentionError);
  expect(ops.ops.size).toBe(1);
  expect(ops.locks.size).toBe(2);
});

// ── 9. Compatible blocked + incompatible free ────────────────────────────────

it("9. sibling locked + free sibling incompatible: contention retry; merges after the lock clears", async () => {
  const { makeHarness } = await import("./fake-shopify");
  const h = makeHarness([
    makeOrder(1, { currencyCode: "EUR", presentmentCurrencyCode: "EUR" }), // same group, incompatible
    makeOrder(2),
    makeOrder(3),
  ]);
  // A foreign op holds order 2's durable lock.
  await h.claims.acquire(h.SHOP, [id(2)], "holder", h.deps.leaseTtlMs);
  const holder = await h.ops.createOperation(
    opInput(
      { deps: h.deps } as Ctx,
      {
        claimToken: "holder",
        involvedOrderIds: [id(2)],
        primaryOrderId: id(2),
        primaryOrderName: "#2",
        secondaries: [],
        leaseToken: "holder-op",
      },
    ),
  );
  const wi = await h.webhook(id(3)); // anchor order 3, processed inline
  expect(wi?.status).toBe("PENDING"); // contention retry, not a failure
  expect([...h.ops.ops.keys()]).toHaveLength(1); // no second op
  expect(h.shopify.mutationCalls("MergeEditCommit")).toBe(0);

  // Release the blocker and let the sweeper pick the item back up.
  await h.ops.transition(
    { id: holder.id, leaseToken: "holder-op", workItemId: null },
    { phase: "ABANDONED", lastError: "test done" },
  );
  // The durable lock is gone; release the setup claim too so it doesn't
  // collide with the retried work item's fresh claim.
  await h.claims.release(h.SHOP, [id(2)], "holder");
  h.advance(120_000);
  await h.sweep();

  const op = [...h.ops.ops.values()].find((o) => o.id !== holder.id)!;
  const final = await h.driveUntilIdle(op.id);
  expect(final?.phase).toBe("COMPLETED");
  expect(h.shopify.order(3).cancelledAt).not.toBeNull(); // order 3 merged into order 2
  expect(h.shopify.order(1).cancelCount).toBe(0); // incompatible order untouched
  expect(h.shopify.order(2).lineItems).toHaveLength(2);
});

// ── 10. Bounded exhaustion via exhaustDue ────────────────────────────────────

it("10. exhaustDue converts an item past its limit while its stale owner still 'holds' an expired lease", async () => {
  const ctx = setup();
  const { work, deps } = ctx;
  const wi = await work.insertLeased(SHOP, id(2), "stale", 1_000, 6 * 3600_000);
  work.items.get(wi!.id)!.attempts = 20; // at the retry limit
  advance(deps, 2_000); // the stale lease has lapsed

  expect(await work.exhaustDue()).toBe(1);
  const row = await work.find(SHOP, id(2));
  expect(row).toMatchObject({ status: "REVIEW", outcome: "EXHAUSTED" });
  // Every stale write fails on status <> PENDING.
  expect(await work.markDone(wi!.id, "stale", "MERGED", "x")).toBe(false);
  expect(await work.scheduleRetry(wi!.id, "stale", 1_000, "x")).toBe(false);
  await expect(work.renew(wi!.id, "stale", 60_000)).rejects.toThrow(OwnershipLostError);
});

// ── 11. Cancellation response lost ───────────────────────────────────────────

it("11. cancel response lost: exactly one orderCancel; verified from cancelledAt + staffNote", async () => {
  const ctx = setup();
  const { shopify, deps, ops } = ctx;
  shopify.cancelMode.set(id(2), "lose"); // applied, response never received
  const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
  const op = await driveToIdle(ctx, result.operation!);
  expect(op?.phase).toBe("COMPLETED");
  expect(shopify.mutationCalls("MergeCancelSecondary")).toBe(1); // never re-issued
  expect(ops.attempts.find((a) => a.kind === "ORDER_CANCEL")).toMatchObject({ state: "UNKNOWN" });
  expect(ops.records).toHaveLength(1);
  expect(shopify.order(2).cancelledAt).not.toBeNull();
});

// ── 12. "Already been saved" is UNKNOWN, reconciled by evidence ──────────────

it("12. already-saved commit => UNKNOWN attempt, evidence APPLIED, never ABANDONED", async () => {
  const ctx = setup();
  const { shopify, deps, ops } = ctx;
  const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
  const calcId = shopify.lastCalcId();
  let fired = false;
  deps.hooks = {
    afterDispatchGate: async () => {
      if (fired) return; // only for the EDIT_COMMIT gate
      fired = true;
      // Shopify applied the commit before this request arrived (a retry
      // upstream, or a timed-out earlier call).
      shopify.applyCommit(calcId);
    },
  };
  const op = await driveToIdle(ctx, result.operation!);
  expect(op?.phase).toBe("COMPLETED");
  expect(ops.attempts.find((a) => a.kind === "EDIT_COMMIT")).toMatchObject({ state: "UNKNOWN" });
  expect(shopify.order(2).cancelCount).toBe(1);
  expect(ops.records).toHaveLength(1);
});

// ── 13. Kill-switch races ────────────────────────────────────────────────────

it("13. kill-switch flips before the gate: no Shopify call; completion switch holds cancellation", async () => {
  // (a) newMergesEnabled off at gate time: READY persists, nothing sent.
  {
    const ctx = setup();
    const { shopify, deps, ops } = ctx;
    deps.hooks = {
      afterOpInsert: async () => {
        await ops.setControl({ newMergesEnabled: false });
      },
    };
    const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
    const op = await drive(ctx, result.operation!);
    expect(op?.phase).toBe("READY");
    expect(op?.nextCheckAt).not.toBeNull();
    expect(ops.attempts).toHaveLength(0);
    expect(shopify.mutationCalls("MergeEditCommit")).toBe(0);
    expect(ops.locks.size).toBe(2);
  }
  // (b) completionEnabled off: the commit applies; the cancel waits at the gate.
  {
    const ctx = setup();
    const { shopify, deps, ops } = ctx;
    const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
    await ops.setControl({ completionEnabled: false });
    let op = await drive(ctx, result.operation!);
    expect(op?.phase).toBe("APPLIED");
    expect(shopify.mutationCalls("MergeCancelSecondary")).toBe(0);
    // Switch on: the held cancellation proceeds normally.
    await ops.setControl({ completionEnabled: true });
    advance(deps, 60_000);
    op = await driveToIdle(ctx, op!.id);
    expect(op?.phase).toBe("COMPLETED");
    expect(shopify.order(2).cancelCount).toBe(1);
  }
});

// ── 14. Definitive rejection + quiet period ──────────────────────────────────

it("14. rejected commit: COMMIT_REJECTED, quiet 15m, then ABANDONED — unless a token appears", async () => {
  // (a) Absence of evidence after the quiet period => ABANDONED, locks
  //     released, work item requeued.
  {
    const ctx = setup();
    const { shopify, deps, ops, work } = ctx;
    const wi = await linkedWork(ctx, id(2));
    const result = await executeMerge(shopify.admin, SHOP, IDS, {
      ...deps,
      workItem: { id: wi.id, token: "wt" },
    });
    shopify.commitMode.set(shopify.lastCalcId(), "reject");
    let op = await drive(ctx, result.operation!);
    expect(op?.phase).toBe("COMMIT_REJECTED");
    expect(ops.attempts.find((a) => a.kind === "EDIT_COMMIT")).toMatchObject({ state: "REJECTED" });
    expect(ops.locks.size).toBe(2); // still held during the quiet period
    expect((await work.find(SHOP, id(2)))?.outcome).toBe("OPERATION_CREATED");
    advance(deps, 15 * 60_000);
    op = await drive(ctx, op!.id);
    expect(op?.phase).toBe("ABANDONED");
    expect(ops.locks.size).toBe(0);
    expect((await work.find(SHOP, id(2)))?.status).toBe("PENDING"); // requeued
    expect(shopify.mutationCalls("MergeCancelSecondary")).toBe(0);
  }
  // (b) Shopify applied the commit despite returning an (undocumented)
  //     userError: the wording proves nothing, so the attempt is UNKNOWN and
  //     evidence — the token lines — reconciles the op to completion.
  {
    const ctx = setup();
    const { shopify, deps, ops } = ctx;
    const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
    const calcId = shopify.lastCalcId();
    shopify.on("MergeEditCommit", () => {
      shopify.applyCommit(calcId);
      return userError("orderEditCommit", "userErrors", "Rejected at commit");
    });
    let op = await drive(ctx, result.operation!);
    expect(ops.attempts.find((a) => a.kind === "EDIT_COMMIT")).toMatchObject({ state: "UNKNOWN" });
    op = await driveToIdle(ctx, op!.id);
    expect(op?.phase).toBe("COMPLETED");
    expect(shopify.order(2).cancelCount).toBe(1);
    expect(shopify.mutationCalls("MergeEditCommit")).toBe(1);
  }
});

// ── 15. Stale history write after takeover ───────────────────────────────────

it("15. takeover between verify and the history insert: no MergeRecord is written", async () => {
  const ctx = setup();
  const { shopify, deps, ops, journal } = ctx;
  let taken = false;
  deps.hooks = {
    beforeHistoryTx: async () => {
      if (taken) return;
      taken = true;
      advance(deps, deps.leaseTtlMs + 1);
      const opId = [...ops.ops.keys()][0];
      await ops.acquireOperationLease(opId, "worker-b", deps.leaseTtlMs);
    },
  };
  const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
  const out = await driveOperation(result.operation!, shopify.admin, deps);
  expect(out).toBeNull(); // lost the lease mid-flight
  expect(ops.records).toHaveLength(0);
  expect(journal.history).toHaveLength(0);
  // The op is intact, mid-APPLIED, owned by worker B — not corrupted.
  const op = await ops.getOperation(result.operation!.id);
  expect(op?.phase).toBe("APPLIED");
  expect(op?.leaseToken).toBe("worker-b");
});

// ── 16. tags only ever go through tagsAdd ────────────────────────────────────

it("16. tags are written by tagsAdd only; orderUpdate inputs never carry tags", async () => {
  const ctx = setup([makeOrder(1), makeOrder(2, { tags: ["VIP"], note: "Leave at back door" })]);
  const { shopify, deps } = ctx;
  const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
  const op = await driveToIdle(ctx, result.operation!);
  expect(op?.phase).toBe("COMPLETED");
  expect(shopify.mutationCalls("MergeTagsAdd")).toBeGreaterThan(0);
  expect(shopify.orderUpdateInputs.length).toBeGreaterThan(0);
  expect(shopify.orderUpdateInputs.every((i) => !("tags" in i))).toBe(true);
  expect(shopify.order(1).tags).toContain("VIP");
  expect(shopify.order(1).tags).toContain("Consolidated");
  expect(shopify.order(2).tags).toContain("Merged");
});

// ── 17. Lease lost between the gate and the send (R1) ────────────────────────

it("17. fence-before-send ownership loss: attempt REJECTED not dispatched, zero Shopify calls, op abandoned", async () => {
  const ctx = setup();
  const { shopify, deps, ops, work } = ctx;
  const item = await linkedWork(ctx, id(2));
  deps.workItem = { id: item.id, token: item.leaseToken! };
  deps.hooks = {
    afterDispatchGate: async () => {
      // The dispatcher stalls here until its op lease expires; the gate has
      // already flipped the phase and written the write-ahead attempt.
      advance(deps, deps.leaseTtlMs + 1);
    },
  };
  const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
  expect(result.code).toBe("OPERATION_CREATED");

  // The stale dispatcher's fence throws before admin.graphql: the request
  // provably never left the process, so the attempt is a REJECTED fact.
  expect(await driveOperation(result.operation!, shopify.admin, deps)).toBeNull();
  const attempt = ops.attempts.find((a) => a.kind === "EDIT_COMMIT")!;
  expect(attempt.state).toBe("REJECTED");
  expect(attempt.responseSummary).toContain("not dispatched");
  expect(shopify.mutationCalls("MergeEditCommit")).toBe(0);

  // A takeover reconciles: a REJECTED commit → COMMIT_REJECTED → quiet →
  // ABANDONED, locks released, the work item requeued.
  const taken = await ops.acquireOperationLease(result.operation!.id, "worker-b", deps.leaseTtlMs);
  const done = await driveToIdle(ctx, taken!);
  expect(done?.phase).toBe("ABANDONED");
  expect(ops.locks.size).toBe(0);
  expect(shopify.mutationCalls("MergeEditCommit")).toBe(0);
  expect(shopify.mutationCalls("MergeCancelSecondary")).toBe(0);
  const requeued = work.items.get(item.id)!;
  expect(requeued.status).toBe("PENDING");
  expect(requeued.operationId).toBe(result.operation!.id);
});

// ── 18. Legacy-converted ops accept the v1 cancel note ──────────────────────

const LEGACY_CANCEL_NOTE =
  "Repeat order merged into #1 by MergeShip. Items transferred, inventory restocked, not refunded.";

it("18. legacy op (calculatedOrderId null): 'merged into #1 by MergeShip' note verifies the cancel", async () => {
  const ctx = setup();
  const { shopify, deps, ops } = ctx;
  await deps.claims.acquire(SHOP, [id(1), id(2)], "claim", deps.leaseTtlMs);
  // legacy-reconcile marks converted ops with calculatedOrderId IS NULL.
  const op = await ops.createOperation(
    opInput(ctx, { calculatedOrderId: null, leaseToken: "legacy-lease" }),
  );
  await ops.transition(
    { id: op.id, leaseToken: "legacy-lease", workItemId: null },
    {
      expectedPhase: "READY",
      phase: "APPLIED",
      secondaries: [{ id: id(2), name: "#2", items: 1, cancelPhase: "CANCEL_READY" }],
      nextCheckAt: "now",
    },
  );
  // The secondary was cancelled during the v1 era — the note has no MS- token.
  shopify.order(2).cancelledAt = deps.now().toISOString();
  shopify.order(2).cancellation = { staffNote: LEGACY_CANCEL_NOTE };

  const final = await driveToIdle(ctx, op.id);
  expect(final?.phase).toBe("COMPLETED");
  expect(ops.records).toHaveLength(1);
  expect(shopify.mutationCalls("MergeCancelSecondary")).toBe(0); // verified, never re-issued
});

it("19. v2 op (calculatedOrderId set): a legacy-style note is NOT ours — REVIEW_REQUIRED", async () => {
  const ctx = setup();
  const { shopify, deps, ops } = ctx;
  await deps.claims.acquire(SHOP, [id(1), id(2)], "claim", deps.leaseTtlMs);
  const op = await ops.createOperation(
    opInput(ctx, {
      calculatedOrderId: "gid://shopify/CalculatedOrder/1",
      leaseToken: "v2-lease",
    }),
  );
  await ops.transition(
    { id: op.id, leaseToken: "v2-lease", workItemId: null },
    {
      expectedPhase: "READY",
      phase: "APPLIED",
      secondaries: [{ id: id(2), name: "#2", items: 1, cancelPhase: "CANCEL_READY" }],
      nextCheckAt: "now",
    },
  );
  shopify.order(2).cancelledAt = deps.now().toISOString();
  shopify.order(2).cancellation = { staffNote: LEGACY_CANCEL_NOTE };

  const final = await driveToIdle(ctx, op.id);
  expect(final?.phase).toBe("REVIEW_REQUIRED");
  expect(final?.reviewReason).toContain("outside MergeShip");
  expect(ops.records).toHaveLength(0); // a foreign cancel is never adopted
});

// ── 20. Secondary merchandise changed between plan and commit (B1) ───────────

it("20. secondary qty changed before dispatch: ABANDONED, nothing sent; a fresh merge uses the new quantity", async () => {
  const ctx = setup();
  const { shopify, deps, ops, work } = ctx;
  const wi = await linkedWork(ctx, id(2));
  const result = await executeMerge(shopify.admin, SHOP, IDS, {
    ...deps,
    workItem: { id: wi.id, token: "wt" },
  });
  expect(result.code).toBe("OPERATION_CREATED");

  // The merchant adds units to the secondary between planning and commit.
  const secLine = shopify.order(2).lineItems[0];
  shopify.setLineQuantity(id(2), secLine.id!, 3);

  const op = await drive(ctx, result.operation!);
  expect(op?.phase).toBe("ABANDONED");
  expect(op?.lastError).toContain("quantity changed");
  expect(ops.attempts).toHaveLength(0); // nothing was ever dispatched
  expect(shopify.mutationCalls("MergeEditCommit")).toBe(0);
  expect(shopify.mutationCalls("MergeCancelSecondary")).toBe(0);
  expect(ops.locks.size).toBe(0); // terminal ops release their locks
  expect(await work.find(SHOP, id(2))).toMatchObject({ status: "PENDING", outcome: null });

  // A fresh run re-plans and merges the new quantity.
  const again = await executeMerge(shopify.admin, SHOP, IDS, deps);
  expect(again.code).toBe("OPERATION_CREATED");
  const done = await driveToIdle(ctx, again.operation!);
  expect(done?.phase).toBe("COMPLETED");
  const moved = shopify.order(1).lineItems.find((i) => i.id !== shopify.order(1).lineItems[0].id);
  expect(moved?.quantity).toBe(3);
  expect(shopify.mutationCalls("MergeEditCommit")).toBe(1);
  expect(shopify.order(2).cancelCount).toBe(1);
});

// ── 21. Merchandise edited after the commit applied (B1) ────────────────────

it("21. secondary edited after APPLIED: cancel blocked, REVIEW_REQUIRED + CANCEL_REVIEW, locks kept", async () => {
  const mutations: [string, (s: FakeShopify) => void][] = [
    ["quantity increase", (s) => s.setLineQuantity(id(2), s.order(2).lineItems[0].id!, 3)],
    ["quantity decrease", (s) => s.setLineQuantity(id(2), s.order(2).lineItems[0].id!, 0)],
    ["new source line", (s) => void s.addSourceLine(id(2))],
    ["source line removed", (s) => s.removeLine(id(2), s.order(2).lineItems[0].id!)],
    ["variant substituted", (s) => s.setLineVariant(id(2), s.order(2).lineItems[0].id!, "gid://shopify/ProductVariant/9")],
    ["fulfillment change", (s) => s.fulfillLine(id(2), s.order(2).lineItems[0].id!)],
  ];
  for (const [name, mutate] of mutations) {
    const ctx = setup();
    const { shopify, deps, ops } = ctx;
    await ops.setControl({ completionEnabled: false }); // park the op at APPLIED
    const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
    expect(result.code, name).toBe("OPERATION_CREATED");
    const op = await drive(ctx, result.operation!);
    expect(op?.phase, name).toBe("APPLIED");
    const evidenceBefore = (await ops.getOperation(op!.id))?.appliedEvidence;

    mutate(shopify);
    await ops.setControl({ completionEnabled: true });
    advance(deps, 60_000); // past the gate's retry slot
    const final = await driveToIdle(ctx, op!.id);
    expect(final?.phase, name).toBe("REVIEW_REQUIRED");
    const stored = await ops.getOperation(op!.id);
    expect(stored?.secondaries[0]?.cancelPhase, name).toBe("CANCEL_REVIEW");
    expect(stored?.appliedEvidence, name).toEqual(evidenceBefore); // never rewritten
    expect(shopify.mutationCalls("MergeCancelSecondary"), name).toBe(0);
    expect(shopify.order(2).cancelledAt, name).toBeNull();
    expect(ops.locks.size, name).toBe(2);

    // A replacement merge on any involved order is durably locked out.
    const replacement = await executeMerge(shopify.admin, SHOP, IDS, deps);
    expect(replacement.code, name).toBe("LOCKED");
  }
});

// ── 22. Applied evidence tampered after APPLIED (B1) ────────────────────────

it("22. token/discount removed or rewritten after APPLIED: no cancel, REVIEW_REQUIRED", async () => {
  const cases: [string, () => FakeOrder[], (s: FakeShopify) => void][] = [
    [
      "token discount stripped",
      () => [makeOrder(1), makeOrder(2)],
      (s) => s.stripDiscount(id(1), s.order(1).lineItems.at(-1)!.id!),
    ],
    [
      "discount description rewritten (token gone)",
      () => [makeOrder(1), makeOrder(2)],
      (s) => s.rewriteDiscountDescription(id(1), s.order(1).lineItems.at(-1)!.id!, "merchant note"),
    ],
    [
      "token line currentQuantity reduced",
      () => [makeOrder(1), makeOrder(2)],
      (s) => {
        const line = s.order(1).lineItems.at(-1)!;
        line.currentQuantity = line.quantity - 1;
      },
    ],
    [
      "one of two token lines removed",
      () => [makeOrder(1), makeOrder(2, { lineItems: [makeLineItem(), makeLineItem()] })],
      (s) => s.removeLine(id(1), s.order(1).lineItems.at(-1)!.id!),
    ],
  ];
  for (const [name, orders, mutate] of cases) {
    const ctx = setup(orders());
    const { shopify, deps, ops } = ctx;
    await ops.setControl({ completionEnabled: false });
    const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
    expect(result.code, name).toBe("OPERATION_CREATED");
    const op = await drive(ctx, result.operation!);
    expect(op?.phase, name).toBe("APPLIED");
    const evidenceBefore = (await ops.getOperation(op!.id))?.appliedEvidence;

    mutate(shopify);
    await ops.setControl({ completionEnabled: true });
    advance(deps, 60_000);
    const final = await driveToIdle(ctx, op!.id);
    expect(final?.phase, name).toBe("REVIEW_REQUIRED");
    const stored = await ops.getOperation(op!.id);
    expect(stored?.secondaries[0]?.cancelPhase, name).toBe("CANCEL_REVIEW");
    expect(stored?.appliedEvidence, name).toEqual(evidenceBefore);
    expect(shopify.mutationCalls("MergeCancelSecondary"), name).toBe(0);
    expect(ops.locks.size, name).toBe(2);
  }
});

// ── 23. Happy path with quantities > 1 (fake monetary fix) ───────────────────

it("23. a quantity-2 transfer commits, cancels once and completes", async () => {
  const ctx = setup([
    makeOrder(1),
    makeOrder(2, { lineItems: [makeLineItem({ quantity: 2, currentQuantity: 2, unfulfilledQuantity: 2 })] }),
  ]);
  const { shopify, deps, ops } = ctx;
  const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
  const op = await driveToIdle(ctx, result.operation!);
  expect(op?.phase).toBe("COMPLETED");
  expect(shopify.mutationCalls("MergeEditCommit")).toBe(1);
  expect(shopify.order(2).cancelCount).toBe(1);
  expect(ops.locks.size).toBe(0);
  const moved = shopify.order(1).lineItems.find((i) => i.id !== shopify.order(1).lineItems[0].id);
  expect(moved?.quantity).toBe(2);
});

// ── 24. Calculated order gone before dispatch (B2) ──────────────────────────

it("24. calculated order deleted after op creation: ABANDONED, no attempt, work requeued", async () => {
  const ctx = setup();
  const { shopify, deps, ops, work } = ctx;
  const wi = await linkedWork(ctx, id(2));
  const result = await executeMerge(shopify.admin, SHOP, IDS, {
    ...deps,
    workItem: { id: wi.id, token: "wt" },
  });
  shopify.deleteCalculatedOrder(shopify.lastCalcId()); // node() now returns null
  const op = await drive(ctx, result.operation!);
  expect(op?.phase).toBe("ABANDONED");
  expect(ops.attempts).toHaveLength(0);
  expect(shopify.mutationCalls("MergeEditCommit")).toBe(0);
  expect(ops.locks.size).toBe(0);
  expect((await work.find(SHOP, id(2)))?.status).toBe("PENDING");
});

// ── 25. One transient calculated-order read failure (B2) ────────────────────

it("25. one transient calc-order read failure: stays READY, next drive commits normally", async () => {
  const ctx = setup();
  const { shopify, deps } = ctx;
  // Call 1 is executeMerge's freeze-verify; call 2 is the READY re-verify.
  shopify.on("MergeCalculatedOrder", (_v, call) => (call === 2 ? topLevelError() : undefined));
  const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
  let op = await drive(ctx, result.operation!);
  expect(op?.phase).toBe("READY"); // retried, not abandoned
  advance(deps, 60_000);
  op = await driveToIdle(ctx, op!.id);
  expect(op?.phase).toBe("COMPLETED");
  expect(shopify.mutationCalls("MergeEditCommit")).toBe(1);
});

// ── 26. All evidence reads fail through the horizon (B2) ────────────────────

it("26. evidence reads fail through the read-failure horizon: REVIEW_REQUIRED, locks kept", async () => {
  const ctx = setup();
  const { shopify, deps, ops } = ctx;
  shopify.on("MergeOrderEvidence", () => topLevelError("outage"));
  const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
  const final = await driveToIdle(ctx, result.operation!);
  expect(final?.phase).toBe("REVIEW_REQUIRED");
  expect(final?.reviewReason).toContain("Shopify could not be read");
  expect(ops.locks.size).toBe(2); // review keeps the orders protected
  expect(shopify.mutationCalls("MergeCancelSecondary")).toBe(0);
});

// ── 27. Ambiguous "Internal error" userError, delayed application (B3) ──────

it("27. 'Internal error' userError + delayed application: UNKNOWN, reconciled, exactly one commit", async () => {
  const ctx = setup();
  const { shopify, deps, ops } = ctx;
  const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
  const calcId = shopify.lastCalcId();
  shopify.commitMode.set(calcId, "reject-internal");
  let op = await drive(ctx, result.operation!);
  expect(op?.phase).toBe("COMMIT_IN_DOUBT");
  expect(ops.attempts.find((a) => a.kind === "EDIT_COMMIT")).toMatchObject({ state: "UNKNOWN" });

  // While the dispatch is in doubt, a replacement merge is durably locked out.
  const replacement = await executeMerge(shopify.admin, SHOP, IDS, deps);
  expect(replacement.code).toBe("LOCKED");

  // The "rejected" commit applies after all — evidence reconciles, the calc
  // is never re-committed, and the lines are never duplicated.
  advance(deps, 30_000);
  shopify.deliverPendingCommit(calcId);
  op = await driveToIdle(ctx, op!.id);
  expect(op?.phase).toBe("COMPLETED");
  expect(shopify.mutationCalls("MergeEditCommit")).toBe(1);
  expect(shopify.order(1).lineItems).toHaveLength(2); // applied once, NOT 3
  expect(shopify.order(2).cancelCount).toBe(1);
});

// ── 28. Undocumented userError: UNKNOWN, never resent (B3) ──────────────────

it("28. undocumented commit userError: UNKNOWN attempt, evidence ladder, REVIEW at +60m", async () => {
  const ctx = setup();
  const { shopify, deps, ops } = ctx;
  const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
  shopify.on("MergeEditCommit", () =>
    userError("orderEditCommit", "userErrors", "Something entirely undocumented"),
  );
  let op = await drive(ctx, result.operation!);
  expect(ops.attempts.find((a) => a.kind === "EDIT_COMMIT")).toMatchObject({ state: "UNKNOWN" });
  op = await driveToIdle(ctx, op!.id);
  expect(op?.phase).toBe("REVIEW_REQUIRED");
  expect(shopify.mutationCalls("MergeEditCommit")).toBe(1); // never resent
  expect(shopify.mutationCalls("MergeCancelSecondary")).toBe(0);
  expect(ops.locks.size).toBe(2);
});

// ── 29. Cancel userError: UNKNOWN, coded, never re-issued (B3) ──────────────

it("29. cancel userError: UNKNOWN attempt with its code in the summary; no second orderCancel", async () => {
  const ctx = setup();
  const { shopify, deps, ops } = ctx;
  shopify.cancelMode.set(id(2), "reject");
  const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
  const op = await driveToIdle(ctx, result.operation!);
  expect(op?.phase).toBe("REVIEW_REQUIRED");
  expect(shopify.mutationCalls("MergeCancelSecondary")).toBe(1); // never retried on a userError
  const attempt = ops.attempts.find((a) => a.kind === "ORDER_CANCEL")!;
  expect(attempt.state).toBe("UNKNOWN");
  expect(attempt.responseSummary).toContain("INTERNAL_ERROR"); // the code rides the summary
  const stored = await ops.getOperation(op!.id);
  expect(stored?.secondaries[0]?.cancelPhase).toBe("CANCEL_REVIEW");
  expect(ops.locks.size).toBe(2);
});

// ── 30. READY reads fail past the horizon → ABANDONED (B2) ──────────────────

it("30. READY reads fail past the read-failure horizon: ABANDONED, nothing dispatched", async () => {
  const ctx = setup();
  const { shopify, deps, ops } = ctx;
  const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
  expect(result.code).toBe("OPERATION_CREATED");
  shopify.on("MergeOrderState", () => topLevelError("outage"));
  const final = await driveToIdle(ctx, result.operation!);
  // READY can never have dispatched, so the horizon abandons rather than
  // reviewing (the READY→ABANDONED no-EDIT_COMMIT guard holds trivially).
  expect(final?.phase).toBe("ABANDONED");
  expect(ops.attempts).toHaveLength(0);
  expect(shopify.mutationCalls("MergeEditCommit")).toBe(0);
  expect(ops.locks.size).toBe(0);
});

// ── 31. One transient evidence read failure → recovers (B2) ─────────────────

it("31. one transient evidence read failure: stays COMMIT_IN_DOUBT, then reconciles", async () => {
  const ctx = setup();
  const { shopify, deps } = ctx;
  shopify.on("MergeOrderEvidence", (_v, call) => (call === 1 ? topLevelError() : undefined));
  const result = await executeMerge(shopify.admin, SHOP, IDS, deps);
  let op = await drive(ctx, result.operation!);
  expect(op?.phase).toBe("COMMIT_IN_DOUBT"); // read failure retries, not review
  advance(deps, 60_000);
  op = await driveToIdle(ctx, op!.id);
  expect(op?.phase).toBe("COMPLETED");
});

// ── 32. Legacy entries without source ids: multiset binding (B1) ─────────────

it("32. sourceManifestMismatch on legacy entries: (variant, qty) multiset must match", () => {
  const state = makeOrder(2);
  const entry = {
    secondaryId: id(2),
    secondaryIndex: 1,
    lines: [
      {
        sourceLineItemId: null,
        variantId: "gid://shopify/ProductVariant/1",
        quantity: 1,
        description: "x",
      },
    ],
  };
  expect(sourceManifestMismatch(entry as any, state, state.lineItems)).toBeNull();

  const resized = [makeLineItem({ quantity: 3, currentQuantity: 3, unfulfilledQuantity: 3 })];
  expect(sourceManifestMismatch(entry as any, state, resized)).not.toBeNull();
  const extra = [...state.lineItems, makeLineItem()];
  expect(sourceManifestMismatch(entry as any, state, extra)).not.toBeNull();
  expect(sourceManifestMismatch(entry as any, state, [])).not.toBeNull(); // removed
  const swapped = [makeLineItem({ variant: { id: "gid://shopify/ProductVariant/9" } })];
  expect(sourceManifestMismatch(entry as any, state, swapped)).not.toBeNull();
});
