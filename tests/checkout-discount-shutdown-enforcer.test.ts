// Pending-shutdown enforcement (spec G): the durable pending marker is the
// persisted state checkoutDiscountEnabled=true + a failing per-shop lever.
// The enforcer deactivates ONLY the recorded checkoutDiscountNodeId, never
// throws, and retries with spacing until the shutdown is verified.
import { describe, expect, it } from "vitest";
import {
  enforcePendingShutdowns,
  enforceShopShutdown,
} from "../app/lib/checkout-discount/shutdown-enforcer.server";
import { shopLevelGateOff } from "../app/lib/checkout-discount/gate.server";
import type { DiagEvent } from "../app/lib/checkout-discount/diag";
import { DEFAULT_SETTINGS, type MergeSettings } from "../app/lib/settings.server";

const SHOP = "s.myshopify.com";
const DID = "gid://shopify/DiscountAutomaticNode/99";
const OTHER = "gid://shopify/DiscountAutomaticNode/4242";

const settings = (over: Partial<MergeSettings> = {}): MergeSettings & { shop: string } => ({
  shop: SHOP,
  ...DEFAULT_SETTINGS,
  autoMergeEnabled: true,
  onboardingCompletedAt: new Date("2026-11-01T00:00:00Z"),
  mergeWindowHours: 48,
  checkoutDiscountEnabled: true,
  checkoutDiscountEnabledAt: new Date("2026-11-01T00:00:00Z"),
  checkoutDiscountNodeId: DID,
  ...over,
});

const diags = () => {
  const events: DiagEvent[] = [];
  return { events, diag: (e: DiagEvent) => events.push(e) };
};

describe("shopLevelGateOff", () => {
  it("reports the first failing per-shop lever", () => {
    expect(shopLevelGateOff(settings())).toBe(null);
    expect(shopLevelGateOff(settings({ autoMergeEnabled: false }))).toBe("auto-merge");
    expect(shopLevelGateOff(settings({ onboardingCompletedAt: null }))).toBe("onboarding");
    expect(shopLevelGateOff(settings({ mergeWindowHours: 12 }))).toBe("window-unsupported");
  });
});

describe("enforceShopShutdown", () => {
  it("does nothing when the flag is off or every lever holds — zero shutdown calls", async () => {
    let calls = 0;
    const shutdown = async () => {
      calls += 1;
      return { status: "EXPIRED" };
    };
    expect(
      await enforceShopShutdown({
        shop: SHOP,
        admin: {} as any,
        getSettings: async () => settings({ checkoutDiscountEnabled: false, autoMergeEnabled: false }),
        shutdown,
      }),
    ).toEqual({ action: "none" });
    expect(
      await enforceShopShutdown({
        shop: SHOP,
        admin: {} as any,
        getSettings: async () => settings(),
        shutdown,
      }),
    ).toEqual({ action: "none" });
    expect(calls).toBe(0);
  });

  it("deactivates ONLY the recorded node id when a lever fails", async () => {
    const seen: string[] = [];
    const r = await enforceShopShutdown({
      shop: SHOP,
      admin: {} as any,
      getSettings: async () => settings({ autoMergeEnabled: false }),
      shutdown: async ({ discountId }) => {
        seen.push(discountId);
        return { status: "EXPIRED" };
      },
    });
    expect(r).toEqual({ action: "shutdown", status: "EXPIRED" });
    expect(seen).toEqual([DID]);
  });

  it("a lower-than-24h merge window triggers the same shutdown", async () => {
    const seen: string[] = [];
    await enforceShopShutdown({
      shop: SHOP,
      admin: {} as any,
      getSettings: async () => settings({ mergeWindowHours: 6 }),
      shutdown: async ({ discountId }) => {
        seen.push(discountId);
        return { status: "EXPIRED" };
      },
    });
    expect(seen).toEqual([DID]);
  });

  it("NO_DISCOUNT_ID => explicit failed result + FAILED diag, flags untouched", async () => {
    const { events, diag } = diags();
    let calls = 0;
    const r = await enforceShopShutdown({
      shop: SHOP,
      admin: {} as any,
      getSettings: async () => settings({ autoMergeEnabled: false, checkoutDiscountNodeId: null }),
      shutdown: async () => {
        calls += 1;
        return { status: "EXPIRED" };
      },
      diag,
    });
    expect(r).toEqual({ action: "failed", code: "NO_DISCOUNT_ID" });
    expect(calls).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "FAILED", code: "NO_DISCOUNT_ID", shop: SHOP });
  });

  it("a throwing shutdown => failed result + FAILED diag — never rethrows", async () => {
    const { events, diag } = diags();
    const r = await enforceShopShutdown({
      shop: SHOP,
      admin: {} as any,
      getSettings: async () => settings({ autoMergeEnabled: false }),
      shutdown: async () => {
        throw new Error("sensitive customer data must not leak");
      },
      diag,
    });
    expect(r.action).toBe("failed");
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("FAILED");
    expect(JSON.stringify(events)).not.toContain("sensitive");
  });

  it("a settings read failure => failed result, never throws", async () => {
    const { events, diag } = diags();
    const r = await enforceShopShutdown({
      shop: SHOP,
      admin: {} as any,
      getSettings: async () => {
        throw new Error("db down");
      },
      diag,
    });
    expect(r.action).toBe("failed");
    expect(events[0].kind).toBe("FAILED");
  });
});

describe("enforcePendingShutdowns", () => {
  const mkShutdown = () => {
    const calls: { shop: string; discountId: string }[] = [];
    const admin = {} as any;
    const getSettingsFor = (rows: Map<string, MergeSettings>) => async (shop: string) => {
      const s = rows.get(shop);
      if (!s) throw new Error(`no settings for ${shop}`);
      return s;
    };
    return { calls, admin, getSettingsFor };
  };

  it("retries a pending shop until the shutdown verifies; a second merchant is untouched", async () => {
    const pending = settings({ autoMergeEnabled: false });
    const healthy = settings();
    const rows = new Map([
      [SHOP, pending],
      ["other.myshopify.com", { ...healthy, shop: "other.myshopify.com" }],
    ]);
    const { calls, admin, getSettingsFor } = mkShutdown();
    const r = await enforcePendingShutdowns({
      listShops: async () => [...rows.values()],
      adminFactory: async () => admin,
      enforce: async (d) =>
        enforceShopShutdown({
          ...d,
          getSettings: getSettingsFor(rows),
          shutdown: async ({ discountId }) => {
            calls.push({ shop: d.shop, discountId });
            return { status: "EXPIRED" };
          },
        }),
      now: () => new Date(0),
      backoff: new Map<string, number>(),
    });
    // The healthy merchant's discount is never read or mutated.
    expect(calls).toEqual([{ shop: SHOP, discountId: DID }]);
    expect(r.find((x) => x.shop === SHOP)?.result).toEqual({ action: "shutdown", status: "EXPIRED" });
    expect(r.find((x) => x.shop === "other.myshopify.com")).toBeUndefined();
  });

  it("spaces retries after a failed attempt, then retries and flips", async () => {
    const rows = new Map([[SHOP, settings({ autoMergeEnabled: false })]]);
    const { calls, admin, getSettingsFor } = mkShutdown();
    let fail = true;
    let now = 0;
    const backoff = new Map<string, number>();
    const run = () =>
      enforcePendingShutdowns({
        listShops: async () => [...rows.values()],
        adminFactory: async () => admin,
        enforce: async (d) =>
          enforceShopShutdown({
            ...d,
            getSettings: getSettingsFor(rows),
            diag: () => {},
            shutdown: async ({ discountId }) => {
              calls.push({ shop: d.shop, discountId });
              if (fail) throw new Error("transport");
              return { status: "EXPIRED" };
            },
          }),
        now: () => new Date(now),
        minRetryMs: 5 * 60_000,
        backoff,
      });
    // Attempt 1 fails → recorded for spacing.
    let r = await run();
    expect(calls).toHaveLength(1);
    expect(r[0].result.action).toBe("failed");
    // Inside the spacing window → skipped, no Shopify call.
    now += 60_000;
    r = await run();
    expect(calls).toHaveLength(1);
    expect(r[0].result).toEqual({ action: "skipped", code: "BACKOFF" });
    // After the spacing window → retried and verified.
    now += 5 * 60_000;
    fail = false;
    r = await run();
    expect(calls).toHaveLength(2);
    expect(r[0].result).toEqual({ action: "shutdown", status: "EXPIRED" });
  });

  it("a shop with no session is reported and skipped; others still enforced", async () => {
    const rows = new Map([
      [SHOP, settings({ autoMergeEnabled: false })],
      ["gone.myshopify.com", { ...settings({ autoMergeEnabled: false }), shop: "gone.myshopify.com" }],
    ]);
    const { calls, admin, getSettingsFor } = mkShutdown();
    const r = await enforcePendingShutdowns({
      listShops: async () => [...rows.values()],
      adminFactory: async (shop) => (shop === "gone.myshopify.com" ? null : admin),
      enforce: async (d) =>
        enforceShopShutdown({
          ...d,
          getSettings: getSettingsFor(rows),
          shutdown: async ({ discountId }) => {
            calls.push({ shop: d.shop, discountId });
            return { status: "EXPIRED" };
          },
        }),
      now: () => new Date(0),
      backoff: new Map<string, number>(),
    });
    expect(r.find((x) => x.shop === "gone.myshopify.com")?.result).toEqual({
      action: "skipped",
      code: "NO_SESSION",
    });
    expect(calls).toEqual([{ shop: SHOP, discountId: DID }]);
  });

  it("a throwing adminFactory is reported the same way", async () => {
    const rows = new Map([[SHOP, settings({ autoMergeEnabled: false })]]);
    const r = await enforcePendingShutdowns({
      listShops: async () => [...rows.values()],
      adminFactory: async () => {
        throw new Error("session lookup exploded");
      },
      now: () => new Date(0),
      backoff: new Map<string, number>(),
    });
    expect(r[0].result).toEqual({ action: "skipped", code: "NO_SESSION" });
  });

  it("a merchant without checkout enabled causes zero Admin calls", async () => {
    const rows = new Map([[SHOP, settings({ checkoutDiscountEnabled: false })]]);
    let factoryCalls = 0;
    const r = await enforcePendingShutdowns({
      // The durable marker is checkoutDiscountEnabled=true — a disabled shop
      // is not even listed.
      listShops: async () => [...rows.values()].filter((s) => s.checkoutDiscountEnabled),
      adminFactory: async () => {
        factoryCalls += 1;
        return {} as any;
      },
      now: () => new Date(0),
      backoff: new Map<string, number>(),
    });
    expect(r).toHaveLength(0);
    expect(factoryCalls).toBe(0);
  });

  it("a re-enabled lever before verification stops the pending work", async () => {
    // Merchant turned merging OFF (pending) then back ON before the sweep:
    // no lever fails → nothing is touched.
    const rows = new Map([[SHOP, settings()]]);
    let calls = 0;
    const r = await enforcePendingShutdowns({
      listShops: async () => [...rows.values()],
      adminFactory: async () => ({} as any),
      enforce: async () => {
        calls += 1;
        return { action: "shutdown", status: "EXPIRED" };
      },
      now: () => new Date(0),
      backoff: new Map<string, number>(),
    });
    expect(r).toHaveLength(0);
    expect(calls).toBe(0);
  });

  it("never mutates an unrelated discount id — only the recorded one is passed", async () => {
    const rows = new Map([[SHOP, settings({ autoMergeEnabled: false })]]);
    const { calls, admin, getSettingsFor } = mkShutdown();
    await enforcePendingShutdowns({
      listShops: async () => [...rows.values()],
      adminFactory: async () => admin,
      enforce: async (d) =>
        enforceShopShutdown({
          ...d,
          getSettings: getSettingsFor(rows),
          shutdown: async ({ discountId }) => {
            calls.push({ shop: d.shop, discountId });
            return { status: "EXPIRED" };
          },
        }),
      now: () => new Date(0),
      backoff: new Map<string, number>(),
    });
    expect(calls.map((c) => c.discountId)).not.toContain(OTHER);
    expect(calls).toEqual([{ shop: SHOP, discountId: DID }]);
  });
});
