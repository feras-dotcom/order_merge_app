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
import { prismaWorkStore, WORK_DEADLINE_MS, type WorkStore } from "../app/lib/order-work.server";
import { DB_NOW, dbNowPlus, newLeaseToken, OwnershipLostError } from "../app/lib/ownership.server";

const URL = process.env.MERGESHIP_TEST_DATABASE_URL;
const SHOP = "pg-test.myshopify.com";
const oid = (n: number) => `gid://shopify/Order/${n}`;

describe.skipIf(!URL)("postgres stores (real database, Tokyo session timezone)", () => {
  let db: PrismaClient;
  let claims: ClaimStore;
  let work: WorkStore;
  let journal: MergeJournal;

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
  }, 120_000);

  beforeEach(async () => {
    await db.$executeRawUnsafe(
      `TRUNCATE "MergeClaim", "ProcessedWebhook", "MergeOperation" RESTART IDENTITY CASCADE`,
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
    await db.$executeRaw`UPDATE "MergeClaim" SET "leasedUntil" = ${dbNowPlus(-1_000)}`;
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
    await db.$executeRaw`UPDATE "MergeClaim" SET "leasedUntil" = ${dbNowPlus(-1_000)} WHERE "orderId" = ${oid(1)}`;
    expect(await claims.reapExpired()).toBe(1);
    expect(await claimCount()).toBe(1);
  });

  /** Inserts a work item whose lease is already expired, so claimDue can see it. */
  const insertDue = async (orderId: string, retryAfterPast = true) => {
    const item = await work.insertLeased(SHOP, orderId, `seed-${orderId}`, -1_000, WORK_DEADLINE_MS);
    if (!retryAfterPast) {
      await db.$executeRaw`UPDATE "ProcessedWebhook" SET "retryAfter" = ${dbNowPlus(3_600_000)} WHERE id = ${item!.id}`;
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
    await db.$executeRaw`UPDATE "ProcessedWebhook" SET "retryAfter" = ${DB_NOW} WHERE id = ${item.id}`;
    const [claimed] = await work.claimDue(3, 60_000);
    expect(claimed.id).toBe(item.id);
    expect(claimed.attempts).toBe(2);
    await work.renew(claimed.id, claimed.leaseToken!, 60_000);
    expect(await work.markDone(claimed.id, claimed.leaseToken!, "MERGED", "done")).toBe(true);
    const done = await work.find(SHOP, oid(1));
    expect(done).toMatchObject({ status: "DONE", outcome: "MERGED", doneAt: expect.any(Date) });

    // purgeDone: an aged DONE row is deleted (doneAt back-dated via SQL).
    await db.$executeRaw`UPDATE "ProcessedWebhook" SET "doneAt" = ${dbNowPlus(-31 * 24 * 60 * 60 * 1000)} WHERE id = ${item.id}`;
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
    await db.$executeRaw`UPDATE "MergeOperation" SET "leasedUntil" = ${dbNowPlus(-1_000)} WHERE id = ${op.id}`;
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
});
