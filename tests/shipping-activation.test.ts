import { describe, expect, it } from "vitest";
import {
  isShippingIntentAllowed,
  shippingActivationCutoff,
  type ShippingActivationInput,
} from "../app/lib/shipping-activation";

const SHOP = "merchant.myshopify.com";
const EPOCH = new Date("2026-10-14T12:00:00Z");

const input = (
  o: Partial<ShippingActivationInput> & { operationCreatedAt?: Date } = {},
): ShippingActivationInput & { operationCreatedAt: Date } => ({
  shippingAdjustmentsEnabled: true,
  shippingEnabledAt: EPOCH,
  shippingAllowShops: [SHOP],
  shop: SHOP,
  shippingRolloutAt: EPOCH,
  shopEnabled: true,
  enabledAt: EPOCH,
  operationCreatedAt: new Date("2026-10-14T13:00:00Z"), // after all epochs
  ...o,
});

describe("Shipping v0 activation gating (three-epoch cutoff + inverted allowlist)", () => {
  it("allows an intent only when every gate is satisfied", () => {
    expect(isShippingIntentAllowed(input())).toBe(true);
  });
  it("shipping kill switch OFF blocks everything", () => {
    expect(isShippingIntentAllowed(input({ shippingAdjustmentsEnabled: false }))).toBe(false);
  });
  it("a missing kill-switch epoch blocks even when the flag is on", () => {
    expect(isShippingIntentAllowed(input({ shippingEnabledAt: null }))).toBe(false);
  });
  it("EMPTY shippingAllowShops means NO shops — inverted vs merge allowlist", () => {
    expect(isShippingIntentAllowed(input({ shippingAllowShops: [] }))).toBe(false);
  });
  it("a shop outside the rollout allowlist is excluded", () => {
    expect(isShippingIntentAllowed(input({ shippingAllowShops: ["other.myshopify.com"] }))).toBe(false);
  });
  it("a missing rollout epoch blocks even when the shop is listed", () => {
    expect(isShippingIntentAllowed(input({ shippingRolloutAt: null }))).toBe(false);
  });
  it("merchant opt-in OFF blocks intents", () => {
    expect(isShippingIntentAllowed(input({ shopEnabled: false }))).toBe(false);
  });
  it("a missing merchant epoch blocks intents even when the flag is on", () => {
    expect(isShippingIntentAllowed(input({ enabledAt: null }))).toBe(false);
  });
  it("activation-epoch cutoff: combines created BEFORE the epoch never qualify", () => {
    expect(isShippingIntentAllowed(input({
      operationCreatedAt: new Date("2026-10-14T11:59:59.999Z"),
    }))).toBe(false);
  });
  it("a combine created exactly AT the cutoff qualifies", () => {
    expect(isShippingIntentAllowed(input({ operationCreatedAt: EPOCH }))).toBe(true);
  });
  it("the cutoff is the LATEST of the three epochs", () => {
    const t1 = new Date("2026-10-14T10:00:00Z"); // kill switch on
    const t2 = new Date("2026-10-14T11:00:00Z"); // merchant opt-in
    const t3 = new Date("2026-10-14T12:00:00Z"); // shop allowlisted last
    const cutoff = shippingActivationCutoff(
      input({ shippingEnabledAt: t1, enabledAt: t2, shippingRolloutAt: t3 }),
    );
    expect(cutoff?.getTime()).toBe(t3.getTime());
    // A combine created while the shop was opted-in but not yet allowlisted
    // (between t2 and t3) must never qualify — B1.
    expect(
      isShippingIntentAllowed(
        input({
          shippingEnabledAt: t1,
          enabledAt: t2,
          shippingRolloutAt: t3,
          operationCreatedAt: new Date("2026-10-14T11:30:00Z"),
        }),
      ),
    ).toBe(false);
    expect(
      isShippingIntentAllowed(
        input({
          shippingEnabledAt: t1,
          enabledAt: t2,
          shippingRolloutAt: t3,
          operationCreatedAt: new Date("2026-10-14T12:00:00Z"),
        }),
      ),
    ).toBe(true);
  });
  it("a combine created while the kill switch was off never qualifies after it is re-enabled", () => {
    const t1 = new Date("2026-10-14T10:00:00Z"); // merchant + rollout active
    const t2 = new Date("2026-10-14T14:00:00Z"); // kill switch re-enabled late
    expect(
      isShippingIntentAllowed(
        input({
          shippingEnabledAt: t2,
          enabledAt: t1,
          shippingRolloutAt: t1,
          operationCreatedAt: new Date("2026-10-14T13:00:00Z"), // during the off gap
        }),
      ),
    ).toBe(false);
  });
  it("removal + re-add stamps a fresh rollout epoch that excludes gap combines", () => {
    const t1 = new Date("2026-10-14T10:00:00Z");
    const t3 = new Date("2026-10-14T15:00:00Z"); // re-added late
    expect(
      isShippingIntentAllowed(
        input({
          shippingRolloutAt: t3,
          enabledAt: t1,
          shippingEnabledAt: t1,
          operationCreatedAt: new Date("2026-10-14T12:00:00Z"), // while removed
        }),
      ),
    ).toBe(false);
  });
  it("rejects malformed dates rather than guessing", () => {
    expect(isShippingIntentAllowed(input({ enabledAt: new Date("not-a-date") }))).toBe(false);
    expect(isShippingIntentAllowed(input({ shippingRolloutAt: new Date("nope") }))).toBe(false);
    expect(isShippingIntentAllowed(input({ operationCreatedAt: new Date(NaN) }))).toBe(false);
  });
});
