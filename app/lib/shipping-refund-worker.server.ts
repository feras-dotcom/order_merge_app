// S2 operational worker (sections 9, 3.4, 19.5): drives due PREPARED rows
// through the capacity precheck, the R2 recheck, T3, the single send and
// T4 — in-process, behind MERGESHIP_SHIPPING_REFUNDS=enabled only, never
// refreshing tokens (N12/I22) and never resending anything (I7).
//
// QUEUED-row claim/evaluation/freeze stays with the admission scan (S1's
// tested machinery); this worker owns only the dispatch half. The
// reconciler (S1 code) keeps sweeping DISPATCHING -> IN_DOUBT, adopting and
// verifying independently.
import type { PrismaClient } from "@prisma/client";
import defaultDb from "../db.server";
import { OwnershipLostError } from "./ownership.server";
import type { AdminClient } from "./graphql.server";
import { dryRunSessionUsable, readOnlyAdmin } from "./shipping-shadow.server";
import { runShippingRefundAdmissionScan } from "./shipping-refund-admission.server";
import { runShippingRefundReconcileCycle } from "./shipping-refund-reconcile.server";
import { POST_DISPATCH_ENTRY_STATUS } from "./shipping-refund-gate";
import {
  Q_RECHECK, Q_REFUND_DETAIL, DETAIL_IDS_PER_REQUEST, DETAIL_REQUESTS_PER_EVALUATION,
  validateRefundDetailResponse,
} from "./shipping-refund-queries";
import { analyzeExecRecheck, compareBaselineAtR2, type BaselineRefundFingerprint, type RefundBaseline } from "./shipping-refund-baseline";
import { parseShopMoney } from "./money";
import {
  classifyDispatchResponse, leasePreparedShippingRefund, listDuePreparedShippingRefunds,
  openDispatchGate, preparedCapacityPrecheck, recordDispatchOutcome,
  releaseLeaseWithBackoff, renewPreparedShippingRefundLease, sendRefund,
  shippingRefundsDispatchEnabled,
  type DispatchOutcome,
} from "./shipping-refund-dispatch.server";
import { writePreparedR2Outcome } from "./shipping-refund-store.server";

export interface ShippingRefundDispatchCycleDeps {
  /** Offline admin client per shop. */
  adminFactory: (shop: string) => Promise<AdminClient | null>;
  /** The library's canonical offline row (getOfflineId(shop) = `offline_<shop>`,
   *  N12) — never a findFirst({isOnline:false}). */
  sessionLoader?: (shop: string) => Promise<{ expires: Date | null } | null>;
  log?: (line: string) => void;
  /** Permit clock seam (tests only — production uses the monotonic
   *  performance clock inside the dispatch module). */
  monotonicNow?: () => number;
  rowLimit?: number;
  db?: PrismaClient;
}

export interface DispatchCycleReport {
  readonly enabled: boolean;
  readonly rows: number;
  readonly outcomes: Record<string, number>;
}

const R2_ACTOR_READS = "shipping-refund-worker";
const bump = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };

const readBody = async (
  admin: AdminClient,
  document: string,
  variables: Record<string, unknown>,
): Promise<unknown> => (await (await admin.graphql(document, { variables })).json()) as unknown;

/** Build the §8.2.5 "fresh" comparison input from one validated Q-RECHECK
 *  response plus per-id Q-REFUND-DETAIL reads (bounded). Returns null when
 *  any read is invalid — an incomplete fresh read is a transient wait,
 *  never a baseline decision. */
async function freshBaselineRead(
  ro: AdminClient,
  sourceOrderId: string,
  refundIds: readonly string[],
): Promise<{
  refunds: BaselineRefundFingerprint[];
  refundNotes: Record<string, string>;
} | null> {
  const refunds: BaselineRefundFingerprint[] = [];
  const refundNotes: Record<string, string> = {};
  for (let b = 0; b < refundIds.length; b += DETAIL_IDS_PER_REQUEST) {
    if (b / DETAIL_IDS_PER_REQUEST >= DETAIL_REQUESTS_PER_EVALUATION) return null;
    const ids = refundIds.slice(b, b + DETAIL_IDS_PER_REQUEST);
    const body = await readBody(ro, Q_REFUND_DETAIL.document, { ids });
    const v = validateRefundDetailResponse(body, ids, { sourceOrderId });
    if (!v.ok) return null;
    const nodes = ((body as { data: { nodes: (Record<string, unknown> | null)[] } }).data.nodes ?? []);
    for (const n of nodes) {
      if (!n || typeof n.id !== "string") return null;
      const tot = parseShopMoney(n.totalRefundedSet);
      if (tot === null) return null;
      refunds.push({
        id: n.id,
        totalMinor: tot.minorUnits.toString(),
        transactionCount: ((n.transactions as { nodes?: unknown[] })?.nodes ?? []).length,
        shippingLineCount: ((n.refundShippingLines as { nodes?: unknown[] })?.nodes ?? []).length,
        adjustmentCount: ((n.orderAdjustments as { nodes?: unknown[] })?.nodes ?? []).length,
        dutyCount: ((n.duties as unknown[]) ?? []).length,
        refundLineItemCount: ((n.refundLineItems as { nodes?: unknown[] })?.nodes ?? []).length,
      });
      refundNotes[n.id] = typeof n.note === "string" ? n.note : "";
    }
  }
  return { refunds, refundNotes };
}

/** One leased PREPARED row: precheck → R2 → T3 → send → T4. Every write is
 *  the helper's own; a thrown OwnershipLostError ends work on this row
 *  without writing. Returns a tag for the report. */
async function processPreparedRow(
  rowId: string,
  shop: string,
  sourceOrderId: string,
  primaryOrderId: string,
  admin: AdminClient,
  deps: ShippingRefundDispatchCycleDeps & { db: PrismaClient },
): Promise<string> {
  const db = deps.db;
  const lease = await leasePreparedShippingRefund(rowId, { actor: R2_ACTOR_READS }, db);
  if (!lease.leased) return `LEASE_${lease.reason}`;
  const leaseToken = lease.leaseToken;

  // 1. Capacity precheck (DB only): horizon abort; every capacity reason waits.
  const pc = await preparedCapacityPrecheck(rowId, db);
  if ("abort" in pc && pc.abort) {
    await writePreparedR2Outcome(rowId, leaseToken, { toStatus: "ABORTED", reasonCode: "HORIZON_EXPIRED", reviewReason: "seven-day horizon passed at the capacity precheck" }, db);
    return "ABORTED:HORIZON_EXPIRED";
  }
  if ("wait" in pc && pc.wait) {
    await releaseLeaseWithBackoff(rowId, leaseToken, undefined, db);
    return `WAIT:${pc.reason}`;
  }

  // 2. R2 (8.2.5): fresh read-only evidence vs the frozen baseline. Read
  //    failures are transient waits; drift is abort/review.
  const ro = readOnlyAdmin(admin);
  let recheckBody: unknown;
  try {
    recheckBody = await readBody(ro, Q_RECHECK.document, {
      source: sourceOrderId,
      primary: primaryOrderId,
    });
  } catch (e) {
    await releaseLeaseWithBackoff(rowId, leaseToken, undefined, db);
    return `WAIT:RECHECK_TRANSPORT`;
  }
  const analysis = analyzeExecRecheck(recheckBody, { sourceOrderId, primaryOrderId });
  if (!analysis.ok) {
    if (analysis.reasonCode === "BASELINE_UNVERIFIED") {
      await releaseLeaseWithBackoff(rowId, leaseToken, undefined, db);
      return "WAIT:RECHECK_UNVERIFIED";
    }
    await writePreparedR2Outcome(rowId, leaseToken, { toStatus: "ABORTED", reasonCode: analysis.reasonCode, reviewReason: analysis.reason }, db);
    return `ABORTED:${analysis.reasonCode}`;
  }
  const evidence = analysis.evidence;

  let fresh: { refunds: BaselineRefundFingerprint[]; refundNotes: Record<string, string> } | null = { refunds: [], refundNotes: {} };
  if (evidence.refundIds.length > 0) {
    await renewPreparedShippingRefundLease(rowId, leaseToken, db);
    try {
      fresh = await freshBaselineRead(ro, sourceOrderId, evidence.refundIds);
    } catch {
      fresh = null;
    }
  }
  if (fresh === null) {
    await releaseLeaseWithBackoff(rowId, leaseToken, undefined, db);
    return "WAIT:DETAIL_READ_INCOMPLETE";
  }

  const [head] = await db.$queryRaw<{ preEvidence: unknown }[]>`
    SELECT "preEvidence" FROM "ShippingRefund" WHERE "id" = ${rowId}`;
  const stored = (head?.preEvidence as { baseline?: RefundBaseline } | null)?.baseline;
  if (!stored) {
    await writePreparedR2Outcome(rowId, leaseToken, { toStatus: "REVIEW_REQUIRED", reasonCode: "BASELINE_MISSING", reviewReason: "preEvidence.baseline absent on a PREPARED row" }, db);
    return "REVIEW_REQUIRED:BASELINE_MISSING";
  }
  const cmp = compareBaselineAtR2(stored, {
    refunds: fresh.refunds,
    totalRefundedMinor: evidence.totalRefundedMinor,
    totalRefundedShippingMinor: evidence.totalRefundedShippingMinor,
    transactionIds: evidence.transactions.map((t) => t.id),
    refundNotes: fresh.refundNotes,
  });
  if (!cmp.equal) {
    if (cmp.kind === "UNEXPECTED_OWN_MARKER") {
      await writePreparedR2Outcome(rowId, leaseToken, { toStatus: "REVIEW_REQUIRED", reasonCode: "UNEXPECTED_OWN_MARKER", reviewReason: cmp.detail }, db);
      return "REVIEW_REQUIRED:UNEXPECTED_OWN_MARKER";
    }
    await writePreparedR2Outcome(rowId, leaseToken, { toStatus: "ABORTED", reasonCode: cmp.kind === "BASELINE_CHANGED" ? "BASELINE_CHANGED" : "REFUND_APPEARED", reviewReason: cmp.detail }, db);
    return `ABORTED:${cmp.kind}`;
  }

  // 3. T3 — the write-ahead gate. Any throw is a no-decision: NO SEND.
  let t3: Awaited<ReturnType<typeof openDispatchGate>>;
  try {
    t3 = await openDispatchGate(rowId, leaseToken, { monotonicNow: deps.monotonicNow }, db);
  } catch (e) {
    if (e instanceof OwnershipLostError) return "LEASE_LOST";
    deps.log?.(`[shipping-refund] T3 no-decision for ${rowId}: ${String(e).slice(0, 160)}`);
    return "T3_NO_DECISION";
  }
  if (t3.kind === "WAIT") {
    await releaseLeaseWithBackoff(rowId, leaseToken, undefined, db);
    return `WAIT:${t3.reason}`;
  }
  if (t3.kind === "ABORTED") return `ABORTED:${t3.reasonCode}`;

  // 4. The single send + T4. Permit consumed before the call; zero retries.
  let outcome: DispatchOutcome;
  try {
    const body = await sendRefund(t3.permit, admin);
    outcome = classifyDispatchResponse(body);
  } catch (e) {
    outcome = { kind: "TRANSPORT", refundId: null, refundCreatedAt: null, userErrors: [], anomaly: false, summary: `send threw: ${String(e).slice(0, 200)}` };
  }
  const t4 = await recordDispatchOutcome(rowId, t3.permit.dispatchToken, outcome, { log: deps.log }, db);
  return `DISPATCHED:${outcome.kind}${t4.wrote ? "" : `:${t4.reason}`}`;
}

/** One dispatch cycle: all due PREPARED rows across shops, each inside its
 *  own error boundary. Runs only when MERGESHIP_SHIPPING_REFUNDS=enabled;
 *  returns a per-outcome report. Never throws for row-level failures. */
export async function runShippingRefundDispatchCycle(
  deps: ShippingRefundDispatchCycleDeps,
): Promise<DispatchCycleReport> {
  const db = deps.db ?? defaultDb;
  const log = deps.log ?? (() => {});
  if (!shippingRefundsDispatchEnabled()) return { enabled: false, rows: 0, outcomes: {} };

  const sessionLoader = deps.sessionLoader ??
    ((shop: string) => db.session.findUnique({ where: { id: `offline_${shop}` } }));

  const due = await listDuePreparedShippingRefunds(deps.rowLimit ?? 25, db);
  const byShop = new Map<string, typeof due>();
  for (const r of due) {
    const list = byShop.get(r.shop) ?? [];
    list.push(r);
    byShop.set(r.shop, list);
  }

  const outcomes: Record<string, number> = {};
  for (const [shop, rows] of byShop) {
    // N12/I22: the canonical offline session row, checked immediately
    // before any Shopify call; ~expiry skips the shop entirely.
    let session: { expires: Date | null } | null;
    try {
      session = await sessionLoader(shop);
    } catch {
      log(`[shipping-refund] ${shop}: session lookup failed — shop skipped`);
      bump(outcomes, "SHOP_SKIPPED:SESSION_LOOKUP_FAILED");
      continue;
    }
    if (!dryRunSessionUsable(session)) {
      log(`[shipping-refund] ${shop}: SESSION_UNUSABLE — shop skipped`);
      bump(outcomes, "SHOP_SKIPPED:SESSION_UNUSABLE");
      continue;
    }
    const admin = await deps.adminFactory(shop).catch(() => null);
    if (admin === null) {
      bump(outcomes, "SHOP_SKIPPED:ADMIN_UNAVAILABLE");
      continue;
    }
    for (const row of rows) {
      try {
        const tag = await processPreparedRow(row.id, shop, row.sourceOrderId, row.primaryOrderId, admin, { ...deps, db });
        bump(outcomes, tag);
      } catch (e) {
        if (e instanceof OwnershipLostError) bump(outcomes, "LEASE_LOST");
        else {
          bump(outcomes, "ROW_ERROR");
          log(`[shipping-refund] row ${row.id} error: ${String(e).slice(0, 200)}`);
        }
      }
    }
  }
  return { enabled: true, rows: due.length, outcomes };
}

// ── The in-process scheduling lifecycle (3.1, 3.4, 4.8) ─────────────────

/** One loop iteration interval; ±25% jitter like the merge sweeper. */
export const SHIPPING_REFUND_LOOP_INTERVAL_MS = 60_000;

export interface ShippingRefundLoopDeps {
  adminFactory?: (shop: string) => Promise<AdminClient | null>;
  log?: (line: string) => void;
  db?: PrismaClient;
}

/** Offline admin client for the scheduled loop — the same lazy
 *  unauthenticated.admin the operator CLI uses. Imported lazily so this
 *  module stays loadable in tests without the full Shopify app setup. */
const loopAdminFactory = async (shop: string): Promise<AdminClient | null> => {
  const { unauthenticated } = await import("../shopify.server");
  const { admin } = await unauthenticated.admin(shop);
  return admin;
};

/** One iteration of the refund loop (3.4): reconciliation FIRST — it is
 *  read-only toward Shopify, runs regardless of every switch (4.8, 12),
 *  and clears in-flight rows before capacity is considered — then, only
 *  when MERGESHIP_SHIPPING_REFUNDS=enabled, the admission scan (its own
 *  per-shop gate rechecks every DB control) and the dispatch cycle. Each
 *  phase is inside its own error boundary (3.3): a failure in one cannot
 *  stop the others and nothing propagates to the loop. The PREPARED
 *  horizon sweep is deliberately NOT called (7.6.1: explicit invocation
 *  only). */
export async function runShippingRefundLoopOnce(
  deps: ShippingRefundLoopDeps = {},
): Promise<void> {
  const db = deps.db ?? defaultDb;
  const log = deps.log ?? console.error;
  const adminFactory = deps.adminFactory ?? loopAdminFactory;

  try {
    const shops = await db.$queryRaw<{ shop: string }[]>`
      SELECT DISTINCT "shop" FROM "ShippingRefund"
      WHERE "status" IN (${POST_DISPATCH_ENTRY_STATUS},'IN_DOUBT','REFUND_RECORDED')`;
    if (shops.length > 0) {
      await runShippingRefundReconcileCycle(
        shops.map((r) => r.shop),
        { adminFactory, log },
        db,
      );
    }
  } catch (e) {
    log(`[shipping-refund] reconcile cycle failed: ${String(e).slice(0, 200)}`);
  }

  if (!shippingRefundsDispatchEnabled()) return;

  try {
    const optedIn = await db.$queryRaw<{ shop: string }[]>`
      SELECT "shop" FROM "Settings" WHERE "shippingAdjustmentEnabled" = true`;
    if (optedIn.length > 0) {
      await runShippingRefundAdmissionScan(
        optedIn.map((r) => r.shop),
        { adminFactory, log },
        db,
      );
    }
  } catch (e) {
    log(`[shipping-refund] admission cycle failed: ${String(e).slice(0, 200)}`);
  }

  try {
    await runShippingRefundDispatchCycle({ adminFactory, log, db });
  } catch (e) {
    log(`[shipping-refund] dispatch cycle failed: ${String(e).slice(0, 200)}`);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __mergeshipShippingRefundWorkerStarted: boolean | undefined;
}

/** Starts the refund loop once per process (3.1: own module and timer,
 *  never inside runSweepOnce). Disabled by default: with
 *  MERGESHIP_SHIPPING_REFUNDS unset the loop performs no admission and no
 *  dispatch — only the read-only reconciliation phase runs, and only for
 *  rows that already carry dispatch evidence. No-op under tests and when
 *  DISABLE_BACKGROUND_WORKER=true (e.g. one-off deploy/debug shells). */
export function startShippingRefundWorker(): void {
  if (globalThis.__mergeshipShippingRefundWorkerStarted) return;
  globalThis.__mergeshipShippingRefundWorkerStarted = true;
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
      await runShippingRefundLoopOnce();
    } catch (err) {
      console.error(
        `[shipping-refund] loop failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      running = false;
      schedule();
    }
  };

  const schedule = () => {
    if (stopping) return;
    const delay = SHIPPING_REFUND_LOOP_INTERVAL_MS * (0.75 + Math.random() * 0.5);
    // Unref'd: the loop must never keep the process alive on its own.
    setTimeout(() => void tick(), delay).unref();
  };

  // Stop scheduling on shutdown; in-flight work is left to its leases.
  process.once("SIGTERM", () => (stopping = true));
  process.once("SIGINT", () => (stopping = true));
  schedule();
}
