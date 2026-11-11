// Real-Postgres concurrency tests for abortPreparedOnApprovalClosure: the
// preliminary GATE_CHANGED abort observed by preparedCapacityPrecheck on an
// unlocked read must be re-decided under the §4.10 locks in the same
// transaction as the abort write — a snapshot-equal approval restored in
// between wins and the row must never be terminalised on stale evidence.
// These tests use REAL second/third database connections and synchronise
// purely by OBSERVING the lock manager (pg_locks / pg_stat_activity),
// never by sleeping.
//
//   MERGESHIP_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:PORT/mergeship_test_x \
//   MERGESHIP_SHADOW_TOKEN=<token> npx vitest run tests/shipping-refund-approval-closure-race-pg.test.ts
//
// Blocked-state observation queries used below:
//   - pending table-lock requests on the approval table:
//       SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c
//       ON c.oid = l.relation WHERE c.relname='ShippingExecuteApproval'
//       AND NOT l.granted
//   - backends parked in a lock wait, with their active statement:
//       SELECT pid, query FROM pg_stat_activity
//       WHERE "datname"=current_database() AND wait_event_type='Lock'
// Both are asserted through waitFor() BEFORE the blocking lock is released,
// so each interleaving is proven, not assumed.
//
// The function under test is reached through a NAMESPACE import
// (dispatch.abortPreparedOnApprovalClosure) so this file still loads —
// and the concurrency tests still fail (TypeError on the missing export,
// or a false ABORTED write) — against the rejected production revision
// that predates it.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { preflightDisposableDatabase } from "./helpers/disposable-db";
import * as dispatch from "../app/lib/shipping-refund-dispatch.server";
import { runShippingRefundDispatchCycle } from "../app/lib/shipping-refund-worker.server";
import { OwnershipLostError } from "../app/lib/ownership.server";
import {
  r2HappyAdmin,
  seedPreparedR2Row,
  seedShippingR2Gate,
  seedShippingR2MergeOp,
} from "./helpers/shipping-refund-r2-fixture";

const TEST_URL = process.env.MERGESHIP_TEST_DATABASE_URL;
const oid = (n: number) => `gid://shopify/Order/${n}`;
const txnGid = (n: number) => `gid://shopify/OrderTransaction/${n}`;
const refundGid = (n: number) => `gid://shopify/Refund/${n}`;
const naive = (iso: string) => Prisma.sql`(${iso}::timestamptz AT TIME ZONE 'UTC')`;

describe.skipIf(!TEST_URL)("shipping-refund approval-closure race (real disposable database)", () => {
  let db: PrismaClient;
  let dbB: PrismaClient;
  let dbC: PrismaClient;
  let seq = 1_700_000_000 + Math.floor(Math.random() * 200_000_000);

  beforeAll(async () => {
    await preflightDisposableDatabase(TEST_URL!);
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: TEST_URL! }, stdio: "pipe" });
    db = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    dbB = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    dbC = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
  }, 120_000);
  afterAll(async () => {
    await db?.$disconnect();
    await dbB?.$disconnect();
    await dbC?.$disconnect();
  });

  const resolveInflightDispatches = async () => {
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='IN_DOUBT',"responseKind"='TRANSPORT',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "status"='DISPATCHING'`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='REVIEW_REQUIRED',"reasonCode"='TEST_CLEANUP',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "status" IN ('IN_DOUBT','REFUND_RECORDED')`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='RESOLVED',"resolvedBy"='test',"resolvedAt"=clock_timestamp() AT TIME ZONE 'UTC',"resolution"='cleanup',"resolutionNote"='x',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "status"='REVIEW_REQUIRED'`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='ABORTED',"reasonCode"='TEST_CLEANUP',"leaseToken"=NULL,"leasedUntil"=NULL,"nextCheckAt"=NULL,"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "status"='PREPARED'`;
    await db.$executeRaw`UPDATE "ShippingRefund" SET "status"='SKIPPED',"reasonCode"='TEST_CLEANUP',"leaseToken"=NULL,"leasedUntil"=NULL,"nextCheckAt"=NULL,"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "status"='QUEUED'`;
  };
  beforeEach(async () => {
    process.env.MERGESHIP_SHIPPING_REFUNDS = "enabled";
    await resolveInflightDispatches();
  });
  afterEach(async () => {
    delete process.env.MERGESHIP_SHIPPING_REFUNDS;
    await resolveInflightDispatches();
    await db.$executeRaw`UPDATE "ShippingExecuteControl" SET
      "admissionEnabled"=false,"admissionEnabledAt"=NULL,
      "dispatchEnabled"=false,"dispatchEnabledAt"=NULL,
      "globalDailyCap"=0,"note"='S1-A: seeded fully off',
      "updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "id"='control'`;
    await db.$executeRaw`UPDATE "AppControl" SET
      "shippingAdjustmentsEnabled"=false,"shippingEnabledAt"=NULL,
      "shippingAllowShops"='{}'::text[] WHERE "id"='control'`;
    await db.$executeRaw`DELETE FROM "ShippingExecuteApproval" WHERE "approvedBy"='r2-test'`;
  });

  const shop = () => `race-${randomUUID()}.myshopify.com`;

  // ── Seeding, leasing, observation ─────────────────────────────────────

  async function seedPrepared(s: string, gate: Parameters<typeof seedShippingR2Gate>[2] = {}) {
    await seedShippingR2Gate(db, s, gate);
    const ids = {
      sourceOrderId: oid(++seq),
      primaryOrderId: oid(++seq),
      captureTxnId: txnGid(++seq),
      authTxnId: txnGid(++seq),
    };
    const opId = await seedShippingR2MergeOp(db, {
      shop: s,
      primaryId: ids.primaryOrderId,
      secondaryId: ids.sourceOrderId,
    });
    const row = await seedPreparedR2Row(db, {
      shop: s,
      mergeOperationId: opId,
      evidence: ids,
      approvedHash: true,
    });
    return { row, opId, ev: row.evidence };
  }

  const lease = async (rowId: string) => {
    const l = await dispatch.leasePreparedShippingRefund(rowId, {}, db);
    if (!l.leased) throw new Error(`seed lease failed: ${l.reason}`);
    return l.leaseToken;
  };

  const rowById = async (id: string) =>
    (await db.$queryRaw<any[]>`SELECT * FROM "ShippingRefund" WHERE "id" = ${id}`)[0];

  const approvalRow = async (s: string) =>
    (await db.$queryRaw<any[]>`SELECT * FROM "ShippingExecuteApproval" WHERE "shop" = ${s}`)[0];

  /** Re-INSERT an approval row captured verbatim (naive-UTC binds). */
  const insertApproval = (q: { $executeRaw: PrismaClient["$executeRaw"] }, ap: any) =>
    q.$executeRaw`
      INSERT INTO "ShippingExecuteApproval"
        ("shop","approvedAt","approvedBy","revokedAt","merchantOptInEpoch",
         "ackVersion","ackRecordedAt","currencyCode","maxRefundMinor","dailyCap","autoApprove")
      VALUES (${ap.shop}, ${naive(ap.approvedAt.toISOString())}, ${ap.approvedBy},
        ${ap.revokedAt ? naive(ap.revokedAt.toISOString()) : Prisma.sql`NULL`},
        ${naive(ap.merchantOptInEpoch.toISOString())}, ${ap.ackVersion},
        ${naive(ap.ackRecordedAt.toISOString())}, ${ap.currencyCode},
        ${ap.maxRefundMinor}, ${ap.dailyCap}, ${ap.autoApprove})`;

  /** Poll a predicate until true — synchronisation by observing the lock
   *  manager, never by sleeping. */
  const waitFor = async (pred: () => Promise<boolean>, what: string, ms = 15_000) => {
    const t0 = Date.now();
    for (;;) {
      if (await pred()) return;
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  /** Observation query 1: non-granted lock requests on the approval table. */
  const ungrantedApprovalLocks = async () => {
    const [r] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks l
      JOIN pg_class c ON c.oid = l.relation
      WHERE c.relname = 'ShippingExecuteApproval' AND NOT l.granted`;
    return r.n;
  };

  /** Observation query 2: backends parked in a lock wait + their SQL. */
  const lockWaiters = () =>
    db.$queryRaw<{ pid: number; query: string }[]>`
      SELECT "pid", "query" FROM pg_stat_activity
      WHERE "datname" = current_database() AND "wait_event_type" = 'Lock'`;

  /** A held transaction on dbB: acquire `lockSql`, run `afterLock` inside
   *  the same transaction, signal ready, then park on the gate promise
   *  until the test releases it (commit). */
  const holdLock = (lockSql: string, afterLock?: (t: Prisma.TransactionClient) => Promise<unknown>) => {
    let ready!: () => void;
    let release!: () => void;
    const readyP = new Promise<void>((r) => (ready = r));
    const gate = new Promise<void>((r) => (release = r));
    const tx = dbB.$transaction(async (t) => {
      await t.$executeRawUnsafe(lockSql);
      if (afterLock) await afterLock(t);
      ready();
      await gate;
    });
    return { readyP, release, tx };
  };

  const runCycle = (admin: ReturnType<typeof r2HappyAdmin>["admin"]) =>
    runShippingRefundDispatchCycle({
      db,
      adminFactory: async () => admin,
      sessionLoader: async () => ({ expires: new Date("2030-01-10T00:00:00Z") }),
    });

  // ── 1. The reviewer race at cycle level: a snapshot-equal approval
  //       restored under lock must win over the stale precheck read ─────

  it(
    "restored snapshot-equal approval under lock: the cycle never aborts on the stale precheck read",
    async () => {
      const s = shop();
      const seeded = await seedPrepared(s);
      const ap = await approvalRow(s);
      await db.$executeRaw`DELETE FROM "ShippingExecuteApproval" WHERE "shop" = ${s}`;

      // Connection B holds the approval table's ROW EXCLUSIVE lock (the
      // level every writer takes) plus the uncommitted exact-snapshot
      // restore — the recreation the row lock alone cannot fence.
      const { readyP, release, tx: bTx } = holdLock(
        `LOCK TABLE "ShippingExecuteApproval" IN ROW EXCLUSIVE MODE`,
        (t) => insertApproval(t, ap),
      );
      await readyP;

      const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
      let cycleSettled = false;
      const cycle = runCycle(admin.admin).then((r) => {
        cycleSettled = true;
        return r;
      });

      // The precheck's unlocked read sees the approval MISSING →
      // preliminary GATE_CHANGED → the authoritative abort parks at its
      // LOCK TABLE on B's ROW EXCLUSIVE. Prove the block before release:
      await waitFor(
        async () => cycleSettled || (await ungrantedApprovalLocks()) > 0,
        "the abort's LOCK TABLE request to wait on B",
      );
      const blockedObserved = !cycleSettled; // a settle without the block is the stale-evidence defect
      release();
      const report = await cycle;
      await bTx;

      // The locked re-decision saw the restored snapshot → aborted:false →
      // the row continued through R2 → T3 → exactly one fake send.
      expect(blockedObserved, "the abort's LOCK TABLE was observed waiting on B's ROW EXCLUSIVE").toBe(true);
      expect(admin.mutationCalls()).toBe(1);
      expect(report.outcomes["ABORTED:GATE_CHANGED"] ?? 0).toBe(0);
      expect(Object.keys(report.outcomes).some((k) => k.startsWith("DISPATCHED"))).toBe(true);
      const row = await rowById(seeded.row.id);
      expect(row.status).not.toBe("ABORTED");
      expect(row.reasonCode).toBeNull();
      expect(row.dispatchedAt).not.toBeNull();
    },
    60_000,
  );

  // ── 2. Atomicity inside the decision window: an exact-snapshot INSERT
  //       cannot interleave between the closure read and the write ──────

  it(
    "a concurrent exact-snapshot INSERT is fenced out for the whole decision window",
    async () => {
      const s = shop();
      const seeded = await seedPrepared(s);
      const ap = await approvalRow(s);
      await db.$executeRaw`DELETE FROM "ShippingExecuteApproval" WHERE "shop" = ${s}`;
      const leaseToken = await lease(seeded.row.id);

      // Connection B holds ShippingRefundEvent in SHARE MODE: the abort's
      // status UPDATE fires the append-only event trigger whose INSERT
      // needs ROW EXCLUSIVE — so A parks INSIDE its locked section (row X,
      // Settings S, control X, approval table SHARE ROW EXCLUSIVE held)
      // with the decision still uncommitted.
      const { readyP, release, tx: bTx } = holdLock(
        `LOCK TABLE "ShippingRefundEvent" IN SHARE MODE`,
      );
      await readyP;

      const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
      let aResult: { aborted: true; detail: string } | { aborted: false } | undefined;
      let aErr: unknown;
      const aP = dispatch
        .abortPreparedOnApprovalClosure!(seeded.row.id, leaseToken, dbC)
        .then((r) => {
          aResult = r;
          return r;
        })
        .catch((e) => {
          aErr = e;
          throw e;
        });
      const aSettled = aP.then(() => "A", () => "A_ERR");

      // Prove A is parked on the event-table lock with its UPDATE active.
      await waitFor(
        async () => (await lockWaiters()).some((w) => w.query.includes('"ShippingRefund"') && w.query.includes("ABORTED")),
        "the abort's event-trigger insert to wait on the event-table lock",
      );

      // Connection C attempts the exact-snapshot restore: it must queue
      // behind A's SHARE ROW EXCLUSIVE table lock — prove the non-granted
      // request exists BEFORE releasing B.
      const cOrder: string[] = [];
      const cP = insertApproval(dbC as any, ap).then(
        () => cOrder.push("C"),
        (e) => cOrder.push(`C_ERR:${String(e && (e as Error).message).slice(0, 80)}`),
      );
      await waitFor(async () => (await ungrantedApprovalLocks()) > 0, "C's approval insert to wait on the table lock");
      expect(cOrder).toEqual([]); // provably still blocked, A still uncommitted

      release();
      await aSettled;
      await bTx;
      await cP;

      expect(aErr).toBeUndefined();
      expect(aResult).toMatchObject({ aborted: true });
      expect((aResult as { aborted: true; detail: string }).detail).toContain("approval");
      const row = await rowById(seeded.row.id);
      expect(row.status).toBe("ABORTED");
      expect(row.reasonCode).toBe("GATE_CHANGED");
      expect(String(row.reviewReason)).toContain("approval");
      expect(row.leaseToken).toBeNull();
      expect(row.leasedUntil).toBeNull();
      expect(row.nextCheckAt).toBeNull();
      expect(row.dispatchedAt).toBeNull();
      // C's restore landed only after A committed — it cannot un-abort.
      expect(cOrder).toEqual(["C"]);
      expect(await approvalRow(s)).toBeTruthy();
      expect(admin.allCalls()).toBe(0); // the settle spends no Shopify call
    },
    60_000,
  );

  // ── 3. Direct-function cases ──────────────────────────────────────────

  const approvalBreakers: Record<string, (s: string) => Promise<unknown>> = {
    deleted: (s) => db.$executeRaw`DELETE FROM "ShippingExecuteApproval" WHERE "shop" = ${s}`,
    revoked: (s) =>
      db.$executeRaw`UPDATE "ShippingExecuteApproval" SET "revokedAt" = clock_timestamp() AT TIME ZONE 'UTC' WHERE "shop" = ${s}`,
    restamped: (s) =>
      db.$executeRaw`UPDATE "ShippingExecuteApproval" SET "approvedAt" = ${naive("2031-01-01T00:00:00Z")} WHERE "shop" = ${s}`,
    "ackVersion changed": (s) =>
      db.$executeRaw`UPDATE "ShippingExecuteApproval" SET "ackVersion" = 'v2' WHERE "shop" = ${s}`,
    "Settings epoch changed": (s) =>
      db.$executeRaw`UPDATE "Settings" SET "shippingAdjustmentEnabledAt" = ${naive("2031-02-02T00:00:00Z")} WHERE "shop" = ${s}`,
  };

  const closureAbortTest = (name: string, mutate: (s: string) => Promise<unknown>) =>
    it(`approval ${name} under the locked decision writes ABORTED(GATE_CHANGED)`, async () => {
      const s = shop();
      const seeded = await seedPrepared(s);
      const leaseToken = await lease(seeded.row.id);
      const before = await rowById(seeded.row.id);
      await mutate(s);
      const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
      const r = await dispatch.abortPreparedOnApprovalClosure!(seeded.row.id, leaseToken, db);
      expect(r).toMatchObject({ aborted: true });
      expect((r as { aborted: true; detail: string }).detail).toContain("approval");
      const after = await rowById(seeded.row.id);
      expect(after.status).toBe("ABORTED");
      expect(after.reasonCode).toBe("GATE_CHANGED");
      expect(String(after.reviewReason)).toContain("approval");
      expect(after.leaseToken).toBeNull();
      expect(after.leasedUntil).toBeNull();
      expect(after.nextCheckAt).toBeNull();
      expect(after.dispatchedAt).toBeNull();
      expect(after.dispatchToken).toBeNull();
      expect(after.refundId).toBeNull();
      expect(after.attempts).toBe(before.attempts);
      for (const k of ["wireHash", "idempotencyKey", "marker", "documentSha256", "mutationVersion", "plannedShippingMinor", "currencyCode"] as const) {
        expect(after[k], `frozen column ${k}`).toEqual(before[k]);
      }
      expect(admin.allCalls()).toBe(0);
      // No dispatch evidence: no DISPATCHING transition event.
      const ev = await db.$queryRaw<{ toStatus: string }[]>`
        SELECT "toStatus" FROM "ShippingRefundEvent" WHERE "shippingRefundId" = ${seeded.row.id}`;
      expect(ev.some((e) => e.toStatus === "DISPATCHING")).toBe(false);
    });
  for (const [name, mutate] of Object.entries(approvalBreakers)) closureAbortTest(name, mutate);

  it("a valid snapshot-equal approval returns {aborted:false} and writes nothing", async () => {
    const s = shop();
    const seeded = await seedPrepared(s);
    const leaseToken = await lease(seeded.row.id);
    const before = await rowById(seeded.row.id);
    const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
    const r = await dispatch.abortPreparedOnApprovalClosure!(seeded.row.id, leaseToken, db);
    expect(r).toEqual({ aborted: false });
    const after = await rowById(seeded.row.id);
    expect(after).toEqual(before); // byte-identical: still PREPARED, lease intact
    expect(admin.allCalls()).toBe(0);
  });

  const stolenLeaseTest = (closed: boolean) =>
    it(`a stolen lease token rejects OwnershipLostError and writes nothing (approval ${closed ? "closed" : "valid"})`, async () => {
      const s = shop();
      const seeded = await seedPrepared(s);
      await lease(seeded.row.id);
      if (closed) await approvalBreakers.deleted(s);
      const before = await rowById(seeded.row.id);
      await expect(
        dispatch.abortPreparedOnApprovalClosure!(seeded.row.id, `stolen-${randomUUID()}`, db),
      ).rejects.toBeInstanceOf(OwnershipLostError);
      expect(await rowById(seeded.row.id)).toEqual(before);
    });

  const expiredLeaseTest = (closed: boolean) =>
    it(`an expired lease rejects OwnershipLostError and writes nothing (approval ${closed ? "closed" : "valid"})`, async () => {
      const s = shop();
      const seeded = await seedPrepared(s);
      const leaseToken = await lease(seeded.row.id);
      if (closed) await approvalBreakers.deleted(s);
      await db.$executeRaw`
        UPDATE "ShippingRefund" SET "leasedUntil" = clock_timestamp() AT TIME ZONE 'UTC' - INTERVAL '1 second'
        WHERE "id" = ${seeded.row.id}`;
      const before = await rowById(seeded.row.id);
      await expect(
        dispatch.abortPreparedOnApprovalClosure!(seeded.row.id, leaseToken, db),
      ).rejects.toBeInstanceOf(OwnershipLostError);
      expect(await rowById(seeded.row.id)).toEqual(before);
    });
  for (const closed of [true, false]) {
    stolenLeaseTest(closed);
    expiredLeaseTest(closed);
  }

  it("a row that left PREPARED rejects OwnershipLostError and writes nothing", async () => {
    const s = shop();
    const seeded = await seedPrepared(s);
    const leaseToken = await lease(seeded.row.id);
    await db.$executeRaw`
      UPDATE "ShippingRefund" SET "status" = 'REVIEW_REQUIRED', "reasonCode" = 'TEST'
      WHERE "id" = ${seeded.row.id}`;
    const before = await rowById(seeded.row.id);
    await expect(
      dispatch.abortPreparedOnApprovalClosure!(seeded.row.id, leaseToken, db),
    ).rejects.toBeInstanceOf(OwnershipLostError);
    expect(await rowById(seeded.row.id)).toEqual(before);
  });

  // ── 4. Lock-order/deadlock sanity against T3 and a setter-style writer ──

  it("no deadlock running concurrently with openDispatchGate and a setter-style approval writer", async () => {
    const ITERATIONS = 6;
    for (let i = 0; i < ITERATIONS; i++) {
      const sA = shop();
      const sB = shop();
      const sC = shop();
      const a = await seedPrepared(sA);
      const b = await seedPrepared(sB);
      await seedShippingR2Gate(db, sC);
      await db.$executeRaw`DELETE FROM "ShippingExecuteApproval" WHERE "shop" = ${sA}`;
      const tokA = await lease(a.row.id);
      const tokB = await lease(b.row.id);
      const results = await Promise.allSettled([
        dispatch.abortPreparedOnApprovalClosure!(a.row.id, tokA, dbB),
        dispatch.openDispatchGate(b.row.id, tokB, {}, dbC),
        // Setter-style writer (mirrors scripts/shipping-refund-admin.ts):
        // Settings FOR SHARE → control FOR SHARE → approval upsert.
        db.$transaction(async (t) => {
          await t.$queryRaw`SELECT "shop" FROM "Settings" WHERE "shop" = ${sC} FOR SHARE`;
          await t.$queryRaw`SELECT "id" FROM "ShippingExecuteControl" WHERE "id" = 'control' FOR SHARE`;
          await t.$executeRaw`UPDATE "ShippingExecuteApproval" SET "maxRefundMinor" = '9999' WHERE "shop" = ${sC}`;
        }),
      ]);
      for (const r of results) {
        if (r.status === "rejected") {
          const e = r.reason as { code?: string; message?: string };
          // Lock-timeout (55P03) / statement-timeout (57014) /
          // OwnershipLostError are acceptable contention outcomes; a
          // deadlock (40P01) is never acceptable.
          expect(e?.code).not.toBe("40P01");
          expect(String(e?.message ?? e)).not.toMatch(/deadlock detected/i);
        }
      }
      // The abort and the gate must both have reached a verdict.
      expect((results[0] as PromiseFulfilledResult<any>).value).toMatchObject({ aborted: true });
      expect(["PERMIT", "WAIT", "ABORTED"]).toContain((results[1] as PromiseFulfilledResult<any>).value?.kind);
    }
  }, 90_000);

  // ── 5. Cycle-level complement: deleted-stays-deleted aborts, and a
  //       restamp mid-window (uncommitted revoke lift) also continues ────

  it(
    "the deleted-stays-deleted variant still ends ABORTED(GATE_CHANGED) through the real worker",
    async () => {
      const s = shop();
      const seeded = await seedPrepared(s);
      await db.$executeRaw`DELETE FROM "ShippingExecuteApproval" WHERE "shop" = ${s}`;
      const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
      const report = await runCycle(admin.admin);
      expect(report.outcomes["ABORTED:GATE_CHANGED"]).toBe(1);
      expect(admin.allCalls()).toBe(0);
      const row = await rowById(seeded.row.id);
      expect(row.status).toBe("ABORTED");
      expect(row.reasonCode).toBe("GATE_CHANGED");
      expect(String(row.reviewReason)).toContain("approval");
      expect(row.dispatchedAt).toBeNull();
    },
  );

  it(
    "an uncommitted revoke-lift committed inside the decision window also continues the row",
    async () => {
      const s = shop();
      const seeded = await seedPrepared(s);
      const ap = await approvalRow(s);
      // Revoke committed: the precheck sees the closure…
      await db.$executeRaw`UPDATE "ShippingExecuteApproval" SET "revokedAt" = clock_timestamp() AT TIME ZONE 'UTC' WHERE "shop" = ${s}`;
      // …but a transaction restores the exact snapshot (revokedAt back to
      // NULL) under ROW EXCLUSIVE, uncommitted, before the abort's locks.
      const { readyP, release, tx: bTx } = holdLock(
        `LOCK TABLE "ShippingExecuteApproval" IN ROW EXCLUSIVE MODE`,
        (t) =>
          t.$executeRaw`UPDATE "ShippingExecuteApproval" SET "revokedAt" = NULL WHERE "shop" = ${s}`,
      );
      await readyP;
      const admin = r2HappyAdmin(seeded.ev, refundGid(++seq));
      let cycleSettled = false;
      const cycle = runCycle(admin.admin).then((r) => {
        cycleSettled = true;
        return r;
      });
      await waitFor(
        async () => cycleSettled || (await ungrantedApprovalLocks()) > 0,
        "the abort's LOCK TABLE request to wait on B",
      );
      const blockedObserved = !cycleSettled;
      release();
      const report = await cycle;
      await bTx;
      expect(blockedObserved, "the abort's LOCK TABLE was observed waiting on B's ROW EXCLUSIVE").toBe(true);
      expect(admin.mutationCalls()).toBe(1);
      expect(report.outcomes["ABORTED:GATE_CHANGED"] ?? 0).toBe(0);
      const row = await rowById(seeded.row.id);
      expect(row.status).not.toBe("ABORTED");
      expect(row.dispatchedAt).not.toBeNull();
      void ap;
    },
    60_000,
  );
});
