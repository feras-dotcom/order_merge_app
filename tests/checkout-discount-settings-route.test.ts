// Turning automatic merging OFF (or lowering the merge window below 24 h)
// through the REAL settings route action must stop the merchant's checkout
// discount: the Shopify automatic discount is deactivated+verified and the
// checkout flag flips — never the other way around. A failed deactivation
// still saves the merchant's settings and leaves the durable pending
// marker (flag on + failing lever) for the sweeper.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { cartDeliveryOptionsDiscountsGenerateRun } from "../functions/checkout-shipping-discount/src/cart_delivery_options_discounts_generate_run";
import { action } from "../app/routes/app.settings";
import { CHECKOUT_DISCOUNT_MESSAGE } from "../app/lib/checkout-discount/config";
import type { CheckoutGateDeps } from "../app/lib/checkout-discount/gate.server";
import { parseElig } from "../app/lib/checkout-discount/records";
import { processCheckoutWork } from "../app/lib/checkout-discount/processor.server";
import {
  CHECKOUT_DEADLINE_MS,
  memoryCheckoutWorkStore,
} from "../app/lib/checkout-discount/work.server";
import { DEFAULT_SETTINGS, type MergeSettings } from "../app/lib/settings.server";
import { makeFakeEligibilityAdmin } from "./helpers/checkout-fake-admin";

const SHOP = "s.myshopify.com";
const DID = "gid://shopify/DiscountAutomaticNode/99";
const OID = "gid://shopify/Order/1001";
const CUST = "gid://shopify/Customer/777";
const EPOCH1 = new Date("2026-11-01T00:00:00Z");
const WIN1 = `w${EPOCH1.getTime()}`;

// ── In-memory settings store backing the mocked settings.server ──
const env = {
  settings: { ...DEFAULT_SETTINGS } as MergeSettings,
};

vi.mock("../app/db.server", () => ({ default: {} }));

vi.mock("../app/lib/settings.server", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    getSettings: async () => env.settings,
    upsertSettings: async (_shop: string, update: Partial<MergeSettings>) => {
      env.settings = { ...env.settings, ...update };
      return env.settings;
    },
    setCheckoutDiscountEnabled: async (_shop: string, enabled: boolean) => {
      env.settings = {
        ...env.settings,
        checkoutDiscountEnabled: enabled,
        checkoutDiscountEnabledAt: enabled ? (env.settings.checkoutDiscountEnabledAt ?? EPOCH1) : null,
      };
      return env.settings.checkoutDiscountEnabledAt;
    },
    setCheckoutDiscountNodeId: async (_shop: string, id: string | null) => {
      env.settings = { ...env.settings, checkoutDiscountNodeId: id };
    },
  };
});

// authenticate.admin returns the per-test admin (the composite fake below).
const current: { admin: any } = { admin: null };
vi.mock("../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: SHOP }, admin: current.admin }),
  },
}));

// ── Composite fake Admin: the discount node (ACTIVE/EXPIRED, status-only
// verify, deactivate) + order/eligibility queries for the real processor.
const baseConfig = (over: Record<string, unknown> = {}) => ({
  v: 1,
  windowId: WIN1,
  percentage: "100.0",
  message: CHECKOUT_DISCOUNT_MESSAGE,
  windowStart: "2026-11-01T00:00:00",
  windowEnd: "2026-12-01T00:00:00",
  ...over,
});

const ADDR = {
  firstName: "Jane", lastName: "Doe", company: "Acme",
  address1: "123 Main", address2: "Apt 4",
  city: "New York", provinceCode: "NY", zip: "10001", countryCode: "US",
};

const makeAdmin = (order: Record<string, unknown>) => {
  const state = {
    discountStatus: "ACTIVE",
    deactivateCalls: 0,
    deactivateIds: [] as string[],
    failDeactivate: false,
    stuckVerify: false,
    config: baseConfig(),
  };
  const elig = makeFakeEligibilityAdmin();
  const admin = {
    state,
    elig,
    async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
      const respond = (body: any) => ({ ok: true, status: 200, json: async () => body });
      const vars = options?.variables ?? {};
      if (query.includes("discountAutomaticDeactivate")) {
        state.deactivateIds.push(vars.id as string);
        if (state.failDeactivate) {
          return respond({ errors: [{ message: "transport boom" }] });
        }
        state.deactivateCalls += 1;
        state.discountStatus = "EXPIRED";
        return respond({ data: { discountAutomaticDeactivate: { automaticDiscountNode: { id: DID }, userErrors: [] } } });
      }
      if (query.includes("CheckoutDiscountStatus")) {
        return respond({
          data: {
            automaticDiscountNode: {
              id: vars.id ?? DID,
              automaticDiscount: {
                __typename: "DiscountAutomaticApp",
                status: state.stuckVerify ? "ACTIVE" : state.discountStatus,
              },
            },
          },
        });
      }
      if (query.includes("CheckoutEligibilityOrder")) {
        return respond({ data: { order, shop: { ianaTimezone: "UTC" } } });
      }
      if (query.includes("fulfillmentOrders")) {
        return respond({ errors: [{ message: "Access denied for field fulfillmentOrders" }] });
      }
      if (query.includes("locationsCount")) {
        return respond({ data: { locationsCount: { count: 1 } } });
      }
      if (query.includes("lineItems")) {
        return respond({ data: { order: { lineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } });
      }
      if (query.includes("EligibilityProjectionRead") || query.includes("metafieldsSet")) {
        return respond(await elig.graphql(query, options));
      }
      if (query.includes("automaticDiscountNode")) {
        return respond({
          data: {
            automaticDiscountNode: {
              id: vars.id ?? DID,
              automaticDiscount: {
                __typename: "DiscountAutomaticApp",
                title: "MS Checkout Shipping",
                status: state.discountStatus,
                startsAt: "2026-11-01T00:00:00Z",
                endsAt: null,
                appDiscountType: { functionId: "fn-1", app: { id: "gid://shopify/App/1" } },
                combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
              },
              metafield: { jsonValue: state.config },
            },
            currentAppInstallation: { app: { id: "gid://shopify/App/1" } },
          },
        });
      }
      throw new Error(`route fake admin: unhandled ${query.slice(0, 60)}`);
    },
  };
  return admin;
};

const orderFixture = () => ({
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
  shippingLines: {
    nodes: [{
      title: "Standard Shipping",
      originalPriceSet: { shopMoney: { amount: "8.00", currencyCode: "USD" } },
      discountedPriceSet: { shopMoney: { amount: "8.00", currencyCode: "USD" } },
      discountAllocations: [],
    }],
  },
  fulfillments: [],
  discountApplications: { nodes: [] },
});

const gateDeps = (): CheckoutGateDeps => ({
  env: (n) => (n === "MERGESHIP_CHECKOUT_DISCOUNT" ? "enabled" : undefined),
  settings: async () => env.settings,
  control: async () => ({ checkoutDiscountEnabled: true, checkoutDiscountAllowShops: [SHOP] }),
});

const fnInput = (eligDoc: unknown) => ({
  discount: {
    discountClasses: ["SHIPPING"],
    metafield: { jsonValue: baseConfig() },
  },
  shop: { localTime: { inWindow: true, date: "2026-11-10" } },
  cart: {
    buyerIdentity: { isAuthenticated: true, customer: { metafield: { jsonValue: eligDoc } } },
    deliveryGroups: [{
      deliveryAddress: ADDR,
      deliveryOptions: [{ handle: "o1", deliveryMethodType: "SHIPPING", title: "Standard Shipping", cost: { amount: "8.00", currencyCode: "USD" } }],
    }],
  },
});

/** The Shopify-side model: checkout evaluates the Function only while the
 *  automatic discount is ACTIVE. */
const grantsAtCheckout = (admin: ReturnType<typeof makeAdmin>) =>
  admin.state.discountStatus === "ACTIVE" &&
  (cartDeliveryOptionsDiscountsGenerateRun(fnInput(admin.elig.stored(CUST)))
    .operations as unknown[]).length > 0;

const post = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return new Request("https://app.example/settings", { method: "POST", body: fd });
};

beforeEach(() => {
  env.settings = {
    ...DEFAULT_SETTINGS,
    autoMergeEnabled: true,
    onboardingCompletedAt: EPOCH1,
    mergeWindowHours: 48,
    checkoutDiscountEnabled: true,
    checkoutDiscountEnabledAt: EPOCH1,
    checkoutDiscountNodeId: DID,
  };
  current.admin = null;
});

const project = async (admin: ReturnType<typeof makeAdmin>) => {
  const work = memoryCheckoutWorkStore(() => Date.parse("2026-11-10T12:00:00Z"));
  const { item } = await work.upsertDirty(SHOP, OID, "tok-1", 90_000, CHECKOUT_DEADLINE_MS);
  await processCheckoutWork({
    item, token: item.leaseToken!, shop: SHOP, admin: admin as any, work,
    now: () => new Date("2026-11-10T12:00:00Z"), sleep: async () => {}, random: () => 0.5,
    gate: gateDeps(), diag: () => {},
  });
};

describe("settings action → checkout shutdown enforcement", () => {
  it("merging OFF: the ACTIVE discount is deactivated+verified, the flag flips, the Function becomes unreachable", async () => {
    const admin = makeAdmin(orderFixture());
    current.admin = admin;
    await project(admin);
    // The record was really projected and the real Function grants while ACTIVE.
    expect(parseElig(admin.elig.stored(CUST)).doc.recs).toHaveLength(1);
    expect(grantsAtCheckout(admin)).toBe(true);

    const res = await action({
      request: post({ autoMergeEnabled: "false", mergeWindowHours: "48" }),
      params: {},
      context: {},
    } as any);
    expect(res.status).toBe(200);

    // Settings saved AND the discount was deactivated via the recorded id.
    expect(env.settings.autoMergeEnabled).toBe(false);
    expect(admin.state.deactivateIds).toEqual([DID]);
    expect(admin.state.discountStatus).toBe("EXPIRED");
    // Flag flipped only after verification.
    expect(env.settings.checkoutDiscountEnabled).toBe(false);
    expect(env.settings.checkoutDiscountEnabledAt).toBe(null);
    // Shopify evaluates the Function only for an ACTIVE discount → gone.
    expect(grantsAtCheckout(admin)).toBe(false);
  });

  it("lowering the merge window below 24 h triggers the same shutdown", async () => {
    const admin = makeAdmin(orderFixture());
    current.admin = admin;
    const res = await action({
      request: post({ autoMergeEnabled: "true", mergeWindowHours: "6" }),
      params: {},
      context: {},
    } as any);
    expect(res.status).toBe(200);
    expect(admin.state.deactivateIds).toEqual([DID]);
    expect(env.settings.checkoutDiscountEnabled).toBe(false);
  });

  it("a deactivate failure still saves the settings and leaves the flag for the sweeper", async () => {
    const admin = makeAdmin(orderFixture());
    admin.state.failDeactivate = true;
    current.admin = admin;
    const res = await action({
      request: post({ autoMergeEnabled: "false", mergeWindowHours: "48" }),
      params: {},
      context: {},
    } as any);
    expect(res.status).toBe(200);
    expect(env.settings.autoMergeEnabled).toBe(false);
    // Shutdown not verified → the durable pending marker stays set.
    expect(env.settings.checkoutDiscountEnabled).toBe(true);
  });

  it("verification seeing still-ACTIVE leaves the flag untouched", async () => {
    const admin = makeAdmin(orderFixture());
    admin.state.stuckVerify = true; // status read always reports ACTIVE
    current.admin = admin;
    const res = await action({
      request: post({ autoMergeEnabled: "false", mergeWindowHours: "48" }),
      params: {},
      context: {},
    } as any);
    expect(res.status).toBe(200);
    expect(env.settings.checkoutDiscountEnabled).toBe(true);
    expect(admin.state.discountStatus).toBe("EXPIRED"); // deactivate ran
  });

  it("a merchant without checkout enabled causes zero discount calls", async () => {
    env.settings.checkoutDiscountEnabled = false;
    env.settings.checkoutDiscountEnabledAt = null;
    env.settings.checkoutDiscountNodeId = null;
    const admin = makeAdmin(orderFixture());
    current.admin = admin;
    const res = await action({
      request: post({ autoMergeEnabled: "false", mergeWindowHours: "48" }),
      params: {},
      context: {},
    } as any);
    expect(res.status).toBe(200);
    expect(admin.state.deactivateCalls).toBe(0);
    expect(admin.state.deactivateIds).toHaveLength(0);
  });

  it("leaving merging unchanged makes no discount calls at all", async () => {
    const admin = makeAdmin(orderFixture());
    current.admin = admin;
    const res = await action({
      request: post({ autoMergeEnabled: "true", mergeWindowHours: "48" }),
      params: {},
      context: {},
    } as any);
    expect(res.status).toBe(200);
    expect(admin.state.deactivateCalls).toBe(0);
  });
});
