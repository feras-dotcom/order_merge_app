// Backfills ProcessedWebhook work items for recent orders (spec §11) — for
// every shop with automation on and a live session, recent
// open/paid/unfulfilled orders are inserted as unleased PENDING rows (the
// sweeper claims them). Existing rows are kept (ON CONFLICT DO NOTHING).
//
//   npx vite-node scripts/backfill-recent-orders.ts --since 2026-10-01T00:00:00Z
//   npx vite-node scripts/backfill-recent-orders.ts --since 2026-10-01T00:00:00Z --apply

import "./require-database-url";
import db from "../app/db.server";
import { isOnboardingComplete } from "../app/lib/onboarding";
import { DB_WALL, dbWallPlus } from "../app/lib/ownership.server";
import { WORK_DEADLINE_MS } from "../app/lib/order-work.server";

const argv = process.argv.slice(2);
const since = argv[argv.indexOf("--since") + 1];
const apply = argv.includes("--apply");
if (!since || isNaN(new Date(since).getTime())) {
  console.error("usage: npx vite-node scripts/backfill-recent-orders.ts --since <iso> [--apply]");
  process.exit(2);
}

const ORDERS_QUERY = `#graphql
  query BackfillOrders($query: String!, $after: String) {
    orders(first: 250, query: $query, after: $after) {
      nodes { id name createdAt }
      pageInfo { hasNextPage endCursor }
    }
  }`;

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
  const ids: string[] = [];
  let after: string | null = null;
  do {
    const res: any = await admin.graphql(ORDERS_QUERY, {
      variables: {
        query: `created_at:>=${since} status:open financial_status:paid fulfillment_status:unfulfilled`,
        after,
      },
    });
    const orders: any = (await res.json()).data?.orders;
    for (const n of orders?.nodes ?? []) if (n?.id) ids.push(n.id);
    after = orders?.pageInfo?.hasNextPage ? orders.pageInfo.endCursor : null;
  } while (after);

  console.log(`${s.shop}: ${ids.length} order(s) since ${since}`);
  if (!apply || !ids.length) continue;
  let inserted = 0;
  for (const orderId of ids) {
    // Unleased: leaseToken NULL, retryAfter now — claimDue owns the first pass.
    inserted += await db.$executeRaw`
      INSERT INTO "ProcessedWebhook"
        ("id", "shop", "orderId", "status", "attempts", "retryAfter",
         "leaseToken", "leasedUntil", "deadlineAt", "createdAt", "updatedAt")
      VALUES (
        ${crypto.randomUUID()}, ${s.shop}, ${orderId}, 'PENDING', 1, ${DB_WALL},
        NULL, NULL, ${dbWallPlus(WORK_DEADLINE_MS)}, ${DB_WALL}, ${DB_WALL}
      )
      ON CONFLICT ("shop", "orderId") DO NOTHING`;
  }
  console.log(`${s.shop}: inserted ${inserted}, skipped ${ids.length - inserted} existing`);
}
if (!apply) console.log("\nDry run — pass --apply to write.");
