// Shared handler for the four checkout-eligibility webhooks
// (ORDERS_PAID, ORDERS_CANCELLED, ORDERS_FULFILLED,
// ORDERS_PARTIALLY_FULFILLED). One helper so authentication stays in exactly
// one place — the routes are ~5 lines each.
//
//   1. Authenticate + topic check.
//   2. Cheap gate pre-check — a gated-off shop answers 200 WITHOUT writing a
//      durable row, so enabling later never replays stale deliveries.
//   3. Read only admin_graphql_api_id; the payload is never trusted for
//      eligibility (the processor reloads the order).
//   4. upsertDirty marks the order dirty (gen + 1). An insert failure is
//      answered 500 so Shopify retries; a live lease just records the newer
//      generation and leaves processing to its owner.
//   5. When this delivery acquired the lease AND the gate is on, processing
//      runs inline as a latency optimization — the sweeper owns it
//      otherwise, and always on any failure.

import { authenticate } from "../../shopify.server";
import { LEASE_TTL_MS, newLeaseToken } from "../ownership.server";
import { checkoutDiscountGate } from "./gate.server";
import { processCheckoutWork } from "./processor.server";
import {
  CHECKOUT_DEADLINE_MS,
  prismaCheckoutWorkStore,
  type CheckoutWorkStore,
} from "./work.server";

export type CheckoutWebhookTopic =
  | "ORDERS_PAID"
  | "ORDERS_CANCELLED"
  | "ORDERS_FULFILLED"
  | "ORDERS_PARTIALLY_FULFILLED";

const TOPICS: readonly string[] = [
  "ORDERS_PAID",
  "ORDERS_CANCELLED",
  "ORDERS_FULFILLED",
  "ORDERS_PARTIALLY_FULFILLED",
];

export const handleCheckoutEligibilityWebhook = async (
  request: Request,
  topic: CheckoutWebhookTopic,
  deps: { work?: CheckoutWorkStore } = {},
): Promise<Response> => {
  const { topic: actual, shop, payload, admin } = await authenticate.webhook(request);

  if (actual !== topic || !TOPICS.includes(actual)) {
    console.warn(`[checkout] Unexpected topic: ${actual} (expected ${topic})`);
    return new Response();
  }

  // Cheap pre-check only: off => 200, nothing written. The processor
  // re-checks authoritatively anyway; this only saves a durable row.
  const gate = await checkoutDiscountGate(shop);
  if (!gate.on) return new Response();

  const orderId = (payload as Record<string, any>)?.admin_graphql_api_id as string | undefined;
  if (!orderId) {
    console.error(`[checkout] Webhook for ${shop} carried no order id — skipping.`);
    return new Response();
  }

  const work = deps.work ?? prismaCheckoutWorkStore();
  const token = newLeaseToken();
  let dirty;
  try {
    dirty = await work.upsertDirty(shop, orderId, token, LEASE_TTL_MS, CHECKOUT_DEADLINE_MS);
  } catch (err: any) {
    // The durable mark itself failed — answer 500 so Shopify redelivers
    // instead of silently dropping the event.
    console.error(`[checkout] Could not record work for ${orderId}: ${err?.message}`);
    return new Response(null, { status: 500 });
  }

  if (!dirty.acquired) {
    // A live worker already owns this order: the newer generation is on the
    // row, its owner settles or requeues — never lost (D1).
    return new Response();
  }
  if (!admin) return new Response(); // no inline admin: the sweeper picks it up

  void processCheckoutWork({
    item: dirty.item,
    token,
    shop,
    admin,
    work,
    now: () => new Date(),
  }).catch((err) =>
    console.error(`[checkout] Processing failed for ${orderId}: ${err?.message ?? err}`),
  );
  return new Response();
};
