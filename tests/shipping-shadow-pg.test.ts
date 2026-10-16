// Real-Postgres tests for the Shipping v0 shadow evaluator (Phase 1.1).
// Opt-in:
//
//   MERGESHIP_TEST_DATABASE_URL=postgresql://postgres@localhost:54329/mergeship_test \
//   MERGESHIP_SHADOW_TOKEN=<operator token> \
//     npx vitest run tests/shipping-shadow-pg.test.ts
//
// The URL must point at a DISPOSABLE database provisioned via
// scripts/test-db-provision.ts — `prisma migrate deploy` runs against it and
// tables are truncated between tests. `preflightDisposableDatabase` runs
// BEFORE any write and refuses unless the database already carries the
// `mergeship-shadow-disposable:<MERGESHIP_SHADOW_TOKEN>` marker; this suite
// never stamps the marker itself.
//
// The database's session timezone is Asia/Tokyo (postgres-stores setup), so
// every timestamp-write discipline error actually surfaces; one test asserts
// the naive-UTC round trip explicitly.

import { execSync } from "child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { AdminClient } from "../app/lib/graphql.server";
import { OwnershipLostError } from "../app/lib/ownership.server";
import { makeOperationStore, type OperationStore } from "../app/lib/operation-store.server";
import {
  GateChangedError,
  makeShippingShadowStore,
  runShadowScan,
  SHADOW_DB_MARKER_PREFIX,
  ShadowDatabaseNotAllowedError,
  type ShadowIntentIdentity,
} from "../app/lib/shipping-shadow.server";
import {
  DEFAULT_SETTINGS,
  setShippingAdjustmentEnabled,
  type MergeSettings,
} from "../app/lib/settings.server";
import { bootstrapDisposableDatabase } from "../app/lib/shadow-db-bootstrap.server";
import {
  preflightDisposableDatabase,
  withScratchDatabase,
  type PreflightedDatabase,
} from "./helpers/disposable-db";

const TEST_URL = process.env.MERGESHIP_TEST_DATABASE_URL;
const SHOP = "pg-shadow.myshopify.com";
const oid = (n: number) => `gid://shopify/Order/${n}`;
const DB_NAME = TEST_URL
  ? new globalThis.URL(TEST_URL).pathname.replace(/^\//, "").split("?")[0]
  : "";
// The token comes from the operator's shell — the suite never defines or
// stamps it. preflightDisposableDatabase already verified the marker on the
// database equals mergeship-shadow-disposable:<this token>.
const TOKEN = process.env.MERGESHIP_SHADOW_TOKEN ?? "";
const MARKER = `${SHADOW_DB_MARKER_PREFIX}${TOKEN}`;

const OP_CREATED = new Date("2030-10-20T12:00:00Z"); // after any stamped epoch

describe.skipIf(!TEST_URL)("shipping shadow store (real disposable database)", () => {
  let db: PrismaClient;
  let db2: PrismaClient;
  let ops: OperationStore;
  let savedShadowDb: string | undefined;
  let preflighted: PreflightedDatabase;

  beforeAll(async () => {
    // FIRST — before migrations, comments or any write. Throws unless the
    // target is an independently marked disposable database. The returned
    // brand is the only credential that may authorize scratch databases.
    preflighted = await preflightDisposableDatabase(TEST_URL!);
    execSync("npx prisma migrate deploy", {
      env: { ...process.env, DATABASE_URL: TEST_URL! },
      stdio: "pipe",
    });
    db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    db2 = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    if (!/^[A-Za-z0-9_]+$/.test(DB_NAME)) {
      throw new Error(`Unexpected test database name '${DB_NAME}'.`);
    }
    savedShadowDb = process.env.MERGESHIP_SHADOW_DATABASE;
    process.env.MERGESHIP_SHADOW_DATABASE = DB_NAME;
    ops = makeOperationStore(db);
  }, 120_000);

  afterAll(async () => {
    if (savedShadowDb === undefined) delete process.env.MERGESHIP_SHADOW_DATABASE;
    else process.env.MERGESHIP_SHADOW_DATABASE = savedShadowDb;
    await db?.$disconnect();
    await db2?.$disconnect();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(
      `TRUNCATE "ShippingAdjustment", "MergeOperation", "MergeRecord",
       "MergeMutationAttempt", "Settings", "AppControl" RESTART IDENTITY CASCADE`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "AppControl" ("id", "updatedAt") VALUES ('control', now())`,
    );
  });

  const rowFor = (sourceOrderId = oid(200)) =>
    db.$queryRaw<
      any[]
    >`SELECT * FROM "ShippingAdjustment" WHERE "shop" = ${SHOP} AND "sourceOrderId" = ${sourceOrderId}`;

  /** Enable every gate through the REAL write paths — this is also the
   *  epoch-stamping coverage: setControl + setShippingAdjustmentEnabled. */
  const setupGate = async (): Promise<Date> => {
    await ops.setControl({
      shippingAdjustmentsEnabled: true,
      shippingAllowShops: [SHOP],
    });
    await setShippingAdjustmentEnabled(SHOP, true, db);
    const s = await db.settings.findUnique({ where: { shop: SHOP } });
    const c = await ops.getControl();
    const cutoff = new Date(
      Math.max(
        c!.shippingEnabledAt!.getTime(),
        s!.shippingRolloutAt!.getTime(),
        s!.shippingAdjustmentEnabledAt!.getTime(),
      ),
    );
    return cutoff;
  };

  const identity = (
    cutoff: Date,
    sourceOrderId = oid(200),
    mergeOperationId = "op-1",
  ): ShadowIntentIdentity => ({
    shop: SHOP,
    mergeOperationId,
    sourceOrderId,
    operationCreatedAt: OP_CREATED,
    activationCutoffAt: cutoff,
    policyKind: "REFUND_ALL",
    policyRetainedMinor: null,
    policyCurrencyCode: null,
  });

  // ── Write guard (H1) ──────────────────────────────────────────────────────

  it("refuses every write when MERGESHIP_SHADOW_DATABASE is unset", async () => {
    const cutoff = await setupGate();
    delete process.env.MERGESHIP_SHADOW_DATABASE;
    const store = makeShippingShadowStore(db);
    await expect(store.claimIntent(identity(cutoff), 60_000)).rejects.toBeInstanceOf(
      ShadowDatabaseNotAllowedError,
    );
    await expect(
      store.recordTerminal(identity(cutoff), "SKIPPED", { reasonCode: "X" }),
    ).rejects.toBeInstanceOf(ShadowDatabaseNotAllowedError);
    // Reads are unaffected — the guard only gates writes.
    await expect(store.findAdjustments(SHOP, [oid(200)])).resolves.toEqual([]);
    process.env.MERGESHIP_SHADOW_DATABASE = DB_NAME;
  });

  it("refuses writes when the env var names a different database", async () => {
    const cutoff = await setupGate();
    process.env.MERGESHIP_SHADOW_DATABASE = "some_other_database";
    const store = makeShippingShadowStore(db);
    await expect(store.claimIntent(identity(cutoff), 60_000)).rejects.toBeInstanceOf(
      ShadowDatabaseNotAllowedError,
    );
    process.env.MERGESHIP_SHADOW_DATABASE = DB_NAME;
  });

  it("refuses writes when MERGESHIP_SHADOW_TOKEN does not match the database marker", async () => {
    const cutoff = await setupGate();
    process.env.MERGESHIP_SHADOW_TOKEN = "spoofed-token-9999";
    const store = makeShippingShadowStore(db);
    await expect(store.claimIntent(identity(cutoff), 60_000)).rejects.toBeInstanceOf(
      ShadowDatabaseNotAllowedError,
    );
    process.env.MERGESHIP_SHADOW_TOKEN = TOKEN;
  });

  it("refuses writes when the database carries NO disposable marker", async () => {
    // A scratch database (empty by construction, dropped afterwards) — the
    // suite never un-marks or re-marks the real test database.
    const cutoff = await setupGate();
    await withScratchDatabase(preflighted, async (scratchUrl, scratchName) => {
      const saved = process.env.MERGESHIP_SHADOW_DATABASE;
      process.env.MERGESHIP_SHADOW_DATABASE = scratchName;
      try {
        const sdb = new PrismaClient({ datasources: { db: { url: scratchUrl } } });
        try {
          const store = makeShippingShadowStore(sdb);
          await expect(store.claimIntent(identity(cutoff), 60_000)).rejects.toBeInstanceOf(
            ShadowDatabaseNotAllowedError,
          );
        } finally {
          await sdb.$disconnect();
        }
      } finally {
        process.env.MERGESHIP_SHADOW_DATABASE = saved!;
      }
    });
  });

  it("refuses writes when a production environment marker is set", async () => {
    const cutoff = await setupGate();
    process.env.RAILWAY_PROJECT_ID = "test-prod-marker";
    const store = makeShippingShadowStore(db);
    await expect(store.claimIntent(identity(cutoff), 60_000)).rejects.toBeInstanceOf(
      ShadowDatabaseNotAllowedError,
    );
    delete process.env.RAILWAY_PROJECT_ID;
  });

  // ── Activation epochs (B1) ────────────────────────────────────────────────

  it("setControl stamps the kill-switch epoch on enable and clears it on disable", async () => {
    await ops.setControl({ shippingAdjustmentsEnabled: true });
    const c1 = await ops.getControl();
    expect(c1!.shippingEnabledAt).toBeInstanceOf(Date);
    // Idempotent re-enable keeps the epoch.
    await ops.setControl({ shippingAdjustmentsEnabled: true });
    expect((await ops.getControl())!.shippingEnabledAt!.getTime()).toBe(
      c1!.shippingEnabledAt!.getTime(),
    );
    // Disable clears; re-enable stamps a NEW epoch.
    await ops.setControl({ shippingAdjustmentsEnabled: false });
    expect((await ops.getControl())!.shippingEnabledAt).toBeNull();
    await ops.setControl({ shippingAdjustmentsEnabled: true });
    const c2 = await ops.getControl();
    expect(c2!.shippingEnabledAt!.getTime()).toBeGreaterThanOrEqual(
      c1!.shippingEnabledAt!.getTime(),
    );
  });

  it("allowlist membership stamps/clears Settings.shippingRolloutAt atomically", async () => {
    await ops.setControl({ shippingAllowShops: [SHOP] });
    const s1 = await db.settings.findUnique({ where: { shop: SHOP } });
    expect(s1!.shippingRolloutAt).toBeInstanceOf(Date);
    // Removal clears the epoch.
    await ops.setControl({ shippingAllowShops: [] });
    expect(
      (await db.settings.findUnique({ where: { shop: SHOP } }))!.shippingRolloutAt,
    ).toBeNull();
    // Re-add stamps a NEW epoch — combines from the gap never qualify.
    await ops.setControl({ shippingAllowShops: [SHOP] });
    const s2 = await db.settings.findUnique({ where: { shop: SHOP } });
    expect(s2!.shippingRolloutAt!.getTime()).toBeGreaterThanOrEqual(
      s1!.shippingRolloutAt!.getTime(),
    );
    // An unrelated allowlist entry does not disturb the shop's epoch.
    await ops.setControl({ shippingAllowShops: [SHOP, "other.myshopify.com"] });
    expect(
      (await db.settings.findUnique({ where: { shop: SHOP } }))!.shippingRolloutAt!.getTime(),
    ).toBe(s2!.shippingRolloutAt!.getTime());
  });

  it("merchant opt-in stamps its own epoch; disable clears it", async () => {
    await setShippingAdjustmentEnabled(SHOP, true, db);
    const s1 = await db.settings.findUnique({ where: { shop: SHOP } });
    expect(s1!.shippingAdjustmentEnabledAt).toBeInstanceOf(Date);
    await setShippingAdjustmentEnabled(SHOP, false, db);
    const s2 = await db.settings.findUnique({ where: { shop: SHOP } });
    expect(s2!.shippingAdjustmentEnabled).toBe(false);
    expect(s2!.shippingAdjustmentEnabledAt).toBeNull();
  });

  // ── Claim/settle semantics ────────────────────────────────────────────────

  it("two concurrent claims produce exactly one intent row", async () => {
    const cutoff = await setupGate();
    const s1 = makeShippingShadowStore(db);
    const s2 = makeShippingShadowStore(db2);
    const [a, b] = await Promise.all([
      s1.claimIntent(identity(cutoff), 60_000),
      s2.claimIntent(identity(cutoff), 60_000),
    ]);
    const claimed = [a, b].filter((r) => r !== null && r !== "GATE_CHANGED");
    expect(claimed).toHaveLength(1);
    expect(await rowFor()).toHaveLength(1);
    expect((await rowFor())[0].mode).toBe("SHADOW");
  });

  it("claimIntent returns GATE_CHANGED when the cutoff moved under the gate", async () => {
    const cutoff = await setupGate();
    const store = makeShippingShadowStore(db);
    const wrong = new Date(cutoff.getTime() - 60_000); // a stale snapshot
    expect(await store.claimIntent(identity(wrong), 60_000)).toBe("GATE_CHANGED");
    expect(await rowFor()).toHaveLength(0);
  });

  it("a live-leased PENDING row cannot be re-leased or settled by another token", async () => {
    const cutoff = await setupGate();
    const store = makeShippingShadowStore(db);
    const claimed = (await store.claimIntent(identity(cutoff), 60_000))!;
    expect(claimed).not.toBe("GATE_CHANGED");
    const row = claimed as { id: string; leaseToken: string };
    expect(await store.reclaimIntent(row.id, "other-token", 60_000)).toBeNull();
    await expect(
      store.settleIntent(row.id, "stale", { status: "SKIPPED", reasonCode: "X" }),
    ).rejects.toBeInstanceOf(OwnershipLostError);
    await store.settleIntent(row.id, row.leaseToken, {
      status: "READY",
      sourceShippingMinor: "800",
      plannedRefundMinor: "800",
      currencyCode: "USD",
      previewEvidence: { ok: true },
      requestPayload: { orderId: oid(200) },
      requestHash: "a".repeat(64),
    });
    const [r] = await rowFor();
    expect(r.status).toBe("READY");
    expect(r.plannedRefundMinor).toBe("800");
  });

  it("a READY settle races a control change: refused, the row survives for re-evaluation", async () => {
    const cutoff = await setupGate();
    const store = makeShippingShadowStore(db);
    const claimed = (await store.claimIntent(identity(cutoff), 60_000)) as any;
    // The kill switch toggles between claim and settle — the FOR SHARE
    // recompute inside the settle transaction must see it.
    await ops.setControl({ shippingAdjustmentsEnabled: false });
    await expect(
      store.settleIntent(claimed.id, claimed.leaseToken, {
        status: "READY",
        sourceShippingMinor: "800",
        plannedRefundMinor: "800",
        currencyCode: "USD",
      }),
    ).rejects.toBeInstanceOf(GateChangedError);
    // The row is still PENDING — nothing misleading was written.
    expect((await rowFor())[0].status).toBe("PENDING");
    // A deterministic non-READY verdict is still writable.
    await store.settleIntent(claimed.id, claimed.leaseToken, {
      status: "REVIEW_REQUIRED",
      reviewReason: "gate changed mid-flight",
    });
    expect((await rowFor())[0].status).toBe("REVIEW_REQUIRED");
  });

  it("an expired lease is re-leasable exactly once — two workers race, one wins", async () => {
    const cutoff = await setupGate();
    const s1 = makeShippingShadowStore(db);
    const s2 = makeShippingShadowStore(db2);
    const claimed = (await s1.claimIntent(identity(cutoff), 60_000)) as any;
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
    const loserToken = a ? "tok-b" : "tok-a";
    await expect(
      s2.settleIntent(claimed.id, loserToken, { status: "SKIPPED", reasonCode: "X" }),
    ).rejects.toBeInstanceOf(OwnershipLostError);
  });

  it("terminal rows are never re-leased or rewritten", async () => {
    const cutoff = await setupGate();
    const store = makeShippingShadowStore(db);
    expect(
      await store.recordTerminal(identity(cutoff), "SKIPPED", {
        reasonCode: "BEFORE_EPOCH",
        reviewReason: "predates epoch",
      }),
    ).toBe(true);
    expect(
      await store.recordTerminal(identity(cutoff), "REVIEW_REQUIRED", { reviewReason: "x" }),
    ).toBe(false);
    const [row] = await rowFor();
    expect(row.status).toBe("SKIPPED");
    expect(row.reasonCode).toBe("BEFORE_EPOCH");
    expect(await store.claimIntent(identity(cutoff), 60_000)).toBeNull();
  });

  it("a rescheduled intent is not reclaimed before nextCheckAt, and is when due", async () => {
    const cutoff = await setupGate();
    const store = makeShippingShadowStore(db);
    const claimed = (await store.claimIntent(identity(cutoff), 60_000)) as any;
    await store.rescheduleIntent(claimed.id, claimed.leaseToken, 300_000, "TRANSIENT");
    expect(await store.reclaimIntent(claimed.id, "tok-b", 60_000)).toBeNull();
    const [deferred] = await rowFor();
    expect(deferred.status).toBe("PENDING");
    expect(deferred.leaseToken).toBeNull();
    const claimed2 = (await store.claimIntent(identity(cutoff, oid(202)), 60_000)) as any;
    await store.rescheduleIntent(claimed2.id, claimed2.leaseToken, 0, "TRANSIENT");
    const reclaimed = await store.reclaimIntent(claimed2.id, "tok-c", 60_000);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.leaseToken).toBe("tok-c");
  });

  it("RETAIN_FIXED snapshots satisfy the CHECK constraint", async () => {
    const cutoff = await setupGate();
    const store = makeShippingShadowStore(db);
    const claimed = await store.claimIntent(
      {
        ...identity(cutoff, oid(201)),
        policyKind: "RETAIN_FIXED",
        policyRetainedMinor: "300",
        policyCurrencyCode: "USD",
      },
      60_000,
    );
    expect(claimed).not.toBeNull();
    expect((claimed as any).policyKind).toBe("RETAIN_FIXED");
    expect((claimed as any).policyRetainedMinor).toBe("300");
  });

  it("naive-UTC timestamp round trip is exact under a non-UTC session", async () => {
    const cutoff = await setupGate();
    const store = makeShippingShadowStore(db);
    const exact = new Date("2030-10-20T12:00:00.000Z");
    await store.claimIntent(
      { ...identity(cutoff, oid(203)), operationCreatedAt: exact },
      60_000,
    );
    // The suite already runs under a non-UTC session; prove the raw stored
    // value is the naive UTC wall clock, not a Tokyo-shifted bind.
    const [{ tz }] = await db.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
    expect(tz).not.toBe("UTC");
    const [row] = await rowFor(oid(203));
    expect(new Date(row.operationCreatedAt).getTime()).toBe(exact.getTime());
    expect(new Date(row.activationCutoffAt).getTime()).toBe(cutoff.getTime());
  });

  // ── End-to-end scans over real merge rows ─────────────────────────────────

  const MONEY = (amount: string, currencyCode = "USD") => ({ amount, currencyCode });

  const cannedAdmin = (): AdminClient => {
    const order = {
      id: oid(200),
      name: "#2000",
      test: true,
      cancelledAt: "2030-10-20T12:05:00Z",
      closedAt: "2030-10-20T12:06:00Z",
      closed: true,
      displayFinancialStatus: "PAID",
      currencyCode: "USD",
      presentmentCurrencyCode: "USD",
      taxesIncluded: false,
      totalRefundedShippingSet: { presentmentMoney: MONEY("0.00") },
      totalRefundedSet: { presentmentMoney: MONEY("0.00") },
      shippingLines: {
        nodes: [
          {
            title: "Standard",
            originalPriceSet: { presentmentMoney: MONEY("8.00") },
            discountedPriceSet: { presentmentMoney: MONEY("8.00") },
            taxLines: [],
          },
        ],
        pageInfo: { hasNextPage: false },
      },
      refunds: [],
      transactions: [
        {
          id: "txn-cap",
          kind: "CAPTURE",
          status: "SUCCESS",
          gateway: "bogus",
          test: true,
          amountSet: { presentmentMoney: MONEY("18.00") },
          parentTransaction: null,
        },
      ],
    };
    const preview = {
      suggestedRefund: {
        amountSet: { presentmentMoney: MONEY("8.00") },
        maximumRefundableSet: { presentmentMoney: MONEY("18.00") },
        shipping: {
          amountSet: { presentmentMoney: MONEY("8.00") },
          taxSet: { presentmentMoney: MONEY("0.00") },
          maximumRefundableSet: { presentmentMoney: MONEY("8.00") },
        },
        suggestedTransactions: [
          {
            kind: "SUGGESTED_REFUND",
            gateway: "bogus",
            amountSet: { presentmentMoney: MONEY("8.00") },
            parentTransaction: {
              id: "txn-cap",
              kind: "CAPTURE",
              status: "SUCCESS",
              gateway: "bogus",
              test: true,
            },
          },
        ],
      },
    };
    return {
      graphql: async (query: string) =>
        ({
          json: async () => ({
            data: { order: query.includes("suggestedRefund") ? preview : order },
          }),
        }) as any,
    };
  };

  /** Seed a real COMPLETED native-v2 op + MergeRecord + attempts — the same
   *  columns the live engine writes, mapped through raw SQL. */
  const seedOp = async (
  i: number,
  secondaryId = oid(200),
  createdAt = OP_CREATED,
  cleanup: { stopped?: boolean; deferred?: boolean } = {},
) => {
    const opId = `e2e-op-${i}`;
    const primaryId = oid(9000 + i);
    const secondary = {
      id: secondaryId,
      name: `#${2000 + i}`,
      items: 1,
      done: true,
      cancelPhase: "CANCEL_VERIFIED",
      cancelledAt: "2030-10-20T12:05:00Z",
      staffNoteMatched: true,
    };
    await db.mergeOperation.create({
      data: {
        id: opId,
        shop: SHOP,
        status: "COMPLETED",
        primaryOrderId: primaryId,
        primaryOrderName: `#${9000 + i}`,
        primaryLineItemCountBefore: 1,
        addedLineItemCount: 1,
        protocolVersion: 2,
        phase: "COMPLETED",
        opToken: `TK${String(i).padStart(6, "0")}`,
        secondaries: [secondary],
        involvedOrderIds: [primaryId, secondaryId],
        calculatedOrderId: `calc-${opId}`,
        expectedTransfer: [
          {
            secondaryId,
            secondaryIndex: 1,
            lines: [{ sourceLineItemId: "l", variantId: "v", quantity: 1 }],
          },
        ],
        appliedEvidence: {
          agreementId: "ag",
          happenedAt: "2030-10-20T12:01:00Z",
          lines: [{ secondaryId, lineItemId: "li", variantId: "v", quantity: 1 }],
        },
        firstDispatchAt: createdAt,
        // stopped=true mirrors the worker give-up state (schedule cleared);
        // deferred=true mirrors cleanup still scheduled — e.g. merge
        // completion disabled while shipping evaluation is on.
        sideEffectsDone: !(cleanup.stopped || cleanup.deferred),
        nextCheckAt: cleanup.deferred ? new Date(Date.now() - 60_000) : null,
        createdAt,
      },
    });
    await db.mergeRecord.create({
      data: {
        id: `mr-${opId}`,
        shop: SHOP,
        primaryOrderId: primaryId,
        primaryOrderName: `#${9000 + i}`,
        mergedOrderId: secondaryId,
        mergedOrderName: secondary.name,
        itemsCombined: 1,
        operationId: opId,
      },
    });
    await db.mergeMutationAttempt.createMany({
      data: [
        {
          id: `att-commit-${opId}`,
          operationId: opId,
          kind: "EDIT_COMMIT",
          targetOrderId: primaryId,
          attemptNo: 1,
          state: "SUCCEEDED",
          dispatchToken: `tok-${opId}`,
          dispatchedAt: OP_CREATED,
        },
        {
          id: `att-cancel-${opId}`,
          operationId: opId,
          kind: "ORDER_CANCEL",
          targetOrderId: secondaryId,
          attemptNo: 1,
          state: "SUCCEEDED",
          dispatchToken: `tok-${opId}`,
          dispatchedAt: OP_CREATED,
        },
      ],
    });
    return opId;
  };

  const settingsLoader = async (shop: string): Promise<MergeSettings> =>
    ((await db.settings.findUnique({ where: { shop } })) as MergeSettings | null) ??
    DEFAULT_SETTINGS;

  it("end-to-end: a real seeded combine scans to READY under a live gate", async () => {
    const cutoff = await setupGate();
    await seedOp(1);
    const store = makeShippingShadowStore(db);
    const report = await runShadowScan(
      { store, ops, settings: settingsLoader, adminFactory: async () => cannedAdmin() },
      { apply: true },
    );
    const rows = await db.$queryRaw<
      any[]
    >`SELECT * FROM "ShippingAdjustment" WHERE "shop" = ${SHOP}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("READY");
    expect(rows[0].mode).toBe("SHADOW");
    expect(rows[0].sourceOrderId).toBe(oid(200));
    expect(new Date(rows[0].activationCutoffAt).getTime()).toBe(cutoff.getTime());
    expect(new Date(rows[0].operationCreatedAt).getTime()).toBe(OP_CREATED.getTime());
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("READY");
  });

  it("end-to-end dry run evaluates real rows and writes nothing", async () => {
    await setupGate();
    await seedOp(1);
    const store = makeShippingShadowStore(db);
    const report = await runShadowScan(
      { store, ops, settings: settingsLoader, adminFactory: async () => cannedAdmin() },
      { apply: false },
    );
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("READY");
    expect(
      await db.$queryRaw<any[]>`SELECT * FROM "ShippingAdjustment" WHERE "shop" = ${SHOP}`,
    ).toHaveLength(0);
  });

  it("more than 50 completed combines do not starve — scans keep making progress", async () => {
    await setupGate();
    for (let i = 0; i < 60; i++) await seedOp(i, oid(3000 + i));
    const store = makeShippingShadowStore(db);
    await runShadowScan(
      { store, ops, settings: settingsLoader, adminFactory: async () => cannedAdmin() },
      { apply: true },
    );
    const afterFirst = await db.$queryRaw<
      any[]
    >`SELECT * FROM "ShippingAdjustment" WHERE "shop" = ${SHOP}`;
    expect(afterFirst.length).toBe(50);
    await runShadowScan(
      { store, ops, settings: settingsLoader, adminFactory: async () => cannedAdmin() },
      { apply: true },
    );
    const afterSecond = await db.$queryRaw<
      any[]
    >`SELECT * FROM "ShippingAdjustment" WHERE "shop" = ${SHOP}`;
    expect(afterSecond.length).toBe(60);
    expect(afterSecond.every((r) => r.status === "READY")).toBe(true);
  });

  it("two concurrent scans over real Postgres produce exactly one row per secondary", async () => {
    await setupGate();
    for (let i = 0; i < 8; i++) await seedOp(i, oid(4000 + i));
    const s1 = makeShippingShadowStore(db);
    const s2 = makeShippingShadowStore(db2);
    const [r1, r2] = await Promise.all([
      runShadowScan(
        { store: s1, ops, settings: settingsLoader, adminFactory: async () => cannedAdmin() },
        { apply: true },
      ),
      runShadowScan(
        { store: s2, ops: makeOperationStore(db2), settings: settingsLoader, adminFactory: async () => cannedAdmin() },
        { apply: true },
      ),
    ]);
    const rows = await db.$queryRaw<
      any[]
    >`SELECT * FROM "ShippingAdjustment" WHERE "shop" = ${SHOP}`;
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((r) => r.sourceOrderId)).size).toBe(8);
    expect(rows.every((r) => r.status === "READY")).toBe(true);
    // No scanner may report an error.
    for (const rep of [r1, r2]) {
      expect(rep.entries.filter((e) => e.outcome === "ERROR")).toHaveLength(0);
    }
  });

  it("a combine completed before rollout membership is durably SKIPPED (B1 end-to-end)", async () => {
    // Merchant opt-in + kill switch ON, but the shop is NOT yet allowlisted;
    // the combine completed in the past. The shop joins the rollout AFTER —
    // the stamped membership epoch postdates the combine's createdAt.
    await setShippingAdjustmentEnabled(SHOP, true, db);
    await ops.setControl({ shippingAdjustmentsEnabled: true });
    // Completed one hour before the rollout stamp — provably pre-membership.
    await seedOp(1, oid(200), new Date(Date.now() - 3_600_000));
    await ops.setControl({ shippingAllowShops: [SHOP] }); // rollout starts now
    const store = makeShippingShadowStore(db);
    const report = await runShadowScan(
      { store, ops, settings: settingsLoader, adminFactory: async () => cannedAdmin() },
      { apply: true },
    );
    const rows = await db.$queryRaw<
      any[]
    >`SELECT * FROM "ShippingAdjustment" WHERE "shop" = ${SHOP}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("SKIPPED");
    expect(rows[0].reasonCode).toBe("BEFORE_EPOCH");
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("SKIPPED");
  });

  // ── MEDIUM-1: cleanup-stopped combines cannot starve the scan window ──

  it("51 cleanup-stopped combines do not starve the one eligible combine", async () => {
    await setupGate();
    // 51 combines whose cleanup permanently stopped (sideEffectsDone=false
    // with nextCheckAt=null — the worker gave up), then one fully eligible
    // combine. Each stopped op gets a durable fail-closed REVIEW, so the
    // oldest-50 window keeps moving.
    for (let i = 0; i < 51; i++) {
      await seedOp(i, oid(5000 + i), new Date(Date.now() - (60 - i) * 60_000), {
        stopped: true,
      });
    }
    await seedOp(51, oid(5200), OP_CREATED);
    const store = makeShippingShadowStore(db);
    const scan = () =>
      runShadowScan(
        { store, ops, settings: settingsLoader, adminFactory: async () => cannedAdmin() },
        { apply: true },
      );
    await scan(); // the oldest 50 stopped ops → REVIEW rows
    await scan(); // the last stopped op + the eligible combine
    const rows = await db.$queryRaw<
      any[]
    >`SELECT * FROM "ShippingAdjustment" WHERE "shop" = ${SHOP}`;
    expect(rows).toHaveLength(52);
    expect(
      rows.filter(
        (r) => r.status === "REVIEW_REQUIRED" && r.reasonCode === "CLEANUP_STOPPED",
      ),
    ).toHaveLength(51);
    const ready = rows.filter((r) => r.status === "READY");
    expect(ready).toHaveLength(1);
    expect(ready[0].sourceOrderId).toBe(oid(5200));
  });

  it("cleanup-deferred combines (merge completion off, shipping on) do not starve the window", async () => {
    await setupGate();
    // Shipping evaluation is fully enabled for this shop while merge
    // completion is independently disabled — 51 combines sit with
    // sideEffectsDone=false and a scheduled nextCheckAt that will never run.
    for (let i = 0; i < 51; i++) {
      // e2e-op-0 gets a post-cutoff createdAt so that, once cleanup finishes,
      // it is genuinely eligible (the others would BEFORE_EPOCH-skip anyway).
      await seedOp(
        i,
        oid(5000 + i),
        i === 0 ? OP_CREATED : new Date(Date.now() - (60 - i) * 60_000),
        { deferred: true },
      );
    }
    await seedOp(51, oid(5200), OP_CREATED);
    const store = makeShippingShadowStore(db);
    const report = await runShadowScan(
      { store, ops, settings: settingsLoader, adminFactory: async () => cannedAdmin() },
      { apply: true },
    );
    const rows = await db.$queryRaw<
      any[]
    >`SELECT * FROM "ShippingAdjustment" WHERE "shop" = ${SHOP}`;
    // The eligible combine is evaluated NOW — deferred ops neither occupy
    // the window nor get durable rows while their fate is undecided.
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("READY");
    expect(rows[0].sourceOrderId).toBe(oid(5200));
    expect(report.entries.find((e) => e.sourceOrderId === oid(5200))?.outcome).toBe(
      "READY",
    );
    // A deferred op that later finishes cleanup becomes discoverable again.
    await db.mergeOperation.update({
      where: { id: "e2e-op-0" },
      data: { sideEffectsDone: true, nextCheckAt: null },
    });
    await runShadowScan(
      { store, ops, settings: settingsLoader, adminFactory: async () => cannedAdmin() },
      { apply: true },
    );
    const after = await db.$queryRaw<
      any[]
    >`SELECT * FROM "ShippingAdjustment" WHERE "shop" = ${SHOP} AND "sourceOrderId" = ${oid(5000)}`;
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("READY");
  });

  // ── Dry run: a due PENDING intent is reported, never reclaimed ──

  it("a dry run never reclaims or mutates a due PENDING intent", async () => {
    const cutoff = await setupGate();
    const store = makeShippingShadowStore(db);
    // ttl 0 → the lease is already expired and nextCheckAt is already due.
    const claimed = await store.claimIntent(identity(cutoff), 0);
    const rowId = (claimed as { id: string }).id;
    const before = await db.shippingAdjustment.findUniqueOrThrow({
      where: { id: rowId },
    });
    const report = await runShadowScan(
      { store, ops, settings: settingsLoader, adminFactory: async () => cannedAdmin() },
      { apply: false },
    );
    const after = await db.shippingAdjustment.findUniqueOrThrow({
      where: { id: rowId },
    });
    expect(after.status).toBe("PENDING");
    expect(after.attempts).toBe(before.attempts); // reclaim would increment
    expect(after.leaseToken).toBe(before.leaseToken); // lease untouched
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe(
      "PENDING_HELD",
    );
  });

  // ── MEDIUM-2: disposable bootstrap must prove the database is disposable ──

  const fingerprintOf = async (client: PrismaClient) => {
    const [r] = await client.$queryRaw<{ fp: string }[]>`
      SELECT current_database() || '@' ||
             COALESCE(host(inet_server_addr()), 'unix') || ':' ||
             COALESCE(inet_server_port()::text, '?') AS fp`;
    return r.fp;
  };
  const fingerprint = () => fingerprintOf(db);

  it("bootstrap marks a verified empty database", async () => {
    // A fresh scratch database is empty by construction — the test never
    // truncates a shared database to satisfy the bootstrap's emptiness check.
    await withScratchDatabase(preflighted, async (scratchUrl) => {
      execSync("npx prisma migrate deploy", {
        env: { ...process.env, DATABASE_URL: scratchUrl },
        stdio: "pipe",
      });
      const sdb = new PrismaClient({ datasources: { db: { url: scratchUrl } } });
      try {
        const fp = await fingerprintOf(sdb);
        const res = await bootstrapDisposableDatabase(sdb, {
          token: TOKEN,
          confirmDb: fp,
          disposableConfirmed: true,
        });
        expect(res.fingerprint).toBe(fp);
        const [m] = await sdb.$queryRaw<{ marker: string | null }[]>`
          SELECT shobj_description(
            (SELECT oid FROM pg_database WHERE datname = current_database()),
            'pg_database') AS marker`;
        expect(m.marker).toBe(MARKER);
      } finally {
        await sdb.$disconnect();
      }
    });
  });

  it("bootstrap refuses a wrong or missing fingerprint confirmation", async () => {
    await expect(
      bootstrapDisposableDatabase(db, {
        token: TOKEN,
        confirmDb: "prod-db@10.0.0.5:5432",
        disposableConfirmed: true,
      }),
    ).rejects.toThrow(/confirm-db/);
    await expect(
      bootstrapDisposableDatabase(db, {
        token: TOKEN,
        confirmDb: undefined,
        disposableConfirmed: true,
      }),
    ).rejects.toThrow(/confirm-db/);
  });

  it("bootstrap refuses without the explicit disposable flag", async () => {
    await expect(
      bootstrapDisposableDatabase(db, {
        token: TOKEN,
        confirmDb: await fingerprint(),
        disposableConfirmed: false,
      }),
    ).rejects.toThrow(/DISPOSABLE/);
  });

  it("bootstrap refuses under a production environment marker", async () => {
    process.env.RAILWAY_PROJECT_ID = "proj-x";
    try {
      await expect(
        bootstrapDisposableDatabase(db, {
          token: TOKEN,
          confirmDb: await fingerprint(),
          disposableConfirmed: true,
        }),
      ).rejects.toThrow(/refusing: Railway environment/);
    } finally {
      delete process.env.RAILWAY_PROJECT_ID;
    }
  });

  it("bootstrap refuses a database containing application rows", async () => {
    await withScratchDatabase(preflighted, async (scratchUrl) => {
      execSync("npx prisma migrate deploy", {
        env: { ...process.env, DATABASE_URL: scratchUrl },
        stdio: "pipe",
      });
      const sdb = new PrismaClient({ datasources: { db: { url: scratchUrl } } });
      try {
        await sdb.settings.create({ data: { shop: "live-shop.myshopify.com" } });
        await expect(
          bootstrapDisposableDatabase(sdb, {
            token: TOKEN,
            confirmDb: await fingerprintOf(sdb),
            disposableConfirmed: true,
          }),
        ).rejects.toThrow(/populated/);
      } finally {
        await sdb.$disconnect();
      }
    });
  });

  it("bootstrap refuses when application tables are missing entirely", async () => {
    // An unmigrated scratch database has no schema — a missing table must
    // never read as "empty".
    await withScratchDatabase(preflighted, async (scratchUrl) => {
      const sdb = new PrismaClient({ datasources: { db: { url: scratchUrl } } });
      try {
        await expect(
          bootstrapDisposableDatabase(sdb, {
            token: TOKEN,
            confirmDb: await fingerprintOf(sdb),
            disposableConfirmed: true,
          }),
        ).rejects.toThrow(/missing from schema/);
      } finally {
        await sdb.$disconnect();
      }
    });
  });
});
