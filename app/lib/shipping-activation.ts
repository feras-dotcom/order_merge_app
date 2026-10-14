/**
 * Shipping v0 activation gating — pure predicate, no I/O.
 *
 * A ShippingAdjustment intent may only be created for a combine whose
 * MergeOperation was created ON/AFTER the merchant's current
 * shippingAdjustmentEnabledAt epoch, while the shop is inside the shipping
 * rollout allowlist AND the shipping kill switch is ON.
 *
 * CRITICAL SEMANTICS DIFFERENCE vs the merge controls:
 *   AppControl.allowShops          — empty means ALL shops.
 *   AppControl.shippingAllowShops  — empty means NO shops.
 * The rollout allowlist starts empty; turning the switch on with an empty
 * list activates shipping for nobody.
 *
 * Epoch semantics: enabling stamps the epoch (DB wall clock); disabling clears
 * it; re-enabling stamps a NEW epoch. Combines that finished before the current
 * epoch can never produce intents, so a shop newly allowlisted or a merchant
 * newly opted in can never retroactively refund historical combines.
 */
export interface ShippingActivationInput {
  /** AppControl.shippingAdjustmentsEnabled — the shipping kill switch. */
  shippingAdjustmentsEnabled: boolean;
  /** AppControl.shippingAllowShops — empty means NO shops (inverted). */
  shippingAllowShops: string[];
  /** The shop being evaluated. */
  shop: string;
  /** Settings.shippingAdjustmentEnabled — merchant opt-in. */
  shopEnabled: boolean;
  /** Settings.shippingAdjustmentEnabledAt — the activation epoch. */
  enabledAt: Date | null;
  /** MergeOperation.createdAt of the candidate combine. */
  operationCreatedAt: Date;
}

const validDate = (d: unknown): d is Date =>
  d instanceof Date && !Number.isNaN(d.getTime());

export function isShippingIntentAllowed(input: ShippingActivationInput): boolean {
  if (input.shippingAdjustmentsEnabled !== true) return false;
  if (!Array.isArray(input.shippingAllowShops) || !input.shippingAllowShops.includes(input.shop)) {
    return false;
  }
  if (input.shopEnabled !== true) return false;
  if (!validDate(input.enabledAt) || !validDate(input.operationCreatedAt)) return false;
  return input.operationCreatedAt.getTime() >= input.enabledAt.getTime();
}
