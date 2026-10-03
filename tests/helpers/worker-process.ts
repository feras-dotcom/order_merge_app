// Child worker for tests/two-process.test.ts (spec §12): a real process that
// talks to the fake Shopify over HTTP and to the shared test database through
// the real Prisma stores, so locks/leases/attempts race for real.
//
// Env: DATABASE_URL, FAKE_SHOPIFY_URL, SHOP, ANCHOR_ORDER_ID,
//      MERGESHIP_MUTATIONS=enabled
//      LEASE_TTL_MS          clamps the OPERATION lease to this ttl — claims
//                          and work leases keep the default so executeMerge
//                          can still finish; the short op lease is what lets
//                          a second worker take over after a crash
//      CRASH_AT              after-attempt-record → exit(1) right after the
//                          first attempt outcome is durable
//      SWEEP_ONLY            "true" → no anchor; just sweep until quiet
//      SWEEP_MAX_MS          (default 60000) sweep deadline
//      WORKER_NAME           identity posted to /ready so the harness can
//                          release exactly the workers a case expects

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
const SWEEP_ONLY = process.env.SWEEP_ONLY === "true";
const OP_LEASE_TTL = Number(process.env.LEASE_TTL_MS) || 0; // 0 → default ttl
const SWEEP_MAX = Number(process.env.SWEEP_MAX_MS) || 60_000;
const CRASH_AT = process.env.CRASH_AT;
const WORKER_NAME = process.env.WORKER_NAME ?? ANCHOR ?? "sweep";
if (!FAKE || !SHOP || (!ANCHOR && !SWEEP_ONLY) || !process.env.DATABASE_URL) {
  console.error("needs env: DATABASE_URL FAKE_SHOPIFY_URL SHOP ANCHOR_ORDER_ID|SWEEP_ONLY");
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
if (OP_LEASE_TTL) {
  // Shorten only the op lease: the merge CLAIMS and work leases must outlive
  // an executeMerge eligibility pass, but the op lease is the takeover fence.
  const create = ops.createOperation.bind(ops);
  ops.createOperation = async (input: Parameters<typeof create>[0]) =>
    create({ ...input, ttlMs: Math.min(input.ttlMs, OP_LEASE_TTL) });
  const renew = ops.renewOperation.bind(ops);
  ops.renewOperation = async (op: Parameters<typeof renew>[0], ttlMs: number) =>
    renew(op, Math.min(ttlMs, OP_LEASE_TTL));
  const acquire = ops.acquireOperationLease.bind(ops);
  ops.acquireOperationLease = async (
    shop: Parameters<typeof acquire>[0],
    token: Parameters<typeof acquire>[1],
    ttlMs: Parameters<typeof acquire>[2],
  ) => acquire(shop, token, Math.min(ttlMs, OP_LEASE_TTL));
}
if (CRASH_AT === "after-attempt-record") {
  // Crash the instant the first attempt outcome is durable: the row exists
  // (SUCCEEDED/UNKNOWN) and the op is mid-flight — a second worker must
  // reconcile from evidence instead of re-dispatching.
  const record = ops.recordAttempt.bind(ops);
  ops.recordAttempt = async (...args: Parameters<typeof record>) => {
    await record(...args);
    console.error(`[worker ${ANCHOR ?? "-"}] crash after attempt record`);
    process.exit(1);
  };
}
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

// Start barrier: register with the harness, then wait for /go — the test
// releases once every expected worker has checked in, never on a timer.
for (;;) {
  try {
    await fetch(`${FAKE}/ready?worker=${encodeURIComponent(WORKER_NAME)}`, { method: "POST" });
    break;
  } catch {
    /* server not up yet */
  }
  await new Promise((r) => setTimeout(r, 50));
}
for (;;) {
  try {
    if ((await (await fetch(`${FAKE}/go`)).json()).go) break;
  } catch {
    /* server not up yet */
  }
  await new Promise((r) => setTimeout(r, 50));
}

if (!SWEEP_ONLY) {
  const token = newLeaseToken();
  const item = await work.insertLeased(SHOP, ANCHOR!, token, deps.leaseTtlMs, WORK_DEADLINE_MS);
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
}

// Keep sweeping until no non-terminal v2 op remains for the shop (or max).
const deadline = Date.now() + SWEEP_MAX;
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
    console.error(`[worker ${ANCHOR ?? "-"}] sweep: ${err?.message ?? err}`);
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
console.log(`[worker ${ANCHOR ?? "sweep"}] done`);
