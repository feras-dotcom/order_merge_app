// S2 operational worker (sections 9, 3.4, 19.5): drives due PREPARED rows
// through the capacity precheck, the §8.4 R2 pre-dispatch recheck (frozen
// integrity, merge evidence, the §8.2.5 baseline, the R1 evaluator and the
// rebuilt-vs-frozen contract parity), T3, the single send and T4 —
// in-process, behind MERGESHIP_SHIPPING_REFUNDS=enabled only, never
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
import { dryRunSessionUsable, evaluateShadowSource, readOnlyAdmin } from "./shipping-shadow.server";
import { reassessMergeEvidence, runShippingRefundAdmissionScan } from "./shipping-refund-admission.server";
import { adaptReadyToFreezeContract, compareRebuiltToFrozen } from "./shipping-refund-freeze-contract";
import {
  computeWireHash,
  REFUND_DOCUMENT_SHA256,
  REFUND_MUTATION_VERSION,
  type ShippingRefundWireVariables,
} from "./shipping-refund-contract";
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
      const tot = parseShopMoney(
        (n.totalRefundedSet as { presentmentMoney?: unknown } | null)?.presentmentMoney,
      );
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

/** The one R2 row read (8.4): every frozen column the pre-dispatch recheck
 *  needs, loaded once after the capacity precheck. */
interface PreparedFrozenRow {
  readonly id: string;
  readonly shop: string;
  readonly status: string;
  readonly mergeOperationId: string;
  readonly sourceOrderId: string;
  readonly primaryOrderId: string;
  readonly primaryOrderName: string;
  readonly marker: string;
  readonly idempotencyKey: string;
  readonly lane: string;
  readonly policyKind: string;
  readonly wireVariables: unknown;
  readonly wireHash: string | null;
  readonly documentSha256: string | null;
  readonly mutationVersion: string | null;
  readonly currencyCode: string | null;
  readonly plannedShippingMinor: string | null;
  readonly parentTransactionId: string | null;
  readonly gateway: string | null;
  readonly preEvidence: unknown;
}

const PREPARED_FROZEN_SQL = `
  SELECT "id", "shop", "status", "mergeOperationId", "sourceOrderId",
         "primaryOrderId", "primaryOrderName", "marker", "idempotencyKey",
         "lane", "policyKind", "wireVariables", "wireHash", "documentSha256",
         "mutationVersion", "currencyCode", "plannedShippingMinor",
         "parentTransactionId", "gateway", "preEvidence"
  FROM "ShippingRefund"`;

/**
 * The R2 frozen-integrity check (8.4): proves the row's frozen columns
 * still describe this build's contract — the same tests T3 repeats at the
 * gate (9.2.3) plus the key/policy identity the freeze bound. Pure, no
 * I/O: it runs before any Shopify read is spent and never writes. Exported
 * narrowly so the cases the database CHECKs make physically uninsertable
 * (a wire key differing from the row key, a non-REFUND_ALL policyKind) can
 * still be driven through it in tests.
 */
export function checkFrozenWireIntegrity(row: {
  readonly documentSha256: string | null;
  readonly mutationVersion: string | null;
  readonly wireHash: string | null;
  readonly wireVariables: unknown;
  readonly idempotencyKey: string;
  readonly policyKind: string;
}):
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: string; readonly detail: string } {
  if (row.documentSha256 !== REFUND_DOCUMENT_SHA256) {
    return {
      ok: false,
      reasonCode: "DOCUMENT_CHANGED",
      detail: `documentSha256 ${row.documentSha256} != this build's pin`,
    };
  }
  if (row.mutationVersion !== REFUND_MUTATION_VERSION) {
    return {
      ok: false,
      reasonCode: "DOCUMENT_CHANGED",
      detail: `mutationVersion ${JSON.stringify(row.mutationVersion)} != this build's contract version`,
    };
  }
  let recomputed: string;
  try {
    recomputed = computeWireHash(
      REFUND_DOCUMENT_SHA256,
      row.wireVariables as ShippingRefundWireVariables,
    );
  } catch (e) {
    return {
      ok: false,
      reasonCode: "WIRE_HASH_MISMATCH",
      detail: `wireVariables invalid: ${(e as Error).message}`,
    };
  }
  if (recomputed !== row.wireHash) {
    return {
      ok: false,
      reasonCode: "WIRE_HASH_MISMATCH",
      detail: "recomputed wireHash != stored wireHash",
    };
  }
  const wireKey = (row.wireVariables as { idempotencyKey?: unknown } | null)?.idempotencyKey;
  if (wireKey !== row.idempotencyKey) {
    return {
      ok: false,
      reasonCode: "WIRE_HASH_MISMATCH",
      detail: "wireVariables.idempotencyKey differs from the row idempotencyKey",
    };
  }
  if (row.policyKind !== "REFUND_ALL") {
    return {
      ok: false,
      reasonCode: "POLICY_CHANGED",
      detail: `policyKind is ${row.policyKind}`,
    };
  }
  return { ok: true };
}

/** One leased PREPARED row: precheck → R2 → T3 → send → T4. Every write is
 *  the helper's own; a thrown OwnershipLostError ends work on this row
 *  without writing. Returns a tag for the report.
 *
 *  R2 (8.4) re-proves everything the freeze relied on, in this order:
 *  frozen-contract integrity and the merge-evidence re-assessment (both
 *  database-only, so a contradiction never spends a Shopify read), then
 *  the §8.2.5 baseline recheck — which deliberately precedes the evaluator
 *  so a new or own-marker refund classifies specifically — then the R1
 *  evaluator, and finally the rebuilt contract, which must equal the
 *  frozen request exactly or the row aborts DRIFT_BEFORE_DISPATCH. The
 *  rebuilt value is only compared — never stored, never sent. */
async function processPreparedRow(
  rowId: string,
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

  // 2. R2 (8.4): the frozen row, in one SELECT. A row that left PREPARED
  //    under the lease needs no write — report and stop.
  const [row] = await db.$queryRawUnsafe<PreparedFrozenRow[]>(
    `${PREPARED_FROZEN_SQL} WHERE "id" = $1`,
    rowId,
  );
  if (!row || row.status !== "PREPARED") return "NOT_PREPARED";

  // 2a. Frozen integrity — before any Shopify read is spent.
  const integrity = checkFrozenWireIntegrity(row);
  if (!integrity.ok) {
    await writePreparedR2Outcome(rowId, leaseToken, { toStatus: "ABORTED", reasonCode: integrity.reasonCode, reviewReason: integrity.detail }, db);
    return `ABORTED:${integrity.reasonCode}`;
  }

  // 2b. Merge evidence re-assessment (7.4/8.4): the same R1 machinery —
  //     a contradiction parks the row before any Shopify call is spent.
  const mergeEvidence = await reassessMergeEvidence(
    { shop: row.shop, mergeOperationId: row.mergeOperationId, sourceOrderId: row.sourceOrderId, primaryOrderId: row.primaryOrderId },
    db,
  );
  if (!mergeEvidence.ok) {
    await writePreparedR2Outcome(rowId, leaseToken, { toStatus: "REVIEW_REQUIRED", reasonCode: "MERGE_EVIDENCE_CONTRADICTION", reviewReason: mergeEvidence.reviewReason }, db);
    return "REVIEW_REQUIRED:MERGE_EVIDENCE_CONTRADICTION";
  }

  // 2c. §8.2.5 baseline recheck: fresh read-only evidence vs the frozen
  //     baseline. Read failures are transient waits; drift is abort/review.
  const ro = readOnlyAdmin(admin);
  let recheckBody: unknown;
  try {
    recheckBody = await readBody(ro, Q_RECHECK.document, {
      source: row.sourceOrderId,
      primary: row.primaryOrderId,
    });
  } catch (e) {
    await releaseLeaseWithBackoff(rowId, leaseToken, undefined, db);
    return `WAIT:RECHECK_TRANSPORT`;
  }
  const analysis = analyzeExecRecheck(recheckBody, { sourceOrderId: row.sourceOrderId, primaryOrderId: row.primaryOrderId });
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
      fresh = await freshBaselineRead(ro, row.sourceOrderId, evidence.refundIds);
    } catch {
      fresh = null;
    }
  }
  if (fresh === null) {
    await releaseLeaseWithBackoff(rowId, leaseToken, undefined, db);
    return "WAIT:DETAIL_READ_INCOMPLETE";
  }

  const stored = (row.preEvidence as { baseline?: RefundBaseline } | null)?.baseline;
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

  // 2d. The R1 evaluator over fresh evidence (8.4). The lease is renewed
  //     between Shopify reads (9.1); a transport/top-level failure is a
  //     transient wait — never an abort and never an attempt consumed.
  await renewPreparedShippingRefundLease(rowId, leaseToken, db);
  let evalOutcome: Awaited<ReturnType<typeof evaluateShadowSource>>;
  try {
    evalOutcome = await evaluateShadowSource(ro, {
      sourceOrderId: row.sourceOrderId,
      policy: { kind: "REFUND_ALL" },
      marker: row.marker,
      primaryOrderName: row.primaryOrderName,
    });
  } catch {
    await releaseLeaseWithBackoff(rowId, leaseToken, undefined, db);
    return "WAIT:EVALUATOR_TRANSPORT";
  }
  if (evalOutcome.kind === "SKIP") {
    await writePreparedR2Outcome(rowId, leaseToken, { toStatus: "ABORTED", reasonCode: evalOutcome.reasonCode, reviewReason: evalOutcome.reason.slice(0, 2000) }, db);
    return `ABORTED:${evalOutcome.reasonCode}`;
  }
  if (evalOutcome.kind === "REVIEW") {
    await writePreparedR2Outcome(rowId, leaseToken, { toStatus: "ABORTED", reasonCode: "EVALUATOR_REVIEW", reviewReason: evalOutcome.reason.slice(0, 2000) }, db);
    return "ABORTED:EVALUATOR_REVIEW";
  }

  // 2e. Rebuild the contract the fresh evidence would freeze today and
  //     require it to equal the frozen request byte for byte — the §8.4
  //     parity gate. The rebuilt value is only compared: nothing writes
  //     it, and T3 still sends the database-frozen variables.
  const rebuilt = adaptReadyToFreezeContract(evalOutcome, {
    sourceOrderId: row.sourceOrderId,
    parentTransactionId: evidence.capture.id,
    gateway: evidence.capture.gateway,
    currencyCode: evidence.currencyCode,
    marker: row.marker,
    idempotencyKey: row.idempotencyKey,
    primaryOrderName: row.primaryOrderName,
    plannedShippingMinor: evalOutcome.plannedRefundMinor,
  });
  if (!rebuilt.ok) {
    await writePreparedR2Outcome(rowId, leaseToken, { toStatus: "ABORTED", reasonCode: "DRIFT_BEFORE_DISPATCH", reviewReason: rebuilt.reason.slice(0, 2000) }, db);
    return "ABORTED:DRIFT_BEFORE_DISPATCH";
  }
  const same = compareRebuiltToFrozen(rebuilt, row);
  if (!same.equal) {
    await writePreparedR2Outcome(rowId, leaseToken, { toStatus: "ABORTED", reasonCode: "DRIFT_BEFORE_DISPATCH", reviewReason: `${same.field}: ${same.detail}`.slice(0, 2000) }, db);
    return "ABORTED:DRIFT_BEFORE_DISPATCH";
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
        const tag = await processPreparedRow(row.id, admin, { ...deps, db });
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
