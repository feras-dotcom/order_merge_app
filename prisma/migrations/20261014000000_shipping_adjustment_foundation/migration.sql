-- Shipping v0 foundation (additive only, no execution path yet):
-- Settings gains the merchant opt-in flag, its enable-epoch (so enabling can
-- never refund combines completed before opt-in) and the policy snapshot
-- inputs. ShippingAdjustment is the immutable intent record the future worker
-- will write ahead of any Shopify refund call: (shop, sourceOrderId) is
-- unique so an intent exists at most once per source, and idempotencyKey is
-- unique so a dispatched refund can never be duplicated. All amounts are
-- exact minor-unit integers stored as TEXT; no Float columns.
-- No refund worker, Shopify mutation or automatic recovery exists yet, so
-- these columns and this table stay inert until the verified implementation
-- lands.

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "shippingAdjustmentEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shippingAdjustmentEnabledAt" TIMESTAMP(3),
ADD COLUMN     "shippingPolicy" TEXT NOT NULL DEFAULT 'REFUND_ALL',
ADD COLUMN     "shippingRetainedCurrency" TEXT,
ADD COLUMN     "shippingRetainedMinor" TEXT;

-- CreateTable
CREATE TABLE "ShippingAdjustment" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "mergeOperationId" TEXT NOT NULL,
    "sourceOrderId" TEXT NOT NULL,
    "policyKind" TEXT NOT NULL,
    "policyRetainedMinor" TEXT,
    "policyCurrencyCode" TEXT,
    "sourceShippingMinor" TEXT,
    "plannedRefundMinor" TEXT,
    "currencyCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "refundId" TEXT,
    "attemptRecordedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "reviewReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShippingAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShippingAdjustment_idempotencyKey_key" ON "ShippingAdjustment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ShippingAdjustment_status_createdAt_idx" ON "ShippingAdjustment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ShippingAdjustment_mergeOperationId_idx" ON "ShippingAdjustment"("mergeOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "ShippingAdjustment_shop_sourceOrderId_key" ON "ShippingAdjustment"("shop", "sourceOrderId");
