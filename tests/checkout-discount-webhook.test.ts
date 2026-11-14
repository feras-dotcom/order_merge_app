// Shared webhook handler for the checkout-eligibility topics: auth + topic
// guard, per-topic payload id extraction, the gate pre-check (confirmed off
// => 200, nothing recorded; unreadable => bounded retry then 500), durable
// dirty-marking (upsertDirty on ORDERS_PAID, touchExisting elsewhere) with a
// 500 on store failure, and inline processing only when the delivery
// acquired the lease. authenticate/webhook, the processor and the work
// store are mocked — no real Shopify, no DB.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleCheckoutEligibilityWebhook,
  orderIdFromPayload,
} from "../app/lib/checkout-discount/webhook.server";
import type { CheckoutGateResult } from "../app/lib/checkout-discount/gate.server";
import type { CheckoutWorkStore } from "../app/lib/checkout-discount/work.server";

const SHOP = "test.myshopify.com";
const OID = "gid://shopify/Order/1001";

const env = vi.hoisted(() => ({
  topic: "ORDERS_PAID",
  admin: { graphql: vi.fn() } as any,
  gateOn: true,
  /** When set, consumed in order by the gate mock; falls back to gateOn. */
  gateResults: null as CheckoutGateResult[] | null,
  upsert: null as null | { acquired: boolean } | "throw",
  touch: null as null | { acquired: boolean } | "throw" | "null",
  processCheckoutWork: vi.fn(async () => {}),
  upsertDirty: vi.fn(),
  touchExisting: vi.fn(),
}));

const GATE_ON: CheckoutGateResult = {
  on: true,
  enabledAt: new Date("2026-10-01T00:00:00Z"),
  mergeWindowHours: 24,
  windowId: "w-test",
};

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
  checkoutDiscountGate: async (): Promise<CheckoutGateResult> => {
    if (env.gateResults?.length) return env.gateResults.shift()!;
    return env.gateOn ? GATE_ON : { on: false, reason: "test-off" };
  },
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
  env.touchExisting = vi.fn(async () => {
    if (env.touch === "throw") throw new Error("db update failed");
    if (env.touch === "null") return null;
    const acquired = env.touch?.acquired ?? true;
    return {
      item: { id: "w1", shop: SHOP, orderId: OID, gen: 2, status: "PENDING", attempts: 1 },
      acquired,
    };
  });
  return { upsertDirty: env.upsertDirty, touchExisting: env.touchExisting } as unknown as CheckoutWorkStore;
};

const req = (payload: unknown = { admin_graphql_api_id: OID }) =>
  new Request("https://app.example/webhooks", { method: "POST", body: JSON.stringify(payload) });

const sleep = async () => {};

beforeEach(() => {
  env.topic = "ORDERS_PAID";
  env.admin = { graphql: vi.fn() };
  env.gateOn = true;
  env.gateResults = null;
  env.upsert = null;
  env.touch = null;
  env.processCheckoutWork.mockClear();
  env.upsertDirty = vi.fn();
  env.touchExisting = vi.fn();
});

describe("handleCheckoutEligibilityWebhook", () => {
  it("gate off => 200 and nothing is recorded", async () => {
    env.gateOn = false;
    const res = await handleCheckoutEligibilityWebhook(req(), "ORDERS_PAID", { work: work(), sleep });
    expect(res.status).toBe(200);
    expect(env.upsertDirty).not.toHaveBeenCalled();
    expect(env.processCheckoutWork).not.toHaveBeenCalled();
  });

  it("wrong topic => 200, nothing recorded", async () => {
    env.topic = "ORDERS_FULFILLED";
    const res = await handleCheckoutEligibilityWebhook(req(), "ORDERS_PAID", { work: work(), sleep });
    expect(res.status).toBe(200);
    expect(env.upsertDirty).not.toHaveBeenCalled();
  });

  it("missing order id => 200, nothing recorded", async () => {
    const res = await handleCheckoutEligibilityWebhook(req({}), "ORDERS_PAID", { work: work(), sleep });
    expect(res.status).toBe(200);
    expect(env.upsertDirty).not.toHaveBeenCalled();
  });

  it("a malformed payload id => 200, nothing written", async () => {
    const res = await handleCheckoutEligibilityWebhook(
      req({ admin_graphql_api_id: "gid://shopify/Order/12x4" }),
      "ORDERS_PAID",
      { work: work(), sleep },
    );
    expect(res.status).toBe(200);
    expect(env.upsertDirty).not.toHaveBeenCalled();
  });

  it("an upsert failure answers 500 so Shopify retries", async () => {
    env.upsert = "throw";
    const res = await handleCheckoutEligibilityWebhook(req(), "ORDERS_PAID", { work: work(), sleep });
    expect(res.status).toBe(500);
  });

  it("an acquired lease invokes the inline processor once", async () => {
    env.upsert = { acquired: true };
    const res = await handleCheckoutEligibilityWebhook(req(), "ORDERS_PAID", { work: work(), sleep });
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
    const res = await handleCheckoutEligibilityWebhook(req(), "ORDERS_PAID", { work: work(), sleep });
    expect(res.status).toBe(200);
    expect(env.processCheckoutWork).not.toHaveBeenCalled();
  });

  it("no admin on the session => 200, left for the sweeper", async () => {
    env.upsert = { acquired: true };
    env.admin = null;
    const res = await handleCheckoutEligibilityWebhook(req(), "ORDERS_PAID", { work: work(), sleep });
    expect(res.status).toBe(200);
    expect(env.processCheckoutWork).not.toHaveBeenCalled();
  });
});

describe("handleCheckoutEligibilityWebhook — revocation topics", () => {
  it("ORDERS_UPDATED touches an existing row and never inserts", async () => {
    env.topic = "ORDERS_UPDATED";
    const res = await handleCheckoutEligibilityWebhook(
      req({ admin_graphql_api_id: OID }),
      "ORDERS_UPDATED",
      { work: work(), sleep },
    );
    expect(res.status).toBe(200);
    expect(env.touchExisting).toHaveBeenCalledTimes(1);
    expect(env.upsertDirty).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(env.processCheckoutWork).toHaveBeenCalledTimes(1));
  });

  it("REFUNDS_CREATE builds the order GID from the numeric order_id", async () => {
    env.topic = "REFUNDS_CREATE";
    const res = await handleCheckoutEligibilityWebhook(
      req({ order_id: 1001 }),
      "REFUNDS_CREATE",
      { work: work(), sleep },
    );
    expect(res.status).toBe(200);
    expect(env.touchExisting).toHaveBeenCalledWith(
      SHOP, OID, expect.any(String), expect.any(Number), expect.any(Number),
    );
  });

  it("ORDERS_RISK_ASSESSMENT_CHANGED prefers the GID field, falls back to numeric order_id", async () => {
    env.topic = "ORDERS_RISK_ASSESSMENT_CHANGED";
    const w = work();
    const res = await handleCheckoutEligibilityWebhook(
      req({ admin_graphql_api_order_id: OID, order_id: 1001 }),
      "ORDERS_RISK_ASSESSMENT_CHANGED",
      { work: w, sleep },
    );
    expect(res.status).toBe(200);
    expect(env.touchExisting).toHaveBeenCalledWith(
      SHOP, OID, expect.any(String), expect.any(Number), expect.any(Number),
    );
    // Sample payloads may carry a null GID — the numeric id still works.
    const res2 = await handleCheckoutEligibilityWebhook(
      req({ admin_graphql_api_order_id: null, order_id: 1001 }),
      "ORDERS_RISK_ASSESSMENT_CHANGED",
      { work: w, sleep },
    );
    expect(res2.status).toBe(200);
    expect(env.touchExisting).toHaveBeenCalledTimes(2);
    // Both null/missing => nothing written.
    const res3 = await handleCheckoutEligibilityWebhook(
      req({}),
      "ORDERS_RISK_ASSESSMENT_CHANGED",
      { work: w, sleep },
    );
    expect(res3.status).toBe(200);
    expect(env.touchExisting).toHaveBeenCalledTimes(2);
  });

  it("touch for an unknown order writes nothing and does not process", async () => {
    env.topic = "ORDERS_CANCELLED";
    env.touch = "null";
    const res = await handleCheckoutEligibilityWebhook(
      req({ admin_graphql_api_id: OID }),
      "ORDERS_CANCELLED",
      { work: work(), sleep },
    );
    expect(res.status).toBe(200);
    expect(env.touchExisting).toHaveBeenCalledTimes(1);
    expect(env.processCheckoutWork).not.toHaveBeenCalled();
  });

  it("a touch failure answers 500 so Shopify redelivers", async () => {
    env.topic = "ORDERS_CANCELLED";
    env.touch = "throw";
    const res = await handleCheckoutEligibilityWebhook(
      req({ admin_graphql_api_id: OID }),
      "ORDERS_CANCELLED",
      { work: work(), sleep },
    );
    expect(res.status).toBe(500);
  });
});

describe("handleCheckoutEligibilityWebhook — unreadable gate", () => {
  const UNKNOWN: CheckoutGateResult = { on: false, reason: "read-error", unknown: true };

  it("a gate read that fails once then succeeds proceeds normally", async () => {
    env.gateResults = [UNKNOWN, GATE_ON];
    const res = await handleCheckoutEligibilityWebhook(req(), "ORDERS_PAID", { work: work(), sleep });
    expect(res.status).toBe(200);
    expect(env.upsertDirty).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(env.processCheckoutWork).toHaveBeenCalledTimes(1));
  });

  it("a gate still unreadable after the bounded retries answers 500, no row", async () => {
    env.gateResults = [UNKNOWN, UNKNOWN, UNKNOWN];
    const res = await handleCheckoutEligibilityWebhook(req(), "ORDERS_PAID", { work: work(), sleep });
    expect(res.status).toBe(500);
    expect(env.upsertDirty).not.toHaveBeenCalled();
    expect(env.processCheckoutWork).not.toHaveBeenCalled();
  });

  it("duplicate deliveries during a flaky gate period do not double-process", async () => {
    env.gateResults = [UNKNOWN, GATE_ON, GATE_ON]; // 1st delivery: retry once; 2nd: immediate
    const w = work();
    env.upsert = { acquired: true };
    const r1 = await handleCheckoutEligibilityWebhook(req(), "ORDERS_PAID", { work: w, sleep });
    env.upsert = { acquired: false }; // 2nd delivery: owner already holds it
    const r2 = await handleCheckoutEligibilityWebhook(req(), "ORDERS_PAID", { work: w, sleep });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(env.upsertDirty).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(env.processCheckoutWork).toHaveBeenCalledTimes(1));
  });
});

describe("orderIdFromPayload — per-topic id extraction", () => {
  it("orders/* topics take admin_graphql_api_id (GID or numeric)", () => {
    expect(orderIdFromPayload("ORDERS_PAID", { admin_graphql_api_id: OID })).toBe(OID);
    expect(orderIdFromPayload("ORDERS_UPDATED", { admin_graphql_api_id: "12345" })).toBe(
      "gid://shopify/Order/12345",
    );
    expect(orderIdFromPayload("ORDERS_CANCELLED", { admin_graphql_api_id: "abc" })).toBe(null);
    expect(orderIdFromPayload("ORDERS_FULFILLED", {})).toBe(null);
  });

  it("refunds/create takes the numeric order_id only", () => {
    expect(orderIdFromPayload("REFUNDS_CREATE", { order_id: 1001 })).toBe(OID);
    expect(orderIdFromPayload("REFUNDS_CREATE", { order_id: "1001" })).toBe(OID);
    expect(orderIdFromPayload("REFUNDS_CREATE", { order_id: "10a1" })).toBe(null);
    expect(orderIdFromPayload("REFUNDS_CREATE", { admin_graphql_api_id: OID })).toBe(null);
  });

  it("risk_assessment_changed prefers the GID, falls back to numeric, rejects junk", () => {
    expect(
      orderIdFromPayload("ORDERS_RISK_ASSESSMENT_CHANGED", {
        admin_graphql_api_order_id: OID,
        order_id: 42,
      }),
    ).toBe(OID);
    expect(
      orderIdFromPayload("ORDERS_RISK_ASSESSMENT_CHANGED", {
        admin_graphql_api_order_id: null,
        order_id: 1001,
      }),
    ).toBe(OID);
    expect(
      orderIdFromPayload("ORDERS_RISK_ASSESSMENT_CHANGED", { admin_graphql_api_order_id: "junk" }),
    ).toBe(null);
    expect(orderIdFromPayload("ORDERS_RISK_ASSESSMENT_CHANGED", null)).toBe(null);
  });
});
