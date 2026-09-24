import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { buildGroupKey, executeMerge } from "../lib/merge.server";
import { getSettings } from "../lib/settings.server";

// ── In-memory lock: prevents two concurrent webhook deliveries from merging
// the same address+shipping group simultaneously. Keyed on the normalized
// group key so independent groups are never blocked by each other.
// This is sufficient for a single-instance Railway deployment. If the app
// ever runs multiple replicas, replace this with a database advisory lock.
const activeGroupMerges = new Set<string>();

// ── ORDERS_CREATE webhook handler ─────────────────────────────────────────────
//
// When a new paid, unfulfilled order arrives this handler:
//   1. Enforces idempotency so duplicate deliveries are no-ops.
//   2. Guards against processing an incoming order that is already cancelled
//      (i.e. it was a secondary in a previous merge run) or unpaid.
//   3. Fetches other open + unfulfilled + paid orders for the same customer.
//      Primary orders that previously absorbed other orders are included —
//      they are still open and eligible to absorb additional orders.
//      Cancelled secondaries are excluded automatically by status:open.
//   4. Applies the same grouping rules as the UI: same customer, matching
//      normalized address, same shipping method (case/whitespace-insensitive),
//      and the merchant's configured creation window.
//   5. Calls executeMerge(), which adds only the NEW order's line items to the
//      primary and leaves the primary's existing items untouched.
//
// Always returns 200 so Shopify does not retry on expected-skip conditions.

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);

  if (topic !== "ORDERS_CREATE") {
    console.warn(`[orders/create] Unexpected topic: ${topic}`);
    return new Response();
  }

  const order = payload as Record<string, any>;
  const orderId = order.admin_graphql_api_id as string;

  // ── Load settings — checked before idempotency so a disabled store never ───
  // ── records an entry, allowing future deliveries to be processed if the    ──
  // ── merchant re-enables auto-merge.                                        ──
  const settings = await getSettings(shop);
  if (!settings.autoMergeEnabled) {
    console.log(`[orders/create] Auto-merge is disabled for ${shop} — skipping.`);
    return new Response();
  }
  const mergeWindowMs = settings.mergeWindowHours * 60 * 60 * 1000;

  // ── Idempotency ─────────────────────────────────────────────────────────────
  // Create a record before processing. A unique constraint violation means this
  // delivery was already handled — return 200 immediately to prevent double merges.
  try {
    await db.processedWebhook.create({ data: { shop, orderId } });
  } catch (e: any) {
    if (e.code === "P2002") {
      console.log(`[orders/create] Already processed ${orderId} — skipping.`);
      return new Response();
    }
    throw e;
  }

  // ── Guardrail: skip if the incoming order is already cancelled ────────────
  // A secondary order that was cancelled by a previous merge run would not
  // normally trigger orders/create again, but this is a belt-and-suspenders
  // check. cancelled_at being set is the reliable signal that this order was
  // already processed as a secondary — NOT the presence of a [Merge] note,
  // which only appears on primary orders and should not block processing.
  if (order.cancelled_at) {
    console.log(`[orders/create] ${orderId} is already cancelled — skipping.`);
    return new Response();
  }

  // ── Guardrail: only process paid orders ────────────────────────────────────
  if (order.financial_status !== "paid") {
    console.log(`[orders/create] ${orderId} is not paid (${order.financial_status}) — skipping.`);
    return new Response();
  }

  // ── Guardrail: only process unfulfilled orders ─────────────────────────────
  // For orders/create this is always null, but guard explicitly so the handler
  // stays correct if Shopify ever fires the webhook for a pre-fulfilled import.
  const fulfillmentStatus = order.fulfillment_status as string | null;
  if (fulfillmentStatus !== null && fulfillmentStatus !== "unfulfilled") {
    console.log(
      `[orders/create] ${orderId} has fulfillment status "${fulfillmentStatus}" — skipping.`,
    );
    return new Response();
  }

  // ── Guardrail: require a known customer ────────────────────────────────────
  const customerId = order.customer?.admin_graphql_api_id as string | undefined;
  if (!customerId) {
    console.log(`[orders/create] ${orderId} has no customer — skipping.`);
    return new Response();
  }

  // ── Build the new order's group key ────────────────────────────────────────
  // REST webhook fields use snake_case and province_code / country_code.
  const rawAddress = order.shipping_address as Record<string, string> | null;
  const newOrderAddress = rawAddress
    ? {
        address1: rawAddress.address1,
        address2: rawAddress.address2,
        city: rawAddress.city,
        provinceCode: rawAddress.province_code,
        zip: rawAddress.zip,
        countryCodeV2: rawAddress.country_code,
      }
    : null;
  const newOrderShippingTitle =
    (order.shipping_lines as any[])?.[0]?.title ?? null;
  const newOrderGroupKey = buildGroupKey(
    customerId,
    newOrderAddress,
    newOrderShippingTitle,
  );

  if (!newOrderGroupKey) {
    console.log(`[orders/create] ${orderId} has no usable shipping address — skipping.`);
    return new Response();
  }

  if (!admin) {
    console.error(`[orders/create] No admin client for ${shop} — skipping.`);
    return new Response();
  }

  // ── Fetch sibling orders for this customer ─────────────────────────────────
  // Shopify's search index may not yet include the brand-new order, so we
  // always inject it into the candidate pool from the webhook payload directly.
  const siblingsRes = await admin.graphql(
    `#graphql
      query CustomerOrders($customerId: ID!) {
        customer(id: $customerId) {
          orders(
            first: 50
            query: "fulfillment_status:unfulfilled status:open financial_status:paid"
          ) {
            nodes {
              id
              name
              createdAt
              note
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
        }
      }`,
    { variables: { customerId } },
  );
  const siblingsJson = await siblingsRes.json();
  const siblings = (
    siblingsJson.data?.customer?.orders?.nodes ?? []
  ) as any[];

  // ── Find siblings in the same group as the new order ──────────────────────
  // Primary orders that previously absorbed other orders carry a [Merge] note
  // but are still status:open and should remain eligible to receive more orders.
  // Cancelled secondaries are already excluded by the status:open query filter.
  const matchGroup: { id: string; createdAt: string }[] = [];
  for (const sibling of siblings) {
    // The new order itself may already be indexed — skip it to avoid duplication
    if (sibling.id === orderId) continue;
    const key = buildGroupKey(
      customerId,
      sibling.shippingAddress,
      sibling.shippingLine?.title,
    );
    if (key === newOrderGroupKey) {
      matchGroup.push({ id: sibling.id, createdAt: sibling.createdAt });
    }
  }

  if (matchGroup.length === 0) {
    console.log(`[orders/create] No matching sibling orders for ${orderId}.`);
    return new Response();
  }

  // ── Filter siblings by the merge window (anchor = incoming order) ─────────
  // Using the new order as the temporal anchor means a stale open order from
  // days ago in the same address+shipping bucket cannot inflate the span and
  // block a merge of two recent orders that are clearly within the window.
  // NaN timestamps (unparseable ISO strings) are excluded defensively.
  const newOrderTime = new Date(order.created_at as string).getTime();
  if (isNaN(newOrderTime)) {
    console.error(
      `[orders/create] Unparseable created_at for ${orderId}: ${order.created_at}`,
    );
    return new Response();
  }

  const eligibleSiblings = matchGroup.filter((sibling) => {
    const t = new Date(sibling.createdAt).getTime();
    return !isNaN(t) && Math.abs(newOrderTime - t) <= mergeWindowMs;
  });

  if (eligibleSiblings.length === 0) {
    console.log(
      `[orders/create] No siblings within the ${settings.mergeWindowHours}h window for ${orderId} — skipping.`,
    );
    return new Response();
  }

  const allCandidates = [
    { id: orderId, createdAt: order.created_at as string },
    ...eligibleSiblings,
  ];

  // ── In-memory lock: guard against concurrent merges for the same group ────
  if (activeGroupMerges.has(newOrderGroupKey)) {
    console.log(
      `[orders/create] Merge already in progress for group key of ${orderId} — skipping to avoid race condition.`,
    );
    return new Response();
  }

  // ── Execute merge ──────────────────────────────────────────────────────────
  const orderIds = allCandidates.map((o) => o.id);
  console.log(`[orders/create] Auto-merging orders: ${orderIds.join(", ")}`);

  activeGroupMerges.add(newOrderGroupKey);
  try {
    const result = await executeMerge(admin, shop, orderIds);
    if (result.success) {
      console.log(
        `[orders/create] Auto-merge OK — merged ${result.mergedCount} order(s) into ${result.primaryName}.`,
      );
    } else {
      console.error(`[orders/create] Auto-merge failed: ${result.error}`);
    }
  } finally {
    activeGroupMerges.delete(newOrderGroupKey);
  }

  return new Response();
};
