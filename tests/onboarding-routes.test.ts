// Route-level tests for the setup gate and server-side enforcement: app.tsx
// loader, the onboarding and Settings actions, and the orders/create webhook.
// Shopify auth, billing, location access and persistence are mocked.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type MergeSettings } from "../app/lib/settings.server";

const SHOP = "test.myshopify.com";

const env = vi.hoisted(() => ({
  settings: null as any,
  location: { activeLocationCount: 1 as number | null, granted: false },
  subscribed: true,
  executeMerge: vi.fn(),
  processed: vi.fn(),
}));

vi.mock("../app/shopify.server", () => {
  const redirect = (url: string) => new Response(null, { status: 302, headers: { Location: url } });
  return {
    authenticate: {
      admin: async () => ({ admin: {}, session: { shop: SHOP }, scopes: {}, redirect }),
      webhook: async (request: Request) => ({
        topic: "ORDERS_CREATE",
        shop: SHOP,
        admin: { graphql: vi.fn() },
        payload: await request.json(),
      }),
    },
  };
});

vi.mock("../app/lib/settings.server", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    getSettings: async () => env.settings,
    upsertSettings: async (_shop: string, update: Partial<MergeSettings>) => {
      env.settings = { ...env.settings, ...update };
      return env.settings;
    },
  };
});

vi.mock("../app/lib/location-access.server", async () => {
  const { locationRequirement } = await import("../app/lib/onboarding");
  return {
    getLocationAccess: async () => {
      const requirement = locationRequirement(env.location);
      return { ...env.location, requirement, blocked: requirement === "needs-access" };
    },
  };
});

vi.mock("../app/lib/billing.server", () => ({
  getActiveSubscription: async () => ({
    subscribed: env.subscribed,
    planHandle: env.subscribed ? "starter" : null,
    planPrice: null,
    shopGid: "gid://shopify/Shop/1",
  }),
  planSelectionUrl: () => "https://admin.shopify.com/store/test/charges/app/pricing_plans",
}));

vi.mock("../app/db.server", () => ({
  default: {
    settings: { upsert: async () => ({}) },
    processedWebhook: { create: env.processed },
  },
}));

vi.mock("../app/lib/merge.server", () => ({
  buildAddressKey: () => "address",
  buildGroupKey: () => "group",
  defaultMergeDeps: () => ({ journal: { findBlockingOrderIds: async () => new Set() } }),
  executeMerge: env.executeMerge,
  resumeIncompleteMerges: async () => [],
}));

const appRoute = await import("../app/routes/app");
const onboardingRoute = await import("../app/routes/app.onboarding");
const settingsRoute = await import("../app/routes/app.settings");
const webhookRoute = await import("../app/routes/webhooks.orders.create");

const newShop = (): MergeSettings => ({ ...DEFAULT_SETTINGS });
const completedShop = (overrides: Partial<MergeSettings> = {}): MergeSettings => ({
  ...DEFAULT_SETTINGS,
  autoMergeEnabled: true,
  autoMergeAcknowledgedAt: new Date("2026-09-01"),
  onboardingStartedAt: new Date("2026-09-01"),
  onboardingCompletedAt: new Date("2026-09-01"),
  ...overrides,
});

const get = (path: string) => new Request(`https://app.example.com${path}`);
const post = (path: string, fields: Record<string, string>) =>
  new Request(`https://app.example.com${path}`, { method: "POST", body: new URLSearchParams(fields) });

async function outcome(fn: () => Promise<unknown>) {
  try {
    const value = await fn();
    return value instanceof Response ? value : { returned: value };
  } catch (thrown) {
    return thrown as Response;
  }
}
const locationOf = (r: any) => (r instanceof Response ? r.headers.get("Location") : null);
const body = async (r: any) => (r instanceof Response ? r.json() : r.returned);

beforeEach(() => {
  env.settings = newShop();
  env.location = { activeLocationCount: 1, granted: false };
  env.subscribed = true;
  env.executeMerge.mockReset();
  env.processed.mockReset();
});

describe("setup gate (app.tsx loader)", () => {
  const load = (path: string) => outcome(() => appRoute.loader({ request: get(path), params: {}, context: {} } as any));

  it("sends a new install from every app page to onboarding", async () => {
    for (const path of ["/app", "/app/settings"]) {
      expect(locationOf(await load(path))).toBe("/app/onboarding");
    }
  });

  it("lets an incomplete setup stay on onboarding", async () => {
    expect(await load("/app/onboarding")).toMatchObject({ returned: { setupComplete: false } });
  });

  it("keeps a merchant who is part-way through setup in onboarding", async () => {
    env.settings = { ...newShop(), onboardingStartedAt: new Date() };
    expect(locationOf(await load("/app"))).toBe("/app/onboarding");
  });

  it("sends a completed merchant away from onboarding, except its final step", async () => {
    env.settings = completedShop();
    expect(locationOf(await load("/app/onboarding"))).toBe("/app");
    expect(await load("/app/onboarding?step=done")).toMatchObject({ returned: { setupComplete: true } });
    expect(await load("/app")).toMatchObject({ returned: { setupComplete: true } });
  });

  it("does not send a paused, established merchant back through setup", async () => {
    env.settings = completedShop({ autoMergeEnabled: false });
    expect(await load("/app")).toMatchObject({ returned: { setupComplete: true } });
  });

  it("still sends unsubscribed shops to plan selection first", async () => {
    env.subscribed = false;
    expect(locationOf(await load("/app/onboarding"))).toContain("pricing_plans");
  });
});

describe("onboarding action — required configuration is enforced server-side", () => {
  const act = (fields: Record<string, string>) =>
    outcome(() => onboardingRoute.action({ request: post("/app/onboarding", fields), params: {}, context: {} } as any));
  const complete = (fields: Partial<Record<string, string>> = {}) =>
    act({ intent: "complete", mergeWindowHours: "24", acknowledged: "true", ...fields } as Record<string, string>);

  it("start marks setup as in progress without enabling anything", async () => {
    await act({ intent: "start" });
    expect(env.settings.onboardingStartedAt).toBeInstanceOf(Date);
    expect(env.settings.onboardingCompletedAt).toBeNull();
    expect(env.settings.autoMergeEnabled).toBe(false);
  });

  it("saves a valid merge window and rejects an invalid one", async () => {
    await act({ intent: "window", mergeWindowHours: "12" });
    expect(env.settings.mergeWindowHours).toBe(12);
    const bad = await act({ intent: "window", mergeWindowHours: "169" });
    expect((bad as Response).status).toBe(400);
    expect(env.settings.mergeWindowHours).toBe(12);
  });

  it.each([
    ["invalid merge window", { mergeWindowHours: "169" }, "merge-window"],
    ["missing acknowledgement", { acknowledged: "false" }, "acknowledgement"],
  ])("refuses to complete with %s", async (_label, fields, requirement) => {
    const result = await complete(fields);
    expect((result as Response).status).toBe(400);
    expect((await body(result)).missing).toContain(requirement);
    expect(env.settings.autoMergeEnabled).toBe(false);
    expect(env.settings.onboardingCompletedAt).toBeNull();
  });

  it("refuses to complete a multi-location store without location access", async () => {
    env.location = { activeLocationCount: 3, granted: false };
    const result = await complete();
    expect((await body(result)).missing).toEqual(["location"]);
    expect(env.settings.onboardingCompletedAt).toBeNull();
  });

  it("refuses to complete when locations can't be verified", async () => {
    env.location = { activeLocationCount: null, granted: false };
    expect((await body(await complete())).missing).toEqual(["location"]);
  });

  it("completes and activates in one step when everything is valid", async () => {
    env.location = { activeLocationCount: 3, granted: true };
    const result = await complete({ mergeWindowHours: "12" });
    expect(locationOf(result)).toBe("/app/onboarding?step=done");
    expect(env.settings).toMatchObject({ autoMergeEnabled: true, mergeWindowHours: 12 });
    expect(env.settings.onboardingCompletedAt).toBeInstanceOf(Date);
    expect(env.settings.autoMergeAcknowledgedAt).toBeInstanceOf(Date);
    expect(env.settings.onboardingStartedAt).toBeInstanceOf(Date);
  });

  it("a single-location store completes without any location access", async () => {
    env.location = { activeLocationCount: 1, granted: false };
    expect(locationOf(await complete())).toBe("/app/onboarding?step=done");
  });

  it("ignores onboarding requests once setup is complete", async () => {
    env.settings = completedShop({ mergeWindowHours: 24 });
    expect(locationOf(await act({ intent: "window", mergeWindowHours: "1" }))).toBe("/app");
    expect(env.settings.mergeWindowHours).toBe(24);
  });
});

describe("Settings action", () => {
  const save = (fields: Record<string, string>) =>
    outcome(() => settingsRoute.action({ request: post("/app/settings", fields), params: {}, context: {} } as any));

  it("cannot turn automation on before setup is complete", async () => {
    const result = await save({ autoMergeEnabled: "true", acknowledged: "true", mergeWindowHours: "24" });
    expect((result as Response).status).toBe(400);
    expect(env.settings.autoMergeEnabled).toBe(false);
  });

  it("lets a completed merchant pause and resume without re-acknowledging", async () => {
    env.settings = completedShop();
    await save({ autoMergeEnabled: "false", mergeWindowHours: "24" });
    expect(env.settings.autoMergeEnabled).toBe(false);
    await save({ autoMergeEnabled: "true", mergeWindowHours: "24" });
    expect(env.settings.autoMergeEnabled).toBe(true);
    expect(env.settings.onboardingCompletedAt).toBeInstanceOf(Date);
  });

  it("asks a migrated merchant who never acknowledged before resuming", async () => {
    env.settings = completedShop({ autoMergeEnabled: false, autoMergeAcknowledgedAt: null });
    expect(((await save({ autoMergeEnabled: "true", mergeWindowHours: "24" })) as Response).status).toBe(400);
    await save({ autoMergeEnabled: "true", acknowledged: "true", mergeWindowHours: "24" });
    expect(env.settings.autoMergeEnabled).toBe(true);
    expect(env.settings.autoMergeAcknowledgedAt).toBeInstanceOf(Date);
  });

  it("rejects an invalid merge window", async () => {
    env.settings = completedShop();
    expect(((await save({ autoMergeEnabled: "true", mergeWindowHours: "2.5" })) as Response).status).toBe(400);
    expect(env.settings.mergeWindowHours).toBe(24);
  });
});

describe("orders/create webhook", () => {
  const deliver = async () => {
    const payload = {
      admin_graphql_api_id: "gid://shopify/Order/9",
      financial_status: "paid",
      fulfillment_status: null,
      customer: { admin_graphql_api_id: "gid://shopify/Customer/1" },
      shipping_address: { address1: "1 Main", country_code: "US" },
      shipping_lines: [{ title: "Standard" }],
      created_at: new Date().toISOString(),
    };
    await webhookRoute.action({
      request: new Request("https://app.example.com/webhooks/orders/create", { method: "POST", body: JSON.stringify(payload) }),
      params: {},
      context: {},
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 10)); // background processing
  };

  it("does not process orders when automation is on but setup isn't complete", async () => {
    env.settings = { ...newShop(), autoMergeEnabled: true };
    await deliver();
    expect(env.processed).not.toHaveBeenCalled();
    expect(env.executeMerge).not.toHaveBeenCalled();
  });

  it("does not process orders when an established merchant has paused", async () => {
    env.settings = completedShop({ autoMergeEnabled: false });
    await deliver();
    expect(env.processed).not.toHaveBeenCalled();
  });

  it("processes orders once setup is complete and automation is on", async () => {
    env.settings = completedShop();
    await deliver();
    expect(env.processed).toHaveBeenCalledTimes(1);
  });
});

describe("app/uninstalled webhook", () => {
  it("resets setup and turns automation off, so a reinstall goes through onboarding", async () => {
    vi.resetModules();
    const updateMany = vi.fn(async () => ({ count: 1 }));
    vi.doMock("../app/db.server", () => ({
      default: {
        session: { deleteMany: vi.fn() },
        settings: { findUnique: async () => ({ shopifyShopGid: "gid://shopify/Shop/1" }), updateMany },
      },
    }));
    vi.doMock("../app/shopify.server", () => ({
      authenticate: { webhook: async () => ({ shop: SHOP, session: {}, topic: "APP_UNINSTALLED" }) },
    }));
    vi.doMock("../app/lib/billing.server", () => ({
      cancelSubscription: vi.fn(async () => true),
      resolveShopGidByDomain: vi.fn(),
    }));
    const route = await import("../app/routes/webhooks.app.uninstalled");
    await route.action({ request: new Request("https://x", { method: "POST" }), params: {}, context: {} } as any);
    expect(updateMany).toHaveBeenCalledWith({
      where: { shop: SHOP },
      data: { autoMergeEnabled: false, onboardingStartedAt: null, onboardingCompletedAt: null },
    });
  });
});

describe("merge window bounds (server-side)", () => {
  const post2 = (path: string, fields: Record<string, string>) =>
    new Request(`https://app.example.com${path}`, { method: "POST", body: new URLSearchParams(fields) });

  it("onboarding accepts presets and custom values up to 7 days, and rejects beyond", async () => {
    for (const [value, ok] of [["6", true], ["48", true], ["72", true], ["168", true], ["169", false], ["0", false]] as const) {
      env.settings = { ...DEFAULT_SETTINGS };
      const result = await outcome(() =>
        onboardingRoute.action({ request: post2("/app/onboarding", { intent: "window", mergeWindowHours: value }), params: {}, context: {} } as any),
      );
      expect([value, (result as Response).status ?? 200]).toEqual([value, ok ? 200 : 400]);
      if (ok) expect(env.settings.mergeWindowHours).toBe(Number(value));
    }
  });

  it("Settings keeps working for an existing shop on the retired 12-hour preset", async () => {
    env.settings = completedShop({ mergeWindowHours: 12 });
    await outcome(() =>
      settingsRoute.action({ request: post2("/app/settings", { autoMergeEnabled: "true", mergeWindowHours: "12" }), params: {}, context: {} } as any),
    );
    expect(env.settings.mergeWindowHours).toBe(12);
    await outcome(() =>
      settingsRoute.action({ request: post2("/app/settings", { autoMergeEnabled: "true", mergeWindowHours: "96" }), params: {}, context: {} } as any),
    );
    expect(env.settings.mergeWindowHours).toBe(96);
  });
});
