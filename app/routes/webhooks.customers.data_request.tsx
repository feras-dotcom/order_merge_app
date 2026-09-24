import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ── CUSTOMERS_DATA_REQUEST mandatory privacy webhook ──────────────────────────
//
// Shopify sends this when a customer (or admin acting on their behalf) requests
// a copy of all personal data the app holds for them.
//
// The only customer-linked data this app stores is consolidation history
// (MergeRecord): Shopify order IDs, order names and the customer ID. No names,
// emails or addresses are persisted. The matching records are logged so they
// can be provided to the store owner on request. Shopify requires a 200
// response within 5 minutes.

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const customerId = (payload as Record<string, any>)?.customer?.id;
  if (!customerId) {
    console.log(`[${topic}] Data request in shop ${shop} without a customer ID.`);
    return new Response();
  }

  const records = await db.mergeRecord.findMany({
    where: { shop, customerId: `gid://shopify/Customer/${customerId}` },
    select: { primaryOrderName: true, mergedOrderName: true, createdAt: true },
  });
  console.log(
    `[${topic}] Data request for customer ${customerId} in shop ${shop}: ` +
      `${records.length} merge-history record(s).`,
    records,
  );

  return new Response();
};
