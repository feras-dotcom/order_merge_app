// The checkout-discount gate (D2): EVERY lever must hold before a work item
// may read or write anything. Checked at the webhook (cheap pre-check that
// skips the durable row) and again inside the processor (authoritative —
// levers can flip between delivery and processing). Any read failure means
// OFF: a gate that cannot prove itself never opens.
import { isOnboardingComplete } from "../onboarding";
import { getSettings, type MergeSettings } from "../settings.server";
import { prismaOperationStore } from "../operation-store.server";

export interface CheckoutGateDeps {
  env: (name: string) => string | undefined;
  settings: (shop: string) => Promise<MergeSettings>;
  control: () => Promise<{
    checkoutDiscountEnabled?: boolean;
    checkoutDiscountAllowShops?: string[];
  } | null>;
}

const defaultDeps = (): CheckoutGateDeps => ({
  env: (n) => process.env[n],
  settings: getSettings,
  control: () => prismaOperationStore.getControl(),
});

export async function checkoutDiscountGate(
  shop: string,
  deps: Partial<CheckoutGateDeps> = {},
): Promise<
  | { on: true; enabledAt: Date; mergeWindowHours: number }
  | { on: false; reason: string }
> {
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
    return {
      on: true,
      enabledAt:
        settings.checkoutDiscountEnabledAt instanceof Date
          ? settings.checkoutDiscountEnabledAt
          : new Date(settings.checkoutDiscountEnabledAt),
      mergeWindowHours: settings.mergeWindowHours,
    };
  } catch {
    return { on: false, reason: "read-error" };
  }
}
