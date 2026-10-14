import { describe, expect, it } from "vitest";
import {
  isShippingIntentAllowed,
  type ShippingActivationInput,
} from "../app/lib/shipping-activation";

const SHOP = "merchant.myshopify.com";
const EPOCH = new Date("2026-10-14T12:00:00Z");

const input = (o: Partial<ShippingActivationInput> = {}): ShippingActivationInput => ({
  shippingAdjustmentsEnabled: true,
  shippingAllowShops: [SHOP],
  shop: SHOP,
  shopEnabled: true,
  enabledAt: EPOCH,
  operationCreatedAt: new Date("2026-10-14T13:00:00Z"), // after the epoch
  ...o,
});

describe("Shipping v0 activation gating (epoch + inverted allowlist)", () => {
  it("allows an intent only when every gate is satisfied", () => {
    expect(isShippingIntentAllowed(input())).toBe(true);
  });
  it("shipping kill switch OFF blocks everything", () => {
    expect(isShippingIntentAllowed(input({ shippingAdjustmentsEnabled: false }))).toBe(false);
  });
  it("EMPTY shippingAllowShops means NO shops — inverted vs merge allowlist", () => {
    // Even with the kill switch ON and the merchant opted in, an empty list
    // must not mean 'all shops'.
    expect(isShippingIntentAllowed(input({ shippingAllowShops: [] }))).toBe(false);
  });
  it("a shop outside the rollout allowlist is excluded", () => {
    expect(isShippingIntentAllowed(input({ shippingAllowShops: ["other.myshopify.com"] }))).toBe(false);
  });
  it("merchant opt-in OFF blocks intents", () => {
    expect(isShippingIntentAllowed(input({ shopEnabled: false }))).toBe(false);
  });
  it("a missing epoch blocks intents even when the flag is on", () => {
    expect(isShippingIntentAllowed(input({ enabledAt: null }))).toBe(false);
  });
  it("activation-epoch cutoff: combines created BEFORE the epoch never qualify", () => {
    // This is the no-historical-refunds guarantee: enabling shipping (or a
    // fresh epoch after re-enable) cannot reach back to earlier combines.
    expect(isShippingIntentAllowed(input({
      operationCreatedAt: new Date("2026-10-14T11:59:59.999Z"),
    }))).toBe(false);
  });
  it("a combine created exactly AT the epoch qualifies", () => {
    expect(isShippingIntentAllowed(input({ operationCreatedAt: EPOCH }))).toBe(true);
  });
  it("re-enable produces a new epoch that excludes gap-period combines", () => {
    // Opt-in at T1, opt-out, opt-in at T3 — a combine created at T2 (inside
    // the gap) must not qualify under the T3 epoch.
    const t2 = new Date("2026-10-14T12:30:00Z");
    const t3 = new Date("2026-10-14T14:00:00Z");
    expect(isShippingIntentAllowed(input({ enabledAt: t3, operationCreatedAt: t2 }))).toBe(false);
    expect(isShippingIntentAllowed(input({ enabledAt: t3, operationCreatedAt: new Date("2026-10-14T15:00:00Z") }))).toBe(true);
  });
  it("rejects malformed dates rather than guessing", () => {
    expect(isShippingIntentAllowed(input({ enabledAt: new Date("not-a-date") }))).toBe(false);
    expect(isShippingIntentAllowed(input({ operationCreatedAt: new Date(NaN) }))).toBe(false);
  });
});
