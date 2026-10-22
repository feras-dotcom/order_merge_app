// Real-Postgres integration tests for the S1-F read-only reconciliation
// and recovery milestone (§§6.1, 9.5, 12.1–12.8, 13, 20.1).
//
// Every post-dispatch row here is a §19.2.1 fixture: the runtime cannot
// mint DISPATCHING (I27), so rows are created by the audited test-only
// helper, then driven through the REAL reconciliation cycle
// (runShippingRefundReconcileCycle) and the REAL lease-fenced writer
// (writeReconcileTransition). All Shopify evidence is an injected fake
// implementing the four pinned documents; it is schema-derived test
// evidence, never a validated Shopify response (12.8.5, 20.1.1).
//
// Opt-in (same gate as every real-database suite):
//
//   MERGESHIP_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:PORT/mergeship_test \
//   MERGESHIP_SHADOW_TOKEN=<operator token> \
//     npx vitest run tests/shipping-refund-reconcile-pg.test.ts
//
// Destructive-scope note: ShippingRefundEvent is append-only; this suite
// never deletes or truncates it. Rows are isolated by unique shops and
// order ids and left in place.

import { execSync } from "child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import type { AdminClient } from "../app/lib/graphql.server";
import {
  claimShippingRefund,
  freezeShippingRefund,
  leaseReconcileShippingRefund,
  resolveShippingRefundReview,
  writeReconcileTransition,
} from "../app/lib/shipping-refund-store.server";
import {
  auditShippingRefundOrphans,
  runShippingRefundReconcileCycle,
  type ShippingRefundReconcileTestDeps,
} from "../app/lib/shipping-refund-reconcile.server";
import {
  buildFrozenWireContract,
  buildRefundNote,
} from "../app/lib/shipping-refund-contract";
import {
  checkTriggerIntegrity,
  TRIGGER_CATALOG_SQL,
  type ShippingRefundTriggerCatalogRow,
} from "../app/lib/shipping-refund-trigger-manifest";
import {
  preflightDisposableDatabase,
  withMarkedScratchDatabase,
  type PreflightedDatabase,
} from "./helpers/disposable-db";
import {
  createDispatchedFixture,
  type DispatchedFixtureArgs,
} from "./helpers/shipping-refund-fixture";

const TEST_URL = process.env.MERGESHIP_TEST_DATABASE_URL;
const oid = (n: number) => `gid://shopify/Order/${n}`;
const txn = (n: number) => `gid://shopify/OrderTransaction/${n}`;
// ShippingRefund.refundId has a GLOBAL unique index and the journal tables
// are append-only, so a deterministic Gid collides with rows left by any
// earlier run of this suite. Salt every Refund Gid with a per-run value so
// each execution occupies its own id space (digits only — REFUND_GID_PATTERN).
const REFUND_RUN_SALT = `${Date.now()}${Math.floor(Math.random() * 1e6)
  .toString()
  .padStart(6, "0")}`;
const refundGid = (n: number) =>
  `gid://shopify/Refund/${REFUND_RUN_SALT}${n.toString().padStart(6, "0")}`;
const agreementGid = (n: number) => `gid://shopify/RefundAgreement/${n}`;
const APP_GID = "gid://shopify/App/424242";

const naive = (iso: string) => Prisma.sql`(${iso}::timestamptz AT TIME ZONE 'UTC')`;
const EPOCH = "2026-10-10T00:00:00.000Z";
const TXN_AUTH = txn(900);
const TXN_CAP = txn(901);
const TXN_REFUND = txn(902);

const PM = (amount: string, currencyCode = "USD") => ({
  presentmentMoney: { amount, currencyCode },
});

describe.skipIf(!TEST_URL)(
  "shipping-refund S1-F reconciliation and recovery (real disposable database)",
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
      // EXECUTE lane on while fixtures are minted (PREPARED requires it);
      // individual tests flip the switches off to prove independence.
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

    const uniqueShop = () => `s1f-rc-${randomUUID()}.myshopify.com`;
    let orderSeq = 900_000;
    const nextOrder = () => oid(++orderSeq);
    let opSeq = 0;
    const nextOpId = () => `op_s1f_rc_${++opSeq}_${randomUUID().slice(0, 8)}`;

    const dbWall = async (client: PrismaClient = db): Promise<Date> => {
      const [row] = await client.$queryRaw<{ wall: Date }[]>`
        SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "wall"`;
      return row.wall;
    };
    const ago = (ms: number, client: PrismaClient = db) =>
      dbWall(client).then((w) => new Date(w.getTime() - ms));
    const agoIso = async (ms: number, client: PrismaClient = db) =>
      (await ago(ms, client)).toISOString();
    const rowState = async (rowId: string, client: PrismaClient = db) =>
      (
        await client.$queryRaw<any[]>`
          SELECT * FROM "ShippingRefund" WHERE "id" = ${rowId}`
      )[0] ?? null;
    const rowEvents = async (rowId: string, client: PrismaClient = db) =>
      client.$queryRaw<{ fromStatus: string | null; toStatus: string; actor: string }[]>`
        SELECT "fromStatus", "toStatus", "actor" FROM "ShippingRefundEvent"
        WHERE "shippingRefundId" = ${rowId} ORDER BY "at" ASC, "id" ASC`;
    const eventStatuses = async (rowId: string) =>
      (await rowEvents(rowId)).map((e) => `${e.fromStatus ?? "∅"}→${e.toStatus}`);

    const seededShops = new Set<string>();

    /** `client` lets scratch-database tests seed their own target — the
     *  control rows are seeded per client, so a fresh scratch gets its
     *  own open gates. */
    async function seedGateAndOp(shop: string, client: PrismaClient = db) {
      const wall = await dbWall(client);
      const cancelledAt = new Date(wall.getTime() - 3600e3).toISOString();
      const primaryId = nextOrder();
      const secondaryId = nextOrder();
      if (!seededShops.has(shop)) {
        seededShops.add(shop);
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
          VALUES (${shop}, ${naive(EPOCH)}, 's1f-reconcile-test', NULL,
            ${naive(EPOCH)}, 'v1', ${naive(EPOCH)}, 'USD', '0')`;
      }
      const opId = nextOpId();
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
      const [opRow] = await client.$queryRaw<any[]>`
        SELECT * FROM "MergeOperation" WHERE "id" = ${opId}`;
      return { opRow, secondary: { id: secondaryId, cancelledAt }, secondaryId };
    }

    const fixtureArgsFor = (
      seed: { opRow: any; secondary: { id: string; cancelledAt: string } },
      over: { plannedMinor?: string } = {},
    ): Omit<DispatchedFixtureArgs, "dispatchedAt" | "hooks" | "log"> => ({
      operation: seed.opRow,
      secondary: seed.secondary,
      freeze: ({ marker, idempotencyKey, sourceOrderId }) => {
        const minor = over.plannedMinor ?? "800";
        const contract = buildFrozenWireContract({
          sourceOrderId,
          parentTransactionId: TXN_CAP,
          gateway: "bogus",
          plannedShippingMinor: minor,
          currencyCode: "USD",
          marker,
          idempotencyKey,
        });
        return {
          contract,
          financialColumns: {
            currencyCode: "USD",
            plannedShippingMinor: minor,
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
              transactionIds: [TXN_AUTH, TXN_CAP],
              monetaryTransactionCount: 1,
            },
          },
        };
      },
    });

    /** A stale (>120 s) DISPATCHING fixture row. `client`/`brand` target a
     *  marked scratch database when given. */
    const makeDispatching = async (
      shop: string,
      dispatchedAgoMs = 10 * 60_000,
      over: { plannedMinor?: string } = {},
      client: PrismaClient = db,
      brand: PreflightedDatabase = preflighted,
    ) => {
      const seed = await seedGateAndOp(shop, client);
      const fx = await createDispatchedFixture(brand, client, {
        ...fixtureArgsFor(seed, over),
        dispatchedAt: await agoIso(dispatchedAgoMs, client),
      });
      return { ...fx, secondaryId: seed.secondary.id };
    };

    /** Drive one real transition on a fixture row through the real writer. */
    const transition = async (
      rowId: string,
      outcome: Parameters<typeof writeReconcileTransition>[2],
      client: PrismaClient = db,
    ) => {
      const lease = await leaseReconcileShippingRefund(rowId, {}, client);
      expect(lease.leased).toBe(true);
      if (!lease.leased) throw new Error(`lease refused: ${lease.reason}`);
      const w = await writeReconcileTransition(rowId, lease.leaseToken, outcome, client);
      if (!w.written) throw new Error(`write refused: ${w.reason}`);
      return w;
    };

    const makeInDoubt = async (
      shop: string,
      dispatchedAgoMs = 10 * 60_000,
      over: { plannedMinor?: string } = {},
      client: PrismaClient = db,
      brand: PreflightedDatabase = preflighted,
    ) => {
      const fx = await makeDispatching(shop, dispatchedAgoMs, over, client, brand);
      await transition(fx.rowId, {
        to: "IN_DOUBT",
        reasonCode: "DISPATCH_UNANSWERED",
      }, client);
      return fx;
    };

    const makeRefundRecorded = async (
      shop: string,
      refundId: string,
      dispatchedAgoMs = 10 * 60_000,
      over: { plannedMinor?: string; settlementState?: string } = {},
    ) => {
      const fx = await makeInDoubt(shop, dispatchedAgoMs, over);
      await transition(fx.rowId, {
        to: "REFUND_RECORDED",
        refundId,
        refundCreatedAt: new Date(Date.now() - dispatchedAgoMs / 2).toISOString(),
        settlementState: over.settlementState ?? "SUCCESS",
      });
      return fx;
    };

    // ── Injected Shopify evidence (schema-derived fixtures, §20.1.1) ──────

    interface Evidence {
      refunds?: any[];
      transactions?: any[];
      totalRefunded?: string;
      totalRefundedShipping?: string;
      details?: Record<string, any>;
      agreements?: any[] | ((vars: any, n: number) => any);
      appId?: string;
      orderOverrides?: Record<string, unknown>;
      malformedList?: boolean;
    }

    /** A complete, consistent evidence set for refund `rid` of `amount`. */
    const fullEvidence = (args: {
      rid: string;
      srcId: string;
      marker: string;
      amount?: string;
      dispatchedAt: string;
      txnStatus?: string;
      agreement?: Record<string, unknown> | null | "omit";
      details?: Record<string, any>;
      extraListRefunds?: any[];
      orderOverrides?: Record<string, unknown>;
    }): Evidence => {
      const amount = args.amount ?? "8.00";
      const processed = new Date(
        Date.parse(args.dispatchedAt) + 30_000,
      ).toISOString();
      const created = new Date(
        Date.parse(args.dispatchedAt) + 25_000,
      ).toISOString();
      const note = buildRefundNote(args.marker, args.srcId);
      const detail =
        args.details?.[args.rid] ??
        detailNode(args.rid, args.srcId, {
          note,
          createdAt: created,
          processedAt: processed,
          total: amount,
          txnStatus: args.txnStatus ?? "SUCCESS",
        });
      return {
        refunds: [
          {
            id: args.rid,
            note,
            createdAt: created,
            processedAt: processed,
            totalRefundedSet: PM(amount),
          },
          ...(args.extraListRefunds ?? []),
        ],
        transactions: [
          authTxn(TXN_AUTH),
          capTxn(TXN_CAP),
          refundTxn(TXN_REFUND, args.txnStatus ?? "SUCCESS", amount),
        ],
        totalRefunded: amount,
        totalRefundedShipping: amount,
        details: { [args.rid]: detail, ...(args.details ?? {}) },
        agreements:
          args.agreement === "omit"
            ? []
            : [
                agreementNode(1, {
                  app: { id: APP_GID },
                  refund: { id: args.rid },
                  happenedAt: processed,
                  ...(args.agreement ?? {}),
                }),
              ],
        appId: APP_GID,
        orderOverrides: args.orderOverrides,
      };
    };

    const authTxn = (id: string) => ({
      id,
      kind: "AUTHORIZATION",
      status: "SUCCESS",
      gateway: "bogus",
      test: true,
      amountSet: PM("18.00"),
      parentTransaction: null,
    });
    const capTxn = (id: string) => ({
      id,
      kind: "CAPTURE",
      status: "SUCCESS",
      gateway: "bogus",
      test: true,
      amountSet: PM("18.00"),
      parentTransaction: { id: TXN_AUTH },
    });
    const refundTxn = (id: string, status: string, amount = "8.00") => ({
      id,
      kind: "REFUND",
      status,
      gateway: "bogus",
      test: true,
      amountSet: PM(amount),
      parentTransaction: { id: TXN_CAP },
    });

    const detailNode = (
      id: string,
      srcId: string,
      over: {
        note?: string;
        createdAt?: string;
        processedAt?: string | null;
        total?: string;
        shippingLines?: any[] | null;
        refundLineItems?: any[];
        orderAdjustments?: any[];
        duties?: any[];
        txns?: any[];
        txnStatus?: string;
      } = {},
    ) => ({
      id,
      note: over.note ?? null,
      createdAt: over.createdAt ?? null,
      processedAt: over.processedAt === undefined ? over.createdAt ?? null : over.processedAt,
      order: { id: srcId },
      totalRefundedSet: PM(over.total ?? "8.00"),
      duties: over.duties ?? [],
      refundShippingLines: {
        nodes:
          over.shippingLines === undefined
            ? [{ subtotalAmountSet: PM(over.total ?? "8.00"), taxAmountSet: PM("0.00") }]
            : (over.shippingLines ?? []),
        pageInfo: { hasNextPage: false },
      },
      refundLineItems: {
        nodes: over.refundLineItems ?? [],
        pageInfo: { hasNextPage: false },
      },
      orderAdjustments: {
        nodes: over.orderAdjustments ?? [],
        pageInfo: { hasNextPage: false },
      },
      transactions: {
        nodes: over.txns ?? [refundTxn(TXN_REFUND, over.txnStatus ?? "SUCCESS")],
        pageInfo: { hasNextPage: false },
      },
    });

    const agreementNode = (n: number, over: Record<string, unknown> = {}) => ({
      __typename: "RefundAgreement",
      id: agreementGid(n),
      happenedAt: new Date().toISOString(),
      reason: "REFUND",
      app: { id: APP_GID },
      refund: { id: refundGid(1) },
      ...over,
    });

    /** Admin fake routing the four pinned documents by name; a mutation
     *  throws — the reconciler must never issue one. */
    function reconAdmin(ev: Evidence | ((vars: any, n: number) => Evidence)) {
      const calls: { query: string; variables: any }[] = [];
      const get = (vars: any, n: number) =>
        typeof ev === "function" ? ev(vars, n) : ev;
      const admin = {
        calls,
        graphql: async (query: string, options?: { variables?: any }) => {
          calls.push({ query, variables: options?.variables });
          if (/mutation\b/.test(query)) {
            throw new Error("a mutation must never be issued");
          }
          const n = calls.length;
          const e = get(options?.variables, n);
          let payload: unknown;
          if (query.includes("ShippingRefundAppIdentity")) {
            payload = {
              currentAppInstallation: { app: { id: e.appId ?? APP_GID } },
            };
          } else if (query.includes("ShippingRefundDetail")) {
            const ids = (options?.variables?.ids ?? []) as string[];
            payload = {
              nodes: ids.map(
                (id) =>
                  e.details?.[id] ?? {
                    __missing: id,
                  },
              ),
            };
          } else if (query.includes("ShippingRefundAgreements")) {
            const nodes =
              typeof e.agreements === "function"
                ? e.agreements(options?.variables, n)
                : (e.agreements ?? []);
            payload = {
              order: {
                agreements: {
                  nodes: Array.isArray(nodes) ? nodes : nodes.nodes,
                  pageInfo: Array.isArray(nodes)
                    ? { hasNextPage: false, endCursor: null }
                    : nodes.pageInfo,
                },
              },
            };
          } else {
            // ShippingRefundReconcile
            if (e.malformedList) {
              payload = { order: null };
            } else {
              payload = {
                order: {
                  id: options?.variables?.source,
                  cancelledAt: "2026-10-15T09:30:00Z",
                  closed: true,
                  displayFinancialStatus: "PAID",
                  currencyCode: "USD",
                  totalRefundedSet: PM(e.totalRefunded ?? "0.00"),
                  totalRefundedShippingSet: PM(e.totalRefundedShipping ?? "0.00"),
                  refunds: e.refunds ?? [],
                  transactions: e.transactions ?? [authTxn(TXN_AUTH), capTxn(TXN_CAP)],
                  ...(e.orderOverrides ?? {}),
                },
              };
            }
          }
          return { json: async () => ({ data: payload }) } as any;
        },
      };
      return admin as AdminClient & {
        calls: { query: string; variables: any }[];
      };
    }

    const usableSession = () =>
      Promise.resolve({ expires: new Date(Date.now() + 3600e3) });

    const runCycle = (
      shops: string[],
      admin: AdminClient,
      over: Partial<ShippingRefundReconcileTestDeps> = {},
    ) =>
      runShippingRefundReconcileCycle(
        shops,
        {
          adminFactory: async () => admin,
          sessionLoader: usableSession,
          log: () => {},
          ...over,
        },
        db,
      );

    // ── The demonstrations ────────────────────────────────────────────────

    it("sweeps a stale unanswered DISPATCHING row to IN_DOUBT — no resend, journaled", async () => {
      const shop = uniqueShop();
      const fx = await makeDispatching(shop, 3 * 60_000);
      const admin = reconAdmin({}); // empty list — the marker refund is not visible
      const reports = await runCycle([shop], admin);
      expect(reports[0].sweptToInDoubt).toBe(1);
      const row = await rowState(fx.rowId);
      expect(row.status).toBe("IN_DOUBT");
      expect(row.reasonCode).toBe("DISPATCH_UNANSWERED");
      expect(await eventStatuses(fx.rowId)).toEqual([
        "∅→QUEUED",
        "QUEUED→PREPARED",
        "PREPARED→DISPATCHING",
        "DISPATCHING→IN_DOUBT",
      ]);
      // Read-only: the only Shopify traffic is Q-RECONCILE / detail /
      // agreements / appId queries — never a mutation, never a resend.
      for (const c of admin.calls) expect(c.query).toMatch(/^query /);
    });

    it("leaves a recent DISPATCHING row alone (the 120 s window has not passed)", async () => {
      const shop = uniqueShop();
      const fx = await makeDispatching(shop, 30_000);
      const admin = reconAdmin({});
      const reports = await runCycle([shop], admin);
      expect(reports[0].sweptToInDoubt).toBe(0);
      const row = await rowState(fx.rowId);
      expect(row.status).toBe("DISPATCHING");
      expect((await rowEvents(fx.rowId)).some((e) => e.toStatus === "IN_DOUBT")).toBe(false);
    });

    it("a marker refund still invisible inside the window waits; past 24 h it parks review", async () => {
      const shop = uniqueShop();
      const a = await makeInDoubt(shop, 10 * 60_000);
      const admin = reconAdmin({});
      let reports = await runCycle([shop], admin);
      expect(reports[0].outcomes["WAIT:visibility"]).toBe(1);
      let row = await rowState(a.rowId);
      expect(row.status).toBe("IN_DOUBT");
      expect(row.nextCheckAt).not.toBeNull();
      // WAIT reschedules without a status event.
      expect((await rowEvents(a.rowId)).filter((e) => e.toStatus === "IN_DOUBT")).toHaveLength(1);

      // Absent evidence after the 24-hour window is human review — never
      // a conclusion that no money moved.
      const b = await makeInDoubt(shop, 25 * 3600e3);
      reports = await runCycle([shop], reconAdmin({}));
      const bRow = await rowState(b.rowId);
      expect(bRow.status).toBe("REVIEW_REQUIRED");
      expect(bRow.reasonCode).toBe("ABSENT_AFTER_WINDOW");
      expect(await eventStatuses(b.rowId)).toContain("IN_DOUBT→REVIEW_REQUIRED");
    });

    it("adopts and verifies a fully evidenced refund under injected CONFIRMED attribution", async () => {
      const shop = uniqueShop();
      const rid = refundGid(5001);
      const dispatchedAt = await agoIso(10 * 60_000);
      const fx = await makeInDoubt(shop, 10 * 60_000);
      const marker = (await rowState(fx.rowId)).marker as string;
      const ev = fullEvidence({
        rid,
        srcId: fx.secondaryId,
        marker,
        dispatchedAt,
      });
      const admin = reconAdmin(ev);
      let reports = await runCycle([shop], admin, {
        attributionStatus: "CONFIRMED",
      });
      expect(
        reports[0].outcomes["ADOPTED:REFUND_RECORDED"],
        `outcomes: ${JSON.stringify(reports[0].outcomes)} errors: ${JSON.stringify(reports[0].errors)}`,
      ).toBe(1);
      let row = await rowState(fx.rowId);
      expect(row.status).toBe("REFUND_RECORDED");
      expect(row.refundId).toBe(rid);
      expect(row.settlementState).toBe("SUCCESS");

      // The next cycle verifies — the full IN_DOUBT -> REFUND_RECORDED ->
      // VERIFIED chain is journaled.
      reports = await runCycle([shop], admin, {
        attributionStatus: "CONFIRMED",
      });
      expect(reports[0].outcomes["VERIFIED"]).toBe(1);
      row = await rowState(fx.rowId);
      expect(row.status).toBe("VERIFIED");
      expect(row.verifiedEvidence).toMatchObject({
        refundId: rid,
        appId: APP_GID,
        aggregateCheck: "verified",
      });
      expect(await eventStatuses(fx.rowId)).toEqual([
        "∅→QUEUED",
        "QUEUED→PREPARED",
        "PREPARED→DISPATCHING",
        "DISPATCHING→IN_DOUBT",
        "IN_DOUBT→REFUND_RECORDED",
        "REFUND_RECORDED→VERIFIED",
      ]);
    });

    it("the identical evidence under the production UNVERIFIED pin can never adopt", async () => {
      const shop = uniqueShop();
      const rid = refundGid(5002);
      const dispatchedAt = await agoIso(10 * 60_000);
      const fx = await makeInDoubt(shop, 10 * 60_000);
      const marker = (await rowState(fx.rowId)).marker as string;
      const admin = reconAdmin(
        fullEvidence({ rid, srcId: fx.secondaryId, marker, dispatchedAt }),
      );
      // No attributionStatus override — the pinned UNVERIFIED applies.
      const reports = await runCycle([shop], admin);
      expect(reports[0].outcomes["ADOPTED:REFUND_RECORDED"] ?? 0).toBe(0);
      expect(reports[0].outcomes["WAIT:attribution"]).toBe(1);
      const row = await rowState(fx.rowId);
      expect(row.status).toBe("IN_DOUBT");
      expect(row.refundId).toBeNull();
    });

    it("UNVERIFIED attribution past the window parks review — still no adoption", async () => {
      const shop = uniqueShop();
      const rid = refundGid(5003);
      const dispatchedAt = await agoIso(25 * 3600e3);
      const fx = await makeInDoubt(shop, 25 * 3600e3);
      const marker = (await rowState(fx.rowId)).marker as string;
      const admin = reconAdmin(
        fullEvidence({ rid, srcId: fx.secondaryId, marker, dispatchedAt }),
      );
      const reports = await runCycle([shop], admin);
      expect(reports[0].outcomes["REVIEW:ATTRIBUTION_UNVERIFIED"]).toBe(1);
      const row = await rowState(fx.rowId);
      expect(row.status).toBe("REVIEW_REQUIRED");
      expect(row.refundId).toBeNull();
    });

    it("a REFUND_RECORDED row under UNVERIFIED is never verified — attribution waits then parks", async () => {
      const shop = uniqueShop();
      const rid = refundGid(5004);
      // dispatchedAt 20 min ago → anchor (respondedAt ?? dispatchedAt) is
      // past the 15-minute visibility window → review, not wait.
      const fx = await makeRefundRecorded(shop, rid, 20 * 60_000);
      const marker = (await rowState(fx.rowId)).marker as string;
      const dispatchedAt = (await rowState(fx.rowId)).dispatchedAt.toISOString();
      const admin = reconAdmin(
        fullEvidence({ rid, srcId: fx.secondaryId, marker, dispatchedAt }),
      );
      const reports = await runCycle([shop], admin);
      expect(reports[0].outcomes["VERIFIED"] ?? 0).toBe(0);
      expect(
        (reports[0].outcomes["REVIEW:ATTRIBUTION_UNVERIFIED"] ?? 0) +
          (reports[0].outcomes["WAIT:attribution"] ?? 0),
      ).toBe(1);
      const row = await rowState(fx.rowId);
      expect(row.status).not.toBe("VERIFIED");
      expect(row.status).not.toBe("DISPATCHING");
    });

    it("wrong app id, duplicate linking agreements and a different refund link all refuse adoption", async () => {
      const shop = uniqueShop();
      const dispatchedAt = await agoIso(10 * 60_000);
      const fx1 = await makeInDoubt(shop, 10 * 60_000);
      const fx2 = await makeInDoubt(shop, 10 * 60_000);
      const fx3 = await makeInDoubt(shop, 10 * 60_000);
      const m1 = (await rowState(fx1.rowId)).marker as string;
      const m2 = (await rowState(fx2.rowId)).marker as string;
      const m3 = (await rowState(fx3.rowId)).marker as string;

      // Per-source evidence: three independent fake orders keyed by the
      // `source` variable; detail calls carry `ids`, resolved against the
      // union of all three detail maps.
      const bySrc = new Map<string, Evidence>();
      bySrc.set(fx1.secondaryId, fullEvidence({ rid: refundGid(5101), srcId: fx1.secondaryId, marker: m1, dispatchedAt, agreement: { app: { id: "gid://shopify/App/999" } } }));
      bySrc.set(fx2.secondaryId, {
        ...fullEvidence({ rid: refundGid(5102), srcId: fx2.secondaryId, marker: m2, dispatchedAt, agreement: "omit" }),
        agreements: [
          agreementNode(11, { refund: { id: refundGid(5102) } }),
          agreementNode(12, { refund: { id: refundGid(5102) } }),
        ],
      });
      bySrc.set(fx3.secondaryId, {
        ...fullEvidence({ rid: refundGid(5103), srcId: fx3.secondaryId, marker: m3, dispatchedAt, agreement: "omit" }),
        agreements: [
          agreementNode(13, { refund: { id: refundGid(7777) } }), // links a DIFFERENT refund
        ],
      });
      const mergedDetails = (): Record<string, any> =>
        Object.assign({}, ...[...bySrc.values()].map((e) => e.details));
      const admin = reconAdmin((vars) => {
        if (vars?.source) return bySrc.get(vars.source) ?? {};
        const ids = (vars?.ids ?? []) as string[];
        const all = mergedDetails();
        return {
          details: Object.fromEntries(ids.map((id) => [id, all[id]])),
          appId: APP_GID,
        };
      });
      const reports = await runCycle([shop], admin, {
        attributionStatus: "CONFIRMED",
      });
      expect(reports[0].outcomes["REVIEW:ATTRIBUTION_MISMATCH"]).toBe(3);
      for (const fx of [fx1, fx2, fx3]) {
        const row = await rowState(fx.rowId);
        expect(row.status).toBe("REVIEW_REQUIRED");
        expect(row.refundId).toBeNull();
      }
    });

    it("missing agreements wait inside the window and become ATTRIBUTION_UNAVAILABLE under CONFIRMED", async () => {
      const shop = uniqueShop();
      const rid = refundGid(5201);
      const dispatchedAt = await agoIso(25 * 3600e3);
      const fx = await makeInDoubt(shop, 25 * 3600e3);
      const marker = (await rowState(fx.rowId)).marker as string;
      const admin = reconAdmin(
        fullEvidence({ rid, srcId: fx.secondaryId, marker, dispatchedAt, agreement: "omit" }),
      );
      const reports = await runCycle([shop], admin, {
        attributionStatus: "CONFIRMED",
      });
      expect(reports[0].outcomes["REVIEW:ATTRIBUTION_UNAVAILABLE"]).toBe(1);
      expect((await rowState(fx.rowId)).status).toBe("REVIEW_REQUIRED");
    });

    it("an agreement list that never completes is unproven — wait, then review past the window", async () => {
      const shop = uniqueShop();
      const rid = refundGid(5202);
      const dispatchedAt = await agoIso(25 * 3600e3);
      const fx = await makeInDoubt(shop, 25 * 3600e3);
      const marker = (await rowState(fx.rowId)).marker as string;
      const ev = fullEvidence({ rid, srcId: fx.secondaryId, marker, dispatchedAt });
      ev.agreements = () => ({
        nodes: [agreementNode(21, { refund: { id: rid } })],
        pageInfo: { hasNextPage: true, endCursor: "c" },
      });
      const admin = reconAdmin(ev);
      const reports = await runCycle([shop], admin, {
        attributionStatus: "CONFIRMED",
      });
      // 5 pages read, all hasNextPage → unproven set → never satisfied.
      const agreementCalls = admin.calls.filter((c) =>
        c.query.includes("ShippingRefundAgreements"),
      );
      expect(agreementCalls).toHaveLength(5);
      expect(reports[0].outcomes["REVIEW:ATTRIBUTION_UNAVAILABLE"]).toBe(1);
      expect(reports[0].outcomes["ADOPTED:REFUND_RECORDED"] ?? 0).toBe(0);
    });

    it("settlement states classify: PENDING waits on the poll cadence, FAILURE and unsupported park review", async () => {
      const shop = uniqueShop();
      const dispatchedAt = await agoIso(10 * 60_000);

      const fxPend = await makeRefundRecorded(shop, refundGid(5301), 10 * 60_000);
      const fxFail = await makeRefundRecorded(shop, refundGid(5302), 10 * 60_000);
      const fxOdd = await makeRefundRecorded(shop, refundGid(5303), 10 * 60_000);
      const markers = new Map<string, string>();
      for (const fx of [fxPend, fxFail, fxOdd]) {
        markers.set(fx.secondaryId, (await rowState(fx.rowId)).marker as string);
      }

      const perSrc = new Map<string, Evidence>();
      perSrc.set(fxPend.secondaryId, fullEvidence({ rid: refundGid(5301), srcId: fxPend.secondaryId, marker: markers.get(fxPend.secondaryId)!, dispatchedAt, txnStatus: "PENDING" }));
      perSrc.set(fxFail.secondaryId, fullEvidence({ rid: refundGid(5302), srcId: fxFail.secondaryId, marker: markers.get(fxFail.secondaryId)!, dispatchedAt, txnStatus: "FAILURE" }));
      perSrc.set(fxOdd.secondaryId, fullEvidence({ rid: refundGid(5303), srcId: fxOdd.secondaryId, marker: markers.get(fxOdd.secondaryId)!, dispatchedAt, txnStatus: "AUTHORIZING" }));
      const admin = reconAdmin((vars) => {
        if (vars?.source) return perSrc.get(vars.source) ?? {};
        const ids = (vars?.ids ?? []) as string[];
        const merged: Evidence = {
          details: Object.assign({}, ...[...perSrc.values()].map((e) => e.details)),
          appId: APP_GID,
          refunds: [],
          transactions: [],
          agreements: [],
        };
        // detail calls get their per-id nodes from the merged detail map
        merged.details = Object.fromEntries(
          ids.map((id) => [id, merged.details?.[id]]),
        );
        return merged;
      });
      const reports = await runCycle([shop], admin, {
        attributionStatus: "CONFIRMED",
      });
      expect(reports[0].outcomes["WAIT:settlement"]).toBe(1);
      expect(reports[0].outcomes["REVIEW:SETTLEMENT_FAILED"]).toBe(1);
      expect(reports[0].outcomes["REVIEW:UNSUPPORTED_TXN_STATUS"]).toBe(1);
      expect((await rowState(fxFail.rowId)).reasonCode).toBe("SETTLEMENT_FAILED");
      expect((await rowState(fxOdd.rowId)).reasonCode).toBe("UNSUPPORTED_TXN_STATUS");
      // The PENDING row stays REFUND_RECORDED with a scheduled next check.
      const pend = await rowState(fxPend.rowId);
      expect(pend.status).toBe("REFUND_RECORDED");
      expect(pend.nextCheckAt).not.toBeNull();
    });

    it("contradictory financial evidence is ANOMALY review, never adoption", async () => {
      const shop = uniqueShop();
      const dispatchedAt = await agoIso(10 * 60_000);
      const fxWrong = await makeInDoubt(shop, 10 * 60_000);
      const fxTaxed = await makeInDoubt(shop, 10 * 60_000);
      const mWrong = (await rowState(fxWrong.rowId)).marker as string;
      const mTaxed = (await rowState(fxTaxed.rowId)).marker as string;

      const perSrc = new Map<string, Evidence>();
      perSrc.set(fxWrong.secondaryId, {
        ...fullEvidence({ rid: refundGid(5401), srcId: fxWrong.secondaryId, marker: mWrong, dispatchedAt }),
      });
      // Contradiction: refund total 9.00 vs planned 8.00.
      perSrc.get(fxWrong.secondaryId)!.details = {
        [refundGid(5401)]: detailNode(refundGid(5401), fxWrong.secondaryId, {
          total: "9.00",
          note: buildRefundNote(mWrong, fxWrong.secondaryId),
        }),
      };
      perSrc.get(fxWrong.secondaryId)!.refunds = [
        {
          id: refundGid(5401),
          note: buildRefundNote(mWrong, fxWrong.secondaryId),
          createdAt: dispatchedAt,
          processedAt: dispatchedAt,
          totalRefundedSet: PM("9.00"),
        },
      ];
      perSrc.set(fxTaxed.secondaryId, {
        ...fullEvidence({ rid: refundGid(5402), srcId: fxTaxed.secondaryId, marker: mTaxed, dispatchedAt }),
      });
      perSrc.get(fxTaxed.secondaryId)!.details = {
        [refundGid(5402)]: detailNode(refundGid(5402), fxTaxed.secondaryId, {
          note: buildRefundNote(mTaxed, fxTaxed.secondaryId),
          shippingLines: [
            { subtotalAmountSet: PM("8.00"), taxAmountSet: PM("0.40") },
          ],
        }),
      };

      const admin = reconAdmin((vars) => {
        if (vars?.source) return perSrc.get(vars.source) ?? {};
        const ids = (vars?.ids ?? []) as string[];
        const all = Object.assign({}, ...[...perSrc.values()].map((e) => e.details));
        return {
          details: Object.fromEntries(ids.map((id) => [id, all[id]])),
          appId: APP_GID,
        };
      });
      const reports = await runCycle([shop], admin, {
        attributionStatus: "CONFIRMED",
      });
      expect(reports[0].outcomes["REVIEW:ANOMALY"]).toBe(2);
      expect((await rowState(fxWrong.rowId)).refundId).toBeNull();
      expect((await rowState(fxTaxed.rowId)).refundId).toBeNull();
    });

    it("duplicate marker refunds and a foreign refund both park review", async () => {
      const shop = uniqueShop();
      const dispatchedAt = await agoIso(10 * 60_000);
      const fxDup = await makeInDoubt(shop, 10 * 60_000);
      const fxExt = await makeInDoubt(shop, 10 * 60_000);
      const mDup = (await rowState(fxDup.rowId)).marker as string;

      const note = buildRefundNote(mDup, fxDup.secondaryId);
      const perSrc = new Map<string, Evidence>();
      perSrc.set(fxDup.secondaryId, {
        refunds: [
          { id: refundGid(5501), note, createdAt: dispatchedAt, processedAt: dispatchedAt, totalRefundedSet: PM("8.00") },
          { id: refundGid(5502), note, createdAt: dispatchedAt, processedAt: dispatchedAt, totalRefundedSet: PM("8.00") },
        ],
        transactions: [authTxn(TXN_AUTH), capTxn(TXN_CAP)],
        totalRefunded: "16.00",
        totalRefundedShipping: "16.00",
      });
      // A foreign refund (not in the baseline, no marker) while ours is
      // absent → EXTERNAL_REFUND, never silently ignored.
      perSrc.set(fxExt.secondaryId, {
        refunds: [
          { id: refundGid(5599), note: "staff refund", createdAt: dispatchedAt, processedAt: dispatchedAt, totalRefundedSet: PM("4.00") },
        ],
        transactions: [authTxn(TXN_AUTH), capTxn(TXN_CAP)],
        totalRefunded: "4.00",
        totalRefundedShipping: "4.00",
      });
      const admin = reconAdmin((vars) => perSrc.get(vars?.source) ?? {});
      const reports = await runCycle([shop], admin, {
        attributionStatus: "CONFIRMED",
      });
      expect(reports[0].outcomes["REVIEW:DUPLICATE_SUSPECTED"]).toBe(1);
      expect(reports[0].outcomes["REVIEW:EXTERNAL_REFUND"]).toBe(1);
      expect((await rowState(fxDup.rowId)).status).toBe("REVIEW_REQUIRED");
      expect((await rowState(fxExt.rowId)).status).toBe("REVIEW_REQUIRED");
    });

    it("a lost lease cannot move a row, and produces no journal event", async () => {
      const shop = uniqueShop();
      const fx = await makeInDoubt(shop, 10 * 60_000);
      const before = await rowState(fx.rowId);
      const eventsBefore = await rowEvents(fx.rowId);
      const w = await writeReconcileTransition(
        fx.rowId,
        "forged-lease-token",
        { to: "REVIEW_REQUIRED", reasonCode: "ANOMALY" },
        db,
      );
      expect(w.written).toBe(false);
      if (!w.written) expect(w.reason).toBe("OWNERSHIP_LOST");
      expect(await rowState(fx.rowId)).toEqual(before);
      expect(await rowEvents(fx.rowId)).toEqual(eventsBefore);
    });

    it("reconciliation works with the admission and dispatch switches OFF", async () => {
      const shop = uniqueShop();
      const fx = await makeDispatching(shop, 10 * 60_000);
      // Turn both switches off globally — the cycle is independent of
      // admission and dispatch gates by design (12.1.1).
      await db.$executeRaw`
        UPDATE "ShippingExecuteControl" SET
          "admissionEnabled" = false, "admissionEnabledAt" = NULL,
          "dispatchEnabled" = false, "dispatchEnabledAt" = NULL
        WHERE "id" = 'control'`;
      try {
        const admin = reconAdmin({});
        const reports = await runCycle([shop], admin);
        expect(reports[0].sweptToInDoubt).toBe(1);
        expect((await rowState(fx.rowId)).status).toBe("IN_DOUBT");
      } finally {
        await db.$executeRaw`
          UPDATE "ShippingExecuteControl" SET
            "admissionEnabled" = true, "admissionEnabledAt" = ${naive(EPOCH)},
            "dispatchEnabled" = true, "dispatchEnabledAt" = ${naive(EPOCH)}
          WHERE "id" = 'control'`;
      }
    });

    it("a non-intact catalog stops the cycle before any read or write", async () => {
      const shop = uniqueShop();
      const fx = await makeInDoubt(shop, 10 * 60_000);
      const before = await rowState(fx.rowId);
      const eventsBefore = await rowEvents(fx.rowId);
      const logs: string[] = [];
      const admin = reconAdmin({});
      const reports = await runCycle([shop], admin, {
        catalogReader: async () => [], // empty catalog — CATALOG_ERROR
        log: (l) => logs.push(l),
      });
      expect(reports[0].stoppedBy).toBe("triggers-not-intact");
      expect(admin.calls).toHaveLength(0);
      expect(await rowState(fx.rowId)).toEqual(before);
      expect(await rowEvents(fx.rowId)).toEqual(eventsBefore);
      expect(logs.some((l) => l.includes("triggers-not-intact"))).toBe(true);
    });

    it("the transition writer re-checks the catalog inside its own transaction", async () => {
      // The catalog mutation runs on an authorized scratch database —
      // the shared suite database's trigger catalog is never touched.
      await withMarkedScratchDatabase(
        preflighted,
        async (scratchUrl, _name, brandB) => {
          const dbB = new PrismaClient({
            datasources: { db: { url: scratchUrl } },
          });
          try {
            const shop = uniqueShop();
            const fx = await makeInDoubt(shop, 10 * 60_000, {}, dbB, brandB);
            const lease = await leaseReconcileShippingRefund(fx.rowId, {}, dbB);
            expect(lease.leased).toBe(true);
            if (!lease.leased) return;
            // Mutate the catalog between lease and write on the real
            // scratch database — the writer's in-transaction check must
            // still refuse.
            await dbB.$executeRawUnsafe(
              `DROP TRIGGER shippingrefund_frozen_columns_guard ON "ShippingRefund"`,
            );
            try {
              const w = await writeReconcileTransition(
                fx.rowId,
                lease.leaseToken,
                { to: "REVIEW_REQUIRED", reasonCode: "ANOMALY" },
                dbB,
              );
              expect(w.written).toBe(false);
              if (!w.written) expect(w.reason).toBe("TRIGGERS_NOT_INTACT");
            } finally {
              await dbB.$executeRawUnsafe(
                `CREATE TRIGGER shippingrefund_frozen_columns_guard
                 BEFORE UPDATE ON "ShippingRefund"
                 FOR EACH ROW EXECUTE FUNCTION shipping_refund_fn_frozen_columns_guard()`,
              );
            }
            const row = await rowState(fx.rowId, dbB);
            expect(row.status).toBe("IN_DOUBT");
            const integrity = await checkTriggerIntegrity(() =>
              dbB.$queryRawUnsafe<ShippingRefundTriggerCatalogRow[]>(
                TRIGGER_CATALOG_SQL,
              ),
            );
            expect(integrity.intact).toBe(true);
            // The shared suite catalog was never weakened.
            const suiteIntegrity = await checkTriggerIntegrity(() =>
              db.$queryRawUnsafe<ShippingRefundTriggerCatalogRow[]>(
                TRIGGER_CATALOG_SQL,
              ),
            );
            expect(suiteIntegrity.intact).toBe(true);
          } finally {
            await dbB.$disconnect();
          }
        },
      );
    });

    it("repeated reconciliation is idempotent — no double-adopt, no extra events", async () => {
      const shop = uniqueShop();
      const rid = refundGid(5601);
      const dispatchedAt = await agoIso(10 * 60_000);
      const fx = await makeInDoubt(shop, 10 * 60_000);
      const marker = (await rowState(fx.rowId)).marker as string;
      const admin = reconAdmin(
        fullEvidence({ rid, srcId: fx.secondaryId, marker, dispatchedAt }),
      );
      await runCycle([shop], admin, { attributionStatus: "CONFIRMED" });
      await runCycle([shop], admin, { attributionStatus: "CONFIRMED" });
      const row = await rowState(fx.rowId);
      expect(row.status).toBe("VERIFIED");
      // Third cycle: VERIFIED is not due-listed; nothing more happens.
      const reports = await runCycle([shop], admin, {
        attributionStatus: "CONFIRMED",
      });
      expect(reports[0].outcomes["VERIFIED"] ?? 0).toBe(0);
      expect(await eventStatuses(fx.rowId)).toEqual([
        "∅→QUEUED",
        "QUEUED→PREPARED",
        "PREPARED→DISPATCHING",
        "DISPATCHING→IN_DOUBT",
        "IN_DOUBT→REFUND_RECORDED",
        "REFUND_RECORDED→VERIFIED",
      ]);
    });

    it("a REVIEW_REQUIRED row is resolvable by the operator without a lease", async () => {
      const shop = uniqueShop();
      const fx = await makeInDoubt(shop, 25 * 3600e3);
      await runCycle([shop], reconAdmin({}), {});
      expect((await rowState(fx.rowId)).status).toBe("REVIEW_REQUIRED");
      const r = await resolveShippingRefundReview(
        fx.rowId,
        "operator-test",
        "NO_REFUND_ISSUED",
        { note: "verified manually on the dev store" },
        db,
      );
      expect(r.written).toBe(true);
      const row = await rowState(fx.rowId);
      expect(row.status).toBe("RESOLVED");
      expect(row.resolvedBy).toBe("operator-test");
      expect(await eventStatuses(fx.rowId)).toContain(
        "REVIEW_REQUIRED→RESOLVED",
      );
    });

    it("the graph still refuses PREPARED -> DISPATCHING outside the fixture", async () => {
      const shop = uniqueShop();
      // A PREPARED row: the real claim + real freeze, no synthetic step.
      const seed = await seedGateAndOp(shop);
      const args = fixtureArgsFor(seed);
      const claim = await claimShippingRefund(
        { operation: args.operation, secondary: args.secondary },
        db,
        () => {},
      );
      expect(claim.claimed).toBe(true);
      if (!claim.claimed) return;
      const [claimed] = await db.$queryRaw<
        { marker: string; idempotencyKey: string }[]
      >`SELECT "marker", "idempotencyKey" FROM "ShippingRefund" WHERE "id" = ${claim.rowId}`;
      const freezeInput = await (args.freeze as any)({
        rowId: claim.rowId,
        leaseToken: claim.leaseToken,
        marker: claimed.marker,
        idempotencyKey: claimed.idempotencyKey,
        sourceOrderId: seed.secondary.id,
      });
      const frozen = await freezeShippingRefund(
        claim.rowId,
        claim.leaseToken!,
        freezeInput,
        db,
      );
      expect(frozen.frozen).toBe(true);
      await expect(
        db.$executeRaw`
          UPDATE "ShippingRefund" SET "status" = 'DISPATCHING', "updatedAt" = now()
          WHERE "id" = ${claim.rowId}`,
      ).rejects.toThrow();
      expect((await rowState(claim.rowId)).status).toBe("PREPARED");
    });

    it("the orphan audit flags marker refunds with no consistent row — read-only", async () => {
      const shop = uniqueShop();
      const fx = await makeInDoubt(shop, 10 * 60_000);
      const marker = (await rowState(fx.rowId)).marker as string;
      const rid = refundGid(5701);
      const ev = fullEvidence({
        rid,
        srcId: fx.secondaryId,
        marker,
        dispatchedAt: await agoIso(10 * 60_000),
      });
      const admin = reconAdmin(ev);
      const before = await rowState(fx.rowId);
      const report = await auditShippingRefundOrphans(
        { shop, since: await ago(24 * 3600e3) },
        { adminFactory: async () => admin, sessionLoader: usableSession, log: () => {} },
        db,
      );
      // The IN_DOUBT local row is NOT consistent → HIGH finding.
      const markerFindings = report.findings.filter(
        (f) => f.code === "ORPHAN_MARKER_REFUND",
      );
      expect(markerFindings.length).toBeGreaterThanOrEqual(1);
      expect(markerFindings[0].severity).toBe("HIGH");
      // Read-only: nothing was mutated.
      expect(await rowState(fx.rowId)).toEqual(before);
      for (const c of admin.calls) expect(c.query).toMatch(/^query /);
    });

    it("a THROTTLED top-level response is transient — the row waits, never reviews", async () => {
      const shop = uniqueShop();
      const fx = await makeInDoubt(shop, 10 * 60_000);
      const admin = {
        calls: [] as { query: string }[],
        graphql: async (query: string) => {
          admin.calls.push({ query });
          return {
            json: async () => ({
              errors: [
                { message: "Throttled", extensions: { code: "THROTTLED" } },
              ],
            }),
          } as any;
        },
      } as unknown as AdminClient & { calls: { query: string }[] };
      const reports = await runCycle([shop], admin);
      // Transient read failure → bounded retry, NOT READBACK_INCOMPLETE.
      expect(reports[0].outcomes["WAIT:reads"]).toBe(1);
      expect(reports[0].outcomes["REVIEW:READBACK_INCOMPLETE"] ?? 0).toBe(0);
      const row = await rowState(fx.rowId);
      expect(row.status).toBe("IN_DOUBT");
      expect(row.nextCheckAt).not.toBeNull();
    });

    it("without a usable offline session the cycle makes no Shopify call and writes nothing", async () => {
      const shop = uniqueShop();
      const fx = await makeInDoubt(shop, 10 * 60_000);
      const admin = reconAdmin({});
      // No sessionLoader — the default real lookup finds no Session row
      // in the disposable database → session-unusable, nothing read.
      const reports = await runShippingRefundReconcileCycle(
        [shop],
        { adminFactory: async () => admin, log: () => {} },
        db,
      );
      expect(reports[0].stoppedBy).toBe("session-unusable");
      expect(admin.calls).toHaveLength(0);
      expect((await rowState(fx.rowId)).status).toBe("IN_DOUBT");
    });

    it("orphan audit: an app-attributed refund whose detail read failed is unverified — never reported zero", async () => {
      const shop = uniqueShop();
      const seed = await seedGateAndOp(shop);
      const rid = refundGid(5801);
      const marker = `MS-SHIPREFUND-${randomUUID()}`;
      const note = buildRefundNote(marker, seed.secondaryId);
      // The refund is app-attributed (agreement links it to our app id),
      // but the DETAIL read fails — its financial state is UNKNOWN.
      const admin = {
        calls: [] as { query: string }[],
        graphql: async (query: string, options?: { variables?: any }) => {
          admin.calls.push({ query });
          let payload: unknown;
          if (query.includes("ShippingRefundAppIdentity")) {
            payload = { currentAppInstallation: { app: { id: APP_GID } } };
          } else if (query.includes("ShippingRefundDetail")) {
            throw new Error("detail transport failure");
          } else if (query.includes("ShippingRefundAgreements")) {
            payload = {
              order: {
                agreements: {
                  nodes: [agreementNode(31, { refund: { id: rid } })],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            };
          } else {
            payload = {
              order: {
                id: options?.variables?.source,
                cancelledAt: "2026-10-15T09:30:00Z",
                closed: true,
                displayFinancialStatus: "PAID",
                currencyCode: "USD",
                totalRefundedSet: PM("8.00"),
                totalRefundedShippingSet: PM("8.00"),
                refunds: [
                  {
                    id: rid,
                    note,
                    createdAt: new Date().toISOString(),
                    processedAt: new Date().toISOString(),
                    totalRefundedSet: PM("8.00"),
                  },
                ],
                transactions: [],
              },
            };
          }
          return { json: async () => ({ data: payload }) } as any;
        },
      } as unknown as AdminClient & { calls: { query: string }[] };
      const report = await auditShippingRefundOrphans(
        { shop, since: await ago(24 * 3600e3) },
        { adminFactory: async () => admin, sessionLoader: usableSession, log: () => {} },
        db,
      );
      // The read failure is recorded — never silent.
      expect(
        report.errors.some((e) => e.includes("detail transport failure")),
      ).toBe(true);
      // An unknown financial state must never be labelled zero-movement.
      expect(report.findings.some((f) => f.code === "ORPHAN_APP_ZERO")).toBe(
        false,
      );
      const unverified = report.findings.filter(
        (f) => f.code === "ORPHAN_APP_UNVERIFIED",
      );
      expect(unverified.length).toBeGreaterThanOrEqual(1);
      expect(unverified[0].severity).toBe("HIGH");
    });

    it("orphan audit: unavailable app-id and agreement reads are recorded, not silently skipped", async () => {
      const shop = uniqueShop();
      const seed = await seedGateAndOp(shop);
      const rid = refundGid(5802);
      const admin = {
        graphql: async (query: string) => {
          let payload: unknown;
          if (query.includes("ShippingRefundAppIdentity")) {
            throw new Error("appId read down");
          } else if (query.includes("ShippingRefundAgreements")) {
            throw new Error("agreements read down");
          } else if (query.includes("ShippingRefundDetail")) {
            payload = {
              nodes: [
                detailNode(rid, seed.secondaryId, { note: "x", total: "8.00" }),
              ],
            };
          } else {
            payload = {
              order: {
                id: seed.secondaryId,
                cancelledAt: "2026-10-15T09:30:00Z",
                closed: true,
                displayFinancialStatus: "PAID",
                currencyCode: "USD",
                refunds: [
                  {
                    id: rid,
                    note: "refund",
                    createdAt: null,
                    processedAt: null,
                    totalRefundedSet: PM("8.00"),
                  },
                ],
                transactions: [],
                totalRefundedSet: PM("8.00"),
                totalRefundedShippingSet: PM("8.00"),
              },
            };
          }
          return { json: async () => ({ data: payload }) } as any;
        },
      } as unknown as AdminClient;
      const report = await auditShippingRefundOrphans(
        { shop, since: await ago(24 * 3600e3) },
        { adminFactory: async () => admin, sessionLoader: usableSession, log: () => {} },
        db,
      );
      expect(report.errors.some((e) => e.includes("appId read down"))).toBe(
        true,
      );
      expect(
        report.errors.some((e) => e.includes("agreements read down")),
      ).toBe(true);
      // App-attribution findings are impossible without the reads — and
      // none may be invented.
      expect(
        report.findings.some(
          (f) =>
            f.code === "ORPHAN_APP_REFUND" ||
            f.code === "ORPHAN_APP_ZERO" ||
            f.code === "ORPHAN_APP_UNVERIFIED",
        ),
      ).toBe(false);
    });

    it("orphan audit: malformed secondaries JSON is reported and does not abort the shop's audit", async () => {
      const shop = uniqueShop();
      // One good op (scanned normally) plus one op whose `secondaries` is
      // a JSON object, not an array — jsonb_array_elements would throw.
      await seedGateAndOp(shop);
      const wall = await dbWall();
      await db.$executeRaw`
        INSERT INTO "MergeOperation"
          ("id", "shop", "status", "primaryOrderId", "primaryOrderName",
           "primaryLineItemCountBefore", "addedLineItemCount", "secondaries",
           "involvedOrderIds", "createdAt", "updatedAt", "protocolVersion",
           "phase", "opToken", "calculatedOrderId", "expectedTransfer",
           "appliedEvidence", "sideEffectsDone")
        VALUES (
          ${nextOpId()}, ${shop}, 'COMPLETED', ${nextOrder()}, '#primary',
          1, 0, ${'{"not":"an-array"}'}::jsonb,
          ${[] as string[]}::text[],
          ${naive(wall.toISOString())}, ${naive(wall.toISOString())},
          2, 'COMPLETED', ${`TK${randomUUID().slice(0, 6).toUpperCase()}`}, 'gid://shopify/CalculatedOrder/1',
          '[]'::jsonb, '{}'::jsonb, true
        )`;
      const admin = reconAdmin({});
      const report = await auditShippingRefundOrphans(
        { shop, since: await ago(24 * 3600e3) },
        { adminFactory: async () => admin, sessionLoader: usableSession, log: () => {} },
        db,
      );
      // The malformed op is reported, not fatal — the good op was scanned.
      expect(
        report.errors.some((e) => e.includes("is not a JSON array")),
      ).toBe(true);
      expect(report.secondariesScanned).toBeGreaterThanOrEqual(1);
      expect(
        admin.calls.some((c) =>
          c.query.includes("ShippingRefundReconcile"),
        ),
      ).toBe(true);
    });

    it("orphan audit: the since filter is correct on a non-UTC session timezone", async () => {
      const shop = uniqueShop();
      const [dbRow] = await db.$queryRaw<{ d: string }[]>(
        Prisma.sql`SELECT current_database() AS "d"`,
      );
      // An op created 3 h ago must be found with since = 4 h even when the
      // session timezone is Asia/Tokyo — the naive-UTC column binds through
      // an explicit AT TIME ZONE 'UTC' cast.
      await db.$executeRawUnsafe(
        `ALTER DATABASE "${dbRow.d}" SET timezone = 'Asia/Tokyo'`,
      );
      const tokyoDb = new PrismaClient({
        datasources: { db: { url: TEST_URL } },
      });
      try {
        const [{ tz }] = await tokyoDb.$queryRaw<{ tz: string }[]>`
          SELECT current_setting('TimeZone') AS "tz"`;
        expect(tz).toBe("Asia/Tokyo");
        const seed = await seedGateAndOp(shop, tokyoDb);
        void seed;
        const admin = reconAdmin({});
        const report = await auditShippingRefundOrphans(
          { shop, since: await ago(4 * 3600e3, tokyoDb) },
          {
            adminFactory: async () => admin,
            sessionLoader: usableSession,
            log: () => {},
          },
          tokyoDb,
        );
        // The 3-hour-old op is inside the since window under any session tz.
        expect(report.secondariesScanned).toBeGreaterThanOrEqual(1);
      } finally {
        await tokyoDb.$disconnect();
        await db.$executeRawUnsafe(
          `ALTER DATABASE "${dbRow.d}" RESET timezone`,
        );
      }
    });

    it("orphan audit: the secondary scan bound reports the records it cannot examine", async () => {
      const shop = uniqueShop();
      const seed = await seedGateAndOp(shop);
      void seed;
      const wall = await dbWall();
      // 26 qualifying ops — one past the 25-secondary bound.
      for (let i = 0; i < 26; i += 1) {
        const secondaryId = nextOrder();
        const secondaries = [
          {
            id: secondaryId,
            name: `#${secondaryId.split("/").pop()}`,
            items: 0,
            done: true,
            cancelPhase: "CANCEL_VERIFIED",
            cancelledAt: new Date(wall.getTime() - 3600e3).toISOString(),
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
            ${nextOpId()}, ${shop}, 'COMPLETED', ${nextOrder()}, '#primary',
            1, 0, ${JSON.stringify(secondaries)}::jsonb,
            ${[secondaryId]}::text[],
            ${naive(wall.toISOString())}, ${naive(wall.toISOString())},
            2, 'COMPLETED', ${`TK${i}${randomUUID().slice(0, 5).toUpperCase()}`}, 'gid://shopify/CalculatedOrder/1',
            '[]'::jsonb, '{}'::jsonb, true
          )`;
      }
      const admin = reconAdmin({});
      const report = await auditShippingRefundOrphans(
        { shop, since: await ago(24 * 3600e3) },
        { adminFactory: async () => admin, sessionLoader: usableSession, log: () => {} },
        db,
      );
      expect(report.secondariesScanned).toBe(25);
      expect(
        report.errors.some((e) => e.includes("unexamined")),
      ).toBe(true);
    });
  },
);
