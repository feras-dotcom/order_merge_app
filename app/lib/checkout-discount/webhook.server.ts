// Shared handler for the checkout-eligibility webhooks. One helper so
// authentication stays in exactly one place — the routes are ~5 lines each.
//
// Disqualifier → topic coverage (audit, D1): a previously eligible order
// must stop granting after a disqualifying change. Cancellation, closes,
// order edits (address/shipping lines/discounts), refunds and fulfillments
// all fire `orders/updated`; `orders/edited` is therefore redundant and NOT
// subscribed. `refunds/create` is the explicit financial signal (refund
// also flips displayFinancialStatus away from PAID), risk is delivered by
// `orders/risk_assessment_changed` (own topic), and paid/cancelled/
// fulfilled/partially_fulfilled keep their dedicated topics for promptness.
// Fulfillment holds and location changes have no webhook at all — the
// sweeper's `reopenOutstanding` re-check (C3) covers them and any lost
// delivery, re-verifying every outstanding projected row against fresh
// Shopify state roughly every CHECKOUT_RECHECK_MS.
//
//   1. Authenticate + topic check.
//   2. Gate pre-check — a CONFIRMED-off shop answers 200 WITHOUT writing a
//      durable row (enabling later never replays stale deliveries). A gate
//      that cannot prove itself (dependency read threw → `unknown`) is
//      retried a few times in-handler; still unreadable → 500 so Shopify
//      redelivers with its own backoff.
//   3. Extract the order id per topic (payload field shapes from Shopify's
//      webhook reference): orders/* carry `admin_graphql_api_id` (GID),
//      refunds/create carries a numeric `order_id`, and
//      orders/risk_assessment_changed carries `admin_graphql_api_order_id`
//      (GID, may be null) plus a numeric `order_id`. A GID is built only
//      from a purely numeric id; anything else is rejected with 200 —
//      malformed payloads are acknowledged, never retried forever.
//   4. ORDERS_PAID upserts a work row; every other topic only TOUCHES an
//      existing one (touchExisting) — an order that never became work has
//      nothing to revoke, keeping the all-orders streams cheap. A store
//      failure is answered 500 so Shopify retries.
//   5. When this delivery acquired the lease AND the gate is on, processing
//      runs inline as a latency optimization — the sweeper owns it
//      otherwise, and always on any failure.

import { authenticate } from "../../shopify.server";
import { LEASE_TTL_MS, newLeaseToken } from "../ownership.server";
import { checkoutDiscountGate, type CheckoutGateResult } from "./gate.server";
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
  | "ORDERS_PARTIALLY_FULFILLED"
  | "ORDERS_UPDATED"
  | "REFUNDS_CREATE"
  | "ORDERS_RISK_ASSESSMENT_CHANGED";

const TOPICS: readonly string[] = [
  "ORDERS_PAID",
  "ORDERS_CANCELLED",
  "ORDERS_FULFILLED",
  "ORDERS_PARTIALLY_FULFILLED",
  "ORDERS_UPDATED",
  "REFUNDS_CREATE",
  "ORDERS_RISK_ASSESSMENT_CHANGED",
];

/** Bounded in-handler retry while the gate is unreadable (D2): 3 attempts
 *  with 100 ms then 300 ms between them. */
export const CHECKOUT_GATE_ATTEMPTS = 3;
const GATE_RETRY_DELAYS_MS = [100, 300];

const ORDER_GID = /^gid:\/\/shopify\/Order\/\d+$/;
const NUMERIC = /^\d+$/;

/** Builds `gid://shopify/Order/<n>` from a purely numeric value; rejects
 *  anything else (strings with digits+text, objects, negatives). */
const gidFromNumeric = (v: unknown): string | null => {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v : null;
  return s !== null && NUMERIC.test(s) ? `gid://shopify/Order/${s}` : null;
};

/** Order id extraction per topic — see the header matrix. Returns null for
 *  a missing/malformed id (the caller acknowledges without writing). */
export const orderIdFromPayload = (
  topic: CheckoutWebhookTopic,
  payload: unknown,
): string | null => {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (topic === "REFUNDS_CREATE") return gidFromNumeric(p.order_id);
  if (topic === "ORDERS_RISK_ASSESSMENT_CHANGED") {
    const gid = p.admin_graphql_api_order_id;
    if (typeof gid === "string" && ORDER_GID.test(gid)) return gid;
    return gidFromNumeric(p.order_id);
  }
  const gid = p.admin_graphql_api_id;
  if (typeof gid === "string" && ORDER_GID.test(gid)) return gid;
  return gidFromNumeric(gid);
};

export const handleCheckoutEligibilityWebhook = async (
  request: Request,
  topic: CheckoutWebhookTopic,
  deps: {
    work?: CheckoutWorkStore;
    gate?: (shop: string) => Promise<CheckoutGateResult>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<Response> => {
  const { topic: actual, shop, payload, admin } = await authenticate.webhook(request);

  if (actual !== topic || !TOPICS.includes(actual)) {
    console.warn(`[checkout] Unexpected topic: ${actual} (expected ${topic})`);
    return new Response();
  }

  const readGate = deps.gate ?? ((s: string) => checkoutDiscountGate(s));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Confirmed off => 200, nothing written. Unknown (a dependency read
  // threw) => bounded retry; still unreadable => 500 so Shopify redelivers
  // — a down database cannot hold a durable row anyway.
  let gate: CheckoutGateResult | null = null;
  let gateUnknown = true;
  for (let attempt = 0; attempt < CHECKOUT_GATE_ATTEMPTS; attempt++) {
    gate = await readGate(shop);
    gateUnknown = !gate.on && gate.unknown === true;
    if (!gateUnknown) break;
    if (attempt < CHECKOUT_GATE_ATTEMPTS - 1) {
      await sleep(GATE_RETRY_DELAYS_MS[Math.min(attempt, GATE_RETRY_DELAYS_MS.length - 1)]);
    }
  }
  if (gateUnknown) {
    console.error(`[checkout] gate unreadable for ${shop} — answering 500`);
    return new Response(null, { status: 500 });
  }
  if (!gate!.on) return new Response();

  const orderId = orderIdFromPayload(topic, payload);
  if (!orderId) {
    console.error(`[checkout] Webhook for ${shop} carried no order id — skipping.`);
    return new Response();
  }

  const work = deps.work ?? prismaCheckoutWorkStore();
  const token = newLeaseToken();
  let dirty;
  try {
    dirty =
      topic === "ORDERS_PAID"
        ? await work.upsertDirty(shop, orderId, token, LEASE_TTL_MS, CHECKOUT_DEADLINE_MS)
        : await work.touchExisting(shop, orderId, token, LEASE_TTL_MS, CHECKOUT_DEADLINE_MS);
  } catch (err: any) {
    // The durable mark itself failed — answer 500 so Shopify redelivers
    // instead of silently dropping the event.
    console.error(`[checkout] Could not record work for ${orderId}: ${err?.message}`);
    return new Response(null, { status: 500 });
  }
  if (!dirty) return new Response(); // never became checkout work — nothing to revoke

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
