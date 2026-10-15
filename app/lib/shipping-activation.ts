/**
 * Shipping v0 activation gating — pure predicate, no I/O.
 *
 * A ShippingAdjustment intent may only be created for a combine whose
 * MergeOperation was created ON/AFTER the effective activation cutoff, which
 * is the LATEST of three independent activation epochs:
 *
 *   1. merchantEpoch — Settings.shippingAdjustmentEnabledAt, stamped on the
 *      DB wall clock when the merchant opts in, cleared on opt-out/uninstall.
 *   2. rolloutEpoch — Settings.shippingRolloutAt, stamped on the DB wall
 *      clock when the shop is ADDED to AppControl.shippingAllowShops,
 *      cleared when removed. Re-adding stamps a NEW epoch.
 *   3. switchEpoch — AppControl.shippingEnabledAt, stamped on the DB wall
 *      clock on a false→true transition of shippingAdjustmentsEnabled,
 *      cleared on disable.
 *
 * ALL THREE must be active and stamped. Any one missing/inactive means no
 * shipping intent may exist for the shop — so a combine that completed while
 * the shop was outside the rollout, or while the kill switch was off, can
 * never become eligible retroactively.
 *
 * CRITICAL SEMANTICS DIFFERENCE vs the merge controls:
 *   AppControl.allowShops          — empty means ALL shops.
 *   AppControl.shippingAllowShops  — empty means NO shops.
 */
export interface ShippingActivationInput {
  /** AppControl.shippingAdjustmentsEnabled — the shipping kill switch. */
  shippingAdjustmentsEnabled: boolean;
  /** AppControl.shippingEnabledAt — kill-switch epoch. */
  shippingEnabledAt: Date | null;
  /** AppControl.shippingAllowShops — empty means NO shops (inverted). */
  shippingAllowShops: string[];
  /** The shop being evaluated. */
  shop: string;
  /** Settings.shippingRolloutAt — rollout-membership epoch for this shop. */
  shippingRolloutAt: Date | null;
  /** Settings.shippingAdjustmentEnabled — merchant opt-in. */
  shopEnabled: boolean;
  /** Settings.shippingAdjustmentEnabledAt — merchant opt-in epoch. */
  enabledAt: Date | null;
}

const validDate = (d: unknown): d is Date =>
  d instanceof Date && !Number.isNaN(d.getTime());

/**
 * The effective activation cutoff for a shop, or null when any prerequisite
 * is inactive. A ShippingAdjustment may exist only for combines created on
 * or after this instant. Because the cutoff is recomputed from CURRENT
 * control state, toggling any control forward in time invalidates intents
 * snapshotted under an older cutoff.
 */
export function shippingActivationCutoff(input: ShippingActivationInput): Date | null {
  if (input.shippingAdjustmentsEnabled !== true) return null;
  if (!validDate(input.shippingEnabledAt)) return null;
  if (!Array.isArray(input.shippingAllowShops) || !input.shippingAllowShops.includes(input.shop)) {
    return null;
  }
  if (!validDate(input.shippingRolloutAt)) return null;
  if (input.shopEnabled !== true) return null;
  if (!validDate(input.enabledAt)) return null;
  return new Date(
    Math.max(
      input.enabledAt.getTime(),
      input.shippingRolloutAt.getTime(),
      input.shippingEnabledAt.getTime(),
    ),
  );
}

/** Eligibility predicate: combine created on/after the live cutoff. */
export function isShippingIntentAllowed(
  input: ShippingActivationInput & { operationCreatedAt: Date },
): boolean {
  const cutoff = shippingActivationCutoff(input);
  return (
    cutoff !== null &&
    validDate(input.operationCreatedAt) &&
    input.operationCreatedAt.getTime() >= cutoff.getTime()
  );
}
