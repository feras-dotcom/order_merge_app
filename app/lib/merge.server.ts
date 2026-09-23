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

export interface AddressFields {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  provinceCode?: string | null;
  zip?: string | null;
  countryCodeV2?: string | null;
}

/**
 * Returns a composite key of (normalized address) + NUL + (shipping title).
 * Baking the shipping method into the key ensures different methods at the
 * same address form independent buckets instead of disqualifying each other.
 * Returns null when the order has no usable address.
 */
export function buildGroupKey(
  address: AddressFields | null | undefined,
  shippingTitle: string | null | undefined,
): string | null {
  if (!address) return null;
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
  // \0 is a safe separator — it cannot appear in address text or shipping titles
  return `${normalizedAddress}\0${shippingTitle ?? ""}`;
}

export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// ── Merge result type ─────────────────────────────────────────────────────────

export interface MergeResult {
  success: boolean;
  primaryOrderId?: string;
  primaryName?: string;
  mergedCount?: number;
  cancelResults?: { name: string; cancelled: boolean; error?: string }[];
  error?: string;
}

// ── Core merge execution ──────────────────────────────────────────────────────

/**
 * Executes a full merge of the supplied order IDs:
 *   1. Fetches full details (createdAt, fulfillment status, lineItems,
 *      customAttributes) for all orders.
 *   2. Sorts oldest-first; the oldest becomes the primary.
 *   3. Guards: returns immediately if any order is not UNFULFILLED.
 *   4. Guards: returns immediately if any order has line items with custom
 *      properties — Shopify's order-edit API cannot carry these over.
 *   5. Opens an order-edit session on the primary.
 *   6. Adds every secondary line item to the primary.
 *   7. Applies a 100 % discount to each transferred item so the primary
 *      balance does not increase (customer already paid on the secondary).
 *   8. Commits the edit silently.
 *   9. Cancels every secondary with reason OTHER, restock, no refund, then
 *      closes it.
 *  10. Appends any secondary customer notes to the primary note and merges
 *      all tags (plus "merged") into a unique list on the primary.
 *
 * @param admin  Shopify admin GraphQL client (from authenticate.admin or
 *               authenticate.webhook).
 * @param orderIds  Array of Shopify Order GIDs to merge (minimum 2).
 */
export async function executeMerge(
  admin: { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> },
  orderIds: string[],
): Promise<MergeResult> {
  if (orderIds.length < 2) {
    return { success: false, error: "At least two orders are required to merge." };
  }

  // 1 ── Fetch full order details including line items ───────────────────────
  const detailsRes = await admin.graphql(
    `#graphql
      query OrderDetails($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Order {
            id
            name
            createdAt
            displayFulfillmentStatus
            note
            tags
            lineItems(first: 50) {
              nodes {
                quantity
                variant { id }
                customAttributes { key value }
              }
            }
          }
        }
      }`,
    { variables: { ids: orderIds } },
  );
  const detailsJson = await detailsRes.json();
  const orders = (detailsJson.data?.nodes ?? []).filter(Boolean) as any[];

  if (orders.length < 2) {
    return { success: false, error: "Could not retrieve order details." };
  }

  // Sort oldest-first; the primary order is the earliest
  orders.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  const primary = orders[0];
  const secondaries = orders.slice(1);
  const secondaryNames = secondaries.map((o: any) => o.name).join(", ");

  // 2 ── Guard: all orders must be fully unfulfilled ───────────────────────────
  // Defense-in-depth: callers already filter by fulfillment status, but we
  // re-check here so executeMerge is safe regardless of how it is invoked.
  for (const order of orders) {
    if (order.displayFulfillmentStatus !== "UNFULFILLED") {
      console.log(
        `Skipping merge: order ${order.name} has fulfillment status ${order.displayFulfillmentStatus}.`,
      );
      return {
        success: false,
        error: `Order ${order.name} is not unfulfilled (status: ${order.displayFulfillmentStatus}). Merge aborted to avoid altering a fulfilled order.`,
      };
    }
  }

  // 4 ── Guard: skip any merge that involves orders with line item properties ─
  // Shopify's order-edit API (orderEditAddVariant) has no argument for
  // customAttributes, so properties on personalized products cannot be carried
  // over to the primary. Skip the entire merge to leave those orders untouched.
  for (const order of orders) {
    const hasProperties = (order.lineItems?.nodes ?? []).some(
      (item: any) => (item.customAttributes ?? []).length > 0,
    );
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

  // 3 ── Begin an order-edit session on the primary order ───────────────────
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
  for (const secondary of secondaries) {
    for (const item of secondary.lineItems.nodes) {
      if (!item.variant?.id) continue;

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
            variantId: item.variant.id,
            quantity: item.quantity,
          },
        },
      );
      const addJson = await addRes.json();
      const addErrors = addJson.data?.orderEditAddVariant?.userErrors ?? [];
      if (addErrors.length) {
        console.error("orderEditAddVariant error:", addErrors);
        continue;
      }

      // Apply a 100 % discount so the primary balance stays zero
      const calcLineItemId =
        addJson.data?.orderEditAddVariant?.calculatedLineItem?.id;
      if (calcLineItemId) {
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
          console.error("orderEditAddLineItemDiscount error:", discountErrors);
        }
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
