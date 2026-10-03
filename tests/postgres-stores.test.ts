// Real-Postgres tests for the raw-SQL stores (spec §9). Opt-in:
//
//   MERGESHIP_TEST_DATABASE_URL=postgresql://postgres@localhost:54329/mergeship_test \
//     npx vitest run tests/postgres-stores.test.ts
//
// The URL must point at a DISPOSABLE database — `prisma migrate deploy` runs
// against it and the tables are truncated between tests. The database's
// session timezone is set to Asia/Tokyo (ALTER DATABASE ... SET timezone) so
// every (now() AT TIME ZONE 'UTC') discipline error would actually surface.

import { execSync } from "child_process";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prismaClaimStore, type ClaimStore } from "../app/lib/claims.server";
import { makeMergeJournal, type MergeJournal } from "../app/lib/merge-journal.server";
import {
  makeOperationStore,
  type OperationRecord,
  type OperationStore,
} from "../app/lib/operation-store.server";
import {
  prismaWorkStore,
  MAX_ATTEMPTS,
  WORK_DEADLINE_MS,
  type WorkStore,
} from "../app/lib/order-work.server";
import type { MergeDeps } from "../app/lib/merge.server";
import { driveOperation } from "../app/lib/operation-protocol.server";
import { processOrderWork } from "../app/lib/order-work-processor.server";
import { FakeShopify, makeOrder } from "./fake-shopify";
import {
  ClaimContentionError,
  DB_WALL,
  dbWallPlus,
  isTransientDbError,
  newLeaseToken,
  newOpToken,
  OwnershipLostError,
} from "../app/lib/ownership.server";

const URL = process.env.MERGESHIP_TEST_DATABASE_URL;
const SHOP = "pg-test.myshopify.com";
const oid = (n: number) => `gid://shopify/Order/${n}`;

describe.skipIf(!URL)("postgres stores (real database, Tokyo session timezone)", () => {
  let db: PrismaClient;
  let db2: PrismaClient; // second connection, for tests that hold row locks
  let claims: ClaimStore;
  let work: WorkStore;
  let journal: MergeJournal;
  let ops: OperationStore;

  beforeAll(async () => {
    execSync("npx prisma migrate deploy", {
      env: { ...process.env, DATABASE_URL: URL! },
      stdio: "pipe",
    });
    db = new PrismaClient({ datasources: { db: { url: URL } } });

    // The discipline check only means something on a non-UTC session.
    const [{ tz }] = await db.$queryRawUnsafe<{ tz: string }[]>(
      `SELECT current_setting('TimeZone') AS tz`,
    );
    expect(tz).toBe("Asia/Tokyo");

    // Exercise the LEGACY backfill statement verbatim on a pre-shaped row
    // (migrate deploy runs the whole chain, so a row cannot be inserted
    // between migrations — the UPDATE itself is applied here instead).
    await db.$executeRawUnsafe(
      `INSERT INTO "ProcessedWebhook" ("id","shop","orderId") VALUES ('legacy-1','${SHOP}','legacy-order')`,
    );
    await db.$executeRawUnsafe(
      `UPDATE "ProcessedWebhook" SET "outcome" = 'LEGACY', "doneAt" = "createdAt" WHERE "outcome" IS NULL`,
    );
    const legacy = await db.$queryRawUnsafe<any[]>(
      `SELECT "outcome", "status", "doneAt", "createdAt" FROM "ProcessedWebhook" WHERE id = 'legacy-1'`,
    );
    expect(legacy[0].outcome).toBe("LEGACY");
    expect(legacy[0].status).toBe("DONE"); // the column default keeps it inert
    expect(legacy[0].doneAt).toEqual(legacy[0].createdAt);

    claims = prismaClaimStore(db);
    work = prismaWorkStore(db);
    journal = makeMergeJournal(db);
    ops = makeOperationStore(db);
    db2 = new PrismaClient({ datasources: { db: { url: URL } } });
  }, 120_000);

  beforeEach(async () => {
    await db.$executeRawUnsafe(
      `TRUNCATE "MergeClaim", "ProcessedWebhook", "MergeOperation", "MergeOrderLock",
       "MergeMutationAttempt", "MergeRecord", "WorkerInstance" RESTART IDENTITY CASCADE`,
    );
    // The singleton kill-switch row is seeded by the migration; re-seed it
    // disabled after every truncate (tests flip it via setControl).
    await db.$executeRawUnsafe(
      `INSERT INTO "AppControl" ("id","newMergesEnabled","completionEnabled","allowShops","updatedAt")
       VALUES ('control', false, false, ARRAY[]::TEXT[], (clock_timestamp() AT TIME ZONE 'UTC'))
       ON CONFLICT (id) DO UPDATE SET "newMergesEnabled" = false, "completionEnabled" = false, "allowShops" = ARRAY[]::TEXT[]`,
    );
  });

  const claimCount = async () =>
    (await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "MergeClaim"`))[0].n;

  it("claims: acquire is all-or-nothing — a partial conflict rolls everything back", async () => {
    expect(await claims.acquire(SHOP, [oid(1)], "t1", 60_000)).toBe(true);
    // 1 is held -> the whole {1,2} acquire must fail AND leave no row for 2.
    expect(await claims.acquire(SHOP, [oid(1), oid(2)], "t2", 60_000)).toBe(false);
    expect(await claimCount()).toBe(1);
  });

  it("claims: 20 parallel acquires on the same ids — exactly one wins", async () => {
    const ids = [oid(1), oid(2), oid(3)];
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => claims.acquire(SHOP, ids, `tok-${i}`, 60_000)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await claimCount()).toBe(3);
  });

  it("claims: parallel overlapping sets {1,2} vs {2,3} — exactly one wins, nothing half-held", async () => {
    const [a, b] = await Promise.all([
      claims.acquire(SHOP, [oid(1), oid(2)], "tok-a", 60_000),
      claims.acquire(SHOP, [oid(2), oid(3)], "tok-b", 60_000),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await claimCount()).toBe(2); // only the winner's two rows
  });

  it("claims: a stale token can neither renew nor release; expiry makes the row re-acquirable", async () => {
    expect(await claims.acquire(SHOP, [oid(1)], "real", 60_000)).toBe(true);
    await expect(claims.renew(SHOP, [oid(1)], "stale", 60_000)).rejects.toBeInstanceOf(
      OwnershipLostError,
    );
    await claims.release(SHOP, [oid(1)], "stale");
    expect(await claimCount()).toBe(1); // untouched

    // Push the lease into the past: take-over works, the old token stays dead.
    await db.$executeRaw`UPDATE "MergeClaim" SET "leasedUntil" = ${dbWallPlus(-1_000)}`;
    expect(await claims.acquire(SHOP, [oid(1)], "new", 60_000)).toBe(true);
    await expect(claims.renew(SHOP, [oid(1)], "real", 60_000)).rejects.toBeInstanceOf(
      OwnershipLostError,
    );
    await claims.renew(SHOP, [oid(1)], "new", 60_000); // still owned
    await claims.release(SHOP, [oid(1)], "new");
    expect(await claimCount()).toBe(0);
  });

  it("claims: reapExpired deletes only expired claims", async () => {
    await claims.acquire(SHOP, [oid(1)], "a", 60_000);
    await claims.acquire(SHOP, [oid(2)], "b", 60_000);
    await db.$executeRaw`UPDATE "MergeClaim" SET "leasedUntil" = ${dbWallPlus(-1_000)} WHERE "orderId" = ${oid(1)}`;
    expect(await claims.reapExpired()).toBe(1);
    expect(await claimCount()).toBe(1);
  });

  /** Inserts a work item whose lease is already expired, so claimDue can see it. */
  const insertDue = async (orderId: string, retryAfterPast = true) => {
    const item = await work.insertLeased(SHOP, orderId, `seed-${orderId}`, -1_000, WORK_DEADLINE_MS);
    if (!retryAfterPast) {
      await db.$executeRaw`UPDATE "ProcessedWebhook" SET "retryAfter" = ${dbWallPlus(3_600_000)} WHERE id = ${item!.id}`;
    }
    return item!;
  };

  it("work: claimDue leases due items — parallel claimants get disjoint sets with distinct tokens", async () => {
    for (const n of [1, 2, 3, 4, 5]) await insertDue(oid(n));
    await insertDue(oid(6), false); // not yet due
    await work.insertLeased(SHOP, oid(7), "live", 60_000, WORK_DEADLINE_MS); // live lease

    const [a, b] = await Promise.all([work.claimDue(3, 60_000), work.claimDue(3, 60_000)]);
    const all = [...a, ...b];
    expect(all).toHaveLength(5);
    expect(new Set(all.map((i) => i.id)).size).toBe(5); // disjoint
    expect(new Set(all.map((i) => i.leaseToken)).size).toBe(5); // own token each
    expect(all.every((i) => i.attempts === 2)).toBe(true); // insert=1, claim=2
    expect(all.map((i) => i.orderId)).not.toContain(oid(6));
    expect(all.map((i) => i.orderId)).not.toContain(oid(7));
  });

  it("work: renew/markDone/scheduleRetry honour the token; stale writers change nothing", async () => {
    const item = (await work.insertLeased(SHOP, oid(1), "real", 60_000, WORK_DEADLINE_MS))!;
    expect(item.status).toBe("PENDING");
    expect(item.retryAfter).not.toBeNull();

    await expect(work.renew(item.id, "stale", 60_000)).rejects.toBeInstanceOf(OwnershipLostError);
    expect(await work.markDone(item.id, "stale", "MERGED", "x")).toBe(false);
    expect(await work.scheduleRetry(item.id, "stale", 1_000, "x")).toBe(false);
    const untouched = await work.find(SHOP, oid(1));
    expect(untouched).toMatchObject({ status: "PENDING", outcome: null, leaseToken: "real" });

    expect(await work.scheduleRetry(item.id, "real", 60_000, "later")).toBe(true);
    const scheduled = await work.find(SHOP, oid(1));
    expect(scheduled!.leaseToken).toBeNull(); // lease cleared, retryable later
    expect(scheduled!.lastReason).toBe("later");
    expect(scheduled!.retryAfter!.getTime()).toBeGreaterThan(Date.now());

    // Re-claim it (retryAfter is in the future, so move it back) and finish it.
    await db.$executeRaw`UPDATE "ProcessedWebhook" SET "retryAfter" = ${DB_WALL} WHERE id = ${item.id}`;
    const [claimed] = await work.claimDue(3, 60_000);
    expect(claimed.id).toBe(item.id);
    expect(claimed.attempts).toBe(2);
    await work.renew(claimed.id, claimed.leaseToken!, 60_000);
    expect(await work.markDone(claimed.id, claimed.leaseToken!, "MERGED", "done")).toBe(true);
    const done = await work.find(SHOP, oid(1));
    expect(done).toMatchObject({ status: "DONE", outcome: "MERGED", doneAt: expect.any(Date) });

    // purgeDone: an aged DONE row is deleted (doneAt back-dated via SQL).
    await db.$executeRaw`UPDATE "ProcessedWebhook" SET "doneAt" = ${dbWallPlus(-31 * 24 * 60 * 60 * 1000)} WHERE id = ${item.id}`;
    expect(await work.purgeDone(30 * 24 * 60 * 60 * 1000)).toBe(1);
    expect(await work.find(SHOP, oid(1))).toBeNull();
  });

  it("work: a fresh insertLeased row is NOT considered expired under the Tokyo session", async () => {
    const item = (await work.insertLeased(SHOP, oid(1), "tok", 60_000, WORK_DEADLINE_MS))!;
    // renew() is conditional on leasedUntil >= (now() AT TIME ZONE 'UTC') — it
    // throws if the lease reads as expired, so reaching here proves discipline.
    await work.renew(item.id, "tok", 60_000);
    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "ProcessedWebhook"
       WHERE id = '${item.id}' AND "leasedUntil" >= (now() AT TIME ZONE 'UTC')`,
    );
    expect(n).toBe(1);
  });

  it("journal: op lease — acquire once, stale writes throw, expired lease re-acquirable", async () => {
    const op = await journal.create(
      {
        shop: SHOP,
        status: "PENDING_COMMIT",
        primaryOrderId: oid(1),
        primaryOrderName: "#1",
        customerId: null,
        primaryLineItemCountBefore: 1,
        addedLineItemCount: 1,
        secondaries: [{ id: oid(2), name: "#2", items: 1, done: false }],
        involvedOrderIds: [oid(1), oid(2)],
      },
      "t1",
      60_000,
    );
    expect(op.leaseToken).toBe("t1");

    expect(await journal.acquireLease(op.id, "t2", 60_000)).toBeNull(); // live lease
    await expect(
      journal.update({ id: op.id, leaseToken: "stale" }, { status: "COMPLETED" }),
    ).rejects.toBeInstanceOf(OwnershipLostError);

    await journal.renew(op, 60_000);
    await journal.update(op, { status: "COMMITTED", lastError: null });
    expect((await journal.findBlockingOrderStatuses(SHOP)).get(oid(1))).toBe("COMMITTED");
    expect(await journal.findShopsWithUnfinished()).toEqual([SHOP]);

    // Expire the lease: a new worker takes over; the old token stays dead.
    await db.$executeRaw`UPDATE "MergeOperation" SET "leasedUntil" = ${dbWallPlus(-1_000)} WHERE id = ${op.id}`;
    const leased = await journal.acquireLease(op.id, newLeaseToken(), 60_000);
    expect(leased).not.toBeNull();
    expect(leased!.leaseToken).not.toBe("t1");
    await expect(journal.update(op, { status: "ABANDONED" })).rejects.toBeInstanceOf(
      OwnershipLostError,
    );
    await journal.update(leased!, { status: "COMPLETED" });
    // COMPLETED is no longer unfinished or blocking.
    expect(await journal.findShopsWithUnfinished()).toEqual([]);
    expect((await journal.findBlockingOrderStatuses(SHOP)).has(oid(1))).toBe(false);
  });

  // ── Protocol v2 (spec §3/§12) ─────────────────────────────────────────────

  /** Claims `orderIds` and creates a v2 op over them (locks included). The
   *  control row is re-seeded OFF per test, so creation must switch it on —
   *  AppControl is the durable kill-switch gate inside createOperation. */
  const createOp = async (
    orderIds: string[],
    opts: Partial<Parameters<OperationStore["createOperation"]>[0]> = {},
  ): Promise<OperationRecord> => {
    await ops.setControl({ newMergesEnabled: true, completionEnabled: true, allowShops: [] });
    const claimToken = newLeaseToken();
    expect(await claims.acquire(SHOP, orderIds, claimToken, 120_000)).toBe(true);
    return ops.createOperation({
      shop: SHOP,
      claimToken,
      involvedOrderIds: orderIds,
      primaryOrderId: orderIds[0],
      primaryOrderName: `#${orderIds[0].split("/").pop()}`,
      customerId: null,
      primaryLineItemCountBefore: 1,
      addedLineItemCount: 1,
      secondaries: orderIds.slice(1).map((id) => ({
        id,
        name: `#${id.split("/").pop()}`,
        items: 1,
        cancelPhase: "TRANSFER_PENDING" as const,
      })),
      opToken: newOpToken(),
      calculatedOrderId: "gid://shopify/CalculatedOrder/1",
      expectedTransfer: [],
      expectedLocationId: null,
      primaryLineItemIdsBefore: ["gid://shopify/LineItem/1"],
      leaseToken: newLeaseToken(),
      ttlMs: 120_000,
      ...opts,
    });
  };

  const lockCount = async () =>
    (await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "MergeOrderLock"`))[0].n;
  const opCount = async () =>
    (await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "MergeOperation" WHERE "protocolVersion" = 2`,
    ))[0].n;
  const attemptCount = async () =>
    (await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "MergeMutationAttempt"`,
    ))[0].n;
  const freshOp = async (id: string): Promise<OperationRecord> =>
    (await db.$queryRawUnsafe<any[]>(`SELECT * FROM "MergeOperation" WHERE id = '${id}'`))[0];
  const expireOpLease = (id: string) =>
    db.$executeRaw`UPDATE "MergeOperation" SET "leasedUntil" = ${dbWallPlus(-1_000)} WHERE id = ${id}`;

  it("v2 createOperation: builds READY op + durable locks; claim takeover rolls everything back", async () => {
    const op = await createOp([oid(1), oid(2)]);
    expect(op).toMatchObject({
      protocolVersion: 2,
      phase: "READY",
      status: "NEEDS_REVIEW", // legacy shield while non-terminal
      leaseToken: expect.any(String),
    });
    expect(new Date(op.leasedUntil!).getTime()).toBeGreaterThan(Date.now());
    expect(await lockCount()).toBe(2);
    expect(await ops.findLockedOrderIds(SHOP, [oid(1), oid(2), oid(9)])).toEqual(
      new Set([oid(1), oid(2)]),
    );

    // Claim takeover: expire + reacquire claims with a new token, then create
    // with the STALE token — nothing persists (no op row, no locks).
    await db.$executeRaw`UPDATE "MergeClaim" SET "leasedUntil" = ${dbWallPlus(-1_000)}`;
    const tokB = newLeaseToken();
    expect(await claims.acquire(SHOP, [oid(1), oid(2)], tokB, 120_000)).toBe(true);
    const opBefore = await opCount();
    const locksBefore = await lockCount();
    await expect(
      ops.createOperation({
        shop: SHOP,
        claimToken: "stale-token",
        involvedOrderIds: [oid(1), oid(2)],
        primaryOrderId: oid(1),
        primaryOrderName: "#1",
        customerId: null,
        primaryLineItemCountBefore: 1,
        addedLineItemCount: 1,
        secondaries: [{ id: oid(2), name: "#2", items: 1, cancelPhase: "TRANSFER_PENDING" }],
        opToken: newOpToken(),
        calculatedOrderId: null,
        expectedTransfer: [],
        expectedLocationId: null,
        primaryLineItemIdsBefore: [],
        leaseToken: newLeaseToken(),
        ttlMs: 120_000,
      }),
    ).rejects.toBeInstanceOf(OwnershipLostError);
    expect(await opCount()).toBe(opBefore);
    expect(await lockCount()).toBe(locksBefore);
  });

  it("v2 createOperation: overlapping lock sets — exactly one op wins", async () => {
    // Claims are unique per (shop, order), so two live claim tokens can never
    // cover an overlapping set — the second caller loses at the claim check
    // (OwnershipLostError). Holding a lock also blocks a caller whose claims
    // were honestly acquired after the first op's claims expired.
    const opA = await createOp([oid(1), oid(2)]);
    expect(opA.phase).toBe("READY");

    // Caller B legitimately holds {2,3}'s claims now (claims are expired
    // leases, replaceable) — but the durable lock on order 2 still blocks.
    await db.$executeRaw`UPDATE "MergeClaim" SET "leasedUntil" = ${dbWallPlus(-1_000)} WHERE "orderId" = ${oid(2)}`;
    const tokB = newLeaseToken();
    await claims.acquire(SHOP, [oid(2)], tokB, 120_000);
    await claims.acquire(SHOP, [oid(3)], tokB, 120_000);
    await expect(
      ops.createOperation({
        shop: SHOP,
        claimToken: tokB,
        involvedOrderIds: [oid(2), oid(3)],
        primaryOrderId: oid(2),
        primaryOrderName: "#2",
        customerId: null,
        primaryLineItemCountBefore: 1,
        addedLineItemCount: 1,
        secondaries: [{ id: oid(3), name: "#3", items: 1, cancelPhase: "TRANSFER_PENDING" }],
        opToken: newOpToken(),
        calculatedOrderId: null,
        expectedTransfer: [],
        expectedLocationId: null,
        primaryLineItemIdsBefore: [],
        leaseToken: newLeaseToken(),
        ttlMs: 120_000,
      }),
    ).rejects.toBeInstanceOf(ClaimContentionError);
    expect(await opCount()).toBe(1);
    expect(await lockCount()).toBe(2); // only op A's {1,2}
  });

  it("v2 acquireOperationLease: SKIP LOCKED — 10 parallel claimers on 3 due ops, each claimed once", async () => {
    const a = await createOp([oid(1), oid(2)]);
    const b = await createOp([oid(3), oid(4)]);
    const c = await createOp([oid(5), oid(6)]);
    // All three are due (nextCheckAt = DB_WALL) but still lease-held by their
    // creators — expire so the claimers can take over.
    for (const op of [a, b, c]) await expireOpLease(op.id);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        ops.acquireOperationLease(undefined, `claimer-${i}`, 120_000),
      ),
    );
    const won = results.filter(Boolean) as OperationRecord[];
    expect(won).toHaveLength(3);
    expect(new Set(won.map((o) => o.id)).size).toBe(3); // each op claimed once
    expect(new Set(won.map((o) => o.leaseToken)).size).toBe(3); // distinct tokens
    expect(won.map((o) => o.id).sort()).toEqual([a.id, b.id, c.id].sort());
    // A specific-op lease works too, once its lease is free again.
    await expireOpLease(a.id);
    const re = await ops.acquireOperationLease(a.id, newLeaseToken(), 120_000);
    expect(re?.id).toBe(a.id);
    // A completed op is never leased.
    await ops.transition(re!, { phase: "COMPLETED", expectedPhase: "READY" });
    expect(await ops.acquireOperationLease(a.id, newLeaseToken(), 120_000)).toBeNull();
    expect(await lockCount()).toBe(4); // a's locks released on COMPLETED
  });

  it("v2 transition: stale owner affects 0 rows even after waiting on a row lock", async () => {
    // Holder (db2): expires the lease and holds the row lock for ~1s (under
    // the 2s lock_timeout). The stale owner's SELECT … FOR UPDATE waits on
    // the lock, then the guarded UPDATE sees the COMMITTED expired row => 0
    // rows => OwnershipLostError. (EvalPlanQual over the changed row.)
    const op = await createOp([oid(1), oid(2)]);
    const holder = db2.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          UPDATE "MergeOperation" SET "leasedUntil" = ${dbWallPlus(-5_000)} WHERE "id" = ${op.id}`;
        await tx.$queryRawUnsafe(`SELECT 1 FROM pg_sleep(1)`);
      },
      { timeout: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 500)); // let the holder take the lock

    // The op's own lease token is still "live" per the old row, but the new
    // owner is whoever re-leases after expiry — simulate a takeover first by
    // letting the holder commit, then re-leasing.
    await expect(ops.renewOperation(op, 60_000)).rejects.toBeInstanceOf(OwnershipLostError);
    await holder;

    const taken = await ops.acquireOperationLease(op.id, "new-owner", 120_000);
    expect(taken).not.toBeNull();
    await expect(ops.renewOperation(op, 60_000)).rejects.toBeInstanceOf(OwnershipLostError);
    await ops.renewOperation(taken!, 60_000); // the new owner renews fine
  });

  it("v2 transition: terminal phases release locks and settle/requeue the work item", async () => {
    const item = (await work.insertLeased(SHOP, oid(1), "work-tok", 120_000, WORK_DEADLINE_MS))!;
    const op = await createOp([oid(1), oid(2)], {
      workItemId: item.id,
      workToken: "work-tok",
    });
    const linked = await work.find(SHOP, oid(1));
    expect(linked).toMatchObject({ status: "DONE", outcome: "OPERATION_CREATED", operationId: op.id });

    // REVIEW_REQUIRED keeps locks but settles the work item.
    await ops.transition(op, {
      phase: "REVIEW_REQUIRED",
      expectedPhase: "READY",
      reviewReason: "anomaly",
      nextCheckAt: 24 * 60 * 60 * 1000,
    });
    const reviewed = await freshOp(op.id);
    expect(reviewed.phase).toBe("REVIEW_REQUIRED");
    expect(reviewed.reviewRequiredAt).not.toBeNull();
    expect(await lockCount()).toBe(2); // locks stay for reviewed ops
    expect((await work.find(SHOP, oid(1)))!.outcome).toBe("OPERATION_REVIEW");

    // ABANDONED releases locks and requeues the work item.
    const item2 = (await work.insertLeased(SHOP, oid(3), "w2", 120_000, WORK_DEADLINE_MS))!;
    const op2 = await createOp([oid(3), oid(4)], { workItemId: item2.id, workToken: "w2" });
    await ops.transition(op2, {
      phase: "ABANDONED",
      expectedPhase: "READY",
      lastError: "merchant edited the order",
    });
    expect(await lockCount()).toBe(2); // only op A's locks remain
    const requeued = await work.find(SHOP, oid(3));
    expect(requeued).toMatchObject({
      status: "PENDING",
      outcome: null,
      lastReason: "merchant edited the order",
      leaseToken: null,
    });
    const op2After = await freshOp(op2.id);
    expect(op2After.phase).toBe("ABANDONED");
    expect(op2After.status).toBe("ABANDONED"); // terminal shield value
  });

  it("v2 dispatch gate: env off refuses before SQL; one EDIT_COMMIT ever; cancel guards", async () => {
    const saved = process.env.MERGESHIP_MUTATIONS;
    try {
      const op = await createOp([oid(1), oid(2)]);
      await ops.setControl({ newMergesEnabled: true, completionEnabled: true });
      const gate = (kind: any, target: string, phase: any) =>
        ops.openDispatchGate({
          op,
          kind,
          targetOrderId: target,
          dispatchToken: `dt-${crypto.randomUUID()}`,
          requiredPhase: phase,
        });

      // Env flag off => refused in code before touching the database.
      delete process.env.MERGESHIP_MUTATIONS;
      expect(await gate("EDIT_COMMIT", oid(1), "READY")).toBeNull();
      expect(await attemptCount()).toBe(0);

      process.env.MERGESHIP_MUTATIONS = "enabled";
      const attempt = await gate("EDIT_COMMIT", oid(1), "READY");
      expect(attempt).toMatchObject({ kind: "EDIT_COMMIT", state: "DISPATCHING", attemptNo: 1 });
      expect((await freshOp(op.id)).phase).toBe("COMMIT_IN_DOUBT");
      expect((await freshOp(op.id)).firstDispatchAt).not.toBeNull();

      // A second EDIT_COMMIT for the op is refused even if the phase is reset.
      await db.$executeRaw`UPDATE "MergeOperation" SET "phase" = 'READY' WHERE id = ${op.id}`;
      expect(await gate("EDIT_COMMIT", oid(1), "READY")).toBeNull();
      expect(await attemptCount()).toBe(1);

      // ORDER_CANCEL: one in-doubt attempt per secondary, ever.
      await db.$executeRaw`UPDATE "MergeOperation" SET "phase" = 'APPLIED' WHERE id = ${op.id}`;
      const cancel = await gate("ORDER_CANCEL", oid(2), "APPLIED");
      expect(cancel?.kind).toBe("ORDER_CANCEL");
      expect(await gate("ORDER_CANCEL", oid(2), "APPLIED")).toBeNull(); // DISPATCHING blocks
      expect(await ops.recordAttempt(cancel!.id, "wrong-token", "SUCCEEDED", "nope")).toBe(false);
      expect(await ops.recordAttempt(cancel!.id, cancel!.dispatchToken, "SUCCEEDED", "ok", "job-1")).toBe(true);
      expect(await gate("ORDER_CANCEL", oid(2), "APPLIED")).toBeNull(); // SUCCEEDED blocks too

      // A second cancel is possible only after the first is REJECTED, and
      // never after three rejections.
      const opB = await createOp([oid(3), oid(4)]);
      await db.$executeRaw`UPDATE "MergeOperation" SET "phase" = 'APPLIED' WHERE id = ${opB.id}`;
      for (let i = 0; i < 3; i++) {
        const a = await ops.openDispatchGate({
          op: opB,
          kind: "ORDER_CANCEL",
          targetOrderId: oid(4),
          dispatchToken: `dtB-${i}`,
          requiredPhase: "APPLIED",
        });
        expect(a).not.toBeNull();
        expect(await ops.recordAttempt(a!.id, a!.dispatchToken, "REJECTED", `rej-${i}`)).toBe(true);
      }
      expect(
        await ops.openDispatchGate({
          op: opB,
          kind: "ORDER_CANCEL",
          targetOrderId: oid(4),
          dispatchToken: "dtB-4",
          requiredPhase: "APPLIED",
        }),
      ).toBeNull(); // 3 REJECTED => gate stays shut

      const cancels = await ops.listAttempts(opB.id, "ORDER_CANCEL", oid(4));
      expect(cancels).toHaveLength(3);
      expect(cancels.map((a) => a.attemptNo)).toEqual([1, 2, 3]);
    } finally {
      if (saved === undefined) delete process.env.MERGESHIP_MUTATIONS;
      else process.env.MERGESHIP_MUTATIONS = saved;
    }
  });

  it("v2 dispatch gate vs setControl race: phase flip and attempt insert are atomic", async () => {
    const saved = process.env.MERGESHIP_MUTATIONS;
    process.env.MERGESHIP_MUTATIONS = "enabled";
    try {
      for (let i = 0; i < 20; i++) {
        const op = await createOp([oid(10 + i), oid(100 + i)]);
        const flip = ops.setControl({ newMergesEnabled: i % 2 === 0 });
        const gate = ops.openDispatchGate({
          op,
          kind: "EDIT_COMMIT",
          targetOrderId: oid(10 + i),
          dispatchToken: `race-${i}`,
          requiredPhase: "READY",
        });
        const [attempt] = await Promise.all([gate, flip]);
        const fresh = await freshOp(op.id);
        const attempts = await ops.listAttempts(op.id, "EDIT_COMMIT");
        // Either the gate saw the switch on (attempt + COMMIT_IN_DOUBT) or off
        // (nothing at all) — never a phase change without an attempt row.
        if (attempt) {
          expect(attempts).toHaveLength(1);
          expect(fresh.phase).toBe("COMMIT_IN_DOUBT");
        } else {
          expect(attempts).toHaveLength(0);
          expect(fresh.phase).toBe("READY");
        }
      }
    } finally {
      if (saved === undefined) delete process.env.MERGESHIP_MUTATIONS;
      else process.env.MERGESHIP_MUTATIONS = saved;
    }
  });

  it("v2 isEnabled/getControl read the control row; allowShops scopes it", async () => {
    expect(await ops.isEnabled(SHOP, "newMergesEnabled")).toBe(false);
    await ops.setControl({ newMergesEnabled: true, allowShops: ["other.myshopify.com"] });
    expect(await ops.isEnabled(SHOP, "newMergesEnabled")).toBe(false); // not in allow list
    await ops.setControl({ allowShops: [] });
    expect(await ops.isEnabled(SHOP, "newMergesEnabled")).toBe(true);
    const control = await ops.getControl();
    expect(control).toMatchObject({ id: "control", newMergesEnabled: true });
  });

  it("v2 recordHistoryAndVerifyCancel: stale op token writes no history", async () => {
    const op = await createOp([oid(1), oid(2)]);
    await ops.transition(op, { phase: "APPLIED", expectedPhase: "READY" });
    const applied = await freshOp(op.id);

    // Takeover: stale record must not update secondaries or insert history.
    await expireOpLease(op.id);
    const owned = await ops.acquireOperationLease(op.id, newLeaseToken(), 120_000);
    await expect(
      ops.recordHistoryAndVerifyCancel(applied, oid(2), { cancelledAt: new Date().toISOString() }),
    ).rejects.toBeInstanceOf(OwnershipLostError);
    const records = await db.$queryRawUnsafe<any[]>(`SELECT * FROM "MergeRecord"`);
    expect(records).toHaveLength(0);
    const row = await freshOp(op.id);
    expect((row.secondaries as any[])[0].cancelPhase).toBe("TRANSFER_PENDING");

    // The live owner verifies: secondary marked + MergeRecord written.
    await ops.recordHistoryAndVerifyCancel(
      { ...applied, leaseToken: owned!.leaseToken },
      oid(2),
      { cancelledAt: "2026-10-04T00:00:00Z" },
    );
    const recs = await db.$queryRawUnsafe<any[]>(`SELECT * FROM "MergeRecord"`);
    expect(recs).toHaveLength(1);
    expect(recs[0].mergedOrderId).toBe(oid(2));
    expect(recs[0].operationId).toBe(op.id);
    const done = await freshOp(op.id);
    expect((done.secondaries as any[])[0].cancelPhase).toBe("CANCEL_VERIFIED");
  });

  it("v2 lock_timeout: an ownership tx waits ~2s, classifies transient, changes nothing", async () => {
    // Holder (db2) takes the order-1 claim row lock and sleeps 4s.
    const claimTok = newLeaseToken();
    expect(await claims.acquire(SHOP, [oid(1), oid(2)], claimTok, 120_000)).toBe(true);
    const holder = db2.$transaction(
      async (tx) => {
        await tx.$executeRaw`UPDATE "MergeClaim" SET "leasedUntil" = "leasedUntil" WHERE "orderId" = ${oid(1)}`;
        await tx.$queryRawUnsafe(`SELECT 1 FROM pg_sleep(4)`);
      },
      { timeout: 15_000 },
    );
    await new Promise((r) => setTimeout(r, 500)); // holder holds the row lock

    const start = Date.now();
    let thrown: unknown = null;
    try {
      // The kill switch must be on so the create reaches the claim-row lock.
      await ops.setControl({ newMergesEnabled: true });
      await ops.createOperation({
        shop: SHOP,
        claimToken: claimTok,
        involvedOrderIds: [oid(1), oid(2)],
        primaryOrderId: oid(1),
        primaryOrderName: "#1",
        customerId: null,
        primaryLineItemCountBefore: 1,
        addedLineItemCount: 1,
        secondaries: [{ id: oid(2), name: "#2", items: 1, cancelPhase: "TRANSFER_PENDING" }],
        opToken: newOpToken(),
        calculatedOrderId: null,
        expectedTransfer: [],
        expectedLocationId: null,
        primaryLineItemIdsBefore: [],
        leaseToken: newLeaseToken(),
        ttlMs: 120_000,
      });
    } catch (e) {
      thrown = e;
    }
    const elapsed = Date.now() - start;
    expect(thrown).toBeTruthy();
    expect(isTransientDbError(thrown)).toBe(true); // 55P03 lock_timeout
    expect(elapsed).toBeLessThan(3_500); // ~2s lock_timeout, not the full 4s sleep
    expect(await opCount()).toBe(0);
    expect(await lockCount()).toBe(0);
    await holder; // let the holder finish cleanly
  });

  it("v2 work store: exhaustDue converts expired/unowned items, leaves live leases alone", async () => {
    const expired = (await work.insertLeased(SHOP, oid(1), "t1", -1_000, WORK_DEADLINE_MS))!;
    const live = (await work.insertLeased(SHOP, oid(2), "t2", 120_000, WORK_DEADLINE_MS))!;
    await work.insertLeased(SHOP, oid(3), "t3", -1_000, WORK_DEADLINE_MS); // young: under both limits
    await db.$executeRaw`UPDATE "ProcessedWebhook" SET "attempts" = ${MAX_ATTEMPTS} WHERE id IN (${expired.id}, ${live.id})`;
    // 'young' stays under the limit but past deadline? give it a live deadline —
    // it should NOT be converted.
    expect(await work.exhaustDue()).toBe(1); // only 'expired' (attempts + no lease)
    const rows = await Promise.all([1, 2, 3].map((n) => work.find(SHOP, oid(n))));
    expect(rows[0]).toMatchObject({ status: "REVIEW", outcome: "EXHAUSTED" });
    expect(rows[0]!.reviewReason).toBeTruthy();
    expect(rows[1]!.status).toBe("PENDING"); // live lease protects it
    expect(rows[2]!.status).toBe("PENDING");

    // Deadline exhaustion too.
    await db.$executeRaw`UPDATE "ProcessedWebhook" SET "deadlineAt" = ${dbWallPlus(-1_000)} WHERE id = ${live.id}`;
    await db.$executeRaw`UPDATE "ProcessedWebhook" SET "leasedUntil" = ${dbWallPlus(-1_000)} WHERE id = ${live.id}`;
    expect(await work.exhaustDue()).toBe(1);
    expect((await work.find(SHOP, oid(2)))!.status).toBe("REVIEW");
  });

  it("v2 work store: claimDue(1) parallel — disjoint, each item claimed once", async () => {
    for (const n of [1, 2, 3, 4, 5]) {
      await work.insertLeased(SHOP, oid(n), `seed-${n}`, -1_000, WORK_DEADLINE_MS);
    }
    const results = await Promise.all(
      Array.from({ length: 10 }, () => work.claimDue(1, 60_000)),
    );
    const claimed = results.flat();
    expect(claimed).toHaveLength(5);
    expect(new Set(claimed.map((i) => i.id)).size).toBe(5);
    expect(new Set(claimed.map((i) => i.leaseToken)).size).toBe(5);
  });

  it("v2 work store: linkOperation/requeue/settle CAS chain", async () => {
    const item = (await work.insertLeased(SHOP, oid(1), "tok", 120_000, WORK_DEADLINE_MS))!;
    // Stale token cannot link.
    expect(await work.linkOperation(item.id, "stale", "op-x")).toBe(false);
    expect(await work.linkOperation(item.id, "tok", "op-x")).toBe(true);
    const linked = await work.find(SHOP, oid(1));
    expect(linked).toMatchObject({ status: "DONE", outcome: "OPERATION_CREATED", operationId: "op-x" });

    // Wrong operationId cannot touch it.
    expect(await work.requeueFromOperation(item.id, "op-y", "x")).toBe(false);
    expect(await work.settleFromOperation(item.id, "op-y", "MERGED")).toBe(false);

    expect(await work.requeueFromOperation(item.id, "op-x", "abandoned")).toBe(true);
    expect((await work.find(SHOP, oid(1)))!).toMatchObject({ status: "PENDING", outcome: null });

    // Re-link and settle as MERGED.
    await db.$executeRaw`UPDATE "ProcessedWebhook" SET "leaseToken"='tok2', "leasedUntil"=${dbWallPlus(60_000)} WHERE id=${item.id}`;
    await work.linkOperation(item.id, "tok2", "op-z");
    expect(await work.settleFromOperation(item.id, "op-z", "MERGED")).toBe(true);
    expect((await work.find(SHOP, oid(1)))!.outcome).toBe("MERGED");
  });

  it("v2 journal: findBlockingV1 sees only v1 blocking ops; v2 ops are covered by locks", async () => {
    // v1 blocking op (protocolVersion default 1).
    await journal.create(
      {
        shop: SHOP,
        status: "PENDING_COMMIT",
        primaryOrderId: oid(9),
        primaryOrderName: "#9",
        customerId: null,
        primaryLineItemCountBefore: 1,
        addedLineItemCount: 1,
        secondaries: [{ id: oid(8), name: "#8", items: 1, done: false }],
        involvedOrderIds: [oid(8), oid(9)],
      },
      "v1tok",
      60_000,
    );
    await createOp([oid(1), oid(2)]); // v2 — must NOT appear in findBlockingV1
    expect(await ops.findBlockingV1(SHOP, [oid(1), oid(8), oid(9), oid(7)])).toEqual(
      new Set([oid(8), oid(9)]),
    );
  });

  it("v2 worker instances: heartbeat upserts, listRecent returns it, purgeOld removes it", async () => {
    await ops.heartbeat("inst-1", "deploy-1", "v1");
    let rows = await ops.listRecentInstances();
    expect(rows.map((r: any) => r.instanceId)).toContain("inst-1");
    await ops.heartbeat("inst-1", "deploy-2", "v2"); // upsert, not a second row
    rows = await ops.listRecentInstances();
    expect(rows.filter((r: any) => r.instanceId === "inst-1")).toHaveLength(1);
    expect(await ops.purgeOldInstances(-1_000)).toBe(1); // heartbeat is < now + 1s
    expect(await ops.listRecentInstances()).toHaveLength(0);
  });

  // ── A1: a lock held on an UNCHANGED row past lease expiry ────────────────
  // A conditional UPDATE evaluates its WHERE first, then waits on the row
  // lock; if the locker committed no change PostgreSQL does not re-evaluate
  // the predicate, so a write that started while the lease was still valid
  // would land after expiry. The store must therefore force the wait into a
  // SELECT ... FOR UPDATE and evaluate only while holding the row lock.
  // Every test here holds the row on db2 WITHOUT changing it, blocks the
  // ownership write on db, lets the lease expire, then releases — the write
  // must reject OwnershipLostError and leave leasedUntil in the past.

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("v2 renewOperation: unchanged-row lock held past lease expiry still refuses the write", async () => {
    const op = await createOp([oid(1), oid(2)]);
    await db.$executeRaw`UPDATE "MergeOperation" SET "leasedUntil" = ${dbWallPlus(800)} WHERE id = ${op.id}`;

    let release!: () => void;
    const holder = db2.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "MergeOperation" WHERE id = ${op.id} FOR UPDATE`;
        await new Promise<void>((r) => (release = r));
      },
      { timeout: 15_000 },
    );
    await sleep(500); // holder owns the row lock, row unchanged

    let thrown: unknown = null;
    const write = ops.renewOperation(op, 60_000).catch((e) => (thrown = e));
    await sleep(1_200); // the lease expires while the write waits
    release();
    await write;
    await holder;

    expect(thrown).toBeInstanceOf(OwnershipLostError);
    expect(new Date((await freshOp(op.id)).leasedUntil!).getTime()).toBeLessThan(Date.now());
  });

  it("v2 transition (non-terminal patch): unchanged-row lock held past expiry still refuses the write", async () => {
    const op = await createOp([oid(1), oid(2)]);
    await db.$executeRaw`UPDATE "MergeOperation" SET "leasedUntil" = ${dbWallPlus(800)} WHERE id = ${op.id}`;

    let release!: () => void;
    const holder = db2.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "MergeOperation" WHERE id = ${op.id} FOR UPDATE`;
        await new Promise<void>((r) => (release = r));
      },
      { timeout: 15_000 },
    );
    await sleep(500);

    let thrown: unknown = null;
    const write = ops.transition(op, { nextCheckAt: 60_000 }).catch((e) => (thrown = e));
    await sleep(1_200);
    release();
    await write;
    await holder;

    expect(thrown).toBeInstanceOf(OwnershipLostError);
    const row = await freshOp(op.id);
    expect(new Date(row.leasedUntil!).getTime()).toBeLessThan(Date.now());
    expect(row.nextCheckAt).not.toBeNull(); // no stale patch landed
  });

  it("v2 work.renew: unchanged-row lock held past lease expiry still refuses the write", async () => {
    const item = (await work.insertLeased(SHOP, oid(1), "tok", 800, WORK_DEADLINE_MS))!;

    let release!: () => void;
    const holder = db2.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ProcessedWebhook" WHERE id = ${item.id} FOR UPDATE`;
        await new Promise<void>((r) => (release = r));
      },
      { timeout: 15_000 },
    );
    await sleep(500);

    let thrown: unknown = null;
    const write = work.renew(item.id, "tok", 60_000).catch((e) => (thrown = e));
    await sleep(1_200);
    release();
    await write;
    await holder;

    expect(thrown).toBeInstanceOf(OwnershipLostError);
    const row = (await work.find(SHOP, oid(1)))!;
    expect(new Date(row.leasedUntil!).getTime()).toBeLessThan(Date.now());
    expect(row.leaseToken).toBe("tok");
  });

  it("v2 claims.renew: unchanged-row lock held past lease expiry still refuses the write", async () => {
    expect(await claims.acquire(SHOP, [oid(1)], "tok", 800)).toBe(true);

    let release!: () => void;
    const holder = db2.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "orderId" FROM "MergeClaim" WHERE "orderId" = ${oid(1)} FOR UPDATE`;
        await new Promise<void>((r) => (release = r));
      },
      { timeout: 15_000 },
    );
    await sleep(500);

    let thrown: unknown = null;
    const write = claims.renew(SHOP, [oid(1)], "tok", 60_000).catch((e) => (thrown = e));
    await sleep(1_200);
    release();
    await write;
    await holder;

    expect(thrown).toBeInstanceOf(OwnershipLostError);
    const [row] = await db.$queryRawUnsafe<{ leasedUntil: string }[]>(
      `SELECT "leasedUntil" FROM "MergeClaim" WHERE "orderId" = '${oid(1)}'`,
    );
    expect(new Date(row.leasedUntil!).getTime()).toBeLessThan(Date.now());
    // The expired claim is now re-acquirable — the stale renew did not resurrect it.
    expect(await claims.acquire(SHOP, [oid(1)], "new", 60_000)).toBe(true);
  });

  it("v2 transition READY→ABANDONED refuses while an EDIT_COMMIT attempt exists", async () => {
    const saved = process.env.MERGESHIP_MUTATIONS;
    process.env.MERGESHIP_MUTATIONS = "enabled";
    try {
      const op = await createOp([oid(1), oid(2)]);
      const attempt = await ops.openDispatchGate({
        op,
        kind: "EDIT_COMMIT",
        targetOrderId: oid(1),
        dispatchToken: newLeaseToken(),
        requiredPhase: "READY",
      });
      expect(attempt).not.toBeNull(); // phase flipped to COMMIT_IN_DOUBT
      // The pathological state the guard exists for: a commit attempt row is
      // on the books while the phase reads READY again.
      await db.$executeRaw`UPDATE "MergeOperation" SET "phase" = 'READY' WHERE id = ${op.id}`;

      await expect(
        ops.transition(op, { phase: "ABANDONED", expectedPhase: "READY", lastError: "give up" }),
      ).rejects.toBeInstanceOf(OwnershipLostError);
      expect(await attemptCount()).toBe(1); // no new attempt was written
      const row = await freshOp(op.id);
      expect(row.phase).toBe("READY");
      expect(row.status).not.toBe("ABANDONED");
      expect(await lockCount()).toBe(2); // locks retained — the merge is unreconciled
    } finally {
      if (saved === undefined) delete process.env.MERGESHIP_MUTATIONS;
      else process.env.MERGESHIP_MUTATIONS = saved;
    }
  });

  // ── A2: the dispatch gate is linearizable with setControl ────────────────

  const gateControlInterleave = async (
    kind: "EDIT_COMMIT" | "ORDER_CANCEL",
    switchKey: "newMergesEnabled" | "completionEnabled",
    requiredPhase: "READY" | "APPLIED",
  ) => {
    const op = await createOp([oid(1), oid(2)]);
    if (requiredPhase === "APPLIED") {
      await db.$executeRaw`UPDATE "MergeOperation" SET "phase" = 'APPLIED' WHERE id = ${op.id}`;
    }
    // db2 holds the op row lock without changing the row; the gate blocks on
    // its FOR UPDATE before it ever reads AppControl.
    let release!: () => void;
    const holder = db2.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "MergeOperation" WHERE id = ${op.id} FOR UPDATE`;
        await new Promise<void>((r) => (release = r));
      },
      { timeout: 15_000 },
    );
    await sleep(500);

    const gate = ops.openDispatchGate({
      op,
      kind,
      targetOrderId: kind === "EDIT_COMMIT" ? oid(1) : oid(2),
      dispatchToken: newLeaseToken(),
      requiredPhase,
    });
    await sleep(200); // the gate is blocked on the row lock
    await ops.setControl({ [switchKey]: false }); // commits while it waits
    await sleep(200);
    release();

    expect(await gate).toBeNull(); // the disable is observed, no dispatch token
    expect(await attemptCount()).toBe(0); // no attempt row was inserted
    expect((await freshOp(op.id)).phase).toBe(requiredPhase); // no phase flip
    await holder;
  };

  it("v2 dispatch gate (EDIT_COMMIT): a newMergesEnabled disable committed while the gate blocked is observed", async () => {
    const saved = process.env.MERGESHIP_MUTATIONS;
    process.env.MERGESHIP_MUTATIONS = "enabled";
    try {
      await gateControlInterleave("EDIT_COMMIT", "newMergesEnabled", "READY");
    } finally {
      if (saved === undefined) delete process.env.MERGESHIP_MUTATIONS;
      else process.env.MERGESHIP_MUTATIONS = saved;
    }
  });

  it("v2 dispatch gate (ORDER_CANCEL): a completionEnabled disable committed while the gate blocked is observed", async () => {
    const saved = process.env.MERGESHIP_MUTATIONS;
    process.env.MERGESHIP_MUTATIONS = "enabled";
    try {
      await gateControlInterleave("ORDER_CANCEL", "completionEnabled", "APPLIED");
    } finally {
      if (saved === undefined) delete process.env.MERGESHIP_MUTATIONS;
      else process.env.MERGESHIP_MUTATIONS = saved;
    }
  });

  it("v2 setControl is serialized: its FOR UPDATE waits on a gate's FOR SHARE", async () => {
    let release!: () => void;
    let markLocked!: () => void;
    const held = new Promise<void>((r) => (markLocked = r));
    const holder = db2.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "AppControl" WHERE id = 'control' FOR SHARE`;
        markLocked();
        await new Promise<void>((r) => (release = r));
      },
      { timeout: 15_000 },
    );
    await held;

    let resolved = false;
    const flip = ops.setControl({ completionEnabled: true }).then(() => {
      resolved = true;
    });
    await sleep(300);
    expect(resolved).toBe(false); // the write lock waits on the share lock
    release();
    await flip;
    await holder;
    expect((await ops.getControl())!.completionEnabled).toBe(true);
  });

  it("v2 createOperation honours the kill switch — disabled switch and missing allowlist, nothing persists", async () => {
    // Control re-seeded OFF; acquire claims + work item exactly like a real merge.
    const claimToken = newLeaseToken();
    expect(await claims.acquire(SHOP, [oid(1), oid(2)], claimToken, 120_000)).toBe(true);
    const item = (await work.insertLeased(SHOP, oid(1), "wt", 120_000, WORK_DEADLINE_MS))!;
    const input = {
      shop: SHOP,
      claimToken,
      involvedOrderIds: [oid(1), oid(2)],
      primaryOrderId: oid(1),
      primaryOrderName: "#1",
      customerId: null,
      primaryLineItemCountBefore: 1,
      addedLineItemCount: 1,
      secondaries: [{ id: oid(2), name: "#2", items: 1, cancelPhase: "TRANSFER_PENDING" as const }],
      opToken: newOpToken(),
      calculatedOrderId: "gid://shopify/CalculatedOrder/9",
      expectedTransfer: [],
      expectedLocationId: null,
      primaryLineItemIdsBefore: [],
      workItemId: item.id,
      workToken: "wt",
      leaseToken: newLeaseToken(),
      ttlMs: 120_000,
    };
    await expect(ops.createOperation(input)).rejects.toThrowError(ClaimContentionError);

    // Allowlist that does not contain the shop is equally closed.
    await ops.setControl({ newMergesEnabled: true, allowShops: ["other.myshopify.com"] });
    await expect(ops.createOperation(input)).rejects.toThrowError(ClaimContentionError);

    // Claims, locks, op rows and the work item's lease are all unchanged.
    expect(await opCount()).toBe(0);
    expect(await lockCount()).toBe(0);
    expect(await claimCount()).toBe(2);
    expect((await work.find(SHOP, oid(1)))!).toMatchObject({
      status: "PENDING",
      leaseToken: "wt",
      operationId: null,
    });
  });

  // ── A3: end-to-end store-layer runs — FakeShopify for the Admin API,
  // real Prisma stores, real processOrderWork/driveOperation wiring ────────

  const realDeps = (): MergeDeps => ({
    journal,
    claims,
    ops,
    leaseTtlMs: 120_000,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    cancelPollAttempts: 4,
    cancelPollIntervalMs: 250,
  });

  const settings = async () => ({
    autoMergeEnabled: true,
    mergeWindowHours: 24,
    shippingCostSavings: 0,
    shopifyShopGid: "gid://shopify/Shop/1",
    autoMergeAcknowledgedAt: new Date(),
    onboardingStartedAt: new Date(),
    onboardingCompletedAt: new Date(),
  });

  /** insertLeased + processOrderWork, exactly like the webhook path. */
  const deliverWork = async (shopify: FakeShopify, orderId: string, deps: MergeDeps) => {
    const token = newLeaseToken();
    const item = await work.insertLeased(SHOP, orderId, token, 120_000, WORK_DEADLINE_MS);
    if (!item) return null;
    await processOrderWork({
      item,
      token,
      shop: SHOP,
      admin: shopify.admin,
      deps,
      work,
      settings,
      now: () => new Date(),
      random: () => 0.5,
    });
    return work.find(SHOP, orderId);
  };

  /** Drive until terminal, or parked at a future nextCheckAt waiting point. */
  const driveUntilSettled = async (shopify: FakeShopify, opId: string, deps: MergeDeps) => {
    for (let i = 0; i < 30; i++) {
      const row = await freshOp(opId);
      if (
        row.phase === "ABANDONED" ||
        row.phase === "REVIEW_REQUIRED" ||
        (row.phase === "COMPLETED" && row.sideEffectsDone)
      ) {
        return row;
      }
      if (
        row.nextCheckAt &&
        new Date(row.nextCheckAt).getTime() > Date.now() &&
        row.phase !== "COMPLETED"
      ) {
        return row; // waiting point a real-time test cannot pass
      }
      await driveOperation(row, shopify.admin, deps);
    }
    return freshOp(opId);
  };

  const onlyV2Op = async () => {
    const rows = await db.$queryRawUnsafe<OperationRecord[]>(
      `SELECT * FROM "MergeOperation" WHERE "protocolVersion" = 2`,
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  it("v2 real stores: sibling held by a COMMIT_IN_DOUBT op + incompatible free sibling → anchor retries, never NO_PARTNER", async () => {
    const saved = process.env.MERGESHIP_MUTATIONS;
    process.env.MERGESHIP_MUTATIONS = "enabled";
    try {
      await ops.setControl({ newMergesEnabled: true, completionEnabled: true });
      const shopify = new FakeShopify([
        makeOrder(1),
        makeOrder(2),
        makeOrder(3, { riskLevel: "HIGH" }),
      ]);
      shopify.commitMode.set("*", "lose-never");
      const deps = realDeps();

      // #1 + #2 merge; the commit response is lost → the op parks in doubt
      // holding durable locks on both. (#3 was same-group but HIGH-risk and
      // got excluded; it stays free.)
      await deliverWork(shopify, oid(2), deps);
      const op1 = await onlyV2Op();
      expect((await driveUntilSettled(shopify, op1.id, deps)).phase).toBe("COMMIT_IN_DOUBT");
      expect(await lockCount()).toBe(2);

      // #4's only compatible siblings are locked by the in-doubt op; #3 is
      // free but incompatible (HIGH risk). Contention — not NO_PARTNER.
      shopify.orders.set(oid(4), makeOrder(4));
      const item = await deliverWork(shopify, oid(4), deps);
      expect(item).toMatchObject({ status: "PENDING", outcome: null });
      expect(item!.lastReason).toMatch(/unfinished merge/);
      expect(await opCount()).toBe(1);
      expect(await lockCount()).toBe(2);
    } finally {
      if (saved === undefined) delete process.env.MERGESHIP_MUTATIONS;
      else process.env.MERGESHIP_MUTATIONS = saved;
    }
  });

  it("v2 real stores: an order arriving while the merge is in doubt waits — no second op, locks unchanged", async () => {
    const saved = process.env.MERGESHIP_MUTATIONS;
    process.env.MERGESHIP_MUTATIONS = "enabled";
    try {
      await ops.setControl({ newMergesEnabled: true, completionEnabled: true });
      const shopify = new FakeShopify([makeOrder(1), makeOrder(2)]);
      shopify.commitMode.set("*", "lose-never");
      const deps = realDeps();

      await deliverWork(shopify, oid(2), deps);
      const op1 = await onlyV2Op();
      expect((await driveUntilSettled(shopify, op1.id, deps)).phase).toBe("COMMIT_IN_DOUBT");

      // #4 arrives while every same-group sibling is under a live lock —
      // the item waits.
      shopify.orders.set(oid(4), makeOrder(4));
      const item = await deliverWork(shopify, oid(4), deps);
      expect(item).toMatchObject({ status: "PENDING", outcome: null });
      expect(item!.lastReason).toMatch(/unfinished merge/);
      expect(await opCount()).toBe(1);
      expect(await lockCount()).toBe(2);
    } finally {
      if (saved === undefined) delete process.env.MERGESHIP_MUTATIONS;
      else process.env.MERGESHIP_MUTATIONS = saved;
    }
  });

  it("v2 real stores: after COMPLETED a new order merges into the released primary — second op, 4 lines, cancelled once", async () => {
    const saved = process.env.MERGESHIP_MUTATIONS;
    process.env.MERGESHIP_MUTATIONS = "enabled";
    try {
      await ops.setControl({ newMergesEnabled: true, completionEnabled: true });
      const shopify = new FakeShopify([makeOrder(1), makeOrder(2), makeOrder(3)]);
      const deps = realDeps();

      // #3 is the newest arrival: its op merges #2+#3 into primary #1.
      await deliverWork(shopify, oid(3), deps);
      const op1 = await onlyV2Op();
      const settled = await driveUntilSettled(shopify, op1.id, deps);
      expect(settled.phase).toBe("COMPLETED");
      expect(settled.sideEffectsDone).toBe(true);
      expect(settled.primaryOrderId).toBe(oid(1));
      expect(shopify.orders.get(oid(1))!.lineItems).toHaveLength(3);
      for (const s of [oid(2), oid(3)]) {
        expect(shopify.orders.get(s)!.cancelledAt).toBeTruthy();
        expect(shopify.orders.get(s)!.cancelCount).toBe(1);
      }
      expect(await lockCount()).toBe(0); // terminal ops release their locks

      // #4 arrives after completion: a SECOND op merges it into #1.
      shopify.orders.set(oid(4), makeOrder(4));
      const item = await deliverWork(shopify, oid(4), deps);
      expect(item!.outcome === "MERGED" || item!.status === "DONE").toBe(true);
      const all = await db.$queryRawUnsafe<OperationRecord[]>(
        `SELECT * FROM "MergeOperation" WHERE "protocolVersion" = 2 ORDER BY "createdAt"`,
      );
      expect(all).toHaveLength(2);
      const op2 = all[1];
      expect(op2.primaryOrderId).toBe(oid(1));
      const settled2 = await driveUntilSettled(shopify, op2.id, deps);
      expect(settled2.phase).toBe("COMPLETED");
      expect(shopify.orders.get(oid(1))!.lineItems).toHaveLength(4);
      expect(shopify.orders.get(oid(4))!.cancelCount).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.MERGESHIP_MUTATIONS;
      else process.env.MERGESHIP_MUTATIONS = saved;
    }
  });

  it("v2 real stores: a COMPLETED op keeps status 'COMPLETED' through side-effect dispatches and blocks nothing", async () => {
    const saved = process.env.MERGESHIP_MUTATIONS;
    process.env.MERGESHIP_MUTATIONS = "enabled";
    try {
      await ops.setControl({ newMergesEnabled: true, completionEnabled: true });
      const shopify = new FakeShopify([makeOrder(1), makeOrder(2)]);
      const deps = realDeps();

      await deliverWork(shopify, oid(2), deps);
      const op1 = await onlyV2Op();
      const settled = await driveUntilSettled(shopify, op1.id, deps);
      expect(settled.phase).toBe("COMPLETED");
      expect(settled.sideEffectsDone).toBe(true);

      // The cosmetic dispatches really went through the gate (this is what
      // used to flip the legacy status back to NEEDS_REVIEW).
      const kinds = (await ops.listAttempts(op1.id)).map((a) => a.kind);
      expect(kinds).toEqual(expect.arrayContaining(["EDIT_COMMIT", "ORDER_CANCEL", "ANNOTATE", "CLOSE"]));

      const raw = await freshOp(op1.id);
      expect(raw.status).toBe("COMPLETED");

      // The released orders block neither the v1 queries nor a new op.
      expect(await ops.findBlockingV1(SHOP, [oid(1), oid(2)])).toEqual(new Set());
      expect(await journal.findBlockingOrderIds(SHOP)).not.toContain(oid(1));
      const claimToken = newLeaseToken();
      expect(await claims.acquire(SHOP, [oid(1), oid(4)], claimToken, 120_000)).toBe(true);
      const op2 = await ops.createOperation({
        shop: SHOP,
        claimToken,
        involvedOrderIds: [oid(1), oid(4)],
        primaryOrderId: oid(1),
        primaryOrderName: "#1",
        customerId: null,
        primaryLineItemCountBefore: 2,
        addedLineItemCount: 1,
        secondaries: [{ id: oid(4), name: "#4", items: 1, cancelPhase: "TRANSFER_PENDING" }],
        opToken: newOpToken(),
        calculatedOrderId: "gid://shopify/CalculatedOrder/7",
        expectedTransfer: [],
        expectedLocationId: null,
        primaryLineItemIdsBefore: shopify.orders.get(oid(1))!.lineItems.map((l) => l.id!),
        leaseToken: newLeaseToken(),
        ttlMs: 120_000,
      });
      expect(op2.phase).toBe("READY");
      expect(await lockCount()).toBe(2);
    } finally {
      if (saved === undefined) delete process.env.MERGESHIP_MUTATIONS;
      else process.env.MERGESHIP_MUTATIONS = saved;
    }
  });

  it("v2 real stores: the v2 status shield never leaks into v1 journal queries (no cross-protocol blocking)", async () => {
    const saved = process.env.MERGESHIP_MUTATIONS;
    process.env.MERGESHIP_MUTATIONS = "enabled";
    try {
      // An ACTIVE v2 op carries status NEEDS_REVIEW — v1 blocking queries
      // must not see it (v2 involvement is enforced by locks, not status).
      const op = await createOp([oid(1), oid(2)]);
      expect(op.status).toBe("NEEDS_REVIEW");
      expect(await journal.findBlockingOrderIds(SHOP)).toEqual(new Set());
      expect(await journal.findBlockingOrderStatuses(SHOP)).toEqual(new Map());
      expect(await journal.findUnfinished(SHOP)).toEqual([]);
      expect(await journal.findShopsWithUnfinished()).toEqual([]);
      expect(await ops.findBlockingV1(SHOP, [oid(1)])).toEqual(new Set());
      // …while the durable locks still mark the orders busy for v2 callers.
      expect(await ops.findLockedOrderIds(SHOP, [oid(1), oid(9)])).toEqual(new Set([oid(1)]));
    } finally {
      if (saved === undefined) delete process.env.MERGESHIP_MUTATIONS;
      else process.env.MERGESHIP_MUTATIONS = saved;
    }
  });
});
