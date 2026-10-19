// ── Shipping v0 Phase 2: immutable refund request contract ────────────────────
// docs/SHIPPING-PHASE2-DESIGN.md Revision 3.3, section 10 (resolves H1).
//
// Pure module: constants, validators and deterministic builders only. It
// performs no I/O, holds no Shopify client and cannot send anything. There is
// no callable refund transport, mutation execution path or runtime scheduler
// here — dispatching is the separately authorized S2 dispatcher's job, and
// only it may import the document text through the single accessor below
// (architecture rule 3.2.5).
//
// Nothing in this module claims that Shopify has validated the document, the
// @idempotent directive's variable form, the idempotency semantics or the
// refund semantics. Those are the future evidence gates G-INTROSPECT, G-E7
// and friends (section 10.1); the document text is pinned precisely so a
// change that invalidates an archived validation result is a visible event.
//
// Validation is fail-closed and mirrors what the deployed schema enforces:
// the exact key sets of the shape trigger (5.3), the format CHECKs (5.3),
// the NULL-safe kind rule (B2) and the application-only precision rule —
// the decimal amount must equal minorToDecimal(plannedShippingMinor,
// precision) for the order currency, and the fraction must carry exactly the
// currency's precision (zero-decimal currencies send no fraction at all).

import { createHash, randomUUID } from "node:crypto";

import { canonicalJson, minorToDecimal } from "./shipping-shadow.server";
import { getCurrencyPrecision } from "./money";

// ── 5.3 formats (the same patterns the migration CHECKs pin, verbatim) ────────

/** The one order-GID pattern (5.3: shared by CHECKs, scanner SQL and validators). */
export const ORDER_GID_PATTERN = "^gid://shopify/Order/[0-9]+$";
export const ORDER_TRANSACTION_GID_PATTERN = "^gid://shopify/OrderTransaction/[0-9]+$";
export const REFUND_GID_PATTERN = "^gid://shopify/Refund/[0-9]+$";
export const APP_GID_PATTERN = "^gid://shopify/App/[0-9]+$";
export const CURRENCY_CODE_PATTERN = "^[A-Z]{3}$";
export const HASH_64_PATTERN = "^[0-9a-f]{64}$";
export const PLANNED_SHIPPING_MINOR_PATTERN = "^[1-9][0-9]{0,39}$";
export const MARKER_PATTERN = "^MS-SHIPREFUND-[0-9a-f-]{36}$";
/** The loose UUID shape the idempotencyKey CHECK accepts. */
export const IDEMPOTENCY_KEY_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
/** Strict RFC-4122 version-4 UUID (10.3: required before template rendering). */
export const STRICT_UUIDV4_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
/** Decimal-format CHECK of 5.3: no sign, no exponent, no superfluous zeros, ≤4 fractional digits. */
export const WIRE_AMOUNT_PATTERN = "^(0\\.[0-9]{1,4}|[1-9][0-9]*(\\.[0-9]{1,4})?)$";

export const MARKER_PREFIX = "MS-SHIPREFUND-";

const ORDER_GID_RE = new RegExp(ORDER_GID_PATTERN);
const ORDER_TRANSACTION_GID_RE = new RegExp(ORDER_TRANSACTION_GID_PATTERN);
const CURRENCY_CODE_RE = new RegExp(CURRENCY_CODE_PATTERN);
const PLANNED_SHIPPING_MINOR_RE = new RegExp(PLANNED_SHIPPING_MINOR_PATTERN);
const MARKER_RE = new RegExp(MARKER_PATTERN);
const IDEMPOTENCY_KEY_RE = new RegExp(IDEMPOTENCY_KEY_PATTERN);
const STRICT_UUIDV4_RE = new RegExp(STRICT_UUIDV4_PATTERN);
const WIRE_AMOUNT_RE = new RegExp(WIRE_AMOUNT_PATTERN);
const HASH_64_RE = new RegExp(HASH_64_PATTERN);

/**
 * Contract version stamped into `mutationVersion` at the freeze (5.1). It
 * identifies which contract produced the row; the pinned API version is part
 * of it so a re-pinned build produces a different value. (The specification
 * names the column but never fixes its literal value — this is the build's
 * chosen constant and is pinned to an independent literal by a test.)
 *
 * The earlier S1-A PostgreSQL fixture rows used the test-only label
 * 'refundCreate@2026-04' (tests/shipping-refund-schema-pg.test.ts): that
 * string only fed CHECK-bound inserts on a disposable database and was never
 * the production version authority — this constant is.
 */
export const REFUND_MUTATION_VERSION = "MergeShipShippingRefund@2026-04";

// ── 10.1 The constant document ────────────────────────────────────────────────

/**
 * The mutation document, normalized (LF endings, no trailing whitespace).
 * NOT exported as a constant: its text leaves this module only through the
 * single accessor shippingRefundMutationDocument() (3.2 rule 5). The
 * dispatcher (S2) is the only production importer; every other module must
 * never see the text, so no S1 code path can even name the request.
 */
const REFUND_DOCUMENT = `mutation MergeShipShippingRefund($input: RefundInput!, $idempotencyKey: String!) {
  refundCreate(input: $input) @idempotent(key: $idempotencyKey) {
    refund {
      id
      note
      createdAt
      totalRefundedSet { presentmentMoney { amount currencyCode } }
    }
    userErrors { field message }
  }
}`;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256 of the normalized 10.1 document text; pinned by a test (3.2 rule 8). */
export const REFUND_DOCUMENT_SHA256 = sha256Hex(REFUND_DOCUMENT);

/**
 * The ONLY accessor for the mutation document text (3.2 rule 5). Imported
 * solely by the S2 dispatcher and by this module's tests. No S1 production
 * module may reference this name — the architecture test asserts it.
 */
export function shippingRefundMutationDocument(): string {
  return REFUND_DOCUMENT;
}

// ── 10.3 Validated-template fallback (decided before S2 by G-INTROSPECT/G-E7) ──

/**
 * Fallback document used only if G-INTROSPECT/G-E7 reject the variable
 * directive form: the idempotency key is rendered into the document instead.
 * Carries exactly one __IDEMPOTENCY_KEY__ placeholder; the rendered document
 * differs from the template at that position only, and documentSha256 is the
 * hash of the rendered document (variables then carry { input } only, while
 * wireHash keeps the same formula so the stored record is uniform).
 */
export const IDEMPOTENCY_KEY_PLACEHOLDER = "__IDEMPOTENCY_KEY__";

const REFUND_DOCUMENT_TEMPLATE = `mutation MergeShipShippingRefund($input: RefundInput!) {
  refundCreate(input: $input) @idempotent(key: "__IDEMPOTENCY_KEY__") {
    refund {
      id
      note
      createdAt
      totalRefundedSet { presentmentMoney { amount currencyCode } }
    }
    userErrors { field message }
  }
}`;

/** sha256 of the raw (unrendered) template text; pinned by a test. */
export const REFUND_DOCUMENT_TEMPLATE_SHA256 = sha256Hex(REFUND_DOCUMENT_TEMPLATE);

/** The ONLY accessor for the unrendered template text (3.2 rule 5, mirrored). */
export function shippingRefundMutationDocumentTemplate(): string {
  return REFUND_DOCUMENT_TEMPLATE;
}

/**
 * Render the fallback document (10.3). The key must match the strict UUIDv4
 * pattern before rendering — anything else refuses. Refuses too if the
 * template ever carries a placeholder count other than exactly one.
 */
export function renderRefundDocumentTemplate(idempotencyKey: string): string {
  if (typeof idempotencyKey !== "string" || !STRICT_UUIDV4_RE.test(idempotencyKey)) {
    throw new Error(
      "refund contract: template rendering requires a strict UUIDv4 idempotency key",
    );
  }
  const occurrences = REFUND_DOCUMENT_TEMPLATE.split(IDEMPOTENCY_KEY_PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `refund contract: template must contain exactly one ${IDEMPOTENCY_KEY_PLACEHOLDER} placeholder (found ${occurrences})`,
    );
  }
  return REFUND_DOCUMENT_TEMPLATE.split(IDEMPOTENCY_KEY_PLACEHOLDER).join(idempotencyKey);
}

// ── Key and marker handling (5.1: generated at claim, never derived) ──────────

/** A fresh UUIDv4 idempotency key. Generated at claim; never derived. */
export function generateIdempotencyKey(): string {
  return randomUUID();
}

/** A fresh unique marker: MS-SHIPREFUND-<uuid>. Generated at claim. */
export function generateMarker(): string {
  return `${MARKER_PREFIX}${randomUUID()}`;
}

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY_RE.test(value);
}

export function isStrictUuidV4(value: unknown): value is string {
  return typeof value === "string" && STRICT_UUIDV4_RE.test(value);
}

export function isValidMarker(value: unknown): value is string {
  return typeof value === "string" && MARKER_RE.test(value);
}

// ── 10.4 The strict shipping-only RefundInput ─────────────────────────────────

export interface ShippingRefundTransactionInput {
  readonly orderId: string;
  readonly parentId: string;
  readonly gateway: string;
  readonly kind: "REFUND";
  readonly amount: string;
}

export interface ShippingRefundInput {
  readonly orderId: string;
  readonly note: string;
  readonly notify: false;
  readonly currency: string;
  readonly shipping: { readonly fullRefund: false; readonly amount: string };
  readonly transactions: readonly [ShippingRefundTransactionInput];
}

export interface ShippingRefundWireVariables {
  readonly idempotencyKey: string;
  readonly input: ShippingRefundInput;
}

/**
 * The note carries the marker (5.3 N7: position(marker in note) > 0 is a
 * database CHECK, because adoption later matches the refund by this marker).
 * Deterministic: same marker and order id produce the same note.
 */
export function buildRefundNote(marker: string, sourceOrderId: string): string {
  // §5.1 requires the generated marker to embed a UUIDv4. The marker CHECK is
  // deliberately looser (MS-SHIPREFUND-[0-9a-f-]{36}) and isValidMarker mirrors
  // it for shape parity; the build side additionally requires the strict v4
  // suffix so a CHECK-legal but non-UUID marker can never be frozen.
  if (!isValidMarker(marker) || !isStrictUuidV4(marker.slice(MARKER_PREFIX.length))) {
    throw new Error("refund contract: note requires an MS-SHIPREFUND-<uuidv4> marker");
  }
  if (typeof sourceOrderId !== "string" || !ORDER_GID_RE.test(sourceOrderId)) {
    throw new Error(`refund contract: malformed source order id ${JSON.stringify(sourceOrderId)}`);
  }
  return `${marker} MergeShip shipping refund (cancelled combined order ${sourceOrderId})`;
}

/**
 * Build the strict shipping-only RefundInput (10.4). Never: refundLineItems,
 * restock, allowOverRefunding, refund methods, store credit or
 * RefundShippingInput. The key sets produced here are exactly the sets the
 * shape trigger accepts — nothing else can be constructed.
 *
 * The amount is minorToDecimal(plannedShippingMinor, precision) where the
 * precision comes from the established ISO 4217 table via
 * getCurrencyPrecision — an unknown currency fails closed before any input
 * is produced.
 */
export function buildRefundInput(params: {
  readonly sourceOrderId: string;
  readonly parentTransactionId: string;
  readonly gateway: string;
  readonly plannedShippingMinor: string;
  readonly currencyCode: string;
  readonly marker: string;
}): ShippingRefundInput {
  const {
    sourceOrderId,
    parentTransactionId,
    gateway,
    plannedShippingMinor,
    currencyCode,
    marker,
  } = params;
  if (typeof sourceOrderId !== "string" || !ORDER_GID_RE.test(sourceOrderId)) {
    throw new Error(`refund contract: malformed sourceOrderId ${JSON.stringify(sourceOrderId)}`);
  }
  if (
    typeof parentTransactionId !== "string" ||
    !ORDER_TRANSACTION_GID_RE.test(parentTransactionId)
  ) {
    throw new Error(
      `refund contract: malformed parentTransactionId ${JSON.stringify(parentTransactionId)}`,
    );
  }
  if (typeof gateway !== "string" || gateway.length === 0) {
    throw new Error("refund contract: gateway must be a non-empty string");
  }
  if (
    typeof plannedShippingMinor !== "string" ||
    !PLANNED_SHIPPING_MINOR_RE.test(plannedShippingMinor)
  ) {
    throw new Error(
      `refund contract: plannedShippingMinor must match ${PLANNED_SHIPPING_MINOR_PATTERN}, got ${JSON.stringify(plannedShippingMinor)}`,
    );
  }
  if (typeof currencyCode !== "string" || !CURRENCY_CODE_RE.test(currencyCode)) {
    throw new Error(`refund contract: malformed currencyCode ${JSON.stringify(currencyCode)}`);
  }
  const precision = getCurrencyPrecision(currencyCode);
  if (precision === null) {
    throw new Error(`refund contract: no established precision for currency ${currencyCode}`);
  }
  const amount = minorToDecimal(plannedShippingMinor, precision);
  return {
    orderId: sourceOrderId,
    note: buildRefundNote(marker, sourceOrderId),
    notify: false,
    currency: currencyCode,
    shipping: { fullRefund: false, amount },
    transactions: [
      {
        orderId: sourceOrderId,
        parentId: parentTransactionId,
        gateway,
        kind: "REFUND",
        amount,
      },
    ],
  };
}

type ShapeCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const ok: ShapeCheck = { ok: true };
const fail = (reason: string): ShapeCheck => ({ ok: false, reason });

function exactKeys(value: unknown, allowed: readonly string[]): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["<not-an-object>"];
  }
  return Object.keys(value as Record<string, unknown>).filter((k) => !allowed.includes(k));
}

function missingKeys(value: unknown, required: readonly string[]): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return required.slice();
  }
  const o = value as Record<string, unknown>;
  return required.filter((k) => !(k in o));
}

function isDecimalAmount(value: unknown): value is string {
  return typeof value === "string" && WIRE_AMOUNT_RE.test(value);
}

function isPositiveDecimal(value: string): boolean {
  return BigInt(value.replace(".", "")) > 0n;
}

/** Fractional digit count of a WIRE_AMOUNT_PATTERN-conforming decimal string. */
function fractionDigits(value: string): number {
  const dot = value.indexOf(".");
  return dot === -1 ? 0 : value.length - dot - 1;
}

/**
 * Fail-closed validator for a RefundInput-shaped value. Mirrors the shape
 * trigger's exact key sets and the CHECK rules that are expressible without
 * a database row: types, notify/fullRefund fixed false, exactly one
 * transaction, kind strictly 'REFUND' (a JSON null or any other value
 * refuses), decimal format and strict positivity, amount equality between
 * shipping and the transaction, orderId equality, and the marker inside the
 * note. The decimal amounts must always carry exactly the precision the
 * established ISO 4217 table assigns to input.currency — that application
 * invariant (5.3) holds with or without an `expected` binding, and an
 * unknown currency fails closed. When `expected` is supplied it additionally
 * binds the row-level equalities the wire CHECKs enforce (orderId, parentId,
 * gateway, currency, minor amount at the currency's own precision).
 */
export function validateRefundInput(
  input: unknown,
  expected?: {
    readonly orderId?: string;
    readonly parentTransactionId?: string;
    readonly gateway?: string;
    readonly currencyCode?: string;
    readonly plannedShippingMinor?: string;
    readonly marker?: string;
  },
): ShapeCheck {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return fail("input is not an object");
  }
  const allowedInput = ["orderId", "note", "notify", "currency", "shipping", "transactions"];
  const extra = exactKeys(input, allowedInput);
  if (extra.length) return fail(`input has forbidden keys: ${extra.join(",")}`);
  const missing = missingKeys(input, allowedInput);
  if (missing.length) return fail(`input is missing keys: ${missing.join(",")}`);
  const i = input as Record<string, unknown>;

  if (typeof i.orderId !== "string" || !ORDER_GID_RE.test(i.orderId)) {
    return fail("input.orderId is not a valid order GID");
  }
  if (i.notify !== false) return fail("input.notify must be exactly false");
  if (typeof i.note !== "string" || i.note.length === 0) {
    return fail("input.note must be a non-empty string");
  }
  if (typeof i.currency !== "string" || !CURRENCY_CODE_RE.test(i.currency)) {
    return fail("input.currency is not a valid currency code");
  }
  // The currency must have an established ISO 4217 precision; the precision
  // itself is enforced against both amounts below.
  const inputPrecision = getCurrencyPrecision(i.currency);
  if (inputPrecision === null) {
    return fail(`input.currency ${JSON.stringify(i.currency)} has no established precision`);
  }

  const sh = i.shipping;
  const allowedShipping = ["fullRefund", "amount"];
  const shExtra = exactKeys(sh, allowedShipping);
  if (shExtra.length) return fail(`shipping has forbidden keys: ${shExtra.join(",")}`);
  const shMissing = missingKeys(sh, allowedShipping);
  if (shMissing.length) return fail(`shipping is missing keys: ${shMissing.join(",")}`);
  const s = sh as Record<string, unknown>;
  if (s.fullRefund !== false) return fail("shipping.fullRefund must be exactly false");
  if (!isDecimalAmount(s.amount) || !isPositiveDecimal(s.amount)) {
    return fail("shipping.amount is not a strictly positive decimal string");
  }
  if (fractionDigits(s.amount) !== inputPrecision) {
    return fail(
      `shipping.amount must carry exactly ${inputPrecision} fractional digit(s) for ${i.currency}`,
    );
  }

  if (!Array.isArray(i.transactions) || i.transactions.length !== 1) {
    return fail("input.transactions must be an array of exactly one entry");
  }
  const tx = i.transactions[0];
  const allowedTx = ["orderId", "parentId", "gateway", "kind", "amount"];
  const txExtra = exactKeys(tx, allowedTx);
  if (txExtra.length) return fail(`transaction has forbidden keys: ${txExtra.join(",")}`);
  const txMissing = missingKeys(tx, allowedTx);
  if (txMissing.length) return fail(`transaction is missing keys: ${txMissing.join(",")}`);
  const t = tx as Record<string, unknown>;
  if (t.orderId !== i.orderId) return fail("transaction.orderId must equal input.orderId");
  if (typeof t.parentId !== "string" || !ORDER_TRANSACTION_GID_RE.test(t.parentId)) {
    return fail("transaction.parentId is not a valid OrderTransaction GID");
  }
  if (typeof t.gateway !== "string" || t.gateway.length === 0) {
    return fail("transaction.gateway must be a non-empty string");
  }
  if (t.kind !== "REFUND") {
    return fail("transaction.kind must be exactly 'REFUND' (null and other values refuse)");
  }
  if (!isDecimalAmount(t.amount) || !isPositiveDecimal(t.amount)) {
    return fail("transaction.amount is not a strictly positive decimal string");
  }
  if (fractionDigits(t.amount) !== inputPrecision) {
    return fail(
      `transaction.amount must carry exactly ${inputPrecision} fractional digit(s) for ${i.currency}`,
    );
  }
  if (t.amount !== s.amount) return fail("transaction.amount must equal shipping.amount");

  if (expected) {
    if (expected.orderId !== undefined && i.orderId !== expected.orderId) {
      return fail("input.orderId does not match the row sourceOrderId");
    }
    if (expected.parentTransactionId !== undefined && t.parentId !== expected.parentTransactionId) {
      return fail("transaction.parentId does not match the row parentTransactionId");
    }
    if (expected.gateway !== undefined && t.gateway !== expected.gateway) {
      return fail("transaction.gateway does not match the row gateway");
    }
    if (expected.currencyCode !== undefined && i.currency !== expected.currencyCode) {
      return fail("input.currency does not match the row currencyCode");
    }
    if (expected.plannedShippingMinor !== undefined) {
      // Format first: a malformed expected value is a validation failure, not
      // a BigInt throw. The precision comes from the row currency when given,
      // otherwise from the already validated input.currency.
      if (
        typeof expected.plannedShippingMinor !== "string" ||
        !PLANNED_SHIPPING_MINOR_RE.test(expected.plannedShippingMinor)
      ) {
        return fail("expected.plannedShippingMinor must match the minor-unit pattern");
      }
      const precision = getCurrencyPrecision(
        expected.currencyCode !== undefined ? expected.currencyCode : i.currency,
      );
      if (precision === null) {
        return fail("no established precision for the bound currency");
      }
      const required = minorToDecimal(expected.plannedShippingMinor, precision);
      if (s.amount !== required) {
        return fail("amount is not minorToDecimal(plannedShippingMinor, precision)");
      }
    }
    if (expected.marker !== undefined && !(i.note as string).includes(expected.marker)) {
      return fail("input.note does not carry the row marker");
    }
  }
  return ok;
}

/** Build the stored wire variables { idempotencyKey, input } (10.2). */
export function buildWireVariables(
  idempotencyKey: string,
  input: ShippingRefundInput,
): ShippingRefundWireVariables {
  // §5.1: the key generated at claim is a UUIDv4, so the freeze builder
  // requires the strict v4 form even though the database CHECK (and
  // isValidIdempotencyKey, which mirrors it) accepts the loose UUID shape.
  if (!isStrictUuidV4(idempotencyKey)) {
    throw new Error("refund contract: idempotencyKey must be a strict UUIDv4");
  }
  const check = validateRefundInput(input);
  if (!check.ok) throw new Error(`refund contract: ${check.reason}`);
  return { idempotencyKey, input };
}

/**
 * wireHash = sha256( canonicalJson( { documentSha256, variables } ) ) (10.2).
 * canonicalJson is the existing exported sorted-key serializer. The hash
 * covers the canonical semantic request — document hash, key and input —
 * not any transport byte serialization.
 */
export function computeWireHash(
  documentSha256: string,
  variables: ShippingRefundWireVariables,
): string {
  if (typeof documentSha256 !== "string" || !HASH_64_RE.test(documentSha256)) {
    throw new Error("refund contract: documentSha256 must be a 64-hex sha256");
  }
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    throw new Error("refund contract: variables must be an object");
  }
  const extra = exactKeys(variables, ["idempotencyKey", "input"]);
  if (extra.length) throw new Error(`refund contract: variables has forbidden keys: ${extra.join(",")}`);
  const missing = missingKeys(variables, ["idempotencyKey", "input"]);
  if (missing.length) throw new Error(`refund contract: variables is missing keys: ${missing.join(",")}`);
  // Same strict-v4 policy as the freeze builder: a row whose key only
  // satisfies the looser CHECK never recomputes successfully at T3.
  if (!isStrictUuidV4(variables.idempotencyKey)) {
    throw new Error("refund contract: variables.idempotencyKey must be a strict UUIDv4");
  }
  const check = validateRefundInput(variables.input);
  if (!check.ok) throw new Error(`refund contract: ${check.reason}`);
  return sha256Hex(canonicalJson({ documentSha256, variables }));
}

/** The complete frozen wire contract written at the freeze (8.3, 10.2). */
export interface FrozenWireContract {
  readonly documentSha256: string;
  readonly mutationVersion: string;
  readonly wireVariables: ShippingRefundWireVariables;
  readonly wireHash: string;
}

/**
 * Build the whole frozen wire contract deterministically: given the same
 * idempotency key and financial parameters it reproduces the same
 * wireVariables and wireHash every time, which is exactly what T3
 * re-computes for equality (9.2 step 3).
 */
export function buildFrozenWireContract(params: {
  readonly sourceOrderId: string;
  readonly parentTransactionId: string;
  readonly gateway: string;
  readonly plannedShippingMinor: string;
  readonly currencyCode: string;
  readonly marker: string;
  readonly idempotencyKey: string;
}): FrozenWireContract {
  const input = buildRefundInput(params);
  const wireVariables = buildWireVariables(params.idempotencyKey, input);
  return {
    documentSha256: REFUND_DOCUMENT_SHA256,
    mutationVersion: REFUND_MUTATION_VERSION,
    wireVariables,
    wireHash: computeWireHash(REFUND_DOCUMENT_SHA256, wireVariables),
  };
}
