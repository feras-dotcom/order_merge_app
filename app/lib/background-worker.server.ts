// ── Background sweeper ────────────────────────────────────────────────────────
// The durability half of the merge pipeline: a single setTimeout chain started
// from entry.server that, every ~30s (±25% jitter), reaps expired claims,
// resumes unfinished merge operations (a crash mid-merge is finished here),
// re-leases due work items and processes them, and purges old DONE rows.
//
// Every step is isolated so one failure cannot stop the others; each tick is
// independent — nothing in here is required for correctness, only for timely
// recovery. All stores/deps are injectable via runSweepOnce so tests drive the
// sweep with memory stores and a fake clock, free of timers.

import type { AdminClient } from "./graphql.server";
import { defaultMergeDeps, resumeIncompleteMerges, type MergeDeps } from "./merge.server";
import { prismaClaimStore, type ClaimStore } from "./claims.server";
import { prismaMergeJournal, type MergeJournal } from "./merge-journal.server";
import {
  DONE_RETENTION_MS,
  prismaWorkStore,
  SWEEP_BATCH,
  SWEEP_INTERVAL_MS,
  type WorkStore,
} from "./order-work.server";
import { isSessionNotFound, processOrderWork } from "./order-work-processor.server";
import { getSettings, type MergeSettings } from "./settings.server";

export interface SweepContext {
  claims: ClaimStore;
  journal: MergeJournal;
  work: WorkStore;
  deps: MergeDeps;
  /** Resolves a shop's offline admin session; null = no session (uninstalled). */
  adminFactory: (shop: string) => Promise<AdminClient | null>;
  settings: (shop: string) => Promise<MergeSettings>;
  now: () => Date;
  random?: () => number;
  batchSize?: number;
}

export async function runSweepOnce(ctx: SweepContext): Promise<void> {
  const msg = (err: any) => err?.message ?? String(err);

  // 1 — Expired merge claims are dropped so their orders can be re-claimed.
  try {
    const reaped = await ctx.claims.reapExpired();
    if (reaped) console.log(`[worker] Reaped ${reaped} expired merge claim(s).`);
  } catch (err: any) {
    console.error(`[worker] Claim reap failed: ${msg(err)}`);
  }

  // 2 — Unfinished operations are resumed per shop (lease-guarded inside).
  try {
    for (const shop of await ctx.journal.findShopsWithUnfinished()) {
      try {
        const admin = await ctx.adminFactory(shop);
        if (!admin) {
          console.warn(`[worker] No offline session for ${shop}; skipping merge resume.`);
          continue;
        }
        await resumeIncompleteMerges(admin, shop, ctx.deps);
      } catch (err: any) {
        console.error(`[worker] Merge resume for ${shop} failed: ${msg(err)}`);
      }
    }
  } catch (err: any) {
    console.error(`[worker] Unfinished-operation scan failed: ${msg(err)}`);
  }

  // 3 — Due work items, leased and driven one at a time.
  try {
    const items = await ctx.work.claimDue(ctx.batchSize ?? SWEEP_BATCH, ctx.deps.leaseTtlMs);
    for (const item of items) {
      try {
        await processOrderWork({
          item,
          token: item.leaseToken!,
          shop: item.shop,
          adminFactory: ctx.adminFactory,
          deps: ctx.deps,
          work: ctx.work,
          settings: ctx.settings,
          now: ctx.now,
          random: ctx.random,
        });
      } catch (err: any) {
        console.error(`[worker] Work item ${item.orderId} (${item.shop}) failed: ${msg(err)}`);
      }
    }
  } catch (err: any) {
    console.error(`[worker] Work-item scan failed: ${msg(err)}`);
  }

  // 4 — Housekeeping: drop DONE rows past retention.
  try {
    const purged = await ctx.work.purgeDone(DONE_RETENTION_MS);
    if (purged) console.log(`[worker] Purged ${purged} completed work item(s).`);
  } catch (err: any) {
    console.error(`[worker] Work-item purge failed: ${msg(err)}`);
  }
}

/** Offline session via unauthenticated.admin; a missing session means the app
 *  was uninstalled — report null rather than throwing. */
async function sessionAdminFactory(shop: string): Promise<AdminClient | null> {
  try {
    // Loaded lazily so importing this module (e.g. in tests) does not pull in
    // the full Shopify app setup.
    const { unauthenticated } = await import("../shopify.server");
    const { admin } = await unauthenticated.admin(shop);
    return admin;
  } catch (err: any) {
    if (isSessionNotFound(err)) return null;
    throw err;
  }
}

const productionContext = (): SweepContext => {
  const deps = defaultMergeDeps();
  return {
    claims: prismaClaimStore(),
    journal: prismaMergeJournal,
    work: prismaWorkStore(),
    deps,
    adminFactory: sessionAdminFactory,
    settings: getSettings,
    now: () => new Date(),
  };
};

declare global {
  // eslint-disable-next-line no-var
  var __mergeshipWorkerStarted: boolean | undefined;
}

/** Starts the sweep loop once per process. No-op under tests and when
 *  DISABLE_BACKGROUND_WORKER=true (e.g. one-off deploy/debug shells). */
export function startBackgroundWorker(): void {
  if (globalThis.__mergeshipWorkerStarted) return;
  globalThis.__mergeshipWorkerStarted = true;
  if (
    process.env.DISABLE_BACKGROUND_WORKER === "true" ||
    process.env.VITEST ||
    process.env.NODE_ENV === "test"
  ) {
    return;
  }

  let stopping = false;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runSweepOnce(productionContext());
    } catch (err: any) {
      console.error(`[worker] Sweep failed: ${err?.message ?? err}`);
    } finally {
      running = false;
      schedule();
    }
  };

  const schedule = () => {
    if (stopping) return;
    const delay = SWEEP_INTERVAL_MS * (0.75 + Math.random() * 0.5);
    // Unref'd: the sweep must never keep the process alive on its own.
    setTimeout(() => void tick(), delay).unref();
  };

  // Stop scheduling on shutdown; in-flight work is left to its leases.
  process.once("SIGTERM", () => (stopping = true));
  process.once("SIGINT", () => (stopping = true));
  schedule();
}
