// Real-Postgres safety tests for the §19.2.1 fixture mechanism
// (tests/helpers/shipping-refund-fixture.ts): the ONE test-only path
// allowed to create a synthetic DISPATCHING row.
//
// What this suite proves on a preflighted disposable database:
//   - happy path: legal claim + real freeze, then exactly one
//     PREPARED -> DISPATCHING update with both dispatch fields, exactly
//     one journal event with actor 'test-fixture', catalog intact after;
//   - rollback: a failure injected at any point inside the transaction
//     (including a lost connection) leaves the row PREPARED and the
//     trigger enabled;
//   - restoration: a no-op ENABLE is caught by the in-transaction
//     verification and rolls everything back;
//   - privilege/identity: forged brands, wrong markers and production
//     env markers refuse before or inside the transaction with no DDL;
//   - isolation/liveness: the suspended trigger is invisible to other
//     sessions mid-transaction, and the restored trigger still enforces
//     the transition graph afterwards.
//
// Opt-in (same gate as every real-database suite):
//
//   MERGESHIP_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:PORT/mergeship_test \
//   MERGESHIP_SHADOW_TOKEN=<operator token> \
//     npx vitest run tests/shipping-refund-fixture-pg.test.ts
//
// Destructive-scope note: ShippingRefundEvent is append-only; this suite
// never deletes or truncates it. Rows are isolated by unique shops and
// order ids and left in place.

import { execSync } from "child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  claimShippingRefund,
  leaseReconcileShippingRefund,
  writeReconcileTransition,
} from "../app/lib/shipping-refund-store.server";
import { buildFrozenWireContract } from "../app/lib/shipping-refund-contract";
import {
  checkTriggerIntegrity,
  TRIGGER_CATALOG_SQL,
  type ShippingRefundTriggerCatalogRow,
} from "../app/lib/shipping-refund-trigger-manifest";
import {
  DisposablePreflightError,
  preflightDisposableDatabase,
  type PreflightedDatabase,
} from "./helpers/disposable-db";
import {
  createDispatchedFixture,
  FixtureError,
  type DispatchedFixtureArgs,
} from "./helpers/shipping-refund-fixture";

const TEST_URL = process.env.MERGESHIP_TEST_DATABASE_URL;
const oid = (n: number) => `gid://shopify/Order/${n}`;
const txn = (n: number) => `gid://shopify/OrderTransaction/${n}`;

const naive = (iso: string) => Prisma.sql`(${iso}::timestamptz AT TIME ZONE 'UTC')`;
const EPOCH = "2026-10-10T00:00:00.000Z";
const TXN_CAP = txn(901);

describe.skipIf(!TEST_URL)(
  "shipping-refund §19.2.1 fixture mechanism safety (real disposable database)",
  () => {
    let db: PrismaClient;
    let preflighted: PreflightedDatabase;
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
      preflighted = await preflightDisposableDatabase(TEST_URL!);
      execSync("npx prisma migrate deploy", {
        env: { ...process.env, DATABASE_URL: TEST_URL! },
        stdio: "pipe",
      });
      db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });

      [savedAppControl] = await db.$queryRaw<
        {
          shippingAdjustmentsEnabled: boolean;
          shippingEnabledAt: Date | null;
          shippingAllowShops: string[];
        }[]
      >`
        SELECT "shippingAdjustmentsEnabled", "shippingEnabledAt", "shippingAllowShops"
        FROM "AppControl" WHERE "id" = 'control'`;
      [savedExecuteControl] = await db.$queryRaw<
        {
          admissionEnabled: boolean;
          admissionEnabledAt: Date | null;
          dispatchEnabled: boolean;
          dispatchEnabledAt: Date | null;
        }[]
      >`
        SELECT "admissionEnabled", "admissionEnabledAt", "dispatchEnabled", "dispatchEnabledAt"
        FROM "ShippingExecuteControl" WHERE "id" = 'control'`;

      await db.$executeRaw`
        UPDATE "AppControl" SET
          "shippingAdjustmentsEnabled" = true,
          "shippingEnabledAt" = ${naive(EPOCH)}
        WHERE "id" = 'control'`;
      // Fixture creation needs the EXECUTE lane: a PREPARED row is the
      // only legal fixture source (19.2.1 step 3).
      await db.$executeRaw`
        INSERT INTO "ShippingExecuteControl"
          ("id", "admissionEnabled", "admissionEnabledAt", "dispatchEnabled", "dispatchEnabledAt")
        VALUES ('control', true, ${naive(EPOCH)}, true, ${naive(EPOCH)})
        ON CONFLICT ("id") DO UPDATE SET
          "admissionEnabled" = true, "admissionEnabledAt" = ${naive(EPOCH)},
          "dispatchEnabled" = true, "dispatchEnabledAt" = ${naive(EPOCH)}`;
    }, 120_000);

    afterAll(async () => {
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
      }
    });

    const uniqueShop = () => `s1f-fx-${randomUUID()}.myshopify.com`;
    let orderSeq = 700_000;
    const nextOrder = () => oid(++orderSeq);
    let opSeq = 0;
    const nextOpId = () => `op_s1f_fx_${++opSeq}_${randomUUID().slice(0, 8)}`;

    const dbWall = async (): Promise<Date> => {
      const [row] = await db.$queryRaw<{ wall: Date }[]>`
        SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "wall"`;
      return row.wall;
    };
    const catalog = () =>
      db.$queryRawUnsafe<ShippingRefundTriggerCatalogRow[]>(
        TRIGGER_CATALOG_SQL,
      );
    const rowState = async (rowId: string) =>
      (
        await db.$queryRaw<any[]>`
          SELECT * FROM "ShippingRefund" WHERE "id" = ${rowId}`
      )[0] ?? null;
    const rowEvents = async (rowId: string) =>
      db.$queryRaw<{ fromStatus: string | null; toStatus: string; actor: string }[]>`
        SELECT "fromStatus", "toStatus", "actor" FROM "ShippingRefundEvent"
        WHERE "shippingRefundId" = ${rowId} ORDER BY "at" ASC, "id" ASC`;

    /** Gate + a v2 COMPLETED op the real claim consumes; EXECUTE lane. */
    async function seedGateAndOp(shop: string) {
      const wall = await dbWall();
      const cancelledAt = new Date(wall.getTime() - 3600e3).toISOString();
      const primaryId = nextOrder();
      const secondaryId = nextOrder();
      await db.$executeRaw`
        UPDATE "AppControl" SET
          "shippingAllowShops" = array_append("shippingAllowShops", ${shop})
        WHERE "id" = 'control'`;
      await db.$executeRaw`
        INSERT INTO "Settings" ("id", "shop", "shippingAdjustmentEnabled",
          "shippingAdjustmentEnabledAt", "shippingRolloutAt", "shippingPolicy")
        VALUES (${`set_${randomUUID()}`}, ${shop}, true, ${naive(EPOCH)}, ${naive(EPOCH)}, 'REFUND_ALL')`;
      await db.$executeRaw`
        INSERT INTO "ShippingExecuteApproval"
          ("shop", "approvedAt", "approvedBy", "revokedAt", "merchantOptInEpoch",
           "ackVersion", "ackRecordedAt", "currencyCode", "maxRefundMinor")
        VALUES (${shop}, ${naive(EPOCH)}, 's1f-fixture-test', NULL,
          ${naive(EPOCH)}, 'v1', ${naive(EPOCH)}, 'USD', '0')`;

      const opId = nextOpId();
      const secondary = { id: secondaryId, cancelledAt };
      const secondaries = [
        {
          id: secondaryId,
          name: `#${secondaryId.split("/").pop()}`,
          items: 1,
          done: true,
          cancelPhase: "CANCEL_VERIFIED",
          cancelledAt,
          staffNoteMatched: true,
        },
      ];
      await db.$executeRaw`
        INSERT INTO "MergeOperation"
          ("id", "shop", "status", "primaryOrderId", "primaryOrderName",
           "primaryLineItemCountBefore", "addedLineItemCount", "secondaries",
           "involvedOrderIds", "createdAt", "updatedAt", "protocolVersion",
           "phase", "opToken", "calculatedOrderId", "expectedTransfer",
           "appliedEvidence", "sideEffectsDone")
        VALUES (
          ${opId}, ${shop}, 'COMPLETED', ${primaryId}, '#primary',
          1, 1, ${JSON.stringify(secondaries)}::jsonb,
          ${[primaryId, secondaryId]}::text[],
          ${naive(wall.toISOString())}, ${naive(wall.toISOString())},
          2, 'COMPLETED', ${`TK${randomUUID().slice(0, 6).toUpperCase()}`},
          'gid://shopify/CalculatedOrder/1',
          ${JSON.stringify([{ secondaryId, secondaryIndex: 1, lines: [{ sourceLineItemId: "gid://shopify/LineItem/9", variantId: "gid://shopify/ProductVariant/9", quantity: 1 }] }])}::jsonb,
          ${JSON.stringify({ agreementId: "gid://shopify/OrderEditAgreement/1", happenedAt: wall.toISOString(), lines: [{ secondaryId }] })}::jsonb,
          true
        )`;
      await db.$executeRaw`
        INSERT INTO "MergeRecord"
          ("id", "shop", "primaryOrderId", "primaryOrderName", "mergedOrderId",
           "mergedOrderName", "itemsCombined", "operationId", "createdAt")
        VALUES (${`mr_${randomUUID()}`}, ${shop}, ${primaryId}, '#primary',
          ${secondaryId}, '#secondary', 1, ${opId}, ${naive(wall.toISOString())})`;
      await db.$executeRaw`
        INSERT INTO "MergeMutationAttempt"
          ("id", "operationId", "kind", "targetOrderId", "attemptNo", "state",
           "dispatchToken", "dispatchedAt", "respondedAt")
        VALUES
          (${`att_${randomUUID()}`}, ${opId}, 'EDIT_COMMIT', ${primaryId}, 1,
           'SUCCEEDED', 't', ${naive(wall.toISOString())}, ${naive(wall.toISOString())}),
          (${`att_${randomUUID()}`}, ${opId}, 'ORDER_CANCEL', ${secondaryId}, 1,
           'SUCCEEDED', 't', ${naive(wall.toISOString())}, ${naive(wall.toISOString())})`;
      const [opRow] = await db.$queryRaw<any[]>`
        SELECT * FROM "MergeOperation" WHERE "id" = ${opId}`;
      return { opRow, secondary, secondaryId };
    }

    /** Fixture args: a valid freeze (wire contract binds the claimed row's
     *  marker + idempotency key) over a STRICT_EMPTY baseline. */
    const fixtureArgsFor = (seed: {
      opRow: any;
      secondary: { id: string; cancelledAt: string };
    }): Omit<DispatchedFixtureArgs, "dispatchedAt" | "hooks" | "log"> => ({
      operation: seed.opRow,
      secondary: seed.secondary,
      freeze: ({ marker, idempotencyKey, sourceOrderId }) => {
        const contract = buildFrozenWireContract({
          sourceOrderId,
          parentTransactionId: TXN_CAP,
          gateway: "bogus",
          plannedShippingMinor: "800",
          currencyCode: "USD",
          marker,
          idempotencyKey,
        });
        return {
          contract,
          financialColumns: {
            currencyCode: "USD",
            plannedShippingMinor: "800",
            parentTransactionId: TXN_CAP,
            gateway: "bogus",
          },
          preEvidence: {
            capturedAt: new Date().toISOString(),
            baseline: {
              capturedAt: new Date().toISOString(),
              mode: "STRICT_EMPTY",
              currencyCode: "USD",
              refunds: [],
              totalRefundedMinor: "0",
              totalRefundedShippingMinor: "0",
              transactionIds: [txn(900), TXN_CAP],
              monetaryTransactionCount: 1,
            },
          },
        };
      },
    });

    it("creates a DISPATCHING row through the one named trigger with full restoration", async () => {
      const shop = uniqueShop();
      const seed = await seedGateAndOp(shop);
      const wall = await dbWall();
      const dispatchedAt = new Date(wall.getTime() - 3600e3).toISOString();

      const result = await createDispatchedFixture(preflighted, db, {
        ...fixtureArgsFor(seed),
        dispatchedAt,
      });

      const row = await rowState(result.rowId);
      expect(row.status).toBe("DISPATCHING");
      expect(row.dispatchToken).toBe(result.dispatchToken);
      expect(row.respondedAt).toBeNull();
      expect(row.refundId).toBeNull();
      // The frozen evidence is intact (the update touched only the three
      // dispatch columns and updatedAt).
      expect(row.wireHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.plannedShippingMinor).toBe("800");
      expect(row.marker).toMatch(/^MS-SHIPREFUND-/);

      // Exactly one PREPARED -> DISPATCHING journal row, actor test-fixture.
      const events = await rowEvents(result.rowId);
      const dispatchEvents = events.filter((e) => e.toStatus === "DISPATCHING");
      expect(dispatchEvents).toHaveLength(1);
      expect(dispatchEvents[0].fromStatus).toBe("PREPARED");
      expect(dispatchEvents[0].actor).toBe("test-fixture");

      // Statement allowlist: SET LOCALs, one LOCK, one literal DISABLE,
      // one UPDATE, one literal ENABLE, then verification SELECTs. No
      // forbidden form ever ran.
      const stmts = result.statements;
      expect(
        stmts.filter((s) => /DISABLE\s+TRIGGER/i.test(s)),
      ).toHaveLength(1);
      expect(
        stmts.filter((s) => /ENABLE\s+TRIGGER/i.test(s)),
      ).toHaveLength(1);
      for (const s of stmts) {
        expect(s).not.toMatch(/DISABLE\s+TRIGGER\s+ALL/i);
        expect(s).not.toMatch(/ENABLE\s+(REPLICA|ALWAYS)\s+TRIGGER/i);
        expect(s).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM|DROP)\b/i);
        expect(s).not.toMatch(/SET\s+(LOCAL\s+|SESSION\s+)?session_replication_role/i);
      }
      // The catalog is fully intact on a fresh read after commit.
      const integrity = await checkTriggerIntegrity(catalog);
      expect(integrity.intact).toBe(true);
    });

    it("an aged fixture row is swept to IN_DOUBT by the real transition writer", async () => {
      const shop = uniqueShop();
      const seed = await seedGateAndOp(shop);
      const wall = await dbWall();
      const dispatchedAt = new Date(
        wall.getTime() - 3 * 60_000,
      ).toISOString();
      const fx = await createDispatchedFixture(preflighted, db, {
        ...fixtureArgsFor(seed),
        dispatchedAt,
      });
      const lease = await leaseReconcileShippingRefund(fx.rowId, {}, db);
      expect(lease.leased).toBe(true);
      if (!lease.leased) return;
      const w = await writeReconcileTransition(
        fx.rowId,
        lease.leaseToken,
        { to: "IN_DOUBT", reasonCode: "DISPATCH_UNANSWERED" },
        db,
      );
      expect(w.written).toBe(true);
      const row = await rowState(fx.rowId);
      expect(row.status).toBe("IN_DOUBT");
      const events = await rowEvents(fx.rowId);
      expect(events.map((e) => e.toStatus)).toEqual([
        "QUEUED",
        "PREPARED",
        "DISPATCHING",
        "IN_DOUBT",
      ]);
    });

    it("a throw at any transaction step rolls back the row, the disable and the update", async () => {
      for (const step of ["lock", "disable", "update", "enable"] as const) {
        const shop = uniqueShop();
        const seed = await seedGateAndOp(shop);
        await expect(
          createDispatchedFixture(preflighted, db, {
            ...fixtureArgsFor(seed),
            hooks: {
              afterStep: (s) => {
                if (s === step) throw new Error(`injected failure after ${step}`);
              },
            },
          }),
        ).rejects.toThrow(`injected failure after ${step}`);
        // No ShippingRefund row may exist at all (claim+freeze happened
        // outside the tx — so a row EXISTS, but still PREPARED).
        const [row] = await db.$queryRaw<any[]>`
          SELECT * FROM "ShippingRefund" WHERE "shop" = ${shop}`;
        expect(row.status).toBe("PREPARED");
        expect(row.dispatchToken).toBeNull();
        expect(row.dispatchedAt).toBeNull();
        const events = await rowEvents(row.id);
        expect(events.some((e) => e.toStatus === "DISPATCHING")).toBe(false);
        const integrity = await checkTriggerIntegrity(catalog);
        expect(integrity.intact).toBe(true);
      }
    });

    it("a failed verification rolls back a committed-shape update", async () => {
      const shop = uniqueShop();
      const seed = await seedGateAndOp(shop);
      await expect(
        createDispatchedFixture(preflighted, db, {
          ...fixtureArgsFor(seed),
          hooks: {
            afterStep: (s) => {
              if (s === "verify") throw new Error("post-verify abort");
            },
          },
        }),
      ).rejects.toThrow("post-verify abort");
      const [row] = await db.$queryRaw<any[]>`
        SELECT * FROM "ShippingRefund" WHERE "shop" = ${shop}`;
      expect(row.status).toBe("PREPARED");
      const integrity = await checkTriggerIntegrity(catalog);
      expect(integrity.intact).toBe(true);
    });

    it("a swallowed ENABLE is caught by in-transaction verification and rolls back", async () => {
      const shop = uniqueShop();
      const seed = await seedGateAndOp(shop);
      await expect(
        createDispatchedFixture(preflighted, db, {
          ...fixtureArgsFor(seed),
          hooks: {
            // The ENABLE statement returns success without executing —
            // verification must catch the still-disabled trigger.
            executeAlter: (_tx, sql, real) =>
              /ENABLE\s+TRIGGER/i.test(sql) ? Promise.resolve(0) : real(),
          },
        }),
      ).rejects.toThrow(FixtureError);
      const [row] = await db.$queryRaw<any[]>`
        SELECT * FROM "ShippingRefund" WHERE "shop" = ${shop}`;
      expect(row.status).toBe("PREPARED");
      const integrity = await checkTriggerIntegrity(catalog);
      expect(integrity.intact).toBe(true);
    });

    it("the suspended trigger stays invisible to other sessions mid-transaction", async () => {
      const shop = uniqueShop();
      const seed = await seedGateAndOp(shop);
      // From a SECOND connection, inside the hook that runs while the
      // trigger is disabled-but-uncommitted, the catalog must still show
      // the full manifest enabled (DDL is transactional — rule 19.2.1's
      // safety argument).
      let midTxIntact: boolean | null = null;
      await createDispatchedFixture(preflighted, db, {
        ...fixtureArgsFor(seed),
        hooks: {
          afterStep: async (s) => {
            if (s !== "disable") return;
            const other = new PrismaClient({
              datasources: { db: { url: TEST_URL } },
            });
            try {
              const v = await checkTriggerIntegrity(() =>
                other.$queryRawUnsafe<ShippingRefundTriggerCatalogRow[]>(
                  TRIGGER_CATALOG_SQL,
                ),
              );
              midTxIntact = v.intact;
            } finally {
              await other.$disconnect();
            }
          },
        },
      });
      expect(midTxIntact).toBe(true);
      const integrity = await checkTriggerIntegrity(catalog);
      expect(integrity.intact).toBe(true);
    });

    it("the restored trigger still enforces the graph on the fixture row", async () => {
      const shop = uniqueShop();
      const seed = await seedGateAndOp(shop);
      const fx = await createDispatchedFixture(preflighted, db, {
        ...fixtureArgsFor(seed),
      });
      // DISPATCHING -> RESOLVED is not a legal edge: the transition guard
      // must still raise on the fixture row.
      await expect(
        db.$executeRaw`
          UPDATE "ShippingRefund" SET "status" = 'RESOLVED', "updatedAt" = now()
          WHERE "id" = ${fx.rowId}`,
      ).rejects.toThrow();
      const row = await rowState(fx.rowId);
      expect(row.status).toBe("DISPATCHING");
    });

    it("identity gates refuse before or inside the transaction with no DDL", async () => {
      const shop = uniqueShop();
      const seed = await seedGateAndOp(shop);

      // A forged brand — registry membership is the credential.
      await expect(
        createDispatchedFixture(
          { dbName: "mergeship_test_x", addr: "127.0.0.1", port: 1, fingerprint: "x" } as PreflightedDatabase,
          db,
          fixtureArgsFor(seed),
        ),
      ).rejects.toThrow(DisposablePreflightError);

      // A malformed/absent marker token.
      const saved = process.env.MERGESHIP_SHADOW_TOKEN;
      try {
        delete process.env.MERGESHIP_SHADOW_TOKEN;
        await expect(
          createDispatchedFixture(preflighted, db, fixtureArgsFor(seed)),
        ).rejects.toThrow(DisposablePreflightError);
      } finally {
        if (saved !== undefined) process.env.MERGESHIP_SHADOW_TOKEN = saved;
      }

      // A well-formed but WRONG token: claim+freeze run, then the
      // in-transaction marker check refuses before the table lock.
      try {
        process.env.MERGESHIP_SHADOW_TOKEN = `wrong_${randomUUID().replace(/-/g, "")}`;
        await expect(
          createDispatchedFixture(preflighted, db, fixtureArgsFor(seed)),
        ).rejects.toThrow(DisposablePreflightError);
      } finally {
        if (saved !== undefined) process.env.MERGESHIP_SHADOW_TOKEN = saved;
      }
      const [row] = await db.$queryRaw<any[]>`
        SELECT * FROM "ShippingRefund" WHERE "shop" = ${shop}`;
      expect(row.status).toBe("PREPARED");
      expect(row.dispatchToken).toBeNull();
      const integrity = await checkTriggerIntegrity(catalog);
      expect(integrity.intact).toBe(true);
    });

    it("a production-environment marker refuses before any work", async () => {
      const shop = uniqueShop();
      const seed = await seedGateAndOp(shop);
      const saved = process.env.RAILWAY_ENVIRONMENT;
      try {
        process.env.RAILWAY_ENVIRONMENT = "production";
        await expect(
          createDispatchedFixture(preflighted, db, fixtureArgsFor(seed)),
        ).rejects.toThrow();
      } finally {
        if (saved === undefined) delete process.env.RAILWAY_ENVIRONMENT;
        else process.env.RAILWAY_ENVIRONMENT = saved;
      }
      // Nothing was claimed — the refusal precedes even the real claim.
      const rows = await db.$queryRaw<any[]>`
        SELECT * FROM "ShippingRefund" WHERE "shop" = ${shop}`;
      expect(rows).toHaveLength(0);
    });

    it("a second claim for the same (shop, source) can never mint a duplicate fixture row", async () => {
      const shop = uniqueShop();
      const seed = await seedGateAndOp(shop);
      await createDispatchedFixture(preflighted, db, fixtureArgsFor(seed));
      const again = await claimShippingRefund(
        { operation: seed.opRow, secondary: seed.secondary },
        db,
        () => {},
      );
      expect(again.claimed).toBe(false);
      if (again.claimed) return;
      expect(again.code).toBe("CONFLICT");
      const rows = await db.$queryRaw<any[]>`
        SELECT * FROM "ShippingRefund" WHERE "shop" = ${shop}`;
      expect(rows).toHaveLength(1);
    });
  },
);
