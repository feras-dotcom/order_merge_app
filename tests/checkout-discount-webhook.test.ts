// Shared webhook handler for the checkout-eligibility topics: auth + topic
// guard, the cheap gate pre-check (off => 200, nothing recorded), durable
// dirty-marking with a 500 on insert failure, and inline processing only
// when the delivery acquired the lease. authenticate/webhook, the processor
// and the work store are mocked — no real Shopify, no DB.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCheckoutEligibilityWebhook } from "../app/lib/checkout-discount/webhook.server";
import type { CheckoutWorkStore } from "../app/lib/checkout-discount/work.server";

const SHOP = "test.myshopify.com";
const OID = "gid://shopify/Order/1001";

const env = vi.hoisted(() => ({
  topic: "ORDERS_PAID",
  admin: { graphql: vi.fn() } as any,
  gateOn: true,
  upsert: null as null | { acquired: boolean } | "throw",
  processCheckoutWork: vi.fn(async () => {}),
  upsertDirty: vi.fn(),
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: {
    webhook: async (request: Request) => ({
      topic: env.topic,
      shop: SHOP,
      admin: env.admin,
      payload: await request.json().catch(() => ({})),
    }),
  },
}));

vi.mock("../app/lib/checkout-discount/gate.server", () => ({
  checkoutDiscountGate: async () =>
    env.gateOn
      ? { on: true, enabledAt: new Date("2026-10-01T00:00:00Z"), mergeWindowHours: 24 }
      : { on: false, reason: "test-off" },
}));

vi.mock("../app/lib/checkout-discount/processor.server", () => ({
  processCheckoutWork: env.processCheckoutWork,
}));

const work = (): CheckoutWorkStore => {
  env.upsertDirty = vi.fn(async () => {
    if (env.upsert === "throw") throw new Error("db insert failed");
    const acquired = env.upsert?.acquired ?? true;
    return {
      item: { id: "w1", shop: SHOP, orderId: OID, gen: 1, status: "PENDING", attempts: 1 },
      acquired,
    };
  });
  return { upsertDirty: env.upsertDirty } as unknown as CheckoutWorkStore;
};

const req = (payload: unknown = { admin_graphql_api_id: OID }) =>
  new Request("https://app.example/webhooks", { method: "POST", body: JSON.stringify(payload) });

beforeEach(() => {
  env.topic = "ORDERS_PAID";
  env.admin = { graphql: vi.fn() };
  env.gateOn = true;
  env.upsert = null;
  env.processCheckoutWork.mockClear();
  env.upsertDirty = vi.fn();
});

describe("handleCheckoutEligibilityWebhook", () => {
  it("gate off => 200 and nothing is recorded", async () => {
    env.gateOn = false;
    const res = await handleCheckoutEligibilityWebhook(req(), "ORDERS_PAID", { work: work() });
    expect(res.status).toBe(200);
    expect(env.upsertDirty).not.toHaveBeenCalled();
    expect(env.processCheckoutWork).not.toHaveBeenCalled();
  });

  it("wrong topic => 200, nothing recorded", async () => {
    env.topic = "ORDERS_FULFILLED";
    const res = await handleCheckoutEligibilityWebhook(req(), "ORDERS_PAID", { work: work() });
    expect(res.status).toBe(200);
    expect(env.upsertDirty).not.toHaveBeenCalled();
  });

  it("missing order id => 200, nothing recorded", async () => {
    const res = await handleCheckoutEligibilityWebhook(req({}), "ORDERS_PAID", { work: work() });
    expect(res.status).toBe(200);
    expect(env.upsertDirty).not.toHaveBeenCalled();
  });

  it("an upsert failure answers 500 so Shopify retries", async () => {
    env.upsert = "throw";
    const res = await handleCheckoutEligibilityWebhook(req(), "ORDERS_PAID", { work: work() });
    expect(res.status).toBe(500);
  });

  it("an acquired lease invokes the inline processor once", async () => {
    env.upsert = { acquired: true };
    const res = await handleCheckoutEligibilityWebhook(req(), "ORDERS_PAID", { work: work() });
    expect(res.status).toBe(200);
    // Inline processing is fire-and-forget — let it run.
    await vi.waitFor(() => expect(env.processCheckoutWork).toHaveBeenCalledTimes(1));
    const args = (env.processCheckoutWork.mock.calls[0] as unknown[])[0] as any;
    expect(args.shop).toBe(SHOP);
    expect(args.item.orderId).toBe(OID);
    expect(args.admin).toBe(env.admin);
  });

  it("a live lease (duplicate delivery) leaves processing to its owner", async () => {
    env.upsert = { acquired: false };
    const res = await handleCheckoutEligibilityWebhook(req(), "ORDERS_PAID", { work: work() });
    expect(res.status).toBe(200);
    expect(env.processCheckoutWork).not.toHaveBeenCalled();
  });

  it("no admin on the session => 200, left for the sweeper", async () => {
    env.upsert = { acquired: true };
    env.admin = null;
    const res = await handleCheckoutEligibilityWebhook(req(), "ORDERS_PAID", { work: work() });
    expect(res.status).toBe(200);
    expect(env.processCheckoutWork).not.toHaveBeenCalled();
  });
});
