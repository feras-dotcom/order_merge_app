// Requeues ProcessedWebhook rows stranded by the v1→v2 cutover (spec §11):
// rows created since --since with status DONE and outcome NULL or LEGACY go
// back to PENDING — unless the order is locked by a live op or already merged.
//
//   npx vite-node scripts/requeue-cutover-work.ts --since 2026-10-01T00:00:00Z
//   npx vite-node scripts/requeue-cutover-work.ts --since 2026-10-01T00:00:00Z --apply

import "./require-database-url";
import db from "../app/db.server";
import { requeueCutoverWork } from "../app/lib/cutover.server";

const argv = process.argv.slice(2);
const since = argv[argv.indexOf("--since") + 1];
const apply = argv.includes("--apply");
if (!since || isNaN(new Date(since).getTime())) {
  console.error("usage: npx vite-node scripts/requeue-cutover-work.ts --since <iso> [--apply]");
  process.exit(2);
}

const plan = await requeueCutoverWork(db, new Date(since), { apply });
console.log(`Max Settings.mergeWindowHours: ${plan.maxWindowHours}`);
console.log(
  `LEGACY rows in [${plan.since.getTime() - plan.maxWindowHours * 60 * 60_000 > 0 ? new Date(plan.since.getTime() - plan.maxWindowHours * 60 * 60_000).toISOString() : "—"}, ${since}): ${plan.legacyInWindowBefore}`,
);
console.log(`DONE/LEGACY-or-null-outcome rows since ${since}: ${plan.candidates.length}`);
console.log(`Excluded — order locked by a live op: ${plan.excludedLocked.length}`);
for (const r of plan.excludedLocked) console.log(`  ${r.orderId}  ${r.shop}`);
console.log(`Excluded — order already merged: ${plan.excludedMerged.length}`);
for (const r of plan.excludedMerged) console.log(`  ${r.orderId}  ${r.shop}`);
console.log(`Eligible for requeue: ${plan.eligible.length}`);
for (const r of plan.eligible) console.log(`  ${r.orderId}  ${r.shop}`);
console.log(`PENDING backlog deadline extension (+6h): ${plan.pendingExtended} row(s)`);

console.log(
  apply
    ? `\nRequeued ${plan.requeued} row(s).`
    : "\nDry run — pass --apply to write.",
);
