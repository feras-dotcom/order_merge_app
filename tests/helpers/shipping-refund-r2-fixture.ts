// Shared fixtures for the §8.4 R2 pre-dispatch-parity suites (S2): the live
// gate/approval rows, a fixture MergeOperation that satisfies
// assessSecondaryEvidence, and a PREPARED ShippingRefund row seeded through
// the REAL evaluator + freeze adapter — so the frozen columns are the exact
// values the pipeline itself produces and an unchanged re-evaluation must
// rebuild them byte for byte. A fake AdminClient routes by GraphQL
// document. Fake admin clients only — no Shopify calls.
//
// Fixture provenance: every Shopify response here is SYNTHETIC — built
// from the shapes the pinned documents request (Q-RECHECK, the shadow
// evaluator's order and preview queries, Q-REFUND-DETAIL), not derived
// from the evidence archive.

import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { AdminClient } from "../../app/lib/graphql.server";
import { evaluateShadowSource, readOnlyAdmin } from "../../app/lib/shipping-shadow.server";
import {
  adaptReadyToFreezeContract,
  type FreezeBindings,
} from "../../app/lib/shipping-refund-freeze-contract";
import {
  analyzeExecRecheck,
  buildPreEvidence,
  buildRefundBaseline,
} from "../../app/lib/shipping-refund-baseline";
import { Q_RECHECK, Q_REFUND_DETAIL } from "../../app/lib/shipping-refund-queries";
import {
  generateIdempotencyKey,
  generateMarker,
  REFUND_MUTATION_VERSION,
  shippingRefundMutationDocument,
} from "../../app/lib/shipping-refund-contract";
import { recordApprovedWireHash } from "../../app/lib/shipping-refund-store.server";

/** The naive-UTC timestamp bind (repository discipline). */
const naive = (iso: string) => Prisma.sql`(${iso}::timestamptz AT TIME ZONE 'UTC')`;
const PM = (amount: string, currencyCode = "USD") => ({
  presentmentMoney: { amount, currencyCode },
});

// ── Live gate state (the same epoch layout the dispatch suite uses) ────────

export const R2_EPOCHS = {
  E1: "2030-01-01T00:00:00Z", // merchant opt-in
  E2: "2030-01-02T00:00:00Z", // rollout
  E3: "2030-01-03T00:00:00Z", // app switch (activation = max(E1,E2,E3))
  E4: "2030-01-04T00:00:00Z", // admission switch
  E5: "2030-01-05T00:00:00Z", // dispatch switch + approval (admission cutoff)
} as const;

/** operationCreatedAt / sourceCancelledAt / the op's createdAt — after the
 *  admission cutoff and inside the seven-day horizon. */
export const R2_OPERATION_AT = "2030-01-06T00:00:00Z";

export interface R2GateOptions {
  readonly dailyCap?: number;
  readonly maxMinor?: string;
  readonly autoApprove?: boolean;
  readonly globalCap?: number;
  readonly approvalCurrency?: string;
}

/** The live gate: AppControl + Settings + ShippingExecuteControl +
 *  ShippingExecuteApproval, matching the epochs the row snapshot carries. */
export async function seedShippingR2Gate(
  db: PrismaClient,
  shop: string,
  o: R2GateOptions = {},
): Promise<void> {
  const { E1, E2, E3, E4, E5 } = R2_EPOCHS;
  await db.$executeRaw`
    UPDATE "AppControl" SET "shippingAdjustmentsEnabled" = true,
      "shippingEnabledAt" = ${naive(E3)},
      "shippingAllowShops" = ARRAY[${shop}]::text[]
    WHERE "id" = 'control'`;
  await db.$executeRaw`
    INSERT INTO "Settings" ("id","shop","autoMergeEnabled","mergeWindowHours","shippingCostSavings","shippingAdjustmentEnabled","shippingAdjustmentEnabledAt","shippingRolloutAt","shippingPolicy")
    VALUES (${"set_" + randomUUID().replace(/-/g, "")}, ${shop}, false, 24, '0', true, ${naive(E1)},
            ${naive(E2)}, 'REFUND_ALL')
    ON CONFLICT ("shop") DO UPDATE SET
      "shippingAdjustmentEnabled" = true,
      "shippingAdjustmentEnabledAt" = ${naive(E1)},
      "shippingRolloutAt" = ${naive(E2)},
      "shippingPolicy" = 'REFUND_ALL'`;
  await db.$executeRaw`
    UPDATE "ShippingExecuteControl" SET
      "admissionEnabled" = true, "admissionEnabledAt" = ${naive(E4)},
      "dispatchEnabled" = true, "dispatchEnabledAt" = ${naive(E5)},
      "globalDailyCap" = ${o.globalCap ?? 1_000_000}
    WHERE "id" = 'control'`;
  await db.$executeRaw`
    INSERT INTO "ShippingExecuteApproval"
      ("shop","approvedAt","approvedBy","revokedAt","merchantOptInEpoch","ackVersion","ackRecordedAt","currencyCode","maxRefundMinor","dailyCap","autoApprove")
    VALUES (${shop}, ${naive(E5)}, 'r2-test', NULL,
            ${naive(E1)}, 'v1',
            ${naive(E5)}, ${o.approvalCurrency ?? "USD"},
            ${o.maxMinor ?? "10000"}, ${o.dailyCap ?? 1_000_000}, ${o.autoApprove ?? true})
    ON CONFLICT ("shop") DO UPDATE SET
      "approvedAt" = ${naive(E5)}, "revokedAt" = NULL,
      "merchantOptInEpoch" = ${naive(E1)},
      "ackVersion" = 'v1', "currencyCode" = ${o.approvalCurrency ?? "USD"},
      "maxRefundMinor" = ${o.maxMinor ?? "10000"}, "dailyCap" = ${o.dailyCap ?? 1_000_000},
      "autoApprove" = ${o.autoApprove ?? true}`;
}

// ── The fixture merge operation (native v2 COMPLETED, assessment-eligible) ──

/** A MergeOperation (+ MergeRecord + both mutation attempts) that passes
 *  the merge-evidence assessment for `secondaryId`. Mirrors the admission
 *  e2e suite's seedOp — no protocol-v2 write path is exercised. */
export async function seedShippingR2MergeOp(
  db: PrismaClient,
  seed: {
    shop: string;
    primaryId: string;
    secondaryId: string;
    primaryOrderName?: string;
    cancelledAt?: string;
    createdAt?: string;
    secondaries?: unknown;
    phase?: string | null;
    status?: string;
  },
): Promise<string> {
  const opId = `op_r2_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const cancelledAt = seed.cancelledAt ?? R2_OPERATION_AT;
  const createdAt = seed.createdAt ?? R2_OPERATION_AT;
  const secondaries =
    seed.secondaries !== undefined
      ? seed.secondaries
      : [
          {
            id: seed.secondaryId,
            name: `#${seed.secondaryId.split("/").pop()}`,
            items: 1,
            done: true,
            cancelPhase: "CANCEL_VERIFIED",
            cancelledAt,
            staffNoteMatched: true,
          },
        ];
  await db.$executeRaw`
    INSERT INTO "MergeOperation"
      ("id", "shop", "status", "primaryOrderId", "primaryOrderName",
       "primaryLineItemCountBefore", "addedLineItemCount", "secondaries",
       "involvedOrderIds", "createdAt", "updatedAt", "protocolVersion",
       "phase", "opToken", "calculatedOrderId", "expectedTransfer",
       "appliedEvidence", "sideEffectsDone")
    VALUES (
      ${opId}, ${seed.shop}, ${seed.status ?? "COMPLETED"}, ${seed.primaryId},
      ${seed.primaryOrderName ?? "#P1"},
      1, 1, ${JSON.stringify(secondaries)}::jsonb,
      ${[seed.primaryId, seed.secondaryId]}::text[],
      ${naive(createdAt)}, ${naive(createdAt)},
      2, ${seed.phase === undefined ? "COMPLETED" : seed.phase},
      ${`TK${randomUUID().slice(0, 6).toUpperCase()}`},
      ${"gid://shopify/CalculatedOrder/1"},
      ${JSON.stringify([{ secondaryId: seed.secondaryId, secondaryIndex: 1, lines: [{ sourceLineItemId: "gid://shopify/LineItem/9", variantId: "gid://shopify/ProductVariant/9", quantity: 1 }] }])}::jsonb,
      ${JSON.stringify({ agreementId: "gid://shopify/OrderEditAgreement/1", happenedAt: createdAt, lines: [{ secondaryId: seed.secondaryId }] })}::jsonb,
      true
    )`;
  await db.$executeRaw`
    INSERT INTO "MergeRecord"
      ("id", "shop", "primaryOrderId", "primaryOrderName", "mergedOrderId",
       "mergedOrderName", "itemsCombined", "operationId", "createdAt")
    VALUES (${`mr_${randomUUID()}`}, ${seed.shop}, ${seed.primaryId}, '#P1',
      ${seed.secondaryId}, '#secondary', 1, ${opId}, ${naive(createdAt)})`;
  await db.$executeRaw`
    INSERT INTO "MergeMutationAttempt"
      ("id", "operationId", "kind", "targetOrderId", "attemptNo", "state",
       "dispatchToken", "dispatchedAt", "respondedAt")
    VALUES
      (${`att_${randomUUID()}`}, ${opId}, 'EDIT_COMMIT', ${seed.primaryId}, 1,
       'SUCCEEDED', 't', ${naive(createdAt)}, ${naive(createdAt)}),
      (${`att_${randomUUID()}`}, ${opId}, 'ORDER_CANCEL', ${seed.secondaryId}, 1,
       'SUCCEEDED', 't', ${naive(createdAt)}, ${naive(createdAt)})`;
  return opId;
}

// ── Synthetic Shopify evidence (the shapes the pinned documents request) ───

export interface R2Evidence {
  readonly sourceOrderId: string;
  readonly primaryOrderId: string;
  readonly captureTxnId: string;
  readonly authTxnId: string;
  /** The secondary's display name embedded in the evaluator evidence. */
  readonly secondaryName: string;
  readonly currency: string;
  /** The shipping amount the customer paid (the refund target). */
  readonly shippingAmount: string;
  /** The successful capture's amount — must cover the refund. */
  readonly captureAmount: string;
  /** suggestedRefund.maximumRefundableSet — must cover the refund. */
  readonly maxRefundable: string;
  readonly cancelledAt: string;
  readonly closedAt: string;
}

export const defaultR2Evidence = (ids: {
  sourceOrderId: string;
  primaryOrderId: string;
  captureTxnId: string;
  authTxnId: string;
}): R2Evidence => ({
  ...ids,
  secondaryName: `#${ids.sourceOrderId.split("/").pop()}`,
  currency: "USD",
  shippingAmount: "4.00",
  captureAmount: "18.00",
  maxRefundable: "18.00",
  cancelledAt: R2_OPERATION_AT,
  closedAt: R2_OPERATION_AT,
});

const transactionsFor = (ev: R2Evidence) => [
  {
    id: ev.authTxnId,
    kind: "AUTHORIZATION",
    status: "SUCCESS",
    gateway: "bogus",
    test: true,
    amountSet: PM(ev.captureAmount, ev.currency),
    parentTransaction: null,
  },
  {
    id: ev.captureTxnId,
    kind: "CAPTURE",
    status: "SUCCESS",
    gateway: "bogus",
    test: true,
    amountSet: PM(ev.captureAmount, ev.currency),
    parentTransaction: { id: ev.authTxnId },
  },
];

/** `data` for the evaluator's order query (ShippingShadowSource). */
export function r2ShadowOrderBody(ev: R2Evidence) {
  return {
    order: {
      id: ev.sourceOrderId,
      name: ev.secondaryName,
      test: true,
      cancelledAt: ev.cancelledAt,
      closedAt: ev.closedAt,
      closed: true,
      displayFinancialStatus: "PAID",
      currencyCode: ev.currency,
      presentmentCurrencyCode: ev.currency,
      taxesIncluded: false,
      totalRefundedShippingSet: PM("0.00", ev.currency),
      totalRefundedSet: PM("0.00", ev.currency),
      shippingLines: {
        nodes: [
          {
            title: "Standard",
            originalPriceSet: PM(ev.shippingAmount, ev.currency),
            discountedPriceSet: PM(ev.shippingAmount, ev.currency),
            taxLines: [],
          },
        ],
        pageInfo: { hasNextPage: false },
      },
      refunds: [],
      transactions: transactionsFor(ev),
    },
  };
}

/** `data` for the evaluator's preview query (ShippingShadowPreview):
 *  a clean suggested refund covering exactly the paid shipping. */
export function r2ShadowPreviewBody(ev: R2Evidence) {
  return {
    order: {
      suggestedRefund: {
        amountSet: PM(ev.shippingAmount, ev.currency),
        maximumRefundableSet: PM(ev.maxRefundable, ev.currency),
        shipping: {
          amountSet: PM(ev.shippingAmount, ev.currency),
          taxSet: PM("0.00", ev.currency),
          maximumRefundableSet: PM(ev.shippingAmount, ev.currency),
        },
        suggestedTransactions: [
          {
            kind: "SUGGESTED_REFUND",
            gateway: "bogus",
            amountSet: PM(ev.shippingAmount, ev.currency),
            parentTransaction: {
              id: ev.captureTxnId,
              kind: "CAPTURE",
              status: "SUCCESS",
              gateway: "bogus",
              test: true,
            },
          },
        ],
      },
    },
  };
}

/** `data` for Q-RECHECK (ShippingRefundExecRecheck): the empty-baseline
 *  cancelled+paid source and the untouched primary. */
export function r2RecheckBody(ev: R2Evidence) {
  return {
    source: {
      id: ev.sourceOrderId,
      cancelledAt: ev.cancelledAt,
      closed: true,
      displayFinancialStatus: "PAID",
      currencyCode: ev.currency,
      totalRefundedSet: PM("0.00", ev.currency),
      totalRefundedShippingSet: PM("0.00", ev.currency),
      refunds: [] as { id: string }[],
      transactions: transactionsFor(ev),
    },
    primary: {
      id: ev.primaryOrderId,
      cancelledAt: null,
      displayFinancialStatus: "PAID",
      currencyCode: ev.currency,
    },
  };
}

/** One `data.nodes[]` element for Q-REFUND-DETAIL: a complete, valid
 *  external refund node. `note` carries whatever marker text the scenario
 *  needs (the own-marker scenarios pass a MS-SHIPREFUND- string). */
export function r2RefundDetailNode(ev: R2Evidence, refund: {
  id: string;
  note: string | null;
  total?: string;
  txnId?: string;
}) {
  return {
    id: refund.id,
    note: refund.note,
    createdAt: "2030-01-07T00:00:00Z",
    processedAt: "2030-01-07T00:00:00Z",
    order: { id: ev.sourceOrderId },
    totalRefundedSet: PM(refund.total ?? ev.shippingAmount, ev.currency),
    duties: [],
    refundShippingLines: {
      nodes: [
        {
          subtotalAmountSet: PM(refund.total ?? ev.shippingAmount, ev.currency),
          taxAmountSet: PM("0.00", ev.currency),
        },
      ],
      pageInfo: { hasNextPage: false },
    },
    refundLineItems: { nodes: [], pageInfo: { hasNextPage: false } },
    orderAdjustments: { nodes: [], pageInfo: { hasNextPage: false } },
    transactions: {
      nodes: [
        {
          id: refund.txnId ?? `gid://shopify/OrderTransaction/${refund.id.split("/").pop()}1`,
          kind: "REFUND",
          status: "SUCCESS",
          gateway: "bogus",
          test: true,
          amountSet: PM(refund.total ?? ev.shippingAmount, ev.currency),
          parentTransaction: { id: ev.captureTxnId },
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  };
}

// ── The routing fake admin ────────────────────────────────────────────────

export interface R2AdminHandlers {
  /** Returns the `data` payload for each pinned document — may throw. */
  recheck?: (vars: Record<string, unknown>) => unknown | Promise<unknown>;
  detail?: (vars: Record<string, unknown>) => unknown | Promise<unknown>;
  order?: (vars: Record<string, unknown>) => unknown | Promise<unknown>;
  preview?: (vars: Record<string, unknown>) => unknown | Promise<unknown>;
  /** Returns the full response body for the pinned mutation document. */
  mutation?: (vars: Record<string, unknown>) => unknown | Promise<unknown>;
}

export interface R2Admin {
  readonly admin: AdminClient;
  readonly calls: { doc: string; variables: Record<string, unknown> | undefined }[];
  /** The variables of every mutation-document call (the actual sends). */
  readonly sentVariables: Record<string, unknown>[];
  readonly mutationCalls: () => number;
  readonly allCalls: () => number;
}

/** Wrap a handler result so the fake admin returns it as the RAW response
 *  body instead of wrapping it in `{ data: ... }` — for top-level-error
 *  and malformed-body scenarios. */
export const r2Raw = (body: unknown) => ({ __r2raw: body });

/** An AdminClient that routes by the exact pinned documents (the shadow
 *  evaluator's module-private documents match on their operation names)
 *  and records every call and every mutation send. */
export function r2RoutingAdmin(handlers: R2AdminHandlers): R2Admin {
  const calls: R2Admin["calls"] = [];
  const sentVariables: R2Admin["sentVariables"] = [];
  let mutationCalls = 0;
  const admin = {
    graphql: async (doc: string, options?: { variables?: Record<string, unknown> }) => {
      calls.push({ doc, variables: options?.variables });
      const vars = options?.variables ?? {};
      if (doc === shippingRefundMutationDocument()) {
        mutationCalls += 1;
        sentVariables.push(vars);
        return { json: async () => (await handlers.mutation?.(vars)) ?? {} };
      }
      let data: unknown;
      if (doc === Q_RECHECK.document) data = await handlers.recheck?.(vars);
      else if (doc === Q_REFUND_DETAIL.document) data = await handlers.detail?.(vars);
      else if (doc.includes("ShippingShadowSource")) data = await handlers.order?.(vars);
      else if (doc.includes("ShippingShadowPreview") || doc.includes("suggestedRefund")) {
        data = await handlers.preview?.(vars);
      }
      if (data !== null && typeof data === "object" && "__r2raw" in (data as object)) {
        const raw = (data as { __r2raw: unknown }).__r2raw;
        return { json: async () => raw };
      }
      return { json: async () => ({ data }) };
    },
  } as unknown as AdminClient;
  return {
    admin,
    calls,
    sentVariables,
    mutationCalls: () => mutationCalls,
    allCalls: () => calls.length,
  };
}

/** The mutation payload's top-level field, read off the pinned document
 *  at runtime (the literal name may not appear in this file). */
const MUTATION_FIELD =
  shippingRefundMutationDocument().match(/(\w+)\(input: \$input\)/)?.[1] ??
  "unreachable";

/** The standard fixture-backed admin: consistent evidence everywhere,
 *  mutation accepted with the given (or a fresh) refund id. */
export function r2HappyAdmin(ev: R2Evidence, refundId: string): R2Admin {
  return r2RoutingAdmin({
    recheck: () => r2RecheckBody(ev),
    order: () => r2ShadowOrderBody(ev),
    preview: () => r2ShadowPreviewBody(ev),
    mutation: () => ({
      data: {
        [MUTATION_FIELD]: {
          refund: { id: refundId, createdAt: "2030-01-07T00:00:00Z" },
          userErrors: [],
        },
      },
    }),
  });
}

// ── The PREPARED row, seeded through the REAL pipeline ─────────────────────

export interface SeedR2RowResult {
  readonly id: string;
  readonly shop: string;
  readonly idempotencyKey: string;
  readonly marker: string;
  readonly mergeOperationId: string;
  readonly sourceOrderId: string;
  readonly primaryOrderId: string;
  readonly primaryOrderName: string;
  readonly captureTxnId: string;
  readonly authTxnId: string;
  readonly evidence: R2Evidence;
  readonly wireVariables: unknown;
  readonly wireHash: string;
}

/**
 * Seed a PREPARED EXECUTE row by driving the real R1 pipeline: the shadow
 * evaluator over the fixture evidence, the freeze adapter for the contract,
 * and the real recheck analyzer for the baseline — then the ordinary
 * QUEUED insert and the QUEUED -> PREPARED update, exactly the path the
 * §8.3 freeze takes (no trigger is bypassed). `preparedOverrides` may
 * substitute individual frozen columns in that update — the only way to
 * seed the integrity cases the SQL CHECKs still allow (a foreign-but-valid
 * documentSha256 or wireHash).
 */
export async function seedPreparedR2Row(
  db: PrismaClient,
  seed: {
    shop: string;
    mergeOperationId: string;
    evidence?: Partial<R2Evidence> & Pick<R2Evidence, "sourceOrderId" | "primaryOrderId" | "captureTxnId" | "authTxnId">;
    primaryOrderName?: string;
    approvedHash?: boolean;
    preparedOverrides?: {
      documentSha256?: string;
      wireHash?: string;
      mutationVersion?: string | null;
      currencyCode?: string;
      plannedShippingMinor?: string;
      parentTransactionId?: string;
      gateway?: string;
      preEvidence?: unknown;
      /** Backdates preparedAt at the write-once point (NULL -> value), for
       *  capacity-wait ageing scenarios. ISO instant. */
      preparedAt?: string;
    };
  },
): Promise<SeedR2RowResult> {
  const ev = { ...defaultR2Evidence(seed.evidence!), ...seed.evidence } as R2Evidence;
  const primaryOrderName = seed.primaryOrderName ?? "#P1";
  const key = generateIdempotencyKey();
  const marker = generateMarker();

  // The real R1 evaluator over the synthetic evidence — the READY outcome
  // and its payload must be what production would produce for this row.
  const seedAdmin = r2RoutingAdmin({
    order: () => r2ShadowOrderBody(ev),
    preview: () => r2ShadowPreviewBody(ev),
  });
  const outcome = await evaluateShadowSource(readOnlyAdmin(seedAdmin.admin), {
    sourceOrderId: ev.sourceOrderId,
    policy: { kind: "REFUND_ALL" },
    marker,
    primaryOrderName,
  });
  if (outcome.kind !== "READY") {
    throw new Error(`seed evaluator did not return READY: ${JSON.stringify(outcome)}`);
  }
  const bindings: FreezeBindings = {
    sourceOrderId: ev.sourceOrderId,
    parentTransactionId: ev.captureTxnId,
    gateway: "bogus",
    currencyCode: ev.currency,
    marker,
    idempotencyKey: key,
    primaryOrderName,
    plannedShippingMinor: outcome.plannedRefundMinor,
  };
  const adapted = adaptReadyToFreezeContract(outcome, bindings);
  if (!adapted.ok) {
    throw new Error(`seed freeze adapter refused: ${adapted.reason}`);
  }

  // The real recheck analysis -> baseline -> preEvidence (8.2.2/8.2.6).
  const analysis = analyzeExecRecheck(
    { data: r2RecheckBody(ev) },
    { sourceOrderId: ev.sourceOrderId, primaryOrderId: ev.primaryOrderId },
  );
  if (!analysis.ok) {
    throw new Error(`seed recheck analysis failed: ${analysis.reasonCode} ${analysis.reason}`);
  }
  const baseline = buildRefundBaseline({
    capturedAt: R2_OPERATION_AT,
    currency: analysis.evidence.currencyCode,
    evidence: analysis.evidence,
  });
  const preEvidence = buildPreEvidence({ evidence: analysis.evidence, baseline });

  const id = `sr_${randomUUID().replace(/-/g, "")}`;
  const { E1, E2, E3, E4, E5 } = R2_EPOCHS;
  await db.$executeRaw`
    INSERT INTO "ShippingRefund" (
      "id","shop","mergeOperationId","sourceOrderId","primaryOrderId","primaryOrderName",
      "operationCreatedAt","sourceCancelledAt","lane","status",
      "merchantEpochAt","rolloutEpochAt","switchEpochAt","activationCutoffAt",
      "admissionEpochAt","admissionCutoffAt","dispatchEpochAtAdmission",
      "approvalApprovedAt","approvalOptInEpoch","approvalAckVersion",
      "policyKind","idempotencyKey","marker"
    ) VALUES (
      ${id}, ${seed.shop}, ${seed.mergeOperationId}, ${ev.sourceOrderId}, ${ev.primaryOrderId}, ${primaryOrderName},
      ${naive(R2_OPERATION_AT)},
      ${naive(ev.cancelledAt)}, 'EXECUTE', 'QUEUED',
      ${naive(E1)}, ${naive(E2)}, ${naive(E3)}, ${naive(E3)},
      ${naive(E4)}, ${naive(E5)}, ${naive(E5)},
      ${naive(E5)}, ${naive(E1)},
      'v1', 'REFUND_ALL', ${key}, ${marker}
    )`;
  const ov = seed.preparedOverrides ?? {};
  await db.$executeRaw`
    UPDATE "ShippingRefund" SET
      "status" = 'PREPARED',
      "preparedAt" = ${ov.preparedAt !== undefined ? naive(ov.preparedAt) : Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC')`},
      "wireVariables" = ${JSON.stringify(adapted.contract.wireVariables)}::jsonb,
      "wireHash" = ${ov.wireHash ?? adapted.contract.wireHash},
      "documentSha256" = ${ov.documentSha256 ?? adapted.contract.documentSha256},
      "mutationVersion" = ${"mutationVersion" in ov ? ov.mutationVersion : REFUND_MUTATION_VERSION},
      "currencyCode" = ${ov.currencyCode ?? adapted.financialColumns.currencyCode},
      "plannedShippingMinor" = ${ov.plannedShippingMinor ?? adapted.financialColumns.plannedShippingMinor},
      "parentTransactionId" = ${ov.parentTransactionId ?? adapted.financialColumns.parentTransactionId},
      "gateway" = ${ov.gateway ?? adapted.financialColumns.gateway},
      "preEvidence" = ${JSON.stringify(ov.preEvidence ?? preEvidence)}::jsonb
    WHERE "id" = ${id}`;
  if (seed.approvedHash) {
    const ok = await recordApprovedWireHash(id, ov.wireHash ?? adapted.contract.wireHash, "r2-test", db);
    if (!ok) throw new Error("seed hash approval failed");
  }
  return {
    id,
    shop: seed.shop,
    idempotencyKey: key,
    marker,
    mergeOperationId: seed.mergeOperationId,
    sourceOrderId: ev.sourceOrderId,
    primaryOrderId: ev.primaryOrderId,
    primaryOrderName,
    captureTxnId: ev.captureTxnId,
    authTxnId: ev.authTxnId,
    evidence: ev,
    wireVariables: adapted.contract.wireVariables,
    wireHash: adapted.contract.wireHash,
  };
}
