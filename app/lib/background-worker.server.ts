// ── Background sweeper (protocol v2, spec §9) ────────────────────────────────
// The durability half of the merge pipeline: a single setTimeout chain started
// from entry.server that, every ~30s (±25% jitter), within a time budget:
//   1. reaps expired claims + heartbeats this worker instance;
//   2. leases and drives due v2 operations one step at a time (evidence
//      checks and reconciliation are reads — they run even with the kill
//      switches off; only the dispatch gate refuses mutations);
//   3. exhausts work items past their retry limit/deadline (status REVIEW);
//   4. claims and processes due work items, one at a time;
//   5. purges old DONE work rows and stale WorkerInstance heartbeats.
// v1 unfinished ops are deliberately NOT resumed here — the legacy
// reconciliation tool (spec §11) owns them.
//
// Every step is isolated so one failure cannot stop the others; each tick is
// independent — nothing in here is required for correctness, only for timely
// recovery. All stores/deps are injectable via runSweepOnce so tests drive the
// sweep with memory stores and a fake clock, free of timers.

import type { AdminClient } from "./graphql.server";
import { defaultMergeDeps, type MergeDeps } from "./merge.server";
import { driveOperation } from "./operation-protocol.server";
import { prismaClaimStore, type ClaimStore } from "./claims.server";
import { prismaMergeJournal, type MergeJournal } from "./merge-journal.server";
import { newLeaseToken, OwnershipLostError } from "./ownership.server";
import { prismaOperationStore, type OperationStore } from "./operation-store.server";
import {
  DONE_RETENTION_MS,
  prismaWorkStore,
  SWEEP_INTERVAL_MS,
  type WorkStore,
} from "./order-work.server";
import { isSessionNotFound, processOrderWork } from "./order-work-processor.server";
import { getSettings, type MergeSettings } from "./settings.server";

/** How long a sweep tick works before deferring to the next tick. */
export const SWEEP_BUDGET_MS = 20_000;
/** Heartbeat rows older than this are purged. */
export const INSTANCE_RETENTION_MS = 24 * 60 * 60_000;
/** An op whose shop has no offline session is retried this far out — a
 *  missing session cannot drive reads or writes, but must not be terminal. */
const NO_SESSION_RETRY_MS = 60 * 60_000;

export interface SweepContext {
  claims: ClaimStore;
  journal: MergeJournal;
  ops: OperationStore;
  work: WorkStore;
  deps: MergeDeps;
  /** This worker's id for the WorkerInstance heartbeat. */
  instanceId?: string;
  /** Resolves a shop's offline admin session; null = no session (uninstalled). */
  adminFactory: (shop: string) => Promise<AdminClient | null>;
  settings: (shop: string) => Promise<MergeSettings>;
  now: () => Date;
  random?: () => number;
  /** Max wall-clock time the op-drive and work loops may use (default 20s). */
  budgetMs?: number;
}

export async function runSweepOnce(ctx: SweepContext): Promise<void> {
  const msg = (err: any) => err?.message ?? String(err);
  const started = ctx.now().getTime();
  const budgetLeft = () => (ctx.budgetMs ?? SWEEP_BUDGET_MS) - (ctx.now().getTime() - started);

  // 1 — Expired merge claims are dropped so their orders can be re-claimed;
  //     the heartbeat records this worker for the tooling dashboard.
  try {
    const reaped = await ctx.claims.reapExpired();
    if (reaped) console.log(`[worker] Reaped ${reaped} expired merge claim(s).`);
  } catch (err: any) {
    console.error(`[worker] Claim reap failed: ${msg(err)}`);
  }
  try {
    await ctx.ops.heartbeat(
      ctx.instanceId ?? crypto.randomUUID(),
      process.env.RAILWAY_DEPLOYMENT_ID ?? null,
      process.env.npm_package_version ?? null,
    );
  } catch (err: any) {
    console.error(`[worker] Heartbeat failed: ${msg(err)}`);
  }

  // 2 — Due operations, leased and driven one step at a time.
  try {
    while (budgetLeft() > 0) {
      const op = await ctx.ops.acquireOperationLease(undefined, newLeaseToken(), ctx.deps.leaseTtlMs);
      if (!op) break;
      try {
        let admin: AdminClient | null = null;
        try {
          admin = await ctx.adminFactory(op.shop);
        } catch (err) {
          if (!isSessionNotFound(err)) throw err;
        }
        if (!admin) {
          console.warn(`[worker] No offline session for ${op.shop}; deferring op ${op.id}.`);
          try {
            await ctx.ops.transition(op, {
              expectedPhase: op.phase ?? undefined,
              nextCheckAt: NO_SESSION_RETRY_MS,
              lastError: "no offline session for the shop",
            });
          } catch (err) {
            if (!(err instanceof OwnershipLostError)) throw err;
          }
          continue;
        }
        await driveOperation(op, admin, ctx.deps);
      } catch (err: any) {
        console.error(`[worker] Driving operation ${op.id} failed: ${msg(err)}`);
      }
    }
  } catch (err: any) {
    console.error(`[worker] Operation scan failed: ${msg(err)}`);
  }

  // 3 — Work items past their retry limit or deadline become REVIEW; their
  //     stale owners' writes then fail on status <> 'PENDING'.
  try {
    const exhausted = await ctx.work.exhaustDue();
    if (exhausted) console.log(`[worker] Exhausted ${exhausted} work item(s) → REVIEW.`);
  } catch (err: any) {
    console.error(`[worker] Work-item exhaustion failed: ${msg(err)}`);
  }

  // 4 — Due work items, leased and driven one at a time.
  try {
    while (budgetLeft() > 0) {
      const [item] = await ctx.work.claimDue(1, ctx.deps.leaseTtlMs);
      if (!item) break;
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

  // 5 — Housekeeping: DONE work rows past retention + stale heartbeats.
  try {
    const purged = await ctx.work.purgeDone(DONE_RETENTION_MS);
    if (purged) console.log(`[worker] Purged ${purged} completed work item(s).`);
  } catch (err: any) {
    console.error(`[worker] Work-item purge failed: ${msg(err)}`);
  }
  try {
    await ctx.ops.purgeOldInstances(INSTANCE_RETENTION_MS);
  } catch (err: any) {
    console.error(`[worker] Instance purge failed: ${msg(err)}`);
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
    ops: prismaOperationStore,
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
