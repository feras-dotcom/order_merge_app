// Child worker for tests/two-process.test.ts (spec §12): a real process that
// talks to the fake Shopify over HTTP and to the shared test database through
// the real Prisma stores, so locks/leases/attempts race for real.
//
// Env: DATABASE_URL, FAKE_SHOPIFY_URL, SHOP, ANCHOR_ORDER_ID,
//      MERGESHIP_MUTATIONS=enabled

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { prismaClaimStore } from "../../app/lib/claims.server";
import type { AdminClient } from "../../app/lib/graphql.server";
import type { MergeDeps } from "../../app/lib/merge.server";
import { makeMergeJournal } from "../../app/lib/merge-journal.server";
import { runSweepOnce } from "../../app/lib/background-worker.server";
import { makeOperationStore } from "../../app/lib/operation-store.server";
import { newLeaseToken } from "../../app/lib/ownership.server";
import { prismaWorkStore, WORK_DEADLINE_MS } from "../../app/lib/order-work.server";
import { processOrderWork } from "../../app/lib/order-work-processor.server";

const FAKE = process.env.FAKE_SHOPIFY_URL;
const SHOP = process.env.SHOP;
const ANCHOR = process.env.ANCHOR_ORDER_ID;
if (!FAKE || !SHOP || !ANCHOR || !process.env.DATABASE_URL) {
  console.error("needs env: DATABASE_URL FAKE_SHOPIFY_URL SHOP ANCHOR_ORDER_ID");
  process.exit(2);
}

const admin: AdminClient = {
  graphql: async (query, options) =>
    fetch(`${FAKE}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables: options?.variables ?? {} }),
    }),
};

const db = new PrismaClient();
const ops = makeOperationStore(db);
const work = prismaWorkStore(db);
const claims = prismaClaimStore(db);
const journal = makeMergeJournal(db);
const deps: MergeDeps = {
  journal,
  claims,
  ops,
  leaseTtlMs: 120_000,
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  cancelPollAttempts: 4,
  cancelPollIntervalMs: 250,
};
const settings = async () => ({
  autoMergeEnabled: true,
  mergeWindowHours: 24,
  shippingCostSavings: 0,
  shopifyShopGid: "gid://shopify/Shop/1",
  autoMergeAcknowledgedAt: new Date(),
  onboardingStartedAt: new Date(),
  onboardingCompletedAt: new Date(),
});

// Start barrier: both children fire at once.
for (;;) {
  try {
    if ((await (await fetch(`${FAKE}/go`)).json()).go) break;
  } catch {
    /* server not up yet */
  }
  await new Promise((r) => setTimeout(r, 50));
}

const token = newLeaseToken();
const item = await work.insertLeased(SHOP, ANCHOR, token, deps.leaseTtlMs, WORK_DEADLINE_MS);
if (item) {
  try {
    await processOrderWork({
      item,
      token,
      shop: SHOP,
      admin,
      deps,
      work,
      settings,
      now: deps.now,
    });
  } catch (err: any) {
    console.error(`[worker ${ANCHOR}] processOrderWork: ${err?.message ?? err}`);
  }
}

// Keep sweeping until no non-terminal v2 op remains for the shop (or 60s).
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  try {
    await runSweepOnce({
      claims,
      journal,
      ops,
      work,
      deps,
      adminFactory: async () => admin,
      settings,
      now: () => new Date(),
      budgetMs: 2_000,
    });
  } catch (err: any) {
    console.error(`[worker ${ANCHOR}] sweep: ${err?.message ?? err}`);
  }
  const open = await db.$queryRaw<{ count: bigint }[]>`
    SELECT (
      (SELECT COUNT(*) FROM "MergeOperation"
        WHERE "shop" = ${SHOP} AND "protocolVersion" = 2
          AND ("phase" NOT IN ('COMPLETED','ABANDONED')
            OR ("phase" = 'COMPLETED' AND "sideEffectsDone" = false)))
      + (SELECT COUNT(*) FROM "ProcessedWebhook"
          WHERE "shop" = ${SHOP} AND "status" <> 'DONE')
    )::bigint AS count`;
  if (Number(open[0].count) === 0) break;
  await new Promise((r) => setTimeout(r, 150));
}

await db.$disconnect();
console.log(`[worker ${ANCHOR}] done`);
