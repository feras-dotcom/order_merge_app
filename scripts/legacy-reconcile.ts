// Converts leftover v1 MergeOperation rows (status PENDING_COMMIT / COMMITTED
// / NEEDS_REVIEW) into the v2 protocol (spec §11). Never abandons: an op whose
// live state cannot be proven goes to REVIEW_REQUIRED.
//
//   npx vite-node scripts/legacy-reconcile.ts            (dry run, prints table)
//   npx vite-node scripts/legacy-reconcile.ts --apply
//
// For each op:
//   * MergeOrderLock rows are inserted for every involved order. A lock
//     already owned by another v1 op flags BOTH ops REVIEW_REQUIRED; a lock
//     owned by a live v2 op flags only the v1 op (the v2 protocol owns it).
//   * NEEDS_REVIEW → phase REVIEW_REQUIRED.
//   * PENDING_COMMIT / COMMITTED → the primary's lines + agreements are read:
//     lines whose ManualDiscountApplication description starts
//     "Merged from #<secondary>" (both legacy separators) must equal the
//     secondary's current (variant, quantity) multiset and all sit in one
//     MergeShip OrderEditAgreement with happenedAt >= op.createdAt → APPLIED.
//     Then each secondary's live state gives its cancel sub-phase:
//       cancelled with a "merged into #<primary>" staff note → CANCEL_VERIFIED
//       (and a MergeRecord is written); cancelled otherwise → CANCEL_REVIEW;
//       open with the journal's cancelRequestedAt → CANCEL_IN_DOUBT
//       (+ synthetic UNKNOWN ORDER_CANCEL attempt); open and never requested
//       → CANCEL_READY. (Shopify's Order has no cancelRequestedAt field; the
//       v1 journal JSON is the only source.)
//     Anything else → REVIEW_REQUIRED.

import "./require-database-url";
import db from "../app/db.server";
import { newOpToken, DB_WALL } from "../app/lib/ownership.server";

const apply = process.argv.slice(2).includes("--apply");
const BLOCKING = ["PENDING_COMMIT", "COMMITTED", "NEEDS_REVIEW"];

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

type Line = { id: string; quantity: number; currentQuantity: number; variantId: string | null; description: string | null };
type Secondary = { id: string; name: string; items?: number; cancelRequestedAt?: string | null };

const multisetKey = (l: { variantId: string | null; quantity: number }) => `${l.variantId}:${l.quantity}`;
const multisetEqual = (a: { variantId: string | null; quantity: number }[], b: { variantId: string | null; quantity: number }[]) => {
  const counts = new Map<string, number>();
  for (const x of a) counts.set(multisetKey(x), (counts.get(multisetKey(x)) ?? 0) + 1);
  for (const x of b) counts.set(multisetKey(x), (counts.get(multisetKey(x)) ?? 0) - 1);
  return [...counts.values()].every((n) => n === 0);
};

/** Both legacy description formats: "Merged from #N — already paid" and
 *  "Merged from #N, already paid". */
const descriptionFor = (line: Line, secondaryName: string) =>
  (line.description ?? "").includes(`Merged from ${secondaryName}`);

async function readOrder(admin: any, id: string) {
  const res = await admin.graphql(EVIDENCE_QUERY, { variables: { id } });
  return (await res.json()).data?.order ?? null;
}

const linesOf = (order: any): Line[] =>
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

async function main() {
  const ops = await db.$queryRaw<any[]>`
    SELECT * FROM "MergeOperation" WHERE "status" = ANY(${BLOCKING}) AND "protocolVersion" = 1
    ORDER BY "createdAt"`;
  console.log(`v1 operations in a blocking status: ${ops.length}`);
  if (!ops.length) return;

  const appIdCache = new Map<string, string>();
  const { unauthenticated } = await import("../app/shopify.server");

  console.log("\nopId  status  →  verdict  reason\n");
  for (const op of ops) {
    const verdict = await classify(op, appIdCache, unauthenticated).catch((e) => ({
      phase: "REVIEW_REQUIRED",
      reason: `reconcile read failed: ${e?.message ?? e}`,
      secondaries: (op.secondaries as Secondary[]) ?? [],
      records: [] as Secondary[],
      syntheticAttempts: [] as string[],
      expectedTransfer: [] as any[],
    }));

    console.log(
      `${op.id}  ${op.status}  →  ${verdict.phase}  ${verdict.reason ?? ""}` +
        (apply ? "" : "  (dry run)"),
    );
    for (const s of verdict.secondaries ?? []) {
      console.log(`    ${s.name}  →  ${s.cancelPhase ?? "-"}`);
    }
    for (const r of verdict.records ?? []) {
      console.log(`    + MergeRecord  ${r.name} → ${op.primaryOrderName}`);
    }
    if (!apply) continue;

    // Lock every involved order. On a conflict with another v1 op, flag both.
    for (const orderId of op.involvedOrderIds as string[]) {
      const owner = await db.$queryRaw<{ operationId: string }[]>`
        SELECT "operationId" FROM "MergeOrderLock" WHERE "shop" = ${op.shop} AND "orderId" = ${orderId}`;
      if (owner.length && owner[0].operationId !== op.id) {
        // A v2 op's lock is never touched: only v1 rows get flagged here.
        await db.$executeRaw`
          UPDATE "MergeOperation" SET "phase" = 'REVIEW_REQUIRED', "status" = 'NEEDS_REVIEW',
            "reviewReason" = 'Order lock conflict with a concurrent merge operation during cutover.',
            "reviewRequiredAt" = ${DB_WALL}, "nextCheckAt" = ${DB_WALL}, "updatedAt" = ${DB_WALL}
          WHERE "id" = ${owner[0].operationId} AND "protocolVersion" = 1
            AND "phase" IS DISTINCT FROM 'REVIEW_REQUIRED'`;
        verdict.phase = "REVIEW_REQUIRED";
        verdict.reason = `lock on ${orderId} is owned by ${owner[0].operationId}`;
      } else if (!owner.length) {
        await db.$executeRaw`
          INSERT INTO "MergeOrderLock" ("id", "shop", "orderId", "operationId", "createdAt")
          VALUES (${crypto.randomUUID()}, ${op.shop}, ${orderId}, ${op.id}, ${DB_WALL})
          ON CONFLICT ("shop", "orderId") DO NOTHING`;
      }
    }

    // v2 shield: converted ops are non-terminal, so status reads NEEDS_REVIEW
    // to v1 consumers regardless of the phase we computed.
    const secondaries = verdict.secondaries.map((s: any) => ({ ...s }));
    await db.$executeRaw`
      UPDATE "MergeOperation"
      SET "protocolVersion" = 2, "phase" = ${verdict.phase},
          "status" = 'NEEDS_REVIEW',
          "opToken" = ${newOpToken()}, "expectedTransfer" = ${JSON.stringify(verdict.expectedTransfer ?? [])}::jsonb,
          "appliedEvidence" = ${verdict.appliedEvidence ? JSON.stringify(verdict.appliedEvidence) : null}::jsonb,
          "firstDispatchAt" = "createdAt", "nextCheckAt" = ${DB_WALL},
          "secondaries" = ${JSON.stringify(secondaries)}::jsonb,
          "reviewReason" = ${verdict.reason ?? null},
          "reviewRequiredAt" = CASE WHEN ${verdict.phase} = 'REVIEW_REQUIRED' THEN ${DB_WALL} ELSE "reviewRequiredAt" END,
          "updatedAt" = ${DB_WALL}
      WHERE "id" = ${op.id}`;

    for (const rec of verdict.records) {
      await db.$executeRaw`
        INSERT INTO "MergeRecord"
          ("id", "shop", "primaryOrderId", "primaryOrderName", "mergedOrderId",
           "mergedOrderName", "customerId", "itemsCombined", "operationId", "createdAt")
        VALUES (${crypto.randomUUID()}, ${op.shop}, ${op.primaryOrderId}, ${op.primaryOrderName},
                ${rec.id}, ${rec.name}, ${op.customerId}, ${rec.items ?? 0}, ${op.id}, ${DB_WALL})
        ON CONFLICT ("shop", "mergedOrderId") DO NOTHING`;
    }
    for (const att of verdict.syntheticAttempts ?? []) {
      await db.$executeRaw`
        INSERT INTO "MergeMutationAttempt"
          ("id", "operationId", "kind", "targetOrderId", "attemptNo", "state",
           "dispatchToken", "dispatchedAt", "respondedAt", "responseSummary")
        VALUES (${crypto.randomUUID()}, ${op.id}, 'ORDER_CANCEL', ${att},
                1, 'UNKNOWN', ${`legacy-${op.id}`}, ${op.createdAt}, ${DB_WALL},
                'synthetic: cancelRequestedAt was set before cutover')`;
    }
  }
  console.log(apply ? "\nApplied." : "\nDry run — pass --apply to write.");
}

async function classify(op: any, appIdCache: Map<string, string>, unauthenticated: any): Promise<any> {
  // NEEDS_REVIEW converts straight to v2 REVIEW_REQUIRED; its secondaries are
  // carried over so the review step still knows which orders to tag.
  if (op.status === "NEEDS_REVIEW") {
    const secondaries = ((op.secondaries as Secondary[]) ?? []).map((s, i) => ({
      ...s,
      cancelPhase: "TRANSFER_PENDING",
      secondaryIndex: i + 1,
    }));
    return {
      phase: "REVIEW_REQUIRED",
      reason: op.lastError ?? "v1 op flagged for review",
      secondaries,
      records: [],
      expectedTransfer: [],
    };
  }

  let admin;
  try {
    admin = (await unauthenticated.admin(op.shop)).admin;
  } catch (err: any) {
    return { phase: "REVIEW_REQUIRED", reason: `no session: ${err?.message ?? err}`, secondaries: [], records: [], expectedTransfer: [] };
  }
  let appId = appIdCache.get(op.shop);
  if (!appId) {
    const res: any = await admin.graphql(APP_QUERY);
    appId = (await res.json()).data?.currentAppInstallation?.app?.id;
    if (appId) appIdCache.set(op.shop, appId);
  }

  const primary = await readOrder(admin, op.primaryOrderId);
  if (!primary) return { phase: "REVIEW_REQUIRED", reason: "primary order no longer readable", secondaries: [], records: [], expectedTransfer: [] };
  const primaryLines = linesOf(primary);
  const agreements = (primary.agreements?.nodes ?? []).filter(
    (a: any) => a.__typename === "OrderEditAgreement" && a.app?.id === appId &&
      new Date(a.happenedAt).getTime() >= new Date(op.createdAt).getTime() - 2 * 60_000,
  );

  const secondaries: any[] = [];
  const records: Secondary[] = [];
  const syntheticAttempts: string[] = [];
  const expectedTransfer: any[] = [];
  const appliedLines: { secondaryId: string; lineItemId: string; variantId: string | null; quantity: number }[] = [];
  let evidenceAgreement: { id: string; happenedAt: string } | null = null;
  let index = 0;
  for (const s of (op.secondaries as Secondary[]) ?? []) {
    index += 1;
    const secondary = await readOrder(admin, s.id);
    if (!secondary) {
      return { phase: "REVIEW_REQUIRED", reason: `${s.name} no longer readable`, secondaries, records, expectedTransfer };
    }
    const sLines = linesOf(secondary).map((l) => ({ variantId: l.variantId, quantity: l.quantity }));
    expectedTransfer.push({
      secondaryId: s.id,
      secondaryIndex: index,
      lines: sLines.map((l) => ({ sourceLineItemId: null, variantId: l.variantId, quantity: l.quantity, description: `Merged from ${s.name}, already paid` })),
    });

    // Evidence: token lines on the primary for this secondary, matching the
    // secondary's multiset and inside one MergeShip agreement.
    const tokenLines = primaryLines.filter((l) => descriptionFor(l, s.name));
    const matchedAgreement = agreements.find((a: any) =>
      tokenLines.every((l) =>
        (a.sales?.nodes ?? []).some((n: any) => n.__typename === "ProductSale" && n.lineItem?.id === l.id),
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
      return { phase: "REVIEW_REQUIRED", reason: `no evidence the transfer to ${op.primaryOrderName} applied for ${s.name}`, secondaries, records, expectedTransfer };
    }
    // The protocol's cancel precondition needs appliedEvidence.lines — record
    // exactly which primary lines this secondary's transfer landed on.
    appliedLines.push(
      ...tokenLines.map((l) => ({
        secondaryId: s.id,
        lineItemId: l.id,
        variantId: l.variantId,
        quantity: l.currentQuantity,
      })),
    );
    evidenceAgreement = evidenceAgreement ?? { id: matchedAgreement.id, happenedAt: matchedAgreement.happenedAt };

    // Cancel sub-phase from live state.
    const staffNote = secondary.cancellation?.staffNote ?? "";
    if (secondary.cancelledAt && staffNote.includes(`merged into ${op.primaryOrderName}`)) {
      secondaries.push({ ...s, cancelPhase: "CANCEL_VERIFIED", cancelledAt: secondary.cancelledAt, staffNoteMatched: true });
      records.push(s);
    } else if (secondary.cancelledAt) {
      secondaries.push({ ...s, cancelPhase: "CANCEL_REVIEW", cancelledAt: secondary.cancelledAt });
    } else if (s.cancelRequestedAt) {
      secondaries.push({ ...s, cancelPhase: "CANCEL_IN_DOUBT" });
      syntheticAttempts.push(s.id);
    } else {
      secondaries.push({ ...s, cancelPhase: "CANCEL_READY" });
    }
  }
  return {
    phase: "APPLIED",
    reason: null,
    secondaries,
    records,
    syntheticAttempts,
    expectedTransfer,
    appliedEvidence: evidenceAgreement
      ? { agreementId: evidenceAgreement.id, happenedAt: evidenceAgreement.happenedAt, lines: appliedLines }
      : null,
  };
}

await main();
