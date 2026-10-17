-- Shipping v0 Phase 2, Stage S1-A (spec docs/SHIPPING-PHASE2-DESIGN.md
-- Revision 3.3, sections 4, 5.1-5.4, 5.4.7): database foundation only.
--
-- Additive: creates ShippingExecuteControl, ShippingExecuteApproval,
-- ShippingRefund, ShippingRefundEvent plus the ten canonical triggers.
-- No existing table, constraint or index is touched. The control singleton is
-- seeded fully off, so this migration alone can never enable anything.
--
-- The S1 transition graph deliberately contains NO PREPARED -> DISPATCHING
-- edge: entering DISPATCHING requires the separate, separately authorized S2
-- migration (section 5.4.1, invariant I27). The evidence-integrity function
-- names that update (it is the only update that may stamp dispatch evidence)
-- but does not authorize it (5.4.6).

-- ── ShippingExecuteControl (section 4.2): singleton id='control', fully off ──
CREATE TABLE "ShippingExecuteControl" (
    "id" TEXT NOT NULL,
    "admissionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "admissionEnabledAt" TIMESTAMP(3),
    "dispatchEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dispatchEnabledAt" TIMESTAMP(3),
    "globalDailyCap" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShippingExecuteControl_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ShippingExecuteControl_singleton" CHECK ("id" = 'control'),
    CONSTRAINT "ShippingExecuteControl_globalDailyCap" CHECK ("globalDailyCap" >= 0),
    CONSTRAINT "ShippingExecuteControl_switch_order" CHECK (NOT "dispatchEnabled" OR "admissionEnabled"),
    CONSTRAINT "ShippingExecuteControl_epochs" CHECK (
        ("admissionEnabledAt" IS NOT NULL) = "admissionEnabled"
        AND ("dispatchEnabledAt" IS NOT NULL) = "dispatchEnabled"
    )
);

-- Seeded fully off: no admission, no dispatch, zero cap.
INSERT INTO "ShippingExecuteControl"
    ("id", "admissionEnabled", "admissionEnabledAt", "dispatchEnabled", "dispatchEnabledAt", "globalDailyCap", "note", "updatedAt")
VALUES
    ('control', false, NULL, false, NULL, 0, 'S1-A: seeded fully off', CURRENT_TIMESTAMP);

-- ── ShippingExecuteApproval (section 4.3): PK shop; empty = NO shops ──
CREATE TABLE "ShippingExecuteApproval" (
    "shop" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "note" TEXT,
    "revokedAt" TIMESTAMP(3),
    "merchantOptInEpoch" TIMESTAMP(3) NOT NULL,
    "ackVersion" TEXT NOT NULL,
    "ackRecordedAt" TIMESTAMP(3) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "maxRefundMinor" TEXT NOT NULL,
    "dailyCap" INTEGER NOT NULL DEFAULT 0,
    "autoApprove" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ShippingExecuteApproval_pkey" PRIMARY KEY ("shop"),
    CONSTRAINT "ShippingExecuteApproval_currencyCode" CHECK ("currencyCode" ~ '^[A-Z]{3}$'),
    CONSTRAINT "ShippingExecuteApproval_maxRefundMinor_format" CHECK ("maxRefundMinor" ~ '^(0|[1-9][0-9]{0,39})$'),
    CONSTRAINT "ShippingExecuteApproval_dailyCap" CHECK ("dailyCap" >= 0)
);

-- ── ShippingRefund (section 5.1; constraints per 5.3) ──
CREATE TABLE "ShippingRefund" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "mergeOperationId" TEXT NOT NULL,
    "sourceOrderId" TEXT NOT NULL,
    "primaryOrderId" TEXT NOT NULL,
    "primaryOrderName" TEXT NOT NULL,
    "operationCreatedAt" TIMESTAMP(3) NOT NULL,
    "sourceCancelledAt" TIMESTAMP(3),
    "lane" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    -- Gate snapshot (NEW-8): each epoch stored individually.
    "merchantEpochAt" TIMESTAMP(3) NOT NULL,
    "rolloutEpochAt" TIMESTAMP(3) NOT NULL,
    "switchEpochAt" TIMESTAMP(3) NOT NULL,
    "activationCutoffAt" TIMESTAMP(3) NOT NULL,
    "admissionEpochAt" TIMESTAMP(3) NOT NULL,
    "admissionCutoffAt" TIMESTAMP(3) NOT NULL,
    "dispatchEpochAtAdmission" TIMESTAMP(3),
    "approvalApprovedAt" TIMESTAMP(3) NOT NULL,
    "approvalOptInEpoch" TIMESTAMP(3) NOT NULL,
    "approvalAckVersion" TEXT NOT NULL,
    "policyKind" TEXT NOT NULL,
    -- Frozen financial facts (write-once at the freeze).
    "currencyCode" TEXT,
    "plannedShippingMinor" TEXT,
    "parentTransactionId" TEXT,
    "gateway" TEXT,
    -- Frozen wire contract.
    "idempotencyKey" TEXT NOT NULL,
    "marker" TEXT NOT NULL,
    "documentSha256" TEXT,
    "wireVariables" JSONB,
    "wireHash" TEXT,
    "mutationVersion" TEXT,
    "preEvidence" JSONB,
    "preparedAt" TIMESTAMP(3),
    -- Operator approval (recorded only on PREPARED EXECUTE rows).
    "approvedWireHash" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    -- Dispatch write-ahead evidence (set only by PREPARED -> DISPATCHING).
    "dispatchToken" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "responseKind" TEXT,
    "responseSummary" TEXT,
    -- Settlement.
    "refundId" TEXT,
    "refundCreatedAt" TIMESTAMP(3),
    "settlementState" TEXT,
    "settlementCheckAt" TIMESTAMP(3),
    "verifiedEvidence" JSONB,
    "verifiedAt" TIMESTAMP(3),
    -- Ownership (liveness + stale-write fencing only).
    "leaseToken" TEXT,
    "leasedUntil" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    -- Review.
    "reasonCode" TEXT,
    "reviewReason" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolution" TEXT,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShippingRefund_pkey" PRIMARY KEY ("id"),

    -- ── Formats (5.3) ──
    CONSTRAINT "ShippingRefund_status_values" CHECK ("status" IN (
        'QUEUED','PREPARED','DISPATCHING','IN_DOUBT','REFUND_RECORDED','VERIFIED',
        'OBSERVED','SKIPPED','INELIGIBLE','ABORTED','REVIEW_REQUIRED','RESOLVED')),
    CONSTRAINT "ShippingRefund_lane_values" CHECK ("lane" IN ('OBSERVE','EXECUTE')),
    CONSTRAINT "ShippingRefund_policyKind" CHECK ("policyKind" = 'REFUND_ALL'),
    CONSTRAINT "ShippingRefund_orders_distinct" CHECK ("sourceOrderId" <> "primaryOrderId"),
    CONSTRAINT "ShippingRefund_sourceOrderId_format" CHECK ("sourceOrderId" ~ '^gid://shopify/Order/[0-9]+$'),
    CONSTRAINT "ShippingRefund_primaryOrderId_format" CHECK ("primaryOrderId" ~ '^gid://shopify/Order/[0-9]+$'),
    CONSTRAINT "ShippingRefund_parentTransactionId_format" CHECK ("parentTransactionId" IS NULL OR "parentTransactionId" ~ '^gid://shopify/OrderTransaction/[0-9]+$'),
    CONSTRAINT "ShippingRefund_refundId_format" CHECK ("refundId" IS NULL OR "refundId" ~ '^gid://shopify/Refund/[0-9]+$'),
    CONSTRAINT "ShippingRefund_currencyCode_format" CHECK ("currencyCode" IS NULL OR "currencyCode" ~ '^[A-Z]{3}$'),
    CONSTRAINT "ShippingRefund_idempotencyKey_format" CHECK ("idempotencyKey" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CONSTRAINT "ShippingRefund_marker_format" CHECK ("marker" ~ '^MS-SHIPREFUND-[0-9a-f-]{36}$'),
    CONSTRAINT "ShippingRefund_documentSha256_format" CHECK ("documentSha256" IS NULL OR "documentSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "ShippingRefund_wireHash_format" CHECK ("wireHash" IS NULL OR "wireHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "ShippingRefund_approvedWireHash_format" CHECK ("approvedWireHash" IS NULL OR "approvedWireHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "ShippingRefund_plannedShippingMinor_format" CHECK ("plannedShippingMinor" IS NULL OR "plannedShippingMinor" ~ '^[1-9][0-9]{0,39}$'),
    CONSTRAINT "ShippingRefund_attempts_nonneg" CHECK ("attempts" >= 0),

    -- ── State consistency (5.3) ──
    -- Dispatch-path statuses need EXECUTE lane, the dispatch epoch and frozen wire columns.
    CONSTRAINT "ShippingRefund_dispatch_path_state" CHECK (
        "status" NOT IN ('PREPARED','DISPATCHING','IN_DOUBT','REFUND_RECORDED','VERIFIED')
        OR ("lane" = 'EXECUTE' AND "dispatchEpochAtAdmission" IS NOT NULL
            AND "wireVariables" IS NOT NULL AND "wireHash" IS NOT NULL AND "documentSha256" IS NOT NULL)),
    -- Durable dispatch evidence (N1): post-dispatch statuses carry write-ahead evidence.
    CONSTRAINT "ShippingRefund_durable_dispatch_evidence" CHECK (
        "status" NOT IN ('DISPATCHING','IN_DOUBT','REFUND_RECORDED','VERIFIED')
        OR ("dispatchedAt" IS NOT NULL AND "dispatchToken" IS NOT NULL)),
    -- dispatchedAt implies EXECUTE lane, token and a dispatch-capable status;
    -- dispatchedAt IS NULL <=> dispatchToken IS NULL. The first-set rule is the
    -- evidence-integrity trigger's, not this CHECK's.
    CONSTRAINT "ShippingRefund_dispatch_columns" CHECK (
        ("dispatchedAt" IS NULL) = ("dispatchToken" IS NULL)
        AND ("dispatchedAt" IS NULL OR (
            "lane" = 'EXECUTE'
            AND "status" IN ('DISPATCHING','IN_DOUBT','REFUND_RECORDED','VERIFIED','REVIEW_REQUIRED','RESOLVED')))),
    -- sourceCancelledAt: NULL only on the terminal CANCELLED_AT_INVALID row (A-2).
    CONSTRAINT "ShippingRefund_sourceCancelledAt_nullable_terminal" CHECK (
        "sourceCancelledAt" IS NOT NULL
        OR ("reasonCode" = 'CANCELLED_AT_INVALID' AND "status" IN ('REVIEW_REQUIRED','RESOLVED'))),
    -- Gate snapshot derived cutoffs and no-retroactivity (N7, NEW-8, I8).
    CONSTRAINT "ShippingRefund_activationCutoff_derived" CHECK (
        "activationCutoffAt" = GREATEST("merchantEpochAt","rolloutEpochAt","switchEpochAt")),
    CONSTRAINT "ShippingRefund_admissionCutoff_derived" CHECK (
        "admissionCutoffAt" = GREATEST("activationCutoffAt","admissionEpochAt","approvalApprovedAt")),
    CONSTRAINT "ShippingRefund_no_retroactive" CHECK ("operationCreatedAt" >= "admissionCutoffAt"),
    CONSTRAINT "ShippingRefund_lane_dispatch_epoch" CHECK (
        ("lane" = 'EXECUTE' AND "dispatchEpochAtAdmission" IS NOT NULL AND "operationCreatedAt" >= "dispatchEpochAtAdmission")
        OR ("lane" = 'OBSERVE' AND "dispatchEpochAtAdmission" IS NULL)),
    -- Terminal pre-dispatch outcomes never carry dispatch evidence.
    CONSTRAINT "ShippingRefund_pre_dispatch_terminals" CHECK (
        "status" NOT IN ('OBSERVED','ABORTED','SKIPPED','INELIGIBLE') OR "dispatchedAt" IS NULL),
    CONSTRAINT "ShippingRefund_recorded_needs_refundId" CHECK (
        "status" NOT IN ('REFUND_RECORDED','VERIFIED') OR "refundId" IS NOT NULL),
    CONSTRAINT "ShippingRefund_verified_needs_success" CHECK (
        "status" <> 'VERIFIED' OR ("settlementState" = 'SUCCESS' AND "verifiedAt" IS NOT NULL)),
    CONSTRAINT "ShippingRefund_resolved_needs_actor" CHECK (
        "status" <> 'RESOLVED' OR ("resolvedBy" IS NOT NULL AND "resolution" IS NOT NULL AND "resolvedAt" IS NOT NULL)),

    -- ── Frozen wire shape (5.3; NULL-safe: every compared field must be
    -- present, a NULL comparison result must never satisfy the CHECK) ──
    CONSTRAINT "ShippingRefund_wire_idempotencyKey" CHECK (
        "wireVariables" IS NULL
        OR ("wireVariables"->>'idempotencyKey' IS NOT NULL
            AND "wireVariables"->>'idempotencyKey' = "idempotencyKey")),
    CONSTRAINT "ShippingRefund_wire_order" CHECK (
        "wireVariables" IS NULL
        OR ("wireVariables"->'input'->>'orderId' IS NOT NULL
            AND "wireVariables"->'input'->>'orderId' = "sourceOrderId")),
    CONSTRAINT "ShippingRefund_wire_txn_count" CHECK (
        "wireVariables" IS NULL
        OR jsonb_array_length("wireVariables"->'input'->'transactions') = 1),
    CONSTRAINT "ShippingRefund_wire_txn_fields" CHECK (
        "wireVariables" IS NULL
        OR ("parentTransactionId" IS NOT NULL AND "gateway" IS NOT NULL
            AND "wireVariables"->'input'->'transactions'->0->>'orderId' IS NOT NULL
            AND "wireVariables"->'input'->'transactions'->0->>'orderId' = "sourceOrderId"
            AND "wireVariables"->'input'->'transactions'->0->>'parentId' IS NOT NULL
            AND "wireVariables"->'input'->'transactions'->0->>'parentId' = "parentTransactionId"
            AND "wireVariables"->'input'->'transactions'->0->>'gateway' IS NOT NULL
            AND "wireVariables"->'input'->'transactions'->0->>'gateway' = "gateway"
            AND "wireVariables"->'input'->'transactions'->0->>'kind' = 'REFUND')),
    CONSTRAINT "ShippingRefund_wire_fullRefund_false" CHECK (
        "wireVariables" IS NULL
        OR ("wireVariables"->'input'->'shipping' ? 'fullRefund'
            AND "wireVariables"->'input'->'shipping'->'fullRefund' = 'false'::jsonb)),
    CONSTRAINT "ShippingRefund_wire_amounts_equal" CHECK (
        "wireVariables" IS NULL
        OR ("wireVariables"->'input'->'shipping'->>'amount' IS NOT NULL
            AND "wireVariables"->'input'->'transactions'->0->>'amount' IS NOT NULL
            AND "wireVariables"->'input'->'shipping'->>'amount'
                = "wireVariables"->'input'->'transactions'->0->>'amount')),
    CONSTRAINT "ShippingRefund_wire_notify_false" CHECK (
        "wireVariables" IS NULL
        OR ("wireVariables"->'input' ? 'notify'
            AND "wireVariables"->'input'->'notify' = 'false'::jsonb)),
    CONSTRAINT "ShippingRefund_wire_currency" CHECK (
        "wireVariables" IS NULL
        OR ("currencyCode" IS NOT NULL
            AND "wireVariables"->'input'->>'currency' IS NOT NULL
            AND "wireVariables"->'input'->>'currency' = "currencyCode")),
    CONSTRAINT "ShippingRefund_wire_no_refundLineItems" CHECK (
        "wireVariables" IS NULL
        OR ("wireVariables"->'input' IS NOT NULL
            AND NOT ("wireVariables"->'input' ? 'refundLineItems'))),
    CONSTRAINT "ShippingRefund_wire_marker_in_note" CHECK (
        "wireVariables" IS NULL
        OR ("wireVariables"->'input'->>'note' IS NOT NULL
            AND position("marker" in "wireVariables"->'input'->>'note') > 0)),
    -- Decimal amount format (N7): no sign, no exponent, no superfluous leading
    -- zeros, at most four fractional digits, strictly positive.
    CONSTRAINT "ShippingRefund_wire_amount_decimal" CHECK (
        "wireVariables" IS NULL
        OR ("wireVariables"->'input'->'shipping'->>'amount' ~ '^(0\.[0-9]{1,4}|[1-9][0-9]*(\.[0-9]{1,4})?)$'
            AND ("wireVariables"->'input'->'shipping'->>'amount')::numeric > 0
            AND "wireVariables"->'input'->'transactions'->0->>'amount' ~ '^(0\.[0-9]{1,4}|[1-9][0-9]*(\.[0-9]{1,4})?)$'
            AND ("wireVariables"->'input'->'transactions'->0->>'amount')::numeric > 0))
);

-- ── ShippingRefundEvent (5.2): append-only journal; FK column is named
-- shippingRefundId, never refundId (NEW-10) ──
CREATE TABLE "ShippingRefundEvent" (
    "id" TEXT NOT NULL,
    "shippingRefundId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'unknown',

    CONSTRAINT "ShippingRefundEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ShippingRefundEvent_shippingRefundId_fkey"
        FOREIGN KEY ("shippingRefundId") REFERENCES "ShippingRefund"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- ── Indexes ──
CREATE UNIQUE INDEX "ShippingRefund_shop_sourceOrderId_key" ON "ShippingRefund"("shop", "sourceOrderId");
CREATE UNIQUE INDEX "ShippingRefund_idempotencyKey_key" ON "ShippingRefund"("idempotencyKey");
CREATE UNIQUE INDEX "ShippingRefund_marker_key" ON "ShippingRefund"("marker");
CREATE UNIQUE INDEX "ShippingRefund_refundId_key" ON "ShippingRefund"("refundId");
CREATE INDEX "ShippingRefund_status_nextCheckAt_idx" ON "ShippingRefund"("status", "nextCheckAt");
CREATE INDEX "ShippingRefund_shop_status_idx" ON "ShippingRefund"("shop", "status");
CREATE INDEX "ShippingRefund_mergeOperationId_idx" ON "ShippingRefund"("mergeOperationId");
CREATE INDEX "ShippingRefund_dispatchedAt_idx" ON "ShippingRefund"("dispatchedAt");
CREATE INDEX "ShippingRefundEvent_shippingRefundId_idx" ON "ShippingRefundEvent"("shippingRefundId");
CREATE INDEX "ShippingRefundEvent_at_idx" ON "ShippingRefundEvent"("at");

-- ═══ Trigger functions (5.4; canonical names per 5.4.7) ═══

-- 5.4.4 shared raiser: journal rows are never deleted, updated (event table)
-- or truncated.
CREATE FUNCTION shipping_refund_fn_always_raise() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
    RAISE EXCEPTION 'MergeShip shipping-refund journal integrity: % on %.% is forbidden',
        TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$fn$;

-- 5.4.1 insert guard: only the claim statuses; every dispatch, response,
-- settlement, refund, verification, resolution, approval and frozen-wire
-- column NULL (insert integrity, NEW-6).
CREATE FUNCTION shipping_refund_fn_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
    IF NEW."status" NOT IN ('QUEUED','SKIPPED','INELIGIBLE','REVIEW_REQUIRED') THEN
        RAISE EXCEPTION 'ShippingRefund: illegal initial status % (claim admits QUEUED, SKIPPED, INELIGIBLE, REVIEW_REQUIRED only)',
            NEW."status";
    END IF;
    IF NEW."dispatchToken" IS NOT NULL OR NEW."dispatchedAt" IS NOT NULL
        OR NEW."respondedAt" IS NOT NULL OR NEW."responseKind" IS NOT NULL
        OR NEW."responseSummary" IS NOT NULL OR NEW."refundId" IS NOT NULL
        OR NEW."refundCreatedAt" IS NOT NULL OR NEW."settlementState" IS NOT NULL
        OR NEW."settlementCheckAt" IS NOT NULL OR NEW."verifiedEvidence" IS NOT NULL
        OR NEW."verifiedAt" IS NOT NULL OR NEW."resolvedAt" IS NOT NULL
        OR NEW."resolvedBy" IS NOT NULL OR NEW."resolution" IS NOT NULL
        OR NEW."resolutionNote" IS NOT NULL
        OR NEW."approvedWireHash" IS NOT NULL OR NEW."approvedAt" IS NOT NULL
        OR NEW."approvedBy" IS NOT NULL
        OR NEW."wireVariables" IS NOT NULL OR NEW."wireHash" IS NOT NULL
        OR NEW."documentSha256" IS NOT NULL OR NEW."mutationVersion" IS NOT NULL
        OR NEW."parentTransactionId" IS NOT NULL OR NEW."gateway" IS NOT NULL
        OR NEW."plannedShippingMinor" IS NOT NULL OR NEW."currencyCode" IS NOT NULL
        OR NEW."preEvidence" IS NOT NULL OR NEW."preparedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'ShippingRefund: insert carries dispatch, response, settlement, approval, resolution or frozen-wire evidence';
    END IF;
    RETURN NEW;
END;
$fn$;

-- 5.4.1 transition graph (S1). NO PREPARED -> DISPATCHING edge exists here:
-- the S2 migration adds it by replacing this function's body. Terminal rows
-- (OBSERVED, SKIPPED, INELIGIBLE, ABORTED, VERIFIED, RESOLVED) accept no
-- update at all (I13). Updates that keep the status (lease, attempts,
-- bookkeeping) pass on non-terminal rows.
CREATE FUNCTION shipping_refund_fn_transition_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
    IF OLD."status" IN ('OBSERVED','SKIPPED','INELIGIBLE','ABORTED','VERIFIED','RESOLVED') THEN
        RAISE EXCEPTION 'ShippingRefund: terminal status % is immutable', OLD."status";
    END IF;
    IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
        RETURN NEW;
    END IF;
    IF OLD."status" = 'QUEUED' AND NEW."status" = 'PREPARED' AND OLD."lane" = 'EXECUTE' THEN RETURN NEW; END IF;
    IF OLD."status" = 'QUEUED' AND NEW."status" = 'OBSERVED' AND OLD."lane" = 'OBSERVE' THEN RETURN NEW; END IF;
    IF OLD."status" = 'QUEUED' AND NEW."status" IN ('SKIPPED','INELIGIBLE','ABORTED','REVIEW_REQUIRED') THEN RETURN NEW; END IF;
    IF OLD."status" = 'PREPARED' AND NEW."status" IN ('ABORTED','REVIEW_REQUIRED') THEN RETURN NEW; END IF;
    IF OLD."status" = 'DISPATCHING' AND NEW."status" IN ('REFUND_RECORDED','IN_DOUBT') THEN RETURN NEW; END IF;
    IF OLD."status" = 'IN_DOUBT' AND NEW."status" IN ('REFUND_RECORDED','REVIEW_REQUIRED') THEN RETURN NEW; END IF;
    IF OLD."status" = 'REFUND_RECORDED' AND NEW."status" IN ('VERIFIED','REVIEW_REQUIRED') THEN RETURN NEW; END IF;
    IF OLD."status" = 'REVIEW_REQUIRED' AND NEW."status" = 'RESOLVED' THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'ShippingRefund: illegal transition % -> %', OLD."status", NEW."status";
END;
$fn$;

-- 5.4.2 frozen columns. Always immutable (NULL-safe IS DISTINCT FROM so NULL
-- stays NULL forever, including the terminal CANCELLED_AT_INVALID row): shop,
-- order ids, operation, sourceCancelledAt, lane, key, marker and the whole
-- gate snapshot. Write-once columns may go NULL -> value exactly once (the
-- evidence-integrity trigger governs WHEN dispatchToken/dispatchedAt may be
-- set) and never change or return to NULL afterwards.
CREATE FUNCTION shipping_refund_fn_frozen_columns_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
    IF NEW."shop" IS DISTINCT FROM OLD."shop"
        OR NEW."sourceOrderId" IS DISTINCT FROM OLD."sourceOrderId"
        OR NEW."primaryOrderId" IS DISTINCT FROM OLD."primaryOrderId"
        OR NEW."mergeOperationId" IS DISTINCT FROM OLD."mergeOperationId"
        OR NEW."operationCreatedAt" IS DISTINCT FROM OLD."operationCreatedAt"
        OR NEW."sourceCancelledAt" IS DISTINCT FROM OLD."sourceCancelledAt"
        OR NEW."lane" IS DISTINCT FROM OLD."lane"
        OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
        OR NEW."marker" IS DISTINCT FROM OLD."marker"
        OR NEW."merchantEpochAt" IS DISTINCT FROM OLD."merchantEpochAt"
        OR NEW."rolloutEpochAt" IS DISTINCT FROM OLD."rolloutEpochAt"
        OR NEW."switchEpochAt" IS DISTINCT FROM OLD."switchEpochAt"
        OR NEW."activationCutoffAt" IS DISTINCT FROM OLD."activationCutoffAt"
        OR NEW."admissionEpochAt" IS DISTINCT FROM OLD."admissionEpochAt"
        OR NEW."admissionCutoffAt" IS DISTINCT FROM OLD."admissionCutoffAt"
        OR NEW."dispatchEpochAtAdmission" IS DISTINCT FROM OLD."dispatchEpochAtAdmission"
        OR NEW."approvalApprovedAt" IS DISTINCT FROM OLD."approvalApprovedAt"
        OR NEW."approvalOptInEpoch" IS DISTINCT FROM OLD."approvalOptInEpoch"
        OR NEW."approvalAckVersion" IS DISTINCT FROM OLD."approvalAckVersion" THEN
        RAISE EXCEPTION 'ShippingRefund: immutable column modified (identity, sourceCancelledAt, lane, key, marker or gate snapshot)';
    END IF;
    IF (OLD."wireVariables" IS NOT NULL AND NEW."wireVariables" IS DISTINCT FROM OLD."wireVariables")
        OR (OLD."wireHash" IS NOT NULL AND NEW."wireHash" IS DISTINCT FROM OLD."wireHash")
        OR (OLD."documentSha256" IS NOT NULL AND NEW."documentSha256" IS DISTINCT FROM OLD."documentSha256")
        OR (OLD."mutationVersion" IS NOT NULL AND NEW."mutationVersion" IS DISTINCT FROM OLD."mutationVersion")
        OR (OLD."currencyCode" IS NOT NULL AND NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode")
        OR (OLD."plannedShippingMinor" IS NOT NULL AND NEW."plannedShippingMinor" IS DISTINCT FROM OLD."plannedShippingMinor")
        OR (OLD."parentTransactionId" IS NOT NULL AND NEW."parentTransactionId" IS DISTINCT FROM OLD."parentTransactionId")
        OR (OLD."gateway" IS NOT NULL AND NEW."gateway" IS DISTINCT FROM OLD."gateway")
        OR (OLD."preEvidence" IS NOT NULL AND NEW."preEvidence" IS DISTINCT FROM OLD."preEvidence")
        OR (OLD."preparedAt" IS NOT NULL AND NEW."preparedAt" IS DISTINCT FROM OLD."preparedAt")
        OR (OLD."dispatchToken" IS NOT NULL AND NEW."dispatchToken" IS DISTINCT FROM OLD."dispatchToken")
        OR (OLD."dispatchedAt" IS NOT NULL AND NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt") THEN
        RAISE EXCEPTION 'ShippingRefund: write-once column changed after being set';
    END IF;
    RETURN NEW;
END;
$fn$;

-- 5.4.3 shape guard: when wireVariables is set its key sets are EXACTLY the
-- allowed sets (a CHECK cannot enumerate keys without an SRF). No merchandise,
-- restock, allowOverRefunding or refund-method field can ever appear.
CREATE FUNCTION shipping_refund_fn_shape_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
    wv jsonb := NEW."wireVariables";
    inp jsonb;
    sh jsonb;
    txn jsonb;
BEGIN
    IF wv IS NULL THEN
        RETURN NEW;
    END IF;
    IF jsonb_typeof(wv) <> 'object'
        OR NOT (wv ? 'idempotencyKey' AND wv ? 'input')
        OR (SELECT count(*) FROM jsonb_object_keys(wv) k
            WHERE k NOT IN ('idempotencyKey','input')) > 0 THEN
        RAISE EXCEPTION 'ShippingRefund: wireVariables keys must be exactly {idempotencyKey, input}';
    END IF;
    inp := wv->'input';
    IF jsonb_typeof(inp) <> 'object'
        OR NOT (inp ? 'orderId' AND inp ? 'note' AND inp ? 'notify'
                AND inp ? 'currency' AND inp ? 'shipping' AND inp ? 'transactions')
        OR (SELECT count(*) FROM jsonb_object_keys(inp) k
            WHERE k NOT IN ('orderId','note','notify','currency','shipping','transactions')) > 0 THEN
        RAISE EXCEPTION 'ShippingRefund: wire input keys must be exactly {orderId, note, notify, currency, shipping, transactions}';
    END IF;
    sh := inp->'shipping';
    IF jsonb_typeof(sh) <> 'object'
        OR NOT (sh ? 'fullRefund' AND sh ? 'amount')
        OR (SELECT count(*) FROM jsonb_object_keys(sh) k
            WHERE k NOT IN ('fullRefund','amount')) > 0 THEN
        RAISE EXCEPTION 'ShippingRefund: wire shipping keys must be exactly {fullRefund, amount}';
    END IF;
    IF jsonb_typeof(inp->'transactions') <> 'array' THEN
        RAISE EXCEPTION 'ShippingRefund: wire transactions must be an array';
    END IF;
    IF jsonb_array_length(inp->'transactions') <> 1 THEN
        RAISE EXCEPTION 'ShippingRefund: wire transactions must contain exactly one entry';
    END IF;
    txn := inp->'transactions'->0;
    IF jsonb_typeof(txn) <> 'object'
        OR NOT (txn ? 'orderId' AND txn ? 'parentId' AND txn ? 'gateway'
                AND txn ? 'kind' AND txn ? 'amount')
        OR (SELECT count(*) FROM jsonb_object_keys(txn) k
            WHERE k NOT IN ('orderId','parentId','gateway','kind','amount')) > 0 THEN
        RAISE EXCEPTION 'ShippingRefund: wire transaction keys must be exactly {orderId, parentId, gateway, kind, amount}';
    END IF;
    RETURN NEW;
END;
$fn$;

-- 5.4.6 evidence-integrity guard (NEW-6): its OWN function, independent of
-- the transition function. dispatchToken/dispatchedAt may first become
-- non-null only inside an update that is exactly PREPARED -> DISPATCHING on an
-- EXECUTE row with both set; once set they never change. Response and
-- settlement evidence can first appear only while the row is post-dispatch.
-- approvedWireHash only on a PREPARED EXECUTE row and only equal to wireHash.
-- This function NAMES PREPARED -> DISPATCHING but does not authorize it: the
-- transition guard still rejects that edge until the S2 migration.
CREATE FUNCTION shipping_refund_fn_evidence_integrity_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
    IF (OLD."dispatchToken" IS NULL AND NEW."dispatchToken" IS NOT NULL)
        OR (OLD."dispatchedAt" IS NULL AND NEW."dispatchedAt" IS NOT NULL) THEN
        IF NOT (OLD."status" = 'PREPARED' AND NEW."status" = 'DISPATCHING'
                AND OLD."lane" = 'EXECUTE'
                AND NEW."dispatchToken" IS NOT NULL AND NEW."dispatchedAt" IS NOT NULL) THEN
            RAISE EXCEPTION 'ShippingRefund: dispatch evidence may be stamped only by a PREPARED -> DISPATCHING update';
        END IF;
    END IF;
    IF (OLD."dispatchToken" IS NOT NULL AND NEW."dispatchToken" IS DISTINCT FROM OLD."dispatchToken")
        OR (OLD."dispatchedAt" IS NOT NULL AND NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt") THEN
        RAISE EXCEPTION 'ShippingRefund: dispatch evidence is write-once';
    END IF;
    IF (OLD."respondedAt" IS NULL AND NEW."respondedAt" IS NOT NULL)
        OR (OLD."responseKind" IS NULL AND NEW."responseKind" IS NOT NULL)
        OR (OLD."responseSummary" IS NULL AND NEW."responseSummary" IS NOT NULL)
        OR (OLD."refundId" IS NULL AND NEW."refundId" IS NOT NULL)
        OR (OLD."refundCreatedAt" IS NULL AND NEW."refundCreatedAt" IS NOT NULL)
        OR (OLD."settlementState" IS NULL AND NEW."settlementState" IS NOT NULL)
        OR (OLD."settlementCheckAt" IS NULL AND NEW."settlementCheckAt" IS NOT NULL)
        OR (OLD."verifiedEvidence" IS NULL AND NEW."verifiedEvidence" IS NOT NULL)
        OR (OLD."verifiedAt" IS NULL AND NEW."verifiedAt" IS NOT NULL) THEN
        IF OLD."status" NOT IN ('DISPATCHING','IN_DOUBT','REFUND_RECORDED') THEN
            RAISE EXCEPTION 'ShippingRefund: response and settlement evidence require a post-dispatch status';
        END IF;
    END IF;
    IF OLD."refundId" IS NOT NULL AND NEW."refundId" IS DISTINCT FROM OLD."refundId" THEN
        RAISE EXCEPTION 'ShippingRefund: refundId is write-once';
    END IF;
    IF OLD."approvedWireHash" IS NULL AND NEW."approvedWireHash" IS NOT NULL THEN
        IF NOT (OLD."status" = 'PREPARED' AND OLD."lane" = 'EXECUTE'
                AND OLD."wireHash" IS NOT NULL
                AND NEW."approvedWireHash" = OLD."wireHash") THEN
            RAISE EXCEPTION 'ShippingRefund: approvedWireHash only on a PREPARED EXECUTE row, equal to wireHash';
        END IF;
    END IF;
    IF OLD."approvedWireHash" IS NOT NULL AND NEW."approvedWireHash" IS DISTINCT FROM OLD."approvedWireHash" THEN
        RAISE EXCEPTION 'ShippingRefund: approvedWireHash is write-once';
    END IF;
    RETURN NEW;
END;
$fn$;

-- 5.4.5 event writer: exactly one ShippingRefundEvent per status change
-- (insert counts as a new status), actor from the session-local
-- mergeship.actor setting, 'unknown' when unset. The store never inserts
-- events itself. "at" is the database UTC wall clock.
CREATE FUNCTION shipping_refund_fn_event_writer() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
    IF TG_OP = 'INSERT' OR NEW."status" IS DISTINCT FROM OLD."status" THEN
        INSERT INTO "ShippingRefundEvent"
            ("id", "shippingRefundId", "at", "fromStatus", "toStatus", "actor")
        VALUES (
            gen_random_uuid()::text,
            NEW."id",
            clock_timestamp() AT TIME ZONE 'UTC',
            CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."status" END,
            NEW."status",
            COALESCE(NULLIF(current_setting('mergeship.actor', true), ''), 'unknown')
        );
    END IF;
    RETURN NULL;
END;
$fn$;

-- ═══ The ten canonical triggers (5.4.7 manifest order) ═══

CREATE TRIGGER shippingrefund_insert_guard
    BEFORE INSERT ON "ShippingRefund"
    FOR EACH ROW EXECUTE FUNCTION shipping_refund_fn_insert_guard();

CREATE TRIGGER shippingrefund_transition_guard
    BEFORE UPDATE ON "ShippingRefund"
    FOR EACH ROW EXECUTE FUNCTION shipping_refund_fn_transition_guard();

CREATE TRIGGER shippingrefund_frozen_columns_guard
    BEFORE UPDATE ON "ShippingRefund"
    FOR EACH ROW EXECUTE FUNCTION shipping_refund_fn_frozen_columns_guard();

CREATE TRIGGER shippingrefund_shape_guard
    BEFORE INSERT OR UPDATE ON "ShippingRefund"
    FOR EACH ROW EXECUTE FUNCTION shipping_refund_fn_shape_guard();

CREATE TRIGGER shippingrefund_evidence_integrity_guard
    BEFORE UPDATE ON "ShippingRefund"
    FOR EACH ROW EXECUTE FUNCTION shipping_refund_fn_evidence_integrity_guard();

CREATE TRIGGER shippingrefund_no_delete
    BEFORE DELETE ON "ShippingRefund"
    FOR EACH ROW EXECUTE FUNCTION shipping_refund_fn_always_raise();

CREATE TRIGGER shippingrefund_no_truncate
    BEFORE TRUNCATE ON "ShippingRefund"
    FOR EACH STATEMENT EXECUTE FUNCTION shipping_refund_fn_always_raise();

CREATE TRIGGER shippingrefund_event_writer
    AFTER INSERT OR UPDATE ON "ShippingRefund"
    FOR EACH ROW EXECUTE FUNCTION shipping_refund_fn_event_writer();

CREATE TRIGGER shippingrefundevent_no_update_delete
    BEFORE UPDATE OR DELETE ON "ShippingRefundEvent"
    FOR EACH ROW EXECUTE FUNCTION shipping_refund_fn_always_raise();

CREATE TRIGGER shippingrefundevent_no_truncate
    BEFORE TRUNCATE ON "ShippingRefundEvent"
    FOR EACH STATEMENT EXECUTE FUNCTION shipping_refund_fn_always_raise();
