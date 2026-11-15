// Disabled-behavior invariants (Task D): with checkoutDiscountEnabled=false
// — and the new pilot-approval columns present and NULL — the pre-change
// behavior holds exactly: gate reasons per lever, webhooks answer 200 with
// zero work writes and zero Admin calls, an ordinary settings save makes no
// checkout Admin call, and the shutdown enforcer is a no-op. The REAL gate,
// webhook handler, settings action and enforcer run; only transport/auth
// and the durable stores are faked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkoutDiscountGate,
  shopLevelGateOff,
  type CheckoutGateDeps,
} from "../app/lib/checkout-discount/gate.server";
import { handleCheckoutEligibilityWebhook } from "../app/lib/checkout-discount/webhook.server";
import { enforceShopShutdown } from "../app/lib/checkout-discount/shutdown-enforcer.server";
import { action as settingsAction } from "../app/routes/app.settings";
import { DEFAULT_SETTINGS, type MergeSettings } from "../app/lib/settings.server";
import type { CheckoutWorkStore } from "../app/lib/checkout-discount/work.server";

const SHOP = "inv.myshopify.com";
const EPOCH = new Date("2026-11-01T00:00:00Z");

/** A fully-configured shop with the checkout discount OFF and every new
 *  column present and NULL. */
const OFF_SETTINGS = (over: Partial<MergeSettings> = {}): MergeSettings => ({
  ...DEFAULT_SETTINGS,
  autoMergeEnabled: true,
  onboardingStartedAt: EPOCH,
  onboardingCompletedAt: EPOCH,
  mergeWindowHours: 24,
  checkoutDiscountEnabled: false,
  checkoutDiscountEnabledAt: null,
  checkoutDiscountNodeId: null,
  checkoutDiscountWindowHours: null,
  checkoutDiscountMethod: null,
  checkoutDiscountMaxShippingMinor: null,
  checkoutDiscountCurrency: null,
  ...over,
});

// ── mocks (transport/auth/store only — real gate/handler/enforcer run) ──

const env = vi.hoisted(() => ({
  topic: "ORDERS_PAID",
  adminGraphql: vi.fn(),
  settings: null as unknown as MergeSettings,
  processCheckoutWork: vi.fn(async () => {}),
}));

vi.mock("../app/db.server", () => ({ default: {} }));

vi.mock("../app/lib/webhook-auth.server", () => ({
  authenticateWebhook: async (request: Request) => ({
    topic: env.topic,
    shop: SHOP,
    admin: { graphql: env.adminGraphql },
    payload: await request.json().catch(() => ({})),
  }),
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: SHOP },
      admin: { graphql: env.adminGraphql },
    }),
  },
}));

vi.mock("../app/lib/checkout-discount/processor.server", () => ({
  processCheckoutWork: env.processCheckoutWork,
}));

vi.mock("../app/lib/settings.server", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    getSettings: async () => env.settings,
    upsertSettings: async (_shop: string, update: Partial<MergeSettings>) => {
      env.settings = { ...env.settings, ...update };
      return env.settings;
    },
    raiseCheckoutDiscountWindowStamp: async () => {},
  };
});

const gateDeps = (over: Partial<CheckoutGateDeps> = {}): CheckoutGateDeps => ({
  env: () => undefined, // MERGESHIP_CHECKOUT_DISCOUNT unset
  settings: async () => OFF_SETTINGS(),
  control: async () => null, // AppControl off / unset
  ...over,
});

const spyWork = () => {
  const calls: string[] = [];
  const work = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (typeof prop !== "string") return undefined;
        return async () => {
          calls.push(prop);
          return null;
        };
      },
    },
  );
  return { calls, work: work as CheckoutWorkStore };
};

const req = (payload: unknown = { admin_graphql_api_id: "gid://shopify/Order/1" }) =>
  new Request("https://app.example/webhooks", { method: "POST", body: JSON.stringify(payload) });

beforeEach(() => {
  env.topic = "ORDERS_PAID";
  env.adminGraphql.mockClear();
  env.processCheckoutWork.mockClear();
  env.settings = OFF_SETTINGS();
});

describe("disabled gate invariants", () => {
  it("the pre-change reasons hold for every lever (env/control/allowlist/shop)", async () => {
    // env unset.
    expect(await checkoutDiscountGate(SHOP, gateDeps())).toEqual({ on: false, reason: "env" });
    // env on, AppControl off.
    expect(
      await checkoutDiscountGate(
        SHOP,
        gateDeps({ env: () => "enabled", control: async () => ({ checkoutDiscountEnabled: false, checkoutDiscountAllowShops: [SHOP] }) }),
      ),
    ).toEqual({ on: false, reason: "control" });
    // control on, shop not allowlisted (inverted allowlist).
    expect(
      await checkoutDiscountGate(
        SHOP,
        gateDeps({ env: () => "enabled", control: async () => ({ checkoutDiscountEnabled: true, checkoutDiscountAllowShops: [] }) }),
      ),
    ).toEqual({ on: false, reason: "allowlist" });
    // allowlisted, shop flag off — stops here; the new approval lever is
    // never reached while the flag is off.
    expect(
      await checkoutDiscountGate(
        SHOP,
        gateDeps({ env: () => "enabled", control: async () => ({ checkoutDiscountEnabled: true, checkoutDiscountAllowShops: [SHOP] }) }),
      ),
    ).toEqual({ on: false, reason: "shop" });
  });

  it("shopLevelGateOff: the pre-change reason order, and the new levers stay silent while disabled", () => {
    expect(shopLevelGateOff(OFF_SETTINGS({ autoMergeEnabled: false }))).toBe("auto-merge");
    expect(shopLevelGateOff(OFF_SETTINGS({ onboardingCompletedAt: null }))).toBe("onboarding");
    expect(shopLevelGateOff(OFF_SETTINGS({ mergeWindowHours: 12 }))).toBe("window-unsupported");
    // Flag off + NULL stamp + NULL approval: every enabled-only lever is
    // skipped — the result is null, never "window-unstamped" or
    // "method-unconfigured".
    expect(shopLevelGateOff(OFF_SETTINGS())).toBe(null);
  });
});

describe("disabled webhook invariants", () => {
  it.each([
    "ORDERS_PAID",
    "ORDERS_CANCELLED",
    "ORDERS_FULFILLED",
    "ORDERS_PARTIALLY_FULFILLED",
    "ORDERS_UPDATED",
    "REFUNDS_CREATE",
    "ORDERS_RISK_ASSESSMENT_CHANGED",
  ] as const)("%s answers 200, writes no work row, makes no Admin call", async (topic) => {
    env.topic = topic;
    const { calls, work } = spyWork();
    const payload =
      topic === "REFUNDS_CREATE"
        ? { order_id: 1 }
        : topic === "ORDERS_RISK_ASSESSMENT_CHANGED"
          ? { admin_graphql_api_order_id: "gid://shopify/Order/1" }
          : { admin_graphql_api_id: "gid://shopify/Order/1" };
    // The REAL gate — env unset, AppControl off, shop flag off.
    const res = await handleCheckoutEligibilityWebhook(req(payload), topic, {
      work,
      gate: (shop) => checkoutDiscountGate(shop, gateDeps()),
      sleep: async () => {},
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([]); // no upsertDirty/touchExisting/anything
    expect(env.adminGraphql).not.toHaveBeenCalled();
    expect(env.processCheckoutWork).not.toHaveBeenCalled();
  });
});

describe("disabled settings-route invariant", () => {
  it("an ordinary merge-window/auto-merge save makes no checkout Admin call", async () => {
    env.settings = OFF_SETTINGS({ autoMergeEnabled: true });
    const fd = new FormData();
    fd.set("autoMergeEnabled", "true");
    fd.set("mergeWindowHours", "48");
    const res = await settingsAction({
      request: new Request("https://app.example/settings", { method: "POST", body: fd }),
      params: {},
      context: {},
    } as any);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(env.settings.mergeWindowHours).toBe(48);
    expect(env.adminGraphql).not.toHaveBeenCalled();
  });
});

describe("disabled shutdown-enforcer invariant", () => {
  it("does nothing for a shop whose checkout flag is off — no Admin call", async () => {
    env.settings = OFF_SETTINGS();
    const r = await enforceShopShutdown({
      shop: SHOP,
      admin: { graphql: env.adminGraphql } as any,
      getSettings: async () => env.settings,
    });
    expect(r).toEqual({ action: "none" });
    expect(env.adminGraphql).not.toHaveBeenCalled();
  });
});
