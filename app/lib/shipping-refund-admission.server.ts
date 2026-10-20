// ── Shipping v0 Phase 2, S1-E: the admission scanner and evaluation loop ──
// docs/SHIPPING-PHASE2-DESIGN.md Revision 3.3, sections 7.2–7.6.1 and 8.
//
// One coherent, non-dispatchable S1 workflow per shop per scan:
//   1. the canonical trigger-integrity check (3.2 rule 11);
//   2. the shop-level gate evaluated on an advisory read (the claim and the
//      freeze re-read everything under the §4.10 locks — E4 here only
//      decides whether a scan is worth attempting);
//   3. Part A: due QUEUED rows — lease, re-evaluate, settle;
//   4. Part B: the bounded §7.2 selection — validate (7.2.1), merge-evidence
//      assessment, the 15-minute settle delay (E6), the seven-day stale rule
//      (E7), the §7.5 claim, then immediate evaluation and settlement;
//   5. the malformed-operations report (7.2.2).
//
// Evaluation is the accepted read-only evaluator over INJECTED Shopify
// evidence (a caller-supplied AdminClient; this module never builds a
// session or a real client itself) plus the §8.2 execution recheck under
// STRICT_EMPTY, then the §8.3 atomic freeze — QUEUED -> PREPARED (EXECUTE)
// or QUEUED -> OBSERVED (OBSERVE). Nothing here writes a dispatch-path
// status, calls a financial mutation or runs a worker loop.

import { type PrismaClient } from "@prisma/client";
import defaultDb from "../db.server";
import type { AdminClient } from "./graphql.server";
import { isTransientDbError, OwnershipLostError } from "./ownership.server";
import { assessSecondaryEvidence } from "./shipping-eligibility";
import {
  computeShippingGate,
  validateOperationForClaim,
  type ShippingGateLiveState,
} from "./shipping-refund-gate";
import {
  dryRunSessionUsable,
  evaluateShadowSource,
  readOnlyAdmin,
  type ShadowOutcome,
} from "./shipping-shadow.server";
import {
  adaptReadyToFreezeContract,
  type FreezeBindings,
} from "./shipping-refund-freeze-contract";
import {
  admitBaseline,
  analyzeExecRecheck,
  buildPriorRefundDiagnostic,
  buildPreEvidence,
  buildRefundBaseline,
  classifyRefundRecord,
  compareRecheckReads,
  type RefundRecordClass,
} from "./shipping-refund-baseline";
import {
  DETAIL_IDS_PER_REQUEST,
  DETAIL_REQUESTS_PER_EVALUATION,
  Q_RECHECK,
  Q_REFUND_DETAIL,
  validateDetailRequestBudget,
  validateDetailRequestIds,
  validateRefundDetailResponse,
} from "./shipping-refund-queries";
import {
  claimShippingRefund,
  claimTerminalShippingRefund,
  findMalformedOperations,
  freezeShippingRefund,
  leaseQueuedShippingRefund,
  listDueQueuedShippingRefunds,
  listMergeAttemptsForOperations,
  listMergeRecordsForSecondaries,
  listShippingRefundsForSources,
  loadScanOperation,
  readAdvisoryGateState,
  recordEvaluationFailure,
  renewQueuedShippingRefundLease,
  selectScanOperations,
  settleQueuedShippingRefund,
  SHIPPING_REFUND_DUE_ROW_LIMIT,
  SHIPPING_REFUND_SCAN_PAGE_SIZE,
  type DueQueuedRow,
  type ScanOperationRow,
} from "./shipping-refund-store.server";

// ── Bounds (7.2, 7.2.2, 7.3, 8.2) ──────────────────────────────────────────

export const SCAN_MAX_PAGES_PER_SHOP = 4;
export const SCAN_SECONDARIES_PER_OPERATION = 25;
export const SCAN_EVALUATIONS_PER_SHOP = 25;
export const SCAN_ERRORS_PER_SHOP = 25;
export const SETTLE_DELAY_MS = 15 * 60 * 1000;
export const STALE_COMBINE_MS = 7 * 24 * 60 * 60 * 1000;

const ORDER_GID_RE = /^gid:\/\/shopify\/Order\/[0-9]+$/;
const REFUND_GID_RE = /^gid:\/\/shopify\/Refund\/[0-9]+$/;

// ── Report shape ──────────────────────────────────────────────────────────

export type SecondaryErrorClass = "DATA" | "TRANSIENT" | "UNKNOWN";

export interface SecondaryError {
  readonly shop: string;
  readonly operationId: string;
  readonly secondaryId: string;
  readonly errorClass: SecondaryErrorClass;
  readonly sqlstate: string | null;
  readonly message: string;
}

export interface ShopScanReport {
  readonly shop: string;
  /** Set when the scan ended before finishing: a gate-close mid-scan, a
   *  trigger-integrity refusal, an exhausted error budget or a saturated
   *  scan window. */
  readonly stoppedBy: string | null;
  readonly gateOpen: boolean;
  readonly admissionCutoffAt: Date | null;
  /** Part A: due QUEUED rows attempted and their settle outcomes. */
  readonly dueRowsExamined: number;
  /** Part B: fresh claims and their outcomes. */
  readonly claimed: number;
  readonly terminalClaims: number;
  readonly deferredSettleDelay: number;
  readonly outcomes: Record<string, number>;
  readonly evaluations: number;
  readonly secondaryErrors: SecondaryError[];
  readonly quarantined: readonly { operationId: string; secondaryId: string }[];
  readonly malformed: readonly {
    operationId: string;
    secondaryIndex: number | null;
    defect: string;
  }[];
}

/** The mutable in-scan view of a ShopScanReport. */
interface ShopReportMutable {
  shop: string;
  stoppedBy: string | null;
  gateOpen: boolean;
  admissionCutoffAt: Date | null;
  dueRowsExamined: number;
  claimed: number;
  terminalClaims: number;
  deferredSettleDelay: number;
  outcomes: Record<string, number>;
  evaluations: number;
  secondaryErrors: SecondaryError[];
  quarantined: { operationId: string; secondaryId: string }[];
  malformed: { operationId: string; secondaryIndex: number | null; defect: string }[];
}

export interface ShippingRefundScanDeps {
  /** Returns the (offline) AdminClient for the shop, or null when no usable
   *  session exists. Tests inject the read-only fake; production wiring is
   *  a separate S1 surface that never runs in this milestone. */
  readonly adminFactory: (shop: string) => Promise<AdminClient | null>;
  /** The offline session record {expires} — the same row the library's
   *  session storage loads (offline_<shop>). Defaults to the Session table. */
  readonly sessionLoader?: (shop: string) => Promise<{ expires: Date | null } | null>;
  readonly log?: (line: string) => void;
}

const defaultSessionLoader = (db: PrismaClient) => async (shop: string) =>
  db.session.findUnique({ where: { id: `offline_${shop}` } });

const bump = (outcomes: Record<string, number>, key: string) => {
  outcomes[key] = (outcomes[key] ?? 0) + 1;
};

// ── Error classification (7.2.2) ──────────────────────────────────────────

const sqlstateOf = (err: unknown): string | null => {
  const e = err as { meta?: { code?: unknown }; code?: unknown };
  const c = e?.meta?.code ?? e?.code;
  return typeof c === "string" ? c : null;
};

/** SQLSTATE class 22 (data exception) or 23 (integrity violation) is DATA;
 *  the transient set of ownership.server is TRANSIENT; everything else is
 *  UNKNOWN (7.2.2). */
export function classifySecondaryError(err: unknown): SecondaryErrorClass {
  const sqlstate = sqlstateOf(err);
  if (sqlstate !== null && /^2[23]/.test(sqlstate)) return "DATA";
  if (isTransientDbError(err)) return "TRANSIENT";
  return "UNKNOWN";
}

// ── Helpers ───────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** The JSON secondary elements that pass the SQL guards: object with a
 *  string id matching the order-GID pattern and differing from the primary. */
const candidateSecondaryElements = (op: ScanOperationRow): Record<string, unknown>[] => {
  if (!Array.isArray(op.secondaries)) return [];
  return op.secondaries.filter(
    (s): s is Record<string, unknown> =>
      isObject(s) &&
      typeof s.id === "string" &&
      ORDER_GID_RE.test(s.id) &&
      s.id !== op.primaryOrderId,
  );
};

const readShopifyBody = async (
  admin: AdminClient,
  document: string,
  variables: Record<string, unknown>,
): Promise<unknown> => {
  const res = await admin.graphql(document, { variables });
  return (await res.json()) as unknown;
};

// ── One evaluation + settlement for a leased QUEUED row ────────────────────

interface QueuedRowContext {
  readonly id: string;
  readonly shop: string;
  readonly mergeOperationId: string;
  readonly sourceOrderId: string;
  readonly primaryOrderId: string;
  readonly primaryOrderName: string;
  readonly lane: string;
  readonly marker: string;
  readonly idempotencyKey: string;
}

type RowOutcome = string;

/**
 * The §7.3/§8 pipeline for one QUEUED row held under `leaseToken`: merge
 * evidence re-assessment, the session guard immediately before any Shopify
 * call, the read-only evaluator, the §8.2 execution recheck under
 * STRICT_EMPTY (with the bounded prior-refund diagnostic), the consistency
 * second read, contract adaptation and the §8.3 freeze.
 *
 * Fail-closed outcomes: transient evidence failures reschedule through
 * `recordEvaluationFailure` (attempts budget 8); deterministic failures
 * settle INELIGIBLE / SKIPPED / REVIEW_REQUIRED; a lost lease, a gate that
 * changed mid-evaluation or an expired horizon abort without any freeze.
 *
 * Errors that are not part of the outcome vocabulary (database failures,
 * programming bugs) propagate to the caller's secondary boundary.
 */
async function evaluateAndSettleQueuedRow(
  row: QueuedRowContext,
  leaseToken: string,
  deps: ShippingRefundScanDeps & { sessionLoader: NonNullable<ShippingRefundScanDeps["sessionLoader"]> },
  db: PrismaClient,
  dbWall: Date,
): Promise<RowOutcome> {
  // ── Merge evidence re-assessment (7.4: at claim and at R1) ──
  const op = await loadScanOperation(row.shop, row.mergeOperationId, db);
  const secondary =
    op === null ? undefined : candidateSecondaryElements(op).find((s) => s.id === row.sourceOrderId);
  if (op === null || secondary === undefined) {
    await settleQueuedShippingRefund(
      row.id,
      leaseToken,
      {
        status: "REVIEW_REQUIRED",
        reasonCode: "MERGE_EVIDENCE_CONTRADICTION",
        reviewReason: op === null
          ? "the merge operation is no longer readable"
          : "the secondary is no longer present in the operation",
      },
      db,
    );
    return "REVIEW_REQUIRED";
  }
  const [records, attempts] = await Promise.all([
    listMergeRecordsForSecondaries(row.shop, [row.sourceOrderId], db),
    listMergeAttemptsForOperations([op.id], db),
  ]);
  const assessment = assessSecondaryEvidence({
    operation: {
      id: op.id,
      protocolVersion: op.protocolVersion,
      phase: op.phase,
      calculatedOrderId: op.calculatedOrderId,
      opToken: op.opToken,
      primaryOrderId: op.primaryOrderId,
      expectedTransfer: op.expectedTransfer,
      appliedEvidence: op.appliedEvidence,
    },
    secondary: secondary as { id: string; cancelPhase?: string; done?: boolean; cancelledAt?: string | null; staffNoteMatched?: boolean },
    mergeRecords: records,
    attempts,
  });
  if (!assessment.eligible) {
    await settleQueuedShippingRefund(
      row.id,
      leaseToken,
      {
        status: "REVIEW_REQUIRED",
        reasonCode: "MERGE_EVIDENCE_CONTRADICTION",
        reviewReason: assessment.issues.join(" | ").slice(0, 2000),
      },
      db,
    );
    return "REVIEW_REQUIRED";
  }

  // ── Session guard immediately before any Shopify call (3.4/N12) ──
  // A session-lookup failure or an unavailable admin is a transient
  // evaluation failure for an already-claimed row: reschedule through the
  // attempts budget (7.4), never a boundary error.
  let admin: AdminClient | null = null;
  try {
    const session = await deps.sessionLoader(row.shop);
    if (!dryRunSessionUsable(session)) {
      await recordEvaluationFailure(row.id, leaseToken, db);
      return "RETRY_SESSION_UNUSABLE";
    }
    admin = await deps.adminFactory(row.shop);
  } catch {
    await recordEvaluationFailure(row.id, leaseToken, db);
    return "RETRY_SESSION_LOOKUP_FAILED";
  }
  if (admin === null) {
    await recordEvaluationFailure(row.id, leaseToken, db);
    return "RETRY_ADMIN_UNAVAILABLE";
  }
  const ro = readOnlyAdmin(admin);

  // ── R1: the accepted evaluator (8.1) ──
  let outcome: ShadowOutcome;
  try {
    outcome = await evaluateShadowSource(ro, {
      sourceOrderId: row.sourceOrderId,
      policy: { kind: "REFUND_ALL" },
      marker: row.marker,
      primaryOrderName: row.primaryOrderName,
    });
  } catch {
    // Transport/top-level failure: bounded retry (7.4).
    await recordEvaluationFailure(row.id, leaseToken, db);
    return "RETRY_EVALUATION_FAILED";
  }

  if (outcome.kind === "SKIP") {
    await settleQueuedShippingRefund(
      row.id,
      leaseToken,
      { status: "SKIPPED", reasonCode: outcome.reasonCode, reviewReason: outcome.reason },
      db,
    );
    return `SKIPPED:${outcome.reasonCode}`;
  }
  if (outcome.kind === "REVIEW") {
    await settleQueuedShippingRefund(
      row.id,
      leaseToken,
      { status: "INELIGIBLE", reasonCode: "EVALUATOR_REVIEW", reviewReason: outcome.reason },
      db,
    );
    return "INELIGIBLE:EVALUATOR_REVIEW";
  }

  // ── §8.2 execution recheck (a second read-only document) ──
  // The lease is renewed between Shopify reads (9.1).
  try {
    await renewQueuedShippingRefundLease(row.id, leaseToken, db);
  } catch (err) {
    if (err instanceof OwnershipLostError) return "OWNERSHIP_LOST";
    throw err;
  }
  let recheckBody: unknown;
  try {
    recheckBody = await readShopifyBody(ro, Q_RECHECK.document, {
      source: row.sourceOrderId,
      primary: row.primaryOrderId,
    });
  } catch {
    await recordEvaluationFailure(row.id, leaseToken, db);
    return "RETRY_RECHECK_FAILED";
  }
  const analysis = analyzeExecRecheck(recheckBody, {
    sourceOrderId: row.sourceOrderId,
    primaryOrderId: row.primaryOrderId,
  });
  if (!analysis.ok) {
    await settleQueuedShippingRefund(
      row.id,
      leaseToken,
      { status: "INELIGIBLE", reasonCode: analysis.reasonCode, reviewReason: analysis.reason },
      db,
    );
    return `INELIGIBLE:${analysis.reasonCode}`;
  }
  const evidence = analysis.evidence;

  // STRICT_EMPTY: any refund record at all is INELIGIBLE(PRIOR_REFUND_RECORD)
  // — with a bounded best-effort diagnostic (refund ids + classes, ≤4 KiB).
  if (evidence.refundIds.length > 0) {
    const diagnostic = await priorRefundDiagnostic(
      ro,
      evidence.refundIds,
      evidence.currencyCode,
      row.sourceOrderId,
    );
    await settleQueuedShippingRefund(
      row.id,
      leaseToken,
      { status: "INELIGIBLE", reasonCode: "PRIOR_REFUND_RECORD", reviewReason: diagnostic },
      db,
    );
    return "INELIGIBLE:PRIOR_REFUND_RECORD";
  }

  // The baseline (empty under STRICT_EMPTY) and its admission rule (8.2.2/3).
  const [wallRow] = await db.$queryRaw<{ wall: Date }[]>`
    SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "wall"`;
  const baseline = buildRefundBaseline({
    capturedAt: wallRow.wall.toISOString(),
    currency: evidence.currencyCode,
    evidence,
  });
  const admission = admitBaseline(baseline);
  if (!admission.ok) {
    await settleQueuedShippingRefund(
      row.id,
      leaseToken,
      { status: "INELIGIBLE", reasonCode: admission.reasonCode, reviewReason: admission.reason },
      db,
    );
    return `INELIGIBLE:${admission.reasonCode}`;
  }

  // Consistency: the recheck is read once more and must agree exactly —
  // a difference is a transient retry (BASELINE_UNVERIFIED after the
  // attempt budget), never a freeze (8.2.2).
  let secondBody: unknown;
  try {
    secondBody = await readShopifyBody(ro, Q_RECHECK.document, {
      source: row.sourceOrderId,
      primary: row.primaryOrderId,
    });
  } catch {
    await recordEvaluationFailure(row.id, leaseToken, db, "BASELINE_UNVERIFIED");
    return "RETRY_RECHECK_FAILED";
  }
  const second = analyzeExecRecheck(secondBody, {
    sourceOrderId: row.sourceOrderId,
    primaryOrderId: row.primaryOrderId,
  });
  if (!second.ok || !compareRecheckReads(evidence, second.evidence)) {
    await recordEvaluationFailure(row.id, leaseToken, db, "BASELINE_UNVERIFIED");
    return "RETRY_BASELINE_UNVERIFIED";
  }

  // ── Contract adaptation (8.3 preface) ──
  const bindings: FreezeBindings = {
    sourceOrderId: row.sourceOrderId,
    parentTransactionId: evidence.capture.id,
    gateway: evidence.capture.gateway,
    currencyCode: evidence.currencyCode,
    marker: row.marker,
    idempotencyKey: row.idempotencyKey,
    primaryOrderName: row.primaryOrderName,
    plannedShippingMinor: outcome.plannedRefundMinor,
  };
  const adapted = adaptReadyToFreezeContract(outcome, bindings);
  if (!adapted.ok) {
    await settleQueuedShippingRefund(
      row.id,
      leaseToken,
      { status: "INELIGIBLE", reasonCode: "UNSUPPORTED_EVIDENCE", reviewReason: adapted.reason },
      db,
    );
    return "INELIGIBLE:UNSUPPORTED_EVIDENCE";
  }

  // ── §8.3 atomic freeze ──
  const frozen = await freezeShippingRefund(
    row.id,
    leaseToken,
    {
      contract: adapted.contract,
      financialColumns: adapted.financialColumns,
      preEvidence: buildPreEvidence({ evidence, baseline: admission.baseline }),
    },
    db,
  );
  if (frozen.frozen) return `FROZEN:${frozen.status}`;
  return `ABORTED:${frozen.reason}`;
}

/** The §8.2.3 best-effort diagnostic for a PRIOR_REFUND_RECORD row: at most
 *  DETAIL_REQUESTS_PER_EVALUATION × DETAIL_IDS_PER_REQUEST refund records are
 *  classified; a failing or incomplete detail read reports the ids as
 *  UNCLASSIFIABLE. No note text, no customer data (bounded to 4 KiB). */
async function priorRefundDiagnostic(
  admin: AdminClient,
  refundIds: readonly string[],
  currency: string,
  sourceOrderId: string,
): Promise<string> {
  const entries: { id: string; class: RefundRecordClass }[] = [];
  const covered = refundIds.slice(0, DETAIL_IDS_PER_REQUEST * DETAIL_REQUESTS_PER_EVALUATION);
  try {
    for (let r = 0; r < covered.length; r += DETAIL_IDS_PER_REQUEST) {
      const ids = covered.slice(r, r + DETAIL_IDS_PER_REQUEST).filter((id) => REFUND_GID_RE.test(id));
      const req = Math.floor(r / DETAIL_IDS_PER_REQUEST) + 1;
      if (
        !validateDetailRequestBudget(req).ok ||
        !validateDetailRequestIds(ids).ok ||
        ids.length === 0
      ) {
        break;
      }
      const body = await readShopifyBody(admin, Q_REFUND_DETAIL.document, { ids });
      const valid = validateRefundDetailResponse(body, ids, { sourceOrderId });
      if (!valid.ok) {
        for (const id of ids) entries.push({ id, class: "UNCLASSIFIABLE" });
        continue;
      }
      const nodes = ((body as { data: { nodes: unknown[] } }).data.nodes ?? []) as unknown[];
      for (const node of nodes) {
        const id = isObject(node) && typeof node.id === "string" ? node.id : "?";
        entries.push({ id, class: classifyRefundRecord(node, currency) });
      }
    }
    for (const id of refundIds.slice(covered.length)) {
      entries.push({ id, class: "UNCLASSIFIABLE" });
    }
  } catch {
    return buildPriorRefundDiagnostic(
      refundIds.map((id) => ({ id, class: "UNCLASSIFIABLE" as const })),
    );
  }
  return buildPriorRefundDiagnostic(entries);
}

// ── The per-shop scan (7.3) ────────────────────────────────────────────────

/**
 * One admission scan over the given shops, in order — every secondary and
 * every shop inside its own error boundary (7.2.2). Returns the per-shop
 * report the caller logs and persists; the function itself never throws
 * for a secondary or shop failure.
 */
export async function runShippingRefundAdmissionScan(
  shops: readonly string[],
  deps: ShippingRefundScanDeps,
  db: PrismaClient = defaultDb,
): Promise<ShopScanReport[]> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const fullDeps = { ...deps, sessionLoader: deps.sessionLoader ?? defaultSessionLoader(db) };
  const reports: ShopScanReport[] = [];

  for (const shop of shops) {
    const outcomes: Record<string, number> = {};
    const secondaryErrors: SecondaryError[] = [];
    const quarantined = new Map<string, { operationId: string; secondaryId: string }>();
    const malformed: { operationId: string; secondaryIndex: number | null; defect: string }[] = [];
    const report: ShopReportMutable = {
      shop,
      stoppedBy: null,
      gateOpen: false,
      admissionCutoffAt: null,
      dueRowsExamined: 0,
      claimed: 0,
      terminalClaims: 0,
      deferredSettleDelay: 0,
      outcomes,
      evaluations: 0,
      secondaryErrors,
      quarantined: [],
      malformed,
    };
    reports.push(report);

    try {
      const live: ShippingGateLiveState = await readAdvisoryGateState(shop, db);
      const gate = computeShippingGate(live);
      if (!gate.open) {
        log(`[shipping-refund] shop-gate-closed shop=${shop} code=${gate.code}`);
        report.stoppedBy = `gate:${gate.code}`;
        continue;
      }
      report.gateOpen = true;
      report.admissionCutoffAt = gate.admissionCutoffAt;

      const [wallRow] = await db.$queryRaw<{ wall: Date }[]>`
        SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "wall"`;
      const dbWall = wallRow.wall;

      const errorBoundary = async (
        operationId: string,
        secondaryId: string,
        work: () => Promise<void>,
      ): Promise<void> => {
        const key = `${operationId}::${secondaryId}`;
        if (quarantined.has(key)) return;
        try {
          await work();
        } catch (err) {
          const cls = classifySecondaryError(err);
          secondaryErrors.push({
            shop,
            operationId,
            secondaryId,
            errorClass: cls,
            sqlstate: sqlstateOf(err),
            message: err instanceof Error ? err.message : String(err),
          });
          log(
            `[shipping-refund] secondary-error shop=${shop} op=${operationId} ` +
              `secondary=${secondaryId} class=${cls} sqlstate=${sqlstateOf(err) ?? "none"}`,
          );
          malformed.push({ operationId, secondaryIndex: null, defect: "secondary-error" });
          if (cls === "DATA") {
            // Park durably: claimTerminal(REVIEW_REQUIRED, DATA_INVALID) in a
            // fresh minimal transaction (7.2.2). A failed park quarantines the
            // secondary for this scan and is reported.
            const opObj = await loadScanOperation(shop, operationId, db).catch(() => null);
            let parked = false;
            if (opObj !== null) {
              const sEl = candidateSecondaryElements(opObj).find((x) => x.id === secondaryId);
              if (sEl !== undefined) {
                const parkedClaim = await claimTerminalShippingRefund(
                  { operation: opObj, secondary: sEl },
                  { status: "REVIEW_REQUIRED", reasonCode: "DATA_INVALID" },
                  db,
                  log,
                ).catch(() => null);
                parked = parkedClaim?.claimed === true;
                if (parked) {
                  bump(outcomes, "PARKED:DATA_INVALID");
                  report.terminalClaims += 1;
                }
              }
            }
            if (!parked) {
              quarantined.set(key, { operationId, secondaryId });
              malformed.push({ operationId, secondaryIndex: null, defect: "claim-rejected" });
            }
          } else {
            quarantined.set(key, { operationId, secondaryId });
          }
          if (secondaryErrors.length >= SCAN_ERRORS_PER_SHOP) {
            report.stoppedBy = "error-budget";
            log(
              `[shipping-refund] shop-error-budget-exhausted shop=${shop} errors=${secondaryErrors.length}`,
            );
          }
        }
      };

      const settleRow = async (queued: QueuedRowContext, leaseToken: string) => {
        const outcome = await evaluateAndSettleQueuedRow(queued, leaseToken, fullDeps, db, dbWall);
        bump(outcomes, outcome);
      };

      // ── Part A: due QUEUED rows (outside any new-row cap) ──
      const dueRows = await listDueQueuedShippingRefunds(shop, SHIPPING_REFUND_DUE_ROW_LIMIT, db);
      for (const due of dueRows) {
        if (report.stoppedBy === "error-budget") break;
        await errorBoundary(due.mergeOperationId, due.sourceOrderId, async () => {
          report.dueRowsExamined += 1;
          const lease = await leaseQueuedShippingRefund(due.id, {}, db);
          if (!lease.leased) {
            bump(outcomes, `LEASE:${lease.reason}`);
            return;
          }
          await settleRow(dueAsContext(due), lease.leaseToken);
        });
      }

      // ── Part B: new candidates (bounded keyset paging) ──
      if (report.stoppedBy === null) {
        let cursor = { createdAt: new Date(0), id: "" };
        for (let page = 0; page < SCAN_MAX_PAGES_PER_SHOP; page++) {
          if (report.stoppedBy !== null) break;
          const ops = await selectScanOperations(
            shop,
            gate.admissionCutoffAt,
            cursor,
            SHIPPING_REFUND_SCAN_PAGE_SIZE,
            db,
          );
          if (ops.length === 0) break;
          for (const op of ops) {
            if (report.stoppedBy !== null) break;
            await scanOperation(op, dbWall, report, errorBoundary, settleRow, log, db);
          }
          const last = ops[ops.length - 1];
          cursor = { createdAt: last.createdAt, id: last.id };
          if (ops.length < SHIPPING_REFUND_SCAN_PAGE_SIZE) break;
          if (page === SCAN_MAX_PAGES_PER_SHOP - 1) {
            log(`[shipping-refund] scan-window-saturated shop=${shop}`);
          }
        }
      }

      // ── The malformed-operations report (7.2.2) ──
      const structural = await findMalformedOperations(shop, gate.admissionCutoffAt, 25, db);
      for (const m of structural) {
        malformed.push({
          operationId: m.operationId,
          secondaryIndex: m.secondaryIndex,
          defect: m.defect,
        });
      }
      log(
        `[shipping-refund] malformed-operations shop=${shop} count=${malformed.length}`,
      );
      report.quarantined = [...quarantined.values()];
    } catch (err) {
      // A shop-level failure (advisory read, due-row query, page fetch):
      // logged, counted, and the next shop is unaffected (7.2.2).
      report.stoppedBy = report.stoppedBy ?? "shop-error";
      log(
        `[shipping-refund] shop-error shop=${shop} ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      report.quarantined = [...quarantined.values()];
    }
  }
  return reports;
}

const dueAsContext = (due: DueQueuedRow): QueuedRowContext => ({
  id: due.id,
  shop: due.shop,
  mergeOperationId: due.mergeOperationId,
  sourceOrderId: due.sourceOrderId,
  primaryOrderId: due.primaryOrderId,
  primaryOrderName: due.primaryOrderName,
  lane: due.lane,
  marker: due.marker,
  idempotencyKey: due.idempotencyKey,
});

// ── Part B: one operation's secondaries ────────────────────────────────────

interface MutableReport {
  stoppedBy: string | null;
  readonly outcomes: Record<string, number>;
  claimed: number;
  terminalClaims: number;
  deferredSettleDelay: number;
  evaluations: number;
  readonly secondaryErrors: SecondaryError[];
  readonly malformed: { operationId: string; secondaryIndex: number | null; defect: string }[];
}

async function scanOperation(
  op: ScanOperationRow,
  dbWall: Date,
  report: MutableReport,
  errorBoundary: (operationId: string, secondaryId: string, work: () => Promise<void>) => Promise<void>,
  settleRow: (queued: QueuedRowContext, leaseToken: string) => Promise<void>,
  log: (line: string) => void,
  db: PrismaClient,
): Promise<void> {
  const candidates = candidateSecondaryElements(op);
  const ids = candidates.map((s) => s.id as string);
  if (ids.length === 0) return;

  const [records, attempts, existing] = await Promise.all([
    listMergeRecordsForSecondaries(op.shop, ids, db),
    listMergeAttemptsForOperations([op.id], db),
    listShippingRefundsForSources(op.shop, ids, db),
  ]);

  const existingBySource = new Map(existing.map((e) => [e.sourceOrderId, e]));
  const rowFree = candidates.filter((s) => {
    const claimed = existingBySource.get(s.id as string);
    if (claimed && claimed.mergeOperationId !== op.id) {
      // A row owned by a DIFFERENT operation: one-merge-per-secondary is
      // contradicted — report it; the unique key already prevents a second
      // refund (7.2.2 'source-claimed-by-other-operation').
      report.malformed.push({
        operationId: op.id,
        secondaryIndex: null,
        defect: "source-claimed-by-other-operation",
      });
      return false;
    }
    return claimed === undefined;
  });

  // The SQL EXISTS filter already proved one eligible secondary; JS-side
  // re-filtering is belt and braces. At most 25 rowFree per operation
  // per scan (7.3); existing rows never consume the allowance.
  for (const secondary of rowFree.slice(0, SCAN_SECONDARIES_PER_OPERATION)) {
    if (report.stoppedBy !== null) return;
    const secondaryId = secondary.id as string;
    await errorBoundary(op.id, secondaryId, async () => {
      const shop = op.shop;

      // 7.2.1 first — before any Shopify read or evaluation.
      const validation = validateOperationForClaim(op, secondary, dbWall);
      if (validation.outcome === "UNCLAIMABLE") {
        // No valid key exists to write even a terminal row (7.2.1): counted
        // in the malformed report; the per-secondary boundary stays clean.
        report.malformed.push({
          operationId: op.id,
          secondaryIndex: null,
          defect: `unclaimable:${validation.field}/${validation.reason}`,
        });
        bump(report.outcomes, "UNCLAIMABLE");
        return;
      }
      if (validation.outcome === "CANCELLED_AT_INVALID") {
        const claim = await claimShippingRefund(
          { operation: op, secondary },
          db,
          log,
        );
        if (claim.claimed) {
          report.terminalClaims += 1;
          bump(report.outcomes, "TERMINAL:CANCELLED_AT_INVALID");
          // 7.2.2: the claim-path 'cancelled-at-invalid' listing.
          report.malformed.push({
            operationId: op.id,
            secondaryIndex: null,
            defect: "cancelled-at-invalid",
          });
          return;
        }
        if (claim.code === "GATE_CLOSED") {
          report.stoppedBy = `gate:${claim.gate.code}`;
          bump(report.outcomes, "GATE_CLOSED");
          return;
        }
        if (claim.code === "TRIGGERS_NOT_INTACT") throw new Error("triggers-not-intact");
        bump(report.outcomes, `CLAIM:${claim.code}`);
        return;
      }

      // Merge-evidence contradiction → REVIEW_REQUIRED, no Shopify read.
      const assessment = assessSecondaryEvidence({
        operation: {
          id: op.id,
          protocolVersion: op.protocolVersion,
          phase: op.phase,
          calculatedOrderId: op.calculatedOrderId,
          opToken: op.opToken,
          primaryOrderId: op.primaryOrderId,
          expectedTransfer: op.expectedTransfer,
          appliedEvidence: op.appliedEvidence,
        },
        secondary: secondary as { id: string; cancelPhase?: string; done?: boolean; cancelledAt?: string | null; staffNoteMatched?: boolean },
        mergeRecords: records,
        attempts,
      });
      if (!assessment.eligible) {
        const claim = await claimTerminalShippingRefund(
          { operation: op, secondary },
          {
            status: "REVIEW_REQUIRED",
            reasonCode: "MERGE_EVIDENCE_CONTRADICTION",
            reviewReason: assessment.issues.join(" | ").slice(0, 2000),
          },
          db,
          log,
        );
        if (claim.claimed) {
          report.terminalClaims += 1;
          bump(report.outcomes, "TERMINAL:MERGE_EVIDENCE_CONTRADICTION");
          return;
        }
        if (claim.code === "GATE_CLOSED") {
          report.stoppedBy = `gate:${claim.gate.code}`;
          bump(report.outcomes, "GATE_CLOSED");
          return;
        }
        if (claim.code === "TRIGGERS_NOT_INTACT") throw new Error("triggers-not-intact");
        bump(report.outcomes, `CLAIM:${claim.code}`);
        return;
      }

      // E6: the 15-minute settle delay (7.1) — leave unclaimed.
      const cancelledAt = validation.sourceCancelledAt;
      if (cancelledAt.getTime() + SETTLE_DELAY_MS > dbWall.getTime()) {
        report.deferredSettleDelay += 1;
        bump(report.outcomes, "DEFERRED:SETTLE_DELAY");
        return;
      }
      // E7: stale combine — terminal SKIPPED(STALE_COMBINE).
      if (cancelledAt.getTime() + STALE_COMBINE_MS < dbWall.getTime()) {
        const claim = await claimTerminalShippingRefund(
          { operation: op, secondary },
          { status: "SKIPPED", reasonCode: "STALE_COMBINE" },
          db,
          log,
        );
        if (claim.claimed) {
          report.terminalClaims += 1;
          bump(report.outcomes, "SKIPPED:STALE_COMBINE");
          return;
        }
        if (claim.code === "GATE_CLOSED") {
          report.stoppedBy = `gate:${claim.gate.code}`;
          bump(report.outcomes, "GATE_CLOSED");
          return;
        }
        if (claim.code === "TRIGGERS_NOT_INTACT") throw new Error("triggers-not-intact");
        bump(report.outcomes, `CLAIM:${claim.code}`);
        return;
      }

      // The per-shop Shopify-evaluation budget (7.3): once exhausted, stop
      // claiming — later candidates wait for the next scan.
      if (report.evaluations >= SCAN_EVALUATIONS_PER_SHOP) {
        report.stoppedBy = "evaluation-budget";
        log(`[shipping-refund] evaluation-budget-exhausted shop=${shop}`);
        return;
      }

      // §7.5 claim.
      const claim = await claimShippingRefund({ operation: op, secondary }, db, log);
      if (!claim.claimed) {
        if (claim.code === "GATE_CLOSED") {
          report.stoppedBy = `gate:${claim.gate.code}`;
          bump(report.outcomes, "GATE_CLOSED");
          return;
        }
        if (claim.code === "TRIGGERS_NOT_INTACT") throw new Error("triggers-not-intact");
        if (claim.code === "UNCLAIMABLE") {
          // Re-validation inside the claim refused (it ran before ours): no
          // valid key to park — counted in the malformed report.
          report.malformed.push({
            operationId: op.id,
            secondaryIndex: null,
            defect: `unclaimable:${claim.validation.field}/${claim.validation.reason}`,
          });
          bump(report.outcomes, "UNCLAIMABLE");
          return;
        }
        bump(report.outcomes, `CLAIM:${claim.code}`); // CONFLICT: another scanner won
        return;
      }
      report.claimed += 1;
      bump(report.outcomes, `CLAIMED:${claim.status}`);

      // Evaluate immediately (7.3) and settle — counted against the
      // per-shop evaluation budget. A QUEUED claim always carries its
      // 180-second lease; a missing token is defensive only.
      report.evaluations += 1;
      const head = await claimRowHead(claim.rowId, db);
      if (head === null || claim.leaseToken === null) return;
      const ctx: QueuedRowContext = {
        id: claim.rowId,
        shop,
        mergeOperationId: op.id,
        sourceOrderId: head.sourceOrderId,
        primaryOrderId: head.primaryOrderId,
        primaryOrderName: head.primaryOrderName,
        lane: head.lane,
        marker: head.marker,
        idempotencyKey: head.idempotencyKey,
      };
      await settleRow(ctx, claim.leaseToken);
    });
  }
}

/** The claim returns no marker or key (they are generated inside the
 *  transaction); read them back before evaluation. */
async function claimRowHead(
  rowId: string,
  db: PrismaClient,
): Promise<{ marker: string; idempotencyKey: string; sourceOrderId: string; primaryOrderId: string; primaryOrderName: string; lane: string; mergeOperationId: string; shop: string } | null> {
  const rows = await db.$queryRaw<
    { marker: string; idempotencyKey: string; sourceOrderId: string; primaryOrderId: string; primaryOrderName: string; lane: string; mergeOperationId: string; shop: string }[]
  >`
    SELECT "marker", "idempotencyKey", "sourceOrderId", "primaryOrderId",
           "primaryOrderName", "lane", "mergeOperationId", "shop"
    FROM "ShippingRefund" WHERE "id" = ${rowId}`;
  return rows[0] ?? null;
}
