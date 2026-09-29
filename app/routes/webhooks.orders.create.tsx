import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  buildGroupKey,
  defaultMergeDeps,
  executeMerge,
  resumeIncompleteMerges,
} from "../lib/merge.server";
import { gql } from "../lib/graphql.server";
import { getSettings } from "../lib/settings.server";
import { isOnboardingComplete } from "../lib/onboarding";

// ── In-memory lock: prevents two concurrent webhook deliveries from merging
// the same address+shipping group simultaneously. Keyed on the normalized
// group key so independent groups are never blocked by each other.
// This is sufficient for a single-instance Railway deployment. If the app
// ever runs multiple replicas, replace this with a database advisory lock.
const activeGroupMerges = new Set<string>();

// ── ORDERS_CREATE webhook handler ─────────────────────────────────────────────
//
// When a new order arrives this handler:
//   1. Resumes any unfinished merge for the shop (see merge.server.ts), even
//      if auto-merge has since been turned off — a committed merge must still
//      have its secondaries cancelled.
//   2. Does nothing further unless the merchant has opted in to auto-merge.
//   3. Enforces idempotency so duplicate deliveries are no-ops.
//   4. Cheaply pre-filters the incoming order (cancelled, unpaid, fulfilled,
//      no customer, no usable address / single shipping method).
//   5. Finds other open, unfulfilled, paid orders for the same customer with
//      the same recipient, address and shipping method inside the merchant's
//      window, excluding orders involved in unfinished or flagged merges.
//   6. Calls executeMerge(), which re-checks every rule on fresh state.
//
// The webhook is acknowledged immediately and processed in the background:
// a merge (including confirming asynchronous cancellations) can take longer
// than Shopify's webhook timeout, and repeated timeouts cause redeliveries and
// eventually subscription removal. Losing the process before the commit
// changes nothing; after the commit, the MergeOperation journal resumes it.

type WebhookAdmin = NonNullable<Awaited<ReturnType<typeof authenticate.webhook>>["admin"]>;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);

  if (topic !== "ORDERS_CREATE") {
    console.warn(`[orders/create] Unexpected topic: ${topic}`);
    return new Response();
  }
  if (!admin) {
    console.error(`[orders/create] No admin client for ${shop} — skipping.`);
    return new Response();
  }

  void handleOrderCreated(admin, shop, payload as Record<string, any>).catch((err) =>
    console.error(`[orders/create] Processing failed for ${shop}: ${err?.message ?? err}`),
  );
  return new Response();
};

async function handleOrderCreated(admin: WebhookAdmin, shop: string, order: Record<string, any>) {
  const deps = defaultMergeDeps();
  try {
    await resumeIncompleteMerges(admin, shop, deps);
  } catch (err: any) {
    console.error(`[orders/create] Resuming unfinished merges failed: ${err?.message}`);
  }

  const orderId = order.admin_graphql_api_id as string;

  // ── Opt-in: checked before idempotency so a disabled store never records an
  // ── entry, allowing future deliveries to be processed once enabled.
  const settings = await getSettings(shop);
  // Merging only runs after setup is complete (which is also where it is
  // first turned on) and while the merchant has it on.
  if (!settings.autoMergeEnabled || !isOnboardingComplete(settings)) {
    console.log(`[orders/create] Auto-merge is not enabled for ${shop} — skipping.`);
    return;
  }
  const mergeWindowMs = settings.mergeWindowHours * 60 * 60 * 1000;

  // ── Idempotency ─────────────────────────────────────────────────────────────
  try {
    await db.processedWebhook.create({ data: { shop, orderId } });
  } catch (e: any) {
    if (e.code === "P2002") {
      console.log(`[orders/create] Already processed ${orderId} — skipping.`);
      return;
    }
    throw e;
  }

  // ── Cheap pre-filters (executeMerge re-checks all of these authoritatively)
  if (order.cancelled_at) return skip(orderId, "already cancelled");
  if (order.financial_status !== "paid") return skip(orderId, `not paid (${order.financial_status})`);
  const fulfillmentStatus = order.fulfillment_status as string | null;
  if (fulfillmentStatus !== null && fulfillmentStatus !== "unfulfilled") {
    return skip(orderId, `fulfillment status "${fulfillmentStatus}"`);
  }
  const customerId = order.customer?.admin_graphql_api_id as string | undefined;
  if (!customerId) return skip(orderId, "no customer");

  // REST webhook fields use snake_case and province_code / country_code.
  const rawAddress = order.shipping_address as Record<string, string> | null;
  const newOrderGroupKey = buildGroupKey(
    customerId,
    rawAddress && {
      firstName: rawAddress.first_name,
      lastName: rawAddress.last_name,
      company: rawAddress.company,
      address1: rawAddress.address1,
      address2: rawAddress.address2,
      city: rawAddress.city,
      provinceCode: rawAddress.province_code,
      zip: rawAddress.zip,
      countryCodeV2: rawAddress.country_code,
    },
    ((order.shipping_lines as any[]) ?? []).map((l) => l?.title),
  );
  if (!newOrderGroupKey) {
    return skip(orderId, "no usable shipping address or not exactly one shipping method");
  }

  const newOrderTime = new Date(order.created_at as string).getTime();
  if (isNaN(newOrderTime)) return skip(orderId, `unparseable created_at ${order.created_at}`);

  // ── Candidate siblings for this customer ──────────────────────────────────
  // Shopify's search index may not yet include the brand-new order, so it is
  // always added to the candidate list from the webhook payload directly.
  let siblings: any[];
  try {
    const customer = await gql(
      admin,
      "Load customer orders",
      `#graphql
        query MergeCandidateOrders($customerId: ID!) {
          customer(id: $customerId) {
            orders(
              first: 50
              sortKey: CREATED_AT
              reverse: true
              query: "fulfillment_status:unfulfilled status:open financial_status:paid"
            ) {
              nodes {
                id
                name
                createdAt
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
                shippingLines(first: 5) { nodes { title } }
              }
            }
          }
        }`,
      { customerId },
      "customer",
      null,
    );
    siblings = customer.orders?.nodes ?? [];
  } catch (err: any) {
    console.error(`[orders/create] Could not load candidate orders: ${err?.message}`);
    return;
  }

  const blocked = await deps.journal.findBlockingOrderIds(shop);
  if (blocked.has(orderId)) return skip(orderId, "part of an unfinished or flagged merge");

  const eligibleSiblings = siblings.filter((sibling) => {
    if (sibling.id === orderId || blocked.has(sibling.id)) return false;
    const key = buildGroupKey(
      customerId,
      sibling.shippingAddress,
      (sibling.shippingLines?.nodes ?? []).map((l: any) => l?.title),
    );
    const t = new Date(sibling.createdAt).getTime();
    return key === newOrderGroupKey && !isNaN(t) && Math.abs(newOrderTime - t) <= mergeWindowMs;
  });

  if (eligibleSiblings.length === 0) {
    return skip(orderId, `no matching sibling within ${settings.mergeWindowHours}h`);
  }

  if (activeGroupMerges.has(newOrderGroupKey)) {
    return skip(orderId, "merge already in progress for this group");
  }

  const orderIds = [orderId, ...eligibleSiblings.map((s) => s.id as string)];
  console.log(`[orders/create] Auto-merging orders: ${orderIds.join(", ")}`);

  activeGroupMerges.add(newOrderGroupKey);
  try {
    const result = await executeMerge(admin, shop, orderIds, deps);
    console.log(
      `[orders/create] Merge outcome ${result.outcome}` +
        (result.primaryName ? ` (primary ${result.primaryName})` : "") +
        (result.reason ? `: ${result.reason}` : ""),
    );
  } catch (err: any) {
    console.error(`[orders/create] Merge threw: ${err?.message}`);
  } finally {
    activeGroupMerges.delete(newOrderGroupKey);
  }
}

function skip(orderId: string, reason: string) {
  console.log(`[orders/create] ${orderId} skipped: ${reason}.`);
}
