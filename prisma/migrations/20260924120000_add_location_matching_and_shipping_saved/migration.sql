-- Adds the location-matching merchant toggle and per-record savings tracking.
-- locationMatchEnabled defaults to true so existing merchants keep the
-- safer same-warehouse behavior.
-- shippingSavedAmount defaults to 0; new successful merges will populate it
-- from the merchant's configured shipping cost savings.
ALTER TABLE "Settings" ADD COLUMN "locationMatchEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "MergeRecord" ADD COLUMN "shippingSavedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
