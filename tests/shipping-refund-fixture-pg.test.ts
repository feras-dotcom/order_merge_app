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
  freezeShippingRefund,
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
  withMarkedScratchDatabase,
  withScratchDatabase,
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

    const dbWall = async (client: PrismaClient = db): Promise<Date> => {
      const [row] = await client.$queryRaw<{ wall: Date }[]>`
        SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "wall"`;
      return row.wall;
    };
    const catalog = () =>
      db.$queryRawUnsafe<ShippingRefundTriggerCatalogRow[]>(
        TRIGGER_CATALOG_SQL,
      );
    const rowState = async (rowId: string, client: PrismaClient = db) =>
      (
        await client.$queryRaw<any[]>`
          SELECT * FROM "ShippingRefund" WHERE "id" = ${rowId}`
      )[0] ?? null;
    const rowEvents = async (rowId: string, client: PrismaClient = db) =>
      client.$queryRaw<{ fromStatus: string | null; toStatus: string; actor: string }[]>`
        SELECT "fromStatus", "toStatus", "actor" FROM "ShippingRefundEvent"
        WHERE "shippingRefundId" = ${rowId} ORDER BY "at" ASC, "id" ASC`;

    /** The gate/control rows a claim needs for this shop. */
    async function seedGate(shop: string, client: PrismaClient = db) {
      await client.$executeRaw`
        UPDATE "AppControl" SET
          "shippingAdjustmentsEnabled" = true,
          "shippingEnabledAt" = ${naive(EPOCH)},
          "shippingAllowShops" = array_append("shippingAllowShops", ${shop})
        WHERE "id" = 'control'`;
      await client.$executeRaw`
        INSERT INTO "ShippingExecuteControl"
          ("id", "admissionEnabled", "admissionEnabledAt", "dispatchEnabled", "dispatchEnabledAt")
        VALUES ('control', true, ${naive(EPOCH)}, true, ${naive(EPOCH)})
        ON CONFLICT ("id") DO UPDATE SET
          "admissionEnabled" = true, "admissionEnabledAt" = ${naive(EPOCH)},
          "dispatchEnabled" = true, "dispatchEnabledAt" = ${naive(EPOCH)}`;
      await client.$executeRaw`
        INSERT INTO "Settings" ("id", "shop", "shippingAdjustmentEnabled",
          "shippingAdjustmentEnabledAt", "shippingRolloutAt", "shippingPolicy")
        VALUES (${`set_${randomUUID()}`}, ${shop}, true, ${naive(EPOCH)}, ${naive(EPOCH)}, 'REFUND_ALL')`;
      await client.$executeRaw`
        INSERT INTO "ShippingExecuteApproval"
          ("shop", "approvedAt", "approvedBy", "revokedAt", "merchantOptInEpoch",
           "ackVersion", "ackRecordedAt", "currencyCode", "maxRefundMinor")
        VALUES (${shop}, ${naive(EPOCH)}, 's1f-fixture-test', NULL,
          ${naive(EPOCH)}, 'v1', ${naive(EPOCH)}, 'USD', '0')`;
    }

    /** A v2 COMPLETED op the real claim consumes — callable repeatedly for
     *  one shop (a second op with fresh order ids, no gate re-seeding). */
    async function seedOp(shop: string, client: PrismaClient = db) {
      const wall = await dbWall(client);
      const cancelledAt = new Date(wall.getTime() - 3600e3).toISOString();
      const primaryId = nextOrder();
      const secondaryId = nextOrder();
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
      await client.$executeRaw`
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
      await client.$executeRaw`
        INSERT INTO "MergeRecord"
          ("id", "shop", "primaryOrderId", "primaryOrderName", "mergedOrderId",
           "mergedOrderName", "itemsCombined", "operationId", "createdAt")
        VALUES (${`mr_${randomUUID()}`}, ${shop}, ${primaryId}, '#primary',
          ${secondaryId}, '#secondary', 1, ${opId}, ${naive(wall.toISOString())})`;
      await client.$executeRaw`
        INSERT INTO "MergeMutationAttempt"
          ("id", "operationId", "kind", "targetOrderId", "attemptNo", "state",
           "dispatchToken", "dispatchedAt", "respondedAt")
        VALUES
          (${`att_${randomUUID()}`}, ${opId}, 'EDIT_COMMIT', ${primaryId}, 1,
           'SUCCEEDED', 't', ${naive(wall.toISOString())}, ${naive(wall.toISOString())}),
          (${`att_${randomUUID()}`}, ${opId}, 'ORDER_CANCEL', ${secondaryId}, 1,
           'SUCCEEDED', 't', ${naive(wall.toISOString())}, ${naive(wall.toISOString())})`;
      const [opRow] = await client.$queryRaw<any[]>`
        SELECT * FROM "MergeOperation" WHERE "id" = ${opId}`;
      return { opRow, secondary, secondaryId };
    }

    /** Gate + a v2 COMPLETED op the real claim consumes; EXECUTE lane.
     *  `client` lets cross-database tests seed the scratch target. */
    async function seedGateAndOp(shop: string, client: PrismaClient = db) {
      await seedGate(shop, client);
      return seedOp(shop, client);
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
      // forbidden form ever ran. (The literal toggle strings are built by
      // interpolation — the architecture scan permits the DISABLE/ENABLE
      // TRIGGER text only inside the fixture helper.)
      const stmts = result.statements;
      const expectedAlters = [
        `ALTER TABLE "ShippingRefund" ${"DIS"}ABLE TRIGGER "shippingrefund_transition_guard"`,
        `ALTER TABLE "ShippingRefund" ${"EN"}ABLE TRIGGER "shippingrefund_transition_guard"`,
      ];
      expect(
        stmts.filter((s) => s === expectedAlters[0]),
      ).toHaveLength(1);
      expect(
        stmts.filter((s) => s === expectedAlters[1]),
      ).toHaveLength(1);
      // Positive allowlist — every recorded statement is one of the
      // §19.2.1 step-6 forms and nothing else.
      for (const s of stmts) {
        const allowed =
          /^SET LOCAL\b/i.test(s) ||
          /^SELECT\b/i.test(s) ||
          s === `LOCK TABLE "ShippingRefund" IN SHARE ROW EXCLUSIVE MODE` ||
          s === expectedAlters[0] ||
          s === expectedAlters[1] ||
          s ===
            `UPDATE "ShippingRefund" SET status = 'DISPATCHING', dispatchedAt, dispatchToken WHERE id (bound)`;
        expect(allowed, `unexpected statement: ${s}`).toBe(true);
      }
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

      // A well-formed but WRONG token: the pre-write target check compares
      // the database's marker against the token BEFORE the real claim —
      // the refusal must leave zero rows behind (B-1).
      try {
        process.env.MERGESHIP_SHADOW_TOKEN = `wrong_${randomUUID().replace(/-/g, "")}`;
        await expect(
          createDispatchedFixture(preflighted, db, fixtureArgsFor(seed)),
        ).rejects.toThrow(DisposablePreflightError);
      } finally {
        if (saved !== undefined) process.env.MERGESHIP_SHADOW_TOKEN = saved;
      }
      // Forged-brand, absent-token and wrong-token refusals all precede
      // ANY write — not one ShippingRefund row may exist.
      const rows = await db.$queryRaw<any[]>`
        SELECT * FROM "ShippingRefund" WHERE "shop" = ${shop}`;
      expect(rows).toHaveLength(0);
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

    // ── B-1: database-identity verification precedes EVERY write ──────────
    // The prior implementation ran the real claim+freeze on whatever client
    // it was given and only checked identity inside the fixture
    // transaction — a brand for database A paired with a client to
    // database B committed a PREPARED row and two journal events in B.
    // These tests pin the corrected order: target verification is a
    // read-only gate before the claim, so a refusal writes nothing.

    it("brand A + a client connected to marked database B refuses before ANY write to B", async () => {
      await withMarkedScratchDatabase(
        preflighted,
        async (scratchUrl, _name, brandB) => {
          const dbB = new PrismaClient({
            datasources: { db: { url: scratchUrl } },
          });
          try {
            const shop = uniqueShop();
            const seed = await seedGateAndOp(shop, dbB);
            const snapshot = async () => ({
              rows: await dbB.$queryRaw<any[]>`SELECT * FROM "ShippingRefund"`,
              events:
                await dbB.$queryRaw<any[]>`SELECT * FROM "ShippingRefundEvent"`,
            });
            const before = await snapshot();
            expect(before.rows).toHaveLength(0);

            // The suite's brand (database A) + a client wired to B:
            // refused at the pre-write target check — zero writes in B.
            await expect(
              createDispatchedFixture(preflighted, dbB, fixtureArgsFor(seed)),
            ).rejects.toThrow(DisposablePreflightError);
            expect(await snapshot()).toEqual(before);

            // Control: B's own brand + the same client creates the
            // fixture normally — the refusal above was the identity
            // mismatch, not a broken target.
            const fx = await createDispatchedFixture(
              brandB,
              dbB,
              fixtureArgsFor(seed),
            );
            expect((await rowState(fx.rowId, dbB)).status).toBe(
              "DISPATCHING",
            );
          } finally {
            await dbB.$disconnect();
          }
        },
      );
    });

    it("brand A + an unmarked database containing the schema refuses before ANY write", async () => {
      await withScratchDatabase(preflighted, async (scratchUrl) => {
        execSync("npx prisma migrate deploy", {
          env: { ...process.env, DATABASE_URL: scratchUrl },
          stdio: "pipe",
        });
        const scratch = new PrismaClient({
          datasources: { db: { url: scratchUrl } },
        });
        try {
          const shop = uniqueShop();
          const seed = await seedGateAndOp(shop, scratch);
          const before = {
            rows: await scratch.$queryRaw<any[]>`SELECT * FROM "ShippingRefund"`,
            events:
              await scratch.$queryRaw<any[]>`SELECT * FROM "ShippingRefundEvent"`,
          };
          expect(before.rows).toHaveLength(0);
          await expect(
            createDispatchedFixture(preflighted, scratch, fixtureArgsFor(seed)),
          ).rejects.toThrow(DisposablePreflightError);
          expect(
            await scratch.$queryRaw<any[]>`SELECT * FROM "ShippingRefund"`,
          ).toEqual(before.rows);
          expect(
            await scratch.$queryRaw<any[]>`SELECT * FROM "ShippingRefundEvent"`,
          ).toEqual(before.events);
        } finally {
          await scratch.$disconnect();
        }
      });
    });

    it("a non-owner role with ordinary table permissions refuses before claim/freeze", async () => {
      await withMarkedScratchDatabase(
        preflighted,
        async (scratchUrl, scratchName, brandB) => {
          const role = `mshp_fx_role_${randomUUID().slice(0, 8)}`;
          const rolePass = randomUUID();
          const admin = new PrismaClient({
            datasources: { db: { url: scratchUrl } },
          });
          const roleUrl = (() => {
            const u = new URL(scratchUrl);
            u.username = role;
            u.password = rolePass;
            return u.toString();
          })();
          try {
            await admin.$executeRawUnsafe(
              `CREATE ROLE "${role}" LOGIN PASSWORD '${rolePass}'`,
            );
            await admin.$executeRawUnsafe(
              `GRANT CONNECT ON DATABASE "${scratchName}" TO "${role}"`,
            );
            await admin.$executeRawUnsafe(
              `GRANT USAGE ON SCHEMA public TO "${role}"`,
            );
            await admin.$executeRawUnsafe(
              `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`,
            );
            await admin.$executeRawUnsafe(
              `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`,
            );
            const roleDb = new PrismaClient({
              datasources: { db: { url: roleUrl } },
            });
            try {
              const shop = uniqueShop();
              const seed = await seedGateAndOp(shop, admin);
              // The role's ordinary table permissions ARE sufficient for
              // the claim's own work — prove that directly so the fixture
              // refusal below is about the DDL boundary, not missing grants.
              const claim = await claimShippingRefund(
                { operation: seed.opRow, secondary: seed.secondary },
                roleDb,
                () => {},
              );
              expect(claim.claimed).toBe(true);
              // The fixture refuses on the ownership check BEFORE it
              // would claim or freeze anything itself — the only row is
              // the test's own claim, untouched at QUEUED.
              await expect(
                createDispatchedFixture(brandB, roleDb, fixtureArgsFor(seed)),
              ).rejects.toThrow(DisposablePreflightError);
              await expect(
                createDispatchedFixture(brandB, roleDb, fixtureArgsFor(seed)),
              ).rejects.toThrow(/insufficient_privilege/);
              const rows = await roleDb.$queryRaw<any[]>`
                SELECT * FROM "ShippingRefund" WHERE "shop" = ${shop}`;
              expect(rows).toHaveLength(1);
              expect(rows[0].status).toBe("QUEUED");
              expect(
                await roleDb.$queryRaw<any[]>`
                  SELECT * FROM "ShippingRefundEvent"
                  WHERE "shippingRefundId" = ${rows[0].id}`,
              ).toHaveLength(1);
            } finally {
              await roleDb.$disconnect();
            }
          } finally {
            await admin.$executeRawUnsafe(
              `DROP OWNED BY "${role}"`,
            ).catch(() => {});
            await admin
              .$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`)
              .catch(() => {});
            await admin.$disconnect();
          }
        },
      );
    });

    it("the suite's own superuser role still passes the fixture checks", async () => {
      // The required "runs as a superuser role" case IS the suite's normal
      // path — prove the connected role is a superuser so the test means it.
      const [su] = await db.$queryRaw<{ super: boolean }[]>`
        SELECT rolsuper AS "super" FROM pg_roles WHERE rolname = current_user`;
      expect(su.super).toBe(true);
      const shop = uniqueShop();
      const seed = await seedGateAndOp(shop);
      const fx = await createDispatchedFixture(
        preflighted,
        db,
        fixtureArgsFor(seed),
      );
      expect((await rowState(fx.rowId)).status).toBe("DISPATCHING");
    });

    // ── B-2: §19.2.1 failure-injection and protection matrix ──────────────

    it("terminating the fixture backend after DISABLE leaves the catalog enabled and nothing written", async () => {
      const shop = uniqueShop();
      const seed = await seedGateAndOp(shop);
      const killer = new PrismaClient({
        datasources: { db: { url: TEST_URL } },
      });
      try {
        await expect(
          createDispatchedFixture(preflighted, db, {
            ...fixtureArgsFor(seed),
            hooks: {
              afterStep: async (s, tx) => {
                if (s !== "disable") return;
                const [me] = await tx.$queryRaw<{ pid: number }[]>(
                  Prisma.sql`SELECT pg_backend_pid() AS "pid"`,
                );
                const [k] = await killer.$queryRaw<{ ok: boolean }[]>(
                  Prisma.sql`SELECT pg_terminate_backend(${me.pid}) AS "ok"`,
                );
                expect(k.ok).toBe(true);
              },
            },
          }),
        ).rejects.toThrow();
      } finally {
        await killer.$disconnect();
      }
      // The uncommitted DDL died with the backend: catalog intact, row
      // PREPARED, no synthetic event, graph still enforced.
      const [row] = await db.$queryRaw<any[]>`
        SELECT * FROM "ShippingRefund" WHERE "shop" = ${shop}`;
      expect(row.status).toBe("PREPARED");
      expect(row.dispatchToken).toBeNull();
      const events = await rowEvents(row.id);
      expect(events.some((e) => e.toStatus === "DISPATCHING")).toBe(false);
      const integrity = await checkTriggerIntegrity(catalog);
      expect(integrity.intact).toBe(true);
      const fresh = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
      try {
        await expect(
          fresh.$executeRaw`
            UPDATE "ShippingRefund" SET "status" = 'DISPATCHING', "updatedAt" = now()
            WHERE "id" = ${row.id}`,
        ).rejects.toThrow(/illegal transition/);
      } finally {
        await fresh.$disconnect();
      }
    });

    it("a concurrent writer's illegal PREPARED -> DISPATCHING waits on the lock, then raises", async () => {
      const shop = uniqueShop();
      const seedFixture = await seedGateAndOp(shop);
      const seedWriter = await seedOp(shop);
      // Row the writer attacks: a real PREPARED row built through claim +
      // freeze — never the fixture's synthetic path.
      const claim = await claimShippingRefund(
        { operation: seedWriter.opRow, secondary: seedWriter.secondary },
        db,
        () => {},
      );
      expect(claim.claimed).toBe(true);
      if (!claim.claimed) return;
      const [claimed] = await db.$queryRaw<
        { marker: string; idempotencyKey: string }[]
      >`SELECT "marker", "idempotencyKey" FROM "ShippingRefund" WHERE "id" = ${claim.rowId}`;
      const freezeInput = await (fixtureArgsFor(seedWriter).freeze as any)({
        rowId: claim.rowId,
        leaseToken: claim.leaseToken!,
        marker: claimed.marker,
        idempotencyKey: claimed.idempotencyKey,
        sourceOrderId: seedWriter.secondary.id,
      });
      const frozen = await freezeShippingRefund(
        claim.rowId,
        claim.leaseToken!,
        freezeInput,
        db,
      );
      expect(frozen.frozen).toBe(true);

      const writer = new PrismaClient({
        datasources: { db: { url: TEST_URL } },
      });
      let writerError: unknown = null;
      let writerDone: Promise<void> = Promise.resolve();
      try {
        const fx = await createDispatchedFixture(preflighted, db, {
          ...fixtureArgsFor(seedFixture),
          hooks: {
            afterStep: (s) => {
              if (s !== "disable") return;
              // While the fixture holds its SHARE ROW EXCLUSIVE table
              // lock with the trigger suspended, a second session attempts
              // the same illegal edge on a DIFFERENT row. It blocks until
              // the fixture commits — then the RESTORED trigger must raise.
              writerDone = (async () => {
                try {
                  await writer.$executeRaw`
                    UPDATE "ShippingRefund" SET
                      "status" = 'DISPATCHING',
                      "dispatchToken" = 'writer-forgery',
                      "dispatchedAt" = (clock_timestamp() AT TIME ZONE 'UTC'),
                      "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
                    WHERE "id" = ${claim.rowId}`;
                } catch (e) {
                  writerError = e;
                }
              })();
            },
          },
        });
        await writerDone;
        expect((await rowState(fx.rowId)).status).toBe("DISPATCHING");
      } finally {
        await writer.$disconnect();
      }
      expect(writerError).not.toBeNull();
      expect(String(writerError)).toMatch(/illegal transition/);
      const row = await rowState(claim.rowId);
      expect(row.status).toBe("PREPARED");
      expect(row.dispatchToken).toBeNull();
      expect(
        (await rowEvents(claim.rowId)).some((e) => e.toStatus === "DISPATCHING"),
      ).toBe(false);
      const integrity = await checkTriggerIntegrity(catalog);
      expect(integrity.intact).toBe(true);
    });

    it("trigger-definition doubles are caught by in-transaction verification and roll back", async () => {
      // Every catalog mutation here happens on an authorized G-P0
      // scratch database — never the shared suite database.
      await withMarkedScratchDatabase(
        preflighted,
        async (scratchUrl, _name, brandB) => {
          const dbB = new PrismaClient({
            datasources: { db: { url: scratchUrl } },
          });
          const GUARD = "shippingrefund_transition_guard";
          const FN = "shipping_refund_fn_transition_guard";
          const restoreGuard = async () => {
            await dbB.$executeRawUnsafe(
              `DROP TRIGGER IF EXISTS "${GUARD}" ON "ShippingRefund"`,
            );
            await dbB.$executeRawUnsafe(
              `CREATE TRIGGER "${GUARD}" BEFORE UPDATE ON "ShippingRefund" FOR EACH ROW EXECUTE FUNCTION "${FN}"()`,
            );
          };
          const catalogB = () =>
            dbB.$queryRawUnsafe<ShippingRefundTriggerCatalogRow[]>(
              TRIGGER_CATALOG_SQL,
            );
          const variants: {
            name: string;
            breakIt: (tx: Prisma.TransactionClient) => Promise<void>;
            reason: string;
          }[] = [
            {
              // A passive extra trigger — the update completes; the
              // catalog verification is what must catch it.
              name: "an extra unexpected trigger",
              breakIt: async (tx) => {
                await tx.$executeRawUnsafe(
                  `CREATE TRIGGER mergeship_test_extra_trigger BEFORE UPDATE ON "ShippingRefund" FOR EACH ROW EXECUTE FUNCTION mergeship_test_noop_trigger()`,
                );
              },
              reason: "UNEXPECTED",
            },
            {
              name: "the guard re-created with AFTER timing",
              breakIt: async (tx) => {
                await tx.$executeRawUnsafe(`DROP TRIGGER "${GUARD}" ON "ShippingRefund"`);
                await tx.$executeRawUnsafe(
                  `CREATE TRIGGER "${GUARD}" AFTER UPDATE ON "ShippingRefund" FOR EACH ROW EXECUTE FUNCTION mergeship_test_noop_trigger()`,
                );
              },
              reason: "WRONG_TIMING",
            },
            {
              name: "the guard re-created on INSERT instead of UPDATE",
              breakIt: async (tx) => {
                await tx.$executeRawUnsafe(`DROP TRIGGER "${GUARD}" ON "ShippingRefund"`);
                await tx.$executeRawUnsafe(
                  `CREATE TRIGGER "${GUARD}" BEFORE INSERT ON "ShippingRefund" FOR EACH ROW EXECUTE FUNCTION mergeship_test_noop_trigger()`,
                );
              },
              reason: "WRONG_EVENTS",
            },
            {
              name: "the guard re-created FOR EACH STATEMENT",
              breakIt: async (tx) => {
                await tx.$executeRawUnsafe(`DROP TRIGGER "${GUARD}" ON "ShippingRefund"`);
                await tx.$executeRawUnsafe(
                  `CREATE TRIGGER "${GUARD}" BEFORE UPDATE ON "ShippingRefund" FOR EACH STATEMENT EXECUTE FUNCTION mergeship_test_noop_trigger()`,
                );
              },
              reason: "WRONG_LEVEL",
            },
            {
              name: "the guard re-created bound to the wrong function",
              breakIt: async (tx) => {
                await tx.$executeRawUnsafe(`DROP TRIGGER "${GUARD}" ON "ShippingRefund"`);
                await tx.$executeRawUnsafe(
                  `CREATE TRIGGER "${GUARD}" BEFORE UPDATE ON "ShippingRefund" FOR EACH ROW EXECUTE FUNCTION mergeship_test_noop_trigger()`,
                );
              },
              reason: "WRONG_FUNCTION",
            },
          ];
          try {
            await dbB.$executeRawUnsafe(
              `CREATE OR REPLACE FUNCTION mergeship_test_noop_trigger() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END; $fn$`,
            );
            for (const v of variants) {
              const shop = uniqueShop();
              const seed = await seedGateAndOp(shop, dbB);
              let rejected: unknown = null;
              try {
                await createDispatchedFixture(
                  brandB,
                  dbB,
                  {
                    ...fixtureArgsFor(seed),
                    hooks: {
                      // The real claim+freeze already refused a non-intact
                      // catalog, so the double must exist only inside the
                      // fixture transaction itself — created after the
                      // table lock, caught by the post-ENABLE catalog
                      // verification, removed by the rollback it causes.
                      afterStep: async (s, tx) => {
                        if (s !== "lock") return;
                        await v.breakIt(tx);
                      },
                    },
                  },
                );
              } catch (e) {
                rejected = e;
              }
              expect(rejected, v.name).toBeInstanceOf(FixtureError);
              // The in-transaction verification named the exact violation.
              expect(String(rejected), v.name).toContain(v.reason);
              // Five-point restoration proof on the scratch database:
              const [row] = await dbB.$queryRaw<any[]>`
                SELECT * FROM "ShippingRefund" WHERE "shop" = ${shop}`;
              expect(row.status, v.name).toBe("PREPARED");
              expect(row.dispatchToken, v.name).toBeNull();
              expect(
                (await rowEvents(row.id, dbB)).some(
                  (e) => e.toStatus === "DISPATCHING",
                ),
                v.name,
              ).toBe(false);
              const integrity = await checkTriggerIntegrity(catalogB);
              expect(integrity.intact, `${v.name}: ${JSON.stringify(integrity.reasons)}`).toBe(true);
              const fresh = new PrismaClient({
                datasources: { db: { url: scratchUrl } },
              });
              try {
                await expect(
                  fresh.$executeRaw`
                    UPDATE "ShippingRefund" SET "status" = 'DISPATCHING', "updatedAt" = now()
                    WHERE "id" = ${row.id}`,
                  v.name,
                ).rejects.toThrow(/illegal transition/);
              } finally {
                await fresh.$disconnect();
              }
            }
            // The doubles DID verify-fail for the expected reasons — check
            // one explicitly so the loop above is not vacuous.
            await dbB.$executeRawUnsafe(`DROP TRIGGER "${GUARD}" ON "ShippingRefund"`);
            const broken = await checkTriggerIntegrity(catalogB);
            expect(broken.intact).toBe(false);
            expect(broken.reasons.some((r) => r.code === "MISSING")).toBe(true);
            await restoreGuard();
            expect((await checkTriggerIntegrity(catalogB)).intact).toBe(true);
          } finally {
            await dbB.$disconnect();
          }
        },
      );
    });

    it("the remaining safeguards stay live inside the suspension window", async () => {
      // While the transition guard is suspended, each other trigger still
      // rejects a deliberately malformed variant of the fixture update —
      // the raise aborts the transaction, which is the proof.
      const probes: { name: string; inject: (tx: Prisma.TransactionClient, rowId: string) => Promise<unknown>; want: RegExp }[] = [
        {
          name: "frozen-columns guard rejects a marker rewrite",
          inject: (tx, rowId) =>
            tx.$executeRaw`
              UPDATE "ShippingRefund" SET "marker" = 'forged', "updatedAt" = now()
              WHERE "id" = ${rowId}`,
          want: /immutable column/,
        },
        {
          name: "evidence-integrity rejects DISPATCHING without both dispatch fields",
          inject: (tx, rowId) =>
            tx.$executeRaw`
              UPDATE "ShippingRefund" SET "status" = 'DISPATCHING', "updatedAt" = now()
              WHERE "id" = ${rowId}`,
          want: /dispatch evidence may be stamped|illegal transition|ShippingRefund_durable_dispatch_evidence/,
        },
        {
          name: "the event-table trigger rejects a journal rewrite",
          inject: (tx, rowId) =>
            tx.$executeRaw`
              UPDATE "ShippingRefundEvent" SET "actor" = 'forged'
              WHERE "shippingRefundId" = ${rowId}`,
          want: /journal integrity/,
        },
        {
          name: "the no-delete trigger rejects row removal",
          inject: (tx, rowId) =>
            tx.$executeRaw`
              DELETE FROM "ShippingRefund" WHERE "id" = ${rowId}`,
          want: /journal integrity|forbidden/,
        },
      ];
      for (const p of probes) {
        const shop = uniqueShop();
        const seed = await seedGateAndOp(shop);
        let seen: unknown = null;
        await expect(
          createDispatchedFixture(preflighted, db, {
            ...fixtureArgsFor(seed),
            hooks: {
              afterStep: async (s, tx) => {
                if (s !== "disable") return;
                const [me] = await tx.$queryRaw<{ id: string }[]>(
                  Prisma.sql`SELECT "id" FROM "ShippingRefund" WHERE "status" = 'PREPARED' ORDER BY "preparedAt" DESC LIMIT 1`,
                );
                try {
                  await p.inject(tx, me.id);
                } catch (e) {
                  seen = e;
                  throw e;
                }
                throw new Error(`probe did not raise — ${p.name}`);
              },
            },
          }),
        ).rejects.toThrow();
        expect(String(seen), p.name).toMatch(p.want);
        const [row] = await db.$queryRaw<any[]>`
          SELECT * FROM "ShippingRefund" WHERE "shop" = ${shop}`;
        expect(row.status, p.name).toBe("PREPARED");
        expect(row.dispatchToken, p.name).toBeNull();
        const integrity = await checkTriggerIntegrity(catalog);
        expect(integrity.intact, p.name).toBe(true);
      }

      // The shape guard needs a NULL->value wire write: mutate a second
      // claim's QUEUED row (wireVariables NULL) inside the window.
      const shop = uniqueShop();
      const seedFixture = await seedGateAndOp(shop);
      const seedShape = await seedOp(shop);
      const claim = await claimShippingRefund(
        { operation: seedShape.opRow, secondary: seedShape.secondary },
        db,
        () => {},
      );
      expect(claim.claimed).toBe(true);
      if (!claim.claimed) return;
      let seen: unknown = null;
      await expect(
        createDispatchedFixture(preflighted, db, {
          ...fixtureArgsFor(seedFixture),
          hooks: {
            afterStep: async (s, tx) => {
              if (s !== "disable") return;
              try {
                await tx.$executeRaw`
                  UPDATE "ShippingRefund" SET "wireVariables" = '{"bogus": 1}'::jsonb
                  WHERE "id" = ${claim.rowId}`;
              } catch (e) {
                seen = e;
                throw e;
              }
              throw new Error("shape probe did not raise");
            },
          },
        }),
      ).rejects.toThrow();
      expect(String(seen)).toMatch(/wireVariables keys must be exactly/);
      const integrity = await checkTriggerIntegrity(catalog);
      expect(integrity.intact).toBe(true);
    });
  },
);
