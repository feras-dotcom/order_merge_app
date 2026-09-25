import db from "../db.server";

// ── Merge settings ────────────────────────────────────────────────────────────

export interface MergeSettings {
  autoMergeEnabled: boolean;
  mergeWindowHours: number;
  shippingCostSavings: number;
  locationMatchEnabled: boolean;
}

export const DEFAULT_SETTINGS: MergeSettings = {
  autoMergeEnabled: true,
  mergeWindowHours: 24,
  shippingCostSavings: 8.5,
  locationMatchEnabled: true,
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
