-- Checkout-first shipping discount foundation (additive only; every gate is
-- OFF by default and no webhook subscription exists yet, so the whole path is
-- inert until deliberately enabled):
-- Settings gains the merchant opt-in flag and its enable-epoch (stamped on
-- the DB wall clock only by setCheckoutDiscountEnabled, so enabling can never
-- qualify orders created before opt-in). AppControl gains a SEPARATE
-- checkout kill switch and rollout allowlist — NOTE the inverted semantics:
-- empty checkoutDiscountAllowShops means NO shops (unlike allowShops, where
-- empty means all shops).
-- CheckoutEligibilityWork is the level-triggered work queue for the
-- orders/paid, orders/cancelled, orders/fulfilled and
-- orders/partially_fulfilled webhooks: a delivery only marks the order dirty
-- (gen = gen + 1, status = PENDING) and the processor reconciles the desired
-- projection state from fresh Admin data. Unique (shop, orderId) deduplicates
-- deliveries; `gen` fences completion so a newer event that arrived
-- mid-processing re-queues instead of being lost. Only shop, order GID and
-- outcome codes — no PII columns. A status CHECK keeps raw-SQL writers fail
-- closed. updatedAt carries a DEFAULT so raw-SQL inserts never need to supply
-- it (the codebase's convention).

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "checkoutDiscountEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "checkoutDiscountEnabledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AppControl" ADD COLUMN     "checkoutDiscountEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "checkoutDiscountAllowShops" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "CheckoutEligibilityWork" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "gen" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "retryAfter" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leasedUntil" TIMESTAMP(3),
    "outcome" TEXT,
    "lastReason" TEXT,
    "deadlineAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckoutEligibilityWork_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CheckoutEligibilityWork_status_check" CHECK ("status" IN (
      'PENDING', 'DONE', 'REVIEW'))
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutEligibilityWork_shop_orderId_key" ON "CheckoutEligibilityWork"("shop", "orderId");

-- CreateIndex
CREATE INDEX "CheckoutEligibilityWork_status_retryAfter_idx" ON "CheckoutEligibilityWork"("status", "retryAfter");
