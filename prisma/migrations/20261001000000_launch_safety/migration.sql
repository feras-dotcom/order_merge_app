-- New shops must opt in to automatic merging. Existing Settings rows were
-- written by an explicit save, so their current value is kept.
ALTER TABLE "Settings" ALTER COLUMN "autoMergeEnabled" SET DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "autoMergeAcknowledgedAt" TIMESTAMP(3);

-- Write-ahead journal for interrupted/partial merges.
CREATE TABLE "MergeOperation" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "primaryOrderId" TEXT NOT NULL,
    "primaryOrderName" TEXT NOT NULL,
    "customerId" TEXT,
    "primaryLineItemCountBefore" INTEGER NOT NULL,
    "addedLineItemCount" INTEGER NOT NULL,
    "secondaries" JSONB NOT NULL,
    "involvedOrderIds" TEXT[],
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MergeOperation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MergeOperation_shop_status_idx" ON "MergeOperation"("shop", "status");
