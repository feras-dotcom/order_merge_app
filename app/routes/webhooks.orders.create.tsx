import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getSettings } from "../lib/settings.server";
import { isOnboardingComplete } from "../lib/onboarding";
import { LEASE_TTL_MS, newLeaseToken } from "../lib/ownership.server";
import { prismaWorkStore, WORK_DEADLINE_MS } from "../lib/order-work.server";
import { prismaOperationStore } from "../lib/operation-store.server";
import { processOrderWork } from "../lib/order-work-processor.server";
import { defaultMergeDeps } from "../lib/merge.server";

// ── ORDERS_CREATE webhook handler ─────────────────────────────────────────────
//
// When a new order arrives this handler:
//   1. Does nothing unless the merchant has opted in and finished setup — a
//      disabled store never records a work item, so future deliveries are
//      still processed once enabled.
//   2. Inserts a durable PENDING work item (ProcessedWebhook) leased to this
//      process. The (shop, orderId) unique key makes redeliveries no-ops; a
//      non-duplicate insert error is answered 500 so Shopify retries.
//   3. Processes the item in the background and acknowledges immediately — a
//      merge can take longer than Shopify's webhook timeout, and repeated
//      timeouts cause redeliveries and eventually subscription removal.
//
// The work item survives a crash: once its lease expires the sweeper
// (background-worker.server.ts) re-leases it and drives it to a terminal
// outcome. The payload itself is not trusted for eligibility — the processor
// loads the order fresh; only admin_graphql_api_id is read here.

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

  const settings = await getSettings(shop);
  // Merging only runs after setup is complete (which is also where it is
  // first turned on) and while the merchant has it on.
  if (!settings.autoMergeEnabled || !isOnboardingComplete(settings)) {
    console.log(`[orders/create] Auto-merge is not enabled for ${shop} — skipping.`);
    return new Response();
  }

  const orderId = (payload as Record<string, any>)?.admin_graphql_api_id as string | undefined;
  if (!orderId) {
    console.error(`[orders/create] Webhook for ${shop} carried no order id — skipping.`);
    return new Response();
  }

  const work = prismaWorkStore();
  const token = newLeaseToken();
  let item;
  try {
    item = await work.insertLeased(shop, orderId, token, LEASE_TTL_MS, WORK_DEADLINE_MS);
  } catch (err: any) {
    // Not a duplicate — the write itself failed. Answer 500 so Shopify
    // redelivers instead of silently dropping the order.
    console.error(`[orders/create] Could not record work for ${orderId}: ${err?.message}`);
    return new Response(null, { status: 500 });
  }
  if (!item) {
    console.log(`[orders/create] Duplicate delivery for ${orderId} — skipping.`);
    return new Response();
  }

  // Protocol v2 kill switches: the row is durable either way, so a disabled
  // store simply leaves it for the sweeper to process once enabled. Inline
  // processing is a latency optimization only.
  const inline =
    process.env.MERGESHIP_MUTATIONS === "enabled" &&
    (await prismaOperationStore.isEnabled(shop, "newMergesEnabled"));
  if (!inline) {
    console.log(`[orders/create] Merge mutations not enabled for ${shop} — leaving the work item for the sweeper.`);
    return new Response();
  }

  void processOrderWork({
    item,
    token,
    shop,
    admin,
    deps: defaultMergeDeps(),
    work,
    settings: getSettings,
    now: () => new Date(),
  }).catch((err) => console.error(`[orders/create] Processing failed for ${orderId}: ${err?.message ?? err}`));
  return new Response();
};
