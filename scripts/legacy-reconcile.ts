// Converts leftover v1 MergeOperation rows (status PENDING_COMMIT / COMMITTED
// / NEEDS_REVIEW / ABANDONED) into the v2 protocol — the logic lives in
// app/lib/legacy-reconcile.server.ts; this is only the CLI. An op whose live
// state cannot be proven goes to REVIEW_REQUIRED; a v1 ABANDONED row has no
// terminal conversion — absence of evidence is not proof the commit never
// applied, so it quarantines in REVIEW_REQUIRED for a human to resolve.
//
//   npx vite-node scripts/legacy-reconcile.ts            (dry run, prints table)
//   npx vite-node scripts/legacy-reconcile.ts --apply

import "./require-database-url";
import db from "../app/db.server";
import {
  applyLegacyVerdict,
  planLegacyReconciliation,
} from "../app/lib/legacy-reconcile.server";
import { ControlsNotFrozenError, requireControlsOff } from "../app/lib/cutover.server";

const apply = process.argv.slice(2).includes("--apply");

// Converting ops while the v2 engine is live races it — --apply requires
// both mutation switches off.
if (apply) {
  try {
    await requireControlsOff(db);
  } catch (err) {
    if (err instanceof ControlsNotFrozenError) {
      console.error(`error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

const { unauthenticated } = await import("../app/shopify.server");
const adminFor = async (shop: string) => {
  try {
    return (await unauthenticated.admin(shop)).admin;
  } catch {
    return null;
  }
};

const plans = await planLegacyReconciliation({ db, adminFor, now: () => new Date() });
console.log(`v1 operations in a blocking status: ${plans.length}`);
if (plans.length) console.log("\nopId  status  →  verdict  reason\n");

for (const { op, verdict } of plans) {
  console.log(
    `${op.id}  ${op.status}  →  ${verdict.phase}  ${verdict.reason ?? ""}` +
      (apply ? "" : "  (dry run)"),
  );
  for (const s of verdict.secondaries ?? []) {
    console.log(`    ${s.name}  →  ${s.cancelPhase ?? "-"}`);
  }
  for (const r of verdict.records ?? []) {
    console.log(`    + MergeRecord  ${r.name} → ${op.primaryOrderName}`);
  }
  for (const a of verdict.syntheticAttempts ?? []) {
    console.log(`    + synthetic UNKNOWN ORDER_CANCEL for ${a.targetOrderId}`);
  }
  if (apply) {
    const result = await applyLegacyVerdict(db, op, verdict);
    if (result === "skipped") console.log("    → skipped (stale plan — rerun)");
  }
}

console.log(apply ? "\nApplied." : "\nDry run — pass --apply to write.");
