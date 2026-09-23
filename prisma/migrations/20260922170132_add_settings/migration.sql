-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "autoMergeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "mergeWindowHours" INTEGER NOT NULL DEFAULT 24,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Settings_shop_key" ON "Settings"("shop");
