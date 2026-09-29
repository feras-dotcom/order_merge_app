import db from "../db.server";

// ── Merge settings ────────────────────────────────────────────────────────────

export interface MergeSettings {
  /** Off until the merchant explicitly opts in (see app.settings.tsx). */
  autoMergeEnabled: boolean;
  mergeWindowHours: number;
  shippingCostSavings: number;
  /** gid://shopify/Shop/<id> — persisted so the uninstall webhook can act on
   *  the shop after its Admin API token is revoked. Not merchant-facing. */
  shopifyShopGid: string | null;
  autoMergeAcknowledgedAt: Date | null;
  onboardingStartedAt: Date | null;
  onboardingCompletedAt: Date | null;
}

export const DEFAULT_SETTINGS: MergeSettings = {
  autoMergeEnabled: false,
  mergeWindowHours: 24,
  shippingCostSavings: 8.5,
  shopifyShopGid: null,
  autoMergeAcknowledgedAt: null,
  onboardingStartedAt: null,
  onboardingCompletedAt: null,
};

/**
 * Returns the saved settings for a shop, or the defaults if no row exists yet.
 */
export async function getSettings(shop: string): Promise<MergeSettings> {
  const row = await db.settings.findUnique({ where: { shop } });
  return row ?? DEFAULT_SETTINGS;
}

/**
 * Creates or updates the settings row for a shop.
 * Only the fields supplied in `update` are written; all others keep their current value.
 */
export async function upsertSettings(
  shop: string,
  update: Partial<MergeSettings>,
): Promise<MergeSettings> {
  return db.settings.upsert({
    where: { shop },
    create: { shop, ...DEFAULT_SETTINGS, ...update },
    update,
  });
}
