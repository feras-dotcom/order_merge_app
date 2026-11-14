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
});
