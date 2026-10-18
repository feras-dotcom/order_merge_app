// Real-Postgres tests for the Shipping v0 Phase 2 S1-A database foundation
// (docs/SHIPPING-PHASE2-DESIGN.md Revision 3.3, sections 5.4, 19.3 item 4 and
// the schema cases of 20.1).
//
// Opt-in (the same disposable-database gate as the other real suites):
//
//   MERGESHIP_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:PORT/mergeship_test \
//   MERGESHIP_SHADOW_TOKEN=<operator token> \
//     npx vitest run tests/shipping-refund-schema-pg.test.ts
//
// `preflightDisposableDatabase` runs BEFORE any write and refuses unless the
// target already carries the mergeship-shadow-disposable:<token> marker.
//
// IMPORTANT — destructive-scope note: this suite exercises the journal's
// DELETE/TRUNCATE refusals and (on scratch databases only) catalog-alteration
// checks. The journal tables are never emptied: the append-only triggers make
// TRUNCATE/DELETE fail by design, so tests isolate by unique shop/id values
// and leave their rows in place. It must run only under the same separately
// authorized disposable-database checkpoint as the other real suites; in S1-A
// it was written but deliberately NOT executed.

import { execSync } from "child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  SHIPPING_REFUND_TRIGGER_MANIFEST,
  TRIGGER_CATALOG_SQL,
  checkTriggerIntegrity,
  compareTriggerCatalog,
  type ShippingRefundTriggerCatalogRow,
} from "../app/lib/shipping-refund-trigger-manifest";
import {
  preflightDisposableDatabase,
  withScratchDatabase,
  type PreflightedDatabase,
} from "./helpers/disposable-db";

const TEST_URL = process.env.MERGESHIP_TEST_DATABASE_URL;
const oid = (n: number) => `gid://shopify/Order/${n}`;
const txnGid = (n: number) => `gid://shopify/OrderTransaction/${n}`;
const refundGid = (n: number) => `gid://shopify/Refund/${n}`;
const HASH64 = "a".repeat(64);
const HASH64_B = "b".repeat(64);

describe.skipIf(!TEST_URL)("shipping-refund schema & triggers (real disposable database)", () => {
  let db: PrismaClient;
  let preflighted: PreflightedDatabase;

  beforeAll(async () => {
    // FIRST — before migrations or any write.
    preflighted = await preflightDisposableDatabase(TEST_URL!);
    execSync("npx prisma migrate deploy", {
      env: { ...process.env, DATABASE_URL: TEST_URL! },
      stdio: "pipe",
    });
    db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
  });

  // A fresh identity per row: the journal is append-only, so tests never
  // clean up — they isolate by unique shop/idempotency-key/marker values.
  const uniqueShop = () => `s1a-${randomUUID()}.myshopify.com`;

  interface RowParams {
    lane?: "OBSERVE" | "EXECUTE";
    status?: string;
    reasonCode?: string | null;
    sourceCancelledAt?: string | null;
  }

  /** Insert a constraint-valid row. Defaults: lane OBSERVE, status QUEUED. */
  async function insertRefund(p: RowParams = {}): Promise<{ id: string; shop: string }> {
    const shop = uniqueShop();
    const id = `sr_${randomUUID().replace(/-/g, "")}`;
    const lane = p.lane ?? "OBSERVE";
    const status = p.status ?? "QUEUED";
    const cancelled: string | null =
      p.sourceCancelledAt === undefined ? "2030-01-06T00:00:00Z" : p.sourceCancelledAt;
    const reasonCode = p.reasonCode ?? null;
    const key = randomUUID();
    const dispatchEpoch: string | null = lane === "EXECUTE" ? "2030-01-02T00:00:00Z" : null;
    await db.$executeRaw`
      INSERT INTO "ShippingRefund" (
        "id", "shop", "mergeOperationId", "sourceOrderId", "primaryOrderId",
        "primaryOrderName", "operationCreatedAt", "sourceCancelledAt",
        "lane", "status", "reasonCode",
        "merchantEpochAt", "rolloutEpochAt", "switchEpochAt",
        "activationCutoffAt", "admissionEpochAt", "admissionCutoffAt",
        "dispatchEpochAtAdmission",
        "approvalApprovedAt", "approvalOptInEpoch", "approvalAckVersion",
        "policyKind", "idempotencyKey", "marker"
      ) VALUES (
        ${id}, ${shop}, ${"mo_" + randomUUID().replace(/-/g, "")},
        ${oid(5000 + Math.floor(Math.random() * 1e9))}, ${oid(9000 + Math.floor(Math.random() * 1e9))},
        '#P1001',
        ${"2030-01-06T00:00:00Z"}::timestamptz AT TIME ZONE 'UTC',
        ${cancelled}::timestamptz AT TIME ZONE 'UTC',
        ${lane}, ${status}, ${reasonCode},
        ${"2030-01-01T00:00:00Z"}::timestamptz AT TIME ZONE 'UTC',
        ${"2030-01-02T00:00:00Z"}::timestamptz AT TIME ZONE 'UTC',
        ${"2030-01-03T00:00:00Z"}::timestamptz AT TIME ZONE 'UTC',
        ${"2030-01-03T00:00:00Z"}::timestamptz AT TIME ZONE 'UTC',
        ${"2030-01-04T00:00:00Z"}::timestamptz AT TIME ZONE 'UTC',
        ${"2030-01-05T00:00:00Z"}::timestamptz AT TIME ZONE 'UTC',
        ${dispatchEpoch}::timestamptz AT TIME ZONE 'UTC',
        ${"2030-01-05T00:00:00Z"}::timestamptz AT TIME ZONE 'UTC',
        ${"2030-01-01T00:00:00Z"}::timestamptz AT TIME ZONE 'UTC',
        'v1', 'REFUND_ALL', ${key}, ${"MS-SHIPREFUND-" + key}
      )
    `;
    return { id, shop };
  }

  const getStatus = async (id: string) =>
    (await db.$queryRaw<{ status: string }[]>`SELECT "status" FROM "ShippingRefund" WHERE "id" = ${id}`)[0].status;

  const eventCount = async (id: string) =>
    Number(
      (await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "ShippingRefundEvent" WHERE "shippingRefundId" = ${id}`)[0].n,
    );

  /** Build a constraint-valid wireVariables for an EXECUTE row. */
  function wireFor(sourceOrderId: string, key: string, marker: string, parentTxn: string): object {
    return {
      idempotencyKey: key,
      input: {
        orderId: sourceOrderId,
        note: `Shipping refund ${marker}`,
        notify: false,
        currency: "USD",
        shipping: { fullRefund: false, amount: "10.00" },
        transactions: [
          { orderId: sourceOrderId, parentId: parentTxn, gateway: "bogus", kind: "REFUND", amount: "10.00" },
        ],
      },
    };
  }

  /** Row with the frozen financial facts set (still QUEUED, lane EXECUTE). */
  async function insertFrozen(): Promise<{
    id: string; sourceOrderId: string; key: string; marker: string; parentTxn: string;
  }> {
    const { id } = await insertRefund({ lane: "EXECUTE" });
    const rows = await db.$queryRaw<
      { sourceOrderId: string; idempotencyKey: string; marker: string }[]
    >`SELECT "sourceOrderId", "idempotencyKey", "marker" FROM "ShippingRefund" WHERE "id" = ${id}`;
    const { sourceOrderId, idempotencyKey: key, marker } = rows[0];
    const parentTxn = txnGid(777);
    await db.$executeRaw`
      UPDATE "ShippingRefund" SET
        "currencyCode" = 'USD',
        "plannedShippingMinor" = '1000',
        "parentTransactionId" = ${parentTxn},
        "gateway" = 'bogus'
      WHERE "id" = ${id}
    `;
    return { id, sourceOrderId, key, marker, parentTxn };
  }

  /** Freeze an EXECUTE row to PREPARED through a legal QUEUED -> PREPARED. */
  async function insertPrepared(): Promise<{ id: string; sourceOrderId: string; key: string }> {
    const { id, sourceOrderId, key, marker, parentTxn } = await insertFrozen();
    await db.$executeRaw`
      UPDATE "ShippingRefund" SET
        "status" = 'PREPARED',
        "documentSha256" = ${HASH64},
        "wireVariables" = ${JSON.stringify(wireFor(sourceOrderId, key, marker, parentTxn))}::jsonb,
        "wireHash" = ${HASH64},
        "mutationVersion" = 'refundCreate@2026-04',
        "preparedAt" = clock_timestamp() AT TIME ZONE 'UTC'
      WHERE "id" = ${id}
    `;
    return { id, sourceOrderId, key };
  }

  // ── Catalog & integrity (5.4.7, 19.3) ──

  it("the live catalog exactly matches the canonical manifest", async () => {
    const rows = await db.$queryRawUnsafe<ShippingRefundTriggerCatalogRow[]>(TRIGGER_CATALOG_SQL);
    expect(rows).toHaveLength(SHIPPING_REFUND_TRIGGER_MANIFEST.length);
    const role = rows[0].sessionReplicationRole!;
    expect(role).toBe("origin");
    const v = compareTriggerCatalog(SHIPPING_REFUND_TRIGGER_MANIFEST, rows, role);
    expect(v.reasons).toEqual([]);
    expect(v.intact).toBe(true);
  });

  it("checkTriggerIntegrity is green through a real injected catalog query", async () => {
    const v = await checkTriggerIntegrity(() =>
      db.$queryRawUnsafe<ShippingRefundTriggerCatalogRow[]>(TRIGGER_CATALOG_SQL),
    );
    expect(v).toEqual({ intact: true, reasons: [] });
  });

  // ── Insert integrity (5.4.1, I28) ──

  it("admits only the four claim statuses on insert", async () => {
    for (const status of ["PREPARED", "OBSERVED", "DISPATCHING", "IN_DOUBT", "REFUND_RECORDED", "VERIFIED", "ABORTED", "RESOLVED"]) {
      // The insert guard owns this refusal, not a CHECK.
      await expect(insertRefund({ status }), status).rejects.toThrow(/illegal initial status/i);
    }
    for (const status of ["QUEUED", "SKIPPED", "INELIGIBLE", "REVIEW_REQUIRED"]) {
      const { id } = await insertRefund({ status });
      expect(await getStatus(id)).toBe(status);
    }
  });

  it("rejects an insert carrying any dispatch/response/approval/wire evidence", async () => {
    const { id } = await insertRefund();
    // Evidence columns can't even arrive at insert — re-verify via a direct
    // raw insert path on a fresh row carrying dispatchToken.
    const shop = uniqueShop();
    const key = randomUUID();
    await expect(
      db.$executeRaw`
        INSERT INTO "ShippingRefund" (
          "id", "shop", "mergeOperationId", "sourceOrderId", "primaryOrderId",
          "primaryOrderName", "operationCreatedAt", "sourceCancelledAt",
          "lane", "status",
          "merchantEpochAt", "rolloutEpochAt", "switchEpochAt",
          "activationCutoffAt", "admissionEpochAt", "admissionCutoffAt",
          "dispatchEpochAtAdmission",
          "approvalApprovedAt", "approvalOptInEpoch", "approvalAckVersion",
          "policyKind", "idempotencyKey", "marker", "dispatchToken"
        ) VALUES (
          ${"sr_bad_" + randomUUID().replace(/-/g, "")}, ${shop},
          ${"mo_" + randomUUID().replace(/-/g, "")}, ${oid(1)}, ${oid(2)},
          '#P', '2030-01-06'::timestamptz AT TIME ZONE 'UTC',
          '2030-01-06'::timestamptz AT TIME ZONE 'UTC',
          'OBSERVE', 'QUEUED',
          '2030-01-01'::timestamptz AT TIME ZONE 'UTC',
          '2030-01-02'::timestamptz AT TIME ZONE 'UTC',
          '2030-01-03'::timestamptz AT TIME ZONE 'UTC',
          '2030-01-03'::timestamptz AT TIME ZONE 'UTC',
          '2030-01-04'::timestamptz AT TIME ZONE 'UTC',
          '2030-01-05'::timestamptz AT TIME ZONE 'UTC',
          NULL,
          '2030-01-05'::timestamptz AT TIME ZONE 'UTC',
          '2030-01-01'::timestamptz AT TIME ZONE 'UTC',
          'v1', 'REFUND_ALL', ${key}, ${"MS-SHIPREFUND-" + key}, 'tok'
        )
      `,
    ).rejects.toThrow(/insert carries.*evidence/i);
    expect(id).toBeTruthy();
  });

  it("rejects an insert carrying any of the 28 evidence columns (representative set)", async () => {
    // A single non-NULL evidence column in an otherwise claim-valid insert.
    // The guard groups them into six families; one representative per family
    // plus the frozen-wire group proves the guard sees the whole surface.
    const evidences: [string, string][] = [
      ["dispatchToken", `'${randomUUID()}'`],
      ["dispatchedAt", `'2030-01-07'::timestamptz AT TIME ZONE 'UTC'`],
      ["respondedAt", `'2030-01-07'::timestamptz AT TIME ZONE 'UTC'`],
      ["refundId", `'${refundGid(77)}'`],
      ["refundCreatedAt", `'2030-01-07'::timestamptz AT TIME ZONE 'UTC'`],
      ["settlementState", `'SUCCESS'`],
      ["settlementCheckAt", `'2030-01-07'::timestamptz AT TIME ZONE 'UTC'`],
      ["verifiedAt", `'2030-01-07'::timestamptz AT TIME ZONE 'UTC'`],
      ["approvedWireHash", `'${HASH64}'`],
      ["approvedBy", `'op'`],
      ["approvedAt", `'2030-01-07'::timestamptz AT TIME ZONE 'UTC'`],
      ["preparedAt", `'2030-01-07'::timestamptz AT TIME ZONE 'UTC'`],
      ["wireVariables", `'{"idempotencyKey":"k","input":{}}'::jsonb`],
      ["wireHash", `'${HASH64}'`],
      ["documentSha256", `'${HASH64}'`],
      ["mutationVersion", `'refundCreate@2026-04'`],
      ["resolvedBy", `'op'`],
      ["resolution", `'x'`],
      ["resolvedAt", `'2030-01-07'::timestamptz AT TIME ZONE 'UTC'`],
    ];
    for (const [col, val] of evidences) {
      const key = randomUUID();
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO "ShippingRefund" (
            "id", "shop", "mergeOperationId", "sourceOrderId", "primaryOrderId",
            "primaryOrderName", "operationCreatedAt", "sourceCancelledAt",
            "lane", "status",
            "merchantEpochAt", "rolloutEpochAt", "switchEpochAt",
            "activationCutoffAt", "admissionEpochAt", "admissionCutoffAt",
            "dispatchEpochAtAdmission",
            "approvalApprovedAt", "approvalOptInEpoch", "approvalAckVersion",
            "policyKind", "idempotencyKey", "marker", "${col}"
          ) VALUES (
            '${"sr_evi_" + randomUUID().replace(/-/g, "")}', '${uniqueShop()}',
            '${"mo_" + randomUUID().replace(/-/g, "")}', '${oid(3)}', '${oid(4)}',
            '#P', '2030-01-06'::timestamptz AT TIME ZONE 'UTC',
            '2030-01-06'::timestamptz AT TIME ZONE 'UTC',
            'OBSERVE', 'QUEUED',
            '2030-01-01'::timestamptz AT TIME ZONE 'UTC',
            '2030-01-02'::timestamptz AT TIME ZONE 'UTC',
            '2030-01-03'::timestamptz AT TIME ZONE 'UTC',
            '2030-01-03'::timestamptz AT TIME ZONE 'UTC',
            '2030-01-04'::timestamptz AT TIME ZONE 'UTC',
            '2030-01-05'::timestamptz AT TIME ZONE 'UTC',
            NULL,
            '2030-01-05'::timestamptz AT TIME ZONE 'UTC',
            '2030-01-01'::timestamptz AT TIME ZONE 'UTC',
            'v1', 'REFUND_ALL', '${key}', 'MS-SHIPREFUND-${key}', ${val}
          )`,
        ),
        col,
      ).rejects.toThrow(/insert carries.*evidence/i);
    }
  });

  // ── Transition graph incl. the S1 non-dispatch proof (19.3 item 4, I27) ──

  it("HEADLINE: a raw UPDATE ... SET status='DISPATCHING' from PREPARED raises", async () => {
    const { id } = await insertPrepared();
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "status" = 'DISPATCHING' WHERE "id" = ${id}`,
    ).rejects.toThrow(/illegal transition/i);
    expect(await getStatus(id)).toBe("PREPARED");
  });

  it("QUEUED -> PREPARED requires lane EXECUTE; OBSERVE rows can never prepare", async () => {
    const { id } = await insertRefund({ lane: "OBSERVE" });
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "status" = 'PREPARED' WHERE "id" = ${id}`,
    ).rejects.toThrow(/illegal transition/i);
  });

  it("QUEUED -> OBSERVED succeeds on the OBSERVE lane, then OBSERVED is immutable", async () => {
    const { id } = await insertRefund({ lane: "OBSERVE" });
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status" = 'OBSERVED' WHERE "id" = ${id}`;
    expect(await getStatus(id)).toBe("OBSERVED");
    // OBSERVED is terminal: even an ordinary bookkeeping update raises.
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "attempts" = "attempts" + 1 WHERE "id" = ${id}`,
    ).rejects.toThrow(/terminal/i);
    // ...and the transition was journaled exactly once.
    const ev = await db.$queryRaw<{ fromStatus: string; toStatus: string }[]>`
      SELECT "fromStatus", "toStatus" FROM "ShippingRefundEvent"
      WHERE "shippingRefundId" = ${id} AND "toStatus" = 'OBSERVED'`;
    expect(ev).toEqual([{ fromStatus: "QUEUED", toStatus: "OBSERVED" }]);
  });

  it("PREPARED -> DISPATCHING is refused even with dispatch evidence in the same update", async () => {
    const { id } = await insertPrepared();
    // The exact update the evidence-integrity guard permits: only the
    // transition guard may refuse it (the other guards admit this shape).
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET
        "status" = 'DISPATCHING',
        "dispatchToken" = ${randomUUID()},
        "dispatchedAt" = clock_timestamp() AT TIME ZONE 'UTC'
        WHERE "id" = ${id}`,
    ).rejects.toThrow(/illegal transition/i);
    expect(await getStatus(id)).toBe("PREPARED");
  });

  it("accepts the legal S1 edges and rejects arbitrary pairs", async () => {
    const q = await insertRefund();
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status" = 'SKIPPED' WHERE "id" = ${q.id}`;
    // QUEUED -> VERIFIED is not in the graph
    const q2 = await insertRefund();
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "status" = 'VERIFIED' WHERE "id" = ${q2.id}`,
    ).rejects.toThrow(/illegal transition/i);
    // PREPARED -> ABORTED is legal
    const p = await insertPrepared();
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status" = 'ABORTED' WHERE "id" = ${p.id}`;
    expect(await getStatus(p.id)).toBe("ABORTED");
    // REVIEW_REQUIRED -> RESOLVED needs the resolved fields (CHECK) and is legal
    const rr = await insertRefund({ status: "REVIEW_REQUIRED" });
    await db.$executeRaw`UPDATE "ShippingRefund" SET
      "status" = 'RESOLVED', "resolvedBy" = 'op', "resolution" = 'no-op',
      "resolvedAt" = clock_timestamp() AT TIME ZONE 'UTC' WHERE "id" = ${rr.id}`;
    expect(await getStatus(rr.id)).toBe("RESOLVED");
  });

  it("any update of a terminal row raises", async () => {
    const { id } = await insertRefund({ status: "SKIPPED" });
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "reviewReason" = 'x' WHERE "id" = ${id}`,
    ).rejects.toThrow(/terminal/i);
  });

  it("a non-status update on a live row produces no event", async () => {
    const { id } = await insertRefund();
    const before = await eventCount(id);
    await db.$executeRaw`UPDATE "ShippingRefund" SET "attempts" = "attempts" + 1 WHERE "id" = ${id}`;
    expect(await eventCount(id)).toBe(before);
  });

  // ── Frozen / write-once columns (5.4.2) ──

  it("identity and snapshot columns are immutable", async () => {
    const { id } = await insertRefund();
    for (const col of [
      `"shop" = 'other.example.com'`,
      `"sourceOrderId" = ${"'gid://shopify/Order/42'"}`,
      `"marker" = 'MS-SHIPREFUND-00000000-0000-0000-0000-000000000000'`,
      `"idempotencyKey" = '00000000-0000-0000-0000-000000000000'`,
      `"lane" = 'EXECUTE'`,
      `"activationCutoffAt" = '2030-02-01'::timestamptz AT TIME ZONE 'UTC'`,
    ]) {
      await expect(db.$executeRawUnsafe(`UPDATE "ShippingRefund" SET ${col} WHERE "id" = '${id}'`)).rejects.toThrow();
    }
  });

  it("sourceCancelledAt is NULL-safe immutable, with the CANCELLED_AT_INVALID exception", async () => {
    const { id } = await insertRefund();
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "sourceCancelledAt" = NULL WHERE "id" = ${id}`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "sourceCancelledAt" = '2030-02-02'::timestamptz AT TIME ZONE 'UTC' WHERE "id" = ${id}`,
    ).rejects.toThrow();
    // The terminal exception row may carry NULL and may resolve keeping NULL.
    const rr = await insertRefund({ status: "REVIEW_REQUIRED", reasonCode: "CANCELLED_AT_INVALID", sourceCancelledAt: null });
    await db.$executeRaw`UPDATE "ShippingRefund" SET
      "status" = 'RESOLVED', "resolvedBy" = 'op', "resolution" = 'void',
      "resolvedAt" = clock_timestamp() AT TIME ZONE 'UTC' WHERE "id" = ${rr.id}`;
    // But stamping it afterwards is still impossible (RESOLVED is terminal).
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "sourceCancelledAt" = '2030-02-02'::timestamptz AT TIME ZONE 'UTC' WHERE "id" = ${rr.id}`,
    ).rejects.toThrow(/terminal/i);
  });

  it("A-2: NULL -> value is refused on the REVIEW_REQUIRED(CANCELLED_AT_INVALID) row itself", async () => {
    const { id } = await insertRefund({
      status: "REVIEW_REQUIRED",
      reasonCode: "CANCELLED_AT_INVALID",
      sourceCancelledAt: null,
    });
    // Alone — the frozen-columns guard owns this refusal (the column is in
    // the immutable group: NULL stays NULL forever).
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "sourceCancelledAt" = '2030-02-02'::timestamptz AT TIME ZONE 'UTC' WHERE "id" = ${id}`,
    ).rejects.toThrow(/immutable column/i);
    // Combined with the legal REVIEW_REQUIRED -> RESOLVED edge in one update.
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET
        "status" = 'RESOLVED', "resolvedBy" = 'op', "resolution" = 'void',
        "resolvedAt" = clock_timestamp() AT TIME ZONE 'UTC',
        "sourceCancelledAt" = '2030-02-02'::timestamptz AT TIME ZONE 'UTC'
        WHERE "id" = ${id}`,
    ).rejects.toThrow(/immutable column/i);
    // Neither failed update moved anything.
    expect(await getStatus(id)).toBe("REVIEW_REQUIRED");
    const row = await db.$queryRaw<{ s: Date | null }[]>`
      SELECT "sourceCancelledAt" AS s FROM "ShippingRefund" WHERE "id" = ${id}`;
    expect(row[0].s).toBeNull();
    // And a PREPARED row cannot move it either.
    const p = await insertPrepared();
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "sourceCancelledAt" = '2030-02-02'::timestamptz AT TIME ZONE 'UTC' WHERE "id" = ${p.id}`,
    ).rejects.toThrow(/immutable column/i);
  });

  it("restating an identical sourceCancelledAt succeeds and writes no event", async () => {
    const { id } = await insertRefund(); // sourceCancelledAt = 2030-01-06
    const before = await eventCount(id);
    await db.$executeRaw`UPDATE "ShippingRefund" SET "sourceCancelledAt" = '2030-01-06T00:00:00Z'::timestamptz AT TIME ZONE 'UTC' WHERE "id" = ${id}`;
    // NULL -> NULL on the terminal exception row is likewise a no-op write.
    const rr = await insertRefund({
      status: "REVIEW_REQUIRED",
      reasonCode: "CANCELLED_AT_INVALID",
      sourceCancelledAt: null,
    });
    const before2 = await eventCount(rr.id);
    await db.$executeRaw`UPDATE "ShippingRefund" SET "sourceCancelledAt" = NULL WHERE "id" = ${rr.id}`;
    expect(await eventCount(id)).toBe(before);
    expect(await eventCount(rr.id)).toBe(before2);
  });

  // Regression: the old CHECK evaluated to UNKNOWN when sourceCancelledAt and
  // reasonCode were both NULL on a terminal status, and CHECK treats UNKNOWN
  // as pass. The corrected CHECK uses COALESCE so every combination below
  // must fail closed.
  it("NULL sourceCancelledAt fails closed for NULL, empty and non-exception reasonCode", async () => {
    for (const reasonCode of [null, "", "OTHER_REASON", "SOME_CODE"]) {
      await expect(
        insertRefund({ status: "REVIEW_REQUIRED", reasonCode, sourceCancelledAt: null }),
      ).rejects.toThrow(/sourceCancelledAt|violates check/i);
      // QUEUED never tolerates NULL either.
      await expect(
        insertRefund({ status: "QUEUED", reasonCode, sourceCancelledAt: null }),
      ).rejects.toThrow(/sourceCancelledAt|violates check/i);
    }
    // The one valid exception stays accepted.
    const { id } = await insertRefund({
      status: "REVIEW_REQUIRED",
      reasonCode: "CANCELLED_AT_INVALID",
      sourceCancelledAt: null,
    });
    expect(await getStatus(id)).toBe("REVIEW_REQUIRED");
    // Clearing or changing the reasonCode on that NULL-cancelled row must fail.
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "reasonCode" = NULL WHERE "id" = ${id}`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "reasonCode" = 'OTHER' WHERE "id" = ${id}`,
    ).rejects.toThrow();
  });

  it("write-once wire columns can be set once and never changed", async () => {
    const { id } = await insertRefund();
    await db.$executeRaw`UPDATE "ShippingRefund" SET "plannedShippingMinor" = '1000' WHERE "id" = ${id}`;
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "plannedShippingMinor" = '2000' WHERE "id" = ${id}`,
    ).rejects.toThrow(/write-once/i);
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "plannedShippingMinor" = NULL WHERE "id" = ${id}`,
    ).rejects.toThrow(/write-once/i);
  });

  it("the write-once family binds representative columns, not just one", async () => {
    // NULL -> value once (the frozen facts path), then any second write or
    // NULL-return must fail with the write-once error — per column.
    const cases: [string, string, string][] = [
      ["currencyCode", `'USD'`, `'EUR'`],
      ["plannedShippingMinor", `'1000'`, `'2000'`],
      ["parentTransactionId", `'${txnGid(1)}'`, `'${txnGid(2)}'`],
      ["gateway", `'bogus'`, `'other'`],
    ];
    for (const [col, first, second] of cases) {
      const { id } = await insertRefund();
      await db.$executeRawUnsafe(
        `UPDATE "ShippingRefund" SET "${col}" = ${first} WHERE "id" = '${id}'`,
      );
      // restating the same value stays legal (IS DISTINCT FROM is false)
      await db.$executeRawUnsafe(
        `UPDATE "ShippingRefund" SET "${col}" = ${first} WHERE "id" = '${id}'`,
      );
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "ShippingRefund" SET "${col}" = ${second} WHERE "id" = '${id}'`,
        ),
        `${col} second write`,
      ).rejects.toThrow(/write-once/i);
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "ShippingRefund" SET "${col}" = NULL WHERE "id" = '${id}'`,
        ),
        `${col} NULL return`,
      ).rejects.toThrow(/write-once/i);
    }
  });

  // ── Evidence integrity (5.4.6, I28) ──

  it("dispatch evidence cannot be stamped outside PREPARED -> DISPATCHING", async () => {
    const { id } = await insertRefund();
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "dispatchToken" = 't', "dispatchedAt" = clock_timestamp() AT TIME ZONE 'UTC' WHERE "id" = ${id}`,
    ).rejects.toThrow(/dispatch evidence/i);
  });

  it("response/settlement evidence requires a post-dispatch status", async () => {
    const { id } = await insertRefund();
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "respondedAt" = clock_timestamp() AT TIME ZONE 'UTC' WHERE "id" = ${id}`,
    ).rejects.toThrow(/post-dispatch/i);
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "refundId" = ${refundGid(1)} WHERE "id" = ${id}`,
    ).rejects.toThrow(/post-dispatch/i);
  });

  it("approvedWireHash is only recordable on a PREPARED EXECUTE row equal to wireHash", async () => {
    const q = await insertRefund({ lane: "EXECUTE" });
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "approvedWireHash" = ${HASH64} WHERE "id" = ${q.id}`,
    ).rejects.toThrow(/approvedWireHash/i);
    const p = await insertPrepared();
    await expect(
      db.$executeRaw`UPDATE "ShippingRefund" SET "approvedWireHash" = ${HASH64_B} WHERE "id" = ${p.id}`,
    ).rejects.toThrow(/approvedWireHash/i);
    await db.$executeRaw`UPDATE "ShippingRefund" SET
      "approvedWireHash" = ${HASH64}, "approvedBy" = 'op',
      "approvedAt" = clock_timestamp() AT TIME ZONE 'UTC' WHERE "id" = ${p.id}`;
  });

  // ── Wire shape (5.3, 5.4.3, I3) ──

  async function setWire(id: string, wv: object): Promise<void> {
    await db.$executeRaw`UPDATE "ShippingRefund" SET "wireVariables" = ${JSON.stringify(wv)}::jsonb WHERE "id" = ${id}`;
  }

  it("rejects wire payloads with wrong key sets, extra keys, or forbidden fields", async () => {
    const mutators: Array<(w: any, ctx: { sourceOrderId: string; parentTxn: string }) => object> = [
      (w) => ({ ...w, extra: 1 }),                                   // top-level extra key
      (w) => ({ idempotencyKey: w.idempotencyKey }),                 // missing input
      (w) => ({ ...w, input: { ...w.input, refundLineItems: [] } }), // forbidden key
      (w) => ({ ...w, input: { ...w.input, restock: true } }),
      (w) => ({ ...w, input: { ...w.input, shipping: { amount: "1" } } }), // shipping missing fullRefund
      (w) => ({ ...w, input: { ...w.input, transactions: [] } }),
      (w, ctx) => ({
        ...w,
        input: {
          ...w.input,
          transactions: [
            { orderId: ctx.sourceOrderId, parentId: ctx.parentTxn, gateway: "bogus", kind: "REFUND", amount: "10.00" },
            { orderId: ctx.sourceOrderId, parentId: ctx.parentTxn, gateway: "bogus", kind: "REFUND", amount: "10.00" },
          ],
        },
      }),
      (w, ctx) => ({
        ...w,
        input: {
          ...w.input,
          transactions: [
            { orderId: ctx.sourceOrderId, parentId: ctx.parentTxn, gateway: "bogus", kind: "REFUND", amount: "10.00", restock: true },
          ],
        },
      }),
    ];
    for (const mutate of mutators) {
      const r = await insertFrozen();
      const wv = mutate(wireFor(r.sourceOrderId, r.key, r.marker, r.parentTxn), r);
      await expect(setWire(r.id, wv)).rejects.toThrow();
    }
  });

  it("rejects wire payloads violating the cross-field CHECKs", async () => {
    const mutators: Array<(w: any, ctx: { sourceOrderId: string; parentTxn: string }) => object> = [
      (w) => ({ ...w, idempotencyKey: randomUUID() }),               // key != column
      (w) => ({ ...w, input: { ...w.input, orderId: oid(999999999) } }), // != sourceOrderId
      (w) => ({ ...w, input: { ...w.input, notify: true } }),
      (w) => ({ ...w, input: { ...w.input, shipping: { fullRefund: true, amount: "10.00" } } }),
      (w) => ({ ...w, input: { ...w.input, note: "no marker here" } }),   // marker absent
      (w) => ({ ...w, input: { ...w.input, currency: "JPY" } }),          // != currencyCode
      (w) => ({
        ...w,
        input: { ...w.input, shipping: { fullRefund: false, amount: "0.00" } }, // not positive
      }),
      (w) => ({
        ...w,
        input: { ...w.input, shipping: { fullRefund: false, amount: "10.00001" } }, // >4 frac digits
      }),
      (w) => ({
        ...w,
        input: { ...w.input, shipping: { fullRefund: false, amount: "007.5" } }, // leading zeros
      }),
      (w, ctx) => ({
        ...w,
        input: {
          ...w.input,
          transactions: [
            { orderId: ctx.sourceOrderId, parentId: ctx.parentTxn, gateway: "bogus", kind: "CAPTURE", amount: "10.00" },
          ],
        },
      }),
      (w, ctx) => ({
        ...w,
        input: {
          ...w.input,
          transactions: [
            { orderId: ctx.sourceOrderId, parentId: ctx.parentTxn, gateway: "other", kind: "REFUND", amount: "10.00" },
          ],
        },
      }),
      (w, ctx) => ({
        ...w,
        input: {
          ...w.input,
          transactions: [
            { orderId: ctx.sourceOrderId, parentId: ctx.parentTxn, gateway: "bogus", kind: "REFUND", amount: "9.00" },
          ],
        },
      }),
    ];
    for (const mutate of mutators) {
      const r = await insertFrozen();
      const wv = mutate(wireFor(r.sourceOrderId, r.key, r.marker, r.parentTxn), r);
      await expect(setWire(r.id, wv)).rejects.toThrow();
    }
  });

  it("decimal format and positivity are enforced even when amounts are equal", async () => {
    // Setting BOTH amounts to the same bad value means the amount-equality
    // CHECK cannot mask the format/positivity CHECK — each rejection below
    // must come from ShippingRefund_wire_amount_decimal itself.
    const withAmount = (amount: string) => (w: any) => ({
      ...w,
      input: {
        ...w.input,
        shipping: { ...w.input.shipping, amount },
        transactions: [{ ...w.input.transactions[0], amount }],
      },
    });
    for (const bad of ["0.00", "0", "10.00001", "007.5", "-1.00", "+1.00", "1e3", "10.", ".5", "1,000.00", " 10.00"]) {
      const r = await insertFrozen();
      const wv = withAmount(bad)(wireFor(r.sourceOrderId, r.key, r.marker, r.parentTxn));
      await expect(setWire(r.id, wv), `amount=${bad}`).rejects.toThrow(/wire_amount_decimal/i);
    }
    for (const good of ["0.01", "1", "10.0000", "123456789.1234"]) {
      const r = await insertFrozen();
      const wv = withAmount(good)(wireFor(r.sourceOrderId, r.key, r.marker, r.parentTxn));
      await setWire(r.id, wv);
    }
  });

  it("B2: the transaction kind CHECK rejects NULL, missing, non-string and wrong values", async () => {
    const withTxn = (txn: Record<string, unknown>) => (w: any) => ({
      ...w,
      input: { ...w.input, transactions: [txn] },
    });
    const mkTxn = (r: { sourceOrderId: string; parentTxn: string }, kind: unknown) => ({
      orderId: r.sourceOrderId, parentId: r.parentTxn, gateway: "bogus",
      kind, amount: "10.00",
    });
    // kind: JSON null — the key set is satisfied (txn ? 'kind'), so only the
    // NULL-safe kind CHECK can refuse. This is the B2 regression.
    for (const kind of [null, 5, true, "refund", "CAPTURE", ""]) {
      const r = await insertFrozen();
      const wv = withTxn(mkTxn(r, kind))(wireFor(r.sourceOrderId, r.key, r.marker, r.parentTxn));
      await expect(setWire(r.id, wv), `kind=${JSON.stringify(kind)}`).rejects.toThrow(
        /wire_txn_fields/i,
      );
    }
    // Missing key — the shape trigger owns this refusal.
    const r = await insertFrozen();
    const txn = mkTxn(r, "REFUND") as Record<string, unknown>;
    delete txn.kind;
    const wv = withTxn(txn)(wireFor(r.sourceOrderId, r.key, r.marker, r.parentTxn));
    await expect(setWire(r.id, wv)).rejects.toThrow(/transaction keys/i);
    // The legitimate value still lands.
    const r2 = await insertFrozen();
    await setWire(r2.id, wireFor(r2.sourceOrderId, r2.key, r2.marker, r2.parentTxn));
  });

  it("accepts the exact approved wire shape on a real PREPARED transition", async () => {
    // insertPrepared already exercises QUEUED -> PREPARED with the full valid
    // wire payload; assert the row landed with its frozen facts intact.
    const { id } = await insertPrepared();
    const rows = await db.$queryRaw<
      { status: string; wireHash: string; currencyCode: string; preparedAt: Date }[]
    >`SELECT "status", "wireHash", "currencyCode", "preparedAt" FROM "ShippingRefund" WHERE "id" = ${id}`;
    expect(rows[0].status).toBe("PREPARED");
    expect(rows[0].wireHash).toBe(HASH64);
    expect(rows[0].currencyCode).toBe("USD");
    expect(rows[0].preparedAt).toBeTruthy();
  });

  // ── Event journal (5.4.5): generated, append-only ──

  it("every insert and status change writes exactly one event; others none", async () => {
    const { id } = await insertRefund();
    expect(await eventCount(id)).toBe(1);
    const ev = await db.$queryRaw<
      { fromStatus: string | null; toStatus: string; actor: string }[]
    >`SELECT "fromStatus", "toStatus", "actor" FROM "ShippingRefundEvent" WHERE "shippingRefundId" = ${id}`;
    expect(ev[0]).toMatchObject({ fromStatus: null, toStatus: "QUEUED", actor: "unknown" });

    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL mergeship.actor = 'operator-1'`;
      await tx.$executeRaw`UPDATE "ShippingRefund" SET "status" = 'SKIPPED' WHERE "id" = ${id}`;
    });
    expect(await eventCount(id)).toBe(2);
    // Select by toStatus, not timestamp: "at" has millisecond precision and
    // two events in the same transaction window may tie.
    const ev2 = await db.$queryRaw<
      { fromStatus: string | null; toStatus: string; actor: string }[]
    >`SELECT "fromStatus", "toStatus", "actor" FROM "ShippingRefundEvent"
      WHERE "shippingRefundId" = ${id} AND "toStatus" = 'SKIPPED'`;
    expect(ev2).toHaveLength(1);
    expect(ev2[0]).toMatchObject({ fromStatus: "QUEUED", toStatus: "SKIPPED", actor: "operator-1" });
  });

  it("the event writer stamps the UTC wall clock under a non-UTC session", async () => {
    const { id } = await insertRefund();
    await db.$transaction(async (tx) => {
      // Same discipline the other real suites run under (Asia/Tokyo).
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Tokyo'`);
      await tx.$executeRaw`UPDATE "ShippingRefund" SET "status" = 'SKIPPED' WHERE "id" = ${id}`;
      const rows = await tx.$queryRaw<{ at: Date; nowUtc: Date }[]>`
        SELECT e."at", clock_timestamp() AT TIME ZONE 'UTC' AS "nowUtc"
        FROM "ShippingRefundEvent" e
        WHERE e."shippingRefundId" = ${id} AND e."toStatus" = 'SKIPPED'`;
      // If the writer used session-local now() the stamp would sit ~9h off.
      expect(Math.abs(rows[0].at.getTime() - rows[0].nowUtc.getTime())).toBeLessThan(10_000);
    });
  });

  it("journal rows cannot be updated or deleted; journal tables cannot be truncated", async () => {
    const { id } = await insertRefund();
    await expect(
      db.$executeRaw`DELETE FROM "ShippingRefund" WHERE "id" = ${id}`,
    ).rejects.toThrow(/forbidden/i);
    await expect(
      db.$executeRaw`UPDATE "ShippingRefundEvent" SET "actor" = 'x' WHERE "shippingRefundId" = ${id}`,
    ).rejects.toThrow(/forbidden/i);
    await expect(
      db.$executeRaw`DELETE FROM "ShippingRefundEvent" WHERE "shippingRefundId" = ${id}`,
    ).rejects.toThrow(/forbidden/i);
    // TRUNCATE refusals come from two distinct layers. PostgreSQL checks
    // foreign-key references BEFORE firing BEFORE TRUNCATE triggers, so a
    // plain truncate of the parent is refused by the FK dependency — the
    // mandatory no-TRUNCATE trigger never gets to speak. Naming the
    // referencing table (or CASCADE, which pulls it in) satisfies the FK
    // check and then the trigger raises 'forbidden'.
    await expect(db.$executeRawUnsafe(`TRUNCATE "ShippingRefund"`)).rejects.toThrow(
      /cannot truncate a table referenced in a foreign key constraint/i,
    );
    await expect(
      db.$executeRawUnsafe(`TRUNCATE "ShippingRefundEvent"`),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      db.$executeRawUnsafe(`TRUNCATE "ShippingRefund", "ShippingRefundEvent"`),
    ).rejects.toThrow(/forbidden/i);
    await expect(
      db.$executeRawUnsafe(`TRUNCATE "ShippingRefund" CASCADE`),
    ).rejects.toThrow(/forbidden/i);
  });

  // ── Control and approval constraints (4.2, 4.3) ──

  it("the seeded control singleton is fully off and dispatch needs admission first", async () => {
    const rows = await db.$queryRaw<
      {
        id: string; admissionEnabled: boolean; admissionEnabledAt: Date | null;
        dispatchEnabled: boolean; dispatchEnabledAt: Date | null; globalDailyCap: number;
      }[]
    >`SELECT * FROM "ShippingExecuteControl"`;
    expect(rows).toEqual([
      {
        id: "control", admissionEnabled: false, admissionEnabledAt: null,
        dispatchEnabled: false, dispatchEnabledAt: null, globalDailyCap: 0,
        note: "S1-A: seeded fully off", updatedAt: expect.any(Date),
      },
    ]);
    // Enabling dispatch while admission is off is rejected; the epoch must be
    // non-null exactly while its switch is on.
    await expect(
      db.$executeRaw`UPDATE "ShippingExecuteControl" SET "dispatchEnabled" = true WHERE "id" = 'control'`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE "ShippingExecuteControl" SET "admissionEnabled" = true WHERE "id" = 'control'`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE "ShippingExecuteControl" SET "globalDailyCap" = -1 WHERE "id" = 'control'`,
    ).rejects.toThrow();
    // Singleton discipline.
    await expect(
      db.$executeRaw`INSERT INTO "ShippingExecuteControl" ("id") VALUES ('other')`,
    ).rejects.toThrow();
  });

  it("safe control-state changes commit, and ordered violations roll back", async () => {
    const ROLLBACK = "__rollback__";
    // Positive path: admission then dispatch, each with its epoch — legal.
    // The tx is rolled back so the seeded singleton stays fully off.
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "ShippingExecuteControl" SET
          "admissionEnabled" = true,
          "admissionEnabledAt" = clock_timestamp() AT TIME ZONE 'UTC'
          WHERE "id" = 'control'`;
        await tx.$executeRaw`UPDATE "ShippingExecuteControl" SET
          "dispatchEnabled" = true,
          "dispatchEnabledAt" = clock_timestamp() AT TIME ZONE 'UTC'
          WHERE "id" = 'control'`;
        throw new Error(ROLLBACK);
      }),
    ).rejects.toThrow(ROLLBACK);
    // Order violation: with dispatch on, admission cannot drop first.
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "ShippingExecuteControl" SET
          "admissionEnabled" = true,
          "admissionEnabledAt" = clock_timestamp() AT TIME ZONE 'UTC'
          WHERE "id" = 'control'`;
        await tx.$executeRaw`UPDATE "ShippingExecuteControl" SET
          "dispatchEnabled" = true,
          "dispatchEnabledAt" = clock_timestamp() AT TIME ZONE 'UTC'
          WHERE "id" = 'control'`;
        await tx.$executeRaw`UPDATE "ShippingExecuteControl" SET
          "admissionEnabled" = false, "admissionEnabledAt" = NULL
          WHERE "id" = 'control'`;
      }),
    ).rejects.toThrow();
    // Epoch discipline: the epoch cannot go NULL while the switch stays on.
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "ShippingExecuteControl" SET
          "admissionEnabled" = true,
          "admissionEnabledAt" = clock_timestamp() AT TIME ZONE 'UTC'
          WHERE "id" = 'control'`;
        await tx.$executeRaw`UPDATE "ShippingExecuteControl" SET
          "admissionEnabledAt" = NULL WHERE "id" = 'control'`;
      }),
    ).rejects.toThrow();
    // The singleton is untouched — still the fully-off seed.
    const rows = await db.$queryRaw<{ admissionEnabled: boolean; dispatchEnabled: boolean }[]>`
      SELECT "admissionEnabled", "dispatchEnabled" FROM "ShippingExecuteControl" WHERE "id" = 'control'`;
    expect(rows).toEqual([{ admissionEnabled: false, dispatchEnabled: false }]);
  });

  it("approval format constraints hold", async () => {
    const base = {
      approvedAt: "2030-01-01", approvedBy: "op", merchantOptInEpoch: "2030-01-01",
      ackVersion: "v1", ackRecordedAt: "2030-01-01", currencyCode: "USD",
    };
    for (const bad of ["", "00", "01", "-1", "1.5", "abc", "1e3", "9".repeat(41)]) {
      await expect(
        db.$executeRaw`INSERT INTO "ShippingExecuteApproval"
          ("shop","approvedAt","approvedBy","merchantOptInEpoch","ackVersion","ackRecordedAt","currencyCode","maxRefundMinor")
          VALUES (${uniqueShop()}, ${base.approvedAt}::timestamptz AT TIME ZONE 'UTC', 'op',
            ${base.merchantOptInEpoch}::timestamptz AT TIME ZONE 'UTC', 'v1',
            ${base.ackRecordedAt}::timestamptz AT TIME ZONE 'UTC', 'USD', ${bad})`,
      ).rejects.toThrow();
    }
    for (const good of ["0", "1", "500000", "9".repeat(40)]) {
      const shop = uniqueShop();
      await db.$executeRaw`INSERT INTO "ShippingExecuteApproval"
        ("shop","approvedAt","approvedBy","merchantOptInEpoch","ackVersion","ackRecordedAt","currencyCode","maxRefundMinor")
        VALUES (${shop}, ${base.approvedAt}::timestamptz AT TIME ZONE 'UTC', 'op',
          ${base.merchantOptInEpoch}::timestamptz AT TIME ZONE 'UTC', 'v1',
          ${base.ackRecordedAt}::timestamptz AT TIME ZONE 'UTC', 'USD', ${good})`;
    }
    await expect(
      db.$executeRaw`INSERT INTO "ShippingExecuteApproval"
        ("shop","approvedAt","approvedBy","merchantOptInEpoch","ackVersion","ackRecordedAt","currencyCode","maxRefundMinor")
        VALUES (${uniqueShop()}, '2030-01-01'::timestamptz AT TIME ZONE 'UTC', 'op',
          '2030-01-01'::timestamptz AT TIME ZONE 'UTC', 'v1',
          '2030-01-01'::timestamptz AT TIME ZONE 'UTC', 'usd', '0')`,
    ).rejects.toThrow();
  });

  // ── Uniqueness (I10) ──

  it("(shop, sourceOrderId), idempotencyKey and marker are each unique", async () => {
    const first = await insertRefund();
    const row = (await db.$queryRaw<
      { shop: string; sourceOrderId: string; idempotencyKey: string; marker: string }[]
    >`SELECT "shop", "sourceOrderId", "idempotencyKey", "marker" FROM "ShippingRefund" WHERE "id" = ${first.id}`)[0];
    const clone = async (over: { key?: string; marker?: string; src?: string }) =>
      db.$executeRaw`
        INSERT INTO "ShippingRefund" (
          "id","shop","mergeOperationId","sourceOrderId","primaryOrderId","primaryOrderName",
          "operationCreatedAt","sourceCancelledAt","lane","status",
          "merchantEpochAt","rolloutEpochAt","switchEpochAt","activationCutoffAt",
          "admissionEpochAt","admissionCutoffAt","approvalApprovedAt","approvalOptInEpoch",
          "approvalAckVersion","policyKind","idempotencyKey","marker"
        ) VALUES (
          ${"sr_" + randomUUID().replace(/-/g, "")}, ${row.shop},
          ${"mo_" + randomUUID().replace(/-/g, "")},
          ${over.src ?? row.sourceOrderId}, ${oid(3)}, '#P',
          '2030-01-06'::timestamptz AT TIME ZONE 'UTC',
          '2030-01-06'::timestamptz AT TIME ZONE 'UTC',
          'OBSERVE','QUEUED',
          '2030-01-01'::timestamptz AT TIME ZONE 'UTC','2030-01-02'::timestamptz AT TIME ZONE 'UTC',
          '2030-01-03'::timestamptz AT TIME ZONE 'UTC','2030-01-03'::timestamptz AT TIME ZONE 'UTC',
          '2030-01-04'::timestamptz AT TIME ZONE 'UTC','2030-01-05'::timestamptz AT TIME ZONE 'UTC',
          '2030-01-05'::timestamptz AT TIME ZONE 'UTC','2030-01-01'::timestamptz AT TIME ZONE 'UTC',
          'v1','REFUND_ALL',${over.key ?? randomUUID()},${over.marker ?? "MS-SHIPREFUND-" + randomUUID()}
        )`;
    await expect(clone({})).rejects.toThrow();                 // same shop+sourceOrderId
    await expect(clone({ key: row.idempotencyKey, src: oid(4242) })).rejects.toThrow();
    await expect(clone({ marker: row.marker, src: oid(5353) })).rejects.toThrow();
  });

  // ── Catalog alteration checks on scratch databases (5.4.7) ──
  // These alter triggers, so they run inside a separately migrated scratch
  // database that is dropped afterwards — never on the provisioned baseline.

  // NOTE: no DISABLE/ENABLE TRIGGER here — the spec (3.2, 19.2) reserves the
  // only suspend mechanism for the narrowly controlled fixture helper, and
  // 5.4.7 scratch checks use only the permitted DROP/CREATE mechanisms.
  // Disabled-trigger verdicts stay covered by the mocked catalog tests.
  it("unexpected, missing and wrongly defined triggers fail closed on a scratch copy", async () => {
    await withScratchDatabase(
      preflighted,
      async (scratchUrl) => {
        execSync("npx prisma migrate deploy", {
          env: { ...process.env, DATABASE_URL: scratchUrl },
          stdio: "pipe",
        });
        const scratch = new PrismaClient({ datasources: { db: { url: scratchUrl } } });
        try {
          const catalog = () =>
            scratch.$queryRawUnsafe<ShippingRefundTriggerCatalogRow[]>(TRIGGER_CATALOG_SQL);

          // Baseline: intact.
          expect((await checkTriggerIntegrity(catalog)).intact).toBe(true);

          const withMutated = async (ddl: string[], undo: string[]) => {
            for (const stmt of ddl) await scratch.$executeRawUnsafe(stmt);
            try {
              return await checkTriggerIntegrity(catalog);
            } finally {
              for (const stmt of undo) await scratch.$executeRawUnsafe(stmt);
            }
          };

          // Unexpected trigger.
          let v = await withMutated(
            [
              `CREATE TRIGGER rogue_trigger BEFORE UPDATE ON "ShippingRefund"
               FOR EACH ROW EXECUTE FUNCTION shipping_refund_fn_insert_guard()`,
            ],
            [`DROP TRIGGER rogue_trigger ON "ShippingRefund"`],
          );
          expect(v.intact).toBe(false);
          expect(v.reasons.map((r) => r.code)).toContain("UNEXPECTED");

          // Missing trigger.
          v = await withMutated(
            [`DROP TRIGGER shippingrefund_insert_guard ON "ShippingRefund"`],
            [
              `CREATE TRIGGER shippingrefund_insert_guard BEFORE INSERT ON "ShippingRefund"
               FOR EACH ROW EXECUTE FUNCTION shipping_refund_fn_insert_guard()`,
            ],
          );
          expect(v.intact).toBe(false);
          expect(v.reasons.map((r) => r.code)).toContain("MISSING");

          // Wrongly defined trigger (function swapped).
          v = await withMutated(
            [
              `DROP TRIGGER shippingrefund_insert_guard ON "ShippingRefund"`,
              `CREATE TRIGGER shippingrefund_insert_guard BEFORE INSERT ON "ShippingRefund"
               FOR EACH ROW EXECUTE FUNCTION shipping_refund_fn_always_raise()`,
            ],
            [
              `DROP TRIGGER shippingrefund_insert_guard ON "ShippingRefund"`,
              `CREATE TRIGGER shippingrefund_insert_guard BEFORE INSERT ON "ShippingRefund"
               FOR EACH ROW EXECUTE FUNCTION shipping_refund_fn_insert_guard()`,
            ],
          );
          expect(v.intact).toBe(false);
          expect(v.reasons.map((r) => r.code)).toContain("WRONG_FUNCTION");
        } finally {
          await scratch.$disconnect();
        }
      },
    );
  }, 180_000);

  // ── Constraint deployment (non-destructive; main database) ──
  // Text + predicate proof that the deployed CHECKs are the NULL-safe forms.
  // This reads pg_constraint only — no writes.

  it("the deployed verified_needs_success and wire_txn_fields CHECKs are NULL-safe", async () => {
    const defs = await db.$queryRaw<{ conname: string; def: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = '"ShippingRefund"'::regclass
        AND conname IN ('ShippingRefund_verified_needs_success', 'ShippingRefund_wire_txn_fields')`;
    const byName = Object.fromEntries(defs.map((d) => [d.conname, d.def]));
    expect(byName["ShippingRefund_verified_needs_success"]).toMatch(/COALESCE/i);
    expect(byName["ShippingRefund_wire_txn_fields"]).toMatch(/kind.+IS NOT NULL/is);
    // Predicate proof against real SQL: the VERIFIED clause is FALSE —
    // never UNKNOWN-pass — when settlementState is NULL.
    const p = await db.$queryRaw<{ passes: boolean | null }[]>`
      SELECT (('VERIFIED'::text <> 'VERIFIED') OR
              (COALESCE(NULL::text, '') = 'SUCCESS' AND NULL::timestamp IS NOT NULL)) AS passes`;
    expect(p[0].passes).toBe(false);
    // The exact kind clause of ShippingRefund_wire_txn_fields, evaluated by
    // real PostgreSQL over every invalid shape plus the valid one. `passes`
    // is the corrected predicate; `unsafe` is the pre-fix bare comparison —
    // JSON null and a missing key make it NULL (a CHECK accepts UNKNOWN),
    // while the corrected predicate is FALSE, never NULL.
    const k = await db.$queryRaw<{ passes: boolean | null; unsafe: boolean | null }[]>`
      SELECT (w->'input'->'transactions'->0->>'kind' IS NOT NULL
              AND w->'input'->'transactions'->0->>'kind' = 'REFUND') AS passes,
             (w->'input'->'transactions'->0->>'kind' = 'REFUND') AS unsafe
      FROM (VALUES
        ('{"idempotencyKey":"k","input":{"transactions":[{"kind":null}]}}'::jsonb),
        ('{"idempotencyKey":"k","input":{"transactions":[{}]}}'::jsonb),
        ('{"idempotencyKey":"k","input":{"transactions":[{"kind":5}]}}'::jsonb),
        ('{"idempotencyKey":"k","input":{"transactions":[{"kind":true}]}}'::jsonb),
        ('{"idempotencyKey":"k","input":{"transactions":[{"kind":"CAPTURE"}]}}'::jsonb),
        ('{"idempotencyKey":"k","input":{"transactions":[{"kind":"REFUND"}]}}'::jsonb)
      ) AS t(w)`;
    expect(k.map((r) => r.passes)).toEqual([false, false, false, false, false, true]);
    // The unsafe form would have admitted the first two shapes.
    expect(k.map((r) => r.unsafe)).toEqual([null, null, false, false, false, true]);
  });

  // ── Deferred integration proof (19.2.1/19.2.2 fixture contract) ──
  // The S1 transition graph can never manufacture a DISPATCHING or
  // REFUND_RECORDED row, so end-to-end enforcement at those statuses —
  // notably REFUND_RECORDED -> VERIFIED against ShippingRefund_
  // verified_needs_success on a real row — requires the narrowly controlled
  // fixture mechanism authorized for the post-dispatch stage (or Fixture B).
  // Scratch-catalog DROP/CREATE (5.4.7) exists to test integrity DETECTION,
  // not to manufacture financial rows, so this suite deliberately contains
  // no such bypass. The deployment and predicate proofs above are the S1-A
  // evidence; the live transition proof is deferred to the authorized
  // fixture helper when that stage is reached.
});
