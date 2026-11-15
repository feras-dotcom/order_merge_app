-- Pilot method approval on Settings + durable consumed-record marker on
-- CheckoutEligibilityWork. Additive nullable columns only: rows written by
-- the previous image keep NULLs and old code keeps running on this schema.
ALTER TABLE "Settings" ADD COLUMN "checkoutDiscountMethod" TEXT;
ALTER TABLE "Settings" ADD COLUMN "checkoutDiscountMaxShippingMinor" INTEGER;
ALTER TABLE "Settings" ADD COLUMN "checkoutDiscountCurrency" TEXT;
ALTER TABLE "CheckoutEligibilityWork" ADD COLUMN "consumedRecordId" TEXT;
