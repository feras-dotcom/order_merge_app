// ── Merge planning (protocol v2, spec §4) ────────────────────────────────────
// executeMerge plans a merge and records it: it claims the orders, rejects
// durably locked / v1-blocked ones, evaluates fresh state and the location
// rule, builds the calculated order edit (every moved line discounted to 0 so
// the customer is never double-charged; the ManualDiscountApplication
// description carries `MS-<opToken>-<index>` — the evidence token), verifies
// the calculated order and the group, and inserts the v2 operation plus one
// durable MergeOrderLock per involved order in ONE transaction
// (createOperation). It then releases the claims and returns OPERATION_CREATED.
//
// No Shopify mutation that changes an order is sent from here. driveOperation
// (operation-protocol.server.ts) performs every orderEditCommit / orderCancel
// / tag / note through the write-ahead dispatch gate, and reconciles from
// Shopify evidence — never replaces (spec §0).
//
// Ownership: claims are a transient lease renewed before EVERY Shopify call
// (gql() caps a call at 45s, the TTL is 120s). Durable locks + the operation
// row + evidence are the safety mechanism.

import { gql, gqlNullable, ShopifyGraphqlError, type AdminClient } from "./graphql.server";
import { prismaClaimStore, type ClaimStore } from "./claims.server";
import {
  newLeaseToken,
  newOpToken,
  ClaimContentionError,
  OwnershipLostError,
} from "./ownership.server";
import {
  REVIEW_TAG,
  buildAddressKey,
  evaluateFulfillmentLocation,
  evaluateMergeGroup,
  lineItemIneligibility,
  orderShippingSignature,
  orderStateIneligibility,
  selectCompatibleOrders,
  type OrderFulfillmentOrders,
  type MergeLineItem,
  type OrderState,
} from "./eligibility";
import { prismaMergeJournal, type MergeJournal } from "./merge-journal.server";
import {
  prismaOperationStore,
  type ExpectedTransferEntry,
  type OperationRecord,
  type OperationStore,
} from "./operation-store.server";

export {
  buildAddressKey,
  buildGroupKey,
  normalizeAddressLine,
  normalizeShippingTitle,
} from "./eligibility";
export type { AdminClient } from "./graphql.server";

export { REVIEW_TAG };

// ── Dependencies (injectable for tests) ───────────────────────────────────────

/** Observability barriers awaited by the engine and the protocol driver
 *  (spec §12). All optional; default no-op. */
export interface ProtocolHooks {
  afterClaimCheck?: () => Promise<void>;
  beforeOpInsert?: () => Promise<void>;
  afterOpInsert?: () => Promise<void>;
  afterDispatchGate?: () => Promise<void>;
  afterSend?: () => Promise<void>;
  beforeAttemptRecord?: () => Promise<void>;
  beforeHistoryTx?: () => Promise<void>;
}

export interface MergeDeps {
  /** v1 journal: read-side queries only (e.g. blocking statuses). */
  journal: MergeJournal;
  /** Per-order merge claims (see claims.server.ts). */
  claims: ClaimStore;
  /** v2 operation store: durable locks, write-ahead attempts, control. */
  ops: OperationStore;
  /** Present when the merge is driven by a work item — createOperation
   *  settles it (DONE/OPERATION_CREATED) inside its transaction. */
  workItem?: { id: string; token: string };
  /** Lease length for claims and the new operation lease (default 120s — a
   *  held lease must outlive any single 45s Shopify call with margin). */
  leaseTtlMs: number;
  /** Extra ownership check run inside every fence (e.g. the work processor
   *  renews its work-item lease here). Throws OwnershipLostError. */
  outerFence?: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** Reads of a cancelled secondary before giving up for now (CANCEL_IN_DOUBT
   *  inline poll). */
  cancelPollAttempts: number;
  cancelPollIntervalMs: number;
  /** MergeShip's app id on the shop (defaults to a cached
   *  currentAppInstallation query — see evidence.server.ts). */
  appId?: (admin: AdminClient, shop: string) => Promise<string>;
  hooks?: ProtocolHooks;
}

export const defaultMergeDeps = (): MergeDeps => ({
  journal: prismaMergeJournal,
  claims: prismaClaimStore(),
  ops: prismaOperationStore,
  leaseTtlMs: 120_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
  cancelPollAttempts: 6,
  cancelPollIntervalMs: 1500,
});

// ── Result ────────────────────────────────────────────────────────────────────

export type MergeOutcome =
  /** The operation row + durable locks exist; the caller drives it. */
  | "operation_created"
  /** Not eligible / blocked; nothing was changed. */
  | "skipped"
  /** Failed before the operation was created; nothing was changed. */
  | "failed";

/** How the caller should treat the result: "terminal" is done, "contention"
 *  means another worker is involved (retry soon), "transient" means a
 *  Shopify/DB failure (retry). */
export type MergeDisposition = "terminal" | "contention" | "transient";

export type MergeResultCode =
  | "OPERATION_CREATED"
  | "ANCHOR_INELIGIBLE"
  | "NO_COMPATIBLE_PARTNER"
  | "LOCATION_ACCESS"
  | "MERGES_DISABLED"
  | "CLAIM_CONFLICT"
  | "LOCKED"
  | "OWNERSHIP_LOST"
  | "TRANSIENT";

export interface MergeResult {
  outcome: MergeOutcome;
  reason?: string;
  primaryName?: string;
  operationId?: string;
  /** The fresh operation row when outcome is "operation_created" — the caller
   *  drives it with driveOperation until a waiting point. */
  operation?: OperationRecord;
  disposition: MergeDisposition;
  code?: MergeResultCode;
}

// ── Shopify reads ─────────────────────────────────────────────────────────────

export const ORDER_STATE_QUERY = `#graphql
  query MergeOrderState($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
        name
        createdAt
        cancelledAt
        cancellation { staffNote }
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

export async function fetchOrderStates(admin: AdminClient, ids: string[]): Promise<OrderState[]> {
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
export async function fetchAllLineItems(
  admin: AdminClient,
  orderId: string,
): Promise<MergeLineItem[]> {
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

export async function fetchLineItemsById(admin: AdminClient, orders: OrderState[]) {
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
export async function logMergedLocation(
  admin: AdminClient,
  primary: Pick<OrderState, "id" | "name">,
  locationId: string,
) {
  try {
    const fos = await fetchFulfillmentOrdersById(admin, [primary as OrderState]);
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

export type LocationDecision =
  | { ok: true; locationId: string | null }
  | { ok: false; reason: string; accessDenied?: boolean };

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
export async function resolveMergeLocation(
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
    accessDenied: true,
  };
}

// ── Order edit building (uncommitted — a dropped calc changes nothing) ────────

export const CALCULATED_ORDER_QUERY = `#graphql
  query MergeCalculatedOrder($id: ID!) {
    node(id: $id) {
      ... on CalculatedOrder {
        id
        addedLineItems(first: 100) {
          nodes {
            id
            quantity
            variant { id }
            calculatedDiscountAllocations {
              discountApplication { description }
            }
          }
        }
      }
    }
  }`;

const EDIT_BEGIN_MUTATION = `#graphql
  mutation MergeEditBegin($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder { id }
      userErrors { field message }
    }
  }`;

const EDIT_ADD_VARIANT_MUTATION = `#graphql
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
  }`;

const EDIT_LINE_DISCOUNT_MUTATION = `#graphql
  mutation MergeEditDiscount($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
    orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
      calculatedLineItem { id }
      userErrors { field message }
    }
  }`;

interface AddedLine {
  sourceLineItemId: string | null;
  variantId: string | null;
  quantity: number;
  description: string;
}

/** Builds the uncommitted calculated order: every secondary line is added at
 *  its currentQuantity with a 100% manual discount whose description carries
 *  the op token — the evidence marker §6 verifies after the commit. */
async function buildOrderEdit(
  admin: AdminClient,
  primary: OrderState,
  secondaries: OrderState[],
  lineItems: Map<string, MergeLineItem[]>,
  locationId: string | null,
  opToken: string,
): Promise<{ calcId: string; transfer: ExpectedTransferEntry[]; lineCount: number }> {
  const begin = await gql<{ calculatedOrder: { id: string } | null }>(
    admin,
    `Begin edit of ${primary.name}`,
    EDIT_BEGIN_MUTATION,
    { id: primary.id },
    "orderEditBegin",
  );
  const calcId = begin.calculatedOrder?.id;
  if (!calcId) throw new ShopifyGraphqlError("orderEditBegin returned no calculated order.", false);

  const transfer: ExpectedTransferEntry[] = [];
  let lineCount = 0;
  for (const [index, secondary] of secondaries.entries()) {
    const secondaryIndex = index + 1; // 1-based within the op
    const description = `Merged from ${secondary.name}, already paid · MS-${opToken}-${secondaryIndex}`;
    const lines: AddedLine[] = [];
    for (const item of lineItems.get(secondary.id)!) {
      if (item.currentQuantity <= 0) continue;
      const added = await gql<{ calculatedLineItem?: { id: string } | null }>(
        admin,
        `Add "${item.name}" from ${secondary.name}`,
        EDIT_ADD_VARIANT_MUTATION,
        // Anchor transferred items to the orders' shared location.
        { id: calcId, variantId: item.variant!.id, quantity: item.currentQuantity, locationId },
        "orderEditAddVariant",
      );
      const calcLineItemId = added.calculatedLineItem?.id;
      if (!calcLineItemId) {
        throw new ShopifyGraphqlError(`No line item returned for "${item.name}".`, false);
      }
      await gql(
        admin,
        `Discount "${item.name}" from ${secondary.name}`,
        EDIT_LINE_DISCOUNT_MUTATION,
        {
          id: calcId,
          lineItemId: calcLineItemId,
          discount: { percentValue: 100, description },
        },
        "orderEditAddLineItemDiscount",
      );
      lines.push({
        sourceLineItemId: item.id ?? null,
        variantId: item.variant?.id ?? null,
        quantity: item.currentQuantity,
        description,
      });
      lineCount += 1;
    }
    transfer.push({ secondaryId: secondary.id, secondaryIndex, lines });
  }
  if (!lineCount) throw new ShopifyGraphqlError("Nothing eligible to move.", false);
  return { calcId, transfer, lineCount };
}

/**
 * Freeze-verify the calculated order (§4.5): the staged added lines must equal
 * the expected transfer as a multiset of (variantId, quantity, description).
 * `node` null => the calc expired or was committed — treated like any other
 * mismatch by callers (the calc is simply dropped). Returns the failure
 * reason, or null when the calc matches.
 */
export async function verifyCalculatedOrder(
  admin: AdminClient,
  calcId: string | null,
  expectedTransfer: unknown,
): Promise<string | null> {
  if (!calcId) return "No calculated order was recorded for this operation.";
  const node: any = await gqlNullable(
    admin,
    "Verify calculated order",
    CALCULATED_ORDER_QUERY,
    { id: calcId },
    "node",
  );
  if (!node) return "The calculated order is no longer available (committed or expired).";
  const have = (node.addedLineItems?.nodes ?? []).flatMap((n: any) => {
    const descriptions = (n.calculatedDiscountAllocations ?? []).map(
      (a: any) => a.discountApplication?.description ?? "",
    );
    // A line with no calculated discount allocation is an unmatched extra.
    return (descriptions.length ? descriptions : [""]).map((description: string) => ({
      variantId: n.variant?.id ?? null,
      quantity: n.quantity,
      description,
    }));
  });
  const want = (expectedTransfer as ExpectedTransferEntry[]).flatMap((e) =>
    e.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, description: l.description })),
  );
  const key = (l: { variantId: string | null; quantity: number; description: string }) =>
    `${l.variantId}\0${l.quantity}\0${l.description}`;
  const counts = new Map<string, number>();
  for (const h of have) counts.set(key(h), (counts.get(key(h)) ?? 0) + 1);
  for (const w of want) counts.set(key(w), (counts.get(key(w)) ?? 0) - 1);
  if ([...counts.values()].some((n) => n !== 0)) {
    return "The calculated order's contents no longer match the recorded transfer.";
  }
  return null;
}

// ── Execute (planning only) ──────────────────────────────────────────────────

const skip = (
  reason: string,
  disposition: MergeDisposition = "terminal",
  code?: MergeResultCode,
): MergeResult => {
  console.log(`[merge] Skipped: ${reason}`);
  return { outcome: "skipped", reason, disposition, ...(code && { code }) };
};

const fail = (reason: string): MergeResult => {
  console.error(`[merge] Failed (no orders changed): ${reason}`);
  return { outcome: "failed", reason, disposition: "transient", code: "TRANSIENT" };
};

/** The result when a fence detects this worker lost its lease. No further
 *  DB or Shopify writes are made. */
const ownershipLost = (err: any): MergeResult => ({
  outcome: "failed",
  reason: `Lost ownership of the merge: ${err?.message ?? err}`,
  disposition: "contention",
  code: "OWNERSHIP_LOST",
});

/** Line-item fingerprint used to detect changes between checks and commit. */
const fingerprint = (items: Map<string, MergeLineItem[]>) =>
  JSON.stringify(
    [...items.entries()].map(([id, list]) => [id, list.map((i) => [i.id, i.currentQuantity, i.unfulfilledQuantity])]),
  );

/**
 * Plans a merge for the given orders and creates the v2 operation that owns
 * it (durable locks inserted atomically). The oldest order is the primary.
 *
 * orderIds[0] is the anchor (the newly placed order): it must qualify; other
 * candidates that can't combine with it are excluded and left untouched.
 */
export async function executeMerge(
  admin: AdminClient,
  shop: string,
  orderIds: string[],
  deps: MergeDeps = defaultMergeDeps(),
): Promise<MergeResult> {
  if (orderIds.length < 2) return skip("At least two orders are required to merge.");

  // 0 ── Claim every order before touching anything ────────────────────────────
  // Claims are transient liveness; durable locks are created before release.
  const ids = [...new Set(orderIds)].sort();
  const token = newLeaseToken();
  if (!(await deps.claims.acquire(shop, ids, token, deps.leaseTtlMs))) {
    return skip("Another merge is holding one of the orders.", "contention", "CLAIM_CONFLICT");
  }
  let held = ids;
  const fence = async () => {
    await deps.outerFence?.();
    await deps.claims.renew(shop, held, token, deps.leaseTtlMs);
  };
  // Every Shopify call (reads included) renews the claims first — a worker
  // that lost them stops before touching Shopify.
  const fencedAdmin: AdminClient = {
    graphql: async (query, options) => {
      await fence();
      return admin.graphql(query, options);
    },
  };
  try {
    await deps.hooks?.afterClaimCheck?.();

    // 1 ── Durable blockers: a MergeOrderLock or a blocking v1 op on any id ──
    const [lockedIds, v1Blocked] = await Promise.all([
      deps.ops.findLockedOrderIds(shop, ids),
      deps.ops.findBlockingV1(shop, ids),
    ]);
    const blockedId = ids.find((id) => lockedIds.has(id) || v1Blocked.has(id));
    if (blockedId) {
      return skip(`Order ${blockedId} is held by an unfinished merge operation.`, "contention", "LOCKED");
    }

    // 1b ── Kill switch, read side: disabled mode never prepares a calculated
    // order. createOperation still enforces this inside its transaction.
    if (!(await deps.ops.isEnabled(shop, "newMergesEnabled"))) {
      return skip("New merges are disabled.", "contention", "MERGES_DISABLED");
    }

    // 2 ── Load and evaluate fresh state ─────────────────────────────────────
    let orders: OrderState[];
    let lineItems: Map<string, MergeLineItem[]>;
    try {
      orders = await fetchOrderStates(fencedAdmin, orderIds);
      lineItems = await fetchLineItemsById(fencedAdmin, orders);
    } catch (err: any) {
      if (err instanceof OwnershipLostError) throw err;
      return fail(err?.message ?? "Could not load orders.");
    }

    // 2a ── Classify anchor ineligibility BEFORE compatible-sibling selection,
    // so ANCHOR_INELIGIBLE and NO_COMPATIBLE_PARTNER stay distinguishable.
    const anchor = orders.find((o) => o.id === orderIds[0]);
    let anchorReason: string | null = null;
    if (!anchor) {
      anchorReason = "The new order could not be loaded.";
    } else {
      const anchorShipping = orderShippingSignature(anchor);
      anchorReason =
        orderStateIneligibility(anchor) ??
        lineItemIneligibility(anchor.name, lineItems.get(anchor.id) ?? [], false) ??
        (!anchorShipping.ok ? anchorShipping.reason : null) ??
        (buildAddressKey(anchor.customer?.id, anchor.shippingAddress)
          ? null
          : `Order ${anchor.name} has no usable shipping address.`);
    }
    if (anchorReason) return skip(anchorReason, "terminal", "ANCHOR_INELIGIBLE");

    // 2b ── Keep only the orders that can combine with the new order ─────────
    const selection = selectCompatibleOrders(orderIds[0], orders, lineItems);
    if (!selection.ok) return skip(selection.reason, "terminal", "NO_COMPATIBLE_PARTNER");
    for (const e of selection.excluded) console.log(`[merge] Excluded ${e.name}: ${e.reason}`);
    try {
      const byLocation = await excludeByLocation(fencedAdmin, selection.orders, lineItems);
      if (!byLocation.ok) return skip(byLocation.reason, "terminal", "NO_COMPATIBLE_PARTNER");
      orders = byLocation.orders;
    } catch (err: any) {
      if (err instanceof OwnershipLostError) throw err;
      return fail(err?.message ?? "Could not verify fulfillment locations.");
    }
    lineItems = new Map(orders.map((o) => [o.id, lineItems.get(o.id)!]));
    const groupIds = orders.map((o) => o.id);

    // Candidates narrowed away are released early so a merge touching only
    // them can proceed.
    const dropped = held.filter((id) => !groupIds.includes(id));
    if (dropped.length) {
      held = groupIds;
      await deps.claims
        .release(shop, dropped, token)
        .catch((err: any) => console.warn(`[merge] Could not release excluded claims: ${err?.message}`));
    }

    const evaluation = evaluateMergeGroup(orders, lineItems);
    if (!evaluation.ok) return skip(evaluation.reason, "terminal", "NO_COMPATIBLE_PARTNER");
    const { primary, secondaries } = evaluation;
    const primaryCountBefore = lineItems.get(primary.id)!.length;
    const primaryLineItemIdsBefore = lineItems
      .get(primary.id)!
      .map((i) => i.id)
      .filter((id): id is string => Boolean(id));

    let location: LocationDecision;
    try {
      location = await resolveMergeLocation(fencedAdmin, orders, lineItems);
    } catch (err: any) {
      if (err instanceof OwnershipLostError) throw err;
      return fail(err?.message ?? "Could not verify fulfillment locations.");
    }
    if (!location.ok) {
      return skip(location.reason, "terminal", location.accessDenied ? "LOCATION_ACCESS" : undefined);
    }
    const locationId = location.locationId;

    // 3 ── Build the order edit (uncommitted — abandoning it changes nothing) ──
    const opToken = newOpToken();
    let edit: { calcId: string; transfer: ExpectedTransferEntry[]; lineCount: number };
    try {
      edit = await buildOrderEdit(fencedAdmin, primary, secondaries, lineItems, locationId, opToken);
    } catch (err: any) {
      if (err instanceof OwnershipLostError) throw err;
      return fail(err?.message ?? "Could not build the order edit.");
    }

    // 3b ── Freeze-verify: the staged calc must equal the recorded transfer;
    // a concurrent edit changing it drops the calc (transient — retried).
    try {
      const calcReason = await verifyCalculatedOrder(fencedAdmin, edit.calcId, edit.transfer);
      if (calcReason) {
        return skip(`The calculated order changed before it could be recorded: ${calcReason}`, "transient", "TRANSIENT");
      }
    } catch (err: any) {
      if (err instanceof OwnershipLostError) throw err;
      return fail(err?.message ?? "Could not verify the calculated order.");
    }

    // 4 ── Re-verify the group immediately before creating the operation ──────
    try {
      const freshOrders = await fetchOrderStates(fencedAdmin, groupIds);
      const freshItems = await fetchLineItemsById(fencedAdmin, freshOrders);
      const recheck = evaluateMergeGroup(freshOrders, freshItems);
      if (!recheck.ok) return skip(`Orders changed during the merge: ${recheck.reason}`, "transient", "TRANSIENT");
      if (fingerprint(freshItems) !== fingerprint(lineItems)) {
        return skip("Order line items changed during the merge.", "transient", "TRANSIENT");
      }
      const freshLocation = await resolveMergeLocation(fencedAdmin, freshOrders, freshItems);
      if (!freshLocation.ok) {
        return skip(
          `Orders changed during the merge: ${freshLocation.reason}`,
          "transient",
          freshLocation.accessDenied ? "LOCATION_ACCESS" : "TRANSIENT",
        );
      }
      if (freshLocation.locationId !== locationId) {
        return skip("Fulfillment location changed during the merge.", "transient", "TRANSIENT");
      }
    } catch (err: any) {
      if (err instanceof OwnershipLostError) throw err;
      return fail(err?.message ?? "Could not re-verify orders.");
    }

    // 5 ── The durable point of no return: operation + locks in ONE tx ────────
    await deps.hooks?.beforeOpInsert?.();
    let op: OperationRecord;
    try {
      op = await deps.ops.createOperation({
        shop,
        claimToken: token,
        involvedOrderIds: groupIds,
        primaryOrderId: primary.id,
        primaryOrderName: primary.name,
        customerId: primary.customer?.id ?? null,
        primaryLineItemCountBefore: primaryCountBefore,
        addedLineItemCount: edit.lineCount,
        secondaries: secondaries.map((s, i) => ({
          id: s.id,
          name: s.name,
          items: lineItems.get(s.id)!.reduce((n, item) => n + Math.max(item.currentQuantity, 0), 0),
          cancelPhase: "TRANSFER_PENDING" as const,
          secondaryIndex: i + 1,
        })),
        workItemId: deps.workItem?.id,
        workToken: deps.workItem?.token,
        opToken,
        calculatedOrderId: edit.calcId,
        expectedTransfer: edit.transfer,
        expectedLocationId: locationId,
        primaryLineItemIdsBefore,
        leaseToken: newLeaseToken(),
        ttlMs: deps.leaseTtlMs,
      });
    } catch (err: any) {
      if (err instanceof ClaimContentionError) {
        return skip(
          err.message,
          "contention",
          err.message.startsWith("New merges are disabled") ? "MERGES_DISABLED" : "LOCKED",
        );
      }
      if (err instanceof OwnershipLostError) return ownershipLost(err);
      throw err;
    }
    await deps.hooks?.afterOpInsert?.();
    // The durable locks own the orders now; the claims are released below.
    return {
      outcome: "operation_created",
      reason: `Operation ${op.id} planned for ${primary.name} ← ${secondaries.map((s) => s.name).join(", ")}`,
      primaryName: primary.name,
      operationId: op.id,
      operation: op,
      disposition: "terminal",
      code: "OPERATION_CREATED",
    };
  } catch (err: any) {
    if (err instanceof OwnershipLostError) return ownershipLost(err);
    throw err;
  } finally {
    // Release must never throw out of finally — the claims expire anyway.
    try {
      await deps.claims.release(shop, held, token);
    } catch (err: any) {
      console.warn(`[merge] Could not release claims for ${shop}: ${err?.message}`);
    }
  }
}
