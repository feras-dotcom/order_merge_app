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

const APP = "gid://shopify/App/446390730753";
const OTHER_NODE = "gid://shopify/DiscountAutomaticNode/4242";

/** Fake Admin modeling the automaticDiscountNode + its three mutations, the
 *  minimal status-only verification read, the shop timezone read, and app
 *  ownership (appDiscountType.app.id vs currentAppInstallation.app.id). */
const makeDiscountAdmin = (init: {
  status: string;
  config?: Record<string, unknown> | null;
  typename?: string;
  appId?: string;
  installationAppId?: string;
  deleted?: boolean;
}) => {
  const state = {
    status: init.status,
    config: init.config === undefined ? baseConfig() : init.config,
    typename: init.typename ?? "DiscountAutomaticApp",
    appId: init.appId ?? APP,
    installationAppId: init.installationAppId ?? APP,
    deleted: init.deleted ?? false,
    calls: 0,
    deactivateCalls: 0,
    activateCalls: 0,
    updateCalls: 0,
    failDeactivate: false,      // userErrors (e.g. "already inactive")
    transportDeactivate: false, // top-level errors — gqlData throws
    failVerify: false,          // the status-only read throws
    poisonConfigRead: false,    // any config-containing read throws
    stuckStatus: null as string | null, // verification reads keep this status
    deactivateIds: [] as string[],
  };
  const admin = {
    state,
    async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
      state.calls += 1;
      const respond = (body: any) => ({ ok: true, status: 200, json: async () => body });
      const vars = options?.variables ?? {};
      const node = () => ({
        data: {
          automaticDiscountNode: {
            id: vars.id ?? DID,
            automaticDiscount: {
              __typename: state.typename,
              title: "MS Checkout Shipping",
              status: state.stuckStatus ?? state.status,
              startsAt: "2026-11-01T00:00:00Z",
              endsAt: null,
              appDiscountType:
                state.typename === "DiscountAutomaticApp"
                  ? { functionId: "fn-1", app: { id: state.appId } }
                  : null,
              combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
            },
            metafield: { jsonValue: state.config },
          },
          currentAppInstallation: { app: { id: state.installationAppId } },
        },
      });
      if (query.includes("discountAutomaticDeactivate")) {
        state.deactivateIds.push(vars.id as string);
        if (state.transportDeactivate) {
          return respond({ errors: [{ message: "transport boom" }] });
        }
        state.deactivateCalls += 1;
        if (state.failDeactivate) {
          return respond({
            data: { discountAutomaticDeactivate: { automaticDiscountNode: null, userErrors: [{ field: ["id"], message: "already inactive" }] } },
          });
        }
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
      // The status-only verification read (Q_STATUS) — BEFORE the generic
      // automaticDiscountNode branch.
      if (query.includes("CheckoutDiscountStatus")) {
        if (state.failVerify) return respond({ errors: [{ message: "verify read fail" }] });
        return respond({
          data: {
            automaticDiscountNode: state.deleted
              ? null
              : {
                  id: vars.id ?? DID,
                  automaticDiscount: {
                    __typename: state.typename,
                    status: state.stuckStatus ?? state.status,
                  },
                },
          },
        });
      }
      if (query.includes("CheckoutShopTimezone") || (query.includes("ianaTimezone") && !query.includes("order"))) {
        return respond({ data: { shop: { ianaTimezone: "UTC" } } });
      }
      if (query.includes("automaticDiscountNode")) {
        if (state.poisonConfigRead) {
          return respond({ errors: [{ message: "config read fail" }] });
        }
        if (state.deleted) return respond({ data: { automaticDiscountNode: null } });
        return respond(node());
      }
      throw new Error(`fake discount admin: unhandled ${query.slice(0, 60)}`);
    },
  };
  return admin;
};

/** Fake setEnabled/readEnabledAt/recordDiscountId/readSettings quartet:
 *  enable stamps a fresh epoch on a false→true transition exactly like
 *  setCheckoutDiscountEnabled; nodeId mirrors checkoutDiscountNodeId. */
/** The approval every prepare-enable call in this file passes — a plain
 *  ground method with an $8.00 USD cap. */
const APPROVAL = { method: "Standard", maxShippingMinor: 800, currency: "USD" };

const makeEpoch = (initial: Date | null, nodeId: string | null = null, seeded = initial !== null) => {
  const state = {
    enabledAt: initial as Date | null,
    nodeId: nodeId as string | null,
    // A prepared epoch normally carries its approval; `seeded:false`
    // models the misconfigured shop (flag on, approval absent).
    approval: (seeded
      ? { method: "standard shipping", maxShippingMinor: 800, currency: "USD" }
      : null) as { method: string; maxShippingMinor: number; currency: string } | null,
    tick: Date.parse("2026-11-15T00:00:00Z"),
  };
  return {
    state,
    setEnabled: async (
      _shop: string,
      enabled: boolean,
      approval: { method: string; maxShippingMinor: number; currency: string } | null = null,
    ) => {
      state.enabledAt = enabled ? (state.enabledAt ?? new Date(state.tick++)) : null;
      state.approval = enabled ? approval : null;
    },
    readEnabledAt: async () => state.enabledAt,
    recordDiscountId: async (_shop: string, id: string | null) => {
      state.nodeId = id;
    },
    readSettings: async () => ({
      ...DEFAULT_SETTINGS,
      checkoutDiscountEnabled: state.enabledAt !== null,
      checkoutDiscountEnabledAt: state.enabledAt,
      checkoutDiscountNodeId: state.nodeId,
      checkoutDiscountWindowHours: null,
      checkoutDiscountMethod: state.approval?.method ?? null,
      checkoutDiscountMaxShippingMinor: state.approval?.maxShippingMinor ?? null,
      checkoutDiscountCurrency: state.approval?.currency ?? null,
    }),
  };
};

const deps = (admin: any, epoch: ReturnType<typeof makeEpoch>) => ({
  admin,
  shop: SHOP,
  discountId: DID,
  ...APPROVAL,
  setEnabled: epoch.setEnabled,
  readEnabledAt: epoch.readEnabledAt,
  recordDiscountId: epoch.recordDiscountId,
  readSettings: epoch.readSettings,
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

  it("a malformed config does not block shutdown (no config read at all)", async () => {
    const admin = makeDiscountAdmin({ status: "ACTIVE", config: { garbage: true } });
    const epoch = makeEpoch(new Date("2026-11-01T00:00:00Z"));
    const r = await shutdownCheckoutDiscount(deps(admin as any, epoch) as any);
    expect(r.status).toBe("EXPIRED");
    expect(epoch.state.enabledAt).toBe(null);
  });

  it("shutdown clears the method approval with the other flags", async () => {
    const admin = makeDiscountAdmin({ status: "ACTIVE" });
    const epoch = makeEpoch(new Date("2026-11-01T00:00:00Z"));
    expect(epoch.state.approval).not.toBe(null); // seeded by the prepared epoch
    const r = await shutdownCheckoutDiscount(deps(admin as any, epoch) as any);
    expect(r.status).toBe("EXPIRED");
    expect(epoch.state.enabledAt).toBe(null);
    expect(epoch.state.approval).toBe(null);
  });

  it("a missing config metafield does not block shutdown", async () => {
    const admin = makeDiscountAdmin({ status: "ACTIVE", config: null });
    const epoch = makeEpoch(new Date("2026-11-01T00:00:00Z"));
    const r = await shutdownCheckoutDiscount(deps(admin as any, epoch) as any);
    expect(r.status).toBe("EXPIRED");
    expect(epoch.state.enabledAt).toBe(null);
  });

  it("a config read that would throw is never issued — status read alone verifies", async () => {
    const admin = makeDiscountAdmin({ status: "ACTIVE" });
    admin.state.poisonConfigRead = true; // Q_DISCOUNT would throw; Q_STATUS answers
    const epoch = makeEpoch(new Date("2026-11-01T00:00:00Z"));
    const r = await shutdownCheckoutDiscount(deps(admin as any, epoch) as any);
    expect(r.status).toBe("EXPIRED");
    expect(epoch.state.enabledAt).toBe(null);
  });

  it("an invalid discount id throws before ANY Admin call", async () => {
    const admin = makeDiscountAdmin({ status: "ACTIVE" });
    const epoch = makeEpoch(new Date("2026-11-01T00:00:00Z"));
    await expect(
      shutdownCheckoutDiscount({ ...deps(admin as any, epoch), discountId: "not-a-gid" } as any),
    ).rejects.toThrow(DiscountStateError);
    expect(admin.state.calls).toBe(0);
    expect(epoch.state.enabledAt).not.toBe(null);
  });

  it("deactivate userErrors cannot fail the shutdown — verification decides (already inactive)", async () => {
    const admin = makeDiscountAdmin({ status: "EXPIRED" });
    admin.state.failDeactivate = true; // userErrors "already inactive"
    const epoch = makeEpoch(new Date("2026-11-01T00:00:00Z"));
    const r = await shutdownCheckoutDiscount(deps(admin as any, epoch) as any);
    expect(r.status).toBe("EXPIRED");
    expect(epoch.state.enabledAt).toBe(null);
  });

  it("a transport deactivate failure still verifies — success with flags flipped", async () => {
    const admin = makeDiscountAdmin({ status: "EXPIRED" }); // already EXPIRED server-side
    admin.state.transportDeactivate = true;
    const epoch = makeEpoch(new Date("2026-11-01T00:00:00Z"));
    const r = await shutdownCheckoutDiscount(deps(admin as any, epoch) as any);
    expect(r.status).toBe("EXPIRED");
    expect(epoch.state.enabledAt).toBe(null);
  });

  it("a transport deactivate failure + unverifiable status surfaces BOTH messages", async () => {
    const admin = makeDiscountAdmin({ status: "ACTIVE" });
    admin.state.transportDeactivate = true;
    admin.state.failVerify = true;
    const epoch = makeEpoch(new Date("2026-11-01T00:00:00Z"));
    const err = await shutdownCheckoutDiscount(deps(admin as any, epoch) as any).catch((e) => e);
    expect(err).toBeInstanceOf(ShutdownNotVerifiedError);
    expect(String(err.message)).toContain("transport boom");
    expect(String(err.message)).toContain("verify read fail");
    expect(epoch.state.enabledAt).not.toBe(null);
  });

  it("a deleted discount is verified DELETED and clears the flag", async () => {
    const admin = makeDiscountAdmin({ status: "ACTIVE", deleted: true });
    const epoch = makeEpoch(new Date("2026-11-01T00:00:00Z"));
    const r = await shutdownCheckoutDiscount(deps(admin as any, epoch) as any);
    expect(r.status).toBe("DELETED");
    expect(epoch.state.enabledAt).toBe(null);
  });

  it("a verification read failure leaves the app flag untouched", async () => {
    const admin = makeDiscountAdmin({ status: "ACTIVE" });
    admin.state.failVerify = true;
    const epoch = makeEpoch(new Date("2026-11-01T00:00:00Z"));
    await expect(shutdownCheckoutDiscount(deps(admin as any, epoch) as any)).rejects.toThrow(
      ShutdownNotVerifiedError,
    );
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

  it("a wrong __typename in the verification read fails closed", async () => {
    const admin = makeDiscountAdmin({ status: "ACTIVE", typename: "DiscountAutomaticBasic" });
    const epoch = makeEpoch(new Date("2026-11-01T00:00:00Z"));
    await expect(shutdownCheckoutDiscount(deps(admin as any, epoch) as any)).rejects.toThrow(
      ShutdownNotVerifiedError,
    );
    expect(epoch.state.enabledAt).not.toBe(null);
  });

  it("already inactive => idempotent: deactivate still issued, flag cleared", async () => {
    const admin = makeDiscountAdmin({ status: "EXPIRED" });
    const epoch = makeEpoch(new Date("2026-11-01T00:00:00Z"));
    const r = await shutdownCheckoutDiscount(deps(admin as any, epoch) as any);
    expect(r.status).toBe("EXPIRED");
    expect(admin.state.deactivateCalls).toBe(1);
    expect(epoch.state.enabledAt).toBe(null);
  });

  it("a transient deactivate failure is recovered by a second call", async () => {
    const admin = makeDiscountAdmin({ status: "ACTIVE" });
    admin.state.transportDeactivate = true;
    const epoch = makeEpoch(new Date("2026-11-01T00:00:00Z"));
    await expect(shutdownCheckoutDiscount(deps(admin as any, epoch) as any)).rejects.toThrow(
      ShutdownNotVerifiedError,
    );
    expect(epoch.state.enabledAt).not.toBe(null);
    admin.state.transportDeactivate = false;
    const r = await shutdownCheckoutDiscount(deps(admin as any, epoch) as any);
    expect(r.status).toBe("EXPIRED");
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

  it("refuses a discount owned by a DIFFERENT app — nothing enabled or recorded", async () => {
    const admin = makeDiscountAdmin({ status: "EXPIRED", appId: "gid://shopify/App/999999" });
    const epoch = makeEpoch(null);
    await expect(prepareEnable(deps(admin as any, epoch) as any)).rejects.toThrow(
      /not owned by this app/,
    );
    expect(epoch.state.enabledAt).toBe(null);
    expect(epoch.state.nodeId).toBe(null);
    expect(admin.state.updateCalls).toBe(0);
  });

  it("refuses a non-app automatic discount (wrong __typename)", async () => {
    const admin = makeDiscountAdmin({ status: "EXPIRED", typename: "DiscountAutomaticBasic" });
    const epoch = makeEpoch(null);
    await expect(prepareEnable(deps(admin as any, epoch) as any)).rejects.toThrow(
      DiscountStateError,
    );
    expect(epoch.state.enabledAt).toBe(null);
    expect(epoch.state.nodeId).toBe(null);
  });

  it("refuses a config whose message is not ours", async () => {
    const admin = makeDiscountAdmin({
      status: "EXPIRED",
      config: baseConfig({ message: "some other discount" }),
    });
    const epoch = makeEpoch(null);
    await expect(prepareEnable(deps(admin as any, epoch) as any)).rejects.toThrow(
      DiscountStateError,
    );
    expect(epoch.state.enabledAt).toBe(null);
    expect(epoch.state.nodeId).toBe(null);
  });

  it.each([
    ["missing method", { method: undefined }],
    ["empty after normalization", { method: "   " }],
    ["expedited lookalike (express)", { method: "Express" }],
    ["expedited lookalike (next day)", { method: "Next Day Air" }],
    ["expedited lookalike (2-day)", { method: "2 Day Shipping" }],
    ["missing currency", { currency: undefined }],
    ["lowercase currency", { currency: "usd" }],
    ["unsupported currency", { currency: "XXX" }],
    ["missing cap", { maxShippingMinor: undefined }],
    ["zero cap", { maxShippingMinor: 0 }],
    ["negative cap", { maxShippingMinor: -800 }],
    ["fractional cap", { maxShippingMinor: 8.5 }],
    ["absurd cap", { maxShippingMinor: 3_000_000_000 }],
  ])("refuses BEFORE any write: %s", async (_name, bad) => {
    const admin = makeDiscountAdmin({ status: "EXPIRED" });
    const epoch = makeEpoch(null);
    await expect(
      prepareEnable({ ...deps(admin as any, epoch), ...bad } as any),
    ).rejects.toThrow(DiscountConfigError);
    // Nothing was enabled, recorded, or even read — validation precedes
    // the discount read.
    expect(epoch.state.enabledAt).toBe(null);
    expect(epoch.state.approval).toBe(null);
    expect(epoch.state.nodeId).toBe(null);
    expect(admin.state.updateCalls).toBe(0);
    expect(admin.state.calls).toBe(0); // no Admin call was made at all
  });

  it("stores the approval atomically with the flag — normalized method, integer minor, ISO currency", async () => {
    const admin = makeDiscountAdmin({ status: "EXPIRED" });
    const epoch = makeEpoch(null);
    await prepareEnable({
      ...deps(admin as any, epoch),
      method: "  STANDARD   Shipping ",
      maxShippingMinor: 800,
      currency: "USD",
    } as any);
    expect(epoch.state.approval).toEqual({
      method: "standard shipping",
      maxShippingMinor: 800,
      currency: "USD",
    });
  });

  it("a second prepare-enable re-approves (the old bound is replaced)", async () => {
    const admin = makeDiscountAdmin({ status: "EXPIRED" });
    const epoch = makeEpoch(null);
    await prepareEnable(deps(admin as any, epoch) as any);
    await prepareEnable({
      ...deps(admin as any, epoch),
      method: "Economy",
      maxShippingMinor: 400,
      currency: "USD",
    } as any);
    expect(epoch.state.approval).toEqual({
      method: "economy",
      maxShippingMinor: 400,
      currency: "USD",
    });
  });

  it("derives w<epochMs>, writes it into the config, records the node id and leaves the discount inactive", async () => {
    const admin = makeDiscountAdmin({ status: "EXPIRED" });
    const epoch = makeEpoch(null);
    const r = await prepareEnable(deps(admin as any, epoch) as any);
    expect(r.windowId).toBe(`w${r.enabledAt.getTime()}`);
    expect(admin.state.config!.windowId).toBe(r.windowId);
    // Other config keys preserved.
    expect(admin.state.config!.percentage).toBe("100.0");
    expect(admin.state.config!.message).toBe(CHECKOUT_DISCOUNT_MESSAGE);
    expect(admin.state.config!.windowEnd).toBe("2026-12-01T00:00:00");
    expect(admin.state.status).toBe("EXPIRED"); // still inactive
    // The verified identity is recorded for activate/shutdown/enforcer.
    expect(epoch.state.nodeId).toBe(DID);
  });
});

describe("activateCheckoutDiscount", () => {
  const NOW = new Date("2026-11-15T12:00:00Z");
  const gateOn = (windowId: string) =>
    ({
      on: true,
      enabledAt: NOW,
      mergeWindowHours: 24,
      windowId,
      approved: { method: "standard shipping", maxMinor: 800n, currency: "USD" },
    }) as const;
  const actDeps = (admin: any, epoch: ReturnType<typeof makeEpoch>, over: Record<string, unknown> = {}) => ({
    ...deps(admin, epoch),
    expectedWindowId: "w1",
    gate: async () => gateOn("w1"),
    now: () => NOW,
    shopTimezone: "UTC",
    ...over,
  });
  const ready = (config: Record<string, unknown> = {}, nodeId: string | null = DID) => ({
    admin: makeDiscountAdmin({ status: "EXPIRED", config: baseConfig({ windowId: "w1", ...config }) }),
    epoch: makeEpoch(new Date("2026-11-15T00:00:00Z"), nodeId),
  });

  it("refuses when the shop settings carry no valid approval", async () => {
    // Flag on + node id recorded but the approval columns are NULL — an
    // enable that never ran the new prepare-enable.
    const { admin, epoch } = ready();
    epoch.state.approval = null;
    await expect(activateCheckoutDiscount(actDeps(admin, epoch) as any)).rejects.toThrow(
      /method approval/,
    );
    expect(admin.state.activateCalls).toBe(0);
  });

  it("refuses when no discount node id is recorded — run prepare-enable first", async () => {
    const { admin, epoch } = ready({}, null);
    await expect(activateCheckoutDiscount(actDeps(admin, epoch) as any)).rejects.toThrow(
      /prepare-enable first/,
    );
    expect(admin.state.activateCalls).toBe(0);
  });

  it("refuses an unrelated discount id", async () => {
    const { admin, epoch } = ready();
    await expect(
      activateCheckoutDiscount(actDeps(admin, epoch, { discountId: OTHER_NODE }) as any),
    ).rejects.toThrow(DiscountStateError);
    expect(admin.state.activateCalls).toBe(0);
  });

  it("refuses a wrong expected epoch", async () => {
    const { admin, epoch } = ready();
    await expect(
      activateCheckoutDiscount(actDeps(admin, epoch, { expectedWindowId: "w-other" }) as any),
    ).rejects.toThrow(DiscountStateError);
    expect(admin.state.activateCalls).toBe(0);
  });

  it("refuses a stale config from a previous epoch while the gate is on the new one", async () => {
    const { admin, epoch } = ready({ windowId: "w-old-epoch" });
    await expect(
      activateCheckoutDiscount(actDeps(admin, epoch, { expectedWindowId: "w-new" }) as any),
    ).rejects.toThrow(DiscountStateError);
    expect(admin.state.activateCalls).toBe(0);
  });

  it("refuses when the gate windowId differs from expected", async () => {
    const { admin, epoch } = ready();
    await expect(
      activateCheckoutDiscount(
        actDeps(admin, epoch, { gate: async () => gateOn("w-gate-rotated") }) as any,
      ),
    ).rejects.toThrow(DiscountStateError);
    expect(admin.state.activateCalls).toBe(0);
  });

  it("refuses when the app gate is not on", async () => {
    const { admin, epoch } = ready();
    await expect(
      activateCheckoutDiscount(
        actDeps(admin, epoch, { gate: async () => ({ on: false, reason: "auto-merge" }) }) as any,
      ),
    ).rejects.toThrow(DiscountStateError);
    expect(admin.state.activateCalls).toBe(0);
  });

  it("refuses an incorrect config message", async () => {
    const { admin, epoch } = ready({ message: "wrong message" });
    await expect(activateCheckoutDiscount(actDeps(admin, epoch) as any)).rejects.toThrow(
      DiscountStateError,
    );
    expect(admin.state.activateCalls).toBe(0);
  });

  it("refuses a non-string percentage (fails config validation)", async () => {
    const { admin, epoch } = ready({ percentage: 100 });
    await expect(activateCheckoutDiscount(actDeps(admin, epoch) as any)).rejects.toThrow(
      DiscountConfigError,
    );
    expect(admin.state.activateCalls).toBe(0);
  });

  it("refuses out-of-range percentages", async () => {
    for (const percentage of ["0.0", "150.0"]) {
      const { admin, epoch } = ready({ percentage });
      await expect(activateCheckoutDiscount(actDeps(admin, epoch) as any)).rejects.toThrow(
        DiscountStateError,
      );
      expect(admin.state.activateCalls).toBe(0);
    }
  });

  it("refuses when the config window has not started (shop-local now)", async () => {
    const { admin, epoch } = ready({ windowStart: "2026-11-20T00:00:00" });
    await expect(activateCheckoutDiscount(actDeps(admin, epoch) as any)).rejects.toThrow(
      /does not contain shop-local now/,
    );
    expect(admin.state.activateCalls).toBe(0);
  });

  it("refuses when the config window already ended", async () => {
    const { admin, epoch } = ready({ windowEnd: "2026-11-10T00:00:00" });
    await expect(activateCheckoutDiscount(actDeps(admin, epoch) as any)).rejects.toThrow(
      DiscountStateError,
    );
    expect(admin.state.activateCalls).toBe(0);
  });

  it("the window check compares against the SHOP timezone, not UTC", async () => {
    // 2026-11-15T23:30Z is 2026-11-16 in Kiritimati (UTC+14) — the window
    // ending 2026-11-15 has already passed shop-locally.
    const { admin, epoch } = ready({ windowEnd: "2026-11-15T23:59:59" });
    await expect(
      activateCheckoutDiscount(
        actDeps(admin, epoch, {
          now: () => new Date("2026-11-15T23:30:00Z"),
          shopTimezone: "Pacific/Kiritimati",
        }) as any,
      ),
    ).rejects.toThrow(DiscountStateError);
    expect(admin.state.activateCalls).toBe(0);
  });

  it("activates when config, gate, window and recorded id all agree, verified ACTIVE", async () => {
    const { admin, epoch } = ready();
    const r = await activateCheckoutDiscount(actDeps(admin, epoch) as any);
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
  checkoutDiscountWindowHours: enabledAt !== null ? 72 : null,
  mergeWindowHours: 72,
  checkoutDiscountMethod: enabledAt !== null ? "standard shipping" : null,
  checkoutDiscountMaxShippingMinor: enabledAt !== null ? 800 : null,
  checkoutDiscountCurrency: enabledAt !== null ? "USD" : null,
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
  const ddeps = deps(admin as any, epoch);
  await shutdownCheckoutDiscount(ddeps);
  expect(epoch.state.enabledAt).toBe(null);
  expect(discount.state.status).toBe("EXPIRED");

  // Re-enable: fresh epoch, windowId rotates, config is updated, discount
  // stays INACTIVE until activate is called separately.
  const prep = await prepareEnable({ ...ddeps, readEnabledAt: epoch.readEnabledAt });
  const WIN2 = prep.windowId;
  expect(WIN2).not.toBe(WIN1);
  expect(discount.state.config!.windowId).toBe(WIN2);
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
