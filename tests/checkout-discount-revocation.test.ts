// "A previously eligible order can no longer grant after a disqualifying
// change" — the C matrix. Each case: project an eligible order, prove the
// REAL Function (cartDeliveryOptionsDiscountsGenerateRun) would discount a
// matching checkout, apply the disqualifying change, deliver the matching
// webhook topic through the real handler (touchExisting), process the work,
// and prove the Function no longer discounts. Plus the missed-webhook path:
// reopenOutstanding re-verifies and revokes with no delivery at all.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cartDeliveryOptionsDiscountsGenerateRun } from "../functions/checkout-shipping-discount/src/cart_delivery_options_discounts_generate_run";
import { CHECKOUT_DISCOUNT_MESSAGE } from "../app/lib/checkout-discount/config";
import { handleCheckoutEligibilityWebhook } from "../app/lib/checkout-discount/webhook.server";
import { processCheckoutWork } from "../app/lib/checkout-discount/processor.server";
import { checkoutDiscountGate, type CheckoutGateDeps } from "../app/lib/checkout-discount/gate.server";
import { parseElig } from "../app/lib/checkout-discount/records";
import {
  CHECKOUT_DEADLINE_MS,
  memoryCheckoutWorkStore,
  type CheckoutWorkStore,
} from "../app/lib/checkout-discount/work.server";
import { DEFAULT_SETTINGS, type MergeSettings } from "../app/lib/settings.server";
import { makeFakeEligibilityAdmin } from "./helpers/checkout-fake-admin";

const SHOP = "s.myshopify.com";
const OID = "gid://shopify/Order/1001";
const OID2 = "gid://shopify/Order/2002";
const CUST = "gid://shopify/Customer/777";
const EPOCH = new Date("2026-10-01T00:00:00Z");
const WIN = `w${EPOCH.getTime()}`;

let clock = Date.parse("2026-11-10T12:00:00Z");

const ADDR = {
  firstName: "Jane", lastName: "Doe", company: "Acme",
  address1: "123 Main", address2: "Apt 4",
  city: "New York", provinceCode: "NY", zip: "10001",
  countryCode: "US",
};
const ADDR2 = { ...ADDR, address1: "9 Other St", zip: "10002" };

const SETTINGS: MergeSettings = {
  ...DEFAULT_SETTINGS,
  autoMergeEnabled: true,
  onboardingCompletedAt: EPOCH,
  checkoutDiscountEnabled: true,
  checkoutDiscountEnabledAt: EPOCH,
  checkoutDiscountWindowHours: 72,
  mergeWindowHours: 72,
};
const GATE: CheckoutGateDeps = {
  env: (n) => (n === "MERGESHIP_CHECKOUT_DISCOUNT" ? "enabled" : undefined),
  settings: async () => SETTINGS,
  control: async () => ({ checkoutDiscountEnabled: true, checkoutDiscountAllowShops: [SHOP] }),
};

const shippingLine = (over: Record<string, unknown> = {}) => ({
  title: "Standard Shipping",
  originalPriceSet: { shopMoney: { amount: "8.00", currencyCode: "USD" } },
  discountedPriceSet: { shopMoney: { amount: "8.00", currencyCode: "USD" } },
  discountAllocations: [],
  ...over,
});

const order = (over: Record<string, unknown> = {}) => ({
  id: OID,
  name: "#1001",
  createdAt: "2026-11-10T10:00:00Z",
  processedAt: "2026-11-10T10:00:00Z",
  cancelledAt: null,
  closed: false,
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "UNFULFILLED",
  riskLevel: "LOW",
  currencyCode: "USD",
  customer: { id: CUST },
  shippingAddress: { ...ADDR, countryCodeV2: "US" },
  shippingLines: { nodes: [shippingLine()] },
  fulfillments: [],
  discountApplications: { nodes: [] },
  ...over,
});

// ── Fake Admin (order query + CAS eligibility metafield) ─────────────────

interface FakeAdmin {
  graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<any>;
  calls: string[];
  elig: ReturnType<typeof makeFakeEligibilityAdmin>;
}

const makeAdmin = (orders: Record<string, unknown>): FakeAdmin => {
  const elig = makeFakeEligibilityAdmin();
  const calls: string[] = [];
  return {
    calls,
    elig,
    async graphql(query, options) {
      calls.push(query.slice(0, 60));
      const respond = (body: any) => ({ ok: true, status: 200, json: async () => body });
      const vars = options?.variables ?? {};
      if (query.includes("CheckoutEligibilityOrder")) {
        return respond({ data: { order: orders[vars.id as string] ?? null, shop: { ianaTimezone: "UTC" } } });
      }
      if (query.includes("fulfillmentOrders")) {
        return respond({ errors: [{ message: "Access denied for field fulfillmentOrders" }] });
      }
      if (query.includes("locationsCount")) {
        return respond({ data: { locationsCount: { count: 1 } } });
      }
      if (query.includes("lineItems")) {
        return respond({
          data: { order: { lineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
        });
      }
      if (query.includes("EligibilityProjectionRead") || query.includes("metafieldsSet")) {
        return respond(await elig.graphql(query, options));
      }
      throw new Error(`fake admin: unhandled query: ${query.slice(0, 80)}`);
    },
  };
};

// ── The real Function against a checkout cart ────────────────────────────

/** Builds the Function input for a signed-in customer checkout carrying
 *  the projected $app:ship_elig document — matching `tests/fixtures`. */
const functionInput = (args: {
  eligDoc: unknown;
  address?: Record<string, unknown>;
  method?: string;
  cur?: string;
  today: string;
  windowId: string;
  inWindow?: boolean;
}) => ({
  discount: {
    discountClasses: ["SHIPPING"],
    metafield: {
      jsonValue: {
        v: 1,
        windowId: args.windowId,
        percentage: "100.0",
        message: CHECKOUT_DISCOUNT_MESSAGE,
        windowStart: "2026-11-01T00:00:00",
        windowEnd: "2026-12-01T00:00:00",
      },
    },
  },
  shop: { localTime: { inWindow: args.inWindow ?? true, date: args.today } },
  cart: {
    buyerIdentity: {
      isAuthenticated: true,
      customer: { metafield: { jsonValue: args.eligDoc } },
    },
    deliveryGroups: [
      {
        deliveryAddress: args.address ?? ADDR,
        deliveryOptions: [
          {
            handle: "opt-1",
            deliveryMethodType: "SHIPPING",
            title: args.method ?? "Standard Shipping",
            cost: { amount: "8.00", currencyCode: args.cur ?? "USD" },
          },
        ],
      },
    ],
  },
});

/** Does the real Function discount this checkout? */
const discounts = (input: unknown): boolean =>
  (cartDeliveryOptionsDiscountsGenerateRun(input).operations as unknown[]).length > 0;

const eligDocAt = (admin: FakeAdmin) => admin.elig.stored(CUST);

const todayOf = () => new Date(clock).toISOString().slice(0, 10);

// ── Webhook delivery + processing ────────────────────────────────────────

const authEnv = vi.hoisted(() => ({ topic: "", admin: null as any }));
vi.mock("../app/shopify.server", () => ({
  authenticate: {
    webhook: async (request: Request) => ({
      topic: authEnv.topic,
      shop: SHOP,
      // No inline admin — the handler only marks/touches the durable row;
      // the test then claims and processes it deterministically.
      admin: null,
      payload: await request.json().catch(() => ({})),
    }),
  },
}));

const TOPIC_PAYLOADS: Record<string, unknown> = {
  ORDERS_PAID: { admin_graphql_api_id: OID },
  ORDERS_CANCELLED: { admin_graphql_api_id: OID },
  ORDERS_FULFILLED: { admin_graphql_api_id: OID },
  ORDERS_PARTIALLY_FULFILLED: { admin_graphql_api_id: OID },
  ORDERS_UPDATED: { admin_graphql_api_id: OID },
  REFUNDS_CREATE: { order_id: 1001 },
  ORDERS_RISK_ASSESSMENT_CHANGED: { admin_graphql_api_order_id: OID, order_id: 1001 },
};

const topicRoutes: Record<string, string> = {
  ORDERS_PAID: "ORDERS_PAID",
  ORDERS_CANCELLED: "ORDERS_CANCELLED",
  ORDERS_FULFILLED: "ORDERS_FULFILLED",
  ORDERS_PARTIALLY_FULFILLED: "ORDERS_PARTIALLY_FULFILLED",
  ORDERS_UPDATED: "ORDERS_UPDATED",
  REFUNDS_CREATE: "REFUNDS_CREATE",
  ORDERS_RISK_ASSESSMENT_CHANGED: "ORDERS_RISK_ASSESSMENT_CHANGED",
};

const deliver = async (
  topic: keyof typeof TOPIC_PAYLOADS,
  work: CheckoutWorkStore,
  payload = TOPIC_PAYLOADS[topic],
) => {
  authEnv.topic = topic;
  const res = await handleCheckoutEligibilityWebhook(
    new Request("https://app.example/webhooks", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
    topicRoutes[topic] as never,
    {
      work,
      sleep: async () => {},
      gate: (s: string) => checkoutDiscountGate(s, GATE),
    },
  );
  expect(res.status).toBe(200);
  // The delivery's lease (90s) must lapse before the sweeper can claim.
  clock += 100_000;
  const [item] = await work.claimDue(1, 90_000);
  if (!item) return null;
  await processCheckoutWork({
    item,
    token: item.leaseToken!,
    shop: item.shop,
    admin: adminRef! as any,
    work,
    now: () => new Date(clock),
    sleep: async () => {},
    random: () => 0.5,
    gate: GATE,
    diag: () => {},
  });
  return work.find(SHOP, item.orderId);
};

let adminRef: FakeAdmin | null = null;

/** Project the order once so the metafield holds the live record. */
const project = async (o: Record<string, unknown>, work: CheckoutWorkStore) => {
  adminRef = makeAdmin({ [OID]: o });
  await deliver("ORDERS_PAID", work);
  const doc = parseElig(eligDocAt(adminRef!)).doc;
  expect(doc.recs).toHaveLength(1);
  return doc.recs[0];
};

beforeEach(() => {
  clock = Date.parse("2026-11-10T12:00:00Z");
  adminRef = null;
  authEnv.topic = "";
});

describe("disqualification matrix — projected record stops granting", () => {
  const cases: {
    name: string;
    topic: keyof typeof TOPIC_PAYLOADS;
    mutate: (o: Record<string, unknown>) => Record<string, unknown>;
    /** Post-processing: still discounts? (address-edit expects the NEW dest.) */
    stillDiscounts?: boolean;
  }[] = [
    { name: "refunded", topic: "REFUNDS_CREATE", mutate: (o) => ({ ...o, displayFinancialStatus: "REFUNDED" }) },
    { name: "partially refunded", topic: "ORDERS_UPDATED", mutate: (o) => ({ ...o, displayFinancialStatus: "PARTIALLY_REFUNDED" }) },
    { name: "cancelled", topic: "ORDERS_CANCELLED", mutate: (o) => ({ ...o, cancelledAt: "2026-11-10T13:00:00Z" }) },
    { name: "fulfilled", topic: "ORDERS_FULFILLED", mutate: (o) => ({ ...o, displayFulfillmentStatus: "FULFILLED" }) },
    { name: "partially fulfilled", topic: "ORDERS_PARTIALLY_FULFILLED", mutate: (o) => ({ ...o, displayFulfillmentStatus: "PARTIALLY_FULFILLED" }) },
    { name: "closed", topic: "ORDERS_UPDATED", mutate: (o) => ({ ...o, closed: true }) },
    { name: "risk MEDIUM", topic: "ORDERS_RISK_ASSESSMENT_CHANGED", mutate: (o) => ({ ...o, riskLevel: "MEDIUM" }) },
    { name: "a second shipping line", topic: "ORDERS_UPDATED", mutate: (o) => ({ ...o, shippingLines: { nodes: [shippingLine(), shippingLine({ title: "Express" })] } }) },
    { name: "free shipping (ZERO_SHIPPING)", topic: "ORDERS_UPDATED", mutate: (o) => ({ ...o, shippingLines: { nodes: [shippingLine({ originalPriceSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } }, discountedPriceSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } } })] } }) },
    { name: "fulfillment row present", topic: "ORDERS_UPDATED", mutate: (o) => ({ ...o, fulfillments: [{ id: "gid://shopify/Fulfillment/1" }] }) },
    { name: "no customer", topic: "ORDERS_UPDATED", mutate: (o) => ({ ...o, customer: null }) },
  ];

  const runCase = async (c: (typeof cases)[number]) => {
    const work = memoryCheckoutWorkStore(() => clock);
    const o = order();
    await project(o, work);
    const input = () =>
      functionInput({ eligDoc: eligDocAt(adminRef!), today: todayOf(), windowId: WIN });
    expect(discounts(input())).toBe(true);

    // The disqualifying change lands; the matching topic is delivered.
    const mutated = c.mutate(o);
    adminRef = makeAdmin({ [OID]: mutated });
    await deliver(c.topic, work);

    const doc = parseElig(eligDocAt(adminRef)).doc;
    expect(doc.recs.every((r) => r.id !== "1001" || r.left <= 0)).toBe(true);
    expect(discounts(input())).toBe(false);
  };

  for (const c of cases) {
    it(`${c.name}: Function discounts before, not after (${c.topic})`, () => runCase(c));
  }

  it("address edit: discount follows the NEW address, gone at the old one", async () => {
    const work = memoryCheckoutWorkStore(() => clock);
    const o = order();
    await project(o, work);
    adminRef = makeAdmin({ [OID]: order({ shippingAddress: { ...ADDR2, countryCodeV2: "US" } }) });
    await deliver("ORDERS_UPDATED", work);

    const base = () =>
      functionInput({ eligDoc: eligDocAt(adminRef!), today: todayOf(), windowId: WIN });
    expect(discounts({ ...base(), cart: { ...base().cart, deliveryGroups: [{ ...base().cart.deliveryGroups[0], deliveryAddress: ADDR }] } })).toBe(false);
    expect(discounts({ ...base(), cart: { ...base().cart, deliveryGroups: [{ ...base().cart.deliveryGroups[0], deliveryAddress: ADDR2 }] } })).toBe(true);
  });

  it("window passed: the record expires and the Function stops discounting", async () => {
    const work = memoryCheckoutWorkStore(() => clock);
    await project(order(), work);
    // Past the 72h merge window AND the record's expiry date.
    clock = Date.parse("2026-11-15T12:00:00Z");
    const row = await deliver("ORDERS_UPDATED", work);
    expect(row).not.toBeNull();
    expect(["DONE/WINDOW_PASSED", "DONE/REFUSED", "DONE/REVOKED"]).toContain(`${row!.status}/${row!.outcome}`);
    expect(
      discounts(functionInput({ eligDoc: eligDocAt(adminRef!), today: todayOf(), windowId: WIN })),
    ).toBe(false);
  });

  it("a location-rule failure (multi-location shop without scope) revokes", async () => {
    const work = memoryCheckoutWorkStore(() => clock);
    await project(order(), work);
    // Re-drive through touch: a fulfillment-order hold/location change has
    // no webhook — model it as the re-check path (reopenOutstanding).
    adminRef = makeAdmin({ [OID]: order() });
    const eligCalls = adminRef.elig.callCount;
    // Multi-location shop without the scope => location rule fails.
    const admin2 = makeAdmin({ [OID]: order() });
    admin2.elig = adminRef!.elig;
    const orig = admin2.graphql.bind(admin2);
    admin2.graphql = async (q: string, o?: any) => {
      if (q.includes("locationsCount")) {
        return { ok: true, status: 200, json: async () => ({ data: { locationsCount: { count: 2 } } }) } as any;
      }
      return orig(q, o);
    };
    adminRef = admin2;
    await work.touchExisting(SHOP, OID, "tok-x", 1, CHECKOUT_DEADLINE_MS);
    clock += 10; // the delivery token's 1ms lease lapses so the claim takes it
    const [item] = await work.claimDue(1, 90_000);
    await processCheckoutWork({
      item, token: item.leaseToken!, shop: SHOP, admin: adminRef as any, work,
      now: () => new Date(clock), sleep: async () => {}, random: () => 0.5, gate: GATE, diag: () => {},
    });
    const doc = parseElig(eligDocAt(adminRef)).doc;
    expect(doc.recs.every((r) => r.id !== "1001" || r.left <= 0)).toBe(true);
    expect(
      discounts(functionInput({ eligDoc: eligDocAt(adminRef), today: todayOf(), windowId: WIN })),
    ).toBe(false);
    expect(eligCalls).toBeGreaterThanOrEqual(0);
  });
});

describe("missed-webhook reconciliation — reopenOutstanding", () => {
  it("a disqualification with NO webhook is corrected by the re-check", async () => {
    const work = memoryCheckoutWorkStore(() => clock);
    const o = order();
    await project(o, work);
    const before = parseElig(eligDocAt(adminRef!)).doc;
    expect(before.recs).toHaveLength(1);
    expect(
      discounts(functionInput({ eligDoc: eligDocAt(adminRef!), today: todayOf(), windowId: WIN })),
    ).toBe(true);

    // The order gets fulfilled — the webhook is LOST (never delivered).
    adminRef = makeAdmin({ [OID]: order({ displayFulfillmentStatus: "FULFILLED", fulfillments: [{ id: "gid://shopify/Fulfillment/1" }] }) });
    // Nothing is re-opened while the PROJECTED row is fresh.
    expect(
      await work.reopenOutstanding({ olderThanMs: 600_000, maxAgeMs: 8 * 24 * 3600_000, limit: 50, deadlineMs: CHECKOUT_DEADLINE_MS }),
    ).toBe(0);
    // After the re-check cadence elapses it re-opens and the processor
    // re-reads live state => revokes.
    clock += 601_000;
    expect(
      await work.reopenOutstanding({ olderThanMs: 600_000, maxAgeMs: 8 * 24 * 3600_000, limit: 50, deadlineMs: CHECKOUT_DEADLINE_MS }),
    ).toBe(1);
    const [item] = await work.claimDue(1, 90_000);
    await processCheckoutWork({
      item, token: item.leaseToken!, shop: SHOP, admin: adminRef as any, work,
      now: () => new Date(clock), sleep: async () => {}, random: () => 0.5, gate: GATE, diag: () => {},
    });
    const doc = parseElig(eligDocAt(adminRef)).doc;
    expect(doc.recs.every((r) => r.id !== "1001" || r.left <= 0)).toBe(true);
    expect(
      discounts(functionInput({ eligDoc: eligDocAt(adminRef), today: todayOf(), windowId: WIN })),
    ).toBe(false);
  });

  it("re-checking an unchanged eligible order is a no-op that re-settles PROJECTED", async () => {
    const work = memoryCheckoutWorkStore(() => clock);
    await project(order(), work);
    clock += 601_000;
    expect(
      await work.reopenOutstanding({ olderThanMs: 600_000, maxAgeMs: 8 * 24 * 3600_000, limit: 50, deadlineMs: CHECKOUT_DEADLINE_MS }),
    ).toBe(1);
    const [item] = await work.claimDue(1, 90_000);
    await processCheckoutWork({
      item, token: item.leaseToken!, shop: SHOP, admin: adminRef! as any, work,
      now: () => new Date(clock), sleep: async () => {}, random: () => 0.5, gate: GATE, diag: () => {},
    });
    const row = await work.find(SHOP, OID);
    expect(`${row?.status}/${row?.outcome}`).toBe("DONE/PROJECTED");
    const doc = parseElig(eligDocAt(adminRef!)).doc;
    expect(doc.recs).toHaveLength(1);
    expect(doc.recs[0].left).toBe(1);
    // And it still discounts.
    expect(
      discounts(functionInput({ eligDoc: eligDocAt(adminRef!), today: todayOf(), windowId: WIN })),
    ).toBe(true);
  });

  it("a CONSUMED row is never re-opened", async () => {
    const work = memoryCheckoutWorkStore(() => clock);
    await project(order(), work);
    const { item } = await work.upsertDirty(SHOP, OID, "tok-c", 90_000, CHECKOUT_DEADLINE_MS);
    expect(await work.complete(item.id, "tok-c", item.gen, "CONSUMED", "done")).toBe("DONE");
    clock += 601_000;
    const n = await work.reopenOutstanding({ olderThanMs: 600_000, maxAgeMs: 8 * 24 * 3600_000, limit: 50, deadlineMs: CHECKOUT_DEADLINE_MS });
    expect(n).toBe(0);
  });

  it("touch for an order that never became work writes nothing", async () => {
    const work = memoryCheckoutWorkStore(() => clock);
    const res = await deliver("ORDERS_CANCELLED", work, { admin_graphql_api_id: OID2 });
    expect(res).toBe(null);
    expect(await work.find(SHOP, OID2)).toBe(null);
  });
});
