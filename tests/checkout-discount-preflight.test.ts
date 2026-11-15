// runPreflight: read-only pre-enable validation — every check green, and
// each check failing alone. Injected settings/control/admin; no real
// Shopify. Output detail codes only.
import { describe, expect, it, vi } from "vitest";
import { runPreflight, type PreflightDeps } from "../app/lib/checkout-discount/preflight.server";
import { CHECKOUT_DISCOUNT_MESSAGE } from "../app/lib/checkout-discount/config";
import { DEFAULT_SETTINGS, type MergeSettings } from "../app/lib/settings.server";

vi.mock("../app/db.server", () => ({ default: {} }));

const SHOP = "s.myshopify.com";
const APP = "gid://shopify/App/1";
const APP_URL = "https://ms.example.com";
const DID = "gid://shopify/DiscountAutomaticNode/99";
const EPOCH1 = new Date("2026-11-01T00:00:00Z");

const REQUIRED_TOPICS = [
  "ORDERS_PAID",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "ORDERS_FULFILLED",
  "ORDERS_PARTIALLY_FULFILLED",
  "REFUNDS_CREATE",
  "ORDERS_RISK_ASSESSMENT_CHANGED",
];

/** API enum name -> Shopify topic string (mirrors the declaration mapping
 *  in preflight.server.ts; the drift-guard test proves them against the
 *  real bundled file). */
const TOPIC_OF: Record<string, string> = {
  ORDERS_PAID: "orders/paid",
  ORDERS_UPDATED: "orders/updated",
  ORDERS_CANCELLED: "orders/cancelled",
  ORDERS_FULFILLED: "orders/fulfilled",
  ORDERS_PARTIALLY_FULFILLED: "orders/partially_fulfilled",
  REFUNDS_CREATE: "refunds/create",
  ORDERS_RISK_ASSESSMENT_CHANGED: "orders/risk_assessment_changed",
};

/** A declaration TOML covering `topics` with exact `/webhooks/<topic>`
 *  URIs — the shape the bundled shopify.app.checkout-first.toml carries. */
const declaringToml = (topics: string[], uriFor?: (t: string) => string) =>
  topics
    .map(
      (t) =>
        `  [[webhooks.subscriptions]]\n  uri = "${uriFor ? uriFor(t) : `/webhooks/${t}`}"\n  topics = [ "${t}" ]\n`,
    )
    .join("\n");

const DECLARED_ALL = declaringToml(Object.values(TOPIC_OF));

const allOnSettings = (over: Partial<MergeSettings> = {}): MergeSettings => ({
  ...DEFAULT_SETTINGS,
  autoMergeEnabled: true,
  onboardingStartedAt: EPOCH1,
  onboardingCompletedAt: EPOCH1,
  mergeWindowHours: 24,
  checkoutDiscountEnabled: true,
  checkoutDiscountEnabledAt: EPOCH1,
  checkoutDiscountNodeId: DID,
  checkoutDiscountWindowHours: 24,
  checkoutDiscountMethod: "standard shipping",
  checkoutDiscountMaxShippingMinor: 800,
  checkoutDiscountCurrency: "USD",
  ...over,
});

const config = (over: Record<string, unknown> = {}) => ({
  v: 1,
  windowId: "w1",
  percentage: "100.0",
  message: CHECKOUT_DISCOUNT_MESSAGE,
  windowStart: "2026-11-01T00:00:00",
  windowEnd: "2026-12-01T00:00:00",
  ...over,
});

interface AdminInit {
  scopes?: string[];
  topics?: { topic: string; uri?: string }[];
  plan?: { partnerDevelopment?: boolean; shopifyPlus?: boolean; publicDisplayName?: string | null } | null;
  discountStatus?: string;
  discountConfig?: unknown;
  discountExists?: boolean;
  discountTypename?: string;
  discountAppId?: string | null;
  installationAppId?: string;
  probeOrders?: number;
  probeError?: boolean;
  preflightError?: boolean;
}

const makeAdmin = (init: AdminInit = {}) => {
  const state = { queries: [] as string[] };
  const admin = {
    state,
    async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
      state.queries.push(query);
      const respond = (body: any) => ({ ok: true, status: 200, json: async () => body });
      if (query.includes("CheckoutPreflight")) {
        if (init.preflightError) return respond({ errors: [{ message: "read fail" }] });
        const topics =
          init.topics ??
          REQUIRED_TOPICS.map((topic) => ({ topic, uri: undefined as string | undefined }));
        return respond({
          data: {
            currentAppInstallation: {
              accessScopes: (init.scopes ?? ["write_customers", "write_discounts"]).map(
                (handle) => ({ handle }),
              ),
              app: { id: init.installationAppId ?? APP },
            },
            webhookSubscriptions: {
              nodes: topics.map((t, i) => ({
                id: `gid://hook/${i}`,
                topic: t.topic,
                uri: t.uri ?? `${APP_URL}/webhooks`,
              })),
            },
            shop: {
              plan:
                init.plan === undefined
                  ? { partnerDevelopment: true, shopifyPlus: false, publicDisplayName: "Development" }
                  : init.plan,
            },
          },
        });
      }
      if (query.includes("CheckoutProtectedProbe")) {
        if (init.probeError) return respond({ errors: [{ message: "ACCESS_DENIED" }] });
        return respond({
          data: {
            orders: {
              nodes: Array.from({ length: init.probeOrders ?? 1 }, (_, i) => ({
                id: `gid://o/${i}`,
                shippingAddress: { firstName: "x", lastName: "y", address1: "z" },
              })),
            },
          },
        });
      }
      if (query.includes("automaticDiscountNode")) {
        const exists = init.discountExists !== false;
        const typename = init.discountTypename ?? "DiscountAutomaticApp";
        const appId = init.discountAppId === undefined ? APP : init.discountAppId;
        return respond({
          data: {
            automaticDiscountNode: exists
              ? {
                  id: DID,
                  automaticDiscount: {
                    __typename: typename,
                    status: init.discountStatus ?? "EXPIRED",
                    appDiscountType:
                      typename === "DiscountAutomaticApp"
                        ? { functionId: "fn", app: { id: appId } }
                        : null,
                    combinesWith: {
                      orderDiscounts: false,
                      productDiscounts: false,
                      shippingDiscounts: false,
                    },
                  },
                  metafield: { jsonValue: init.discountConfig ?? config() },
                }
              : null,
            currentAppInstallation: { app: { id: init.installationAppId ?? APP } },
          },
        });
      }
      throw new Error(`fake preflight admin: unhandled ${query.slice(0, 60)}`);
    },
  };
  return admin;
};

const deps = (over: Partial<PreflightDeps> = {}, adminInit: AdminInit = {}): PreflightDeps => ({
  admin: makeAdmin(adminInit) as any,
  shop: SHOP,
  env: (n) => (n === "MERGESHIP_CHECKOUT_DISCOUNT" ? "enabled" : undefined),
  settings: async () => allOnSettings(),
  control: async () => ({
    checkoutDiscountEnabled: true,
    checkoutDiscountAllowShops: [SHOP],
  }),
  appUrl: APP_URL,
  // A controlled declaration — tests never read the real bundled file
  // except the drift guard.
  readConfig: () => DECLARED_ALL,
  ...over,
});

const byCheck = (checks: { check: string; ok: boolean | "warn"; detail: string }[]) =>
  Object.fromEntries(checks.map((c) => [c.check, c]));

describe("runPreflight", () => {
  it("all green when every lever holds", async () => {
    const checks = byCheck(await runPreflight(deps()));
    const fails = Object.values(checks).filter((c) => c.ok === false);
    expect(fails).toEqual([]);
    expect(checks["scopes"].detail).toBe("OK");
    expect(checks["webhooks"].detail).toBe("OK_API");
    expect(checks["method-approval"].detail).toBe("OK");
    expect(checks["discount"].detail).toBe("STATUS_EXPIRED");
    expect(checks["protected-data"].detail).toBe("OK");
  });

  it("missing scopes fails only `scopes`", async () => {
    const checks = byCheck(await runPreflight(deps({}, { scopes: ["write_customers"] })));
    expect(checks["scopes"].ok).toBe(false);
    expect(checks["scopes"].detail).toBe("MISSING_WRITE_DISCOUNTS");
    expect(Object.values(checks).filter((c) => c.ok === false).map((c) => c.check)).toEqual(["scopes"]);
  });

  it("a topic missing in BOTH the API listing and the declaration fails `webhooks`", async () => {
    const checks = byCheck(
      await runPreflight(
        deps(
          { readConfig: () => declaringToml(Object.values(TOPIC_OF).slice(1)) },
          { topics: REQUIRED_TOPICS.slice(1).map((topic) => ({ topic })) },
        ),
      ),
    );
    expect(checks["webhooks"].ok).toBe(false);
    expect(checks["webhooks"].detail).toBe("MISSING_1_TOPICS");
  });

  it("a webhook on another URL does not count (and a wrong declaration URI does not either)", async () => {
    const checks = byCheck(
      await runPreflight(
        deps(
          { readConfig: () => declaringToml(Object.values(TOPIC_OF), (t) => `/other/${t}`) },
          { topics: REQUIRED_TOPICS.map((topic) => ({ topic, uri: "https://other.example.com/hook" })) },
        ),
      ),
    );
    expect(checks["webhooks"].ok).toBe(false);
    expect(checks["webhooks"].detail).toBe(`MISSING_${REQUIRED_TOPICS.length}_TOPICS`);
  });

  it("declaration-only satisfaction passes as OK_DECLARED with the release warning", async () => {
    const checks = await runPreflight(deps({}, { topics: [] }));
    const m = byCheck(checks);
    expect(m["webhooks"].ok).toBe(true);
    expect(m["webhooks"].detail).toBe("OK_DECLARED");
    expect(m["webhooks-release"]).toEqual({
      check: "webhooks-release",
      ok: "warn",
      detail: "VERIFY_RELEASED_VERSION",
    });
  });

  it("API-only satisfaction passes as OK_API with no release warning", async () => {
    const checks = await runPreflight(
      deps({ readConfig: () => { throw new Error("unreadable"); } }),
    );
    const m = byCheck(checks);
    expect(m["webhooks"].ok).toBe(true);
    expect(m["webhooks"].detail).toBe("OK_API");
    expect(m["webhooks-release"]).toBeUndefined();
  });

  it("mixed API + declaration satisfaction passes as OK_DECLARED with the release warning", async () => {
    const checks = await runPreflight(
      deps(
        // The declaration covers every topic; the API covers only the last
        // three — the first four are satisfied by the declaration alone.
        {},
        { topics: REQUIRED_TOPICS.slice(4).map((topic) => ({ topic })) },
      ),
    );
    const m = byCheck(checks);
    expect(m["webhooks"].ok).toBe(true);
    expect(m["webhooks"].detail).toBe("OK_DECLARED");
    expect(m["webhooks-release"]).toEqual({
      check: "webhooks-release",
      ok: "warn",
      detail: "VERIFY_RELEASED_VERSION",
    });
  });

  it("an unreadable declaration with incomplete API subscriptions fails DECLARATION_UNREADABLE", async () => {
    const checks = byCheck(
      await runPreflight(
        deps(
          { readConfig: () => { throw new Error("ENOENT"); } },
          { topics: REQUIRED_TOPICS.slice(1).map((topic) => ({ topic })) },
        ),
      ),
    );
    expect(checks["webhooks"].ok).toBe(false);
    expect(checks["webhooks"].detail).toBe("DECLARATION_UNREADABLE");
  });

  it("the REAL bundled shopify.app.checkout-first.toml declares all required topics (drift guard)", async () => {
    const real = (await import("node:fs")).readFileSync(
      (await import("node:path")).join(process.cwd(), "shopify.app.checkout-first.toml"),
      "utf8",
    );
    const checks = await runPreflight(
      deps({ readConfig: () => real }, { topics: [] }),
    );
    const m = byCheck(checks);
    expect(m["webhooks"].ok).toBe(true);
    expect(m["webhooks"].detail).toBe("OK_DECLARED");
  });

  it("no recorded discount id fails `discount` without an Admin call", async () => {
    const admin = makeAdmin();
    const checks = byCheck(
      await runPreflight(deps({ admin: admin as any, settings: async () => allOnSettings({ checkoutDiscountNodeId: null }) })),
    );
    expect(checks["discount"].ok).toBe(false);
    expect(checks["discount"].detail).toBe("NO_RECORDED_DISCOUNT");
    expect(admin.state.queries.some((q) => q.includes("automaticDiscountNode"))).toBe(false);
  });

  it.each([
    [{ discountExists: false }, "NOT_FOUND"],
    [{ discountTypename: "DiscountAutomaticBasic" }, "WRONG_TYPE"],
    [{ discountAppId: "gid://shopify/App/999" }, "NOT_APP_OWNED"],
    [{ discountConfig: config({ message: "other" }) }, "WRONG_MESSAGE"],
    [{ discountConfig: { garbage: 1 } }, "CONFIG_INVALID"],
    [{ discountStatus: "ACTIVE" }, "STATUS_ACTIVE"],
    [{ discountStatus: "SCHEDULED" }, "STATUS_SCHEDULED"],
  ])("discount case %j -> detail %s", async (init, detail) => {
    const checks = byCheck(await runPreflight(deps({}, init as AdminInit)));
    expect(checks["discount"].ok).toBe(false);
    expect(checks["discount"].detail).toBe(detail);
  });

  it("env flag off fails only `env-flag`", async () => {
    const checks = byCheck(await runPreflight(deps({ env: () => undefined })));
    expect(checks["env-flag"].ok).toBe(false);
    expect(checks["env-flag"].detail).toBe("UNSET");
    expect(Object.values(checks).filter((c) => c.ok === false).map((c) => c.check)).toEqual(["env-flag"]);
  });

  it("control switch off fails only `control-switch`", async () => {
    const checks = byCheck(
      await runPreflight(
        deps({ control: async () => ({ checkoutDiscountEnabled: false, checkoutDiscountAllowShops: [SHOP] }) }),
      ),
    );
    expect(Object.values(checks).filter((c) => c.ok === false).map((c) => c.check)).toEqual(["control-switch"]);
  });

  it("shop not allowlisted fails only `allowlist`", async () => {
    const checks = byCheck(
      await runPreflight(
        deps({ control: async () => ({ checkoutDiscountEnabled: true, checkoutDiscountAllowShops: [] }) }),
      ),
    );
    expect(Object.values(checks).filter((c) => c.ok === false).map((c) => c.check)).toEqual(["allowlist"]);
  });

  it("auto-merge off fails only `auto-merge`", async () => {
    const checks = byCheck(
      await runPreflight(deps({ settings: async () => allOnSettings({ autoMergeEnabled: false }) })),
    );
    expect(Object.values(checks).filter((c) => c.ok === false).map((c) => c.check)).toEqual(["auto-merge"]);
  });

  it("incomplete onboarding fails only `onboarding`", async () => {
    const checks = byCheck(
      await runPreflight(
        deps({ settings: async () => allOnSettings({ onboardingCompletedAt: null }) }),
      ),
    );
    expect(Object.values(checks).filter((c) => c.ok === false).map((c) => c.check)).toEqual(["onboarding"]);
  });

  it("merge window < 24h fails only `merge-window`", async () => {
    const checks = byCheck(
      await runPreflight(deps({ settings: async () => allOnSettings({ mergeWindowHours: 12 }) })),
    );
    expect(Object.values(checks).filter((c) => c.ok === false).map((c) => c.check)).toEqual(["merge-window"]);
  });

  it("shop flag off fails only `shop-flag`", async () => {
    const checks = byCheck(
      await runPreflight(deps({ settings: async () => allOnSettings({ checkoutDiscountEnabled: false }) })),
    );
    expect(Object.values(checks).filter((c) => c.ok === false).map((c) => c.check)).toEqual(["shop-flag"]);
  });

  it("protected-data probe: ACCESS_DENIED and NO_ORDERS warn, never fail", async () => {
    for (const [init, detail] of [
      [{ probeError: true }, "ACCESS_DENIED"],
      [{ probeOrders: 0 }, "NO_ORDERS"],
    ] as [AdminInit, string][]) {
      const checks = byCheck(await runPreflight(deps({}, init)));
      expect(checks["protected-data"].ok).toBe("warn");
      expect(checks["protected-data"].detail).toBe(detail);
      expect(Object.values(checks).filter((c) => c.ok === false)).toEqual([]);
    }
  });

  it("an Admin read failure fails scopes+webhooks, never throws", async () => {
    const checks = await runPreflight(deps({}, { preflightError: true }));
    const m = byCheck(checks);
    expect(m["scopes"].ok).toBe(false);
    expect(m["webhooks"].ok).toBe(false);
    expect(m["admin-read"].detail).toBe("ADMIN_READ_FAILED");
  });

  it("method-approval: unset or invalid approval fails only `method-approval`", async () => {
    for (const over of [
      { checkoutDiscountMethod: null },
      { checkoutDiscountMaxShippingMinor: null },
      { checkoutDiscountCurrency: null },
      { checkoutDiscountMaxShippingMinor: 0 },
      { checkoutDiscountCurrency: "usd" },
    ] as Partial<MergeSettings>[]) {
      const checks = byCheck(
        await runPreflight(deps({ settings: async () => allOnSettings(over) })),
      );
      expect(checks["method-approval"].ok).toBe(false);
      expect(checks["method-approval"].detail).toBe("UNSET");
    }
  });
});
