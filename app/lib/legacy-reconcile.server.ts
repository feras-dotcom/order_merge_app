// ── Legacy (protocol v1) reconciliation (spec §11, corrections C1) ───────────
// Converts leftover v1 MergeOperation rows (status PENDING_COMMIT / COMMITTED
// / NEEDS_REVIEW) into the v2 protocol. Never abandons: an op whose live state
// cannot be proven goes to REVIEW_REQUIRED carrying every secondary.
//
//   planLegacyReconciliation — pure classification per op → verdicts
//   applyLegacyVerdict      — one withOwnershipTx per op: locks, conversion,
//                             MergeRecords, synthetic attempts, all or nothing
//
// Cancellation certainty per secondary: cancelled + exact v1 staff note →
// CANCEL_VERIFIED (+ MergeRecord); cancelled otherwise → CANCEL_REVIEW; open
// with the journal's cancelRequestedAt → CANCEL_IN_DOUBT (+ synthetic UNKNOWN
// ORDER_CANCEL attempt); open without it → CANCEL_REVIEW — v1 recorded no
// write-ahead cancellation, so dispatch is uncertain. The op is APPLIED only
// when every secondary's transfer is proven AND every secondary is
// CANCEL_VERIFIED or CANCEL_IN_DOUBT.

import type { PrismaClient } from "@prisma/client";
import type { AdminClient } from "./graphql.server";
import type { AppliedEvidence } from "./evidence.server";
import { DB_WALL, newOpToken, withOwnershipTx } from "./ownership.server";

export const LEGACY_BLOCKING = ["PENDING_COMMIT", "COMMITTED", "NEEDS_REVIEW"];

const EVIDENCE_QUERY = `#graphql
  query LegacyEvidence($id: ID!) {
    order(id: $id) {
      cancelledAt
      displayFulfillmentStatus
      cancellation { staffNote }
      lineItems(first: 100) {
        nodes {
          id
          quantity
          currentQuantity
          variant { id }
          discountAllocations {
            discountApplication {
              __typename
              ... on ManualDiscountApplication { title description }
            }
          }
        }
      }
      agreements(first: 50) {
        nodes {
          __typename
          id
          happenedAt
          app { id }
          ... on OrderEditAgreement {
            sales(first: 100) {
              nodes {
                __typename
                quantity
                ... on ProductSale { lineItem { id } }
              }
            }
          }
        }
      }
    }
  }`;

const APP_QUERY = `#graphql
  query { currentAppInstallation { app { id } } }`;

/** v1 token-line discount description, both separators the old engine wrote:
 *  "Merged from #N, already paid" and "Merged from #N — already paid". The
 *  captured group is the WHOLE secondary name — a line for #123 must never
 *  prove a transfer for #12. */
export const LEGACY_DESCRIPTION_RE = /^Merged from (#\d+)(?:,| —) already paid/;
/** v1 cancellation staff note: the group must equal the op's primary name. */
export const LEGACY_STAFF_NOTE_RE = /\bmerged into (#\d+) by MergeShip\b/;

export interface LegacySecondary extends Record<string, unknown> {
  id: string;
  name: string;
  items?: number;
  cancelRequestedAt?: string | null;
}

export interface LegacyVerdictSecondary extends Record<string, unknown> {
  id: string;
  name: string;
  items?: number;
  secondaryIndex: number;
  cancelPhase: "TRANSFER_PENDING" | "CANCEL_VERIFIED" | "CANCEL_IN_DOUBT" | "CANCEL_REVIEW";
  cancelledAt?: string | null;
  staffNoteMatched?: boolean;
  cancelRequestedAt?: string | null;
}

export interface LegacyVerdict {
  phase: "APPLIED" | "REVIEW_REQUIRED";
  reason: string | null;
  secondaries: LegacyVerdictSecondary[];
  /** Secondaries whose v1 cancellation is proven — MergeRecords to write. */
  records: LegacySecondary[];
  /** Synthetic UNKNOWN ORDER_CANCEL attempts (v1 cancelRequestedAt rows). */
  syntheticAttempts: { targetOrderId: string; dispatchedAt: Date }[];
  expectedTransfer: unknown[];
  appliedEvidence: AppliedEvidence | null;
}

export interface LegacyPlan {
  op: any;
  verdict: LegacyVerdict;
}

export interface LegacyReconcileDeps {
  db: PrismaClient;
  /** Live admin client per shop, or null when no session exists. */
  adminFor: (shop: string) => Promise<AdminClient | null>;
  now: () => Date;
}

interface LegacyLine {
  id: string;
  quantity: number;
  currentQuantity: number;
  variantId: string | null;
  description: string | null;
}

const multisetKey = (l: { variantId: string | null; quantity: number }) =>
  `${l.variantId}:${l.quantity}`;

const multisetEqual = (
  a: { variantId: string | null; quantity: number }[],
  b: { variantId: string | null; quantity: number }[],
) => {
  const counts = new Map<string, number>();
  for (const x of a) counts.set(multisetKey(x), (counts.get(multisetKey(x)) ?? 0) + 1);
  for (const x of b) counts.set(multisetKey(x), (counts.get(multisetKey(x)) ?? 0) - 1);
  return [...counts.values()].every((n) => n === 0);
};

const secondaryName = (line: LegacyLine): string | null =>
  LEGACY_DESCRIPTION_RE.exec(line.description ?? "")?.[1] ?? null;

const linesOf = (order: any): LegacyLine[] =>
  (order?.lineItems?.nodes ?? []).map((n: any) => ({
    id: n.id,
    quantity: n.quantity,
    currentQuantity: n.currentQuantity ?? n.quantity,
    variantId: n.variant?.id ?? null,
    description:
      (n.discountAllocations ?? [])
        .map((a: any) => a.discountApplication?.description)
        .find(Boolean) ?? null,
  }));

const allSecondaries = (op: any): (LegacySecondary & { secondaryIndex: number })[] =>
  ((op.secondaries as LegacySecondary[]) ?? []).map((s, i) => ({
    ...s,
    secondaryIndex: i + 1,
  }));

/** v1 ops in a blocking status, oldest first. */
export async function listBlockingLegacyOps(db: PrismaClient): Promise<any[]> {
  return db.$queryRaw<any[]>`
    SELECT * FROM "MergeOperation" WHERE "status" = ANY(${LEGACY_BLOCKING}) AND "protocolVersion" = 1
    ORDER BY "createdAt"`;
}

/** Plans every blocking v1 op. The overlap pre-pass runs BEFORE any live
 *  read: two v1 ops sharing an involved order are both REVIEW_REQUIRED. */
export async function planLegacyReconciliation(
  deps: LegacyReconcileDeps,
  ops?: any[],
): Promise<LegacyPlan[]> {
  const blocking = ops ?? (await listBlockingLegacyOps(deps.db));

  // Overlap pre-pass: no live reads for ops that share an involved order.
  const byOrder = new Map<string, number>();
  for (const op of blocking) {
    for (const orderId of (op.involvedOrderIds as string[]) ?? []) {
      byOrder.set(orderId, (byOrder.get(orderId) ?? 0) + 1);
    }
  }
  const overlapped = new Set(
    blocking.filter((op) =>
      ((op.involvedOrderIds as string[]) ?? []).some((orderId) => (byOrder.get(orderId) ?? 0) > 1),
    ),
  );

  const appIdCache = new Map<string, string>();
  const plans: LegacyPlan[] = [];
  for (const op of blocking) {
    if (overlapped.has(op)) {
      plans.push({
        op,
        verdict: {
          phase: "REVIEW_REQUIRED",
          reason: "overlapping legacy operations",
          secondaries: allSecondaries(op).map((s) => ({ ...s, cancelPhase: "CANCEL_REVIEW" as const })),
          records: [],
          syntheticAttempts: [],
          expectedTransfer: [],
          appliedEvidence: null,
        },
      });
      continue;
    }
    const verdict = await classify(op, deps, appIdCache).catch((e: any) => ({
      phase: "REVIEW_REQUIRED" as const,
      reason: `reconcile read failed: ${e?.message ?? e}`,
      secondaries: allSecondaries(op).map((s) => ({ ...s, cancelPhase: "CANCEL_REVIEW" as const })),
      records: [],
      syntheticAttempts: [],
      expectedTransfer: [],
      appliedEvidence: null,
    }));
    plans.push({ op, verdict });
  }
  return plans;
}

async function readOrder(admin: AdminClient, id: string) {
  const res = await admin.graphql(EVIDENCE_QUERY, { variables: { id } });
  return (await res.json()).data?.order ?? null;
}

async function classify(
  op: any,
  deps: LegacyReconcileDeps,
  appIdCache: Map<string, string>,
): Promise<LegacyVerdict> {
  const carried = allSecondaries(op);
  /** REVIEW_REQUIRED carrying EVERY secondary — unprocessed ones land as
   *  CANCEL_REVIEW so the review step still knows which orders to tag. */
  const review = (
    reason: string,
    done: LegacyVerdictSecondary[] = [],
    rest?: (LegacySecondary & { secondaryIndex: number })[],
    records: LegacySecondary[] = [],
    syntheticAttempts: LegacyVerdict["syntheticAttempts"] = [],
    expectedTransfer: unknown[] = [],
    appliedEvidence: AppliedEvidence | null = null,
  ): LegacyVerdict => ({
    phase: "REVIEW_REQUIRED",
    reason,
    secondaries: [
      ...done,
      ...(rest ?? carried.slice(done.length)).map((s) => ({ ...s, cancelPhase: "CANCEL_REVIEW" as const })),
    ],
    records,
    syntheticAttempts,
    expectedTransfer,
    appliedEvidence,
  });

  // NEEDS_REVIEW converts straight to v2 REVIEW_REQUIRED; its secondaries are
  // carried over so the review step still knows which orders to tag.
  if (op.status === "NEEDS_REVIEW") {
    return {
      phase: "REVIEW_REQUIRED",
      reason: op.lastError ?? "v1 op flagged for review",
      secondaries: carried.map((s) => ({ ...s, cancelPhase: "TRANSFER_PENDING" as const })),
      records: [],
      syntheticAttempts: [],
      expectedTransfer: [],
      appliedEvidence: null,
    };
  }

  const admin = await deps.adminFor(op.shop);
  if (!admin) return review(`no offline session for ${op.shop}`);

  let appId = appIdCache.get(op.shop);
  if (!appId) {
    const res: any = await admin.graphql(APP_QUERY);
    appId = (await res.json()).data?.currentAppInstallation?.app?.id;
    if (appId) appIdCache.set(op.shop, appId);
  }
  if (!appId) return review("could not resolve this app's id");

  const primary = await readOrder(admin, op.primaryOrderId);
  if (!primary) return review("primary order no longer readable");
  const primaryLines = linesOf(primary);
  const agreements = (primary.agreements?.nodes ?? []).filter(
    (a: any) =>
      a.__typename === "OrderEditAgreement" &&
      a.app?.id === appId &&
      new Date(a.happenedAt).getTime() >= new Date(op.createdAt).getTime() - 2 * 60_000,
  );

  const secondaries: LegacyVerdictSecondary[] = [];
  const records: LegacySecondary[] = [];
  const syntheticAttempts: LegacyVerdict["syntheticAttempts"] = [];
  const expectedTransfer: unknown[] = [];
  const appliedLines: AppliedEvidence["lines"] = [];
  let evidenceAgreement: { id: string; happenedAt: string } | null = null;

  for (let i = 0; i < carried.length; i++) {
    const s = carried[i];
    const secondary = await readOrder(admin, s.id);
    if (!secondary) {
      return review(
        `${s.name} no longer readable`,
        secondaries,
        carried.slice(i),
        records,
        syntheticAttempts,
        expectedTransfer,
      );
    }
    const sLines = linesOf(secondary).map((l) => ({ variantId: l.variantId, quantity: l.quantity }));
    expectedTransfer.push({
      secondaryId: s.id,
      secondaryIndex: s.secondaryIndex,
      lines: sLines.map((l) => ({
        sourceLineItemId: null,
        variantId: l.variantId,
        quantity: l.quantity,
        description: `Merged from ${s.name}, already paid`,
      })),
    });

    // Evidence: token lines on the primary for THIS secondary — the exact
    // name must appear inside the delimiter-aware description — matching the
    // secondary's multiset and inside one MergeShip agreement.
    const tokenLines = primaryLines.filter((l) => secondaryName(l) === s.name);
    const matchedAgreement = agreements.find((a: any) =>
      tokenLines.every((l) =>
        (a.sales?.nodes ?? []).some(
          (n: any) => n.__typename === "ProductSale" && n.lineItem?.id === l.id,
        ),
      ),
    );
    const applied =
      tokenLines.length > 0 &&
      multisetEqual(
        tokenLines.map((l) => ({ variantId: l.variantId, quantity: l.currentQuantity })),
        sLines,
      ) &&
      matchedAgreement != null;
    if (!applied) {
      return review(
        `no evidence the transfer to ${op.primaryOrderName} applied for ${s.name}`,
        secondaries,
        carried.slice(i),
        records,
        syntheticAttempts,
        expectedTransfer,
      );
    }
    appliedLines.push(
      ...tokenLines.map((l) => ({
        secondaryId: s.id,
        lineItemId: l.id,
        variantId: l.variantId,
        quantity: l.currentQuantity,
      })),
    );
    evidenceAgreement = evidenceAgreement ?? {
      id: matchedAgreement.id,
      happenedAt: matchedAgreement.happenedAt,
    };

    // Cancel sub-phase from live state. An open secondary WITHOUT the
    // journal's cancelRequestedAt is CANCEL_REVIEW, never CANCEL_READY — v1
    // kept no write-ahead record, so whether a cancel was dispatched is
    // unprovable.
    const staffNote = secondary.cancellation?.staffNote ?? "";
    const noteMatch = LEGACY_STAFF_NOTE_RE.exec(staffNote);
    if (secondary.cancelledAt && noteMatch?.[1] === op.primaryOrderName) {
      secondaries.push({
        ...s,
        cancelPhase: "CANCEL_VERIFIED",
        cancelledAt: secondary.cancelledAt,
        staffNoteMatched: true,
      });
      records.push(s);
    } else if (secondary.cancelledAt) {
      secondaries.push({ ...s, cancelPhase: "CANCEL_REVIEW", cancelledAt: secondary.cancelledAt });
    } else if (s.cancelRequestedAt) {
      secondaries.push({ ...s, cancelPhase: "CANCEL_IN_DOUBT" });
      syntheticAttempts.push({ targetOrderId: s.id, dispatchedAt: new Date(s.cancelRequestedAt) });
    } else {
      secondaries.push({ ...s, cancelPhase: "CANCEL_REVIEW" });
    }
  }

  const allResolved = secondaries.every(
    (s) => s.cancelPhase === "CANCEL_VERIFIED" || s.cancelPhase === "CANCEL_IN_DOUBT",
  );
  return {
    phase: allResolved ? "APPLIED" : "REVIEW_REQUIRED",
    reason: allResolved
      ? null
      : "one or more secondaries could not be proven cancelled or in-flight",
    secondaries,
    records,
    syntheticAttempts,
    expectedTransfer,
    appliedEvidence: evidenceAgreement
      ? { agreementId: evidenceAgreement.id, happenedAt: evidenceAgreement.happenedAt, lines: appliedLines }
      : null,
  };
}

/** Applies one verdict inside a single transaction: lock rows, the op's v2
 *  conversion, MergeRecords and synthetic attempts — all or nothing. On a
 *  lock conflict the owner is flagged REVIEW_REQUIRED when it is a
 *  legacy-origin op (calculatedOrderId IS NULL) that is still non-terminal,
 *  and this op goes to REVIEW_REQUIRED. Idempotent: ops already at
 *  protocolVersion 2 are skipped. */
export async function applyLegacyVerdict(
  db: PrismaClient,
  op: any,
  verdict: LegacyVerdict,
): Promise<void> {
  if (op.protocolVersion === 2) return;
  await withOwnershipTx(db, async (tx) => {
    let phase = verdict.phase;
    let reason = verdict.reason;

    for (const orderId of (op.involvedOrderIds as string[]) ?? []) {
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "MergeOrderLock" ("id", "shop", "orderId", "operationId", "createdAt")
        VALUES (${crypto.randomUUID()}, ${op.shop}, ${orderId}, ${op.id}, ${DB_WALL})
        ON CONFLICT ("shop", "orderId") DO NOTHING
        RETURNING "id"`;
      if (inserted.length) continue;
      const [owner] = await tx.$queryRaw<
        { operationId: string; legacy: boolean; nonTerminal: boolean }[]
      >`
        SELECT l."operationId",
               (o."calculatedOrderId" IS NULL) AS legacy,
               (COALESCE(o."phase", o."status") NOT IN ('COMPLETED', 'ABANDONED')) AS "nonTerminal"
        FROM "MergeOrderLock" l
        JOIN "MergeOperation" o ON o.id = l."operationId"
        WHERE l."shop" = ${op.shop} AND l."orderId" = ${orderId}`;
      if (!owner || owner.operationId === op.id) continue;
      if (owner.legacy && owner.nonTerminal) {
        await tx.$executeRaw`
          UPDATE "MergeOperation" SET "phase" = 'REVIEW_REQUIRED', "status" = 'NEEDS_REVIEW',
            "reviewReason" = 'Order lock conflict with a concurrent merge operation during cutover.',
            "reviewRequiredAt" = ${DB_WALL}, "nextCheckAt" = ${DB_WALL}, "updatedAt" = ${DB_WALL}
          WHERE "id" = ${owner.operationId} AND "phase" IS DISTINCT FROM 'REVIEW_REQUIRED'`;
      }
      phase = "REVIEW_REQUIRED";
      reason = `lock on ${orderId} is owned by ${owner.operationId}`;
    }

    const n = await tx.$executeRaw`
      UPDATE "MergeOperation"
      SET "protocolVersion" = 2, "phase" = ${phase},
          "status" = 'NEEDS_REVIEW',
          "opToken" = ${`LEGACY-${newOpToken()}`},
          "expectedTransfer" = ${JSON.stringify(verdict.expectedTransfer ?? [])}::jsonb,
          "appliedEvidence" = ${verdict.appliedEvidence ? JSON.stringify(verdict.appliedEvidence) : null}::jsonb,
          "firstDispatchAt" = "createdAt", "nextCheckAt" = ${DB_WALL},
          "secondaries" = ${JSON.stringify(verdict.secondaries)}::jsonb,
          "reviewReason" = ${reason ?? null},
          "reviewRequiredAt" = CASE WHEN ${phase} = 'REVIEW_REQUIRED' THEN ${DB_WALL} ELSE "reviewRequiredAt" END,
          "updatedAt" = ${DB_WALL}
      WHERE "id" = ${op.id} AND "protocolVersion" = 1`;
    if (n === 0) return; // a concurrent applier converted it first

    for (const rec of verdict.records) {
      await tx.$executeRaw`
        INSERT INTO "MergeRecord"
          ("id", "shop", "primaryOrderId", "primaryOrderName", "mergedOrderId",
           "mergedOrderName", "customerId", "itemsCombined", "operationId", "createdAt")
        VALUES (${crypto.randomUUID()}, ${op.shop}, ${op.primaryOrderId}, ${op.primaryOrderName},
                ${rec.id}, ${rec.name}, ${op.customerId}, ${rec.items ?? 0}, ${op.id}, ${DB_WALL})
        ON CONFLICT ("shop", "mergedOrderId") DO NOTHING`;
    }
    for (const att of verdict.syntheticAttempts) {
      await tx.$executeRaw`
        INSERT INTO "MergeMutationAttempt"
          ("id", "operationId", "kind", "targetOrderId", "attemptNo", "state",
           "dispatchToken", "dispatchedAt", "respondedAt", "responseSummary")
        VALUES (${crypto.randomUUID()}, ${op.id}, 'ORDER_CANCEL', ${att.targetOrderId},
                1, 'UNKNOWN', ${`legacy-${op.id}`},
                (${att.dispatchedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
                ${DB_WALL}, 'synthetic: cancelRequestedAt was set before cutover')`;
    }
  });
}
