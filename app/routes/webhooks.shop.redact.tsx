import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ── SHOP_REDACT mandatory privacy webhook ─────────────────────────────────────
//
// Shopify sends this 48 hours after a shop uninstalls the app, once Shopify
// itself has erased the shop's customer data on its end. The app must delete
// every record it holds for that shop.
//
// Tables that contain shop data:
//   • Session          — OAuth tokens for the shop
//   • Settings         — per-shop auto-merge preferences
//   • ProcessedWebhook — idempotency log of processed ORDERS_CREATE events
//   • MergeRecord      — consolidation history shown on the dashboard
//
// All four are deleted in parallel. Individual failures are logged but do not
// prevent the other deletions from completing, and a 200 is always returned so
// Shopify does not retry unnecessarily. Manual reconciliation can be performed
// from the Railway PostgreSQL console using the logged shop domain.

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`[${topic}] Redact request for shop ${shop} — erasing all stored data.`);

  const deletions = [
    ["session", db.session.deleteMany({ where: { shop } })],
    ["settings", db.settings.deleteMany({ where: { shop } })],
    ["processed-webhook", db.processedWebhook.deleteMany({ where: { shop } })],
    ["merge-history", db.mergeRecord.deleteMany({ where: { shop } })],
  ] as const;

  const results = await Promise.allSettled(deletions.map(([, op]) => op));
  results.forEach((result, i) => {
    const label = deletions[i][0];
    if (result.status === "rejected") {
      console.error(`[${topic}] Failed to delete ${label} records for ${shop}:`, result.reason);
    } else {
      console.log(`[${topic}] Deleted ${result.value.count} ${label} record(s) for ${shop}.`);
    }
  });

  return new Response();
};
