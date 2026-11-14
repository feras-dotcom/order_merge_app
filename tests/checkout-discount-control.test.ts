// Operator control for the Shopify checkout discount (E): shutdown must
// deactivate the Shopify discount FIRST and verify EXPIRED before touching
// the app flag — the app gate controls only whether the APP projects
// records; the Shopify discount's status is the only thing that stops
// checkout discounting. Fake Admin models the node query + the three
// mutations; no real Shopify.
import { describe, expect, it } from "vitest";
import { cartDeliveryOptionsDiscountsGenerateRun } from "../functions/checkout-shipping-discount/src/cart_delivery_options_discounts_generate_run";
import {
  activateCheckoutDiscount,
  DiscountConfigError,
  DiscountStateError,
  prepareEnable,
  ShutdownNotVerifiedError,
  shutdownCheckoutDiscount,
  validateCheckoutConfig,
} from "../app/lib/checkout-discount/discount-control.server";
import { CHECKOUT_DISCOUNT_MESSAGE } from "../app/lib/checkout-discount/config";
import { processCheckoutWork } from "../app/lib/checkout-discount/processor.server";
import type { CheckoutGateDeps } from "../app/lib/checkout-discount/gate.server";
import { parseElig, serializeElig } from "../app/lib/checkout-discount/records";
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

const baseConfig = (over: Record<string, unknown> = {}) => ({
  v: 1,
  windowId: "w-old",
  percentage: "100.0",
  message: CHECKOUT_DISCOUNT_MESSAGE,
  windowStart: "2026-11-01T00:00:00",
  windowEnd: "2026-12-01T00:00:00",
  ...over,
});

/** Fake Admin modeling the automaticDiscountNode + its three mutations. */
const makeDiscountAdmin = (init: { status: string; config?: Record<string, unknown> }) => {
  const state = {
    status: init.status,
    config: init.config ?? baseConfig(),
    deactivateCalls: 0,
    activateCalls: 0,
    updateCalls: 0,
    failDeactivate: false,
    stuckStatus: null as string | null, // verification reads keep this status
  };
  const admin = {
    state,
    async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
      const respond = (body: any) => ({ ok: true, status: 200, json: async () => body });
      const vars = options?.variables ?? {};
      const node = () => ({
        data: {
          automaticDiscountNode: {
            id: vars.id ?? DID,
            automaticDiscount: {
              title: "MS Checkout Shipping",
              status: state.stuckStatus ?? state.status,
              startsAt: "2026-11-01T00:00:00Z",
              endsAt: null,
              appDiscountType: { functionId: "fn-1" },
              combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
            },
            metafield: { jsonValue: state.config },
          },
        },
      });
      if (query.includes("discountAutomaticDeactivate")) {
        if (state.failDeactivate) {
          return respond({
            data: { discountAutomaticDeactivate: { automaticDiscountNode: null, userErrors: [{ field: ["id"], message: "boom" }] } },
          });
        }
        state.deactivateCalls += 1;
        state.status = "EXPIRED";
        return respond({ data: { discountAutomaticDeactivate: { automaticDiscountNode: { id: DID }, userErrors: [] } } });
      }
      if (query.includes("discountAutomaticActivate")) {
        state.activateCalls += 1;
        state.status = "ACTIVE";
        return respond({ data: { discountAutomaticActivate: { automaticDiscountNode: { id: DID }, userErrors: [] } } });
      }
      if (query.includes("discountAutomaticAppUpdate")) {
        state.updateCalls += 1;
        const mfs = (vars.input as any)?.metafields ?? [];
        for (const mf of mfs) {
          if (mf.key === "config") state.config = JSON.parse(mf.value);
        }
        return respond({ data: { discountAutomaticAppUpdate: { automaticAppDiscount: { discountId: DID, status: state.status }, userErrors: [] } } });
      }
      if (query.includes("automaticDiscountNode")) return respond(node());
      throw new Error(`fake discount admin: unhandled ${query.slice(0, 60)}`);
    },
  };
  return admin;
};

/** Fake setEnabled/readEnabledAt pair: enable stamps a fresh epoch on a
 *  false→true transition exactly like setCheckoutDiscountEnabled. */
const makeEpoch = (initial: Date | null) => {
  const state = { enabledAt: initial as Date | null, tick: Date.parse("2026-11-15T00:00:00Z") };
  return {
    state,
    setEnabled: async (_shop: string, enabled: boolean) => {
      state.enabledAt = enabled ? (state.enabledAt ?? new Date(state.tick++)) : null;
    },
    readEnabledAt: async () => state.enabledAt,
  };
};

const deps = (admin: any, epoch: ReturnType<typeof makeEpoch>) => ({
  admin,
  shop: SHOP,
  discountId: DID,
  setEnabled: epoch.setEnabled,
  readEnabledAt: epoch.readEnabledAt,
});

describe("validateCheckoutConfig", () => {
  it("accepts the live-validated shape; rejects a NUMERIC percentage", () => {
    expect(validateCheckoutConfig(baseConfig()).percentage).toBe("100.0");
    expect(() => validateCheckoutConfig(baseConfig({ percentage: 100 }))).toThrow(DiscountConfigError);
    expect(() => validateCheckoutConfig(baseConfig({ windowStart: "2026-11-01" }))).toThrow(DiscountConfigError);
    expect(() => validateCheckoutConfig(baseConfig({ windowEnd: "2026-12-01T00:00:00Z" }))).toThrow(DiscountConfigError);
  });
});

describe("shutdownCheckoutDiscount", () => {
  it("deactivates FIRST, verifies EXPIRED, then flips the app flag", async () => {
    const admin = makeDiscountAdmin({ status: "ACTIVE" });
    const epoch = makeEpoch(new Date("2026-11-01T00:00:00Z"));
    const order: string[] = [];
    const wrapped = {
      ...deps(admin as any, epoch),
      setEnabled: async (s: string, e: boolean) => {
        order.push(`setEnabled(${e})@deactivateCalls=${admin.state.deactivateCalls}`);
        await epoch.setEnabled(s, e);
      },
    };
    const r = await shutdownCheckoutDiscount(wrapped as any);
    expect(r.status).toBe("EXPIRED");
    expect(admin.state.deactivateCalls).toBe(1);
    // The flag flip happened only AFTER the deactivation call.
    expect(order).toEqual(["setEnabled(false)@deactivateCalls=1"]);
    expect(epoch.state.enabledAt).toBe(null);
  });

  it("a failed deactivate leaves the app flag untouched", async () => {
    const admin = makeDiscountAdmin({ status: "ACTIVE" });
    admin.state.failDeactivate = true;
    const epoch = makeEpoch(new Date("2026-11-01T00:00:00Z"));
    await expect(shutdownCheckoutDiscount(deps(admin as any, epoch) as any)).rejects.toThrow(DiscountStateError);
    expect(epoch.state.enabledAt).not.toBe(null);
  });

  it("a status that never reaches EXPIRED throws ShutdownNotVerifiedError, flags untouched", async () => {
    const admin = makeDiscountAdmin({ status: "ACTIVE" });
    admin.state.stuckStatus = "SCHEDULED"; // verify read never sees EXPIRED
    const epoch = makeEpoch(new Date("2026-11-01T00:00:00Z"));
    await expect(shutdownCheckoutDiscount(deps(admin as any, epoch) as any)).rejects.toThrow(
      ShutdownNotVerifiedError,
    );
    expect(epoch.state.enabledAt).not.toBe(null);
  });

  it("already inactive => idempotent: no deactivate call, flag cleared", async () => {
    const admin = makeDiscountAdmin({ status: "EXPIRED" });
    const epoch = makeEpoch(new Date("2026-11-01T00:00:00Z"));
    const r = await shutdownCheckoutDiscount(deps(admin as any, epoch) as any);
    expect(r.status).toBe("EXPIRED");
    expect(admin.state.deactivateCalls).toBe(0);
    expect(epoch.state.enabledAt).toBe(null);
  });
});

describe("prepareEnable", () => {
  it("refuses an ACTIVE discount", async () => {
    const admin = makeDiscountAdmin({ status: "ACTIVE" });
    const epoch = makeEpoch(null);
    await expect(prepareEnable(deps(admin as any, epoch) as any)).rejects.toThrow(DiscountStateError);
    expect(epoch.state.enabledAt).toBe(null);
  });

  it("derives w<epochMs>, writes it into the config and leaves the discount inactive", async () => {
    const admin = makeDiscountAdmin({ status: "EXPIRED" });
    const epoch = makeEpoch(null);
    const r = await prepareEnable(deps(admin as any, epoch) as any);
    expect(r.windowId).toBe(`w${r.enabledAt.getTime()}`);
    expect(admin.state.config.windowId).toBe(r.windowId);
    // Other config keys preserved.
    expect(admin.state.config.percentage).toBe("100.0");
    expect(admin.state.config.message).toBe(CHECKOUT_DISCOUNT_MESSAGE);
    expect(admin.state.config.windowEnd).toBe("2026-12-01T00:00:00");
    expect(admin.state.status).toBe("EXPIRED"); // still inactive
  });
});

describe("activateCheckoutDiscount", () => {
  const gateOn = {
    on: true,
    enabledAt: new Date("2026-11-15T00:00:00Z"),
    mergeWindowHours: 24,
    windowId: "w",
  } as const;

  it("refuses when the stored windowId does not match", async () => {
    const admin = makeDiscountAdmin({ status: "EXPIRED", config: baseConfig({ windowId: "w1" }) });
    const epoch = makeEpoch(new Date("2026-11-15T00:00:00Z"));
    await expect(
      activateCheckoutDiscount({
        ...deps(admin as any, epoch),
        expectedWindowId: "w-other",
        gate: async () => gateOn,
      } as any),
    ).rejects.toThrow(DiscountStateError);
    expect(admin.state.activateCalls).toBe(0);
  });

  it("refuses when the app gate is not on", async () => {
    const admin = makeDiscountAdmin({ status: "EXPIRED", config: baseConfig({ windowId: "w1" }) });
    const epoch = makeEpoch(new Date("2026-11-15T00:00:00Z"));
    await expect(
      activateCheckoutDiscount({
        ...deps(admin as any, epoch),
        expectedWindowId: "w1",
        gate: async () => ({ on: false, reason: "shop" }),
      } as any),
    ).rejects.toThrow(DiscountStateError);
    expect(admin.state.activateCalls).toBe(0);
  });

  it("activates when config and gate agree, verified ACTIVE", async () => {
    const admin = makeDiscountAdmin({ status: "EXPIRED", config: baseConfig({ windowId: "w1" }) });
    const epoch = makeEpoch(new Date("2026-11-15T00:00:00Z"));
    const r = await activateCheckoutDiscount({
      ...deps(admin as any, epoch),
      expectedWindowId: "w1",
      gate: async () => gateOn,
    } as any);
    expect(r.status).toBe("ACTIVE");
    expect(admin.state.activateCalls).toBe(1);
  });
});

// ── End-to-end no-resurrection (E3) ────────────────────────────────────────
// enable epoch1 -> project A -> Function discounts -> shutdown -> re-enable
// (epoch2, windowId rotated, config updated) -> the stale record neither
// discounts nor is consumed, is pruned on the next write, and a fresh order
// under the new epoch discounts. A record CONSUMED in epoch1 never grants.

const EPOCH1 = new Date("2026-11-01T00:00:00Z");
const WIN1 = `w${EPOCH1.getTime()}`;

const ADDR = {
  firstName: "Jane", lastName: "Doe", company: "Acme",
  address1: "123 Main", address2: "Apt 4",
  city: "New York", provinceCode: "NY", zip: "10001", countryCode: "US",
};

const orderFixture = (id: string, createdAt: string, over: Record<string, unknown> = {}) => ({
  id,
  name: "#" + id.slice(-4),
  createdAt,
  processedAt: createdAt,
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
  ...over,
});

const fnInput = (eligDoc: unknown, windowId: string) => ({
  discount: {
    discountClasses: ["SHIPPING"],
    metafield: { jsonValue: { v: 1, windowId, percentage: "100.0", message: CHECKOUT_DISCOUNT_MESSAGE, windowStart: "2026-11-01T00:00:00", windowEnd: "2026-12-01T00:00:00" } },
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

const discounts = (input: unknown) =>
  (cartDeliveryOptionsDiscountsGenerateRun(input).operations as unknown[]).length > 0;

const settingsFor = (enabledAt: Date | null): MergeSettings => ({
  ...DEFAULT_SETTINGS,
  autoMergeEnabled: true,
  onboardingCompletedAt: EPOCH1,
  checkoutDiscountEnabled: enabledAt !== null,
  checkoutDiscountEnabledAt: enabledAt,
  mergeWindowHours: 72,
});
const gateDeps = (enabledAt: Date | null): CheckoutGateDeps => ({
  env: (n) => (n === "MERGESHIP_CHECKOUT_DISCOUNT" ? "enabled" : undefined),
  settings: async () => settingsFor(enabledAt),
  control: async () => ({ checkoutDiscountEnabled: true, checkoutDiscountAllowShops: [SHOP] }),
});

it("E2E: a record from a previous enable epoch can never grant again", async () => {
  const clock = { now: Date.parse("2026-11-10T12:00:00Z") };
  const work = memoryCheckoutWorkStore(() => clock.now);
  const elig = makeFakeEligibilityAdmin();
  const discount = makeDiscountAdmin({ status: "ACTIVE", config: baseConfig({ windowId: WIN1 }) });
  const epoch = makeEpoch(EPOCH1);
  const orders: Record<string, unknown> = { [OID]: orderFixture(OID, "2026-11-10T10:00:00Z") };

  const admin = {
    async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
      const respond = (body: any) => ({ ok: true, status: 200, json: async () => body });
      const vars = options?.variables ?? {};
      if (query.includes("automaticDiscountNode") || query.includes("discountAutomatic")) {
        return discount.graphql(query, options);
      }
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
        return respond({ data: { order: { lineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } });
      }
      if (query.includes("EligibilityProjectionRead") || query.includes("metafieldsSet")) {
        return respond(await elig.graphql(query, options));
      }
      throw new Error(`unhandled: ${query.slice(0, 60)}`);
    },
  };

  const process = async (orderId: string, enabledAt: Date) => {
    const { item } = await work.upsertDirty(SHOP, orderId, `tok-${orderId}-${clock.now}`, 90_000, CHECKOUT_DEADLINE_MS);
    await processCheckoutWork({
      item, token: item.leaseToken!, shop: SHOP, admin: admin as any, work,
      now: () => new Date(clock.now), sleep: async () => {}, random: () => 0.5,
      gate: gateDeps(enabledAt), diag: () => {},
    });
  };

  // Epoch 1: project order A — the Function discounts it under WIN1.
  await process(OID, EPOCH1);
  const doc1 = parseElig(elig.stored(CUST)).doc;
  expect(doc1.recs).toHaveLength(1);
  expect(doc1.recs[0].win).toBe(WIN1);
  expect(discounts(fnInput(elig.stored(CUST), WIN1))).toBe(true);

  // Simulate a consumed tombstone for a second epoch-1 order.
  const { writeProjection } = await import("../app/lib/checkout-discount/projection-write");
  const { consumeRecord } = await import("../app/lib/checkout-discount/records");
  await writeProjection(elig as any, CUST, (cur) => {
    const { doc } = parseElig(cur);
    doc.recs.push({ id: "2002", win: WIN1, dest: doc.recs[0].dest, method: "standard shipping", cur: "USD", left: 1, exp: "2026-11-13" });
    const c = consumeRecord(serializeElig(doc), { recordId: "2002", byOrderId: "3003" }, { todayDate: "2026-11-10" });
    return { serialized: c.serialized };
  });
  expect(parseElig(elig.stored(CUST)).doc.recs.find((r) => r.id === "2002")!.left).toBe(0);

  // Shutdown: discount deactivated (verified EXPIRED), then the flag flips.
  const ddeps = { admin: admin as any, shop: SHOP, discountId: DID, setEnabled: epoch.setEnabled };
  await shutdownCheckoutDiscount(ddeps);
  expect(epoch.state.enabledAt).toBe(null);
  expect(discount.state.status).toBe("EXPIRED");

  // Re-enable: fresh epoch, windowId rotates, config is updated, discount
  // stays INACTIVE until activate is called separately.
  const prep = await prepareEnable({ ...ddeps, readEnabledAt: epoch.readEnabledAt });
  const WIN2 = prep.windowId;
  expect(WIN2).not.toBe(WIN1);
  expect(discount.state.config.windowId).toBe(WIN2);
  expect(discount.state.status).toBe("EXPIRED");

  // The stale WIN1 records — live AND consumed — cannot discount under the
  // rotated config, before OR after the next projection write.
  expect(discounts(fnInput(elig.stored(CUST), WIN2))).toBe(false);

  // A fresh order (created after the new epoch) projects under WIN2.
  const OIDC = "gid://shopify/Order/3003";
  orders[OIDC] = orderFixture(OIDC, "2026-11-15T01:00:00Z");
  await process(OIDC, epoch.state.enabledAt!);
  const doc2 = parseElig(elig.stored(CUST)).doc;
  // The old-window records were pruned by the write; only the WIN2 record
  // survives, and the consumed tombstone was NOT resurrected.
  expect(doc2.recs.map((r) => r.id)).toEqual(["3003"]);
  expect(doc2.recs[0].win).toBe(WIN2);
  expect(discounts(fnInput(elig.stored(CUST), WIN2))).toBe(true);
});
