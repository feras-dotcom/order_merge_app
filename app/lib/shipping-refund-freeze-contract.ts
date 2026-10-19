// ── Shipping v0 Phase 2: evaluator-READY → frozen wire contract adapter ────
// docs/SHIPPING-PHASE2-DESIGN.md Revision 3.3, section 8.3 — resolves the
// review finding M-7 before any store or scanner code relies on the refund
// contract.
//
// M-7 (authoritative decision): the Phase 1 evaluator's verbatim
// requestPayload is the freeze's financial request. Section 8.1 calls
// evaluateShadowSource with `marker: row.marker`, so the evaluator embeds
// the claimed row's EXECUTION marker inside its own note
//   `MergeShip shipping adjustment <marker> — shipping refunded for order
//    merged into <primaryOrderName>.`
// The contract module's standalone note and input builders produce a
// DIFFERENT note and are never used by this module. The adapter never
// regenerates, normalizes, trims or rewrites the note or any financial
// field: it PROVES the evaluator's output equals the row's expected values
// field by field, then binds that exact object to the row's idempotency key.
//
// Pure module: no I/O, no database, no Shopify, no scheduler. The output is
// a deep-frozen value a future lease-fenced freeze transaction (8.3) can
// write verbatim — nothing here is a write, an authorization or a send.

import { getCurrencyPrecision } from "./money";
import { canonicalJson, minorToDecimal } from "./shipping-shadow.server";
import {
  MARKER_PREFIX,
  ORDER_GID_PATTERN,
  ORDER_TRANSACTION_GID_PATTERN,
  PLANNED_SHIPPING_MINOR_PATTERN,
  REFUND_DOCUMENT_SHA256,
  REFUND_MUTATION_VERSION,
  buildWireVariables,
  computeWireHash,
  isStrictUuidV4,
  isValidMarker,
  sha256Hex,
  validateRefundInput,
  type FrozenWireContract,
  type ShippingRefundInput,
} from "./shipping-refund-contract";

const ORDER_GID_RE = new RegExp(ORDER_GID_PATTERN);
const ORDER_TRANSACTION_GID_RE = new RegExp(ORDER_TRANSACTION_GID_PATTERN);
const PLANNED_SHIPPING_MINOR_RE = new RegExp(PLANNED_SHIPPING_MINOR_PATTERN);
const MINOR_RE = /^\d{1,40}$/;

/** Everything about the claimed row the freeze needs to prove equivalence
 *  against. Values are the row's immutable identity plus the financial
 *  columns the freeze intends to write — all supplied by the caller, all
 *  proven against the evaluator's evidence before the contract is built. */
export interface FreezeBindings {
  readonly sourceOrderId: string;
  readonly parentTransactionId: string;
  readonly gateway: string;
  readonly currencyCode: string;
  /** The row's execution marker (MS-SHIPREFUND-<uuidv4>); the evaluator
   *  received it as `marker` and embedded it in the note (8.1). */
  readonly marker: string;
  /** The row's idempotency key generated at claim (5.1). */
  readonly idempotencyKey: string;
  /** The row's primaryOrderName — embedded in the evaluator's note. */
  readonly primaryOrderName: string;
  /** The intended `plannedShippingMinor` column: the single minor-unit
   *  amount the transaction must move (5.1). */
  readonly plannedShippingMinor: string;
}

export type FreezeAdaptation =
  | {
      readonly ok: true;
      /** Deep-frozen: documentSha256, mutationVersion, wireVariables
       *  ({idempotencyKey, input} — the evaluator's exact payload),
       *  wireHash. */
      readonly contract: FrozenWireContract;
      /** The freeze's financial columns, derived from the evaluator's
       *  validated payload (each was already proven equal to the
       *  corresponding binding). */
      readonly financialColumns: {
        readonly currencyCode: string;
        readonly plannedShippingMinor: string;
        readonly parentTransactionId: string;
        readonly gateway: string;
      };
    }
  | { readonly ok: false; readonly reason: string };

const fail = (reason: string): FreezeAdaptation => ({ ok: false, reason });

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isMinorString(value: unknown): value is string {
  return typeof value === "string" && MINOR_RE.test(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      deepFreeze(v);
    }
    Object.freeze(value);
  }
  return value;
}

/** The evaluator's note template, pinned textually (8.1). The adapter checks
 *  the note equals this shape with the row's marker and primary name — it
 *  verifies, it never builds the string into the stored input. A change to
 *  the evaluator's note construction is a Phase 1 change (3.2 rule 3) that
 *  must fail closed here until re-reviewed; the contract test asserts the
 *  template still exists verbatim in shipping-shadow.server.ts. */
const NOTE_PREFIX = "MergeShip shipping adjustment ";
const NOTE_SEPARATOR = " — shipping refunded for order merged into ";
const NOTE_SUFFIX = ".";

function isEvaluatorNote(note: unknown, marker: string, primaryOrderName: string): note is string {
  return (
    typeof note === "string" &&
    note === `${NOTE_PREFIX}${marker}${NOTE_SEPARATOR}${primaryOrderName}${NOTE_SUFFIX}`
  );
}

/**
 * Adapt a READY result of evaluateShadowSource into the frozen wire contract
 * of section 8.3. Refuses non-READY, missing, malformed or contradictory
 * inputs with a reason; on success returns a deep-frozen value.
 *
 * Proof obligations (each must hold; nothing is repaired, only refused):
 *  - the result is an object with kind 'READY';
 *  - bindings' key and marker are strict UUIDv4 forms (5.1);
 *  - ready.plannedRefundMinor equals bindings.plannedShippingMinor, matches
 *    the minor pattern, and equals the payload's transaction amount
 *    converted at the bound currency's established precision;
 *  - ready.currencyCode equals bindings.currencyCode;
 *  - ready.sourceShippingMinor is a minor string >= the planned amount
 *    (the refund can never exceed what was paid);
 *  - ready.requestHash, when present, equals sha256Hex(canonicalJson(
 *    requestPayload)) — the evaluator's own hash, recomputed;
 *  - previewEvidence.order.id/currencyCode equal the row's
 *    sourceOrderId/currencyCode (the row's primaryOrderName is bound by
 *    the note template instead), and
 *    previewEvidence.allocation.parentTransactionId/gateway equal the
 *    row's parentTransactionId/gateway (the same values the transaction
 *    carries); the parent is a SUCCESS CAPTURE or SALE;
 *  - the requestPayload passes the accepted S1-B1 validateRefundInput with
 *    the full row binding (exact key sets, strict positivity, precision,
 *    kind 'REFUND', notify/fullRefund false, orderId equality);
 *  - the note is the evaluator's exact template with the row's marker and
 *    primary name — verbatim, never regenerated.
 *
 * The evaluator result and the bindings are detached into ONE plain-JSON
 * snapshot before any check runs, then never read again: the values proven
 * below are byte for byte the values frozen into the contract (B-1).
 * Neither caller object is mutated, and later writes to the caller's
 * objects cannot alter the contract.
 */
export function adaptReadyToFreezeContract(
  result: unknown,
  bindings: FreezeBindings,
): FreezeAdaptation {
  // ── One stable snapshot before anything is read (B-1) ──
  // Caller objects are not trustworthy plain data: accessor properties can
  // return a different value on each read, getters and Proxy traps can
  // throw, and any copy taken AFTER validation (structuredClone or
  // otherwise) can disagree with the values that were validated. A single
  // guarded JSON round trip taken up front yields detached data: every
  // check, hash and stored value below is computed on this snapshot, and
  // nothing reads the caller's objects again. A value that cannot be
  // represented as JSON — a throwing getter, a circular structure, a
  // BigInt, a Proxy whose reads fail — refuses; it never throws out of
  // this function.
  let snapResult: unknown;
  let snapBindings: unknown;
  try {
    snapResult = JSON.parse(JSON.stringify(result));
    snapBindings = JSON.parse(JSON.stringify(bindings));
  } catch {
    return fail("inputs are not plain JSON data");
  }

  // ── Bindings must themselves be well-formed ──
  if (!isObject(snapBindings)) return fail("freeze bindings are not an object");
  const b = snapBindings;
  if (typeof b.sourceOrderId !== "string" || !ORDER_GID_RE.test(b.sourceOrderId)) {
    return fail("row sourceOrderId is not a valid order GID");
  }
  if (
    typeof b.parentTransactionId !== "string" ||
    !ORDER_TRANSACTION_GID_RE.test(b.parentTransactionId)
  ) {
    return fail("row parentTransactionId is not a valid OrderTransaction GID");
  }
  if (typeof b.gateway !== "string" || b.gateway.length === 0) {
    return fail("row gateway must be a non-empty string");
  }
  if (typeof b.currencyCode !== "string") {
    return fail(`row currencyCode ${JSON.stringify(b.currencyCode)} has no established precision`);
  }
  const precision = getCurrencyPrecision(b.currencyCode);
  if (precision === null) {
    return fail(`row currencyCode ${JSON.stringify(b.currencyCode)} has no established precision`);
  }
  if (!isValidMarker(b.marker) || !isStrictUuidV4(b.marker.slice(MARKER_PREFIX.length))) {
    return fail("row marker is not an MS-SHIPREFUND-<uuidv4> marker");
  }
  if (!isStrictUuidV4(b.idempotencyKey)) {
    return fail("row idempotencyKey is not a strict UUIDv4");
  }
  if (typeof b.primaryOrderName !== "string" || b.primaryOrderName.length === 0) {
    return fail("row primaryOrderName must be a non-empty string");
  }
  if (typeof b.plannedShippingMinor !== "string" || !PLANNED_SHIPPING_MINOR_RE.test(b.plannedShippingMinor)) {
    return fail("row plannedShippingMinor does not match the 5.3 minor-unit pattern");
  }

  // ── READY shape ──
  if (!isObject(snapResult)) return fail("evaluator result is not an object");
  if (snapResult.kind !== "READY") return fail("evaluator result is not READY");

  const ready = snapResult;
  if (ready.plannedRefundMinor !== b.plannedShippingMinor) {
    return fail("evaluator plannedRefundMinor differs from the row's planned amount");
  }
  if (ready.currencyCode !== b.currencyCode) {
    return fail("evaluator currencyCode differs from the row currency");
  }
  if (!isMinorString(ready.sourceShippingMinor)) {
    return fail("evaluator sourceShippingMinor is missing or malformed");
  }
  if (BigInt(ready.sourceShippingMinor) < BigInt(b.plannedShippingMinor)) {
    return fail("evaluator plans to refund more shipping than was paid");
  }

  const payload = ready.requestPayload;
  if (!isObject(payload)) return fail("evaluator requestPayload is missing or not an object");

  // ── The evaluator's own requestHash, when it is present, must match the
  //    payload under the one canonical serializer (never a second hashing
  //    implementation). ──
  if (ready.requestHash !== undefined) {
    if (
      typeof ready.requestHash !== "string" ||
      ready.requestHash !== sha256Hex(canonicalJson(payload))
    ) {
      return fail("evaluator requestHash does not match its requestPayload");
    }
  }

  // ── Financial evidence binds the same identities the payload carries ──
  const evidence = ready.previewEvidence;
  if (!isObject(evidence) || !isObject(evidence.order) || !isObject(evidence.allocation)) {
    return fail("evaluator previewEvidence is missing its order or allocation");
  }
  const eo = evidence.order;
  const ea = evidence.allocation;
  const tx = isObject(payload) && Array.isArray(payload.transactions) ? payload.transactions[0] : undefined;
  const txObj = isObject(tx) ? tx : undefined;
  if (eo.id !== b.sourceOrderId) return fail("evidence order id differs from the row sourceOrderId");
  // evidence.order.name is the SECONDARY's display name — it does not carry
  // the primary name; the primary is bound by the note template below.
  if (eo.name !== undefined && typeof eo.name !== "string") {
    return fail("evidence order name is malformed");
  }
  if (eo.currencyCode !== b.currencyCode) {
    return fail("evidence currencyCode differs from the row currency");
  }
  if (eo.shippingPaidMinor !== undefined && eo.shippingPaidMinor !== ready.sourceShippingMinor) {
    return fail("evidence shippingPaidMinor differs from sourceShippingMinor");
  }
  if (ea.parentTransactionId !== b.parentTransactionId || ea.parentTransactionId !== txObj?.parentId) {
    return fail("evidence parentTransactionId does not bind the payload's parentId");
  }
  if (ea.gateway !== b.gateway || ea.gateway !== txObj?.gateway) {
    return fail("evidence gateway does not bind the payload's gateway");
  }
  if (
    (ea.parentKind !== "CAPTURE" && ea.parentKind !== "SALE") ||
    ea.parentStatus !== "SUCCESS"
  ) {
    return fail("evidence parent transaction is not a verified successful CAPTURE or SALE");
  }
  const preview = isObject(evidence.preview) ? evidence.preview : undefined;
  if (preview === undefined) return fail("evaluator previewEvidence is missing its preview");
  if (preview.suggestedTransactionMinor !== b.plannedShippingMinor) {
    return fail("evidence suggestedTransactionMinor differs from the planned amount");
  }
  if (preview.shippingMinor !== b.plannedShippingMinor) {
    return fail("evidence previewShippingMinor differs from the planned amount");
  }

  // ── The payload itself, fully bound to the row (shape, formats, exact
  //    precision, strict positivity, row equalities). ──
  const check = validateRefundInput(payload, {
    orderId: b.sourceOrderId,
    parentTransactionId: b.parentTransactionId,
    gateway: b.gateway,
    currencyCode: b.currencyCode,
    plannedShippingMinor: b.plannedShippingMinor,
    marker: b.marker,
  });
  if (!check.ok) return fail(`evaluator requestPayload: ${check.reason}`);

  // ── The note is the evaluator's verbatim text — the row's marker inside
  //    the evaluator template, never the S1-B1 builder's different note. ──
  const note = (payload as Record<string, unknown>).note as string;
  if (!isEvaluatorNote(note, b.marker, b.primaryOrderName)) {
    return fail("payload note is not the evaluator's note carrying the row marker");
  }

  // ── Exact minor-unit conversion proven on the validated payload ──
  const txn = txObj as { amount: string; parentId: string; gateway: string };
  const required = minorToDecimal(b.plannedShippingMinor, precision);
  if ((payload as { shipping: { amount: string } }).shipping.amount !== required || txn.amount !== required) {
    return fail("payload amounts do not equal minorToDecimal(plannedShippingMinor, precision)");
  }

  // ── The stored input IS the validated snapshot payload — detached from
  //    the caller's object since the first read, so it carries exactly the
  //    values that were proven and hashed above. ──
  const input = payload as unknown as ShippingRefundInput;
  const wireVariables = buildWireVariables(b.idempotencyKey, input);
  const contract: FrozenWireContract = {
    documentSha256: REFUND_DOCUMENT_SHA256,
    mutationVersion: REFUND_MUTATION_VERSION,
    wireVariables,
    wireHash: computeWireHash(REFUND_DOCUMENT_SHA256, wireVariables),
  };
  return {
    ok: true,
    contract: deepFreeze(contract),
    financialColumns: deepFreeze({
      // Derived from the evaluator's validated payload; each was proven
      // equal to the corresponding binding above.
      currencyCode: (payload as { currency: string }).currency,
      plannedShippingMinor: ready.plannedRefundMinor as string,
      parentTransactionId: txn.parentId,
      gateway: txn.gateway,
    }),
  };
}
