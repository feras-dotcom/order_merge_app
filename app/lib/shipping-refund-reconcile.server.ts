// ── Shipping v0 Phase 2 S1-F: read-only reconciliation and recovery ─────────
// docs/SHIPPING-PHASE2-DESIGN.md Revision 3.3, sections 6.1, 9.5, 12.1–12.8,
// 13. The reconciler reads synthetic (S1: fixture-created) post-dispatch
// rows — DISPATCHING, IN_DOUBT, REFUND_RECORDED — and classifies the
// Shopify read-back into one of: still-invisible (wait), complete and
// consistent (adopt/verify), missing or contradictory (review) or
// unattributed (wait/review). It NEVER sends a request, never issues a
// refund, never treats an absent refund as proof that no money moved, and
// never creates DISPATCHING or writes dispatch evidence.
//
// Boundaries (3.2): every Shopify call goes through readOnlyAdmin; the four
// pinned documents (Q-RECONCILE, Q-REFUND-DETAIL, Q-AGREEMENTS, Q-APPID) are
// UNVALIDATED proposals — exercised here only against injected fakes until
// G-READBACK. Every status write goes through writeReconcileTransition,
// which re-verifies the canonical trigger catalog inside its transaction
// and is lease-fenced on the database UTC clock. This cycle does not
// consult admission or dispatch controls: reconciliation must work while
// both are off.

import { type PrismaClient } from "@prisma/client";
import defaultDb from "../db.server";
import type { AdminClient } from "./graphql.server";
import { parseShopMoney } from "./money";
import { OwnershipLostError, isTransientDbError } from "./ownership.server";
import { dryRunSessionUsable, readOnlyAdmin } from "./shipping-shadow.server";
import {
  ATTRIBUTION_STATUS,
  classifyInDoubtReadback,
  classifyRefundVerification,
  reconcileRetryDelayMs,
  type AttributionStatus,
  type ReconcileAgreement,
  type ReconcileDecision,
  type ReconcileDetailTransaction,
  type ReconcileListRead,
  type ReconcileReads,
  type ReconcileRefundDetail,
  type ReconcileRefundListEntry,
  type ReconcileRowFacts,
} from "./shipping-refund-gate";
import {
  AGREEMENTS_MAX_PAGES,
  DETAIL_IDS_PER_REQUEST,
  DETAIL_REQUESTS_PER_EVALUATION,
  Q_AGREEMENTS,
  Q_APPID,
  Q_RECONCILE,
  Q_REFUND_DETAIL,
  validateAgreementsPage,
  validateAppIdentity,
  validateRefundDetailResponse,
  validateRefundList,
} from "./shipping-refund-queries";
import {
  checkTriggerIntegrity,
  TRIGGER_CATALOG_SQL,
  type ShippingRefundTriggerCatalogRow,
} from "./shipping-refund-trigger-manifest";
import {
  leaseReconcileShippingRefund,
  listDueReconcileShippingRefunds,
  listStaleDispatchingShippingRefunds,
  loadReconcileRow,
  rescheduleReconcileRow,
  writeReconcileTransition,
} from "./shipping-refund-store.server";

// ── Bounds (12.4, 12.5) ───────────────────────────────────────────────────

export const RECONCILE_ROWS_PER_SHOP = 25;
export const RECONCILE_SWEEP_PER_SHOP = 25;
export const RECONCILE_ERRORS_PER_SHOP = 25;
export const ORPHAN_AUDIT_SECONDARIES_PER_SHOP = 25;
export const ORPHAN_AUDIT_REFUNDS_PER_SECONDARY = 10;

const MARKER_PREFIX = "MS-SHIPREFUND-";

// ── Report shape ──────────────────────────────────────────────────────────

export interface ReconcileRowError {
  readonly shop: string;
  readonly rowId: string;
  readonly errorClass: "DATA" | "TRANSIENT" | "UNKNOWN";
  readonly message: string;
}

export interface ReconcileShopReport {
  readonly shop: string;
  readonly stoppedBy: string | null;
  readonly sweptToInDoubt: number;
  readonly rowsExamined: number;
  readonly adopted: number;
  readonly verified: number;
  readonly reviewRequired: number;
  readonly waited: number;
  readonly outcomes: Record<string, number>;
  readonly errors: ReconcileRowError[];
}

export interface ShippingRefundReconcileDeps {
  /** Offline admin client per shop (wrapped in readOnlyAdmin here). */
  adminFactory: (shop: string) => Promise<AdminClient | null>;
  /** Offline session probe — the same row the Shopify library loads
   *  (`offline_<shop>`, i.e. `getOfflineId(shop)`, F12/N12). A near-expiry
   *  or missing session skips every Shopify read and every write for the
   *  shop (the refresh-rotation hazard of the dry-run rule). Defaults to
   *  the real Session-table lookup below: production wiring MUST NOT
   *  substitute a loader that identifies a different session row or that
   *  always reports usable — the offline-session validity check is a
   *  prerequisite for any future operational caller. */
  sessionLoader?: (shop: string) => Promise<{ expires: Date | null } | null>;
  /** Test seam for the cycle-level catalog check (mirrors admission). The
   *   transition writer always re-checks inside its own transaction. */
  catalogReader?: () => Promise<readonly ShippingRefundTriggerCatalogRow[]>;
  log?: (line: string) => void;
  /** Per-shop row cap (test knob; the spec bound is 25). */
  rowLimit?: number;
}

/**
 * TEST-ONLY deps extension (12.3.1). `attributionStatus` is injected ONLY
 * by tests to exercise the CONFIRMED branch on fixtures; production code
 * never supplies it — the pinned `ATTRIBUTION_STATUS` constant supplies
 * "UNVERIFIED". The field lives on a separate type so an operational deps
 * object cannot acquire it by accident, and the architecture scan forbids
 * the token in non-test sources outside this module and the gate module.
 * There is no env var, row, setter or request path to it.
 */
export interface ShippingRefundReconcileTestDeps
  extends ShippingRefundReconcileDeps {
  readonly attributionStatus?: AttributionStatus;
}

/** The real offline-session lookup: the exact row `loadSession` uses for
 *  `getOfflineId(shop)` (N12) — never `findFirst({shop, isOnline:false})`.
 *  Mirrors the admission scan's default loader. */
const defaultSessionLoader = (db: PrismaClient) => async (shop: string) =>
  db.session.findUnique({ where: { id: `offline_${shop}` } });

const bump = (outcomes: Record<string, number>, key: string) => {
  outcomes[key] = (outcomes[key] ?? 0) + 1;
};

// ── Response normalization (all via the pinned validators) ────────────────

/** A throttled top-level GraphQL error — transient per section 11: it
 *  never contributes evidence and never counts as completeness-unproven.
 *  Thrown out of gqlJson so every reader maps it to its lag/failure class
 *  exactly like a transport failure. */
export class ShopifyThrottledError extends Error {
  name = "ShopifyThrottledError";
}

const isThrottledBody = (body: unknown): boolean => {
  if (!isObj(body) || !Array.isArray(body.errors)) return false;
  return (body.errors as unknown[]).some(
    (e) =>
      isObj(e) &&
      ((isObj(e.extensions) && e.extensions.code === "THROTTLED") ||
        /^throttled/i.test(String((e as { message?: unknown }).message ?? ""))),
  );
};

const gqlJson = async (
  admin: AdminClient,
  document: string,
  variables: Record<string, unknown>,
): Promise<unknown> => {
  const res = await admin.graphql(document, { variables });
  const body = await res.json();
  if (isThrottledBody(body)) {
    throw new ShopifyThrottledError("Shopify read throttled — retryable");
  }
  return body;
};

const moneyBag = (
  set: unknown,
): { minorUnits: bigint; currencyCode: string } | null => {
  const m = parseShopMoney(
    (set as { presentmentMoney?: unknown } | null)?.presentmentMoney,
  );
  return m ? { minorUnits: m.minorUnits, currencyCode: m.currencyCode } : null;
};

const normTxn = (t: Record<string, unknown>): ReconcileDetailTransaction => ({
  id: t.id as string,
  kind: t.kind as string,
  status: t.status as string,
  gateway: (t.gateway as string | null) ?? null,
  amountMinor:
    moneyBag(t.amountSet)?.minorUnits ?? null,
  currencyCode: moneyBag(t.amountSet)?.currencyCode ?? null,
  parentTransactionId:
    ((t.parentTransaction as { id?: string } | null)?.id as string | undefined) ??
    null,
});

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const errMsg = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** Q-RECONCILE read + validation. A thrown transport/top-level error is a
 *  plain lag; a validator failure means completeness is unproven (12.5:
 *  a malformed or unbounded list is READBACK_INCOMPLETE, not a pass). */
const readReconcileList = async (
  admin: AdminClient,
  sourceOrderId: string,
): Promise<ReconcileListRead> => {
  let body: unknown;
  try {
    body = await gqlJson(admin, Q_RECONCILE.document, {
      source: sourceOrderId,
    });
  } catch (err) {
    return {
      ok: false,
      completenessUnproven: false,
      detail: `Q-RECONCILE read failed: ${errMsg(err)}`,
    };
  }
  const v = validateRefundList(body, { sourceOrderId });
  if (!v.ok) {
    return {
      ok: false,
      completenessUnproven: true,
      detail: `Q-RECONCILE response failed validation: ${v.reason}`,
    };
  }
  const order = (body as { data: { order: Record<string, unknown> } }).data
    .order;
  const refunds = (order.refunds as Record<string, unknown>[]).map(
    (r): ReconcileRefundListEntry => ({
      id: r.id as string,
      note: (r.note as string | null) ?? null,
      createdAt: (r.createdAt as string | null) ?? null,
      processedAt: (r.processedAt as string | null) ?? null,
      totalRefunded: moneyBag(r.totalRefundedSet),
    }),
  );
  const transactions = (order.transactions as Record<string, unknown>[]).map(
    normTxn,
  );
  return {
    ok: true,
    refunds,
    transactions,
    totalRefunded: moneyBag(order.totalRefundedSet),
    totalRefundedShipping: moneyBag(order.totalRefundedShippingSet),
  };
};

const normDetail = (node: Record<string, unknown>): ReconcileRefundDetail => {
  const conn = (k: string) =>
    ((node[k] as { nodes?: Record<string, unknown>[] })?.nodes ??
      []) as Record<string, unknown>[];
  return {
    id: node.id as string,
    note: (node.note as string | null) ?? null,
    createdAt: (node.createdAt as string | null) ?? null,
    processedAt: (node.processedAt as string | null) ?? null,
    totalRefunded: moneyBag(node.totalRefundedSet),
    dutiesCount: (node.duties as unknown[]).length,
    shippingLines: conn("refundShippingLines").map((l) => ({
      subtotal: moneyBag(l.subtotalAmountSet),
      taxMinor: moneyBag(l.taxAmountSet)?.minorUnits ?? null,
    })),
    refundLineItemCount: conn("refundLineItems").length,
    orderAdjustmentCount: conn("orderAdjustments").length,
    transactions: conn("transactions").map(normTxn),
  };
};

/** Q-REFUND-DETAIL for a bounded id set (≤5 ids/request, ≤2 requests). */
const readRefundDetails = async (
  admin: AdminClient,
  ids: readonly string[],
  sourceOrderId: string,
  ownRefundId: string | undefined,
): Promise<
  | { ok: true; byId: ReadonlyMap<string, ReconcileRefundDetail> }
  | { ok: false; detail: string }
> => {
  const byId = new Map<string, ReconcileRefundDetail>();
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += DETAIL_IDS_PER_REQUEST) {
    chunks.push(ids.slice(i, i + DETAIL_IDS_PER_REQUEST));
    if (chunks.length > DETAIL_REQUESTS_PER_EVALUATION) {
      return {
        ok: false,
        detail: `detail read needs more than ${DETAIL_REQUESTS_PER_EVALUATION} requests for ${ids.length} ids`,
      };
    }
  }
  for (const chunk of chunks) {
    let body: unknown;
    try {
      body = await gqlJson(admin, Q_REFUND_DETAIL.document, { ids: chunk });
    } catch (err) {
      return { ok: false, detail: `Q-REFUND-DETAIL read failed: ${errMsg(err)}` };
    }
    const v = validateRefundDetailResponse(body, chunk, {
      sourceOrderId,
      ownRefundId,
    });
    if (!v.ok) {
      return {
        ok: false,
        detail: `Q-REFUND-DETAIL response failed validation: ${v.reason}`,
      };
    }
    const nodes = (body as { data: { nodes: Record<string, unknown>[] } })
      .data.nodes;
    for (const node of nodes) {
      byId.set(node.id as string, normDetail(node));
    }
  }
  return { ok: true, byId };
};

/** Q-AGREEMENTS, paginated to AGREEMENTS_MAX_PAGES. A further page at the
 *  cap means the agreement set is unproven — attribution LAG, never a
 *  satisfied condition. */
const readAllAgreements = async (
  admin: AdminClient,
  sourceOrderId: string,
): Promise<
  { ok: true; agreements: ReconcileAgreement[] } | { ok: false; detail: string }
> => {
  const agreements: ReconcileAgreement[] = [];
  let after: string | null = null;
  for (let page = 0; page < AGREEMENTS_MAX_PAGES; page++) {
    let body: unknown;
    try {
      body = await gqlJson(admin, Q_AGREEMENTS.document, {
        source: sourceOrderId,
        after,
      });
    } catch (err) {
      return { ok: false, detail: `Q-AGREEMENTS read failed: ${errMsg(err)}` };
    }
    const v = validateAgreementsPage(body, { sourceOrderId });
    if (!v.ok) {
      return {
        ok: false,
        detail: `Q-AGREEMENTS page ${page + 1} failed validation: ${v.reason}`,
      };
    }
    const conn = (body as { data: { order: { agreements: {
      nodes: Record<string, unknown>[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    } } } }).data.order.agreements;
    for (const n of conn.nodes) {
      agreements.push({
        id: n.id as string,
        typename: n.__typename as string,
        reason: (n.reason as string | null) ?? null,
        happenedAt: (n.happenedAt as string | null) ?? null,
        appId:
          ((n.app as { id?: string } | null)?.id as string | undefined) ?? null,
        refundId:
          ((n.refund as { id?: string } | null)?.id as string | undefined) ??
          null,
      });
    }
    if (!conn.pageInfo.hasNextPage) return { ok: true, agreements };
    after = conn.pageInfo.endCursor;
  }
  return {
    ok: false,
    detail: `agreement scan exceeded ${AGREEMENTS_MAX_PAGES} pages — set unproven`,
  };
};

/** Q-APPID: the verified current app id — the only source 12.3 permits. */
const readCurrentAppId = async (
  admin: AdminClient,
): Promise<{ ok: true; id: string } | { ok: false; detail: string }> => {
  try {
    const body = await gqlJson(admin, Q_APPID.document, {});
    const v = validateAppIdentity(body);
    return v.ok ? { ok: true, id: v.appId! } : { ok: false, detail: v.reason };
  } catch (err) {
    return { ok: false, detail: `Q-APPID read failed: ${errMsg(err)}` };
  }
};

// ── Row facts ──────────────────────────────────────────────────────────────

interface PreparedRowFacts {
  readonly facts: ReconcileRowFacts | null;
  /** The stored baseline's refund ids and fingerprints. */
  readonly baselineIds: readonly string[];
  readonly baselineFingerprints: ReadonlyMap<
    string,
    { totalMinor: string; transactionCount: number; shippingLineCount: number;
      adjustmentCount: number; dutyCount: number; refundLineItemCount: number }
  >;
  readonly malformed: string | null;
}

const extractRowFacts = (rec: {
  marker: string;
  dispatchedAt: Date | null;
  respondedAt: Date | null;
  refundId: string | null;
  plannedShippingMinor: string | null;
  currencyCode: string | null;
  parentTransactionId: string | null;
  gateway: string | null;
  preEvidence: unknown;
}): PreparedRowFacts => {
  const baselineIds: string[] = [];
  const baselineFingerprints = new Map<string, PreparedRowFacts["baselineFingerprints"] extends ReadonlyMap<string, infer F> ? F : never>();
  const pre = rec.preEvidence;
  if (isObj(pre) && isObj(pre.baseline)) {
    const refunds = pre.baseline.refunds;
    if (Array.isArray(refunds)) {
      for (const r of refunds) {
        if (isObj(r) && typeof r.id === "string") {
          baselineIds.push(r.id);
          baselineFingerprints.set(r.id, {
            totalMinor: String((r as Record<string, unknown>).totalMinor),
            transactionCount: Number(
              (r as Record<string, unknown>).transactionCount,
            ),
            shippingLineCount: Number(
              (r as Record<string, unknown>).shippingLineCount,
            ),
            adjustmentCount: Number(
              (r as Record<string, unknown>).adjustmentCount,
            ),
            dutyCount: Number((r as Record<string, unknown>).dutyCount),
            refundLineItemCount: Number(
              (r as Record<string, unknown>).refundLineItemCount,
            ),
          });
        }
      }
    }
  }
  const missing =
    rec.dispatchedAt === null
      ? "dispatchedAt"
      : rec.plannedShippingMinor === null
        ? "plannedShippingMinor"
        : rec.currencyCode === null
          ? "currencyCode"
          : rec.parentTransactionId === null
            ? "parentTransactionId"
            : rec.gateway === null
              ? "gateway"
              : null;
  if (missing !== null) {
    return {
      facts: null,
      baselineIds,
      baselineFingerprints,
      malformed: `post-dispatch row is missing frozen column ${missing}`,
    };
  }
  return {
    facts: {
      marker: rec.marker,
      dispatchedAt: rec.dispatchedAt!,
      respondedAt: rec.respondedAt,
      refundId: rec.refundId,
      plannedShippingMinor: rec.plannedShippingMinor!,
      currencyCode: rec.currencyCode!,
      parentTransactionId: rec.parentTransactionId!,
      gateway: rec.gateway!,
      baselineRefundIds: baselineIds,
    },
    baselineIds,
    baselineFingerprints,
    malformed: null,
  };
};

// ── The cycle ─────────────────────────────────────────────────────────────

export async function runShippingRefundReconcileCycle(
  shops: readonly string[],
  deps: ShippingRefundReconcileDeps | ShippingRefundReconcileTestDeps,
  db: PrismaClient = defaultDb,
): Promise<ReconcileShopReport[]> {
  const log = deps.log ?? ((line: string) => console.error(line));
  // 12.3.1: production wiring never passes attributionStatus — the pinned
  // constant supplies "UNVERIFIED". Test fixtures inject "CONFIRMED"
  // through the ShippingRefundReconcileTestDeps seam only; the field does
  // not exist on the operational type and no env var, row, setter or
  // request reaches it.
  const attributionStatus = (deps as ShippingRefundReconcileTestDeps).attributionStatus ?? ATTRIBUTION_STATUS;
  const sessionLoader = deps.sessionLoader ?? defaultSessionLoader(db);
  const rowLimit = deps.rowLimit ?? RECONCILE_ROWS_PER_SHOP;
  const reports: ReconcileShopReport[] = [];

  for (const shop of shops) {
    const outcomes: Record<string, number> = {};
    const errors: ReconcileRowError[] = [];
    const report = {
      shop,
      stoppedBy: null as string | null,
      sweptToInDoubt: 0,
      rowsExamined: 0,
      adopted: 0,
      verified: 0,
      reviewRequired: 0,
      waited: 0,
      outcomes,
      errors,
    };
    reports.push(report);

    // 3.2 rule 11 / 5.4.7: the canonical trigger-integrity check opens the
    // reconciliation cycle — before the sweep, before any lease, before any
    // Shopify read. A failed check stops this shop's cycle without writing.
    const integrity = await checkTriggerIntegrity(
      deps.catalogReader ??
        (() =>
          db.$queryRawUnsafe<ShippingRefundTriggerCatalogRow[]>(
            TRIGGER_CATALOG_SQL,
          )),
    );
    if (!integrity.intact) {
      report.stoppedBy = "triggers-not-intact";
      log(
        `[shipping-refund] triggers-not-intact shop=${shop} ` +
          integrity.reasons
            .map((r) => `${r.code}${r.trigger ? `(${r.trigger})` : ""}`)
            .join(" ")
            .slice(0, 2000),
      );
      continue;
    }

    // ── Recovery sweep: unanswered DISPATCHING rows older than 120 s of
    // database wall time become IN_DOUBT (9.5, 13). Nothing here re-sends
    // or assumes the request did or did not leave the process. ──
    const stale = await listStaleDispatchingShippingRefunds(
      shop,
      RECONCILE_SWEEP_PER_SHOP,
      db,
    );
    for (const row of stale) {
      if (report.stoppedBy !== null) break;
      try {
        const lease = await leaseReconcileShippingRefund(row.id, {}, db);
        if (!lease.leased) {
          bump(outcomes, `LEASE:${lease.reason}`);
          continue;
        }
        const w = await writeReconcileTransition(
          row.id,
          lease.leaseToken,
          { to: "IN_DOUBT", reasonCode: "DISPATCH_UNANSWERED" },
          db,
        );
        if (!w.written) {
          if (w.reason === "TRIGGERS_NOT_INTACT") {
            report.stoppedBy = "triggers-not-intact";
            log(`[shipping-refund] triggers-not-intact shop=${shop}`);
            break;
          }
          bump(outcomes, `SWEEP:${w.reason}`);
          continue;
        }
        bump(outcomes, "SWEPT:IN_DOUBT");
        report.sweptToInDoubt += 1;
      } catch (err) {
        if (err instanceof OwnershipLostError) {
          bump(outcomes, "LEASE:LOST");
          continue;
        }
        errors.push({
          shop,
          rowId: row.id,
          errorClass: isTransientDbError(err) ? "TRANSIENT" : "UNKNOWN",
          message: errMsg(err),
        });
      }
    }
    if (report.stoppedBy !== null) continue;

    // ── Shopify reads: session gate, then the read-only client. The gate
    // is mandatory — the loader defaults to the real offline-session lookup
    // (`offline_${shop}`, the getOfflineId row), and a missing/expired or
    // unreadable session skips every read and every write for the shop.
    // The rows stay due for the next cycle, never forced. ──
    const session = await sessionLoader(shop).catch(() => null);
    if (!dryRunSessionUsable(session)) {
      report.stoppedBy = "session-unusable";
      log(`[shipping-refund] reconcile-session-unusable shop=${shop}`);
      continue;
    }
    let rawAdmin: AdminClient | null;
    try {
      rawAdmin = await deps.adminFactory(shop);
    } catch (err) {
      report.stoppedBy = "admin-error";
      log(
        `[shipping-refund] reconcile-admin-error shop=${shop} ${errMsg(err)}`,
      );
      continue;
    }
    if (!rawAdmin) {
      report.stoppedBy = "no-session";
      log(`[shipping-refund] reconcile-no-session shop=${shop}`);
      continue;
    }
    const admin = readOnlyAdmin(rawAdmin);

    const [wallRow] = await db.$queryRaw<{ wall: Date }[]>`
      SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "wall"`;
    const now = wallRow.wall;
    let appIdCache:
      | { ok: true; id: string }
      | { ok: false; detail: string }
      | null = null;

    const due = await listDueReconcileShippingRefunds(shop, rowLimit, db);
    for (const d of due) {
      if (report.stoppedBy !== null) break;
      if (errors.length >= RECONCILE_ERRORS_PER_SHOP) {
        report.stoppedBy = "error-budget";
        break;
      }
      try {
        const lease = await leaseReconcileShippingRefund(d.id, {}, db);
        if (!lease.leased) {
          bump(outcomes, `LEASE:${lease.reason}`);
          continue;
        }
        report.rowsExamined += 1;
        const rec = await loadReconcileRow(d.id, db);
        if (rec === null) {
          bump(outcomes, "GONE");
          continue;
        }
        const prepared = extractRowFacts(rec);
        const applyReview = async (
          reasonCode: string,
          detail: string,
        ): Promise<boolean> => {
          const w = await writeReconcileTransition(
            rec.id,
            lease.leaseToken,
            { to: "REVIEW_REQUIRED", reasonCode, reviewReason: detail },
            db,
          );
          if (!w.written) {
            if (w.reason === "TRIGGERS_NOT_INTACT") {
              report.stoppedBy = "triggers-not-intact";
              log(`[shipping-refund] triggers-not-intact shop=${shop}`);
              return false;
            }
            bump(outcomes, `WRITE:${w.reason}`);
            return true;
          }
          bump(outcomes, `REVIEW:${reasonCode}`);
          report.reviewRequired += 1;
          return true;
        };
        if (prepared.facts === null) {
          if (!(await applyReview("ANOMALY", prepared.malformed!))) break;
          continue;
        }
        const facts = prepared.facts;

        // The reads. The list is always needed; detail/agreements/appId are
        // read only when a candidate (marker or recorded id) exists, and
        // lazily enough that a missing candidate costs one bounded read.
        const list = await readReconcileList(admin, rec.sourceOrderId);
        const candidateId =
          rec.status === "REFUND_RECORDED"
            ? facts.refundId
            : list.ok
              ? (list.refunds.find(
                  (r) =>
                    typeof r.note === "string" &&
                    r.note.includes(facts.marker),
                )?.id ?? null)
              : null;

        let detail: ReconcileReads["detail"] = null;
        let baselineFingerprintChanged = false;
        if (candidateId !== null) {
          // Detail ids: the candidate plus the stored baseline ids (for the
          // fingerprint-change check). Beyond the bounded budget the read is
          // declared incomplete — never silently partial.
          const ids = [
            candidateId,
            ...prepared.baselineIds.filter((b) => b !== candidateId),
          ];
          const uniqueIds = [...new Set(ids)];
          if (
            uniqueIds.length >
            DETAIL_IDS_PER_REQUEST * DETAIL_REQUESTS_PER_EVALUATION
          ) {
            detail = {
              ok: false,
              detail: `baseline + candidate exceed the detail budget (${uniqueIds.length} ids)`,
            };
          } else {
            const d = await readRefundDetails(
              admin,
              uniqueIds,
              rec.sourceOrderId,
              candidateId,
            );
            if (!d.ok) {
              detail = { ok: false, detail: d.detail };
            } else {
              const candidate = d.byId.get(candidateId);
              if (!candidate) {
                detail = {
                  ok: false,
                  detail: "candidate refund missing from detail response",
                };
              } else {
                detail = { ok: true, refund: candidate };
                for (const [id, fp] of prepared.baselineFingerprints) {
                  const fresh = d.byId.get(id);
                  if (
                    fresh &&
                    (fresh.totalRefunded === null ||
                      fresh.totalRefunded.minorUnits.toString() !==
                        fp.totalMinor ||
                      fresh.transactions.length !== fp.transactionCount ||
                      fresh.shippingLines.length !== fp.shippingLineCount ||
                      fresh.orderAdjustmentCount !== fp.adjustmentCount ||
                      fresh.dutiesCount !== fp.dutyCount ||
                      fresh.refundLineItemCount !== fp.refundLineItemCount)
                  ) {
                    baselineFingerprintChanged = true;
                  }
                }
              }
            }
          }
        }

        let agreements: ReconcileReads["agreements"] = null;
        let appId: ReconcileReads["appId"] = null;
        if (detail !== null && detail.ok) {
          if (appIdCache === null) appIdCache = await readCurrentAppId(admin);
          appId = appIdCache;
          agreements = await readAllAgreements(admin, rec.sourceOrderId);
        }

        const reads: ReconcileReads = {
          list,
          detail,
          agreements,
          appId,
          baselineFingerprintChanged,
        };
        const decision: ReconcileDecision =
          rec.status === "IN_DOUBT"
            ? classifyInDoubtReadback(facts, reads, {
                now,
                attributionStatus,
              })
            : classifyRefundVerification(facts, reads, {
                now,
                attributionStatus,
              });

        switch (decision.action) {
          case "WAIT": {
            await rescheduleReconcileRow(
              rec.id,
              lease.leaseToken,
              reconcileRetryDelayMs(
                decision.lag,
                {
                  dispatchedAt: facts.dispatchedAt,
                  status: rec.status as "IN_DOUBT" | "REFUND_RECORDED",
                },
                now,
              ),
              db,
            );
            bump(outcomes, `WAIT:${decision.lag}`);
            report.waited += 1;
            break;
          }
          case "REVIEW": {
            if (
              !(await applyReview(decision.reasonCode, decision.detail))
            ) {
              break;
            }
            break;
          }
          case "ADOPT": {
            const w = await writeReconcileTransition(
              rec.id,
              lease.leaseToken,
              {
                to: "REFUND_RECORDED",
                refundId: decision.refundId,
                refundCreatedAt: decision.refundCreatedAt,
                settlementState: decision.settlementState,
              },
              db,
            );
            if (!w.written) {
              if (w.reason === "TRIGGERS_NOT_INTACT") {
                report.stoppedBy = "triggers-not-intact";
                log(`[shipping-refund] triggers-not-intact shop=${shop}`);
                break;
              }
              if (w.reason === "REFUND_ID_TAKEN") {
                // The refund was adopted by another row — a duplicate
                // attribution signal, never an adoption (12.3 condition 7).
                if (
                  !(await applyReview(
                    "DUPLICATE_SUSPECTED",
                    `refund ${decision.refundId} is already recorded on another row`,
                  ))
                ) {
                  break;
                }
              } else {
                bump(outcomes, `WRITE:${w.reason}`);
              }
              break;
            }
            bump(outcomes, "ADOPTED:REFUND_RECORDED");
            report.adopted += 1;
            break;
          }
          case "VERIFY": {
            const w = await writeReconcileTransition(
              rec.id,
              lease.leaseToken,
              { to: "VERIFIED", verifiedEvidence: decision.evidence },
              db,
            );
            if (!w.written) {
              if (w.reason === "TRIGGERS_NOT_INTACT") {
                report.stoppedBy = "triggers-not-intact";
                log(`[shipping-refund] triggers-not-intact shop=${shop}`);
                break;
              }
              bump(outcomes, `WRITE:${w.reason}`);
              break;
            }
            bump(outcomes, "VERIFIED");
            report.verified += 1;
            break;
          }
        }
        if (report.stoppedBy !== null) break;
      } catch (err) {
        if (err instanceof OwnershipLostError) {
          bump(outcomes, "LEASE:LOST");
          continue;
        }
        errors.push({
          shop,
          rowId: d.id,
          errorClass: isTransientDbError(err) ? "TRANSIENT" : "UNKNOWN",
          message: errMsg(err),
        });
      }
    }
    if (errors.length >= RECONCILE_ERRORS_PER_SHOP && report.stoppedBy === null) {
      report.stoppedBy = "error-budget";
      log(`[shipping-refund] reconcile-error-budget shop=${shop}`);
    }
  }
  return reports;
}

// ── 12.8.1: bounded read-only orphan audit ────────────────────────────────
// Scans cancelled v2 secondaries for shipping refunds outside the journal:
// HIGH when a refund carries the marker prefix with no consistent local
// row, or when an app-attributed financially-moving refund exists without
// a consistent local row; INFO when an app-attributed zero-refund exists.
// Read-only: no row is created or modified.

export interface OrphanAuditFinding {
  readonly severity: "HIGH" | "INFO";
  readonly code:
    | "ORPHAN_MARKER_REFUND"
    | "ORPHAN_APP_REFUND"
    | "ORPHAN_APP_ZERO"
    | "ORPHAN_APP_UNVERIFIED";
  readonly shop: string;
  readonly sourceOrderId: string;
  readonly refundId: string;
  readonly detail: string;
}

export interface OrphanAuditReport {
  readonly shop: string;
  readonly stoppedBy: string | null;
  readonly secondariesScanned: number;
  readonly refundsScanned: number;
  readonly findings: OrphanAuditFinding[];
  readonly errors: string[];
}

interface AuditSecondary {
  readonly operationId: string;
  readonly secondaryId: string;
  readonly cancelledAt: string;
}

/**
 * The secondary scan is bounded and JSON-safe: `secondaries` that are not
 * JSON arrays are reported and skipped instead of aborting the whole shop
 * audit, and the `since` filter binds the naive-UTC `createdAt` column
 * through an explicit `AT TIME ZONE 'UTC'` cast so it is correct on any
 * session timezone (the same rule as every other timestamp bind).
 */
const listAuditSecondaries = (
  shop: string,
  sinceIso: string,
  db: PrismaClient,
): Promise<AuditSecondary[]> =>
  db.$queryRaw<AuditSecondary[]>`
    SELECT s.value->>'id' AS "secondaryId",
           o."id" AS "operationId",
           s.value->>'cancelledAt' AS "cancelledAt"
    FROM "MergeOperation" o,
         jsonb_array_elements(o."secondaries") s
    WHERE o."shop" = ${shop}
      AND o."protocolVersion" = 2
      AND o."phase" = 'COMPLETED'
      AND o."createdAt" >= (${sinceIso}::timestamptz AT TIME ZONE 'UTC')
      AND jsonb_typeof(o."secondaries") = 'array'
      AND s.value->>'cancelledAt' IS NOT NULL
      AND s.value->>'done' = 'true'
    ORDER BY o."createdAt" ASC
    LIMIT ${ORPHAN_AUDIT_SECONDARIES_PER_SHOP}`;

/** Ops whose `secondaries` is not a JSON array — they are reported as
 *  unreadable rather than throwing out of jsonb_array_elements. */
const listMalformedSecondariesOps = (
  shop: string,
  sinceIso: string,
  db: PrismaClient,
): Promise<{ operationId: string }[]> =>
  db.$queryRaw<{ operationId: string }[]>`
    SELECT o."id" AS "operationId"
    FROM "MergeOperation" o
    WHERE o."shop" = ${shop}
      AND o."protocolVersion" = 2
      AND o."phase" = 'COMPLETED'
      AND o."createdAt" >= (${sinceIso}::timestamptz AT TIME ZONE 'UTC')
      AND jsonb_typeof(o."secondaries") IS DISTINCT FROM 'array'`;

/** Total eligible secondary records — compared against the bounded scan so
 *  the report can say when the bound left records unexamined. */
const countAuditSecondaries = (
  shop: string,
  sinceIso: string,
  db: PrismaClient,
): Promise<bigint> =>
  db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS "n"
    FROM "MergeOperation" o,
         jsonb_array_elements(o."secondaries") s
    WHERE o."shop" = ${shop}
      AND o."protocolVersion" = 2
      AND o."phase" = 'COMPLETED'
      AND o."createdAt" >= (${sinceIso}::timestamptz AT TIME ZONE 'UTC')
      AND jsonb_typeof(o."secondaries") = 'array'
      AND s.value->>'cancelledAt' IS NOT NULL
      AND s.value->>'done' = 'true'`.then((rows) => rows[0]?.n ?? 0n);

const isRefundFinancial = (d: ReconcileRefundDetail): boolean =>
  (d.totalRefunded?.minorUnits ?? 0n) > 0n ||
  d.shippingLines.length > 0 ||
  d.transactions.length > 0 ||
  d.dutiesCount > 0 ||
  d.refundLineItemCount > 0 ||
  d.orderAdjustmentCount > 0;

export async function auditShippingRefundOrphans(
  args: { readonly shop: string; readonly since: Date },
  deps: Pick<ShippingRefundReconcileDeps, "adminFactory" | "sessionLoader" | "log">,
  db: PrismaClient = defaultDb,
): Promise<OrphanAuditReport> {
  const log = deps.log ?? (() => {});
  const report: {
    -readonly [K in keyof OrphanAuditReport]: OrphanAuditReport[K];
  } = {
    shop: args.shop,
    stoppedBy: null,
    secondariesScanned: 0,
    refundsScanned: 0,
    findings: [],
    errors: [],
  };
  const sessionLoader = deps.sessionLoader ?? defaultSessionLoader(db);
  const session = await sessionLoader(args.shop).catch(() => null);
  if (!dryRunSessionUsable(session)) {
    report.stoppedBy = "session-unusable";
    return report;
  }
  const rawAdmin = await deps.adminFactory(args.shop).catch(() => null);
  if (!rawAdmin) {
    report.stoppedBy = "no-session";
    return report;
  }
  const admin = readOnlyAdmin(rawAdmin);
  const appId = await readCurrentAppId(admin);
  if (!appId.ok) {
    // Unavailable attribution reads are recorded — never silently skipped.
    report.errors.push(`Q-APPID unavailable: ${appId.detail}`);
  }
  const sinceIso = args.since.toISOString();
  for (const malformed of await listMalformedSecondariesOps(
    args.shop,
    sinceIso,
    db,
  )) {
    report.errors.push(
      `${malformed.operationId}: 'secondaries' is not a JSON array — skipped`,
    );
  }
  const secondaries = await listAuditSecondaries(args.shop, sinceIso, db);
  const totalSecondaries = await countAuditSecondaries(args.shop, sinceIso, db);
  if (totalSecondaries > BigInt(secondaries.length)) {
    report.errors.push(
      `secondary scan bound ${ORPHAN_AUDIT_SECONDARIES_PER_SHOP} reached — ` +
        `${(totalSecondaries - BigInt(secondaries.length)).toString()} further ` +
        "records left unexamined",
    );
  }

  for (const secondary of secondaries) {
    report.secondariesScanned += 1;
    const list = await readReconcileList(admin, secondary.secondaryId);
    if (!list.ok) {
      report.errors.push(
        `${secondary.secondaryId}: ${list.detail}`,
      );
      continue;
    }
    const refunds = list.refunds.slice(0, ORPHAN_AUDIT_REFUNDS_PER_SECONDARY);
    if (list.refunds.length > ORPHAN_AUDIT_REFUNDS_PER_SECONDARY) {
      report.errors.push(
        `${secondary.secondaryId}: refund list exceeds the audit bound — audited first ${ORPHAN_AUDIT_REFUNDS_PER_SECONDARY}`,
      );
    }
    if (refunds.length === 0) continue;
    report.refundsScanned += refunds.length;

    const detailIds = refunds.map((r) => r.id);
    const details = await readRefundDetails(
      admin,
      detailIds,
      secondary.secondaryId,
      undefined,
    );
    if (!details.ok) {
      report.errors.push(`${secondary.secondaryId}: ${details.detail}`);
    }
    const agreements = await readAllAgreements(admin, secondary.secondaryId);
    if (!agreements.ok) {
      report.errors.push(`${secondary.secondaryId}: ${agreements.detail}`);
    }

    for (const refund of refunds) {
      // (a) the marker prefix is OUR prefix regardless of which row it names.
      if (typeof refund.note === "string" && refund.note.includes(MARKER_PREFIX)) {
        const [local] = await db.$queryRaw<{ status: string }[]>`
          SELECT "status" FROM "ShippingRefund"
          WHERE "refundId" = ${refund.id}
             OR "marker" = ${refund.note.slice(refund.note.indexOf(MARKER_PREFIX), refund.note.indexOf(MARKER_PREFIX) + MARKER_PREFIX.length + 36)}
          LIMIT 1`;
        const consistent =
          local !== undefined &&
          (local.status === "REFUND_RECORDED" || local.status === "VERIFIED");
        if (!consistent) {
          report.findings.push({
            severity: "HIGH",
            code: "ORPHAN_MARKER_REFUND",
            shop: args.shop,
            sourceOrderId: secondary.secondaryId,
            refundId: refund.id,
            detail:
              "a refund carries the MS-SHIPREFUND- marker but has no consistent local row",
          });
        }
      }

      // (b/c) app attribution: a typed RefundAgreement for our verified app
      // id linking this refund.
      if (!appId.ok || !agreements.ok) continue;
      const linked = agreements.agreements.filter(
        (a) =>
          a.typename === "RefundAgreement" &&
          a.reason === "REFUND" &&
          a.refundId === refund.id &&
          a.appId === appId.id,
      );
      if (linked.length === 0) continue;
      const node = details.ok ? details.byId.get(refund.id) : undefined;
      const [local] = await db.$queryRaw<{ status: string }[]>`
        SELECT "status" FROM "ShippingRefund"
        WHERE "refundId" = ${refund.id} LIMIT 1`;
      const consistent =
        local !== undefined &&
        (local.status === "REFUND_RECORDED" || local.status === "VERIFIED");
      if (node === undefined) {
        // The financial state is UNKNOWN — a failed or absent detail read
        // must never be reported as verified-zero. With no consistent local
        // row the refund is an unverified orphan, not a baseline candidate.
        if (!consistent) {
          report.findings.push({
            severity: "HIGH",
            code: "ORPHAN_APP_UNVERIFIED",
            shop: args.shop,
            sourceOrderId: secondary.secondaryId,
            refundId: refund.id,
            detail:
              "an app-attributed refund's financial state could not be " +
              "verified — the detail read was unavailable; NOT confirmed " +
              "zero-movement",
          });
        }
        continue;
      }
      const financial = isRefundFinancial(node);
      if (financial && !consistent) {
        report.findings.push({
          severity: "HIGH",
          code: "ORPHAN_APP_REFUND",
          shop: args.shop,
          sourceOrderId: secondary.secondaryId,
          refundId: refund.id,
          detail:
            "an app-attributed refund moved money with no consistent local row",
        });
      } else if (!financial) {
        report.findings.push({
          severity: "INFO",
          code: "ORPHAN_APP_ZERO",
          shop: args.shop,
          sourceOrderId: secondary.secondaryId,
          refundId: refund.id,
          detail:
            "an app-attributed refund moved nothing (baseline candidate)",
        });
      }
    }
  }
  void log;
  return report;
}
