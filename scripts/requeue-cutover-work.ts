// Requeues ProcessedWebhook rows stranded by the v1→v2 cutover (spec §11,
// N7): rows created in the derived window [cutoverAt − maxWindow, cutoverAt)
// with status DONE and outcome NULL or LEGACY go back to PENDING — unless the
// order is locked by a live op or already merged. Rows older than the window
// are provable leftovers and need an explicit --older-legacy disposition.
// --apply refuses to run while either mutation switch is on.
//
//   npx vite-node scripts/requeue-cutover-work.ts --cutover-at 2026-10-01T00:00:00Z
//   npx vite-node scripts/requeue-cutover-work.ts --cutover-at 2026-10-01T00:00:00Z \
//     --older-legacy review --apply
//   npx vite-node scripts/requeue-cutover-work.ts --cutover-at … --since … --apply

import "./require-database-url";
import db from "../app/db.server";
import {
  ControlsNotFrozenError,
  CutoverWindowError,
  requeueCutoverWork,
  type OlderLegacyDisposition,
} from "../app/lib/cutover.server";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const cutoverAt = flag("--cutover-at");
const since = flag("--since");
const olderLegacy = flag("--older-legacy");
const apply = argv.includes("--apply");
const usage =
  "usage: npx vite-node scripts/requeue-cutover-work.ts --cutover-at <iso> " +
  "[--since <iso>] [--older-legacy requeue|review|exclude] [--apply]";
if (!cutoverAt || isNaN(new Date(cutoverAt).getTime())) {
  console.error(usage);
  process.exit(2);
}
if (since !== undefined && isNaN(new Date(since).getTime())) {
  console.error(usage);
  process.exit(2);
}
if (olderLegacy !== undefined && !["requeue", "review", "exclude"].includes(olderLegacy)) {
  console.error(usage);
  process.exit(2);
}

let plan;
try {
  plan = await requeueCutoverWork(db, {
    cutoverAt: new Date(cutoverAt),
    since: since === undefined ? undefined : new Date(since),
    olderLegacy: olderLegacy as OlderLegacyDisposition | undefined,
    apply,
  });
} catch (err) {
  if (err instanceof CutoverWindowError || err instanceof ControlsNotFrozenError) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

console.log(`Max Settings.mergeWindowHours: ${plan.maxWindowHours}`);
console.log(`Cutover at: ${plan.cutoverAt.toISOString()}`);
console.log(`Derived safe since (cutoverAt − window): ${plan.safeSince.toISOString()}`);
console.log(`Effective since: ${plan.since.toISOString()}`);
console.log(
  `Older unproven LEGACY rows before since: ${plan.olderLegacy.count}` +
    (plan.olderLegacy.disposition
      ? ` → ${plan.olderLegacy.disposition} (${plan.olderLegacy.eligible} reachable, ${plan.olderLegacy.affected} written)`
      : ""),
);
console.log(`DONE/LEGACY-or-null-outcome rows since: ${plan.candidates.length}`);
console.log(`Excluded — order locked by a live op: ${plan.excludedLocked.length}`);
for (const r of plan.excludedLocked) console.log(`  ${r.orderId}  ${r.shop}`);
console.log(`Excluded — order already merged: ${plan.excludedMerged.length}`);
for (const r of plan.excludedMerged) console.log(`  ${r.orderId}  ${r.shop}`);
console.log(`Excluded — order in an unreconciled v1 operation: ${plan.excludedLegacy.length}`);
for (const r of plan.excludedLegacy) console.log(`  ${r.orderId}  ${r.shop}`);
console.log(`Eligible for requeue: ${plan.eligible.length}`);
for (const r of plan.eligible) console.log(`  ${r.orderId}  ${r.shop}`);
console.log(`PENDING rows within 1h of deadline (extended +6h): ${plan.pendingExtended}`);

console.log(
  apply
    ? `\nRequeued ${plan.requeued} row(s).`
    : "\nDry run — pass --apply to write.",
);
