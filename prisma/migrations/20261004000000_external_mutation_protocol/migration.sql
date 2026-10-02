-- MergeShip reliability protocol v2 (never replace, only reconcile):
-- MergeOrderLock rows never expire and are deleted only inside the terminal
-- transition transaction; MergeMutationAttempt is the write-ahead dispatch
-- record so a response-lost mutation is reconciled from evidence instead of
-- retried. All new clock comparisons use (clock_timestamp() AT TIME ZONE 'UTC').

-- MergeOperation: protocol v2 columns. Legacy `status` stays populated for
-- v2 rows ('NEEDS_REVIEW' while non-terminal) so any old-code process still
-- blocks involved orders and never resumes them.
ALTER TABLE "MergeOperation"
    ADD COLUMN "protocolVersion" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "phase" TEXT,
    ADD COLUMN "opToken" TEXT,
    ADD COLUMN "calculatedOrderId" TEXT,
    ADD COLUMN "expectedTransfer" JSONB,
    ADD COLUMN "expectedLocationId" TEXT,
    ADD COLUMN "primaryLineItemIdsBefore" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "appliedEvidence" JSONB,
    ADD COLUMN "firstDispatchAt" TIMESTAMP(3),
    ADD COLUMN "nextCheckAt" TIMESTAMP(3),
    ADD COLUMN "reviewReason" TEXT,
    ADD COLUMN "reviewRequiredAt" TIMESTAMP(3),
    ADD COLUMN "workItemId" TEXT,
    ADD COLUMN "sideEffectsDone" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "MergeOperation_opToken_key" ON "MergeOperation"("opToken");
CREATE INDEX "MergeOperation_protocolVersion_phase_nextCheckAt_idx" ON "MergeOperation"("protocolVersion", "phase", "nextCheckAt");
CREATE INDEX "MergeOperation_workItemId_idx" ON "MergeOperation"("workItemId");

-- Durable per-order lock. No lease columns: it outlives any worker and is
-- released only by the transaction that finishes the owning operation.
CREATE TABLE "MergeOrderLock" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MergeOrderLock_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MergeOrderLock_shop_orderId_key" ON "MergeOrderLock"("shop", "orderId");
CREATE INDEX "MergeOrderLock_operationId_idx" ON "MergeOrderLock"("operationId");

-- Write-ahead dispatch record: a row exists BEFORE the Shopify request is
-- sent, so a lost response is reconciled (UNKNOWN) instead of re-dispatched.
CREATE TABLE "MergeMutationAttempt" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetOrderId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "dispatchToken" TEXT NOT NULL,
    "dispatchedAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "responseSummary" TEXT,
    "jobId" TEXT,

    CONSTRAINT "MergeMutationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MergeMutationAttempt_operationId_kind_targetOrderId_attemptNo_key" ON "MergeMutationAttempt"("operationId", "kind", "targetOrderId", "attemptNo");
CREATE INDEX "MergeMutationAttempt_operationId_kind_idx" ON "MergeMutationAttempt"("operationId", "kind");

-- Work items: REVIEW vocabulary plus the link to the operation created from it.
ALTER TABLE "ProcessedWebhook"
    ADD COLUMN "reviewReason" TEXT,
    ADD COLUMN "operationId" TEXT;

-- Kill switches. Both columns default off; MERGESHIP_MUTATIONS=enabled is
-- required in addition (checked in code before the gate, enforced in the
-- gate's UPDATE ... WHERE EXISTS clause).
CREATE TABLE "AppControl" (
    "id" TEXT NOT NULL,
    "newMergesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "completionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "allowShops" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppControl_pkey" PRIMARY KEY ("id")
);

INSERT INTO "AppControl" ("id", "newMergesEnabled", "completionEnabled", "allowShops", "updatedAt")
VALUES ('control', false, false, ARRAY[]::TEXT[], (clock_timestamp() AT TIME ZONE 'UTC'));

-- Sweeper liveness bookkeeping (heartbeat rows; purged after a day).
CREATE TABLE "WorkerInstance" (
    "instanceId" TEXT NOT NULL,
    "railwayDeploymentId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL,
    "version" TEXT,

    CONSTRAINT "WorkerInstance_pkey" PRIMARY KEY ("instanceId")
);

-- Consolidation history rows gain the operation that created them.
ALTER TABLE "MergeRecord" ADD COLUMN "operationId" TEXT;
