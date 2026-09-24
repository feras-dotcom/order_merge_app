// ── Shared merge utilities ────────────────────────────────────────────────────
// Used by both the UI route (app._index.tsx) and the background webhook handler
// (webhooks.orders.create.tsx) so grouping rules and merge execution are
// identical in both paths.

// ── Address normalization ─────────────────────────────────────────────────────

export const normalizeAddressLine = (line: string | null | undefined): string =>
  line
    ?.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim() ?? "";

/** Trims, collapses whitespace and lowercases so "Standard Shipping " and
 *  "standard  shipping" compare equal. */
export const normalizeShippingTitle = (title: string | null | undefined): string =>
  title?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";

export interface AddressFields {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  provinceCode?: string | null;
  zip?: string | null;
  countryCodeV2?: string | null;
}

/**
 * Returns a key of (customer ID) + NUL + (normalized address). Orders from
 * different customers can never share a key, even at the same address.
 * Returns null when the order has no customer or no usable address.
 */
export function buildAddressKey(
  customerId: string | null | undefined,
  address: AddressFields | null | undefined,
): string | null {
  if (!customerId || !address) return null;
  const normalizedAddress = [
    address.address1,
    address.address2,
    address.city,
    address.provinceCode,
    address.zip,
    address.countryCodeV2,
  ]
    .map(normalizeAddressLine)
    .filter(Boolean)
    .join("|");
  if (!normalizedAddress) return null;
  // \0 is a safe separator — it cannot appear in IDs, address text or titles
  return `${customerId}\0${normalizedAddress}`;
}

/**
 * Returns a composite key of (customer ID) + (normalized address) +
 * (normalized shipping title). Baking the shipping method into the key ensures
 * different methods at the same address form independent buckets instead of
 * disqualifying each other. Returns null when the order has no customer or no
 * usable address.
 */
export function buildGroupKey(
  customerId: string | null | undefined,
  address: AddressFields | null | undefined,
  shippingTitle: string | null | undefined,
): string | null {
  const addressKey = buildAddressKey(customerId, address);
  return addressKey && `${addressKey}\0${normalizeShippingTitle(shippingTitle)}`;
}

export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// ── Candidate evaluation (UI) ─────────────────────────────────────────────────

export type ConflictReason =
  | "SHIPPING_MISMATCH"
  | "OUTSIDE_WINDOW"
  | "PAYMENT_PENDING"
  | "FULFILLMENT_MISMATCH"
  | "NO_ELIGIBLE_MATCH";

export interface EvaluableOrder {
  id: string;
  createdAt: string;
  cancelledAt?: string | null;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  customer?: { id: string } | null;
  shippingAddress?: AddressFields | null;
  shippingLine?: { title?: string | null } | null;
}

export interface OrderEvaluation<T> {
  evaluatedCount: number;
  readyGroups: { key: string; orders: T[] }[];
  conflictGroups: {
    key: string;
    orders: { order: T; reasons: ConflictReason[] }[];
  }[];
  singleOrders: T[];
}

const toTime = (iso: string) => new Date(iso).getTime();

/**
 * Classifies open orders into three buckets:
 *   • readyGroups    — same customer + address + shipping method, all paid and
 *                      unfulfilled, created within mergeWindowMs of the
 *                      cluster's oldest order.
 *   • conflictGroups — orders that share a customer + address with at least one
 *                      other order but were held back, with the reasons why.
 *   • singleOrders   — orders with no same-customer duplicate at their address
 *                      (or with no customer / no usable address at all).
 * Cancelled orders are ignored entirely.
 */
export function evaluateOrders<T extends EvaluableOrder>(
  orders: T[],
  mergeWindowMs: number,
): OrderEvaluation<T> {
  const active = orders.filter((o) => !o.cancelledAt);
  const buckets = new Map<string, T[]>();
  const singleOrders: T[] = [];

  for (const order of active) {
    const key = buildAddressKey(order.customer?.id, order.shippingAddress);
    if (!key) {
      singleOrders.push(order);
      continue;
    }
    buckets.set(key, [...(buckets.get(key) ?? []), order]);
  }

  const readyGroups: OrderEvaluation<T>["readyGroups"] = [];
  const conflictGroups: OrderEvaluation<T>["conflictGroups"] = [];

  for (const [key, bucket] of buckets) {
    if (bucket.length < 2) {
      singleOrders.push(...bucket);
      continue;
    }

    // Per-order safety rules: only paid, fully unfulfilled orders may merge
    const held: { order: T; reasons: ConflictReason[] }[] = [];
    const eligible: T[] = [];
    for (const order of bucket) {
      const reasons: ConflictReason[] = [];
      if (order.displayFinancialStatus !== "PAID") reasons.push("PAYMENT_PENDING");
      if (order.displayFulfillmentStatus !== "UNFULFILLED") {
        reasons.push("FULFILLMENT_MISMATCH");
      }
      if (reasons.length) held.push({ order, reasons });
      else eligible.push(order);
    }

    const byShipping = new Map<string, T[]>();
    for (const order of eligible) {
      const shipping = normalizeShippingTitle(order.shippingLine?.title);
      byShipping.set(shipping, [...(byShipping.get(shipping) ?? []), order]);
    }

    // For each shipping method, sort by createdAt and greedily build temporal
    // sub-clusters where the span from the anchor (oldest order) to every
    // other order in the cluster is ≤ mergeWindowMs. A single stale open order
    // therefore only holds itself back; it cannot disqualify a recent pair.
    for (const [shipping, group] of byShipping) {
      const sorted = [...group].sort(
        (a, b) => toTime(a.createdAt) - toTime(b.createdAt),
      );
      let start = 0;
      while (start < sorted.length) {
        const anchorTime = toTime(sorted[start].createdAt);
        let end = start;
        while (
          end + 1 < sorted.length &&
          toTime(sorted[end + 1].createdAt) - anchorTime <= mergeWindowMs
        ) {
          end++;
        }
        const cluster = sorted.slice(start, end + 1);
        if (cluster.length >= 2) {
          readyGroups.push({
            key: `${key}\0${shipping}\0${sorted[start].createdAt}`,
            orders: cluster,
          });
        } else {
          const [order] = cluster;
          const others = eligible.filter((o) => o !== order);
          const reasons: ConflictReason[] = [];
          if (others.some((o) => normalizeShippingTitle(o.shippingLine?.title) !== shipping)) {
            reasons.push("SHIPPING_MISMATCH");
          }
          if (others.some((o) => normalizeShippingTitle(o.shippingLine?.title) === shipping)) {
            reasons.push("OUTSIDE_WINDOW");
          }
          if (!reasons.length) reasons.push("NO_ELIGIBLE_MATCH");
          held.push({ order, reasons });
        }
        start = end + 1;
      }
    }

    if (held.length) {
      held.sort((a, b) => toTime(a.order.createdAt) - toTime(b.order.createdAt));
      conflictGroups.push({ key, orders: held });
    }
  }

  return { evaluatedCount: active.length, readyGroups, conflictGroups, singleOrders };
}

// ── Merge result type ─────────────────────────────────────────────────────────

export interface MergeResult {
  success: boolean;
  primaryOrderId?: string;
  primaryName?: string;
  mergedCount?: number;
  cancelResults?: { name: string; cancelled: boolean; error?: string }[];
  error?: string;
}

type AdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

interface MergeLineItem {
  name: string;
  currentQuantity: number;
  variant: { id: string } | null;
  customAttributes: { key: string; value: string | null }[];
}

// ── Line item loading (paginated — never truncates) ───────────────────────────

async function fetchAllLineItems(
  admin: AdminClient,
  orderId: string,
): Promise<MergeLineItem[]> {
  const items: MergeLineItem[] = [];
  let after: string | null = null;
  do {
    const res = await admin.graphql(
      `#graphql
        query OrderLineItems($id: ID!, $after: String) {
          order(id: $id) {
            lineItems(first: 100, after: $after) {
              nodes {
                name
                currentQuantity
                variant { id }
                customAttributes { key value }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
      { variables: { id: orderId, after } },
    );
    const connection: any = (await res.json()).data?.order?.lineItems;
    if (!connection) throw new Error(`Could not load line items for ${orderId}.`);
    items.push(...connection.nodes);
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return items;
}

// ── Core merge execution ──────────────────────────────────────────────────────

/**
 * Executes a full merge of the supplied order IDs:
 *   1. Fetches order details and ALL line items (paginated) for every order.
 *   2. Sorts oldest-first; the oldest becomes the primary.
 *   3. Guards (any failure aborts before anything is changed):
 *      • every order is not cancelled, PAID and UNFULFILLED;
 *      • every order has the same customer, address and shipping method;
 *      • no line item has custom properties (Shopify's order-edit API cannot
 *        carry these over);
 *      • every secondary line item still on the order has a variant, so it can
 *        be transferred.
 *   4. Opens an order-edit session on the primary.
 *   5. Adds every secondary line item to the primary and applies a 100 %
 *      discount so the primary balance does not increase. Any failure here
 *      abandons the uncommitted edit, so no item is ever dropped.
 *   6. Commits the edit silently.
 *   7. Cancels every secondary with reason OTHER, restock, no refund, then
 *      closes it.
 *   8. Appends any secondary customer notes to the primary note and merges
 *      all tags (plus "merged") into a unique list on the primary.
 *
 * @param admin  Shopify admin GraphQL client (from authenticate.admin or
 *               authenticate.webhook).
 * @param orderIds  Array of Shopify Order GIDs to merge (minimum 2).
 */
export async function executeMerge(
  admin: AdminClient,
  orderIds: string[],
): Promise<MergeResult> {
  if (orderIds.length < 2) {
    return { success: false, error: "At least two orders are required to merge." };
  }

  // 1 ── Fetch order details ──────────────────────────────────────────────────
  const detailsRes = await admin.graphql(
    `#graphql
      query OrderDetails($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Order {
            id
            name
            createdAt
            cancelledAt
            displayFinancialStatus
            displayFulfillmentStatus
            note
            tags
            customer { id }
            shippingAddress {
              address1
              address2
              city
              provinceCode
              zip
              countryCodeV2
            }
            shippingLine { title }
          }
        }
      }`,
    { variables: { ids: orderIds } },
  );
  const detailsJson = await detailsRes.json();
  const orders = (detailsJson.data?.nodes ?? []).filter(Boolean) as any[];

  if (orders.length !== orderIds.length) {
    return { success: false, error: "Could not retrieve details for every order." };
  }

  // 2 ── Sort oldest-first; the primary order is the earliest ─────────────────
  orders.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  const primary = orders[0];
  const secondaries = orders.slice(1);
  const secondaryNames = secondaries.map((o: any) => o.name).join(", ");

  const abort = (error: string): MergeResult => {
    console.log(`Merge aborted (${orders.map((o: any) => o.name).join(", ")}): ${error}`);
    return { success: false, error };
  };

  // 3a ── Guard: status — not cancelled, paid, fully unfulfilled ──────────────
  // Defense-in-depth: callers already filter, but executeMerge re-checks so it
  // is safe regardless of how it is invoked (e.g. a tampered UI form post).
  for (const order of orders) {
    if (order.cancelledAt) {
      return abort(`Order ${order.name} is cancelled.`);
    }
    if (order.displayFinancialStatus !== "PAID") {
      return abort(`Order ${order.name} is not paid (status: ${order.displayFinancialStatus}).`);
    }
    if (order.displayFulfillmentStatus !== "UNFULFILLED") {
      return abort(
        `Order ${order.name} is not unfulfilled (status: ${order.displayFulfillmentStatus}).`,
      );
    }
  }

  // 3b ── Guard: same customer, address and shipping method ──────────────────
  const groupKeys = orders.map((o: any) =>
    buildGroupKey(o.customer?.id, o.shippingAddress, o.shippingLine?.title),
  );
  if (groupKeys.some((k) => !k || k !== groupKeys[0])) {
    return abort(
      "Orders do not share the same customer, shipping address and shipping method.",
    );
  }

  // 3c ── Load every line item (paginated) ────────────────────────────────────
  const lineItemsById = new Map<string, MergeLineItem[]>();
  try {
    for (const order of orders) {
      lineItemsById.set(order.id, await fetchAllLineItems(admin, order.id));
    }
  } catch (err: any) {
    return abort(err?.message ?? "Could not load line items.");
  }

  // 3d ── Guard: line item properties ─────────────────────────────────────────
  // Shopify's order-edit API (orderEditAddVariant) has no argument for
  // customAttributes, so properties on personalized products cannot be carried
  // over to the primary. Skip the entire merge to leave those orders untouched.
  for (const order of orders) {
    const hasProperties = lineItemsById
      .get(order.id)!
      .some((item) => item.customAttributes.length > 0);
    if (hasProperties) {
      console.log(
        `Skipping merge for order ${order.name}: contains custom line item properties that cannot be edited via Shopify API.`,
      );
      return {
        success: false,
        error: `Order ${order.name} has line items with custom properties. These orders were left untouched to preserve fulfillment details.`,
      };
    }
  }

  // 3e ── Guard: every secondary item must be transferable ────────────────────
  // Items with currentQuantity 0 were already removed from the order and are
  // not transferred. Anything else without a variant (custom items, deleted
  // products) cannot be added via orderEditAddVariant, so abort rather than
  // drop it and cancel the order.
  for (const secondary of secondaries) {
    const untransferable = lineItemsById
      .get(secondary.id)!
      .find((item) => item.currentQuantity > 0 && !item.variant?.id);
    if (untransferable) {
      return abort(
        `Order ${secondary.name} contains "${untransferable.name}", which is a custom item or a deleted product and cannot be transferred. No orders were changed.`,
      );
    }
  }

  // 4 ── Begin an order-edit session on the primary order ────────────────────
  const editBeginRes = await admin.graphql(
    `#graphql
      mutation orderEditBegin($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }`,
    { variables: { id: primary.id } },
  );
  const editBeginJson = await editBeginRes.json();
  const calcId = editBeginJson.data?.orderEditBegin?.calculatedOrder?.id;
  const beginErrors = editBeginJson.data?.orderEditBegin?.userErrors ?? [];

  if (!calcId || beginErrors.length) {
    return {
      success: false,
      error: `Could not begin edit on ${primary.name}: ${
        beginErrors.map((e: any) => e.message).join("; ") || "unknown error"
      }`,
    };
  }

  // 5 ── Transfer every line item and zero-out the added price ──────────────
  // Returning before orderEditCommit abandons the calculated order, so a
  // failure on any single item leaves every order exactly as it was.
  for (const secondary of secondaries) {
    for (const item of lineItemsById.get(secondary.id)!) {
      if (item.currentQuantity <= 0) continue;

      const addRes = await admin.graphql(
        `#graphql
          mutation orderEditAddVariant(
            $id: ID!
            $variantId: ID!
            $quantity: Int!
          ) {
            orderEditAddVariant(
              id: $id
              variantId: $variantId
              quantity: $quantity
              allowDuplicates: true
            ) {
              calculatedLineItem { id }
              calculatedOrder { id }
              userErrors { field message }
            }
          }`,
        {
          variables: {
            id: calcId,
            variantId: item.variant!.id,
            quantity: item.currentQuantity,
          },
        },
      );
      const addJson = await addRes.json();
      const addErrors = addJson.data?.orderEditAddVariant?.userErrors ?? [];
      const calcLineItemId =
        addJson.data?.orderEditAddVariant?.calculatedLineItem?.id;
      if (addErrors.length || !calcLineItemId) {
        return abort(
          `Could not transfer "${item.name}" from ${secondary.name}: ${
            addErrors.map((e: any) => e.message).join("; ") || "unknown error"
          }. No orders were changed.`,
        );
      }

      // Apply a 100 % discount so the primary balance stays zero
      const discountRes = await admin.graphql(
        `#graphql
          mutation orderEditAddLineItemDiscount(
            $id: ID!
            $lineItemId: ID!
            $discount: OrderEditAppliedDiscountInput!
          ) {
            orderEditAddLineItemDiscount(
              id: $id
              lineItemId: $lineItemId
              discount: $discount
            ) {
              calculatedOrder { id }
              userErrors { field message }
            }
          }`,
        {
          variables: {
            id: calcId,
            lineItemId: calcLineItemId,
            discount: {
              percentValue: 100,
              description: `Merged from ${secondary.name} — already paid`,
            },
          },
        },
      );
      const discountJson = await discountRes.json();
      const discountErrors =
        discountJson.data?.orderEditAddLineItemDiscount?.userErrors ?? [];
      if (discountErrors.length) {
        return abort(
          `Could not discount "${item.name}" from ${secondary.name}: ${discountErrors
            .map((e: any) => e.message)
            .join("; ")}. No orders were changed.`,
        );
      }
    }
  }

  // 6 ── Commit the edit (no customer notification) ─────────────────────────
  const commitRes = await admin.graphql(
    `#graphql
      mutation orderEditCommit($id: ID!, $staffNote: String) {
        orderEditCommit(id: $id, notifyCustomer: false, staffNote: $staffNote) {
          order { id }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        id: calcId,
        staffNote: `Merged line items from ${secondaryNames}.`,
      },
    },
  );
  const commitJson = await commitRes.json();
  const commitErrors = commitJson.data?.orderEditCommit?.userErrors ?? [];

  if (commitErrors.length) {
    return {
      success: false,
      error: `Failed to commit edit: ${commitErrors.map((e: any) => e.message).join("; ")}`,
    };
  }

  // 7 ── Cancel each secondary, then close it so the Orders badge decrements ──
  const cancelResults: { name: string; cancelled: boolean; error?: string }[] = [];
  for (const secondary of secondaries) {
    try {
      const cancelRes = await admin.graphql(
        `#graphql
          mutation orderCancel(
            $orderId: ID!
            $reason: OrderCancelReason!
            $restock: Boolean!
            $refund: Boolean!
            $staffNote: String
          ) {
            orderCancel(
              orderId: $orderId
              reason: $reason
              notifyCustomer: false
              restock: $restock
              refund: $refund
              staffNote: $staffNote
            ) {
              orderCancelUserErrors { field message }
            }
          }`,
        {
          variables: {
            orderId: secondary.id,
            reason: "OTHER",
            restock: true,
            refund: false,
            staffNote: `Duplicate — merged into ${primary.name}. Line items transferred; inventory restocked.`,
          },
        },
      );
      const cancelJson = await cancelRes.json();
      const cancelErrors =
        cancelJson.data?.orderCancel?.orderCancelUserErrors ?? [];

      if (cancelErrors.length) {
        const msg = cancelErrors.map((e: any) => e.message).join("; ");
        console.error(`orderCancel errors for ${secondary.name}:`, msg);
        cancelResults.push({ name: secondary.name, cancelled: false, error: msg });
      } else {
        console.log(`orderCancel OK for ${secondary.name}`);

        // Close the cancelled order so Shopify finalises its lifecycle and the
        // Orders sidebar badge decrements immediately. Without this step the
        // badge stays elevated when restock:true is used (Shopify leaves the
        // order in a pending-inventory state that keeps it in the active count).
        try {
          const closeRes = await admin.graphql(
            `#graphql
              mutation orderClose($input: OrderCloseInput!) {
                orderClose(input: $input) {
                  order { id }
                  userErrors { field message }
                }
              }`,
            { variables: { input: { id: secondary.id } } },
          );
          const closeJson = await closeRes.json();
          const closeErrors = closeJson.data?.orderClose?.userErrors ?? [];
          if (closeErrors.length) {
            console.warn(
              `orderClose warnings for ${secondary.name}:`,
              closeErrors.map((e: any) => e.message).join("; "),
            );
          } else {
            console.log(`orderClose OK for ${secondary.name}`);
          }
        } catch (closeErr: any) {
          // Non-fatal: cancel already succeeded, close is a best-effort badge fix
          console.warn(`orderClose threw for ${secondary.name}:`, closeErr?.message);
        }

        cancelResults.push({ name: secondary.name, cancelled: true });
      }
    } catch (err: any) {
      console.error(`orderCancel threw for ${secondary.name}:`, err?.message);
      cancelResults.push({
        name: secondary.name,
        cancelled: false,
        error: err?.message ?? "Unknown error",
      });
    }
  }

  // 8 ── Carry over secondary customer notes and union tags (+ "merged") ────
  const primaryNote = (primary.note ?? "").trim();
  const secondaryNotes = secondaries
    .map((o: any) => ({ name: o.name, note: (o.note ?? "").trim() }))
    .filter(({ note }) => note && !primaryNote.includes(note))
    .map(({ name, note }) => `Note from ${name}: ${note}`);

  // Shopify tags are case-insensitive; keep the first-seen casing of each
  const tagMap = new Map<string, string>();
  const allTags = orders.flatMap((o: any) => (o.tags ?? []) as string[]);
  for (const tag of [...allTags, "merged"]) {
    const trimmed = tag.trim();
    if (trimmed && !tagMap.has(trimmed.toLowerCase())) {
      tagMap.set(trimmed.toLowerCase(), trimmed);
    }
  }

  const updateRes = await admin.graphql(
    `#graphql
      mutation orderUpdate($input: OrderInput!) {
        orderUpdate(input: $input) {
          order { id }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        input: {
          id: primary.id,
          tags: [...tagMap.values()],
          // Only touch the note when there is a customer note to carry over
          ...(secondaryNotes.length > 0 && {
            note: [primaryNote, ...secondaryNotes].filter(Boolean).join("\n"),
          }),
        },
      },
    },
  );
  const updateErrors = (await updateRes.json()).data?.orderUpdate?.userErrors ?? [];
  if (updateErrors.length) {
    console.error(
      `orderUpdate errors for ${primary.name}:`,
      updateErrors.map((e: any) => e.message).join("; "),
    );
  }

  return {
    success: true,
    primaryOrderId: primary.id as string,
    primaryName: primary.name as string,
    mergedCount: secondaries.length,
    cancelResults,
  };
}
