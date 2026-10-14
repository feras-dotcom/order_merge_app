import type { PrismaClient } from "@prisma/client";
import db from "../db.server";
import { DB_WALL } from "./ownership.server";

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
  /** Shipping v0 foundation only: no execution path is implemented. */
  shippingAdjustmentEnabled: boolean;
  /** Activation epoch: writable ONLY via setShippingAdjustmentEnabled — it is
   *  stamped on enable and cleared on disable, so a plain settings write can
   *  never retroactively qualify historical combines for refunds. */
  shippingAdjustmentEnabledAt: Date | null;
  shippingPolicy: string;
  shippingRetainedMinor: string | null;
  shippingRetainedCurrency: string | null;
}

export const DEFAULT_SETTINGS: MergeSettings = {
  autoMergeEnabled: false,
  mergeWindowHours: 24,
  shippingCostSavings: 8.5,
  shopifyShopGid: null,
  autoMergeAcknowledgedAt: null,
  onboardingStartedAt: null,
  onboardingCompletedAt: null,
  shippingAdjustmentEnabled: false,
  shippingAdjustmentEnabledAt: null,
  shippingPolicy: "REFUND_ALL",
  shippingRetainedMinor: null,
  shippingRetainedCurrency: null,
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
 * Shipping opt-in fields are excluded at the type level — they can only be
 * written through setShippingAdjustmentEnabled, which manages the epoch.
 */
export async function upsertSettings(
  shop: string,
  update: Partial<
    Omit<MergeSettings, "shippingAdjustmentEnabled" | "shippingAdjustmentEnabledAt">
  >,
): Promise<MergeSettings> {
  return db.settings.upsert({
    where: { shop },
    create: { shop, ...DEFAULT_SETTINGS, ...update },
    update,
  });
}

/**
 * The ONLY write path for Settings.shippingAdjustmentEnabled / the enable
 * epoch. Single-statement upsert on the DB wall clock (naive UTC, matching the
 * TIMESTAMP(3) columns): enabling stamps a fresh epoch on a false→true
 * transition (idempotent while already enabled), disabling clears it. A new
 * epoch means combines completed earlier can never produce refund intents.
 */
export async function setShippingAdjustmentEnabled(
  shop: string,
  enabled: boolean,
  client: PrismaClient = db,
): Promise<void> {
  await client.$executeRaw`
    INSERT INTO "Settings" ("id", "shop", "shippingAdjustmentEnabled", "shippingAdjustmentEnabledAt")
    VALUES (${crypto.randomUUID()}, ${shop}, ${enabled},
      CASE WHEN ${enabled} THEN ${DB_WALL} ELSE NULL END)
    ON CONFLICT ("shop") DO UPDATE SET
      "shippingAdjustmentEnabled" = EXCLUDED."shippingAdjustmentEnabled",
      "shippingAdjustmentEnabledAt" = CASE
        WHEN NOT EXCLUDED."shippingAdjustmentEnabled" THEN NULL
        WHEN "Settings"."shippingAdjustmentEnabled" THEN "Settings"."shippingAdjustmentEnabledAt"
        ELSE ${DB_WALL}
      END`;
}

/**
 * Uninstall reset: a reinstall is a new install — automation, onboarding and
 * the shipping opt-in (including its epoch) must not silently resume. The
 * merge window and combine history are kept.
 */
export async function resetAutomationForUninstall(
  shop: string,
  client: Pick<PrismaClient, "settings"> = db,
): Promise<void> {
  await client.settings.updateMany({
    where: { shop },
    data: {
      autoMergeEnabled: false,
      onboardingStartedAt: null,
      onboardingCompletedAt: null,
      shippingAdjustmentEnabled: false,
      shippingAdjustmentEnabledAt: null,
    },
  });
}
