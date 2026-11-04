// S3 staged dev-store CLI over the `shopify app execute` transport.
//
// The S3 local run cannot use `unauthenticated.admin(shop)` — no offline
// Session row can be obtained without changing the production app config —
// so every Shopify call goes through scripts/lib/s3-cli-admin.ts, the
// S3-pinned CLI adapter (read-only / merge / refund modes, zero retries,
// JSONL transport log). The staged commands live here, out of
// shipping-refund-admin.ts, so the CLI credential surface stays isolated.
//
//   npx vite-node --script scripts/s3-cli.ts identity --evidence <dir>
//   npx vite-node --script scripts/s3-cli.ts backfill --orders <gidA>,<gidB> --since <iso> [--evidence <dir>] [--apply]
//   npx vite-node --script scripts/s3-cli.ts sweep --orders <gidA>,<gidB> [--ticks N] [--evidence <dir>] [--apply]
//   npx vite-node --script scripts/s3-cli.ts admission [--evidence <dir>] [--apply]
//   npx vite-node --script scripts/s3-cli.ts reconcile [--evidence <dir>] [--apply]
//   npx vite-node --script scripts/s3-cli.ts wire --row ID [--evidence <dir>]
//   npx vite-node --script scripts/s3-cli.ts dispatch --row ID --source GID --primary GID --expect-db DB [--evidence <dir>] [--apply]
//
// The store is the pinned literal S3_STORE — --shop may only repeat it.
// Every stage that touches the database runs the canonical
// preflightDisposableDatabase first (disposable marker, loopback host,
// mergeship_test_* name, MERGESHIP_SHADOW_TOKEN); mutating stages are
// dry-run unless --apply. --evidence is required for --apply and identity:
// the transport JSONL (<dir>/transport.jsonl) and a per-stage JSON result
// (<dir>/<stage>.json) are written there. No stage imports
// app/shopify.server — there is intentionally no Session row in play.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import db from "../app/db.server";
import { DB_WALL } from "../app/lib/ownership.server";
import {
  backfillWorkItem,
  listBackfillOrderIds,
  requireControlsOff,
} from "../app/lib/cutover.server";
import { isOnboardingComplete } from "../app/lib/onboarding";
import {
  buildSweepContext,
  runSweepOnce,
} from "../app/lib/background-worker.server";
import { runShippingRefundAdmissionScan } from "../app/lib/shipping-refund-admission.server";
import { runShippingRefundReconcileCycle } from "../app/lib/shipping-refund-reconcile.server";
import { runShippingRefundDispatchCycle } from "../app/lib/shipping-refund-worker.server";
import { shippingRefundsDispatchEnabled } from "../app/lib/shipping-refund-dispatch.server";
import { preflightDisposableDatabase } from "../tests/helpers/disposable-db";
import {
  createS3CliAdmin,
  createS3CliSessionLoader,
  evaluateS3DispatchPreflight,
  evaluateS3SweepScope,
  runS3IdentityProbe,
  S3_STORE,
} from "./lib/s3-cli-admin";

const args = process.argv.slice(2);
const cmd = args[0];
const get = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const APPLY = args.includes("--apply");

const ORDER_GID = /^gid:\/\/shopify\/Order\/\d+$/;
const MAX_SWEEP_TICKS = 20;
const S3_SWEEP_BUDGET_MS = 120_000;

const usage =
  "usage: s3-cli.ts <identity|backfill|sweep|admission|reconcile|wire|dispatch> " +
  "[--shop ordermergetest2.myshopify.com] [--evidence <dir>] [--apply]";

/** S3 safety gate for the staged commands: the canonical
 *  preflightDisposableDatabase checks — no production env, loopback host,
 *  disposable-name rules and the mergeship-shadow-disposable marker —
 *  verified on a fresh connection before any staged write or dispatch.
 *  MERGESHIP_SHADOW_TOKEN must match the provisioning token. */
const s3DbPreflight = async (): Promise<void> => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for the staged S3 commands");
  await preflightDisposableDatabase(url);
};

const requireS3Shop = (): void => {
  const shop = get("--shop");
  if (shop !== undefined && shop !== S3_STORE) {
    throw new Error(`--shop may only be ${S3_STORE} (got ${shop})`);
  }
};

async function main() {
  requireS3Shop();

  const evidenceDir = get("--evidence");
  if ((APPLY || cmd === "identity") && !evidenceDir) {
    throw new Error("--evidence <dir> is required for --apply and identity");
  }
  if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
  const transportLog = evidenceDir
    ? join(evidenceDir, "transport.jsonl")
    : join(tmpdir(), `mergeship-s3-${process.pid}-transport.jsonl`);
  const writeStageResult = (name: string, result: unknown) => {
    if (evidenceDir) {
      writeFileSync(
        join(evidenceDir, `${name}.json`),
        JSON.stringify(result, null, 1) + "\n",
      );
    }
  };
  const readOnlyAdmin = () =>
    createS3CliAdmin({ store: S3_STORE, mode: "read-only", transportLog });

  switch (cmd) {
    case "identity": {
      // Read-only, no DB: prove the CLI credential resolves to exactly the
      // pinned store and app on the pinned API version.
      const probe = await runS3IdentityProbe(readOnlyAdmin());
      writeStageResult("identity", probe);
      console.log(JSON.stringify(probe));
      if (!probe.match) process.exitCode = 1;
      return;
    }
    case "backfill": {
      // Mutating (ProcessedWebhook PENDING rows): exactly two distinct order
      // gids, the disposable Settings for the dev store must carry a live
      // auto-merge opt-in with completed onboarding, both orders must appear
      // in the live Shopify backfill listing, and --apply additionally
      // requires both mutation switches frozen off (requireControlsOff).
      const orders = (get("--orders") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const since = get("--since");
      if (!since || isNaN(new Date(since).getTime())) {
        throw new Error("--since <iso> is required");
      }
      if (
        orders.length !== 2 ||
        new Set(orders).size !== 2 ||
        !orders.every((o) => ORDER_GID.test(o))
      ) {
        throw new Error(
          "--orders requires exactly two distinct gid://shopify/Order/<id> values",
        );
      }
      await s3DbPreflight();
      const settings = await db.settings.findUnique({ where: { shop: S3_STORE } });
      if (!settings?.autoMergeEnabled || !isOnboardingComplete(settings)) {
        throw new Error(
          `refused: disposable Settings for ${S3_STORE} must have autoMergeEnabled and completed onboarding`,
        );
      }
      const ids = await listBackfillOrderIds(readOnlyAdmin(), since);
      const missing = orders.filter((o) => !ids.includes(o));
      const summary = {
        dryRun: !APPLY,
        orders,
        listed: ids.length,
        missing,
        written: 0,
      };
      if (missing.length > 0) {
        writeStageResult("backfill", summary);
        console.log(JSON.stringify(summary));
        throw new Error(
          `refused: ${missing.join(", ")} not in the live backfill listing since ${since}`,
        );
      }
      if (APPLY) {
        await requireControlsOff(db);
        for (const orderId of orders) {
          summary.written += await backfillWorkItem(db, S3_STORE, orderId);
        }
      }
      writeStageResult("backfill", summary);
      console.log(JSON.stringify(summary));
      return;
    }
    case "sweep": {
      // Mutating: runSweepOnce leases and drives merge work. Refuses unless
      // MERGESHIP_MUTATIONS=enabled, --orders names exactly the two approved
      // test orders, and the disposable database contains exactly those two
      // work items and no unexpected merge operation for the dev store —
      // fail closed before any tick.
      const ticks = get("--ticks") !== undefined ? Number(get("--ticks")) : 1;
      if (!Number.isInteger(ticks) || ticks < 1 || ticks > MAX_SWEEP_TICKS) {
        throw new Error(`--ticks must be an integer 1-${MAX_SWEEP_TICKS}`);
      }
      const expectedOrders = (get("--orders") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (
        expectedOrders.length !== 2 ||
        new Set(expectedOrders).size !== 2 ||
        !expectedOrders.every((o) => ORDER_GID.test(o))
      ) {
        throw new Error(
          "--orders requires exactly two distinct gid://shopify/Order/<id> values",
        );
      }
      await s3DbPreflight();
      if (process.env.MERGESHIP_MUTATIONS !== "enabled") {
        throw new Error("refused: MERGESHIP_MUTATIONS=enabled is required for the S3 sweep");
      }
      const [foreign] = await db.$queryRaw<{ n: bigint }[]>`
        SELECT (SELECT count(*) FROM "ProcessedWebhook" WHERE "shop" <> ${S3_STORE})
             + (SELECT count(*) FROM "MergeOperation" WHERE "shop" <> ${S3_STORE}) AS n`;
      if (Number(foreign?.n ?? 0n) > 0) {
        throw new Error(
          `refused: ${foreign?.n} ProcessedWebhook/MergeOperation row(s) belong to another shop — the S3 sweep is dev-store only`,
        );
      }
      const snapshot = async () => ({
        operations: await db.$queryRaw<
          {
            id: string;
            phase: string | null;
            sideEffectsDone: boolean;
            involvedOrderIds: string[];
            createdAt: Date;
          }[]
        >`
          SELECT "id","phase","sideEffectsDone","involvedOrderIds","createdAt"
          FROM "MergeOperation" WHERE "shop" = ${S3_STORE} ORDER BY "createdAt"`,
        workItems: await db.$queryRaw<
          { orderId: string; status: string; outcome: string | null }[]
        >`
          SELECT "orderId","status","outcome" FROM "ProcessedWebhook"
          WHERE "shop" = ${S3_STORE} ORDER BY "createdAt"`,
      });
      const scope = await (async () => {
        const { operations, workItems } = await snapshot();
        return evaluateS3SweepScope({
          expectedOrderIds: [expectedOrders[0], expectedOrders[1]],
          workItems,
          operations,
        });
      })();
      if (!scope.ok) {
        const result = { dryRun: !APPLY, refused: true, checks: scope.checks, failed: scope.failed };
        writeStageResult("sweep", result);
        console.log(JSON.stringify(result));
        throw new Error(`refused: S3 sweep scope failed: ${scope.failed.join(", ")}`);
      }
      if (!APPLY) {
        const result = { dryRun: true, ticks, wouldRun: "runSweepOnce", scope: scope.checks, before: await snapshot() };
        writeStageResult("sweep", result);
        console.log(JSON.stringify(result));
        return;
      }
      const mergeAdmin = createS3CliAdmin({
        store: S3_STORE,
        mode: "merge",
        transportLog,
      });
      const ctx = buildSweepContext({
        adminFactory: async (shop) => (shop === S3_STORE ? mergeAdmin : null),
        budgetMs: S3_SWEEP_BUDGET_MS,
      });
      for (let t = 1; t <= ticks; t++) {
        await runSweepOnce(ctx);
        const state = await snapshot();
        console.log(JSON.stringify({ tick: t, ...state }));
        writeStageResult("sweep", { dryRun: false, ticks, lastTick: t, state });
      }
      return;
    }
    case "admission": {
      // Mutating: one admission scan for the dev store — claims candidates,
      // freezes PREPARED rows. The CLI session proof stands in for the
      // offline Session row (fails closed).
      await s3DbPreflight();
      if (!APPLY) {
        const result = { dryRun: true, shop: S3_STORE, wouldRun: "runShippingRefundAdmissionScan" };
        writeStageResult("admission", result);
        console.log(JSON.stringify(result));
        return;
      }
      const admin = readOnlyAdmin();
      const r = await runShippingRefundAdmissionScan([S3_STORE], {
        adminFactory: async (s) => (s === S3_STORE ? admin : null),
        sessionLoader: createS3CliSessionLoader(admin),
        log: console.log,
      });
      writeStageResult("admission", r);
      console.log(JSON.stringify(r));
      return;
    }
    case "reconcile": {
      // Mutating: one reconciliation cycle for the dev store — read-only
      // toward Shopify but writes IN_DOUBT/adoption/review transitions.
      await s3DbPreflight();
      if (!APPLY) {
        const result = { dryRun: true, shop: S3_STORE, wouldRun: "runShippingRefundReconcileCycle" };
        writeStageResult("reconcile", result);
        console.log(JSON.stringify(result));
        return;
      }
      const admin = readOnlyAdmin();
      const r = await runShippingRefundReconcileCycle([S3_STORE], {
        adminFactory: async (s) => (s === S3_STORE ? admin : null),
        sessionLoader: createS3CliSessionLoader(admin),
        log: console.log,
      });
      writeStageResult("reconcile", r);
      console.log(JSON.stringify(r));
      return;
    }
    case "wire": {
      // Read-only: the frozen wire request and approval state for one row —
      // what the operator approves with approve-hash before dispatch.
      const row = get("--row");
      if (!row) throw new Error("--row is required");
      await s3DbPreflight();
      const [r] = await db.$queryRaw<{
        id: string; shop: string; status: string; reasonCode: string | null;
        wireHash: string | null; approvedWireHash: string | null;
        wireVariables: unknown; idempotencyKey: string | null;
        dispatchToken: string | null;
      }[]>`
        SELECT "id","shop","status","reasonCode","wireHash","approvedWireHash",
               "wireVariables","idempotencyKey","dispatchToken"
        FROM "ShippingRefund" WHERE "id" = ${row}`;
      writeStageResult("wire", r ?? null);
      console.log(JSON.stringify(r ?? null, null, 1));
      return;
    }
    case "dispatch": {
      // Staged S3 dispatch with a fail-closed preflight. This command is for
      // the isolated single-shop S3 run and refuses to proceed unless the
      // pure verdict (scripts/lib/s3-cli-admin.ts evaluateS3DispatchPreflight)
      // proves: the database is the expected disposable test database, --row
      // is the single due PREPARED row anywhere, it belongs to the dev
      // store, carries the expected source/primary order ids, an approved
      // wire hash and plannedShippingMinor <= 400. The sender itself is
      // unchanged: runShippingRefundDispatchCycle / DispatchPermit do the
      // T3 gate, single send and T4, and MERGESHIP_SHIPPING_REFUNDS=enabled
      // is still required by that code.
      await s3DbPreflight();
      const row = get("--row"), source = get("--source"), primary = get("--primary");
      const expectDb = get("--expect-db");
      if (!row || !source || !primary || !expectDb) {
        throw new Error("--row --source --primary --expect-db are required");
      }
      if (!/^mergeship_test_/.test(expectDb)) {
        throw new Error(`--expect-db must be a disposable mergeship_test_* database (got ${expectDb})`);
      }
      const [dbName] = await db.$queryRaw<{ d: string }[]>`SELECT current_database() AS "d"`;
      const due = await db.$queryRaw<{ id: string; shop: string }[]>`
        SELECT "id","shop" FROM "ShippingRefund"
        WHERE "status" = 'PREPARED'
          AND ("nextCheckAt" IS NULL OR "nextCheckAt" <= ${DB_WALL})`;
      const [r] = await db.$queryRaw<{
        id: string; shop: string; status: string; sourceOrderId: string;
        primaryOrderId: string; approvedWireHash: string | null;
        plannedShippingMinor: string | null;
      }[]>`
        SELECT "id","shop","status","sourceOrderId","primaryOrderId",
               "approvedWireHash","plannedShippingMinor"
        FROM "ShippingRefund" WHERE "id" = ${row}`;
      const verdict = evaluateS3DispatchPreflight({
        databaseName: dbName?.d ?? null,
        expectedDatabaseName: expectDb,
        duePreparedRows: due,
        row: r ?? null,
        expectedRowId: row,
        expectedShop: S3_STORE,
        expectedSourceOrderId: source,
        expectedPrimaryOrderId: primary,
      });
      const summary = {
        dryRun: !APPLY,
        enabled: shippingRefundsDispatchEnabled(),
        checks: verdict.checks,
        failed: verdict.failed,
      };
      if (verdict.failed.length > 0 || !APPLY) {
        writeStageResult("dispatch", summary);
        console.log(JSON.stringify(summary));
        if (!APPLY) return;
        throw new Error(`S3 dispatch preflight failed: ${verdict.failed.join(", ")}`);
      }
      const sessionProof = readOnlyAdmin();
      const refundAdmin = createS3CliAdmin({
        store: S3_STORE,
        mode: "refund",
        transportLog,
      });
      const out = await runShippingRefundDispatchCycle({
        adminFactory: async (s) => (s === S3_STORE ? refundAdmin : null),
        sessionLoader: createS3CliSessionLoader(sessionProof),
        log: console.log,
      });
      writeStageResult("dispatch", { ...summary, result: out });
      console.log(JSON.stringify(out));
      return;
    }
    default:
      console.error(usage);
      process.exit(2);
  }
}

await main();
