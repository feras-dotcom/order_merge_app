-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "checkoutDiscountWindowHours" INTEGER;

-- AlterTable
ALTER TABLE "CheckoutEligibilityWork" ADD COLUMN "grantConsumedAt" TIMESTAMP(3);
