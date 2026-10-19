// Tests for the evaluator-READY → frozen wire contract adapter (S1-B2A).
// M-7: the evaluator's verbatim requestPayload is authoritative; the adapter
// proves equivalence field by field and never regenerates the note or any
// financial value.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson, evaluateShadowSource, minorToDecimal, readOnlyAdmin } from "../app/lib/shipping-shadow.server";
import type { AdminClient } from "../app/lib/graphql.server";
import {
  REFUND_DOCUMENT_SHA256,
  REFUND_MUTATION_VERSION,
  buildRefundNote,
  computeWireHash,
  sha256Hex,
} from "../app/lib/shipping-refund-contract";
import {
  adaptReadyToFreezeContract,
  type FreezeBindings,
} from "../app/lib/shipping-refund-freeze-contract";

const KEY = "123e4567-e89b-42d3-a456-426614174000";
const SOURCE_GID = "gid://shopify/Order/4002";
const PARENT_TXN = "gid://shopify/OrderTransaction/9001";
const AUTH_TXN = "gid://shopify/OrderTransaction/9000";
const PRIMARY_NAME = "#1001";
const MARKER = `MS-SHIPREFUND-${KEY}`;

const EVALUATOR_NOTE = `MergeShip shipping adjustment ${MARKER} — shipping refunded for order merged into ${PRIMARY_NAME}.`;

/** A READY result modeled exactly on evaluateShadowSource's construction
 *  (requestPayload, previewEvidence and requestHash mirror its fields). */
function makeReady(
  opts: { currencyCode?: string; amount?: string; minor?: string } = {},
): any {
  const currencyCode = opts.currencyCode ?? "USD";
  const amount = opts.amount ?? "0.50";
  const minor = opts.minor ?? "50";
  const requestPayload = {
    orderId: SOURCE_GID,
    notify: false,
    note: `MergeShip shipping adjustment ${MARKER} — shipping refunded for order merged into ${PRIMARY_NAME}.`,
    currency: currencyCode,
    shipping: { amount, fullRefund: false },
    transactions: [
      {
        orderId: SOURCE_GID,
        parentId: PARENT_TXN,
        gateway: "bogus",
        kind: "REFUND",
        amount,
      },
    ],
  };
  return {
    kind: "READY",
    sourceShippingMinor: "800",
    plannedRefundMinor: minor,
    currencyCode,
    previewEvidence: {
      order: {
        id: SOURCE_GID,
        name: "#4002",
        test: true,
        cancelledAt: "2030-01-05T10:00:00Z",
        closedAt: "2030-01-05T10:01:00Z",
        displayFinancialStatus: "PAID",
        currencyCode,
        presentmentCurrencyCode: currencyCode,
        taxesIncluded: false,
        shippingPaidMinor: "800",
        shippingOriginalMinor: "800",
        shippingTaxMinor: "0",
        refundedShippingMinor: "0",
        refundCount: 0,
        transactionCount: 2,
      },
      preview: {
        shippingMinor: minor,
        shippingTaxMinor: "0",
        totalMinor: minor,
        maxShippingMinor: "800",
        maxPaymentMinor: "5000",
        suggestedTransactionMinor: minor,
      },
      allocation: {
        parentTransactionId: PARENT_TXN,
        parentKind: "CAPTURE",
        parentStatus: "SUCCESS",
        parentTest: true,
        gateway: "bogus",
      },
    },
    requestPayload,
    requestHash: sha256Hex(canonicalJson(requestPayload)),
  };
}

function bindings(overrides: Partial<FreezeBindings> = {}): FreezeBindings {
  return {
    sourceOrderId: SOURCE_GID,
    parentTransactionId: PARENT_TXN,
    gateway: "bogus",
    currencyCode: "USD",
    marker: MARKER,
    idempotencyKey: KEY,
    primaryOrderName: PRIMARY_NAME,
    plannedShippingMinor: "50",
    ...overrides,
  };
}

const mutateReady = (mutate: (r: any) => void): any => {
  const r = makeReady();
  mutate(r);
  return r;
};
const mutatePayload = (mutate: (p: any) => void): any =>
  mutateReady((r) => {
    mutate(r.requestPayload);
    // Recompute the evaluator's hash so only the mutated field is tested —
    // a stale-hash refusal would hide the shape refusal under review.
    r.requestHash = sha256Hex(canonicalJson(r.requestPayload));
  });

describe("M-7 parity with the real evaluator (8.1)", () => {
  const MONEY = (amount: string, currencyCode = "USD") => ({ amount, currencyCode });
  const order = () => ({
    id: SOURCE_GID,
    name: "#4002",
    test: true,
    cancelledAt: "2030-01-05T10:00:00Z",
    closedAt: "2030-01-05T10:01:00Z",
    closed: true,
    displayFinancialStatus: "PAID",
    currencyCode: "USD",
    presentmentCurrencyCode: "USD",
    taxesIncluded: false,
    totalRefundedShippingSet: { presentmentMoney: MONEY("0.00") },
    totalRefundedSet: { presentmentMoney: MONEY("0.00") },
    shippingLines: {
      nodes: [
        {
          title: "Standard",
          originalPriceSet: { presentmentMoney: MONEY("8.00") },
          discountedPriceSet: { presentmentMoney: MONEY("8.00") },
          taxLines: [],
        },
      ],
      pageInfo: { hasNextPage: false },
    },
    refunds: [],
    transactions: [
      { id: AUTH_TXN, kind: "AUTHORIZATION", status: "SUCCESS", gateway: "bogus", test: true, amountSet: { presentmentMoney: MONEY("18.00") }, parentTransaction: null },
      { id: PARENT_TXN, kind: "CAPTURE", status: "SUCCESS", gateway: "bogus", test: true, amountSet: { presentmentMoney: MONEY("18.00") }, parentTransaction: { id: AUTH_TXN } },
    ],
  });
  const preview = () => ({
    suggestedRefund: {
      amountSet: { presentmentMoney: MONEY("8.00") },
      maximumRefundableSet: { presentmentMoney: MONEY("18.00") },
      shipping: {
        amountSet: { presentmentMoney: MONEY("8.00") },
        taxSet: { presentmentMoney: MONEY("0.00") },
        maximumRefundableSet: { presentmentMoney: MONEY("8.00") },
      },
      suggestedTransactions: [
        {
          kind: "SUGGESTED_REFUND",
          gateway: "bogus",
          amountSet: { presentmentMoney: MONEY("8.00") },
          parentTransaction: { id: PARENT_TXN, kind: "CAPTURE", status: "SUCCESS", gateway: "bogus", test: true },
        },
      ],
    },
  });
  const admin: AdminClient = {
    graphql: async (query: string) => ({
      json: async () => ({
        data: { order: query.includes("suggestedRefund") ? preview() : order() },
      }),
    }) as any,
  };

  it("adapts the evaluator's actual READY output verbatim, note included", async () => {
    const ready = await evaluateShadowSource(readOnlyAdmin(admin), {
      sourceOrderId: SOURCE_GID,
      policy: { kind: "REFUND_ALL" },
      marker: MARKER,
      primaryOrderName: PRIMARY_NAME,
    });
    expect(ready.kind).toBe("READY");
    const r = adaptReadyToFreezeContract(
      ready,
      bindings({ plannedShippingMinor: "800" }),
    );
    if (!r.ok) throw new Error(`refused a real READY: ${r.reason}`);
    const payload = (ready as any).requestPayload;
    // Field-by-field: the stored input IS the evaluator's payload.
    expect(r.contract.wireVariables.input).toEqual(payload);
    expect(r.contract.wireVariables.input.note).toBe(EVALUATOR_NOTE);
    expect(r.contract.wireVariables.idempotencyKey).toBe(KEY);
    expect(r.financialColumns).toEqual({
      currencyCode: "USD",
      plannedShippingMinor: "800",
      parentTransactionId: PARENT_TXN,
      gateway: "bogus",
    });
  });

  it("the evaluator's note template is still the text the adapter pins", () => {
    const src = readFileSync(
      join(__dirname, "../app/lib/shipping-shadow.server.ts"),
      "utf8",
    );
    // eslint-disable-next-line no-template-curly-in-string -- the pin is the evaluator's literal template text
    expect(src).toContain("note: `MergeShip shipping adjustment ${input.marker} — shipping refunded for order merged into ${input.primaryOrderName}.`");
  });
});

describe("positive cases", () => {
  it("preserves the evaluator's exact note and every field verbatim", () => {
    const ready = makeReady();
    const r = adaptReadyToFreezeContract(ready, bindings());
    if (!r.ok) throw new Error(r.reason);
    const input = r.contract.wireVariables.input;
    expect(input).toEqual(ready.requestPayload);
    expect(input.note).toBe(EVALUATOR_NOTE);
    expect(input.orderId).toBe(SOURCE_GID);
    expect(input.currency).toBe("USD");
    expect(input.notify).toBe(false);
    expect(input.shipping).toEqual({ amount: "0.50", fullRefund: false });
    expect(input.transactions).toEqual([
      { orderId: SOURCE_GID, parentId: PARENT_TXN, gateway: "bogus", kind: "REFUND", amount: "0.50" },
    ]);
    expect(r.contract.wireVariables).toEqual({ idempotencyKey: KEY, input });
    expect(r.contract.documentSha256).toBe(REFUND_DOCUMENT_SHA256);
    expect(r.contract.mutationVersion).toBe(REFUND_MUTATION_VERSION);
    // wireHash is the accepted formula over exactly these values.
    expect(r.contract.wireHash).toBe(
      computeWireHash(r.contract.documentSha256, r.contract.wireVariables),
    );
    expect(r.contract.wireHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic and identical on repetition", () => {
    const a = adaptReadyToFreezeContract(makeReady(), bindings());
    const b = adaptReadyToFreezeContract(makeReady(), bindings());
    if (!a.ok || !b.ok) throw new Error("refusal");
    expect(a.contract.wireHash).toBe(b.contract.wireHash);
    expect(a.contract.wireVariables).toEqual(b.contract.wireVariables);
  });

  it.each([
    ["JPY (0 decimals)", "JPY", "800", "800"],
    ["USD (2 decimals)", "USD", "800", "8.00"],
    ["JOD (3 decimals)", "JOD", "800", "0.800"],
    ["CLF (4 decimals)", "CLF", "800", "0.0800"],
  ])("accepts the exact-precision amount for %s", (_l, currencyCode, minor, amount) => {
    const r = adaptReadyToFreezeContract(
      makeReady({ currencyCode, minor, amount }),
      bindings({ currencyCode, plannedShippingMinor: minor }),
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.financialColumns.currencyCode).toBe(currencyCode);
  });

  it("tolerates a READY result without requestHash, but never a wrong one", () => {
    const ready = makeReady();
    delete ready.requestHash;
    expect(adaptReadyToFreezeContract(ready, bindings()).ok).toBe(true);
  });

  it("returns an immutable contract and never mutates its inputs", () => {
    const ready = makeReady();
    const snapshot = JSON.stringify(ready);
    const r = adaptReadyToFreezeContract(ready, bindings());
    if (!r.ok) throw new Error(r.reason);
    // The evaluator's object is untouched by the adaptation.
    expect(JSON.stringify(ready)).toBe(snapshot);
    const wire = r.contract.wireVariables;
    expect(Object.isFrozen(r.contract)).toBe(true);
    expect(Object.isFrozen(wire)).toBe(true);
    expect(Object.isFrozen(wire.input)).toBe(true);
    expect(Object.isFrozen(wire.input.shipping)).toBe(true);
    expect(Object.isFrozen(wire.input.transactions)).toBe(true);
    expect(Object.isFrozen(r.financialColumns)).toBe(true);
    // Mutating the caller's object afterwards cannot alter the contract.
    ready.requestPayload.note = "tampered";
    ready.requestPayload.shipping.amount = "99.99";
    expect(wire.input.note).toBe(EVALUATOR_NOTE);
    expect(wire.input.shipping.amount).toBe("0.50");
    // Mutating the frozen output itself fails in strict mode.
    expect(() => {
      (wire.input as any).note = "x";
    }).toThrow(TypeError);
    expect(() => {
      (wire as any).idempotencyKey = "x";
    }).toThrow(TypeError);
    // Re-validation of the stored input still passes after the copy.
    expect(computeWireHash(r.contract.documentSha256, wire)).toBe(r.contract.wireHash);
  });
});

describe("negative cases", () => {
  it.each([
    ["a SKIP result", { kind: "SKIP", reasonCode: "NOTHING_REFUNDABLE", reason: "x" }],
    ["a REVIEW result", { kind: "REVIEW", reason: "x" }],
    ["a null result", null],
    ["an array result", []],
    ["a non-object result", "READY"],
  ])("refuses %s", (_l, result) => {
    expect(adaptReadyToFreezeContract(result, bindings()).ok).toBe(false);
  });

  it("the S1-B1 builder's alternative note is refused, never silently kept", () => {
    const s1b1Note = buildRefundNote(MARKER, SOURCE_GID);
    expect(s1b1Note).not.toBe(EVALUATOR_NOTE);
    // The S1-B1 note carries the marker, so only the evaluator-template
    // check can catch this — it must.
    const ready = mutatePayload((p) => {
      p.note = s1b1Note;
    });
    expect(adaptReadyToFreezeContract(ready, bindings()).ok).toBe(false);
    // And the output of the real path is the evaluator's note, never the
    // alternative the contract module would generate.
    const ok = adaptReadyToFreezeContract(makeReady(), bindings());
    if (!ok.ok) throw new Error(ok.reason);
    expect(ok.contract.wireVariables.input.note).toBe(EVALUATOR_NOTE);
    expect(ok.contract.wireVariables.input.note).not.toContain("shipping refund (cancelled combined order");
  });

  it.each([
    ["a paraphrased evaluator note", "MergeShip shipping refund MS-SHIPREFUND-123e4567-e89b-42d3-a456-426614174000"],
    ["marker moved", `MergeShip shipping adjustment — shipping refunded for order merged into ${PRIMARY_NAME}. ${MARKER}`],
    ["marker absent", `MergeShip shipping adjustment  — shipping refunded for order merged into ${PRIMARY_NAME}.`],
    ["a different uuid4 marker", `MergeShip shipping adjustment MS-SHIPREFUND-123e4567-e89b-42d3-a456-426614174999 — shipping refunded for order merged into ${PRIMARY_NAME}.`],
    ["a different order name", `MergeShip shipping adjustment ${MARKER} — shipping refunded for order merged into #9999.`],
    ["the CHECK-loose marker embedded", `MergeShip shipping adjustment MS-SHIPREFUND-123e4567-e89b-12d3-a456-426614174000 — shipping refunded for order merged into ${PRIMARY_NAME}.`],
  ])("refuses a note that is %s", (_l, note) => {
    expect(adaptReadyToFreezeContract(mutatePayload((p) => { p.note = note; }), bindings()).ok).toBe(false);
  });

  it.each([
    ["a non-uuid marker suffix", "MS-SHIPREFUND-not-a-uuid"],
    ["a uuid v1 marker", "MS-SHIPREFUND-123e4567-e89b-12d3-a456-426614174000"],
    ["a nil-uuid marker", "MS-SHIPREFUND-00000000-0000-0000-0000-000000000000"],
    ["an all-dashes marker", `MS-SHIPREFUND-${"-".repeat(36)}`],
    ["an empty marker", ""],
    ["the Phase-1 marker prefix", `MS-SHIP-${KEY}`],
  ])("refuses %s as the row marker", (_l, marker) => {
    const ready = mutateReady((r) => {
      r.requestPayload.note = `MergeShip shipping adjustment ${marker} — shipping refunded for order merged into ${PRIMARY_NAME}.`;
      r.requestHash = sha256Hex(canonicalJson(r.requestPayload));
    });
    expect(adaptReadyToFreezeContract(ready, bindings({ marker })).ok).toBe(false);
  });

  it.each([
    ["a wrong source order", bindings({ sourceOrderId: "gid://shopify/Order/9999" })],
    ["a malformed source order", bindings({ sourceOrderId: "4002" })],
    ["a wrong parent transaction", bindings({ parentTransactionId: "gid://shopify/OrderTransaction/9999" })],
    ["a malformed parent transaction", bindings({ parentTransactionId: "9001" })],
    ["a wrong gateway", bindings({ gateway: "shopify_payments" })],
    ["an empty gateway", bindings({ gateway: "" })],
    ["a wrong currency", bindings({ currencyCode: "EUR" })],
    ["an unknown currency", bindings({ currencyCode: "ZZZ" })],
    ["XXX (no established precision)", bindings({ currencyCode: "XXX" })],
    ["a lowercase currency", bindings({ currencyCode: "usd" })],
    ["an empty primary name", bindings({ primaryOrderName: "" })],
    ["a zero planned amount", bindings({ plannedShippingMinor: "0" })],
    ["a leading-zero planned amount", bindings({ plannedShippingMinor: "050" })],
    ["a decimal planned amount", bindings({ plannedShippingMinor: "0.5" })],
    ["a 41-digit planned amount", bindings({ plannedShippingMinor: "1".padEnd(41, "0") })],
    ["a wrong planned amount", bindings({ plannedShippingMinor: "51" })],
  ])("refuses bindings carrying %s", (_l, b) => {
    expect(adaptReadyToFreezeContract(makeReady(), b).ok).toBe(false);
  });

  it.each([
    ["nil uuid", "00000000-0000-0000-0000-000000000000"],
    ["uuid v1", "123e4567-e89b-12d3-a456-426614174000"],
    ["uuid v5", "123e4567-e89b-52d3-a456-426614174000"],
    ["bad variant nibble", "123e4567-e89b-42d3-c456-426614174000"],
    ["uppercase uuid", "123E4567-E89B-42D3-A456-426614174000"],
    ["not a uuid", "key"],
    ["empty", ""],
  ])("refuses %s as the idempotency key", (_l, idempotencyKey) => {
    expect(
      adaptReadyToFreezeContract(makeReady(), bindings({ idempotencyKey })).ok,
    ).toBe(false);
  });

  it.each([
    ["wrong input orderId", (p: any) => { p.orderId = "gid://shopify/Order/9999"; }],
    ["wrong transaction orderId", (p: any) => { p.transactions[0].orderId = "gid://shopify/Order/9999"; }],
    ["wrong parentId", (p: any) => { p.transactions[0].parentId = "gid://shopify/OrderTransaction/9999"; }],
    ["a malformed parentId", (p: any) => { p.transactions[0].parentId = "txn"; }],
    ["a wrong gateway", (p: any) => { p.transactions[0].gateway = "shopify_payments"; }],
    ["a wrong currency", (p: any) => { p.currency = "EUR"; }],
    ["an unknown currency", (p: any) => { p.currency = "ZZZ"; }],
    ["wrong fractional precision", (p: any) => { p.shipping.amount = "0.5"; p.transactions[0].amount = "0.5"; }],
    ["excess fractional precision", (p: any) => { p.shipping.amount = "0.500"; p.transactions[0].amount = "0.500"; }],
    ["shipping != transaction amount", (p: any) => { p.shipping.amount = "0.51"; }],
    ["a zero amount", (p: any) => { p.shipping.amount = "0.00"; p.transactions[0].amount = "0.00"; }],
    ["notify true", (p: any) => { p.notify = true; }],
    ["fullRefund true", (p: any) => { p.shipping.fullRefund = true; }],
    ["missing note", (p: any) => { delete p.note; }],
    ["an empty note", (p: any) => { p.note = ""; }],
    ["missing currency", (p: any) => { delete p.currency; }],
    ["merchandise refund lines", (p: any) => { p.refundLineItems = []; }],
    ["restock", (p: any) => { p.restock = true; }],
    ["over-refunding", (p: any) => { p.allowOverRefunding = true; }],
    ["store credit", (p: any) => { p.refundMethods = [{ storeCreditRefund: { amount: "0.50" } }]; }],
    ["a second transaction", (p: any) => { p.transactions.push({ ...p.transactions[0] }); }],
    ["a transaction extra key", (p: any) => { p.transactions[0].test = true; }],
    ["wrong kind", (p: any) => { p.transactions[0].kind = "SALE"; }],
    ["JSON-null kind", (p: any) => { p.transactions[0].kind = null; }],
    ["missing kind", (p: any) => { delete p.transactions[0].kind; }],
  ])("refuses a payload with %s", (_l, mutate) => {
    expect(adaptReadyToFreezeContract(mutatePayload(mutate), bindings()).ok).toBe(false);
  });

  it.each([
    ["plannedRefundMinor disagrees with the row", (r: any) => { r.plannedRefundMinor = "51"; }],
    ["currencyCode disagrees with the row", (r: any) => { r.currencyCode = "EUR"; }],
    ["sourceShippingMinor missing", (r: any) => { delete r.sourceShippingMinor; }],
    ["sourceShippingMinor below the planned amount", (r: any) => { r.sourceShippingMinor = "49"; }],
    ["evidence order id differs", (r: any) => { r.previewEvidence.order.id = "gid://shopify/Order/9999"; }],
    ["evidence currency differs", (r: any) => { r.previewEvidence.order.currencyCode = "EUR"; }],
    ["evidence paid != reported paid", (r: any) => { r.previewEvidence.order.shippingPaidMinor = "900"; }],
    ["evidence parent differs", (r: any) => { r.previewEvidence.allocation.parentTransactionId = "gid://shopify/OrderTransaction/9999"; }],
    ["evidence gateway differs", (r: any) => { r.previewEvidence.allocation.gateway = "manual"; }],
    ["evidence parent not CAPTURE/SALE", (r: any) => { r.previewEvidence.allocation.parentKind = "AUTHORIZATION"; }],
    ["evidence parent not SUCCESS", (r: any) => { r.previewEvidence.allocation.parentStatus = "PENDING"; }],
    ["evidence suggested amount differs", (r: any) => { r.previewEvidence.preview.suggestedTransactionMinor = "51"; }],
    ["evidence preview shipping differs", (r: any) => { r.previewEvidence.preview.shippingMinor = "51"; }],
    ["evidence absent", (r: any) => { delete r.previewEvidence; }],
    ["payload absent", (r: any) => { delete r.requestPayload; }],
  ])("refuses READY evidence where %s", (_l, mutate) => {
    expect(adaptReadyToFreezeContract(mutateReady(mutate), bindings()).ok).toBe(false);
  });

  it.each([
    ["a hash of a different payload", (r: any) => { r.requestHash = sha256Hex(canonicalJson({ other: true })); }],
    ["a hash that forgets the tamper", (r: any) => { r.requestPayload.shipping.amount = "99.99"; /* hash left stale */ }],
    ["a non-string hash", (r: any) => { r.requestHash = 42; }],
    ["a null hash", (r: any) => { r.requestHash = null; }],
  ])("refuses a tampered requestHash: %s", (_l, mutate) => {
    expect(adaptReadyToFreezeContract(mutateReady(mutate), bindings()).ok).toBe(false);
  });
});

describe("B-1 snapshot integrity", () => {
  /** A payload whose amounts are computed on read: the first `t` reads
   *  return the good amount, later reads the bad one. requestHash is the
   *  evaluator-style hash of the good payload (what a caller computed when
   *  it first observed the values). */
  const accessorReady = (shipThreshold: number, txThreshold: number): any => {
    const r = makeReady();
    let sr = 0;
    let tr = 0;
    Object.defineProperty(r.requestPayload.shipping, "amount", {
      get: () => (sr++ < shipThreshold ? "0.50" : "9.99"),
      enumerable: true,
    });
    Object.defineProperty(r.requestPayload.transactions[0], "amount", {
      get: () => (tr++ < txThreshold ? "0.50" : "9.99"),
      enumerable: true,
    });
    r.requestHash = sha256Hex(
      canonicalJson({
        ...r.requestPayload,
        shipping: { amount: "0.50", fullRefund: false },
        transactions: [{ ...r.requestPayload.transactions[0], amount: "0.50" }],
      }),
    );
    return r;
  };

  it("computed-on-read amounts can never freeze values that were not validated", () => {
    // The (7, 6) pair is the exact reproduction from the independent
    // review: under the old validate-then-clone order it returned ok:true
    // with frozen amounts 9.99 while plannedShippingMinor stayed 50.
    for (let st = 0; st <= 14; st++) {
      for (let tt = 0; tt <= 14; tt++) {
        const r = adaptReadyToFreezeContract(
          accessorReady(st, tt),
          bindings(),
        );
        if (!r.ok) continue;
        const input = r.contract.wireVariables.input;
        expect(input.shipping.amount).toBe("0.50");
        expect(input.transactions[0].amount).toBe("0.50");
        // Independent assertion against the planned amount, not a builder.
        expect(input.shipping.amount).toBe(minorToDecimal("50", 2));
        expect(r.financialColumns.plannedShippingMinor).toBe("50");
      }
    }
  });

  it.each([
    ["throwing getter on note", (r: any) => {
      Object.defineProperty(r.requestPayload, "note", {
        get: () => { throw new Error("boom"); },
        enumerable: true,
      });
    }],
    ["throwing getter on shipping amount", (r: any) => {
      Object.defineProperty(r.requestPayload.shipping, "amount", {
        get: () => { throw new Error("boom"); },
        enumerable: true,
      });
    }],
    ["a Proxy whose read fails", (r: any) => {
      r.requestPayload = new Proxy(r.requestPayload, {
        get: () => { throw new Error("proxy read failed"); },
      });
    }],
    ["a circular payload", (r: any) => {
      r.requestPayload.self = r.requestPayload;
    }],
    ["a BigInt amount", (r: any) => {
      r.requestPayload.shipping.amount = 50n as any;
    }],
    ["a function in the payload", (r: any) => {
      r.requestPayload.shipping.amount = (() => "0.50") as any;
    }],
    ["an undefined notify", (r: any) => {
      r.requestPayload.notify = undefined;
    }],
  ])("returns ok:false, never throws, for %s", (_l, mutate) => {
    const ready = mutateReady(mutate);
    let r: ReturnType<typeof adaptReadyToFreezeContract>;
    expect(() => {
      r = adaptReadyToFreezeContract(ready, bindings());
    }).not.toThrow();
    expect(r!.ok).toBe(false);
  });

  it("a benign Proxy that reads as plain data is snapshotted to plain data", () => {
    const ready = makeReady();
    ready.requestPayload = new Proxy(ready.requestPayload, {});
    const r = adaptReadyToFreezeContract(ready, bindings());
    if (!r.ok) throw new Error(r.reason);
    // The contract contains the values the snapshot validated — plain data
    // with no Proxy identity carried through.
    expect(Object.getPrototypeOf(r.contract.wireVariables.input)).toBe(
      Object.prototype,
    );
    expect(r.contract.wireVariables.input.note).toBe(EVALUATOR_NOTE);
    expect(r.contract.wireVariables.input.shipping.amount).toBe("0.50");
  });

  it("non-index properties on the transactions array cannot reach the contract", () => {
    const ready = mutateReady((r) => {
      (r.requestPayload.transactions as any).extra = { allowOverRefunding: true };
      r.requestHash = sha256Hex(canonicalJson(r.requestPayload));
    });
    const r = adaptReadyToFreezeContract(ready, bindings());
    if (!r.ok) throw new Error(r.reason);
    const stored = r.contract.wireVariables.input.transactions as any;
    expect("extra" in stored).toBe(false);
    expect(stored.length).toBe(1);
    expect(stored[0].amount).toBe("0.50");
    expect(Object.isFrozen(stored)).toBe(true);
  });

  it("post-call mutation of the READY result or the bindings cannot change the contract", () => {
    const ready = makeReady();
    const b = bindings();
    const r = adaptReadyToFreezeContract(ready, b);
    if (!r.ok) throw new Error(r.reason);
    ready.requestPayload.shipping.amount = "99.99";
    ready.requestPayload.transactions[0].amount = "99.99";
    ready.requestPayload.note = "tampered";
    ready.plannedRefundMinor = "9999";
    (b as any).plannedShippingMinor = "9999";
    (b as any).idempotencyKey = "123e4567-e89b-42d3-a456-426614174999";
    const input = r.contract.wireVariables.input;
    expect(input.shipping.amount).toBe("0.50");
    expect(input.note).toBe(EVALUATOR_NOTE);
    expect(r.contract.wireVariables.idempotencyKey).toBe(KEY);
    expect(r.financialColumns.plannedShippingMinor).toBe("50");
  });
});

describe("module isolation", () => {
  it("contains no database, Shopify, dispatch or scheduling machinery", () => {
    const src = readFileSync(
      join(__dirname, "../app/lib/shipping-refund-freeze-contract.ts"),
      "utf8",
    );
    for (const token of [
      "admin.graphql",
      "shopify.server",
      "graphql.server",
      "db.server",
      "prisma",
      "setInterval",
      "setTimeout",
      "buildRefundNote",
      "buildRefundInput",
      "shippingRefundMutationDocument",
    ]) {
      expect(src).not.toContain(token);
    }
  });
});
