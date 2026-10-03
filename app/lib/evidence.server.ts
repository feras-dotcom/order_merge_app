// ── Transfer evidence (protocol v2, spec §6) ─────────────────────────────────
// The ONLY way an applied order edit is recognised: token lines on the
// primary — line items that were not there before the merge and carry a
// ManualDiscountApplication whose description embeds `MS-<opToken>-<index>` —
// all inside a single OrderEditAgreement attributed to this app and created
// no earlier than the dispatch. Anything else is ANOMALY; no token lines at
// all is NONE (the commit may never have applied).

import { gql, gqlNullable, type AdminClient } from "./graphql.server";
import type { ExpectedTransferEntry, OperationRecord } from "./operation-store.server";

export const ORDER_EVIDENCE_QUERY = `#graphql
  query MergeOrderEvidence($id: ID!, $after: String, $agreementsAfter: String) {
    order(id: $id) {
      lineItems(first: 100, after: $after) {
        nodes {
          id
          quantity
          currentQuantity
          variant { id }
          originalUnitPriceSet { shopMoney { amount } }
          discountAllocations {
            allocatedAmountSet { shopMoney { amount } }
            discountApplication {
              __typename
              ... on ManualDiscountApplication { title description }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
      agreements(first: 50, after: $agreementsAfter) {
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
                actionType
                ... on ProductSale { lineItem { id } }
              }
              pageInfo { hasNextPage }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

export const CURRENT_APP_QUERY = `#graphql
  query MergeCurrentApp {
    currentAppInstallation { app { id } }
  }`;

/** Per-process app-id cache keyed by shop (the app id never changes). */
const appIdCache = new Map<string, Promise<string>>();

/** MergeShip's own app id on the shop — distinguishes MergeShip's edit
 *  agreements from edits made by the merchant or other apps. */
export function resolveAppId(admin: AdminClient, shop: string): Promise<string> {
  let cached = appIdCache.get(shop);
  if (!cached) {
    const pending = gql<{ app: { id: string } }>(
      admin,
      "Resolve app id",
      CURRENT_APP_QUERY,
      {},
      "currentAppInstallation",
      null,
    ).then((r) => r.app.id);
    // A rejected lookup must not poison the cache — the next caller retries.
    pending.catch(() => {
      if (appIdCache.get(shop) === pending) appIdCache.delete(shop);
    });
    cached = pending;
    appIdCache.set(shop, cached);
  }
  return cached;
}

export interface AppliedEvidence {
  agreementId: string;
  happenedAt: string;
  lines: { secondaryId: string; lineItemId: string; variantId: string | null; quantity: number }[];
}

export type TransferEvidence =
  | { kind: "APPLIED"; evidence: AppliedEvidence }
  | { kind: "ANOMALY"; reason: string }
  | { kind: "NONE"; mergeShipAgreementInWindow: boolean };

/** How far back before firstDispatchAt an agreement still counts as ours —
 *  covers clock skew between dispatch record and Shopify's happenedAt. */
export const AGREEMENT_GRACE_MS = 2 * 60_000;
/** A token line must be discounted to zero: |allocated - unit*qty| <= this. */
const FULL_DISCOUNT_TOLERANCE = 0.005;

const tokenIndex = (description: string | null | undefined, opToken: string) => {
  const match = new RegExp(`(?:^|[^0-9A-Z])MS-${opToken}-(\\d+)(?!\\d)`).exec(
    description ?? "",
  );
  return match ? Number(match[1]) : null;
};

/**
 * Reads the primary's line items and sales agreements and decides whether the
 * committed order edit for this operation verifiably applied. Throws on
 * transport/GraphQL failures (callers treat them as transient).
 */
export async function verifyTransferEvidence(
  admin: AdminClient,
  op: OperationRecord,
  appId: string,
): Promise<TransferEvidence> {
  const expected = (op.expectedTransfer ?? []) as ExpectedTransferEntry[];
  const beforeIds = new Set(op.primaryLineItemIdsBefore);
  const windowStart =
    op.firstDispatchAt == null ? null : op.firstDispatchAt.getTime() - AGREEMENT_GRACE_MS;

  // Both connections are paginated to completion: an agreement set cut off
  // mid-page would make "no MergeShip agreement in window" unprovable.
  const items = new Map<string, any>();
  const agreementsById = new Map<string, any>();
  let itemsAfter: string | null = null;
  let agreementsAfter: string | null = null;
  do {
    const order: any = await gqlNullable(
      admin,
      "Load merge evidence",
      ORDER_EVIDENCE_QUERY,
      { id: op.primaryOrderId, after: itemsAfter, agreementsAfter },
      "order",
    );
    if (!order) {
      return { kind: "ANOMALY", reason: "The primary order could not be loaded." };
    }
    for (const n of order.lineItems?.nodes ?? []) if (n?.id) items.set(n.id, n);
    for (const n of order.agreements?.nodes ?? []) if (n?.id) agreementsById.set(n.id, n);
    itemsAfter = order.lineItems?.pageInfo?.hasNextPage ? order.lineItems.pageInfo.endCursor : null;
    agreementsAfter = order.agreements?.pageInfo?.hasNextPage
      ? order.agreements.pageInfo.endCursor
      : null;
  } while (itemsAfter || agreementsAfter);
  const agreements = [...agreementsById.values()];

  const mergeShipAgreements = agreements.filter(
    (a) =>
      a.__typename === "OrderEditAgreement" &&
      a.app?.id === appId &&
      (windowStart === null || new Date(a.happenedAt).getTime() >= windowStart),
  );
  const mergeShipAgreementInWindow = mergeShipAgreements.length > 0;

  // A MergeShip agreement whose sales are truncated cannot prove attribution
  // — fail closed rather than conclude from a partial picture.
  for (const agreement of mergeShipAgreements) {
    if (agreement.sales?.pageInfo?.hasNextPage) {
      return { kind: "ANOMALY", reason: "evidence could not be inspected completely" };
    }
  }

  // Token lines: line items that did not exist at plan time AND carry the
  // op's token in a manual discount description.
  const tokenLines: { item: any; secondaryIndex: number }[] = [];
  for (const item of items.values()) {
    if (beforeIds.has(item.id)) continue;
    for (const alloc of item.discountAllocations ?? []) {
      const app_ = alloc.discountApplication;
      if (app_?.__typename !== "ManualDiscountApplication") continue;
      const idx = tokenIndex(app_.description, op.opToken ?? "");
      if (idx !== null) {
        if (item.currentQuantity != null && item.currentQuantity !== item.quantity) {
          return {
            kind: "ANOMALY",
            reason: `Token line ${item.id} was edited after the merge.`,
          };
        }
        tokenLines.push({ item, secondaryIndex: idx });
        break;
      }
    }
  }
  if (!tokenLines.length) return { kind: "NONE", mergeShipAgreementInWindow };
  if (windowStart === null) {
    return { kind: "ANOMALY", reason: "MergeShip token lines exist but the op has no dispatch record." };
  }

  // Per-secondary multiset match of (variantId, quantity).
  const byIndex = new Map<number, any[]>();
  for (const t of tokenLines) {
    byIndex.set(t.secondaryIndex, [...(byIndex.get(t.secondaryIndex) ?? []), t.item]);
  }
  const expectedByIndex = new Map(expected.map((e) => [e.secondaryIndex, e]));
  const multisetKey = (variantId: string | null, quantity: number) => `${variantId}×${quantity}`;
  for (const idx of byIndex.keys()) {
    if (!expectedByIndex.has(idx)) {
      return { kind: "ANOMALY", reason: `Token lines reference unknown secondary index ${idx}.` };
    }
  }
  for (const [idx, entry] of expectedByIndex) {
    const have = (byIndex.get(idx) ?? []).map((i) => multisetKey(i.variant?.id ?? null, i.quantity));
    const want = entry.lines.map((l) => multisetKey(l.variantId, l.quantity));
    const counts = new Map<string, number>();
    for (const h of have) counts.set(h, (counts.get(h) ?? 0) + 1);
    for (const w of want) counts.set(w, (counts.get(w) ?? 0) - 1);
    if ([...counts.values()].some((n) => n !== 0)) {
      const secondary = expected.find((e) => e.secondaryIndex === idx);
      return {
        kind: "ANOMALY",
        reason: `Transferred items for ${secondary?.secondaryId ?? `index ${idx}`} do not match the recorded edit.`,
      };
    }
  }

  // Fully discounted: the token discount must cover the line's full price.
  for (const { item } of tokenLines) {
    const allocated = (item.discountAllocations ?? []).reduce(
      (sum: number, a: any) => sum + Number(a.allocatedAmountSet?.shopMoney?.amount ?? 0),
      0,
    );
    const full = Number(item.originalUnitPriceSet?.shopMoney?.amount ?? 0) * item.quantity;
    if (Math.abs(allocated - full) > FULL_DISCOUNT_TOLERANCE) {
      return {
        kind: "ANOMALY",
        reason: `Token line ${item.id} is not fully discounted (${allocated} of ${full}).`,
      };
    }
  }

  // Every token line must be sold by exactly ONE MergeShip agreement inside
  // the dispatch window — an ORDER sale of exactly the line's quantity.
  const lineToSales = new Map<string, { agreement: any; sale: any }[]>();
  for (const agreement of mergeShipAgreements) {
    for (const sale of agreement.sales?.nodes ?? []) {
      if (sale.__typename !== "ProductSale" || !sale.lineItem?.id) continue;
      lineToSales.set(sale.lineItem.id, [...(lineToSales.get(sale.lineItem.id) ?? []), { agreement, sale }]);
    }
  }
  const agreementIds = new Set<string>();
  for (const { item } of tokenLines) {
    const found = lineToSales.get(item.id) ?? [];
    if (found.length !== 1) {
      return {
        kind: "ANOMALY",
        reason: `Token line ${item.id} is attributed to ${found.length} MergeShip edits (expected exactly one).`,
      };
    }
    const { agreement, sale } = found[0];
    if (sale.actionType !== "ORDER" || sale.quantity !== item.quantity) {
      return {
        kind: "ANOMALY",
        reason: `Token line ${item.id}'s sale record does not match the transferred quantity.`,
      };
    }
    agreementIds.add(agreement.id);
  }
  if (agreementIds.size !== 1) {
    return {
      kind: "ANOMALY",
      reason: `Token lines span ${agreementIds.size} MergeShip edits (expected exactly one).`,
    };
  }

  const agreement = mergeShipAgreements.find((a) => a.id === [...agreementIds][0]);
  const lines = tokenLines.map(({ item, secondaryIndex }) => ({
    secondaryId: expectedByIndex.get(secondaryIndex)?.secondaryId ?? "",
    lineItemId: item.id,
    variantId: item.variant?.id ?? null,
    quantity: item.quantity,
  }));
  return {
    kind: "APPLIED",
    evidence: { agreementId: agreement.id, happenedAt: agreement.happenedAt, lines },
  };
}
