// The checkout-discount gate (D2): EVERY lever must hold before a work item
// may read or write anything. Checked at the webhook (cheap pre-check that
// skips the durable row) and again inside the processor (authoritative —
// levers can flip between delivery and processing).
//
// A CONFIRMED off (env unset, control off, allowlist, shop flag, auto-merge,
// onboarding, unsupported window) is a durable answer: nothing is written
// and no Admin call is made. A DEPENDENCY READ ERROR is different — it is
// reported as { on:false, reason:"read-error", unknown:true }: the gate
// cannot prove itself, so callers answer 500 / retry instead of treating
// the outage as a decision.
import { isOnboardingComplete } from "../onboarding";
import { getSettings, type MergeSettings } from "../settings.server";
import { prismaOperationStore } from "../operation-store.server";
import { MIN_CHECKOUT_WINDOW_HOURS, checkoutDiscountWindowId } from "./config";

export interface CheckoutGateDeps {
  env: (name: string) => string | undefined;
  settings: (shop: string) => Promise<MergeSettings>;
  control: () => Promise<{
    checkoutDiscountEnabled?: boolean;
    checkoutDiscountAllowShops?: string[];
  } | null>;
}

export type CheckoutGateResult =
  | { on: true; enabledAt: Date; mergeWindowHours: number; windowId: string }
  | { on: false; reason: string; unknown?: true };

const defaultDeps = (): CheckoutGateDeps => ({
  env: (n) => process.env[n],
  settings: getSettings,
  control: () => prismaOperationStore.getControl(),
});

export async function checkoutDiscountGate(
  shop: string,
  deps: Partial<CheckoutGateDeps> = {},
): Promise<CheckoutGateResult> {
  const d = { ...defaultDeps(), ...deps };
  try {
    if (d.env("MERGESHIP_CHECKOUT_DISCOUNT") !== "enabled") {
      return { on: false, reason: "env" };
    }
    const control = await d.control();
    if (!control?.checkoutDiscountEnabled) return { on: false, reason: "control" };
    // INVERTED allowlist: empty means NO shops.
    if (!(control.checkoutDiscountAllowShops ?? []).includes(shop)) {
      return { on: false, reason: "allowlist" };
    }
    const settings = await d.settings(shop);
    if (!settings.checkoutDiscountEnabled || settings.checkoutDiscountEnabledAt == null) {
      return { on: false, reason: "shop" };
    }
    if (!settings.autoMergeEnabled) return { on: false, reason: "auto-merge" };
    if (!isOnboardingComplete(settings)) return { on: false, reason: "onboarding" };
    // A merge window shorter than a full shop-local day can never carry an
    // eligibility record (expiryDateFor has no day to return): the feature
    // is disabled for 1/6/12 h windows rather than silently never issuing.
    if (settings.mergeWindowHours < MIN_CHECKOUT_WINDOW_HOURS) {
      return { on: false, reason: "window-unsupported" };
    }
    const enabledAt =
      settings.checkoutDiscountEnabledAt instanceof Date
        ? settings.checkoutDiscountEnabledAt
        : new Date(settings.checkoutDiscountEnabledAt);
    return {
      on: true,
      enabledAt,
      mergeWindowHours: settings.mergeWindowHours,
      windowId: checkoutDiscountWindowId(enabledAt),
    };
  } catch {
    return { on: false, reason: "read-error", unknown: true };
  }
}
