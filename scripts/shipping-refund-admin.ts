// Operator CLI for the shipping-refund execution controls (§4.8, §4.9).
// Every mutating command is dry-run by default and requires --apply; all
// writes record an operator actor (SET LOCAL mergeship.actor where the
// store helpers do it, or the control/approval rows' note + a structured
// [shipping-refund] control-change line here).
//
//   npx vite-node --script scripts/shipping-refund-admin.ts status [--shop S]
//   npx vite-node --script scripts/shipping-refund-admin.ts set-control [--admission on|off] [--dispatch on|off] [--global-cap N] --note X --by WHO --apply
//   npx vite-node --script scripts/shipping-refund-admin.ts set-approval --shop S --currency USD --max-minor N --daily-cap N [--auto-approve on|off] --by WHO --note X --apply
//   npx vite-node --script scripts/shipping-refund-admin.ts revoke-approval --shop S --by WHO --apply
//   npx vite-node --script scripts/shipping-refund-admin.ts approve-hash --row ID --hash SHA --by WHO --apply
//   npx vite-node --script scripts/shipping-refund-admin.ts sweep-prepared-horizon [--shop S] [--limit N] --apply
//   npx vite-node --script scripts/shipping-refund-admin.ts resolve --row ID --by WHO --resolution X --note TEXT --apply
//   npx vite-node --script scripts/shipping-refund-admin.ts worker --apply   (one dispatch cycle; inert unless the worker env flag is enabled)
import defaultDb from "../app/db.server";
import { DB_WALL } from "../app/lib/ownership.server";
import {
  recordApprovedWireHash,
  resolveShippingRefundReview,
  sweepPreparedHorizon,
} from "../app/lib/shipping-refund-store.server";
import { REQUIRED_ACK_VERSION } from "../app/lib/shipping-refund-gate";
import {
  runShippingRefundDispatchCycle,
} from "../app/lib/shipping-refund-worker.server";
import { shippingRefundsDispatchEnabled } from "../app/lib/shipping-refund-dispatch.server";

const args = process.argv.slice(2);
const cmd = args[0];
const get = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const APPLY = args.includes("--apply");
const BY = get("--by") ?? null;
const onoff = (v: string | undefined) => (v === "on" ? true : v === "off" ? false : undefined);

const usage = `usage: shipping-refund-admin.ts <status|set-control|set-approval|revoke-approval|approve-hash|sweep-prepared-horizon|resolve|worker> [--apply]`;

async function main() {
  const db = defaultDb;
  switch (cmd) {
    case "status": {
      const shop = get("--shop") ?? null;
      const counts = shop === null
        ? await db.$queryRaw<{ status: string; n: bigint }[]>`
            SELECT "status", count(*) AS "n" FROM "ShippingRefund"
            GROUP BY "status" ORDER BY "status"`
        : await db.$queryRaw<{ status: string; n: bigint }[]>`
            SELECT "status", count(*) AS "n" FROM "ShippingRefund"
            WHERE "shop" = ${shop} GROUP BY "status" ORDER BY "status"`;
      const [breaker] = await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS "n" FROM "ShippingRefund"
        WHERE "dispatchedAt" IS NOT NULL AND "status" NOT IN ('VERIFIED','RESOLVED')`;
      const [ctl] = await db.$queryRaw<{ admissionEnabled: boolean; dispatchEnabled: boolean; globalDailyCap: number }[]>`
        SELECT "admissionEnabled", "dispatchEnabled", "globalDailyCap"
        FROM "ShippingExecuteControl" WHERE "id" = 'control'`;
      const [day] = await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS "n" FROM "ShippingRefund"
        WHERE "dispatchedAt" IS NOT NULL AND "dispatchedAt" > (${DB_WALL} - INTERVAL '24 hours')`;
      const approvals = await db.$queryRaw<{ shop: string; revokedAt: Date | null; dailyCap: number; maxRefundMinor: string; currencyCode: string; autoApprove: boolean }[]>`
        SELECT "shop", "revokedAt", "dailyCap", "maxRefundMinor", "currencyCode", "autoApprove"
        FROM "ShippingExecuteApproval" ORDER BY "shop"`;
      console.log(JSON.stringify({
        control: ctl ?? null,
        breakerTripped: Number(breaker?.n ?? 0) > 0,
        dispatches24h: Number(day?.n ?? 0),
        statusCounts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
        approvals,
      }, null, 1));
      return;
    }
    case "set-control": {
      const admission = onoff(get("--admission"));
      const dispatch = onoff(get("--dispatch"));
      const cap = get("--global-cap") !== undefined ? Number(get("--global-cap")) : undefined;
      const note = get("--note") ?? null;
      if (admission === undefined && dispatch === undefined && cap === undefined) throw new Error("nothing to change");
      if (cap !== undefined && (!Number.isInteger(cap) || cap < 0)) throw new Error("--global-cap must be a nonnegative integer");
      if (!note || !BY) throw new Error("--note and --by are required");
      console.log(JSON.stringify({ dryRun: !APPLY, admission, dispatch, globalDailyCap: cap, note, by: BY }));
      if (!APPLY) return;
      // One statement (4.2): epochs stamp on the DB clock on false->true,
      // clear on disable; dispatch implies admission; clearing admission
      // clears dispatch and its epoch.
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('mergeship.actor', ${BY}, true)`;
        await tx.$executeRaw`SELECT "id" FROM "ShippingExecuteControl" WHERE "id" = 'control' FOR UPDATE`;
        const cur = await tx.$queryRaw<{ admissionEnabled: boolean; dispatchEnabled: boolean; globalDailyCap: number }[]>`
          SELECT "admissionEnabled", "dispatchEnabled", "globalDailyCap"
          FROM "ShippingExecuteControl" WHERE "id" = 'control'`;
        const adm = admission ?? cur[0]?.admissionEnabled ?? false;
        const dis = (dispatch ?? cur[0]?.dispatchEnabled ?? false) && adm;
        const newCap = cap ?? cur[0]?.globalDailyCap ?? 0;
        await tx.$executeRaw`
          UPDATE "ShippingExecuteControl" SET
            "admissionEnabled" = ${adm},
            "admissionEnabledAt" = CASE WHEN ${adm} AND NOT "admissionEnabled" THEN ${DB_WALL}
                                        WHEN NOT ${adm} THEN NULL ELSE "admissionEnabledAt" END,
            "dispatchEnabled" = ${dis},
            "dispatchEnabledAt" = CASE WHEN ${dis} AND NOT "dispatchEnabled" THEN ${DB_WALL}
                                       WHEN NOT ${dis} THEN NULL ELSE "dispatchEnabledAt" END,
            "globalDailyCap" = ${newCap},
            "note" = ${note}, "updatedAt" = ${DB_WALL}
          WHERE "id" = 'control'`;
      });
      console.log(`[shipping-refund] control-change by=${BY} admission=${admission} dispatch=${dispatch} globalDailyCap=${cap}`);
      return;
    }
    case "set-approval": {
      const shop = get("--shop"), currency = get("--currency"), maxMinor = get("--max-minor"), dailyCap = get("--daily-cap");
      const auto = onoff(get("--auto-approve"));
      const note = get("--note") ?? null;
      if (!shop || !currency || !maxMinor || dailyCap === undefined || !note || !BY) {
        throw new Error("--shop --currency --max-minor --daily-cap --note --by are required");
      }
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error("--currency must be an ISO code");
      if (!/^(0|[1-9][0-9]{0,39})$/.test(maxMinor)) throw new Error("--max-minor must be '0' or a positive integer string");
      const cap = Number(dailyCap);
      if (!Number.isInteger(cap) || cap < 0) throw new Error("--daily-cap must be a nonnegative integer");
      console.log(JSON.stringify({ dryRun: !APPLY, shop, currency, maxRefundMinor: maxMinor, dailyCap: cap, autoApprove: auto ?? false, note, by: BY }));
      if (!APPLY) return;
      // Approval setter (4.3): reads the live opt-in epoch in the same tx
      // (Settings FOR SHARE, control FOR SHARE, approval FOR UPDATE),
      // refuses MERCHANT_NOT_OPTED_IN, stamps a fresh approvedAt and
      // re-reads the epoch on every write (all listed edits restamp).
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('mergeship.actor', ${BY}, true)`;
        const [st] = await tx.$queryRaw<{ shippingAdjustmentEnabledAt: Date | null }[]>`
          SELECT "shippingAdjustmentEnabledAt" FROM "Settings" WHERE "shop" = ${shop} FOR SHARE`;
        if (!(st?.shippingAdjustmentEnabledAt instanceof Date)) {
          throw new Error(`MERCHANT_NOT_OPTED_IN: ${shop} has no live shipping opt-in epoch`);
        }
        await tx.$queryRaw`SELECT "id" FROM "ShippingExecuteControl" WHERE "id" = 'control' FOR SHARE`;
        // merchantOptInEpoch must copy the Settings timestamp inside SQL —
        // a JS Date bound back into a naive timestamp column is read in the
        // session timezone and lands hours off on non-UTC sessions.
        await tx.$executeRaw`
          INSERT INTO "ShippingExecuteApproval"
            ("shop","approvedAt","approvedBy","revokedAt","merchantOptInEpoch","ackVersion","ackRecordedAt","currencyCode","maxRefundMinor","dailyCap","autoApprove","note")
          SELECT ${shop}, ${DB_WALL}, ${BY}, NULL, s."shippingAdjustmentEnabledAt",
                 ${REQUIRED_ACK_VERSION}, ${DB_WALL}, ${currency}, ${maxMinor}, ${cap}, ${auto ?? false}, ${note}
          FROM "Settings" s WHERE s."shop" = ${shop}
          ON CONFLICT ("shop") DO UPDATE SET
            "approvedAt" = ${DB_WALL}, "approvedBy" = ${BY}, "revokedAt" = NULL,
            "merchantOptInEpoch" = (SELECT s2."shippingAdjustmentEnabledAt" FROM "Settings" s2 WHERE s2."shop" = ${shop}),
            "ackVersion" = ${REQUIRED_ACK_VERSION}, "ackRecordedAt" = ${DB_WALL},
            "currencyCode" = ${currency}, "maxRefundMinor" = ${maxMinor},
            "dailyCap" = ${cap}, "autoApprove" = ${auto ?? false}, "note" = ${note}`;
      });
      console.log(`[shipping-refund] control-change approval by=${BY} shop=${shop}`);
      return;
    }
    case "revoke-approval": {
      const shop = get("--shop");
      if (!shop || !BY) throw new Error("--shop and --by are required");
      if (!APPLY) { console.log(JSON.stringify({ dryRun: true, revoke: shop, by: BY })); return; }
      const n = await db.$executeRaw`
        UPDATE "ShippingExecuteApproval" SET "revokedAt" = ${DB_WALL}
        WHERE "shop" = ${shop} AND "revokedAt" IS NULL`;
      console.log(`[shipping-refund] control-change revoke by=${BY} shop=${shop} updated=${n}`);
      return;
    }
    case "approve-hash": {
      const row = get("--row"), hash = get("--hash");
      if (!row || !hash || !BY) throw new Error("--row --hash --by are required");
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("--hash must be 64 lowercase hex");
      if (!APPLY) { console.log(JSON.stringify({ dryRun: true, row, hash: hash.slice(0, 12) + "…", by: BY })); return; }
      const ok = await recordApprovedWireHash(row, hash, BY, db);
      console.log(`[shipping-refund] approve-hash row=${row} recorded=${ok}`);
      if (!ok) process.exitCode = 1;
      return;
    }
    case "sweep-prepared-horizon": {
      // Mutating (PREPARED -> ABORTED): dry-run by default, --apply required (4.9).
      const r = await sweepPreparedHorizon(
        {
          shop: get("--shop") ?? null,
          limit: get("--limit") ? Number(get("--limit")) : undefined,
          dryRun: !APPLY,
        },
        db,
      );
      console.log(JSON.stringify({ dryRun: !APPLY, ...r }));
      return;
    }
    case "resolve": {
      const row = get("--row"), resolution = get("--resolution"), note = get("--note") ?? null;
      if (!row || !resolution || !note || !BY) throw new Error("--row --resolution --note --by are required");
      if (!APPLY) { console.log(JSON.stringify({ dryRun: true, row, resolution, by: BY })); return; }
      const r = await resolveShippingRefundReview(row, BY, resolution, { note }, db);
      console.log(JSON.stringify(r));
      return;
    }
    case "worker": {
      // Mutating: a dispatch cycle can lease, T3, send and T4 — so manual
      // invocation is opt-in like every other mutating command (4.9).
      // Without --apply this reports the same read-only facts `status`
      // would show for the pending work and exits; no cycle runs, no T3,
      // no send, no write. The scheduled in-process loop (entry.server)
      // does not pass through this CLI and is unaffected.
      if (!APPLY) {
        const [due] = await db.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS "n" FROM "ShippingRefund"
          WHERE "status" = 'PREPARED'
            AND ("nextCheckAt" IS NULL OR "nextCheckAt" <= ${DB_WALL})`;
        console.log(JSON.stringify({
          dryRun: true,
          enabled: shippingRefundsDispatchEnabled(),
          duePrepared: Number(due?.n ?? 0),
        }));
        return;
      }
      const { unauthenticated } = await import("../app/shopify.server");
      const r = await runShippingRefundDispatchCycle({
        adminFactory: async (shop) => (await unauthenticated.admin(shop)).admin,
        log: console.log,
      });
      console.log(JSON.stringify(r));
      return;
    }
    default:
      console.error(usage);
      process.exit(2);
  }
}

await main();
