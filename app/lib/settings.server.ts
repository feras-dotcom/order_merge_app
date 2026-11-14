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
  /** Rollout-membership epoch — writable ONLY by setControl when the shop is
   *  added to / removed from AppControl.shippingAllowShops. */
  shippingRolloutAt: Date | null;
  /** Checkout-first shipping discount opt-in (checkout-discount/). */
  checkoutDiscountEnabled: boolean;
  /** Enable-epoch: writable ONLY via setCheckoutDiscountEnabled — orders
   *  created before it can never produce eligibility records. */
  checkoutDiscountEnabledAt: Date | null;
  /** The merchant's Shopify automatic discount node id, recorded by
   *  prepare-enable after proving ownership — the only discount the
   *  shutdown enforcer may touch. Writable ONLY via
   *  setCheckoutDiscountNodeId. */
  checkoutDiscountNodeId: string | null;
  /** Window stamp: the highest mergeWindowHours under which eligibility
   *  records may have been issued since the current enable epoch. Stamped
   *  on enable, raised monotonically by
   *  raiseCheckoutDiscountWindowStamp, cleared on disable — lowering the
   *  merge window below it fails the checkout gate and forces a shutdown.
   *  Writable ONLY via the dedicated writers, never upsertSettings. */
  checkoutDiscountWindowHours: number | null;
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
  shippingRolloutAt: null,
  checkoutDiscountEnabled: false,
  checkoutDiscountEnabledAt: null,
  checkoutDiscountNodeId: null,
  checkoutDiscountWindowHours: null,
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
    Omit<
      MergeSettings,
      | "shippingAdjustmentEnabled"
      | "shippingAdjustmentEnabledAt"
      | "shippingRolloutAt"
      | "checkoutDiscountEnabled"
      | "checkoutDiscountEnabledAt"
      | "checkoutDiscountNodeId"
      | "checkoutDiscountWindowHours"
    >
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
 * The ONLY write path for Settings.checkoutDiscountEnabled / the enable
 * epoch. Same semantics as setShippingAdjustmentEnabled: enabling stamps a
 * fresh epoch on a false→true transition (idempotent while already enabled),
 * disabling clears it — orders created before the current epoch can never
 * produce eligibility records.
 */
export async function setCheckoutDiscountEnabled(
  shop: string,
  enabled: boolean,
  client: PrismaClient = db,
): Promise<void> {
  // The window stamp moves with the flag: a false→true transition stamps
  // the mergeWindowHours in force at enable time, enabling again keeps the
  // existing stamp (idempotent while enabled), disabling clears it. The
  // INSERT path stamps 24 — the mergeWindowHours column default.
  await client.$executeRaw`
    INSERT INTO "Settings" ("id", "shop", "checkoutDiscountEnabled", "checkoutDiscountEnabledAt", "checkoutDiscountWindowHours")
    VALUES (${crypto.randomUUID()}, ${shop}, ${enabled},
      CASE WHEN ${enabled} THEN ${DB_WALL} ELSE NULL END,
      CASE WHEN ${enabled} THEN 24 ELSE NULL END)
    ON CONFLICT ("shop") DO UPDATE SET
      "checkoutDiscountEnabled" = EXCLUDED."checkoutDiscountEnabled",
      "checkoutDiscountEnabledAt" = CASE
        WHEN NOT EXCLUDED."checkoutDiscountEnabled" THEN NULL
        WHEN "Settings"."checkoutDiscountEnabled" THEN "Settings"."checkoutDiscountEnabledAt"
        ELSE ${DB_WALL}
      END,
      "checkoutDiscountWindowHours" = CASE
        WHEN NOT EXCLUDED."checkoutDiscountEnabled" THEN NULL
        WHEN "Settings"."checkoutDiscountEnabled" THEN "Settings"."checkoutDiscountWindowHours"
        ELSE "Settings"."mergeWindowHours"
      END`;
}

/**
 * Monotonic raise of the checkout window stamp: called BEFORE the settings
 * save that widens mergeWindowHours, with the NEW window value — the stamp
 * must never sit below a window under which records may have been issued
 * (a missed raise would let a later lowering slip under the stale stamp).
 * GREATEST never lowers it — lowering mergeWindowHours below the stamp is
 * the fail-closed path (gate off + shutdown). Only runs while the checkout
 * discount is enabled and stamped.
 */
export async function raiseCheckoutDiscountWindowStamp(
  shop: string,
  hours: number,
  client: PrismaClient = db,
): Promise<void> {
  await client.$executeRaw`
    UPDATE "Settings"
    SET "checkoutDiscountWindowHours" =
      GREATEST("checkoutDiscountWindowHours", ${hours})
    WHERE "shop" = ${shop}
      AND "checkoutDiscountEnabled"
      AND "checkoutDiscountWindowHours" IS NOT NULL`;
}

/**
 * The ONLY write path for Settings.checkoutDiscountNodeId — recorded by
 * prepare-enable after proving the discount belongs to this app, cleared
 * on uninstall reset. Plain field (no epoch semantics): upserts the row.
 */
export async function setCheckoutDiscountNodeId(
  shop: string,
  id: string | null,
  client: PrismaClient = db,
): Promise<void> {
  await client.settings.upsert({
    where: { shop },
    create: { shop, ...DEFAULT_SETTINGS, checkoutDiscountNodeId: id },
    update: { checkoutDiscountNodeId: id },
  });
}

/**
 * Uninstall reset: a reinstall is a new install — automation, onboarding and
 * the shipping opt-in (including its epoch) must not silently resume. The
 * rollout-membership epoch is cleared too: even if the shop domain is still
 * listed in AppControl.shippingAllowShops, a reinstalled shop has no
 * activation cutoff until the operator re-stamps membership, so stale READY
 * evidence can never become eligible across a reinstall. The merge window
 * and combine history are kept.
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
      shippingRolloutAt: null,
      checkoutDiscountEnabled: false,
      checkoutDiscountEnabledAt: null,
      checkoutDiscountNodeId: null,
      checkoutDiscountWindowHours: null,
    },
  });
}
