-- AddColumn: shippingCostSavings to Settings
-- Adds the per-shop configurable shipping label savings amount.
-- Default of 8.5 matches the application default so existing rows
-- automatically get the right value without a data migration.
ALTER TABLE "Settings" ADD COLUMN "shippingCostSavings" DOUBLE PRECISION NOT NULL DEFAULT 8.5;
