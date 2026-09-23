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
//
// All three are deleted in parallel. Individual failures are logged but do not
// prevent the other deletions from completing, and a 200 is always returned so
// Shopify does not retry unnecessarily. Manual reconciliation can be performed
// from the Railway PostgreSQL console using the logged shop domain.

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`[${topic}] Redact request for shop ${shop} — erasing all stored data.`);

  const [sessions, settings, processedWebhooks] = await Promise.allSettled([
    db.session.deleteMany({ where: { shop } }),
    db.settings.deleteMany({ where: { shop } }),
    db.processedWebhook.deleteMany({ where: { shop } }),
  ]);

  if (sessions.status === "rejected") {
    console.error(`[${topic}] Failed to delete sessions for ${shop}:`, sessions.reason);
  } else {
    console.log(`[${topic}] Deleted ${sessions.value.count} session(s) for ${shop}.`);
  }

  if (settings.status === "rejected") {
    console.error(`[${topic}] Failed to delete settings for ${shop}:`, settings.reason);
  } else {
    console.log(`[${topic}] Deleted ${settings.value.count} settings row(s) for ${shop}.`);
  }

  if (processedWebhooks.status === "rejected") {
    console.error(`[${topic}] Failed to delete processed webhooks for ${shop}:`, processedWebhooks.reason);
  } else {
    console.log(
      `[${topic}] Deleted ${processedWebhooks.value.count} processed-webhook record(s) for ${shop}.`,
    );
  }

  return new Response();
};
