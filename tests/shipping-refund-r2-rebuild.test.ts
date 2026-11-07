// §8.4 R2 parity — pure half, no database:
//   - compareRebuiltToFrozen: every field of the rebuilt-vs-frozen
//     comparison, in order, failing closed on NULL frozen values;
//   - checkFrozenWireIntegrity: the row-level frozen-column checks the
//     SQL CHECKs make physically uninsertable (a wire key differing from
//     the row key, a non-REFUND_ALL policyKind);
//   - the archived S3 run-3 frozen wire request: its real wireHash
//     recomputes under the current pin, and a SYNTHETIC evaluator fixture
//     built from the archived run-3 ids/amounts/marker/key drives the real
//     evaluateShadowSource + adaptReadyToFreezeContract into a contract
//     that compares equal to the archived freeze — plus the perturbations
//     that must break parity.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareRebuiltToFrozen,
  adaptReadyToFreezeContract,
  type FreezeBindings,
} from "../app/lib/shipping-refund-freeze-contract";
import { checkFrozenWireIntegrity } from "../app/lib/shipping-refund-worker.server";
import {
  buildRefundInput,
  buildWireVariables,
  computeWireHash,
  REFUND_DOCUMENT_SHA256,
  REFUND_MUTATION_VERSION,
  shippingRefundMutationDocument,
} from "../app/lib/shipping-refund-contract";
import { evaluateShadowSource, readOnlyAdmin } from "../app/lib/shipping-shadow.server";
import type { AdminClient } from "../app/lib/graphql.server";

const OTHER_64HEX = "0".repeat(64);

// A valid rebuilt value produced by the real adapter machinery is needed
// for several cases; build it once from the contract builders (the wire
// variables' note template is irrelevant to the comparison itself).
const SOURCE = "gid://shopify/Order/8143926624503";
const CAPTURE = "gid://shopify/OrderTransaction/10262841229559";
const KEY = "63d6dbac-d6e6-4b31-9014-e2c5e877e71d";
const MARKER = "MS-SHIPREFUND-4d854578-911b-4960-957d-8d34069d2be0";

const input = buildRefundInput({
  sourceOrderId: SOURCE,
  parentTransactionId: CAPTURE,
  gateway: "bogus",
  plannedShippingMinor: "400",
  currencyCode: "USD",
  marker: MARKER,
});
const wireVariables = buildWireVariables(KEY, input);
const rebuiltBase = {
  contract: {
    documentSha256: REFUND_DOCUMENT_SHA256,
    mutationVersion: REFUND_MUTATION_VERSION,
    wireVariables,
    wireHash: computeWireHash(REFUND_DOCUMENT_SHA256, wireVariables),
  },
  financialColumns: {
    currencyCode: "USD",
    plannedShippingMinor: "400",
    parentTransactionId: CAPTURE,
    gateway: "bogus",
  },
};
const frozenBase = {
  documentSha256: REFUND_DOCUMENT_SHA256 as string | null,
  wireHash: rebuiltBase.contract.wireHash as string | null,
  wireVariables: rebuiltBase.contract.wireVariables as unknown,
  currencyCode: "USD" as string | null,
  plannedShippingMinor: "400" as string | null,
  parentTransactionId: CAPTURE as string | null,
  gateway: "bogus" as string | null,
};

describe("compareRebuiltToFrozen (8.4 R2 parity)", () => {
  it("equal when every field matches", () => {
    expect(compareRebuiltToFrozen(rebuiltBase, frozenBase)).toEqual({ equal: true });
  });

  it("mismatches on a rebuilt document pin that is not this build's", () => {
    const rebuilt = {
      ...rebuiltBase,
      contract: { ...rebuiltBase.contract, documentSha256: OTHER_64HEX },
    };
    expect(compareRebuiltToFrozen(rebuilt, frozenBase)).toMatchObject({
      equal: false,
      field: "documentSha256",
    });
  });

  it("mismatches on a frozen documentSha256 that is not this build's pin, and on a NULL one", () => {
    expect(
      compareRebuiltToFrozen(rebuiltBase, { ...frozenBase, documentSha256: OTHER_64HEX }),
    ).toMatchObject({ equal: false, field: "documentSha256" });
    expect(
      compareRebuiltToFrozen(rebuiltBase, { ...frozenBase, documentSha256: null }),
    ).toMatchObject({ equal: false, field: "documentSha256" });
  });

  it("mismatches on currencyCode, plannedShippingMinor, parentTransactionId and gateway", () => {
    expect(
      compareRebuiltToFrozen(rebuiltBase, { ...frozenBase, currencyCode: "EUR" }),
    ).toMatchObject({ equal: false, field: "currencyCode" });
    expect(
      compareRebuiltToFrozen(rebuiltBase, { ...frozenBase, plannedShippingMinor: "500" }),
    ).toMatchObject({ equal: false, field: "plannedShippingMinor" });
    expect(
      compareRebuiltToFrozen(rebuiltBase, {
        ...frozenBase,
        parentTransactionId: "gid://shopify/OrderTransaction/9",
      }),
    ).toMatchObject({ equal: false, field: "parentTransactionId" });
    expect(
      compareRebuiltToFrozen(rebuiltBase, { ...frozenBase, gateway: "manual" }),
    ).toMatchObject({ equal: false, field: "gateway" });
  });

  it("fails closed on NULL frozen financial columns", () => {
    for (const field of ["currencyCode", "plannedShippingMinor", "parentTransactionId", "gateway"] as const) {
      expect(
        compareRebuiltToFrozen(rebuiltBase, { ...frozenBase, [field]: null }),
        field,
      ).toMatchObject({ equal: false, field });
    }
  });

  it("mismatches on differing wire variables (canonical JSON), including a NULL frozen value", () => {
    const tampered = {
      ...wireVariables,
      input: { ...wireVariables.input, currency: "EUR" },
    };
    expect(
      compareRebuiltToFrozen(rebuiltBase, { ...frozenBase, wireVariables: tampered }),
    ).toMatchObject({ equal: false, field: "wireVariables" });
    expect(
      compareRebuiltToFrozen(rebuiltBase, { ...frozenBase, wireVariables: null }),
    ).toMatchObject({ equal: false, field: "wireVariables" });
  });

  it("mismatches on a different frozen wireHash (and a NULL one), after variables matched", () => {
    expect(
      compareRebuiltToFrozen(rebuiltBase, { ...frozenBase, wireHash: OTHER_64HEX }),
    ).toMatchObject({ equal: false, field: "wireHash" });
    expect(
      compareRebuiltToFrozen(rebuiltBase, { ...frozenBase, wireHash: null }),
    ).toMatchObject({ equal: false, field: "wireHash" });
  });

  it("reports the FIRST mismatch in the documented order", () => {
    expect(
      compareRebuiltToFrozen(rebuiltBase, {
        ...frozenBase,
        currencyCode: "EUR",
        gateway: "manual",
        wireHash: OTHER_64HEX,
      }),
    ).toMatchObject({ equal: false, field: "currencyCode" });
    expect(
      compareRebuiltToFrozen(rebuiltBase, {
        documentSha256: null,
        currencyCode: null,
        plannedShippingMinor: null,
        parentTransactionId: null,
        gateway: null,
        wireVariables: null,
        wireHash: null,
      }),
    ).toMatchObject({ equal: false, field: "documentSha256" });
  });
});

describe("checkFrozenWireIntegrity (8.4; the cases the SQL CHECKs cannot contain)", () => {
  it("refuses a wireVariables.idempotencyKey that differs from the row key", () => {
    // ShippingRefund_wire_idempotencyKey makes this row uninsertable, so it
    // is driven through the exported check directly (see the PG suite).
    const badVars = buildWireVariables("00000000-0000-4000-8000-000000000001", input);
    expect(
      checkFrozenWireIntegrity({
        documentSha256: REFUND_DOCUMENT_SHA256,
        wireHash: computeWireHash(REFUND_DOCUMENT_SHA256, badVars),
        wireVariables: badVars,
        idempotencyKey: KEY,
        policyKind: "REFUND_ALL",
      }),
    ).toMatchObject({ ok: false, reasonCode: "WIRE_HASH_MISMATCH" });
  });

  it("refuses a non-REFUND_ALL policyKind and a foreign document pin", () => {
    expect(
      checkFrozenWireIntegrity({
        documentSha256: REFUND_DOCUMENT_SHA256,
        wireHash: rebuiltBase.contract.wireHash,
        wireVariables,
        idempotencyKey: KEY,
        policyKind: "RETAIN_FIXED",
      }),
    ).toMatchObject({ ok: false, reasonCode: "POLICY_CHANGED" });
    expect(
      checkFrozenWireIntegrity({
        documentSha256: OTHER_64HEX,
        wireHash: rebuiltBase.contract.wireHash,
        wireVariables,
        idempotencyKey: KEY,
        policyKind: "REFUND_ALL",
      }),
    ).toMatchObject({ ok: false, reasonCode: "DOCUMENT_CHANGED" });
    expect(
      checkFrozenWireIntegrity({
        documentSha256: null,
        wireHash: rebuiltBase.contract.wireHash,
        wireVariables,
        idempotencyKey: KEY,
        policyKind: "REFUND_ALL",
      }),
    ).toMatchObject({ ok: false, reasonCode: "DOCUMENT_CHANGED" });
  });

  it("refuses malformed wire variables and a wrong wireHash", () => {
    expect(
      checkFrozenWireIntegrity({
        documentSha256: REFUND_DOCUMENT_SHA256,
        wireHash: rebuiltBase.contract.wireHash,
        wireVariables: { idempotencyKey: KEY, input: { bogus: true } },
        idempotencyKey: KEY,
        policyKind: "REFUND_ALL",
      }),
    ).toMatchObject({ ok: false, reasonCode: "WIRE_HASH_MISMATCH" });
    expect(
      checkFrozenWireIntegrity({
        documentSha256: REFUND_DOCUMENT_SHA256,
        wireHash: OTHER_64HEX,
        wireVariables,
        idempotencyKey: KEY,
        policyKind: "REFUND_ALL",
      }),
    ).toMatchObject({ ok: false, reasonCode: "WIRE_HASH_MISMATCH" });
  });

  it("accepts the intact frozen row shape", () => {
    expect(
      checkFrozenWireIntegrity({
        documentSha256: REFUND_DOCUMENT_SHA256,
        wireHash: rebuiltBase.contract.wireHash,
        wireVariables,
        idempotencyKey: KEY,
        policyKind: "REFUND_ALL",
      }),
    ).toEqual({ ok: true });
  });
});

// ── Archived S3 run 3: the real frozen wire request ───────────────────────
// docs/evidence/shipping-v0-s3-run3/r3-24-frozen-wire.json is the REAL
// PREPARED row dump from the S3 staged run (order #1138 on
// ordermergetest2): frozen wireVariables + wireHash b25ed957….
// docs/evidence/shipping-v0-s3-run3-execution/x-03-shopify-1138-pre-dispatch.json
// is the real pre-dispatch order read — it supplies the REAL transaction
// ids, kinds, statuses and the 604.0 capture amount used below; its
// `shopMoney` money shape is NOT what the pinned documents request
// (`presentmentMoney`), so the evaluator responses here are synthetic
// fixtures built from those archived real values — the archive holds no
// raw ShippingShadowSource/ShippingShadowPreview responses.

const RUN3 = JSON.parse(
  readFileSync(
    join(__dirname, "../docs/evidence/shipping-v0-s3-run3/r3-24-frozen-wire.json"),
    "utf8",
  ),
) as {
  wireHash: string;
  wireVariables: unknown;
  idempotencyKey: string;
};

const RUN3_IDS = {
  sourceOrderId: "gid://shopify/Order/8143926624503", // order #1138
  primaryOrderId: "gid://shopify/Order/8143926591735",
  captureTxnId: "gid://shopify/OrderTransaction/10262841229559",
  authTxnId: "gid://shopify/OrderTransaction/10262841098487",
};
const RUN3_MARKER = "MS-SHIPREFUND-4d854578-911b-4960-957d-8d34069d2be0";
const RUN3_PRIMARY_NAME = "#1137";

interface Run3Opts {
  shippingAmount?: string;
  currency?: string;
  marker?: string;
  idempotencyKey?: string;
  captureTxnId?: string;
}

/** The synthetic ShippingShadowSource/ShippingShadowPreview responses,
 *  built from the archived run-3 values (see the provenance note above). */
function run3Admin(o: Run3Opts = {}): AdminClient {
  const currency = o.currency ?? "USD";
  const shipping = o.shippingAmount ?? "4.00";
  const capture = o.captureTxnId ?? RUN3_IDS.captureTxnId;
  const pm = (amount: string) => ({ presentmentMoney: { amount, currencyCode: currency } });
  const order = {
    id: RUN3_IDS.sourceOrderId,
    name: "#1138",
    test: true,
    cancelledAt: "2026-11-05T15:04:13Z",
    closedAt: "2026-11-05T15:04:13Z",
    closed: true,
    displayFinancialStatus: "PAID",
    currencyCode: currency,
    presentmentCurrencyCode: currency,
    taxesIncluded: false,
    totalRefundedShippingSet: pm("0.00"),
    totalRefundedSet: pm("0.00"),
    shippingLines: {
      nodes: [
        {
          title: "S3 Test Shipping",
          originalPriceSet: pm(shipping),
          discountedPriceSet: pm(shipping),
          taxLines: [],
        },
      ],
      pageInfo: { hasNextPage: false },
    },
    refunds: [],
    transactions: [
      {
        id: RUN3_IDS.authTxnId,
        kind: "AUTHORIZATION",
        status: "SUCCESS",
        gateway: "bogus",
        test: true,
        amountSet: pm("604.00"),
        parentTransaction: null,
      },
      {
        id: capture,
        kind: "CAPTURE",
        status: "SUCCESS",
        gateway: "bogus",
        test: true,
        amountSet: pm("604.00"),
        parentTransaction: { id: RUN3_IDS.authTxnId },
      },
    ],
  };
  const preview = {
    suggestedRefund: {
      amountSet: pm(shipping),
      maximumRefundableSet: pm("604.00"),
      shipping: {
        amountSet: pm(shipping),
        taxSet: pm("0.00"),
        maximumRefundableSet: pm(shipping),
      },
      suggestedTransactions: [
        {
          kind: "SUGGESTED_REFUND",
          gateway: "bogus",
          amountSet: pm(shipping),
          parentTransaction: {
            id: capture,
            kind: "CAPTURE",
            status: "SUCCESS",
            gateway: "bogus",
            test: true,
          },
        },
      ],
    },
  };
  return {
    graphql: async (doc: string) => ({
      json: async () => ({
        data: doc.includes("suggestedRefund") ? { order: preview } : { order },
      }),
    }),
  } as unknown as AdminClient;
}

async function run3Adapt(o: Run3Opts = {}) {
  const outcome = await evaluateShadowSource(readOnlyAdmin(run3Admin(o)), {
    sourceOrderId: RUN3_IDS.sourceOrderId,
    policy: { kind: "REFUND_ALL" },
    marker: o.marker ?? RUN3_MARKER,
    primaryOrderName: RUN3_PRIMARY_NAME,
  });
  if (outcome.kind !== "READY") {
    throw new Error(`run-3 fixture did not produce READY: ${JSON.stringify(outcome)}`);
  }
  const currency = o.currency ?? "USD";
  const bindings: FreezeBindings = {
    sourceOrderId: RUN3_IDS.sourceOrderId,
    parentTransactionId: o.captureTxnId ?? RUN3_IDS.captureTxnId,
    gateway: "bogus",
    currencyCode: currency,
    marker: o.marker ?? RUN3_MARKER,
    idempotencyKey: o.idempotencyKey ?? RUN3.idempotencyKey,
    primaryOrderName: RUN3_PRIMARY_NAME,
    plannedShippingMinor: outcome.plannedRefundMinor,
  };
  const adapted = adaptReadyToFreezeContract(outcome, bindings);
  return { outcome, adapted };
}

const run3Frozen = () => ({
  documentSha256: REFUND_DOCUMENT_SHA256 as string | null,
  wireHash: RUN3.wireHash as string | null,
  wireVariables: RUN3.wireVariables,
  currencyCode: "USD" as string | null,
  plannedShippingMinor: "400" as string | null,
  parentTransactionId: RUN3_IDS.captureTxnId as string | null,
  gateway: "bogus" as string | null,
});

describe("S3 run-3 archived wire request (real artifact + synthetic evaluator fixture)", () => {
  it("the archived wireHash recomputes exactly under this build's pin", () => {
    expect(RUN3.wireHash).toBe("b25ed9574e16123b44943b98c41b2eae3c6da1d78ef436e029661fdba5f4c327");
    expect(
      computeWireHash(REFUND_DOCUMENT_SHA256, RUN3.wireVariables as never),
    ).toBe(RUN3.wireHash);
    // The document pin is the hash of the text sendRefund would send.
    expect(shippingRefundMutationDocument().length).toBeGreaterThan(0);
  });

  it("the real evaluator + adapter rebuild a contract equal to the archived freeze", async () => {
    // Synthetic fixture from archived run-3 values (the archive holds no
    // raw evaluator responses — see the provenance note above).
    const { adapted } = await run3Adapt();
    if (!adapted.ok) throw new Error(`adaptation refused: ${adapted.reason}`);
    expect(adapted.contract.wireHash).toBe(RUN3.wireHash);
    expect(adapted.contract.wireVariables).toEqual(RUN3.wireVariables);
    expect(compareRebuiltToFrozen(adapted, run3Frozen())).toEqual({ equal: true });
  });

  it("a changed shipping amount rebuilds a DIFFERENT contract (parity fails)", async () => {
    const { adapted } = await run3Adapt({ shippingAmount: "5.00" });
    if (!adapted.ok) throw new Error(`adaptation refused: ${adapted.reason}`);
    expect(compareRebuiltToFrozen(adapted, run3Frozen())).toMatchObject({
      equal: false,
      field: "plannedShippingMinor",
    });
  });

  it("a changed parent transaction fails parity on parentTransactionId", async () => {
    const other = "gid://shopify/OrderTransaction/10262841000000";
    const { adapted } = await run3Adapt({ captureTxnId: other });
    if (!adapted.ok) throw new Error(`adaptation refused: ${adapted.reason}`);
    expect(compareRebuiltToFrozen(adapted, run3Frozen())).toMatchObject({
      equal: false,
      field: "parentTransactionId",
    });
  });

  it("a changed currency fails parity on currencyCode", async () => {
    const { adapted } = await run3Adapt({ currency: "EUR" });
    if (!adapted.ok) throw new Error(`adaptation refused: ${adapted.reason}`);
    expect(compareRebuiltToFrozen(adapted, run3Frozen())).toMatchObject({
      equal: false,
      field: "currencyCode",
    });
  });

  it("a changed marker or key produces a valid-but-different wire request", async () => {
    const otherMarker = "MS-SHIPREFUND-00000000-0000-4000-8000-000000000001";
    const otherKey = "00000000-0000-4000-8000-000000000001";
    const m = await run3Adapt({ marker: otherMarker });
    if (!m.adapted.ok) throw new Error(`adaptation refused: ${m.adapted.reason}`);
    expect(compareRebuiltToFrozen(m.adapted, run3Frozen())).toMatchObject({
      equal: false,
      field: "wireVariables",
    });
    const k = await run3Adapt({ idempotencyKey: otherKey });
    if (!k.adapted.ok) throw new Error(`adaptation refused: ${k.adapted.reason}`);
    expect(compareRebuiltToFrozen(k.adapted, run3Frozen())).toMatchObject({
      equal: false,
      field: "wireVariables",
    });
  });
});
