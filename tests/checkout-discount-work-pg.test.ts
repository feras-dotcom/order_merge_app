// Real-Postgres tests for prismaCheckoutWorkStore — the durable
// CheckoutEligibilityWork store. Opt-in:
//
//   MERGESHIP_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:PORT/mergeship_test_x \
//   MERGESHIP_SHADOW_TOKEN=<operator token> \
//     npx vitest run tests/checkout-discount-work-pg.test.ts
//
// Same contract as tests/postgres-stores.test.ts: the database must be
// provisioned by scripts/test-db-provision.ts, preflightDisposableDatabase
// runs before any migration or write, and the DB session runs Asia/Tokyo so
// the (clock_timestamp() AT TIME ZONE 'UTC') discipline is what the tests
// prove. Lease expiry is forced with dbWallPlus(-…) UPDATEs — never a JS
// Date bind.

import { execSync } from "child_process";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  CHECKOUT_DEADLINE_MS,
  CHECKOUT_MAX_ATTEMPTS,
  prismaCheckoutWorkStore,
  type CheckoutWorkStore,
} from "../app/lib/checkout-discount/work.server";
import { dbWallPlus, OwnershipLostError } from "../app/lib/ownership.server";
import { preflightDisposableDatabase } from "./helpers/disposable-db";

const URL = process.env.MERGESHIP_TEST_DATABASE_URL;
const SHOP = "pg-checkout.myshopify.com";
const oid = (n: number) => `gid://shopify/Order/${n}`;
const TTL = 60_000;

describe.skipIf(!URL)("checkout work store (real Postgres)", () => {
  let db: PrismaClient;
  let store: CheckoutWorkStore;

  const expireLease = async (id: string) =>
    db.$executeRaw`UPDATE "CheckoutEligibilityWork" SET "leasedUntil" = ${dbWallPlus(-1_000)} WHERE id = ${id}`;
  const forceAttempts = async (id: string, n: number) =>
    db.$executeRaw`UPDATE "CheckoutEligibilityWork" SET "attempts" = ${n}, "leasedUntil" = NULL, "leaseToken" = NULL WHERE id = ${id}`;

  beforeAll(async () => {
    // FIRST — before migrations or any write.
    await preflightDisposableDatabase(URL!);
    execSync("npx prisma migrate deploy", {
      env: { ...process.env, DATABASE_URL: URL! },
      stdio: "pipe",
    });
    db = new PrismaClient({ datasources: { db: { url: URL } } });
    store = prismaCheckoutWorkStore(db);
    const [{ tz }] = await db.$queryRawUnsafe<{ tz: string }[]>(
      `SELECT current_setting('TimeZone') AS tz`,
    );
    expect(tz).toBe("Asia/Tokyo");
  }, 120_000);

  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE "CheckoutEligibilityWork" RESTART IDENTITY CASCADE`);
  });

  it("upsertDirty: new row is PENDING gen 1, leased, acquired", async () => {
    const r = await store.upsertDirty(SHOP, oid(1), "tok1", TTL, CHECKOUT_DEADLINE_MS);
    expect(r.acquired).toBe(true);
    expect(r.item).toMatchObject({
      shop: SHOP,
      orderId: oid(1),
      gen: 1,
      status: "PENDING",
      attempts: 1,
      leaseToken: "tok1",
    });
  });

  it("upsertDirty on a live lease keeps the lease, bumps gen, acquired=false", async () => {
    const first = await store.upsertDirty(SHOP, oid(2), "tok1", TTL, CHECKOUT_DEADLINE_MS);
    const second = await store.upsertDirty(SHOP, oid(2), "tok2", TTL, CHECKOUT_DEADLINE_MS);
    expect(second.acquired).toBe(false);
    const row = await store.find(SHOP, oid(2));
    expect(row).toMatchObject({ gen: 2, status: "PENDING", leaseToken: "tok1" });
    expect(row!.id).toBe(first.item.id);
  });

  it("upsertDirty on an expired lease takes the lease, bumps gen, attempts reset", async () => {
    const first = await store.upsertDirty(SHOP, oid(3), "tok1", TTL, CHECKOUT_DEADLINE_MS);
    await expireLease(first.item.id);
    const r = await store.upsertDirty(SHOP, oid(3), "tok2", TTL, CHECKOUT_DEADLINE_MS);
    expect(r.acquired).toBe(true);
    expect(await store.find(SHOP, oid(3))).toMatchObject({
      gen: 2,
      leaseToken: "tok2",
      attempts: 1,
      status: "PENDING",
    });
  });

  it("upsertDirty re-opens DONE and REVIEW rows", async () => {
    const d = await store.upsertDirty(SHOP, oid(4), "tok1", TTL, CHECKOUT_DEADLINE_MS);
    expect(await store.complete(d.item.id, "tok1", 1, "PROJECTED", "ok")).toBe("DONE");
    const r = await store.upsertDirty(SHOP, oid(4), "tok2", TTL, CHECKOUT_DEADLINE_MS);
    expect(r.acquired).toBe(true);
    expect(await store.find(SHOP, oid(4))).toMatchObject({
      gen: 2,
      status: "PENDING",
      outcome: null,
      doneAt: null,
    });
    // REVIEW rows re-open the same way.
    const s = await store.upsertDirty(SHOP, oid(5), "tok3", TTL, CHECKOUT_DEADLINE_MS);
    await forceAttempts(s.item.id, CHECKOUT_MAX_ATTEMPTS);
    expect(await store.exhaustDue()).toBe(1);
    expect(await store.find(SHOP, oid(5))).toMatchObject({ status: "REVIEW", outcome: "EXHAUSTED" });
    const reopen = await store.upsertDirty(SHOP, oid(5), "tok4", TTL, CHECKOUT_DEADLINE_MS);
    expect(reopen.acquired).toBe(true);
    expect(await store.find(SHOP, oid(5))).toMatchObject({ status: "PENDING", outcome: null });
  });

  it("complete: same gen => DONE; a newer dirty mark mid-processing => REQUEUED", async () => {
    const r = await store.upsertDirty(SHOP, oid(6), "tok1", TTL, CHECKOUT_DEADLINE_MS);
    const d2 = await store.upsertDirty(SHOP, oid(6), "tok2", TTL, CHECKOUT_DEADLINE_MS);
    expect(d2.acquired).toBe(false); // live lease held by tok1
    expect(await store.complete(r.item.id, "tok1", 1, "PROJECTED", "gen1 work")).toBe("REQUEUED");
    const row = await store.find(SHOP, oid(6));
    expect(row).toMatchObject({ status: "PENDING", gen: 2, leaseToken: null });
    const [item] = await store.claimDue(1, TTL); // due immediately
    expect(item?.gen).toBe(2);
    expect(await store.complete(item.id, item.leaseToken!, 2, "PROJECTED", "gen2")).toBe("DONE");
  });

  it("complete with a stale token => LOST", async () => {
    const r = await store.upsertDirty(SHOP, oid(7), "tok1", TTL, CHECKOUT_DEADLINE_MS);
    await expireLease(r.item.id);
    await store.upsertDirty(SHOP, oid(7), "tok2", TTL, CHECKOUT_DEADLINE_MS);
    expect(await store.complete(r.item.id, "tok1", 1, "PROJECTED", "stale")).toBe("LOST");
  });

  it("claimDue: SKIP LOCKED gives exclusive leases with fresh tokens; live leases skipped", async () => {
    const a = await store.upsertDirty(SHOP, oid(8), "tok1", 1, CHECKOUT_DEADLINE_MS);
    const b = await store.upsertDirty(SHOP, oid(9), "tok9", TTL, CHECKOUT_DEADLINE_MS);
    await expireLease(a.item.id);
    const claimed = await store.claimDue(5, TTL);
    expect(claimed.map((i) => i.orderId)).toEqual([oid(8)]);
    expect(claimed[0].leaseToken).toBeTruthy();
    expect(claimed[0].leaseToken).not.toBe("tok1");
    expect(claimed[0].attempts).toBe(2);
    // A second concurrent claim sees the now-live lease and takes nothing.
    expect((await store.claimDue(5, TTL)).length).toBe(0);
    expect(b.item.leaseToken).toBe("tok9");
  });

  it("scheduleRetry defers and clears the lease; a stale token is refused", async () => {
    const r = await store.upsertDirty(SHOP, oid(10), "tok1", TTL, CHECKOUT_DEADLINE_MS);
    expect(await store.scheduleRetry(r.item.id, "bad", 1_000, "x")).toBe(false);
    expect(await store.scheduleRetry(r.item.id, "tok1", 60_000, "transient")).toBe(true);
    expect(await store.find(SHOP, oid(10))).toMatchObject({
      status: "PENDING",
      leaseToken: null,
      lastReason: "transient",
    });
    expect((await store.claimDue(1, TTL)).length).toBe(0); // not due
    await db.$executeRaw`UPDATE "CheckoutEligibilityWork" SET "retryAfter" = ${dbWallPlus(-1_000)} WHERE id = ${r.item.id}`;
    expect((await store.claimDue(1, TTL)).length).toBe(1);
  });

  it("renew extends the lease; wrong or expired token throws OwnershipLostError", async () => {
    const r = await store.upsertDirty(SHOP, oid(11), "tok1", TTL, CHECKOUT_DEADLINE_MS);
    await store.renew(r.item.id, "tok1", TTL);
    await expect(store.renew(r.item.id, "bad", TTL)).rejects.toBeInstanceOf(OwnershipLostError);
    await expireLease(r.item.id);
    await expect(store.renew(r.item.id, "tok1", TTL)).rejects.toBeInstanceOf(OwnershipLostError);
  });

  it("restart: lease expiry lets a second worker claim and finish; stale completion LOST", async () => {
    const r = await store.upsertDirty(SHOP, oid(12), "tok1", TTL, CHECKOUT_DEADLINE_MS);
    await expireLease(r.item.id); // worker 1 died holding the lease
    const [item] = await store.claimDue(1, TTL);
    expect(item).toBeTruthy();
    expect(await store.complete(r.item.id, "tok1", item.gen, "PROJECTED", "stale worker")).toBe("LOST");
    expect(await store.complete(item.id, item.leaseToken!, item.gen, "PROJECTED", "recovered")).toBe("DONE");
    expect(await store.find(SHOP, oid(12))).toMatchObject({ status: "DONE", outcome: "PROJECTED" });
  });

  it("exhaustDue moves deadline-expired rows to REVIEW and purges old DONE rows", async () => {
    const r = await store.upsertDirty(SHOP, oid(13), "tok1", TTL, CHECKOUT_DEADLINE_MS);
    await db.$executeRaw`UPDATE "CheckoutEligibilityWork" SET "deadlineAt" = ${dbWallPlus(-1_000)}, "leasedUntil" = NULL, "leaseToken" = NULL WHERE id = ${r.item.id}`;
    expect(await store.exhaustDue()).toBe(1);
    expect(await store.find(SHOP, oid(13))).toMatchObject({ status: "REVIEW", outcome: "EXHAUSTED" });
    // purgeDone: only DONE rows older than the retention window.
    const d = await store.upsertDirty(SHOP, oid(14), "tok9", TTL, CHECKOUT_DEADLINE_MS);
    await store.complete(d.item.id, "tok9", 1, "PROJECTED", "ok");
    await db.$executeRaw`UPDATE "CheckoutEligibilityWork" SET "doneAt" = ${dbWallPlus(-31 * 24 * 3600_000)} WHERE id = ${d.item.id}`;
    expect(await store.purgeDone(30 * 24 * 3600_000)).toBe(1);
    expect(await store.find(SHOP, oid(14))).toBeNull();
    expect(await store.find(SHOP, oid(13))).not.toBeNull(); // REVIEW is kept
  });
  it("touchExisting: no row => null and nothing written", async () => {
    expect(await store.touchExisting(SHOP, oid(20), "tok1", TTL, CHECKOUT_DEADLINE_MS)).toBeNull();
    expect(await store.find(SHOP, oid(20))).toBeNull();
    const [{ n }] = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM "CheckoutEligibilityWork"`,
    );
    expect(Number(n)).toBe(0);
  });

  it("touchExisting: live lease is kept (owner untouched), gen bumps, acquired=false", async () => {
    const r = await store.upsertDirty(SHOP, oid(21), "tok1", TTL, CHECKOUT_DEADLINE_MS);
    const t = await store.touchExisting(SHOP, oid(21), "tok2", TTL, CHECKOUT_DEADLINE_MS);
    expect(t).not.toBeNull();
    expect(t!.acquired).toBe(false);
    const row = await store.find(SHOP, oid(21));
    expect(row).toMatchObject({ gen: 2, status: "PENDING", leaseToken: "tok1", attempts: 1 });
    expect(row!.leasedUntil!.getTime()).toBe(r.item.leasedUntil!.getTime());
  });

  it("touchExisting: expired lease is acquired by the supplied token", async () => {
    const r = await store.upsertDirty(SHOP, oid(22), "tok1", TTL, CHECKOUT_DEADLINE_MS);
    await expireLease(r.item.id);
    const t = await store.touchExisting(SHOP, oid(22), "tok2", TTL, CHECKOUT_DEADLINE_MS);
    expect(t!.acquired).toBe(true);
    expect(await store.find(SHOP, oid(22))).toMatchObject({
      gen: 2, status: "PENDING", leaseToken: "tok2", attempts: 1,
    });
  });

  it("touchExisting re-opens a DONE row exactly like the upsertDirty conflict branch", async () => {
    const r = await store.upsertDirty(SHOP, oid(23), "tok1", TTL, CHECKOUT_DEADLINE_MS);
    await store.complete(r.item.id, "tok1", 1, "PROJECTED", "ok");
    const t = await store.touchExisting(SHOP, oid(23), "tok2", TTL, CHECKOUT_DEADLINE_MS);
    expect(t!.acquired).toBe(true);
    expect(await store.find(SHOP, oid(23))).toMatchObject({
      gen: 2, status: "PENDING", outcome: null, doneAt: null, leaseToken: "tok2", attempts: 1,
    });
  });

  it("reopenOutstanding: outcome + age filtering and FOR UPDATE SKIP LOCKED limit", async () => {
    const made = async (n: number, outcome: string) => {
      const r = await store.upsertDirty(SHOP, oid(n), "tok1", TTL, CHECKOUT_DEADLINE_MS);
      await store.complete(r.item.id, "tok1", 1, outcome, "ok");
      return r.item.id;
    };
    // Old enough to re-open: PROJECTED rows.
    const ids = [await made(30, "PROJECTED"), await made(31, "PROJECTED"), await made(32, "PROJECTED")];
    await made(33, "CONSUMED");   // never
    await made(34, "REFUSED");    // never
    // Too young to re-open.
    await made(35, "PROJECTED");
    for (const id of ids) {
      await db.$executeRaw`UPDATE "CheckoutEligibilityWork" SET "doneAt" = ${dbWallPlus(-700_000)} WHERE id = ${id}`;
    }
    const args = { olderThanMs: 600_000, maxAgeMs: 8 * 24 * 3600_000, limit: 50, deadlineMs: CHECKOUT_DEADLINE_MS };
    // Too-old row: createdAt beyond maxAge stays DONE.
    await db.$executeRaw`UPDATE "CheckoutEligibilityWork" SET "createdAt" = ${dbWallPlus(-9 * 24 * 3600_000)} WHERE id = ${ids[0]}`;
    expect(await store.reopenOutstanding(args)).toBe(2);
    expect(await store.find(SHOP, oid(31))).toMatchObject({ status: "PENDING", outcome: null, attempts: 0, leaseToken: null, doneAt: null });
    expect(await store.find(SHOP, oid(32))).toMatchObject({ status: "PENDING" });
    expect((await store.find(SHOP, oid(30)))!.status).toBe("DONE"); // too old
    expect((await store.find(SHOP, oid(33)))!.status).toBe("DONE");
    expect((await store.find(SHOP, oid(34)))!.status).toBe("DONE");
    expect((await store.find(SHOP, oid(35)))!.status).toBe("DONE"); // too young
    // limit: another aged batch, limit 1 takes exactly one.
    const m1 = await made(36, "PROJECTED");
    const m2 = await made(37, "PROJECTED");
    await db.$executeRaw`UPDATE "CheckoutEligibilityWork" SET "doneAt" = ${dbWallPlus(-700_000)} WHERE id IN (${m1}, ${m2})`;
    expect(await store.reopenOutstanding({ ...args, limit: 1 })).toBe(1);
  });

  it("reopenOutstanding is safe under concurrent calls (SKIP LOCKED)", async () => {
    for (let n = 40; n < 46; n++) {
      const r = await store.upsertDirty(SHOP, oid(n), "tok1", TTL, CHECKOUT_DEADLINE_MS);
      await store.complete(r.item.id, "tok1", 1, "PROJECTED", "ok");
      await db.$executeRaw`UPDATE "CheckoutEligibilityWork" SET "doneAt" = ${dbWallPlus(-700_000)} WHERE id = ${r.item.id}`;
    }
    const db2 = new PrismaClient({ datasources: { db: { url: URL! } } });
    const store2 = prismaCheckoutWorkStore(db2);
    try {
      const args = { olderThanMs: 600_000, maxAgeMs: 8 * 24 * 3600_000, limit: 4, deadlineMs: CHECKOUT_DEADLINE_MS };
      const [a, b] = await Promise.all([store.reopenOutstanding(args), store2.reopenOutstanding(args)]);
      // Both calls together cover all 6 rows exactly once — no double-open.
      expect(a + b).toBe(6);
      const [claim1] = await Promise.all([store.claimDue(10, TTL), store2.claimDue(10, TTL)]);
      expect(claim1.length).toBe(6);
    } finally {
      await db2.$disconnect();
    }
  });
});
