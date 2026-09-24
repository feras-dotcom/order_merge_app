-- CreateTable
CREATE TABLE "MergeRecord" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "primaryOrderId" TEXT NOT NULL,
    "primaryOrderName" TEXT NOT NULL,
    "mergedOrderId" TEXT NOT NULL,
    "mergedOrderName" TEXT NOT NULL,
    "customerId" TEXT,
    "itemsCombined" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MergeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MergeRecord_shop_createdAt_idx" ON "MergeRecord"("shop", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MergeRecord_shop_mergedOrderId_key" ON "MergeRecord"("shop", "mergedOrderId");
