import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// ── CUSTOMERS_REDACT mandatory privacy webhook ────────────────────────────────
//
// Shopify sends this when a customer requests deletion of their personal data
// (48 hours after a data-request, or when a shop owner initiates erasure).
//
// This app does NOT persist any personal customer data. It reads order and
// customer information on-the-fly from Shopify's Admin API but never writes
// it to its own database. Session tokens and app settings are keyed on the
// shop domain, not on individual customers.
//
// Because there is no customer-specific data stored, we acknowledge the
// deletion request immediately with HTTP 200. Shopify requires a 200 response
// within 5 minutes.

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const customerId = (payload as Record<string, any>)?.customer?.id ?? "unknown";
  console.log(
    `[${topic}] Redact request for customer ${customerId} in shop ${shop}. ` +
      "No customer data is stored by this app — nothing to erase.",
  );

  return new Response();
};
