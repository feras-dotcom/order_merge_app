-- Shipping v0 foundation (additive only, no execution path yet):
-- Settings gains the merchant opt-in flag, its enable-epoch (so enabling can
-- never refund combines completed before opt-in) and the policy snapshot
-- inputs. AppControl gains a SEPARATE shipping kill switch and rollout
-- allowlist — NOTE the inverted semantics: empty shippingAllowShops means NO
-- shops (unlike allowShops, where empty means all shops).
-- ShippingAdjustment is the immutable intent record the future worker will
-- write ahead of any Shopify refund call: (shop, sourceOrderId) is unique so
-- an intent exists at most once per source, idempotencyKey and marker are
-- unique so a dispatched refund can never be duplicated or misattributed, and
-- operationCreatedAt freezes the epoch evidence. All amounts are exact
-- minor-unit integers stored as TEXT; no Float columns.
-- CHECK constraints keep status/policy/amounts inside the documented sets so
-- raw-SQL writers fail closed. updatedAt carries a DEFAULT so raw-SQL inserts
-- (the codebase's convention) never need to supply it.
-- No refund worker, Shopify mutation or automatic recovery exists yet, so
-- these columns and this table stay inert until the verified implementation
-- lands.

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "shippingAdjustmentEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shippingAdjustmentEnabledAt" TIMESTAMP(3),
ADD COLUMN     "shippingPolicy" TEXT NOT NULL DEFAULT 'REFUND_ALL',
ADD COLUMN     "shippingRetainedCurrency" TEXT,
ADD COLUMN     "shippingRetainedMinor" TEXT;

-- AlterTable
ALTER TABLE "AppControl" ADD COLUMN     "shippingAdjustmentsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shippingAllowShops" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "ShippingAdjustment" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "mergeOperationId" TEXT NOT NULL,
    "sourceOrderId" TEXT NOT NULL,
    "operationCreatedAt" TIMESTAMP(3) NOT NULL,
    "policyKind" TEXT NOT NULL,
    "policyRetainedMinor" TEXT,
    "policyCurrencyCode" TEXT,
    "sourceShippingMinor" TEXT,
    "plannedRefundMinor" TEXT,
    "currencyCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "marker" TEXT,
    "requestPayload" JSONB,
    "requestHash" TEXT,
    "previewEvidence" JSONB,
    "verifiedEvidence" JSONB,
    "preparedAt" TIMESTAMP(3),
    "dispatchToken" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "responseSummary" TEXT,
    "refundId" TEXT,
    "leaseToken" TEXT,
    "leasedUntil" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "reasonCode" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "reviewReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShippingAdjustment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ShippingAdjustment_status_check" CHECK ("status" IN (
      'PENDING', 'READY', 'DISPATCHING', 'IN_DOUBT', 'REFUND_RECORDED',
      'VERIFIED', 'SKIPPED', 'REVIEW_REQUIRED')),
    CONSTRAINT "ShippingAdjustment_policyKind_check" CHECK (
      "policyKind" IN ('REFUND_ALL', 'RETAIN_FIXED')),
    CONSTRAINT "ShippingAdjustment_policy_fields_check" CHECK (
      ("policyKind" = 'RETAIN_FIXED'
        AND "policyRetainedMinor" IS NOT NULL AND "policyCurrencyCode" IS NOT NULL)
      OR ("policyKind" <> 'RETAIN_FIXED'
        AND "policyRetainedMinor" IS NULL AND "policyCurrencyCode" IS NULL)),
    CONSTRAINT "ShippingAdjustment_amounts_check" CHECK (
      ("policyRetainedMinor" IS NULL OR "policyRetainedMinor" ~ '^[0-9]{1,40}$') AND
      ("sourceShippingMinor" IS NULL OR "sourceShippingMinor" ~ '^[0-9]{1,40}$') AND
      ("plannedRefundMinor" IS NULL OR "plannedRefundMinor" ~ '^[0-9]{1,40}$')),
    CONSTRAINT "ShippingAdjustment_requestHash_check" CHECK (
      "requestHash" IS NULL OR "requestHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "ShippingAdjustment_dispatch_once_check" CHECK (
      "dispatchedAt" IS NULL OR "dispatchToken" IS NOT NULL)
);

-- CreateIndex
CREATE UNIQUE INDEX "ShippingAdjustment_idempotencyKey_key" ON "ShippingAdjustment"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ShippingAdjustment_marker_key" ON "ShippingAdjustment"("marker");

-- CreateIndex
CREATE UNIQUE INDEX "ShippingAdjustment_refundId_key" ON "ShippingAdjustment"("refundId");

-- CreateIndex
CREATE INDEX "ShippingAdjustment_status_nextCheckAt_idx" ON "ShippingAdjustment"("status", "nextCheckAt");

-- CreateIndex
CREATE INDEX "ShippingAdjustment_mergeOperationId_idx" ON "ShippingAdjustment"("mergeOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "ShippingAdjustment_shop_sourceOrderId_key" ON "ShippingAdjustment"("shop", "sourceOrderId");
