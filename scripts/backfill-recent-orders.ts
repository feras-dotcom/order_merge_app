// Backfills ProcessedWebhook work items for recent orders (spec §11) — for
// every shop with automation on and a live session, recent
// open/paid/unfulfilled orders are inserted as unleased PENDING rows (the
// sweeper claims them). Existing rows are kept unless they are DONE with a
// NULL/LEGACY outcome — those are reopened for the v2 engine. Orders a live
// merge locks or a MergeRecord already absorbed are never written. --apply
// refuses to run while either mutation switch is on.
//
//   npx vite-node scripts/backfill-recent-orders.ts --since 2026-10-01T00:00:00Z
//   npx vite-node scripts/backfill-recent-orders.ts --since 2026-10-01T00:00:00Z --apply

import "./require-database-url";
import db from "../app/db.server";
import {
  backfillWorkItem,
  ControlsNotFrozenError,
  listBackfillOrderIds,
  requireControlsOff,
} from "../app/lib/cutover.server";
import { isOnboardingComplete } from "../app/lib/onboarding";

const argv = process.argv.slice(2);
const since = argv[argv.indexOf("--since") + 1];
const apply = argv.includes("--apply");
if (!since || isNaN(new Date(since).getTime())) {
  console.error("usage: npx vite-node scripts/backfill-recent-orders.ts --since <iso> [--apply]");
  process.exit(2);
}

const shops = await db.settings.findMany({ where: { autoMergeEnabled: true } });
const eligible = shops.filter(isOnboardingComplete);
console.log(`Shops with automation on: ${eligible.length} of ${shops.length}`);

const { unauthenticated } = await import("../app/shopify.server");

for (const s of eligible) {
  let admin;
  try {
    admin = (await unauthenticated.admin(s.shop)).admin;
  } catch (err: any) {
    console.log(`${s.shop}: no session (${err?.message ?? err}) — skipped`);
    continue;
  }
  let ids: string[];
  try {
    ids = await listBackfillOrderIds(admin, since);
  } catch (err: any) {
    console.log(`${s.shop}: order listing failed (${err?.message ?? err}) — NO rows written for this shop`);
    continue;
  }

  console.log(`${s.shop}: ${ids.length} order(s) since ${since}`);
  if (!apply || !ids.length) continue;
  try {
    await requireControlsOff(db);
  } catch (err) {
    if (err instanceof ControlsNotFrozenError) {
      console.error(`error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  // Unleased PENDING rows; the upsert also reopens DONE rows whose outcome
  // was NULL/LEGACY at cutover — v2 outcomes, REVIEW rows, locked and
  // already-merged orders are untouched.
  let written = 0;
  for (const orderId of ids) written += await backfillWorkItem(db, s.shop, orderId);
  console.log(`${s.shop}: wrote ${written}, skipped ${ids.length - written} existing/excluded`);
}
if (!apply) console.log("\nDry run — pass --apply to write.");
