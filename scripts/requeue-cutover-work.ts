// Requeues ProcessedWebhook rows stranded by the v1→v2 cutover (spec §11):
// rows created since --since with status DONE and outcome NULL go back to
// PENDING, and every PENDING row's deadline is extended by 6h so the sweep
// has time to work through the backlog.
//
//   npx vite-node scripts/requeue-cutover-work.ts --since 2026-10-01T00:00:00Z
//   npx vite-node scripts/requeue-cutover-work.ts --since 2026-10-01T00:00:00Z --apply

import "./require-database-url";
import db from "../app/db.server";
import { DB_WALL, dbWallPlus } from "../app/lib/ownership.server";

const argv = process.argv.slice(2);
const since = argv[argv.indexOf("--since") + 1];
const apply = argv.includes("--apply");
if (!since || isNaN(new Date(since).getTime())) {
  console.error("usage: npx vite-node scripts/requeue-cutover-work.ts --since <iso> [--apply]");
  process.exit(2);
}
const SIX_HOURS_MS = 6 * 60 * 60_000;

const stranded = await db.$queryRaw<{ id: string; shop: string; orderId: string; createdAt: Date }[]>`
  SELECT "id", "shop", "orderId", "createdAt" FROM "ProcessedWebhook"
  WHERE "createdAt" >= ${new Date(since)} AND "status" = 'DONE' AND "outcome" IS NULL
  ORDER BY "createdAt"`;
const pending = await db.$queryRaw<{ count: bigint }[]>`
  SELECT COUNT(*)::bigint AS count FROM "ProcessedWebhook" WHERE "status" = 'PENDING'`;

console.log(`Stranded DONE/null-outcome rows since ${since}: ${stranded.length}`);
for (const r of stranded) console.log(`  ${r.orderId}  ${r.shop}  ${r.createdAt.toISOString()}`);
console.log(`PENDING rows whose deadlineAt would extend to now+6h: ${pending[0]?.count ?? 0}`);

if (!apply) {
  console.log("\nDry run — pass --apply to write.");
  process.exit(0);
}

const requeued = await db.$executeRaw`
  UPDATE "ProcessedWebhook"
  SET "status" = 'PENDING', "attempts" = 0, "retryAfter" = ${DB_WALL},
      "deadlineAt" = ${dbWallPlus(SIX_HOURS_MS)}, "lastReason" = 'CUTOVER_REQUEUE',
      "outcome" = NULL, "doneAt" = NULL, "leaseToken" = NULL, "leasedUntil" = NULL,
      "updatedAt" = ${DB_WALL}
  WHERE "createdAt" >= ${new Date(since)} AND "status" = 'DONE' AND "outcome" IS NULL`;
const extended = await db.$executeRaw`
  UPDATE "ProcessedWebhook"
  SET "deadlineAt" = ${dbWallPlus(SIX_HOURS_MS)}, "updatedAt" = ${DB_WALL}
  WHERE "status" = 'PENDING'`;
console.log(`Requeued ${requeued} row(s); extended ${extended} PENDING deadline(s).`);
