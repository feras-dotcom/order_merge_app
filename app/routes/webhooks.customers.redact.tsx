import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ── CUSTOMERS_REDACT mandatory privacy webhook ────────────────────────────────
//
// Shopify sends this when a customer requests deletion of their personal data
// (48 hours after a data-request, or when a shop owner initiates erasure).
//
// The only customer-linked data this app stores is consolidation history
// (MergeRecord): Shopify order IDs, order names and the customer ID. No names,
// emails or addresses are persisted. Every MergeRecord row linked to the
// customer, or to any of the orders Shopify lists for redaction, is deleted.
// Shopify requires a 200 response within 5 minutes.

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const body = payload as Record<string, any>;

  const customerId = body?.customer?.id;
  const customerGid = customerId ? `gid://shopify/Customer/${customerId}` : null;
  const orderGids = ((body?.orders_to_redact ?? []) as (number | string)[]).map(
    (id) => `gid://shopify/Order/${id}`,
  );

  try {
    const { count } = await db.mergeRecord.deleteMany({
      where: {
        shop,
        OR: [
          ...(customerGid ? [{ customerId: customerGid }] : []),
          { primaryOrderId: { in: orderGids } },
          { mergedOrderId: { in: orderGids } },
        ],
      },
    });
    console.log(
      `[${topic}] Redacted customer ${customerId ?? "unknown"} in shop ${shop}: deleted ${count} merge-history record(s).`,
    );
  } catch (err) {
    console.error(`[${topic}] Failed to redact customer ${customerId ?? "unknown"} in ${shop}:`, err);
  }

  return new Response();
};
