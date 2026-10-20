// Real-Postgres tests for the Shipping v0 Phase 2 S1-D milestone: the
// §7.5 transactional admission claim and the §9.1 T1 lease operations in
// app/lib/shipping-refund-store.server.ts.
//
// Opt-in (the same disposable-database gate as the other real suites):
//
//   MERGESHIP_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:PORT/mergeship_test \
//   MERGESHIP_SHADOW_TOKEN=<operator token> \
//     npx vitest run tests/shipping-refund-admission-pg.test.ts
//
// `preflightDisposableDatabase` runs BEFORE any write and refuses unless the
// target already carries the mergeship-shadow-disposable:<token> marker.
//
// Destructive-scope note: ShippingRefundEvent is append-only — this suite
// never deletes or truncates it (the triggers refuse anyway). Tests isolate
// by unique shop/order/operation identities and leave their rows in place.
// Catalog-alteration cases run on a scratch database dropped afterwards.

import { execSync } from "child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  claimShippingRefund,
  claimTerminalShippingRefund,
  leaseQueuedShippingRefund,
  releaseQueuedShippingRefundLease,
  renewQueuedShippingRefundLease,
  SHIPPING_REFUND_LEASE_TTL_MS,
} from "../app/lib/shipping-refund-store.server";
import { OwnershipLostError } from "../app/lib/ownership.server";
import {
  preflightDisposableDatabase,
  withScratchDatabase,
  type PreflightedDatabase,
} from "./helpers/disposable-db";

const TEST_URL = process.env.MERGESHIP_TEST_DATABASE_URL;
const oid = (n: number) => `gid://shopify/Order/${n}`;

/** The naive-UTC timestamp bind (repository discipline). */
const naive = (iso: string) => Prisma.sql`(${iso}::timestamptz AT TIME ZONE 'UTC')`;

const EPOCH = "2026-10-10T00:00:00.000Z";
const OP_CREATED = "2026-10-15T09:12:03.000Z";
const CANCELLED = "2026-10-15T09:30:00.000Z";

describe.skipIf(!TEST_URL)(
  "shipping-refund S1-D admission & lease (real disposable database)",
  () => {
    let db: PrismaClient;
    let db2: PrismaClient;
    let preflighted: PreflightedDatabase;
    // The shared control singletons as they stood BEFORE this suite's first
    // write — restored wholesale in afterAll (F2) so a later suite on the
    // same disposable database (e.g. the S1-A schema suite) sees the state
    // it expects regardless of test order or mid-suite failure.
    let savedAppControl: {
      shippingAdjustmentsEnabled: boolean;
      shippingEnabledAt: Date | null;
      shippingAllowShops: string[];
    } | null;
    let savedExecuteControl: {
      admissionEnabled: boolean;
      admissionEnabledAt: Date | null;
      dispatchEnabled: boolean;
      dispatchEnabledAt: Date | null;
    } | null;

    beforeAll(async () => {
      // FIRST — before migrations or any write.
      preflighted = await preflightDisposableDatabase(TEST_URL!);
      execSync("npx prisma migrate deploy", {
        env: { ...process.env, DATABASE_URL: TEST_URL! },
        stdio: "pipe",
      });
      db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
      db2 = new PrismaClient({ datasources: { db: { url: TEST_URL } } });

      // Capture the pre-suite shared control state for afterAll restore.
      [savedAppControl] = await db.$queryRaw<{
        shippingAdjustmentsEnabled: boolean;
        shippingEnabledAt: Date | null;
        shippingAllowShops: string[];
      }[]>`
        SELECT "shippingAdjustmentsEnabled", "shippingEnabledAt", "shippingAllowShops"
        FROM "AppControl" WHERE "id" = 'control'`;
      [savedExecuteControl] = await db.$queryRaw<{
        admissionEnabled: boolean;
        admissionEnabledAt: Date | null;
        dispatchEnabled: boolean;
        dispatchEnabledAt: Date | null;
      }[]>`
        SELECT "admissionEnabled", "admissionEnabledAt", "dispatchEnabled", "dispatchEnabledAt"
        FROM "ShippingExecuteControl" WHERE "id" = 'control'`;

      // The two singletons: switch on at EPOCH with an empty allowlist —
      // each test appends its own shop; admission on, dispatch off.
      await db.$executeRaw`
        UPDATE "AppControl" SET
          "shippingAdjustmentsEnabled" = true,
          "shippingEnabledAt" = ${naive(EPOCH)}
        WHERE "id" = 'control'`;
      await db.$executeRaw`
        INSERT INTO "ShippingExecuteControl"
          ("id", "admissionEnabled", "admissionEnabledAt", "dispatchEnabled", "dispatchEnabledAt")
        VALUES ('control', true, ${naive(EPOCH)}, false, NULL)
        ON CONFLICT ("id") DO UPDATE SET
          "admissionEnabled" = true, "admissionEnabledAt" = ${naive(EPOCH)},
          "dispatchEnabled" = false, "dispatchEnabledAt" = NULL`;
    }, 120_000);

    afterAll(async () => {
      // F2: restore the shared control singletons to their pre-suite state —
      // runs even when tests failed part-way through a mutation.
      try {
        if (savedAppControl) {
          await db.$executeRaw`
            UPDATE "AppControl" SET
              "shippingAdjustmentsEnabled" = ${savedAppControl.shippingAdjustmentsEnabled},
              "shippingEnabledAt" = ${savedAppControl.shippingEnabledAt},
              "shippingAllowShops" = ${savedAppControl.shippingAllowShops}
            WHERE "id" = 'control'`;
        }
        if (savedExecuteControl) {
          await db.$executeRaw`
            UPDATE "ShippingExecuteControl" SET
              "admissionEnabled" = ${savedExecuteControl.admissionEnabled},
              "admissionEnabledAt" = ${savedExecuteControl.admissionEnabledAt},
              "dispatchEnabled" = ${savedExecuteControl.dispatchEnabled},
              "dispatchEnabledAt" = ${savedExecuteControl.dispatchEnabledAt}
            WHERE "id" = 'control'`;
        } else {
          await db.$executeRaw`DELETE FROM "ShippingExecuteControl" WHERE "id" = 'control'`;
        }
      } finally {
        await db?.$disconnect();
        await db2?.$disconnect();
      }
    });

    const uniqueShop = () => `s1d-${randomUUID()}.myshopify.com`;
    let orderSeq = 10_000;
    const nextOrder = () => oid(++orderSeq);
    let opSeq = 0;
    const nextOpId = () => `op_s1d_${++opSeq}_${randomUUID().slice(0, 8)}`;

    interface GateSeed {
      admissionEnabled?: boolean;
      admissionEnabledAt?: string | null;
      dispatchEnabled?: boolean;
      dispatchEnabledAt?: string | null;
      shopEnabled?: boolean;
      shopEnabledAt?: string | null;
      rolloutAt?: string | null;
      policy?: string;
      approvedAt?: string | null;
      revokedAt?: string | null;
      optInEpoch?: string;
      ackVersion?: string;
    }

    /** Seed the four gate inputs for a fresh shop, all epochs at EPOCH. */
    async function seedGate(shop: string, over: GateSeed = {}): Promise<void> {
      await db.$executeRaw`
        UPDATE "AppControl" SET
          "shippingAllowShops" = array_append("shippingAllowShops", ${shop})
        WHERE "id" = 'control'`;
      await db.$executeRaw`
        INSERT INTO "Settings" ("id", "shop", "shippingAdjustmentEnabled",
          "shippingAdjustmentEnabledAt", "shippingRolloutAt", "shippingPolicy")
        VALUES (${`set_${randomUUID()}`}, ${shop}, ${over.shopEnabled ?? true},
          ${naive(over.shopEnabledAt ?? EPOCH)}, ${naive(over.rolloutAt ?? EPOCH)},
          ${over.policy ?? "REFUND_ALL"})
        ON CONFLICT ("shop") DO UPDATE SET
          "shippingAdjustmentEnabled" = EXCLUDED."shippingAdjustmentEnabled",
          "shippingAdjustmentEnabledAt" = EXCLUDED."shippingAdjustmentEnabledAt",
          "shippingRolloutAt" = EXCLUDED."shippingRolloutAt",
          "shippingPolicy" = EXCLUDED."shippingPolicy"`;
      await db.$executeRaw`
        UPDATE "ShippingExecuteControl" SET
          "admissionEnabled" = ${over.admissionEnabled ?? true},
          "admissionEnabledAt" = ${naive(over.admissionEnabledAt ?? EPOCH)},
          "dispatchEnabled" = ${over.dispatchEnabled ?? false},
          "dispatchEnabledAt" = ${over.dispatchEnabledAt === undefined || over.dispatchEnabledAt === null
            ? Prisma.sql`NULL`
            : naive(over.dispatchEnabledAt)}
        WHERE "id" = 'control'`;
      await db.$executeRaw`
        INSERT INTO "ShippingExecuteApproval"
          ("shop", "approvedAt", "approvedBy", "revokedAt", "merchantOptInEpoch",
           "ackVersion", "ackRecordedAt", "currencyCode", "maxRefundMinor")
        VALUES (${shop}, ${naive(over.approvedAt ?? EPOCH)}, 's1d-test',
          ${over.revokedAt ? naive(over.revokedAt) : Prisma.sql`NULL`},
          ${naive(over.optInEpoch ?? EPOCH)}, ${over.ackVersion ?? "v1"},
          ${naive(EPOCH)}, 'USD', '0')
        ON CONFLICT ("shop") DO UPDATE SET
          "approvedAt" = EXCLUDED."approvedAt",
          "revokedAt" = EXCLUDED."revokedAt",
          "merchantOptInEpoch" = EXCLUDED."merchantOptInEpoch",
          "ackVersion" = EXCLUDED."ackVersion"`;
    }

    interface OperationSeed {
      shop?: string;
      id?: string;
      primaryOrderId?: string;
      primaryOrderName?: string;
      createdAt?: string;
    }

    /** A completed v2 merge operation record, as the scanner reads it. */
    function operation(shop: string, over: OperationSeed = {}) {
      return {
        id: over.id ?? nextOpId(),
        shop: over.shop ?? shop,
        status: "COMPLETED",
        protocolVersion: 2,
        primaryOrderId: over.primaryOrderId ?? nextOrder(),
        primaryOrderName: over.primaryOrderName ?? "#1001",
        createdAt: over.createdAt ?? OP_CREATED,
        secondaries: [],
      };
    }

    const rowCount = (shop: string) =>
      db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM "ShippingRefund" WHERE "shop" = ${shop}`;

    const refundRow = (id: string) =>
      db.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM "ShippingRefund" WHERE "id" = $1`,
        id,
      );

    const eventsFor = (refundId: string) =>
      db.$queryRaw<
        { fromStatus: string | null; toStatus: string; actor: string; at: Date }[]
      >`
        SELECT "fromStatus", "toStatus", "actor", "at"
        FROM "ShippingRefundEvent" WHERE "shippingRefundId" = ${refundId}
        ORDER BY "at", "id"`;

    const dispatchEvidenceColumns = [
      "currencyCode", "plannedShippingMinor", "parentTransactionId", "gateway",
      "documentSha256", "wireVariables", "wireHash", "mutationVersion",
      "preEvidence", "preparedAt", "approvedWireHash", "approvedAt", "approvedBy",
      "dispatchToken", "dispatchedAt", "respondedAt", "responseKind",
      "responseSummary", "refundId", "refundCreatedAt", "settlementState",
      "settlementCheckAt", "verifiedEvidence", "verifiedAt",
      "resolvedAt", "resolvedBy", "resolution", "resolutionNote",
    ];

    function assertAllEvidenceNull(row: Record<string, unknown>) {
      for (const c of dispatchEvidenceColumns) {
        expect(row[c], `column ${c}`).toBeNull();
      }
    }

    // ── Happy path ──────────────────────────────────────────────────────

    it("claims a valid completed merge as one QUEUED OBSERVE row with the locked live snapshot", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const src = nextOrder();
      const res = await claimShippingRefund(
        { operation: operation(shop), secondary: { id: src, cancelledAt: CANCELLED } },
        db,
      );
      expect(res.claimed).toBe(true);
      if (!res.claimed) return;
      expect(res.status).toBe("QUEUED");
      expect(res.lane).toBe("OBSERVE");
      expect(res.leaseToken).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      const [row] = await refundRow(res.rowId);
      expect(row.shop).toBe(shop);
      expect(row.primaryOrderId).toMatch(/^gid:\/\/shopify\/Order\/[0-9]+$/);
      expect(row.sourceOrderId).toBe(src);
      expect(row.status).toBe("QUEUED");
      expect(row.lane).toBe("OBSERVE");
      expect(row.reasonCode).toBeNull();
      expect(row.reviewReason).toBeNull();
      expect(row.policyKind).toBe("REFUND_ALL");
      expect(row.attempts).toBe(1);
      expect(row.leaseToken).toBe(res.leaseToken);
      expect(row.nextCheckAt).toBeNull();
      expect((row.sourceCancelledAt as Date).toISOString()).toBe(CANCELLED);
      expect((row.operationCreatedAt as Date).toISOString()).toBe(OP_CREATED);
      // The stored snapshot IS the locked live state.
      for (const f of [
        "merchantEpochAt", "rolloutEpochAt", "switchEpochAt", "activationCutoffAt",
        "admissionEpochAt", "admissionCutoffAt", "approvalApprovedAt", "approvalOptInEpoch",
      ]) {
        expect((row[f] as Date).toISOString(), f).toBe(new Date(EPOCH).toISOString());
      }
      expect(row.dispatchEpochAtAdmission).toBeNull();
      expect(row.approvalAckVersion).toBe("v1");
      expect(row.idempotencyKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(row.marker).toMatch(/^MS-SHIPREFUND-[0-9a-f-]{36}$/);
      assertAllEvidenceNull(row);

      // 180-second lease on the DB wall clock.
      const [w] = await db.$queryRaw<{ wall: Date }[]>`
        SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "wall"`;
      const leaseMs = (row.leasedUntil as Date).getTime() - w.wall.getTime();
      expect(leaseMs).toBeGreaterThan(0);
      expect(leaseMs).toBeLessThanOrEqual(SHIPPING_REFUND_LEASE_TTL_MS);
      expect(leaseMs).toBeGreaterThan(SHIPPING_REFUND_LEASE_TTL_MS - 10_000);

      // The event trigger recorded the insert; nothing else wrote events.
      const events = await eventsFor(res.rowId);
      expect(events).toHaveLength(1);
      expect(events[0].fromStatus).toBeNull();
      expect(events[0].toStatus).toBe("QUEUED");
      expect(events[0].actor).toBe("shipping-refund-claim");
    });

    it("a repeated admission cannot create a duplicate", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const src = nextOrder();
      const input = { operation: operation(shop), secondary: { id: src, cancelledAt: CANCELLED } };
      const first = await claimShippingRefund(input, db);
      expect(first.claimed).toBe(true);
      const again = await claimShippingRefund(input, db);
      expect(again).toMatchObject({ claimed: false, code: "CONFLICT" });
      const [{ n }] = await rowCount(shop);
      expect(n).toBe(1n);
    });

    it("two competing claimants produce exactly one durable row", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const src = nextOrder();
      const input = { operation: operation(shop), secondary: { id: src, cancelledAt: CANCELLED } };
      const [a, b] = await Promise.all([
        claimShippingRefund(input, db),
        claimShippingRefund(input, db2),
      ]);
      const claimed = [a, b].filter((r) => r.claimed);
      const conflicts = [a, b].filter((r) => !r.claimed && r.code === "CONFLICT");
      expect(claimed).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
      const [{ n }] = await rowCount(shop);
      expect(n).toBe(1n);
    });

    it("a rolled-back competitor lets the other claimant in (no phantom conflict)", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const src = nextOrder();
      const op = operation(shop);

      // A holder inserts the same (shop, sourceOrderId) uncommitted, then
      // aborts: the claim's ON CONFLICT wait must resolve to an insert.
      let holderInserted: () => void = () => {};
      const inserted = new Promise<void>((r) => (holderInserted = r));
      const holder = db2
        .$transaction(async (tx) => {
          await tx.$executeRaw`
            INSERT INTO "ShippingRefund" (
              "id", "shop", "mergeOperationId", "sourceOrderId", "primaryOrderId",
              "primaryOrderName", "operationCreatedAt", "sourceCancelledAt",
              "lane", "status",
              "merchantEpochAt", "rolloutEpochAt", "switchEpochAt",
              "activationCutoffAt", "admissionEpochAt", "admissionCutoffAt",
              "dispatchEpochAtAdmission",
              "approvalApprovedAt", "approvalOptInEpoch", "approvalAckVersion",
              "policyKind", "idempotencyKey", "marker",
              "createdAt", "updatedAt"
            ) VALUES (
              ${`sr_holder_${randomUUID().replace(/-/g, "")}`}, ${shop}, ${op.id},
              ${src}, ${op.primaryOrderId}, ${op.primaryOrderName},
              ${naive(OP_CREATED)}, ${naive(CANCELLED)}, 'OBSERVE', 'QUEUED',
              ${naive(EPOCH)}, ${naive(EPOCH)}, ${naive(EPOCH)},
              ${naive(EPOCH)}, ${naive(EPOCH)}, ${naive(EPOCH)}, NULL,
              ${naive(EPOCH)}, ${naive(EPOCH)}, 'v1',
              'REFUND_ALL', ${randomUUID()}, ${`MS-SHIPREFUND-${randomUUID()}`},
              clock_timestamp() AT TIME ZONE 'UTC', clock_timestamp() AT TIME ZONE 'UTC'
            )`;
          holderInserted();
          await new Promise((r) => setTimeout(r, 400));
          throw new Error("holder abort — rollback");
        })
        .catch(() => {});

      await inserted;
      const res = await claimShippingRefund(
        { operation: op, secondary: { id: src, cancelledAt: CANCELLED } },
        db,
      );
      await holder;
      expect(res.claimed).toBe(true);
      const rows = await db.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "ShippingRefund"
        WHERE "shop" = ${shop} AND "sourceOrderId" = ${src}`;
      expect(rows).toHaveLength(1);
      if (res.claimed) expect(rows[0].id).toBe(res.rowId);
    });

    // ── Gate and epoch enforcement under the locks ──────────────────────

    it("a changed control epoch refuses admission (no row)", async () => {
      const shop = uniqueShop();
      try {
        // Admission enabled AFTER the operation's creation: E3 no retroactive.
        await seedGate(shop, { admissionEnabledAt: "2026-10-16T00:00:00.000Z" });
        const res = await claimShippingRefund(
          { operation: operation(shop), secondary: { id: nextOrder(), cancelledAt: CANCELLED } },
          db,
        );
        expect(res.claimed).toBe(false);
        if (res.claimed) return;
        expect(res.code).toBe("GATE_CLOSED");
        if (res.code === "GATE_CLOSED") {
          expect(res.gate.code).toBe("OPERATION_PREDATES_ADMISSION_CUTOFF");
        }
        const [{ n }] = await rowCount(shop);
        expect(n).toBe(0n);
      } finally {
        // Restore the shared singleton.
        await db.$executeRaw`
          UPDATE "ShippingExecuteControl" SET
            "admissionEnabled" = true, "admissionEnabledAt" = ${naive(EPOCH)},
            "dispatchEnabled" = false, "dispatchEnabledAt" = NULL
          WHERE "id" = 'control'`;
      }
    });

    it("a disabled admission switch refuses admission (no row)", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      await db.$executeRaw`
        UPDATE "ShippingExecuteControl" SET
          "admissionEnabled" = false, "admissionEnabledAt" = NULL
        WHERE "id" = 'control'`;
      try {
        const res = await claimShippingRefund(
          { operation: operation(shop), secondary: { id: nextOrder(), cancelledAt: CANCELLED } },
          db,
        );
        expect(res.claimed).toBe(false);
        if (!res.claimed && res.code === "GATE_CLOSED") {
          expect(res.gate.code).toBe("ADMISSION_DISABLED");
        }
      } finally {
        await db.$executeRaw`
          UPDATE "ShippingExecuteControl" SET
            "admissionEnabled" = true, "admissionEnabledAt" = ${naive(EPOCH)}
          WHERE "id" = 'control'`;
      }
      const [{ n }] = await rowCount(shop);
      expect(n).toBe(0n);
    });

    it("approval epoch mismatch and revocation refuse admission (no row)", async () => {
      const shopA = uniqueShop();
      await seedGate(shopA, { optInEpoch: "2026-10-11T00:00:00.000Z" });
      let res = await claimShippingRefund(
        { operation: operation(shopA), secondary: { id: nextOrder(), cancelledAt: CANCELLED } },
        db,
      );
      expect(res.claimed).toBe(false);
      if (!res.claimed && res.code === "GATE_CLOSED") {
        expect(res.gate.code).toBe("APPROVAL_OPT_IN_EPOCH_MISMATCH");
      }

      const shopB = uniqueShop();
      await seedGate(shopB, { revokedAt: "2026-10-12T00:00:00.000Z" });
      res = await claimShippingRefund(
        { operation: operation(shopB), secondary: { id: nextOrder(), cancelledAt: CANCELLED } },
        db,
      );
      expect(res.claimed).toBe(false);
      if (!res.claimed && res.code === "GATE_CLOSED") {
        expect(res.gate.code).toBe("APPROVAL_REVOKED");
      }
      for (const s of [shopA, shopB]) {
        const [{ n }] = await rowCount(s);
        expect(n).toBe(0n);
      }
    });

    it("a committed control change mid-claim is seen by the waiting claim", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      // A holder takes the AppControl row FOR UPDATE, disables admission
      // underneath the claim's FOR SHARE wait, then commits — the claim must
      // observe the committed closed gate (lock-order discipline, 4.10).
      let locked: () => void = () => {};
      const lockedP = new Promise<void>((r) => (locked = r));
      const holder = db2.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT "id" FROM "AppControl" WHERE "id" = 'control' FOR UPDATE`;
        locked();
        await tx.$executeRaw`SELECT pg_sleep(0.4)`;
        await tx.$executeRaw`
          UPDATE "ShippingExecuteControl" SET
            "admissionEnabled" = false, "admissionEnabledAt" = NULL
          WHERE "id" = 'control'`;
      });
      try {
        await lockedP;
        const res = await claimShippingRefund(
          { operation: operation(shop), secondary: { id: nextOrder(), cancelledAt: CANCELLED } },
          db,
        );
        await holder;
        // Either the claim waited and saw the closed gate, or its FOR SHARE
        // wait exceeded lock_timeout and the transaction threw. Both are
        // fail-closed; assert the durable state: no row was written.
        expect(res.claimed).toBe(false);
        const [{ n }] = await rowCount(shop);
        expect(n).toBe(0n);
      } finally {
        await holder.catch(() => {});
        await db.$executeRaw`
          UPDATE "ShippingExecuteControl" SET
            "admissionEnabled" = true, "admissionEnabledAt" = ${naive(EPOCH)}
          WHERE "id" = 'control'`;
      }
    });

    // ── F3: a committed change on EACH of the four locked gate rows ──────
    // is observed by a claim waiting on the corresponding FOR SHARE lock.

    it.each([
      {
        name: "AppControl (shipping switch off)",
        lock: `SELECT "id" FROM "AppControl" WHERE "id" = 'control' FOR UPDATE`,
        change: (shop: string) => Prisma.sql`
          UPDATE "AppControl" SET
            "shippingAdjustmentsEnabled" = false, "shippingEnabledAt" = NULL
          WHERE "id" = 'control'`,
      },
      {
        name: "Settings (merchant opt-in off)",
        lock: `SELECT "id" FROM "Settings" WHERE "shop" = $shop FOR UPDATE`,
        change: (shop: string) => Prisma.sql`
          UPDATE "Settings" SET
            "shippingAdjustmentEnabled" = false, "shippingAdjustmentEnabledAt" = NULL
          WHERE "shop" = ${shop}`,
      },
      {
        name: "ShippingExecuteApproval (revoked)",
        lock: `SELECT "shop" FROM "ShippingExecuteApproval" WHERE "shop" = $shop FOR UPDATE`,
        change: (shop: string) => Prisma.sql`
          UPDATE "ShippingExecuteApproval" SET
            "revokedAt" = clock_timestamp() AT TIME ZONE 'UTC'
          WHERE "shop" = ${shop}`,
      },
      {
        name: "ShippingExecuteControl (admission off)",
        lock: `SELECT "id" FROM "ShippingExecuteControl" WHERE "id" = 'control' FOR UPDATE`,
        change: (shop: string) => Prisma.sql`
          UPDATE "ShippingExecuteControl" SET
            "admissionEnabled" = false, "admissionEnabledAt" = NULL
          WHERE "id" = 'control'`,
      },
    ])("a committed gate change on $name mid-claim writes no row", async ({ lock, change }) => {
      const shop = uniqueShop();
      await seedGate(shop);
      let locked: () => void = () => {};
      const lockedP = new Promise<void>((r) => (locked = r));
      const holder = db2.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(lock.replace("$shop", `'${shop}'`));
        locked();
        await tx.$executeRaw`SELECT pg_sleep(0.4)`;
        await tx.$executeRaw`${change(shop)}`;
      });
      try {
        await lockedP;
        const res = await claimShippingRefund(
          { operation: operation(shop), secondary: { id: nextOrder(), cancelledAt: CANCELLED } },
          db,
        );
        await holder;
        expect(res.claimed).toBe(false);
        const [{ n }] = await rowCount(shop);
        expect(n).toBe(0n);
      } finally {
        await holder.catch(() => {});
        await db.$executeRaw`
          UPDATE "AppControl" SET
            "shippingAdjustmentsEnabled" = true, "shippingEnabledAt" = ${naive(EPOCH)}
          WHERE "id" = 'control'`;
        await db.$executeRaw`
          UPDATE "ShippingExecuteControl" SET
            "admissionEnabled" = true, "admissionEnabledAt" = ${naive(EPOCH)}
          WHERE "id" = 'control'`;
      }
    });

    it("a committed gate change mid-claim prevents a TERMINAL insertion too", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      let locked: () => void = () => {};
      const lockedP = new Promise<void>((r) => (locked = r));
      const holder = db2.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT "id" FROM "ShippingExecuteControl" WHERE "id" = 'control' FOR UPDATE`;
        locked();
        await tx.$executeRaw`SELECT pg_sleep(0.4)`;
        await tx.$executeRaw`
          UPDATE "ShippingExecuteControl" SET
            "admissionEnabled" = false, "admissionEnabledAt" = NULL
          WHERE "id" = 'control'`;
      });
      try {
        await lockedP;
        const res = await claimTerminalShippingRefund(
          { operation: operation(shop), secondary: { id: nextOrder(), cancelledAt: CANCELLED } },
          { status: "REVIEW_REQUIRED", reasonCode: "DATA_INVALID" },
          db,
        );
        await holder;
        expect(res.claimed).toBe(false);
        const [{ n }] = await rowCount(shop);
        expect(n).toBe(0n);
      } finally {
        await holder.catch(() => {});
        await db.$executeRaw`
          UPDATE "ShippingExecuteControl" SET
            "admissionEnabled" = true, "admissionEnabledAt" = ${naive(EPOCH)}
          WHERE "id" = 'control'`;
      }
    });

    it("a lease that expires while renewal waits for the row lock loses ownership", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const res = await claimShippingRefund(
        { operation: operation(shop), secondary: { id: nextOrder(), cancelledAt: CANCELLED } },
        db,
      );
      expect(res.claimed).toBe(true);
      if (!res.claimed || !res.leaseToken) return;

      // A short lease; the holder takes the row lock past its expiry.
      await db.$executeRaw`
        UPDATE "ShippingRefund" SET
          "leasedUntil" = clock_timestamp() AT TIME ZONE 'UTC' + interval '300 milliseconds'
        WHERE "id" = ${res.rowId}`;
      let locked: () => void = () => {};
      const lockedP = new Promise<void>((r) => (locked = r));
      const holder = db2.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "ShippingRefund" WHERE "id" = ${res.rowId} FOR UPDATE`;
        locked();
        await tx.$executeRaw`SELECT pg_sleep(1.0)`;
      });
      try {
        await lockedP;
        // The renewal waits on the row lock; by the time the conditional
        // UPDATE runs the lease has expired, so the token check fails.
        await expect(
          renewQueuedShippingRefundLease(res.rowId, res.leaseToken, db),
        ).rejects.toBeInstanceOf(OwnershipLostError);
        await holder;
        const [row] = await refundRow(res.rowId);
        expect(row.leaseToken).toBe(res.leaseToken);
      } finally {
        await holder.catch(() => {});
      }
    });

    it("a live foreign lease prevents the horizon abort; expiry re-enables it (F1)", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const res = await claimShippingRefund(
        {
          operation: operation(shop),
          secondary: { id: nextOrder(), cancelledAt: "2020-01-02T00:00:00.000Z" },
        },
        db,
      );
      expect(res.claimed).toBe(true);
      if (!res.claimed || !res.leaseToken) return;

      // The claim lease is live: a second lease attempt is fenced BEFORE the
      // horizon is considered — the row must stay QUEUED.
      expect(await leaseQueuedShippingRefund(res.rowId, {}, db2)).toEqual({
        leased: false,
        reason: "LEASE_HELD",
      });
      let [row] = await refundRow(res.rowId);
      expect(row.status).toBe("QUEUED");

      // Once the lease expires the row can legitimately be acquired, and the
      // horizon abort applies.
      await db.$executeRaw`
        UPDATE "ShippingRefund" SET
          "leasedUntil" = clock_timestamp() AT TIME ZONE 'UTC' - interval '1 second'
        WHERE "id" = ${res.rowId}`;
      expect(await leaseQueuedShippingRefund(res.rowId, {}, db)).toEqual({
        leased: false,
        reason: "HORIZON_EXPIRED",
      });
      [row] = await refundRow(res.rowId);
      expect(row.status).toBe("ABORTED");
      expect(row.reasonCode).toBe("HORIZON_EXPIRED");
    });

    // ── Lane selection (4.5, immutable at claim) ────────────────────────

    it("EXECUTE lane requires the dispatch epoch and carries it frozen", async () => {
      const shop = uniqueShop();
      await seedGate(shop, { dispatchEnabled: true, dispatchEnabledAt: EPOCH });
      const res = await claimShippingRefund(
        { operation: operation(shop), secondary: { id: nextOrder(), cancelledAt: CANCELLED } },
        db,
      );
      try {
        expect(res.claimed).toBe(true);
        if (!res.claimed) return;
        expect(res.lane).toBe("EXECUTE");
        const [row] = await refundRow(res.rowId);
        expect(row.lane).toBe("EXECUTE");
        expect((row.dispatchEpochAtAdmission as Date).toISOString()).toBe(
          new Date(EPOCH).toISOString(),
        );
      } finally {
        await db.$executeRaw`
          UPDATE "ShippingExecuteControl" SET
            "dispatchEnabled" = false, "dispatchEnabledAt" = NULL
          WHERE "id" = 'control'`;
      }
    });

    it("a dispatch epoch after the combine's creation keeps it OBSERVE", async () => {
      const shop = uniqueShop();
      await seedGate(shop, {
        dispatchEnabled: true,
        dispatchEnabledAt: "2026-10-20T00:00:00.000Z",
      });
      try {
        const res = await claimShippingRefund(
          { operation: operation(shop), secondary: { id: nextOrder(), cancelledAt: CANCELLED } },
          db,
        );
        expect(res.claimed).toBe(true);
        if (!res.claimed) return;
        expect(res.lane).toBe("OBSERVE");
        const [row] = await refundRow(res.rowId);
        expect(row.lane).toBe("OBSERVE");
        expect(row.dispatchEpochAtAdmission).toBeNull();
      } finally {
        await db.$executeRaw`
          UPDATE "ShippingExecuteControl" SET
            "dispatchEnabled" = false, "dispatchEnabledAt" = NULL
          WHERE "id" = 'control'`;
      }
    });

    // ── Terminal claims and refusals (7.2.1, 7.2.2) ─────────────────────

    it("invalid cancellation evidence claims the REVIEW_REQUIRED terminal row", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const res = await claimShippingRefund(
        { operation: operation(shop), secondary: { id: nextOrder(), cancelledAt: "not-a-date" } },
        db,
      );
      expect(res.claimed).toBe(true);
      if (!res.claimed) return;
      expect(res.status).toBe("REVIEW_REQUIRED");
      const [row] = await refundRow(res.rowId);
      expect(row.status).toBe("REVIEW_REQUIRED");
      expect(row.reasonCode).toBe("CANCELLED_AT_INVALID");
      expect(row.sourceCancelledAt).toBeNull();
      expect(row.reviewReason).toMatch(/^UNPARSEABLE: /);
      expect(String(row.reviewReason).length).toBeLessThanOrEqual(64 + "UNPARSEABLE: ".length);
      expect(row.leaseToken).toBeNull();
      expect(row.leasedUntil).toBeNull();
      assertAllEvidenceNull(row);
      const events = await eventsFor(res.rowId);
      expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual([[null, "REVIEW_REQUIRED"]]);
    });

    it("UNCLAIMABLE records create no row", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const op = operation(shop);

      // Malformed source order GID.
      let res = await claimShippingRefund(
        { operation: op, secondary: { id: "not-a-gid", cancelledAt: CANCELLED } },
        db,
      );
      expect(res.claimed).toBe(false);
      if (!res.claimed && res.code === "UNCLAIMABLE") {
        expect(res.validation.reason).toBe("SOURCE_ORDER_ID_INVALID");
      }

      // Source equal to primary.
      res = await claimShippingRefund(
        { operation: op, secondary: { id: op.primaryOrderId, cancelledAt: CANCELLED } },
        db,
      );
      expect(res.claimed).toBe(false);
      if (!res.claimed && res.code === "UNCLAIMABLE") {
        expect(res.validation.reason).toBe("SOURCE_EQUALS_PRIMARY");
      }

      // Missing operation createdAt.
      res = await claimShippingRefund(
        {
          operation: { ...op, createdAt: undefined },
          secondary: { id: nextOrder(), cancelledAt: CANCELLED },
        },
        db,
      );
      expect(res.claimed).toBe(false);
      if (!res.claimed && res.code === "UNCLAIMABLE") {
        expect(res.validation.reason).toBe("OPERATION_CREATED_AT_INVALID");
      }

      const [{ n }] = await rowCount(shop);
      expect(n).toBe(0n);
    });

    it("the terminal claim path writes SKIPPED with the validated fields", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const res = await claimTerminalShippingRefund(
        { operation: operation(shop), secondary: { id: nextOrder(), cancelledAt: CANCELLED } },
        { status: "SKIPPED", reasonCode: "ALREADY_REFUNDED_EXTERNALLY" },
        db,
      );
      expect(res.claimed).toBe(true);
      if (!res.claimed) return;
      expect(res.status).toBe("SKIPPED");
      const [row] = await refundRow(res.rowId);
      expect(row.status).toBe("SKIPPED");
      expect(row.reasonCode).toBe("ALREADY_REFUNDED_EXTERNALLY");
      expect((row.sourceCancelledAt as Date).toISOString()).toBe(CANCELLED);
      expect(row.leaseToken).toBeNull();
    });

    it("a terminal claim is refused when validation is not fully VALID", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const res = await claimTerminalShippingRefund(
        { operation: operation(shop), secondary: { id: nextOrder(), cancelledAt: "garbage" } },
        { status: "REVIEW_REQUIRED", reasonCode: "DATA_INVALID" },
        db,
      );
      expect(res.claimed).toBe(false);
      if (!res.claimed) expect(res.code).toBe("UNCLAIMABLE");
      const [{ n }] = await rowCount(shop);
      expect(n).toBe(0n);
    });

    // ── Lease operations (9.1 T1) ───────────────────────────────────────

    it("a stale or expired lease token cannot renew or release", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const res = await claimShippingRefund(
        { operation: operation(shop), secondary: { id: nextOrder(), cancelledAt: CANCELLED } },
        db,
      );
      expect(res.claimed).toBe(true);
      if (!res.claimed || !res.leaseToken) return;
      const rowId = res.rowId;

      // Stale token: renew throws OwnershipLostError, release returns false.
      await expect(
        renewQueuedShippingRefundLease(rowId, "lease_stale_wrong", db),
      ).rejects.toBeInstanceOf(OwnershipLostError);
      await expect(
        releaseQueuedShippingRefundLease(rowId, "lease_stale_wrong", db),
      ).resolves.toBe(false);
      let [row] = await refundRow(rowId);
      expect(row.leaseToken).toBe(res.leaseToken);

      // Correct token: renew extends the lease.
      const before = row.leasedUntil as Date;
      await new Promise((r) => setTimeout(r, 1100));
      await renewQueuedShippingRefundLease(rowId, res.leaseToken, db);
      [row] = await refundRow(rowId);
      expect((row.leasedUntil as Date).getTime()).toBeGreaterThan(before.getTime());

      // Release with the correct token clears the lease.
      await expect(
        releaseQueuedShippingRefundLease(rowId, res.leaseToken, db),
      ).resolves.toBe(true);
      [row] = await refundRow(rowId);
      expect(row.leaseToken).toBeNull();
      expect(row.leasedUntil).toBeNull();

      // The old token is now stale: it cannot update the released row.
      await expect(
        renewQueuedShippingRefundLease(rowId, res.leaseToken, db),
      ).rejects.toBeInstanceOf(OwnershipLostError);

      // A fresh lease grants a NEW token.
      const leased = await leaseQueuedShippingRefund(rowId, {}, db);
      expect(leased.leased).toBe(true);
      if (leased.leased) expect(leased.leaseToken).not.toBe(res.leaseToken);

      // The claim-time token is stale after the re-lease.
      await expect(
        renewQueuedShippingRefundLease(rowId, res.leaseToken, db),
      ).rejects.toBeInstanceOf(OwnershipLostError);

      // Exactly one event so far (the insert): lease ops are not status changes.
      expect(await eventsFor(rowId)).toHaveLength(1);
    });

    it("lease predicates: held, not-due, not-queued and not-found refuse", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const res = await claimShippingRefund(
        { operation: operation(shop), secondary: { id: nextOrder(), cancelledAt: CANCELLED } },
        db,
      );
      expect(res.claimed).toBe(true);
      if (!res.claimed) return;

      // Held lease.
      expect(await leaseQueuedShippingRefund(res.rowId, {}, db)).toEqual({
        leased: false,
        reason: "LEASE_HELD",
      });
      // Not found.
      expect(await leaseQueuedShippingRefund("sr_nonexistent", {}, db)).toEqual({
        leased: false,
        reason: "NOT_FOUND",
      });
      // nextCheckAt in the future.
      await db.$executeRaw`
        UPDATE "ShippingRefund" SET "nextCheckAt" = clock_timestamp() AT TIME ZONE 'UTC' + interval '1 hour',
          "leaseToken" = NULL, "leasedUntil" = NULL
        WHERE "id" = ${res.rowId}`;
      expect(await leaseQueuedShippingRefund(res.rowId, {}, db)).toEqual({
        leased: false,
        reason: "NOT_DUE",
      });
      // Terminal row.
      const term = await claimShippingRefund(
        { operation: operation(shop), secondary: { id: nextOrder(), cancelledAt: 42 } },
        db,
      );
      expect(term.claimed).toBe(true);
      if (term.claimed) {
        expect(await leaseQueuedShippingRefund(term.rowId, {}, db)).toEqual({
          leased: false,
          reason: "NOT_QUEUED",
        });
      }
    });

    it("an expired lease is reclaimable and gets a fresh token", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const res = await claimShippingRefund(
        { operation: operation(shop), secondary: { id: nextOrder(), cancelledAt: CANCELLED } },
        db,
      );
      expect(res.claimed).toBe(true);
      if (!res.claimed) return;
      await db.$executeRaw`
        UPDATE "ShippingRefund" SET
          "leasedUntil" = clock_timestamp() AT TIME ZONE 'UTC' - interval '1 second'
        WHERE "id" = ${res.rowId}`;
      const leased = await leaseQueuedShippingRefund(res.rowId, {}, db);
      expect(leased.leased).toBe(true);
      if (leased.leased) expect(leased.leaseToken).not.toBe(res.leaseToken);
    });

    it("the seven-day horizon aborts at lease instead of granting (8.4)", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      // cancelledAt eight days ago: parses (within [2000, wall+5min]) but is
      // past the horizon when the lease is taken.
      const res = await claimShippingRefund(
        {
          operation: operation(shop),
          secondary: { id: nextOrder(), cancelledAt: "2020-01-02T00:00:00.000Z" },
        },
        db,
      );
      expect(res.claimed).toBe(true);
      if (!res.claimed) return;
      // F1: the claim's own lease is live — it must be released before the
      // row can be acquired and the horizon evaluated.
      await db.$executeRaw`
        UPDATE "ShippingRefund" SET "leaseToken" = NULL, "leasedUntil" = NULL
        WHERE "id" = ${res.rowId}`;
      const leased = await leaseQueuedShippingRefund(res.rowId, {}, db);
      expect(leased).toEqual({ leased: false, reason: "HORIZON_EXPIRED" });
      const [row] = await refundRow(res.rowId);
      expect(row.status).toBe("ABORTED");
      expect(row.reasonCode).toBe("HORIZON_EXPIRED");
      expect(row.leaseToken).toBeNull();
      const events = await eventsFor(res.rowId);
      expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual([
        [null, "QUEUED"],
        ["QUEUED", "ABORTED"],
      ]);
      expect(events[1].actor).toBe("shipping-refund-lease");
    });

    it("a losing concurrent claimant cannot seize the lease", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const res = await claimShippingRefund(
        { operation: operation(shop), secondary: { id: nextOrder(), cancelledAt: CANCELLED } },
        db,
      );
      expect(res.claimed).toBe(true);
      if (!res.claimed) return;
      // First claim expires the lease; two racing lease attempts on it.
      await db.$executeRaw`
        UPDATE "ShippingRefund" SET
          "leasedUntil" = clock_timestamp() AT TIME ZONE 'UTC' - interval '1 second'
        WHERE "id" = ${res.rowId}`;
      const [a, b] = await Promise.all([
        leaseQueuedShippingRefund(res.rowId, {}, db),
        leaseQueuedShippingRefund(res.rowId, {}, db2),
      ]);
      const winners = [a, b].filter((r) => r.leased);
      expect(winners).toHaveLength(1);
      const [row] = await refundRow(res.rowId);
      if (winners[0].leased) expect(row.leaseToken).toBe(winners[0].leaseToken);
    });

    // ── Dispatch-path fencing ───────────────────────────────────────────

    it("no row can enter DISPATCHING or acquire dispatch evidence", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const res = await claimShippingRefund(
        { operation: operation(shop), secondary: { id: nextOrder(), cancelledAt: CANCELLED } },
        db,
      );
      expect(res.claimed).toBe(true);
      if (!res.claimed) return;

      // QUEUED -> DISPATCHING has no edge.
      await expect(
        db.$executeRaw`
          UPDATE "ShippingRefund" SET "status" = 'DISPATCHING' WHERE "id" = ${res.rowId}`,
      ).rejects.toThrow();
      // Dispatch evidence on a QUEUED row violates the evidence CHECKs.
      await expect(
        db.$executeRaw`
          UPDATE "ShippingRefund" SET
            "dispatchToken" = 'x', "dispatchedAt" = clock_timestamp() AT TIME ZONE 'UTC'
          WHERE "id" = ${res.rowId}`,
      ).rejects.toThrow();
      const [row] = await refundRow(res.rowId);
      expect(row.status).toBe("QUEUED");
      expect(row.dispatchToken).toBeNull();
      expect(row.dispatchedAt).toBeNull();
    });

    // ── UTC discipline ──────────────────────────────────────────────────

    it("a non-UTC session cannot shift claim or lease timestamps", async () => {
      const shop = uniqueShop();
      await seedGate(shop);
      const res = await claimShippingRefund(
        {
          operation: operation(shop),
          secondary: { id: nextOrder(), cancelledAt: CANCELLED },
          sessionTimeZone: "Asia/Tokyo",
        },
        db,
      );
      expect(res.claimed).toBe(true);
      if (!res.claimed) return;
      const [row] = await refundRow(res.rowId);
      const [w] = await db.$queryRaw<{ wall: Date }[]>`
        SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "wall"`;
      // createdAt ≈ wall, leasedUntil ≈ wall + 180s — read back as naive UTC.
      expect(Math.abs(w.wall.getTime() - (row.createdAt as Date).getTime())).toBeLessThan(10_000);
      const leaseDelta = (row.leasedUntil as Date).getTime() - (row.createdAt as Date).getTime();
      expect(Math.abs(leaseDelta - SHIPPING_REFUND_LEASE_TTL_MS)).toBeLessThan(10_000);
      expect((row.operationCreatedAt as Date).toISOString()).toBe(OP_CREATED);
      expect((row.sourceCancelledAt as Date).toISOString()).toBe(CANCELLED);
    });

    // ── Trigger-integrity refusal (5.4.7, 3.2 rule 11) ──────────────────

    it("a missing or unexpected trigger refuses the whole claim cycle", async () => {
      await withScratchDatabase(preflighted, async (scratchUrl) => {
        execSync("npx prisma migrate deploy", {
          env: { ...process.env, DATABASE_URL: scratchUrl },
          stdio: "pipe",
        });
        const scratch = new PrismaClient({ datasources: { db: { url: scratchUrl } } });
        try {
          const shop = uniqueShop();
          // Seed the scratch gate (no global beforeAll state here).
          await scratch.$executeRaw`
            UPDATE "AppControl" SET
              "shippingAdjustmentsEnabled" = true,
              "shippingEnabledAt" = ${naive(EPOCH)},
              "shippingAllowShops" = ARRAY[${shop}]::text[]
            WHERE "id" = 'control'`;
          await scratch.$executeRaw`
            INSERT INTO "Settings" ("id", "shop", "shippingAdjustmentEnabled",
              "shippingAdjustmentEnabledAt", "shippingRolloutAt", "shippingPolicy")
            VALUES (${`set_${randomUUID()}`}, ${shop}, true, ${naive(EPOCH)},
              ${naive(EPOCH)}, 'REFUND_ALL')`;
          await scratch.$executeRaw`
            INSERT INTO "ShippingExecuteControl"
              ("id", "admissionEnabled", "admissionEnabledAt", "dispatchEnabled")
            VALUES ('control', true, ${naive(EPOCH)}, false)
            ON CONFLICT ("id") DO UPDATE SET
              "admissionEnabled" = true, "admissionEnabledAt" = ${naive(EPOCH)},
              "dispatchEnabled" = false, "dispatchEnabledAt" = NULL`;
          await scratch.$executeRaw`
            INSERT INTO "ShippingExecuteApproval"
              ("shop", "approvedAt", "approvedBy", "revokedAt", "merchantOptInEpoch",
               "ackVersion", "ackRecordedAt", "currencyCode", "maxRefundMinor")
            VALUES (${shop}, ${naive(EPOCH)}, 's1d-test', NULL, ${naive(EPOCH)},
              'v1', ${naive(EPOCH)}, 'USD', '0')`;

          const input = {
            operation: operation(shop),
            secondary: { id: nextOrder(), cancelledAt: CANCELLED },
          };

          // Baseline: intact catalog — the claim succeeds.
          const ok = await claimShippingRefund(input, scratch);
          expect(ok.claimed).toBe(true);

          // Missing trigger: refuse, write nothing.
          await scratch.$executeRawUnsafe(
            `DROP TRIGGER shippingrefund_frozen_columns_guard ON "ShippingRefund"`,
          );
          const src2 = nextOrder();
          const refused = await claimShippingRefund(
            { operation: operation(shop), secondary: { id: src2, cancelledAt: CANCELLED } },
            scratch,
          );
          expect(refused.claimed).toBe(false);
          if (!refused.claimed) {
            expect(refused.code).toBe("TRIGGERS_NOT_INTACT");
            if (refused.code === "TRIGGERS_NOT_INTACT") {
              expect(refused.reasons.map((r) => r.code)).toContain("MISSING");
            }
          }
          const [{ n }] = await scratch.$queryRaw<{ n: bigint }[]>`
            SELECT count(*) AS n FROM "ShippingRefund" WHERE "sourceOrderId" = ${src2}`;
          expect(n).toBe(0n);

          // Restore, then an UNEXPECTED trigger also refuses.
          await scratch.$executeRawUnsafe(
            `CREATE TRIGGER shippingrefund_frozen_columns_guard
             BEFORE UPDATE ON "ShippingRefund"
             FOR EACH ROW EXECUTE FUNCTION shipping_refund_fn_frozen_columns_guard()`,
          );
          await scratch.$executeRawUnsafe(
            `CREATE TRIGGER rogue_s1d BEFORE UPDATE ON "ShippingRefund"
             FOR EACH ROW EXECUTE FUNCTION shipping_refund_fn_frozen_columns_guard()`,
          );
          const src3 = nextOrder();
          const refused2 = await claimShippingRefund(
            { operation: operation(shop), secondary: { id: src3, cancelledAt: CANCELLED } },
            scratch,
          );
          expect(refused2.claimed).toBe(false);
          if (!refused2.claimed) {
            expect(refused2.code).toBe("TRIGGERS_NOT_INTACT");
            if (refused2.code === "TRIGGERS_NOT_INTACT") {
              expect(refused2.reasons.map((r) => r.code)).toContain("UNEXPECTED");
            }
          }
          const [{ n: n3 }] = await scratch.$queryRaw<{ n: bigint }[]>`
            SELECT count(*) AS n FROM "ShippingRefund" WHERE "sourceOrderId" = ${src3}`;
          expect(n3).toBe(0n);
        } finally {
          await scratch.$disconnect();
        }
      });
    });
  },
);
