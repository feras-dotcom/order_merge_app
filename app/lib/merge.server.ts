// ── Merge execution ───────────────────────────────────────────────────────────
// Merge execution and recovery used by the background webhook handler
// (webhooks.orders.create.tsx). Successful consolidations are recorded in the
// MergeRecord table, which feeds the dashboard (app._index.tsx).
//
// Safety model
//   • Nothing is changed until every eligibility rule passes on freshly loaded
//     state (see eligibility.ts), the location rule passes (every order's items
//     verifiably assigned to one shared location, or a single-location shop —
//     see resolveMergeLocation), and the state is re-verified immediately
//     before the commit.
//   • Every Shopify call goes through gql(), which fails on transport errors,
//     top-level GraphQL errors, missing payloads and userErrors.
//   • A MergeOperation journal row is written BEFORE the primary's order edit
//     is committed. After the commit, each secondary is cancelled and the
//     cancellation is confirmed by reading the order back (orderCancel is
//     asynchronous). Only when every secondary is confirmed cancelled is the
//     merge reported as successful.
//   • Interrupted merges are resumed by resumeIncompleteMerges(). When the
//     outcome cannot be determined, the operation is marked NEEDS_REVIEW, the
//     orders are tagged/annotated in Shopify, and they are excluded from every
//     future merge.

import { gql, ShopifyGraphqlError, type AdminClient } from "./graphql.server";
import {
  REVIEW_TAG,
  evaluateFulfillmentLocation,
  evaluateMergeGroup,
  selectCompatibleOrders,
  type OrderFulfillmentOrders,
  type MergeLineItem,
  type OrderState,
} from "./eligibility";
import {
  prismaMergeJournal,
  type JournalSecondary,
  type MergeJournal,
  type MergeOperationRecord,
} from "./merge-journal.server";

export {
  buildAddressKey,
  buildGroupKey,
  normalizeAddressLine,
  normalizeShippingTitle,
} from "./eligibility";
export type { AdminClient } from "./graphql.server";

export { REVIEW_TAG };

// ── Dependencies (injectable for tests) ───────────────────────────────────────

export interface MergeDeps {
  journal: MergeJournal;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** Reads of the secondary after orderCancel before giving up for now. */
  cancelPollAttempts: number;
  cancelPollIntervalMs: number;
  /** Rejected cancellations tolerated before escalating to NEEDS_REVIEW. */
  maxCancelAttempts: number;
  /** A PENDING_COMMIT op is only reconciled once it is at least this old, so
   *  a slow commit that is still being applied is never misjudged. */
  pendingCommitGraceMs: number;
  /** How long an accepted orderCancel is awaited before it is re-issued. */
  cancelRequestGraceMs: number;
}

export const defaultMergeDeps = (): MergeDeps => ({
  journal: prismaMergeJournal,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
  cancelPollAttempts: 6,
  cancelPollIntervalMs: 1500,
  maxCancelAttempts: 3,
  pendingCommitGraceMs: 5 * 60 * 1000,
  cancelRequestGraceMs: 10 * 60 * 1000,
});

// ── Result ────────────────────────────────────────────────────────────────────

export type MergeOutcome =
  /** Every secondary is confirmed cancelled; the merge is complete. */
  | "merged"
  /** Not eligible; nothing was changed. */
  | "skipped"
  /** Failed before the commit; nothing was changed. */
  | "failed"
  /** Committed (or possibly committed) but not yet confirmed complete. The
   *  journal keeps the orders blocked and the merge is resumed later. */
  | "in_progress"
  /** Outcome could not be confirmed; orders are flagged for the merchant. */
  | "needs_review";

export interface MergeResult {
  outcome: MergeOutcome;
  reason?: string;
  primaryName?: string;
  mergedCount?: number;
  operationId?: string;
}

// ── Shopify reads ─────────────────────────────────────────────────────────────

const ORDER_STATE_QUERY = `#graphql
  query MergeOrderState($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
        name
        createdAt
        cancelledAt
        closed
        displayFinancialStatus
        displayFulfillmentStatus
        riskLevel
        currencyCode
        presentmentCurrencyCode
        note
        tags
        customer { id }
        shippingAddress {
          firstName
          lastName
          company
          address1
          address2
          city
          provinceCode
          zip
          countryCodeV2
        }
        shippingLines(first: 5) {
          nodes {
            title
            code
            source
            carrierIdentifier
            custom
            originalPriceSet { shopMoney { amount currencyCode } }
          }
        }
        fulfillments(first: 5) { id }
      }
    }
  }`;

async function fetchOrderStates(admin: AdminClient, ids: string[]): Promise<OrderState[]> {
  const nodes = await gql<any[]>(admin, "Load orders", ORDER_STATE_QUERY, { ids }, "nodes", null);
  const byId = new Map(nodes.filter((n) => n?.id).map((n) => [n.id as string, n as OrderState]));
  const orders = ids.map((id) => byId.get(id));
  if (orders.some((o) => !o)) {
    throw new ShopifyGraphqlError("Could not load every order involved in the merge.", false);
  }
  return orders as OrderState[];
}

const LINE_ITEMS_QUERY = `#graphql
  query MergeOrderLineItems($id: ID!, $after: String) {
    order(id: $id) {
      lineItems(first: 100, after: $after) {
        nodes {
          id
          name
          quantity
          currentQuantity
          unfulfilledQuantity
          nonFulfillableQuantity
          requiresShipping
          isGiftCard
          variant { id }
          customAttributes { key value }
          sellingPlan { name }
          lineItemGroup { id }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

/** Every line item of the order, paginated — never truncated. Includes items
 *  whose currentQuantity is 0 (removed), so the count is a stable fingerprint
 *  of the order's line-item list. */
async function fetchAllLineItems(admin: AdminClient, orderId: string): Promise<MergeLineItem[]> {
  const items: MergeLineItem[] = [];
  let after: string | null = null;
  do {
    const order: any = await gql(admin, "Load line items", LINE_ITEMS_QUERY, { id: orderId, after }, "order", null);
    const connection = order.lineItems;
    if (!connection?.nodes || !connection.pageInfo) {
      throw new ShopifyGraphqlError(`Could not load line items for ${orderId}.`, false);
    }
    items.push(...connection.nodes);
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return items;
}

async function fetchLineItemsById(admin: AdminClient, orders: OrderState[]) {
  const map = new Map<string, MergeLineItem[]>();
  for (const order of orders) map.set(order.id, await fetchAllLineItems(admin, order.id));
  return map;
}

async function countActiveLocations(admin: AdminClient): Promise<number> {
  const result = await gql<{ count: number }>(
    admin,
    "Count locations",
    `#graphql
      query MergeLocationCount {
        locationsCount(query: "active:true") { count }
      }`,
    {},
    "locationsCount",
    null,
  );
  return result.count;
}

const FULFILLMENT_ORDERS_QUERY = `#graphql
  query MergeFulfillmentOrders($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 20) {
        nodes {
          status
          requestStatus
          fulfillmentHolds { reason }
          assignedLocation { location { id } }
          lineItems(first: 100) {
            nodes { remainingQuantity lineItem { id } }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  }`;

async function fetchFulfillmentOrdersById(admin: AdminClient, orders: OrderState[]) {
  const map = new Map<string, OrderFulfillmentOrders>();
  for (const order of orders) {
    const result: any = await gql(admin, "Load fulfillment orders", FULFILLMENT_ORDERS_QUERY, { id: order.id }, "order", null);
    const connection = result.fulfillmentOrders;
    if (!connection?.nodes || !connection.pageInfo) {
      throw new ShopifyGraphqlError(`Could not load fulfillment orders for ${order.name}.`, false);
    }
    map.set(order.id, { complete: !connection.pageInfo.hasNextPage, nodes: connection.nodes });
  }
  return map;
}

const isAccessDenied = (err: unknown) =>
  err instanceof ShopifyGraphqlError && !err.rejected && /access denied/i.test(err.message);

/** Observability only: reports whether the transferred items stayed at the
 *  shared location. Never throws and never affects the merge. */
async function logMergedLocation(admin: AdminClient, primary: OrderState, locationId: string) {
  try {
    const fos = await fetchFulfillmentOrdersById(admin, [primary]);
    const locations = new Set(
      fos
        .get(primary.id)!
        .nodes.filter((fo) => !["CLOSED", "CANCELLED"].includes(fo.status))
        .map((fo) => fo.assignedLocation?.location?.id ?? "unassigned"),
    );
    if (locations.size === 1 && locations.has(locationId)) {
      console.log(`[merge] ${primary.name}: all items assigned to ${locationId}.`);
    } else {
      console.warn(`[merge] ${primary.name}: items now assigned to ${[...locations].join(", ")} (expected ${locationId}).`);
    }
  } catch (err: any) {
    console.warn(`[merge] Could not check locations after commit for ${primary.name}: ${err?.message}`);
  }
}

/**
 * Per-order location pre-filter. When fulfillment orders are readable, keeps
 * the anchor (orders[0]) plus only those candidates whose items verifiably
 * ship from the anchor's location; others are excluded and left untouched.
 * Without location access, the group is returned unchanged and
 * resolveMergeLocation applies the single-location rule to it.
 */
async function excludeByLocation(
  admin: AdminClient,
  orders: OrderState[],
  lineItems: Map<string, MergeLineItem[]>,
): Promise<{ ok: true; orders: OrderState[] } | { ok: false; reason: string }> {
  let fulfillmentOrders: Map<string, OrderFulfillmentOrders>;
  try {
    fulfillmentOrders = await fetchFulfillmentOrdersById(admin, orders);
  } catch (err) {
    if (isAccessDenied(err)) return { ok: true, orders };
    throw err;
  }

  const [anchor, ...others] = orders;
  const anchorLocation = evaluateFulfillmentLocation([anchor], fulfillmentOrders, lineItems);
  if (!anchorLocation.ok) return { ok: false, reason: anchorLocation.reason };

  const kept = [anchor];
  const excluded: string[] = [];
  for (const order of others) {
    const location = evaluateFulfillmentLocation([order], fulfillmentOrders, lineItems);
    if (!location.ok) {
      excluded.push(`${order.name} — ${location.reason}`);
    } else if (location.locationId !== anchorLocation.locationId) {
      excluded.push(`${order.name} — ships from a different location than ${anchor.name}.`);
    } else {
      kept.push(order);
    }
  }
  for (const e of excluded) console.log(`[merge] Excluded ${e}`);
  if (kept.length < 2) {
    return { ok: false, reason: `No other order ships from the same location as ${anchor.name}: ${excluded.join("; ")}` };
  }
  return { ok: true, orders: kept };
}

type LocationDecision = { ok: true; locationId: string | null } | { ok: false; reason: string };

/**
 * Location rule.
 *   • With the optional location scopes (read_merchant_managed_fulfillment_orders
 *     and read_locations, which gates assignedLocation.location.id): every
 *     open fulfillment order of every order must be untouched and assigned to
 *     one and the same location, and must account for every unfulfilled unit
 *     (see evaluateFulfillmentLocation). Applies to single-location shops too.
 *   • Without them: only shops with exactly one active location qualify.
 * Anything that cannot be verified is skipped.
 */
async function resolveMergeLocation(
  admin: AdminClient,
  orders: OrderState[],
  lineItems: Map<string, MergeLineItem[]>,
): Promise<LocationDecision> {
  let fulfillmentOrders: Map<string, OrderFulfillmentOrders> | null = null;
  let denied = "";
  try {
    fulfillmentOrders = await fetchFulfillmentOrdersById(admin, orders);
  } catch (err: any) {
    if (!isAccessDenied(err)) throw err;
    denied = err.message;
  }

  if (fulfillmentOrders) {
    const result = evaluateFulfillmentLocation(orders, fulfillmentOrders, lineItems);
    return result.ok ? { ok: true, locationId: result.locationId } : result;
  }

  if ((await countActiveLocations(admin)) === 1) return { ok: true, locationId: null };
  return {
    ok: false,
    // Include Shopify's message: it names the exact missing scope.
    reason: `Shop has more than one active location and MergeShip cannot read fulfillment locations (allow location access in Settings). ${denied}`,
  };
}

// ── Best-effort annotations (never affect merge correctness) ──────────────────

function uniqueTags(tags: string[]): string[] {
  const tagMap = new Map<string, string>();
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed && !tagMap.has(trimmed.toLowerCase())) tagMap.set(trimmed.toLowerCase(), trimmed);
  }
  return [...tagMap.values()];
}

async function annotateOrder(
  admin: AdminClient,
  order: Pick<OrderState, "id" | "name" | "note" | "tags">,
  addTags: string[],
  noteLines: string | string[] | null,
): Promise<void> {
  const existingNote = (order.note ?? "").trim();
  const newLines = (Array.isArray(noteLines) ? noteLines : noteLines ? [noteLines] : []).filter(
    (line) => line && !existingNote.includes(line),
  );
  try {
    await gql(
      admin,
      `Annotate ${order.name}`,
      `#graphql
        mutation MergeAnnotateOrder($input: OrderInput!) {
          orderUpdate(input: $input) {
            order { id }
            userErrors { field message }
          }
        }`,
      {
        input: {
          id: order.id,
          tags: uniqueTags([...(order.tags ?? []), ...addTags]),
          ...(newLines.length && {
            note: [existingNote, ...newLines].filter(Boolean).join("\n"),
          }),
        },
      },
      "orderUpdate",
    );
  } catch (err: any) {
    console.warn(`[merge] Could not annotate ${order.name}: ${err?.message}`);
  }
}

// ── Journal helpers ───────────────────────────────────────────────────────────

const inFlight = new Set<string>();

async function flagForReview(
  admin: AdminClient,
  op: MergeOperationRecord,
  reason: string,
  deps: MergeDeps,
): Promise<MergeResult> {
  console.error(`[merge] NEEDS REVIEW ${op.primaryOrderName} (${op.id}): ${reason}`);
  await deps.journal.update(op.id, { status: "NEEDS_REVIEW", lastError: reason });
  op.status = "NEEDS_REVIEW";

  const pending = op.secondaries.filter((s) => !s.done);
  try {
    const states = await fetchOrderStates(admin, [op.primaryOrderId, ...pending.map((s) => s.id)]);
    const [primary, ...secondaryStates] = states;
    await annotateOrder(
      admin,
      primary,
      [REVIEW_TAG],
      `MergeShip: a merge into this order needs review. ${reason}`,
    );
    for (const secondary of secondaryStates) {
      await annotateOrder(
        admin,
        secondary,
        [REVIEW_TAG],
        `MergeShip: items from this order may already have been added to ${op.primaryOrderName}. Do not fulfill this order until reviewed.`,
      );
    }
  } catch (err: any) {
    console.warn(`[merge] Could not flag orders for review on ${op.id}: ${err?.message}`);
  }

  return {
    outcome: "needs_review",
    reason,
    primaryName: op.primaryOrderName,
    operationId: op.id,
  };
}

/**
 * Determines whether a PENDING_COMMIT operation's order edit was applied by
 * comparing the primary's line-item count with the journalled fingerprint.
 * Each transferred item is added with allowDuplicates, so a committed edit
 * adds exactly addedLineItemCount line items.
 */
async function reconcilePendingCommit(
  admin: AdminClient,
  op: MergeOperationRecord,
  deps: MergeDeps,
): Promise<"COMMITTED" | "ABANDONED" | "NEEDS_REVIEW"> {
  const count = (await fetchAllLineItems(admin, op.primaryOrderId)).length;
  if (count === op.primaryLineItemCountBefore) {
    await deps.journal.update(op.id, { status: "ABANDONED", lastError: "Order edit was not committed." });
    op.status = "ABANDONED";
    return "ABANDONED";
  }
  if (count === op.primaryLineItemCountBefore + op.addedLineItemCount) {
    await deps.journal.update(op.id, { status: "COMMITTED" });
    op.status = "COMMITTED";
    return "COMMITTED";
  }
  return "NEEDS_REVIEW";
}

/**
 * Finishes a COMMITTED operation: cancels every remaining secondary, confirms
 * each cancellation by reading the order back, records history, and marks the
 * operation COMPLETED only when every secondary is confirmed.
 */
async function completeCommittedOperation(
  admin: AdminClient,
  op: MergeOperationRecord,
  deps: MergeDeps,
): Promise<MergeResult> {
  const secondaries: JournalSecondary[] = op.secondaries.map((s) => ({ ...s }));

  for (const secondary of secondaries) {
    if (secondary.done) continue;

    let [state] = await fetchOrderStates(admin, [secondary.id]);

    if (!state.cancelledAt) {
      // Its items are already on the primary. If it has started fulfilling in
      // the meantime, cancelling could hide a shipment in progress — stop.
      if (state.displayFulfillmentStatus !== "UNFULFILLED" || state.fulfillments.length > 0) {
        return flagForReview(
          admin,
          { ...op, secondaries },
          `${secondary.name} has fulfillment activity, but its items were already added to ${op.primaryOrderName}.`,
          deps,
        );
      }

      const requestedAt = secondary.cancelRequestedAt ? new Date(secondary.cancelRequestedAt).getTime() : null;
      const awaitingEarlierRequest =
        requestedAt !== null && deps.now().getTime() - requestedAt < deps.cancelRequestGraceMs;

      if (!awaitingEarlierRequest) {
        try {
          await requestCancel(admin, secondary, op.primaryOrderName);
          secondary.cancelRequestedAt = deps.now().toISOString();
          await deps.journal.update(op.id, { secondaries });
        } catch (err: any) {
          op.attempts += 1;
          const rejected = err instanceof ShopifyGraphqlError && err.rejected;
          // Outcome unknown: treat as possibly accepted so it isn't re-issued
          // until the grace period passes.
          if (!rejected) secondary.cancelRequestedAt = deps.now().toISOString();
          await deps.journal.update(op.id, {
            attempts: op.attempts,
            lastError: err?.message ?? String(err),
            secondaries,
          });
          if (rejected) {
            if (op.attempts >= deps.maxCancelAttempts) {
              return flagForReview(admin, { ...op, secondaries }, `Shopify rejected cancelling ${secondary.name}: ${err.message}`, deps);
            }
            return inProgress(op, `Cancelling ${secondary.name} was rejected; will retry.`);
          }
          // Fall through and read the order back.
        }
      }

      for (let i = 0; i < deps.cancelPollAttempts && !state.cancelledAt; i++) {
        await deps.sleep(deps.cancelPollIntervalMs);
        [state] = await fetchOrderStates(admin, [secondary.id]);
      }
      if (!state.cancelledAt) {
        return inProgress(op, `Cancellation of ${secondary.name} is not yet confirmed.`);
      }
    }

    // Confirmed cancelled: record history before marking done so a crash
    // between the two only re-runs an idempotent insert.
    await deps.journal.recordHistory({
      shop: op.shop,
      primaryOrderId: op.primaryOrderId,
      primaryOrderName: op.primaryOrderName,
      mergedOrderId: secondary.id,
      mergedOrderName: secondary.name,
      customerId: op.customerId,
      itemsCombined: secondary.items,
    });
    secondary.done = true;
    await deps.journal.update(op.id, { secondaries });
    op.secondaries = secondaries;

    await annotateOrder(admin, state, ["Merged"], `Consolidated into primary order ${op.primaryOrderName} by MergeShip`);
    try {
      await gql(
        admin,
        `Close ${secondary.name}`,
        `#graphql
          mutation MergeCloseSecondary($input: OrderCloseInput!) {
            orderClose(input: $input) {
              order { id }
              userErrors { field message }
            }
          }`,
        { input: { id: secondary.id } },
        "orderClose",
      );
    } catch (err: any) {
      // Cosmetic (Orders badge); the cancellation is already confirmed.
      console.warn(`[merge] Could not close ${secondary.name}: ${err?.message}`);
    }
  }

  // Carry the secondaries' customer notes and merchant tags to the primary —
  // the order that is actually fulfilled. Lines MergeShip wrote are excluded.
  const [primary, ...secondaryStates] = await fetchOrderStates(admin, [
    op.primaryOrderId,
    ...secondaries.map((s) => s.id),
  ]);
  const carriedNotes = secondaryStates.flatMap((s) =>
    (s.note ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("MergeShip") && !line.startsWith("Consolidated into primary order"))
      .map((line) => `Note from ${s.name}: ${line}`),
  );
  const carriedTags = secondaryStates
    .flatMap((s) => s.tags ?? [])
    .filter((t) => !["merged", REVIEW_TAG.toLowerCase()].includes(t.trim().toLowerCase()));
  await annotateOrder(admin, primary, [...carriedTags, "Consolidated"], [
    ...carriedNotes,
    `MergeShip: merged items from ${secondaries.map((s) => s.name).join(", ")} (already paid; shipping was not refunded).`,
  ]);
  await deps.journal.update(op.id, { status: "COMPLETED", lastError: null });
  op.status = "COMPLETED";
  console.log(`[merge] Completed ${op.primaryOrderName} ← ${secondaries.map((s) => s.name).join(", ")}`);
  return {
    outcome: "merged",
    primaryName: op.primaryOrderName,
    mergedCount: secondaries.length,
    operationId: op.id,
  };
}

/** Requests cancellation (restock, no refund, no customer notification). */
async function requestCancel(admin: AdminClient, secondary: JournalSecondary, primaryName: string) {
  await gql(
    admin,
    `Cancel ${secondary.name}`,
    `#graphql
      mutation MergeCancelSecondary($orderId: ID!, $staffNote: String) {
        orderCancel(
          orderId: $orderId
          reason: OTHER
          notifyCustomer: false
          restock: true
          refund: false
          staffNote: $staffNote
        ) {
          job { id }
          orderCancelUserErrors { field message }
        }
      }`,
    {
      orderId: secondary.id,
      staffNote: `Repeat order merged into ${primaryName} by MergeShip. Items transferred, inventory restocked, not refunded.`,
    },
    "orderCancel",
    "orderCancelUserErrors",
  );
}

function inProgress(op: MergeOperationRecord, reason: string): MergeResult {
  console.warn(`[merge] In progress ${op.primaryOrderName} (${op.id}): ${reason}`);
  return { outcome: "in_progress", reason, primaryName: op.primaryOrderName, operationId: op.id };
}

// ── Resume ────────────────────────────────────────────────────────────────────

/**
 * Resumes every unfinished merge for the shop. Safe to call on every webhook
 * and dashboard load: completed work is skipped and each step is idempotent.
 */
export async function resumeIncompleteMerges(
  admin: AdminClient,
  shop: string,
  deps: MergeDeps = defaultMergeDeps(),
): Promise<MergeResult[]> {
  const results: MergeResult[] = [];
  for (const op of await deps.journal.findUnfinished(shop)) {
    if (inFlight.has(op.id)) continue;
    if (
      op.status === "PENDING_COMMIT" &&
      deps.now().getTime() - op.updatedAt.getTime() < deps.pendingCommitGraceMs
    ) {
      continue;
    }
    inFlight.add(op.id);
    try {
      if (op.status === "PENDING_COMMIT") {
        const state = await reconcilePendingCommit(admin, op, deps);
        if (state === "ABANDONED") continue;
        if (state === "NEEDS_REVIEW") {
          results.push(
            await flagForReview(admin, op, `Could not confirm whether the edit to ${op.primaryOrderName} was applied.`, deps),
          );
          continue;
        }
      }
      results.push(await completeCommittedOperation(admin, op, deps));
    } catch (err: any) {
      console.error(`[merge] Resume of ${op.id} failed; will retry: ${err?.message}`);
    } finally {
      inFlight.delete(op.id);
    }
  }
  return results;
}

// ── Execute ───────────────────────────────────────────────────────────────────

const skip = (reason: string): MergeResult => {
  console.log(`[merge] Skipped: ${reason}`);
  return { outcome: "skipped", reason };
};

const fail = (reason: string): MergeResult => {
  console.error(`[merge] Failed (no orders changed): ${reason}`);
  return { outcome: "failed", reason };
};

/** Line-item fingerprint used to detect changes between checks and commit. */
const fingerprint = (items: Map<string, MergeLineItem[]>) =>
  JSON.stringify(
    [...items.entries()].map(([id, list]) => [id, list.map((i) => [i.id, i.currentQuantity, i.unfulfilledQuantity])]),
  );

/**
 * Merges the given orders: the oldest is the primary; every other order's
 * items are added to it at a 100 % discount, then those orders are cancelled
 * (restocked, not refunded, customer not notified).
 *
 * orderIds[0] is the anchor (the newly placed order). It must qualify; other
 * candidates that can't combine with it are excluded and left untouched.
 */
export async function executeMerge(
  admin: AdminClient,
  shop: string,
  orderIds: string[],
  deps: MergeDeps = defaultMergeDeps(),
): Promise<MergeResult> {
  if (orderIds.length < 2) return skip("At least two orders are required to merge.");

  // 1 ── Never touch orders that belong to an unfinished or flagged merge ─────
  const blocked = await deps.journal.findBlockingOrderIds(shop);
  const blockedId = orderIds.find((id) => blocked.has(id));
  if (blockedId) return skip(`Order ${blockedId} is part of an unfinished or flagged merge.`);

  // 2 ── Load and evaluate fresh state ─────────────────────────────────────────
  let orders: OrderState[];
  let lineItems: Map<string, MergeLineItem[]>;
  try {
    orders = await fetchOrderStates(admin, orderIds);
    lineItems = await fetchLineItemsById(admin, orders);
  } catch (err: any) {
    return fail(err?.message ?? "Could not load orders.");
  }

  // 2b ── Keep only the orders that can combine with the new order ───────────
  // One unsuitable candidate is excluded (and left untouched) rather than
  // blocking an otherwise safe combine of the others.
  const selection = selectCompatibleOrders(orderIds[0], orders, lineItems);
  if (!selection.ok) return skip(selection.reason);
  for (const e of selection.excluded) console.log(`[merge] Excluded ${e.name}: ${e.reason}`);
  try {
    const byLocation = await excludeByLocation(admin, selection.orders, lineItems);
    if (!byLocation.ok) return skip(byLocation.reason);
    orders = byLocation.orders;
  } catch (err: any) {
    return fail(err?.message ?? "Could not verify fulfillment locations.");
  }
  lineItems = new Map(orders.map((o) => [o.id, lineItems.get(o.id)!]));
  const groupIds = orders.map((o) => o.id);

  const evaluation = evaluateMergeGroup(orders, lineItems);
  if (!evaluation.ok) return skip(evaluation.reason);
  const { primary, secondaries } = evaluation;
  const primaryCountBefore = lineItems.get(primary.id)!.length;

  let location: LocationDecision;
  try {
    location = await resolveMergeLocation(admin, orders, lineItems);
  } catch (err: any) {
    return fail(err?.message ?? "Could not verify fulfillment locations.");
  }
  if (!location.ok) return skip(location.reason);
  const locationId = location.locationId;

  // 3 ── Build the order edit (uncommitted — abandoning it changes nothing) ──
  let calcId: string;
  let addedLineItemCount = 0;
  try {
    const begin = await gql(
      admin,
      `Begin edit of ${primary.name}`,
      `#graphql
        mutation MergeEditBegin($id: ID!) {
          orderEditBegin(id: $id) {
            calculatedOrder { id }
            userErrors { field message }
          }
        }`,
      { id: primary.id },
      "orderEditBegin",
    );
    calcId = begin.calculatedOrder?.id;
    if (!calcId) throw new ShopifyGraphqlError("orderEditBegin returned no calculated order.", false);

    for (const secondary of secondaries) {
      for (const item of lineItems.get(secondary.id)!) {
        if (item.currentQuantity <= 0) continue;
        const added = await gql(
          admin,
          `Add "${item.name}" from ${secondary.name}`,
          `#graphql
            mutation MergeEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!, $locationId: ID) {
              orderEditAddVariant(
                id: $id
                variantId: $variantId
                quantity: $quantity
                locationId: $locationId
                allowDuplicates: true
              ) {
                calculatedLineItem { id }
                userErrors { field message }
              }
            }`,
          // Anchor transferred items to the orders' shared location.
          { id: calcId, variantId: item.variant!.id, quantity: item.currentQuantity, locationId },
          "orderEditAddVariant",
        );
        const calcLineItemId = added.calculatedLineItem?.id;
        if (!calcLineItemId) throw new ShopifyGraphqlError(`No line item returned for "${item.name}".`, false);
        addedLineItemCount += 1;

        await gql(
          admin,
          `Discount "${item.name}" from ${secondary.name}`,
          `#graphql
            mutation MergeEditDiscount($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
              orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
                calculatedLineItem { id }
                userErrors { field message }
              }
            }`,
          {
            id: calcId,
            lineItemId: calcLineItemId,
            discount: { percentValue: 100, description: `Merged from ${secondary.name}, already paid` },
          },
          "orderEditAddLineItemDiscount",
        );
      }
    }
  } catch (err: any) {
    return fail(err?.message ?? "Could not build the order edit.");
  }

  // 4 ── Re-verify immediately before committing ──────────────────────────────
  // Orders can be fulfilled, edited, refunded or cancelled while the edit was
  // being built; commit only if nothing relevant changed.
  try {
    const freshOrders = await fetchOrderStates(admin, groupIds);
    const freshItems = await fetchLineItemsById(admin, freshOrders);
    const recheck = evaluateMergeGroup(freshOrders, freshItems);
    if (!recheck.ok) return skip(`Orders changed during the merge: ${recheck.reason}`);
    if (fingerprint(freshItems) !== fingerprint(lineItems)) {
      return skip("Order line items changed during the merge.");
    }
    const freshLocation = await resolveMergeLocation(admin, freshOrders, freshItems);
    if (!freshLocation.ok) return skip(`Orders changed during the merge: ${freshLocation.reason}`);
    if (freshLocation.locationId !== locationId) return skip("Fulfillment location changed during the merge.");
  } catch (err: any) {
    return fail(err?.message ?? "Could not re-verify orders.");
  }

  // 5 ── Journal the intent BEFORE committing ─────────────────────────────────
  let op: MergeOperationRecord;
  try {
    op = await deps.journal.create({
      shop,
      status: "PENDING_COMMIT",
      primaryOrderId: primary.id,
      primaryOrderName: primary.name,
      customerId: primary.customer?.id ?? null,
      primaryLineItemCountBefore: primaryCountBefore,
      addedLineItemCount,
      secondaries: secondaries.map((s) => ({
        id: s.id,
        name: s.name,
        items: lineItems.get(s.id)!.reduce((n, i) => n + Math.max(i.currentQuantity, 0), 0),
        done: false,
      })),
      involvedOrderIds: [primary.id, ...secondaries.map((s) => s.id)],
    });
  } catch (err: any) {
    return fail(`Could not record the merge before committing: ${err?.message}`);
  }

  inFlight.add(op.id);
  try {
    // 6 ── Commit ──────────────────────────────────────────────────────────────
    try {
      await gql(
        admin,
        `Commit edit of ${primary.name}`,
        `#graphql
          mutation MergeEditCommit($id: ID!, $staffNote: String) {
            orderEditCommit(id: $id, notifyCustomer: false, staffNote: $staffNote) {
              order { id }
              userErrors { field message }
            }
          }`,
        { id: calcId, staffNote: `MergeShip: merged items from ${secondaries.map((s) => s.name).join(", ")}.` },
        "orderEditCommit",
      );
      await deps.journal.update(op.id, { status: "COMMITTED" });
      op.status = "COMMITTED";
    } catch (err: any) {
      if (err instanceof ShopifyGraphqlError && err.rejected) {
        await deps.journal.update(op.id, { status: "ABANDONED", lastError: err.message });
        return fail(err.message);
      }
      // Unknown outcome: the edit may or may not have been applied. Leave the
      // op PENDING_COMMIT (orders stay blocked); resume reconciles it after
      // the grace period.
      await deps.journal.update(op.id, { lastError: err?.message ?? String(err) });
      return inProgress(op, `Commit outcome unknown: ${err?.message}`);
    }

    if (locationId) await logMergedLocation(admin, primary, locationId);

    // 7 ── Cancel secondaries and confirm ──────────────────────────────────────
    try {
      return await completeCommittedOperation(admin, op, deps);
    } catch (err: any) {
      await deps.journal.update(op.id, { lastError: err?.message ?? String(err) });
      return inProgress(op, err?.message ?? "Could not finish the merge.");
    }
  } finally {
    inFlight.delete(op.id);
  }
}
