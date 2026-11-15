// Real-Postgres tests for the report/monitor SQL — opt-in:
//
//   MERGESHIP_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:PORT/mergeship_test_x \
//   MERGESHIP_SHADOW_TOKEN=<operator token> \
//     npx vitest run tests/checkout-discount-ops-pg.test.ts
//
// Covers the shop-selection query (checkoutDiscountEnabled OR recorded
// node id), the overdraw predicate (CONSUMED_NO_RECORD definitive;
// CUSTOMER_GONE only with the consumed reason), the since bound, and the
// monitor's WORK_STUCK / SWEEPER_STALE SQL end to end through runMonitor.

import { execSync } from "child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { countOverdraw, reportShops } from "../app/lib/checkout-discount/report.server";
import { runMonitor } from "../app/lib/checkout-discount/monitor.server";
import { dbWallPlus } from "../app/lib/ownership.server";
import { preflightDisposableDatabase } from "./helpers/disposable-db";

vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/shopify.server", () => ({ unauthenticated: { admin: async () => ({ admin: null }) } }));

const URL = process.env.MERGESHIP_TEST_DATABASE_URL;
const SHOP = "pg-monitor.myshopify.com";
const oid = (n: number) => `gid://shopify/Order/${n}`;
const EPOCH1 = new Date("2026-11-01T00:00:00Z");

const insertWork = (
  db: PrismaClient,
  shop: string,
  orderId: string,
  over: {
    status?: string;
    outcome?: string;
    lastReason?: string | null;
    doneAt?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
    consumed?: boolean;
    attempts?: number;
  } = {},
) =>
  db.$executeRaw`
    INSERT INTO "CheckoutEligibilityWork"
      ("id", "shop", "orderId", "gen", "status", "attempts",
       "outcome", "lastReason", "doneAt", "grantConsumedAt", "createdAt", "updatedAt")
    VALUES (
      ${crypto.randomUUID()}, ${shop}, ${orderId}, 1,
      ${over.status ?? "DONE"}, ${over.attempts ?? 0},
      ${over.outcome ?? "PROJECTED"}, ${over.lastReason ?? null},
      ${(over.doneAt ?? dbWallPlus(-3_600_000)) as any},
      ${over.consumed ? dbWallPlus(0) : null},
      ${(over.createdAt ?? dbWallPlus(-3_600_000)) as any},
      ${(over.updatedAt ?? dbWallPlus(-3_600_000)) as any})`;

describe.skipIf(!URL)("checkout report/monitor SQL (real Postgres)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    // FIRST — before migrations or any write.
    await preflightDisposableDatabase(URL!);
    execSync("npx prisma migrate deploy", {
      env: { ...process.env, DATABASE_URL: URL! },
      stdio: "pipe",
    });
    db = new PrismaClient({ datasources: { db: { url: URL } } });
    const [{ tz }] = await db.$queryRawUnsafe<{ tz: string }[]>(
      `SELECT current_setting('TimeZone') AS tz`,
    );
    expect(tz).toBe("Asia/Tokyo");
  }, 120_000);

  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE "CheckoutEligibilityWork" RESTART IDENTITY CASCADE`);
    await db.$executeRawUnsafe(`DELETE FROM "Settings"`);
    await db.$executeRawUnsafe(`DELETE FROM "WorkerInstance"`);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  const addSettings = async (shop: string, over: Record<string, unknown> = {}) =>
    db.$executeRaw`
      INSERT INTO "Settings"
        ("id", "shop", "autoMergeEnabled", "mergeWindowHours",
         "onboardingStartedAt", "onboardingCompletedAt",
         "checkoutDiscountEnabled", "checkoutDiscountEnabledAt",
         "checkoutDiscountNodeId", "checkoutDiscountWindowHours")
      VALUES (
        ${crypto.randomUUID()}, ${shop}, ${over.autoMergeEnabled ?? true}, ${over.mergeWindowHours ?? 24},
        ${EPOCH1.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        ${EPOCH1.toISOString()}::timestamptz AT TIME ZONE 'UTC',
        ${over.checkoutDiscountEnabled ?? false},
        ${over.checkoutDiscountEnabledAt ?? null},
        ${over.checkoutDiscountNodeId ?? null},
        ${over.checkoutDiscountWindowHours ?? null})`;

  it("reportShops selects enabled-flag shops AND recorded-node shops only", async () => {
    await addSettings("a.myshopify.com", { checkoutDiscountEnabled: true, checkoutDiscountEnabledAt: EPOCH1 });
    await addSettings("b.myshopify.com", { checkoutDiscountNodeId: "gid://shopify/DiscountAutomaticNode/1" });
    await addSettings("c.myshopify.com"); // neither -> excluded
    expect((await reportShops(db)).sort()).toEqual(
      ["a.myshopify.com", "b.myshopify.com"].sort(),
    );
    expect(await reportShops(db, "c.myshopify.com")).toEqual(["c.myshopify.com"]); // explicit --shop
  });

  it("countOverdraw: CONSUMED_NO_RECORD definitive; CUSTOMER_GONE only with the consumed reason", async () => {
    await insertWork(db, SHOP, oid(1), { outcome: "CONSUMED_NO_RECORD", lastReason: "grant with no matching record" });
    await insertWork(db, SHOP, oid(2), { outcome: "CUSTOMER_GONE", lastReason: "consumed order has no customer" });
    await insertWork(db, SHOP, oid(3), { outcome: "CUSTOMER_GONE", lastReason: "order has no customer" }); // REFUSED path — NOT overdraw
    await insertWork(db, SHOP, oid(4), { outcome: "PROJECTED" });
    expect(await countOverdraw(db, { shop: SHOP })).toBe(2);
  });

  it("countOverdraw honors the since bound", async () => {
    await insertWork(db, SHOP, oid(1), {
      outcome: "CONSUMED_NO_RECORD",
      doneAt: dbWallPlus(-2 * 86_400_000), // 2 days ago
      updatedAt: dbWallPlus(-2 * 86_400_000),
    });
    const now = Date.now();
    expect(await countOverdraw(db, { shop: SHOP, sinceMs: now - 86_400_000 })).toBe(0);
    expect(await countOverdraw(db, { shop: SHOP, sinceMs: now - 3 * 86_400_000 })).toBe(1);
  });

  // runMonitor's default settings reader would hit the app's default db —
  // inject a reader matching the row addSettings() wrote. The SQL under
  // test is shop selection, overdraw, stuck rows and heartbeat staleness.
  const onSettings = (over: Record<string, unknown> = {}) =>
    ({
      autoMergeEnabled: true,
      onboardingStartedAt: EPOCH1,
      onboardingCompletedAt: EPOCH1,
      mergeWindowHours: 24,
      checkoutDiscountEnabled: true,
      checkoutDiscountEnabledAt: EPOCH1,
      checkoutDiscountNodeId: "gid://shopify/DiscountAutomaticNode/1",
      checkoutDiscountWindowHours: 24,
      ...over,
    }) as any;
  const monitorDeps = (settings: any) => ({
    db,
    shop: SHOP,
    noAdmin: true,
    env: (n: string) => (n === "MERGESHIP_CHECKOUT_DISCOUNT" ? "enabled" : undefined),
    settings: async () => settings,
    control: async () => ({ checkoutDiscountEnabled: true, checkoutDiscountAllowShops: [SHOP] }),
  });

  it("monitor: PENDING_SHUTDOWN for flag-on + failing lever; WORK_STUCK for REVIEW rows", async () => {
    // autoMergeEnabled=false + checkout flag on = the enforcer's pending marker.
    await addSettings(SHOP, {
      checkoutDiscountEnabled: true,
      checkoutDiscountEnabledAt: EPOCH1,
      checkoutDiscountWindowHours: 24,
      autoMergeEnabled: false,
    });
    await insertWork(db, SHOP, oid(1), { status: "REVIEW", outcome: "EXHAUSTED" });
    const fs = await runMonitor(monitorDeps(onSettings({ autoMergeEnabled: false })));
    const codes = fs.map((f) => f.code).sort();
    expect(codes).toContain("PENDING_SHUTDOWN");
    expect(codes).toContain("WORK_STUCK");
    expect(codes).toContain("SWEEPER_STALE"); // no heartbeat rows
  });

  it("monitor: a fresh heartbeat suppresses SWEEPER_STALE; clean work table suppresses WORK_STUCK", async () => {
    await addSettings(SHOP, {
      checkoutDiscountEnabled: true,
      checkoutDiscountEnabledAt: EPOCH1,
      checkoutDiscountWindowHours: 24,
    });
    await db.$executeRaw`
      INSERT INTO "WorkerInstance" ("instanceId", "startedAt", "heartbeatAt")
      VALUES ('wi-1', clock_timestamp() AT TIME ZONE 'UTC', clock_timestamp() AT TIME ZONE 'UTC')`;
    await insertWork(db, SHOP, oid(1), { status: "DONE", outcome: "PROJECTED" });
    const fs = await runMonitor(monitorDeps(onSettings()));
    expect(fs).toEqual([]);
  });

  it("monitor: a PENDING row untouched >30min while the gate is on is WORK_STUCK", async () => {
    await addSettings(SHOP, {
      checkoutDiscountEnabled: true,
      checkoutDiscountEnabledAt: EPOCH1,
      checkoutDiscountWindowHours: 24,
    });
    await db.$executeRaw`
      INSERT INTO "WorkerInstance" ("instanceId", "startedAt", "heartbeatAt")
      VALUES ('wi-1', clock_timestamp() AT TIME ZONE 'UTC', clock_timestamp() AT TIME ZONE 'UTC')`;
    // stale PENDING (updated >30min ago) vs fresh PENDING
    await db.$executeRaw`
      INSERT INTO "CheckoutEligibilityWork"
        ("id", "shop", "orderId", "gen", "status", "attempts", "createdAt", "updatedAt")
      VALUES
        (${crypto.randomUUID()}, ${SHOP}, ${oid(1)}, 1, 'PENDING', 1,
         ${dbWallPlus(-3_600_000)}, ${dbWallPlus(-3_600_000)}),
        (${crypto.randomUUID()}, ${SHOP}, ${oid(2)}, 1, 'PENDING', 1,
         clock_timestamp() AT TIME ZONE 'UTC', clock_timestamp() AT TIME ZONE 'UTC')`;
    const fs = await runMonitor(monitorDeps(onSettings()));
    expect(fs.map((f) => f.code)).toEqual(["WORK_STUCK"]);
  });
});
