// Converts leftover v1 MergeOperation rows (status PENDING_COMMIT / COMMITTED
// / NEEDS_REVIEW) into the v2 protocol — the logic lives in
// app/lib/legacy-reconcile.server.ts; this is only the CLI. Never abandons: an
// op whose live state cannot be proven goes to REVIEW_REQUIRED.
//
//   npx vite-node scripts/legacy-reconcile.ts            (dry run, prints table)
//   npx vite-node scripts/legacy-reconcile.ts --apply

import "./require-database-url";
import db from "../app/db.server";
import {
  applyLegacyVerdict,
  planLegacyReconciliation,
} from "../app/lib/legacy-reconcile.server";

const apply = process.argv.slice(2).includes("--apply");

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
  if (apply) await applyLegacyVerdict(db, op, verdict);
}

console.log(apply ? "\nApplied." : "\nDry run — pass --apply to write.");
