-- ProcessedWebhook becomes the durable orders/create work item. status
-- defaults to 'DONE' so rows inserted by pre-migration code during a deploy
-- overlap stay inert; existing rows are backfilled as LEGACY.
ALTER TABLE "ProcessedWebhook"
    ADD COLUMN "status" TEXT NOT NULL DEFAULT 'DONE',
    ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "retryAfter" TIMESTAMP(3),
    ADD COLUMN "leaseToken" TEXT,
    ADD COLUMN "leasedUntil" TIMESTAMP(3),
    ADD COLUMN "outcome" TEXT,
    ADD COLUMN "lastReason" TEXT,
    ADD COLUMN "deadlineAt" TIMESTAMP(3),
    ADD COLUMN "doneAt" TIMESTAMP(3),
    ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "ProcessedWebhook" SET "outcome" = 'LEGACY', "doneAt" = "createdAt" WHERE "outcome" IS NULL;

CREATE INDEX "ProcessedWebhook_status_retryAfter_idx" ON "ProcessedWebhook"("status", "retryAfter");

-- Per-order merge claim leases (see claims.server.ts).
CREATE TABLE "MergeClaim" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "leaseToken" TEXT NOT NULL,
    "leasedUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MergeClaim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MergeClaim_shop_orderId_key" ON "MergeClaim"("shop", "orderId");
CREATE INDEX "MergeClaim_leasedUntil_idx" ON "MergeClaim"("leasedUntil");

-- Lease the merge operation journal row the same way.
ALTER TABLE "MergeOperation"
    ADD COLUMN "leaseToken" TEXT,
    ADD COLUMN "leasedUntil" TIMESTAMP(3);
