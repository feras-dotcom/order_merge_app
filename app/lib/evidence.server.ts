// ── Transfer evidence (protocol v2, spec §6) ─────────────────────────────────
// The ONLY way an applied order edit is recognised: token lines on the
// primary — line items that were not there before the merge and carry a
// ManualDiscountApplication whose description embeds `MS-<opToken>-<index>` —
// all inside a single OrderEditAgreement attributed to this app and created
// no earlier than the dispatch. Anything else is ANOMALY; no token lines at
// all is NONE (the commit may never have applied).

import {
  gql,
  gqlData,
  gqlNullable,
  IncompletePageError,
  nextPageCursor,
  ShopifyGraphqlError,
  type AdminClient,
} from "./graphql.server";
import { MERGE_LINE_ITEM_FIELDS, ORDER_STATE_FIELDS } from "./merge.server";
import type { OrderState } from "./eligibility";
import type { ExpectedTransferEntry, OperationRecord } from "./operation-store.server";

// The two evidence connections paginate independently — a connection that
// finishes must never restart at cursor null while the other still reads,
// so each lives in its own document.
const EVIDENCE_LINES_QUERY = `#graphql
  query MergeOrderEvidenceLines($id: ID!, $after: String) {
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
    }
  }`;

const EVIDENCE_AGREEMENTS_QUERY = `#graphql
  query MergeOrderEvidenceAgreements($id: ID!, $after: String) {
    order(id: $id) {
      agreements(first: 50, after: $after) {
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

// One fresh request after a complete evidence scan: the primary's order
// state plus every token line by id, so a line or order mutated while the
// scan was still paging invalidates the evidence instead of authorizing the
// cancel from a stale snapshot.
export const TRANSFER_RECHECK_QUERY = `#graphql
  query MergeTransferRecheck($primaryId: ID!, $lineIds: [ID!]!) {
    order(id: $primaryId) {${ORDER_STATE_FIELDS}
    }
    nodes(ids: $lineIds) {
      ... on LineItem {
        __typename
        id
        quantity
        currentQuantity
        unfulfilledQuantity
        variant { id }
        originalUnitPriceSet { shopMoney { amount } }
        discountAllocations {
          allocatedAmountSet { shopMoney { amount } }
          discountApplication {
            __typename
            ... on ManualDiscountApplication {
              title
              description
            }
          }
        }
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

/** Fresh primary state and token-line values from the post-scan recheck —
 *  never persisted; cancelPrecondition consumes it to re-validate both
 *  orders against live state before cancelling. */
export interface TransferRecheck {
  primary: OrderState;
  lines: {
    id: string;
    variantId: string | null;
    quantity: number;
    currentQuantity: number;
    unfulfilledQuantity: number;
  }[];
}

export type TransferEvidence =
  | { kind: "APPLIED"; evidence: AppliedEvidence; recheck: TransferRecheck }
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

  // Each connection is paginated independently to completion: a truncated
  // agreement set would make "no MergeShip agreement in window" unprovable,
  // and a page that cannot prove its own completeness fails the scan.
  const items = new Map<string, any>();
  const agreementsById = new Map<string, any>();
  try {
    const itemsSeen = new Set<string>();
    let after: string | null = null;
    do {
      const order: any = await gqlNullable(
        admin,
        "Load merge evidence",
        EVIDENCE_LINES_QUERY,
        { id: op.primaryOrderId, after },
        "order",
      );
      if (!order) {
        return { kind: "ANOMALY", reason: "The primary order could not be loaded." };
      }
      for (const n of order.lineItems?.nodes ?? []) if (n?.id) items.set(n.id, n);
      after = nextPageCursor(order.lineItems, itemsSeen, "the primary's line items");
    } while (after);

    const agreementsSeen = new Set<string>();
    after = null;
    do {
      const order: any = await gqlNullable(
        admin,
        "Load merge evidence",
        EVIDENCE_AGREEMENTS_QUERY,
        { id: op.primaryOrderId, after },
        "order",
      );
      if (!order) {
        return { kind: "ANOMALY", reason: "The primary order could not be loaded." };
      }
      for (const n of order.agreements?.nodes ?? []) if (n?.id) agreementsById.set(n.id, n);
      after = nextPageCursor(order.agreements, agreementsSeen, "the primary's agreements");
    } while (after);
  } catch (err) {
    if (err instanceof IncompletePageError) {
      return {
        kind: "ANOMALY",
        reason: `evidence could not be inspected completely (${err.message})`,
      };
    }
    throw err;
  }
  const agreements = [...agreementsById.values()];

  const mergeShipAgreements = agreements.filter(
    (a) =>
      a.__typename === "OrderEditAgreement" &&
      a.app?.id === appId &&
      (windowStart === null || new Date(a.happenedAt).getTime() >= windowStart),
  );
  const mergeShipAgreementInWindow = mergeShipAgreements.length > 0;

  // A MergeShip agreement whose sales page is truncated or whose pageInfo is
  // absent cannot prove attribution — fail closed rather than conclude from
  // a partial picture.
  for (const agreement of mergeShipAgreements) {
    const salesPage = agreement.sales?.pageInfo;
    if (!salesPage || typeof salesPage !== "object" || salesPage.hasNextPage !== false) {
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

  // Post-scan recheck: one fresh request re-reads the primary's state and
  // every token line by id. A complete scan alone can never authorize the
  // cancel — evidence read on an earlier page may be stale by the time the
  // scan finishes.
  const recheck = await recheckTransfer(admin, op, tokenLines);
  if (typeof recheck === "string") return { kind: "ANOMALY", reason: recheck };
  return {
    kind: "APPLIED",
    evidence: { agreementId: agreement.id, happenedAt: agreement.happenedAt, lines },
    recheck,
  };
}

/** Re-reads every token line and the primary's order state in ONE request
 *  and requires the fresh values to match what the scan collected. Returns
 *  the recheck on success, an ANOMALY reason string otherwise. */
async function recheckTransfer(
  admin: AdminClient,
  op: OperationRecord,
  tokenLines: { item: any; secondaryIndex: number }[],
): Promise<TransferRecheck | string> {
  const data = await gqlData<{ order: any; nodes: (any | null)[] }>(
    admin,
    "Recheck merge evidence",
    TRANSFER_RECHECK_QUERY,
    { primaryId: op.primaryOrderId, lineIds: tokenLines.map((t) => t.item.id) },
  );
  if (!data?.order) return "The primary order could not be loaded.";
  const fresh = new Map<string, any>(
    (data.nodes ?? [])
      .filter((n) => n?.__typename === "LineItem" && n.id)
      .map((n) => [n.id as string, n]),
  );
  for (const { item, secondaryIndex } of tokenLines) {
    const line = fresh.get(item.id);
    if (!line) return `transferred line ${item.id} no longer exists`;
    let index: number | null = null;
    for (const alloc of line.discountAllocations ?? []) {
      const app_ = alloc.discountApplication;
      if (app_?.__typename !== "ManualDiscountApplication") continue;
      index = tokenIndex(app_.description, op.opToken ?? "");
      if (index !== null) break;
    }
    const allocated = (line.discountAllocations ?? []).reduce(
      (sum: number, a: any) => sum + Number(a.allocatedAmountSet?.shopMoney?.amount ?? 0),
      0,
    );
    const full = Number(line.originalUnitPriceSet?.shopMoney?.amount ?? 0) * (line.quantity ?? 0);
    if (
      (line.variant?.id ?? null) !== (item.variant?.id ?? null) ||
      line.quantity !== item.quantity ||
      line.currentQuantity !== line.quantity ||
      index !== secondaryIndex ||
      Math.abs(allocated - full) > FULL_DISCOUNT_TOLERANCE
    ) {
      return `Transferred line ${item.id} changed while evidence was being verified.`;
    }
  }
  if (fresh.size !== tokenLines.length) {
    return "The rechecked line set does not match the transfer.";
  }
  return {
    primary: data.order as OrderState,
    lines: tokenLines.map(({ item }) => {
      const line = fresh.get(item.id)!;
      return {
        id: line.id,
        variantId: line.variant?.id ?? null,
        quantity: line.quantity,
        currentQuantity: line.currentQuantity,
        unfulfilledQuantity: line.unfulfilledQuantity,
      };
    }),
  };
}

// ── Cancellation snapshot (one bounded request authorizes orderCancel) ────────

/** Largest secondary line-item page the one-request cancel snapshot may ask
 *  for, and the most transferred lines it may reread — both sized so the
 *  REQUESTED query cost stays under Shopify's 1,000-point single-query
 *  limit (measured). Anything larger is REVIEW, never a second page. */
export const CANCEL_SNAPSHOT_LINE_PAGE = 100;
export const CANCEL_SNAPSHOT_MAX_TRANSFER_LINES = 50;

export const CANCEL_SNAPSHOT_QUERY = `#graphql
  query MergeCancelSnapshot($primaryId: ID!, $secondaryId: ID!, $lineIds: [ID!]!) {
    primary: order(id: $primaryId) {${ORDER_STATE_FIELDS}
    }
    secondary: order(id: $secondaryId) {${ORDER_STATE_FIELDS}
      lineItems(first: ${CANCEL_SNAPSHOT_LINE_PAGE}) {
        nodes {${MERGE_LINE_ITEM_FIELDS}
        }
        pageInfo { hasNextPage }
      }
    }
    transferred: nodes(ids: $lineIds) {
      ... on LineItem {
        __typename
        id
        quantity
        currentQuantity
        unfulfilledQuantity
        variant { id }
        originalUnitPriceSet { shopMoney { amount } }
        discountAllocations {
          allocatedAmountSet { shopMoney { amount } }
          discountApplication {
            __typename
            ... on ManualDiscountApplication {
              title
              description
            }
          }
        }
      }
    }
  }`;

export interface CancelSnapshot {
  primary: OrderState | null;
  secondary:
    | (OrderState & {
        lineItems?: { nodes?: unknown; pageInfo?: { hasNextPage?: unknown } | null } | null;
      })
    | null;
  transferred: (any | null)[];
}

/** ONE request. Throws on transport/GraphQL/top-level errors (the driver's
 *  read-failure path handles it). */
export async function fetchCancelSnapshot(
  admin: AdminClient,
  primaryId: string,
  secondaryId: string,
  lineIds: string[],
): Promise<CancelSnapshot> {
  const data = await gqlData<CancelSnapshot>(admin, "Cancel snapshot", CANCEL_SNAPSHOT_QUERY, {
    primaryId,
    secondaryId,
    lineIds,
  });
  if (!data) throw new ShopifyGraphqlError("Cancel snapshot returned no payload.", false);
  return data;
}

/** Pure. Every persisted transferred line (all secondaries) must be present
 *  and intact in the snapshot: the node exists with __typename "LineItem" and
 *  that id; variant.id === stored.variantId; quantity === stored.quantity;
 *  currentQuantity === quantity; a ManualDiscountApplication description
 *  carrying MS-<opToken>-<secondaryIndex of the entry owning
 *  stored.secondaryId>; |allocated − originalUnit×quantity| ≤
 *  FULL_DISCOUNT_TOLERANCE; and the number of non-null LineItem nodes equals
 *  stored.length. For lines whose secondaryId === forSecondaryId,
 *  additionally unfulfilledQuantity === quantity. A reason string or null. */
export function transferredLinesMismatch(
  stored: AppliedEvidence["lines"],
  expected: ExpectedTransferEntry[],
  transferred: (any | null)[],
  opToken: string | null,
  forSecondaryId: string,
): string | null {
  if (opToken == null) {
    return "The operation has no token; the transferred lines cannot be verified.";
  }
  const indexOf = new Map(expected.map((e) => [e.secondaryId, e.secondaryIndex]));
  const fresh = new Map<string, any>(
    (transferred ?? [])
      .filter((n) => n?.__typename === "LineItem" && n.id)
      .map((n) => [n.id as string, n]),
  );
  for (const l of stored) {
    const line = fresh.get(l.lineItemId);
    if (!line) return `Transferred line ${l.lineItemId} no longer exists on the primary.`;
    let index: number | null = null;
    for (const alloc of line.discountAllocations ?? []) {
      const app_ = alloc.discountApplication;
      if (app_?.__typename !== "ManualDiscountApplication") continue;
      index = tokenIndex(app_.description, opToken);
      if (index !== null) break;
    }
    const allocated = (line.discountAllocations ?? []).reduce(
      (sum: number, a: any) => sum + Number(a.allocatedAmountSet?.shopMoney?.amount ?? 0),
      0,
    );
    const full = Number(line.originalUnitPriceSet?.shopMoney?.amount ?? 0) * (line.quantity ?? 0);
    if (
      (line.variant?.id ?? null) !== l.variantId ||
      line.quantity !== l.quantity ||
      line.currentQuantity !== line.quantity ||
      index !== indexOf.get(l.secondaryId) ||
      Math.abs(allocated - full) > FULL_DISCOUNT_TOLERANCE
    ) {
      return `Transferred line ${l.lineItemId} no longer matches the recorded transfer.`;
    }
    if (l.secondaryId === forSecondaryId && line.unfulfilledQuantity !== line.quantity) {
      return `Transferred line ${l.lineItemId} on the primary is no longer fully unfulfilled.`;
    }
  }
  if (fresh.size !== stored.length) {
    return "The transferred line set does not match the recorded transfer.";
  }
  return null;
}
