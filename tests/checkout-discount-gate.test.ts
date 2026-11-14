// The checkout-discount gate (D2): six independent levers, all default OFF,
// any read failure fails closed. Plus the AppControl write path and the
// Settings epoch semantics of setCheckoutDiscountEnabled (SQL-shape
// assertions offline; the real epoch behavior runs in
// checkout-discount-work-pg.test.ts on the disposable database).
import { describe, expect, it } from "vitest";
import { checkoutDiscountGate, type CheckoutGateDeps } from "../app/lib/checkout-discount/gate.server";
import { setCheckoutDiscountEnabled, DEFAULT_SETTINGS, type MergeSettings } from "../app/lib/settings.server";
import type { ControlRow } from "../app/lib/operation-store.server";

const SHOP = "shop.myshopify.com";
const EPOCH = new Date("2026-11-01T00:00:00Z");

const onSettings = (over: Partial<MergeSettings> = {}): MergeSettings => ({
  ...DEFAULT_SETTINGS,
  autoMergeEnabled: true,
  onboardingCompletedAt: EPOCH,
  checkoutDiscountEnabled: true,
  checkoutDiscountEnabledAt: EPOCH,
  ...over,
});
const onControl = (over: Partial<ControlRow> = {}): ControlRow => ({
  id: "control",
  newMergesEnabled: true,
  completionEnabled: true,
  allowShops: [],
  shippingAdjustmentsEnabled: false,
  shippingAllowShops: [],
  shippingEnabledAt: null,
  checkoutDiscountEnabled: true,
  checkoutDiscountAllowShops: [SHOP],
  note: null,
  ...over,
});

const deps = (over: Partial<CheckoutGateDeps> = {}): CheckoutGateDeps => ({
  env: (n) => (n === "MERGESHIP_CHECKOUT_DISCOUNT" ? "enabled" : undefined),
  settings: async () => onSettings(),
  control: async () => onControl(),
  ...over,
});

describe("checkoutDiscountGate — six independent levers", () => {
  it("all levers on => on, carrying the enable epoch and merge window", async () => {
    const g = await checkoutDiscountGate(SHOP, deps());
    expect(g).toEqual({ on: true, enabledAt: EPOCH, mergeWindowHours: 24 });
  });

  it("env lever off (default) => off", async () => {
    const g = await checkoutDiscountGate(SHOP, deps({ env: () => undefined }));
    expect(g.on).toBe(false);
  });

  it("AppControl kill switch off => off", async () => {
    const g = await checkoutDiscountGate(
      SHOP,
      deps({ control: async () => onControl({ checkoutDiscountEnabled: false }) }),
    );
    expect(g.on).toBe(false);
  });

  it("allowlist is INVERTED: empty means NO shops; unlisted shop => off", async () => {
    expect(
      (await checkoutDiscountGate(SHOP, deps({ control: async () => onControl({ checkoutDiscountAllowShops: [] }) }))).on,
    ).toBe(false);
    expect(
      (await checkoutDiscountGate(SHOP, deps({ control: async () => onControl({ checkoutDiscountAllowShops: ["other.myshopify.com"] }) }))).on,
    ).toBe(false);
    expect(
      (await checkoutDiscountGate("other.myshopify.com", deps({ control: async () => onControl({ checkoutDiscountAllowShops: ["other.myshopify.com"] }) }))).on,
    ).toBe(true);
  });

  it("per-shop settings flag off or epoch missing => off", async () => {
    expect(
      (await checkoutDiscountGate(SHOP, deps({ settings: async () => onSettings({ checkoutDiscountEnabled: false }) }))).on,
    ).toBe(false);
    // Flag on but epoch missing is inconsistent state — still off.
    expect(
      (await checkoutDiscountGate(SHOP, deps({ settings: async () => onSettings({ checkoutDiscountEnabledAt: null }) }))).on,
    ).toBe(false);
  });

  it("autoMergeEnabled off => off (the discount only pays when merge will run)", async () => {
    const g = await checkoutDiscountGate(SHOP, deps({ settings: async () => onSettings({ autoMergeEnabled: false }) }));
    expect(g.on).toBe(false);
  });

  it("onboarding incomplete => off", async () => {
    const g = await checkoutDiscountGate(
      SHOP,
      deps({ settings: async () => onSettings({ onboardingCompletedAt: null }) }),
    );
    expect(g.on).toBe(false);
  });

  it("every read failure fails closed", async () => {
    expect((await checkoutDiscountGate(SHOP, deps({ control: async () => { throw new Error("db down"); } }))).on).toBe(false);
    expect((await checkoutDiscountGate(SHOP, deps({ settings: async () => { throw new Error("db down"); } }))).on).toBe(false);
    expect((await checkoutDiscountGate(SHOP, deps({ control: async () => null }))).on).toBe(false);
  });
});

/** Renders what a template-tagged $executeRaw/$queryRaw call receives:
 *  (strings, ...values) at the call site, with nested Prisma.Sql fragments
 *  ({strings, values}) inlined. Literal values render as "?". */
const renderSql = (v: any): string => {
  if (v == null) return "";
  if (typeof v === "object" && Array.isArray(v.strings)) return tag(v.strings, v.values ?? []);
  return "?";
};
const tag = (strings: any, values: unknown[]): string =>
  Array.isArray(strings)
    ? strings.reduce((acc, s, i) => acc + s + (i < values.length ? renderSql(values[i]) : ""), "")
    : renderSql(strings);

describe("setCheckoutDiscountEnabled — epoch SQL", () => {
  const fakeClient = () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    return {
      calls,
      async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
        calls.push({ sql: tag(strings, values), values });
        return 1;
      },
    };
  };

  it("is a single upsert that stamps the epoch on the DB wall clock only on false→true", async () => {
    const c = fakeClient();
    await setCheckoutDiscountEnabled(SHOP, true, c as any);
    expect(c.calls.length).toBe(1);
    const sql = c.calls[0].sql;
    expect(sql).toContain("checkoutDiscountEnabledAt");
    expect(sql).toContain("ON CONFLICT");
    // The epoch comes from the DB wall clock (never a JS Date bind).
    expect(sql).toContain("clock_timestamp()");
    // Enable: fresh epoch stamped on insert AND on a disabled row's flip —
    // kept while already enabled.
    expect(sql).toMatch(/WHEN\s+"Settings"\."checkoutDiscountEnabled"\s+THEN\s+"Settings"\."checkoutDiscountEnabledAt"/);
    expect(c.calls[0].values).toContain(SHOP);
    expect(c.calls[0].values).toContain(true);
  });

  it("disable writes enabled=false and clears the epoch (CASE returns NULL)", async () => {
    const c = fakeClient();
    await setCheckoutDiscountEnabled(SHOP, false, c as any);
    const sql = c.calls[0].sql;
    expect(sql).toMatch(/WHEN NOT EXCLUDED\."checkoutDiscountEnabled" THEN NULL/);
    expect(c.calls[0].values).toContain(false);
  });
});

describe("AppControl write path (operator surface)", () => {
  it("setControl writes the checkout columns inside the locked transaction", async () => {
    const updates: string[] = [];
    const fakeTx = {
      async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
        if (tag(strings, values).includes('FROM "AppControl"')) {
          return [{ shippingAdjustmentsEnabled: false, shippingAllowShops: [] }];
        }
        return [];
      },
      async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
        updates.push(tag(strings, values));
        return 1;
      },
      async $executeRawUnsafe() {
        return 0;
      },
      async $queryRawUnsafe() {
        return [];
      },
    };
    const fakeDb = {
      async $transaction(fn: any) {
        return fn(fakeTx);
      },
    };
    const { makeOperationStore } = await import("../app/lib/operation-store.server");
    const ops = makeOperationStore(fakeDb as any);
    await ops.setControl({
      checkoutDiscountEnabled: true,
      checkoutDiscountAllowShops: [SHOP],
    });
    const set = updates.join(" ");
    expect(set).toContain('"checkoutDiscountEnabled"');
    expect(set).toContain('"checkoutDiscountAllowShops"');
    expect(set).toContain('UPDATE "AppControl"');
  });
});
