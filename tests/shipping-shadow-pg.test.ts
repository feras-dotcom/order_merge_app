// Real-Postgres tests for the Shipping v0 shadow store (Phase 1). Opt-in:
//
//   MERGESHIP_TEST_DATABASE_URL=postgresql://postgres@localhost:54329/mergeship_test \
//     npx vitest run tests/shipping-shadow-pg.test.ts
//
// The URL must point at a DISPOSABLE database — `prisma migrate deploy` runs
// against it and the tables are truncated between tests. The shadow store's
// own guard additionally requires MERGESHIP_SHADOW_DATABASE to equal
// current_database(); these tests set it to the disposable DB name and also
// verify the guard refuses everywhere else.

import { execSync } from "child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { OwnershipLostError } from "../app/lib/ownership.server";
import {
  makeShippingShadowStore,
  ShadowDatabaseNotAllowedError,
  type ShadowIntentIdentity,
} from "../app/lib/shipping-shadow.server";

const TEST_URL = process.env.MERGESHIP_TEST_DATABASE_URL;
const SHOP = "pg-shadow.myshopify.com";
const oid = (n: number) => `gid://shopify/Order/${n}`;
const DB_NAME = TEST_URL
  ? new globalThis.URL(TEST_URL).pathname.replace(/^\//, "").split("?")[0]
  : "";

const identity = (sourceOrderId = oid(200)): ShadowIntentIdentity => ({
  shop: SHOP,
  mergeOperationId: "op-1",
  sourceOrderId,
  operationCreatedAt: new Date("2026-10-20T12:00:00Z"),
  policyKind: "REFUND_ALL",
  policyRetainedMinor: null,
  policyCurrencyCode: null,
});

describe.skipIf(!TEST_URL)("shipping shadow store (real disposable database)", () => {
  let db: PrismaClient;
  let db2: PrismaClient;

  beforeAll(async () => {
    execSync("npx prisma migrate deploy", {
      env: { ...process.env, DATABASE_URL: TEST_URL! },
      stdio: "pipe",
    });
    db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    db2 = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    // The store's disposable-database guard: writes only proceed when this
    // env var names the connected database exactly.
    process.env.MERGESHIP_SHADOW_DATABASE = DB_NAME;
  }, 120_000);

  afterAll(async () => {
    delete process.env.MERGESHIP_SHADOW_DATABASE;
    await db?.$disconnect();
    await db2?.$disconnect();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE "ShippingAdjustment" RESTART IDENTITY CASCADE`);
  });

  const rowFor = (sourceOrderId = oid(200)) =>
    db.$queryRaw<any[]>`SELECT * FROM "ShippingAdjustment" WHERE "shop" = ${SHOP} AND "sourceOrderId" = ${sourceOrderId}`;

  it("refuses every write when MERGESHIP_SHADOW_DATABASE is unset", async () => {
    delete process.env.MERGESHIP_SHADOW_DATABASE;
    const store = makeShippingShadowStore(db);
    await expect(store.claimIntent(identity(), 60_000)).rejects.toBeInstanceOf(
      ShadowDatabaseNotAllowedError,
    );
    await expect(
      store.recordTerminal(identity(), "SKIPPED", { reasonCode: "X" }),
    ).rejects.toBeInstanceOf(ShadowDatabaseNotAllowedError);
    // Reads are unaffected — the guard only gates writes.
    await expect(store.findAdjustments(SHOP, [oid(200)])).resolves.toEqual([]);
    process.env.MERGESHIP_SHADOW_DATABASE = DB_NAME;
  });

  it("refuses writes when the env var names a different database", async () => {
    process.env.MERGESHIP_SHADOW_DATABASE = "some_other_database";
    const store = makeShippingShadowStore(db);
    await expect(store.claimIntent(identity(), 60_000)).rejects.toBeInstanceOf(
      ShadowDatabaseNotAllowedError,
    );
    process.env.MERGESHIP_SHADOW_DATABASE = DB_NAME;
  });

  it("two concurrent claims produce exactly one intent row", async () => {
    const s1 = makeShippingShadowStore(db);
    const s2 = makeShippingShadowStore(db2);
    const [a, b] = await Promise.all([
      s1.claimIntent(identity(), 60_000),
      s2.claimIntent(identity(), 60_000),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await rowFor()).toHaveLength(1);
  });

  it("a live-leased PENDING row cannot be re-leased or settled by another token", async () => {
    const store = makeShippingShadowStore(db);
    const claimed = (await store.claimIntent(identity(), 60_000))!;
    // Another worker cannot reclaim while the lease is live.
    expect(await store.reclaimIntent(claimed.id, "other-token", 60_000)).toBeNull();
    // A stale token cannot settle.
    await expect(
      store.settleIntent(claimed.id, "stale", { status: "SKIPPED", reasonCode: "X" }),
    ).rejects.toBeInstanceOf(OwnershipLostError);
    // The owner can settle.
    await store.settleIntent(claimed.id, claimed.leaseToken!, {
      status: "READY",
      sourceShippingMinor: "800",
      plannedRefundMinor: "800",
      currencyCode: "USD",
      previewEvidence: { ok: true },
      requestPayload: { orderId: oid(200) },
      requestHash: "a".repeat(64),
    });
    const [row] = await rowFor();
    expect(row.status).toBe("READY");
    expect(row.plannedRefundMinor).toBe("800");
  });

  it("an expired lease is re-leasable exactly once — two workers race, one wins", async () => {
    const s1 = makeShippingShadowStore(db);
    const s2 = makeShippingShadowStore(db2);
    const claimed = (await s1.claimIntent(identity(), 60_000))!;
    // Force expiry on the database clock.
    await db.$executeRawUnsafe(
      `UPDATE "ShippingAdjustment" SET "leasedUntil" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE id = '${claimed.id}'`,
    );
    const [a, b] = await Promise.all([
      s1.reclaimIntent(claimed.id, "tok-a", 60_000),
      s2.reclaimIntent(claimed.id, "tok-b", 60_000),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
    const [row] = await rowFor();
    expect(row.attempts).toBe(2); // claim(1) + one successful reclaim
    // The loser cannot settle with its token.
    const loserToken = a ? "tok-b" : "tok-a";
    await expect(
      s2.settleIntent(claimed.id, loserToken, { status: "SKIPPED", reasonCode: "X" }),
    ).rejects.toBeInstanceOf(OwnershipLostError);
  });

  it("terminal rows are never re-leased or rewritten", async () => {
    const store = makeShippingShadowStore(db);
    expect(
      await store.recordTerminal(identity(), "SKIPPED", {
        reasonCode: "BEFORE_EPOCH",
        reviewReason: "predates epoch",
      }),
    ).toBe(true);
    // Duplicate terminal insert is a no-op.
    expect(
      await store.recordTerminal(identity(), "REVIEW_REQUIRED", { reviewReason: "x" }),
    ).toBe(false);
    const [row] = await rowFor();
    expect(row.status).toBe("SKIPPED");
    expect(row.reasonCode).toBe("BEFORE_EPOCH");
    // A claim against an existing SKIPPED row inserts nothing.
    expect(await store.claimIntent(identity(), 60_000)).toBeNull();
  });

  it("reschedule clears the lease and defers the intent on the DB clock", async () => {
    const store = makeShippingShadowStore(db);
    const claimed = (await store.claimIntent(identity(), 60_000))!;
    await store.rescheduleIntent(claimed.id, claimed.leaseToken!, 300_000, "TRANSIENT");
    const [row] = await rowFor();
    expect(row.status).toBe("PENDING");
    expect(row.leaseToken).toBeNull();
    expect(row.reasonCode).toBe("TRANSIENT");
    expect(new Date(row.nextCheckAt).getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it("a rescheduled intent is not reclaimed before nextCheckAt, and is when due", async () => {
    const store = makeShippingShadowStore(db);
    const claimed = (await store.claimIntent(identity(), 60_000))!;
    await store.rescheduleIntent(claimed.id, claimed.leaseToken!, 300_000, "TRANSIENT");
    // Deferred five minutes out: reclaim must refuse despite the cleared lease.
    expect(await store.reclaimIntent(claimed.id, "tok-b", 60_000)).toBeNull();
    const [deferred] = await rowFor();
    expect(deferred.status).toBe("PENDING");
    expect(deferred.leaseToken).toBeNull();
    // A retry that is already due reclaims normally.
    const claimed2 = (await store.claimIntent(identity(oid(202)), 60_000))!;
    await store.rescheduleIntent(claimed2.id, claimed2.leaseToken!, 0, "TRANSIENT");
    const reclaimed = await store.reclaimIntent(claimed2.id, "tok-c", 60_000);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.leaseToken).toBe("tok-c");
  });

  it("RETAIN_FIXED snapshots satisfy the CHECK constraint", async () => {
    const store = makeShippingShadowStore(db);
    const claimed = await store.claimIntent(
      {
        ...identity(oid(201)),
        policyKind: "RETAIN_FIXED",
        policyRetainedMinor: "300",
        policyCurrencyCode: "USD",
      },
      60_000,
    );
    expect(claimed).not.toBeNull();
    expect(claimed!.policyKind).toBe("RETAIN_FIXED");
    expect(claimed!.policyRetainedMinor).toBe("300");
  });
});
