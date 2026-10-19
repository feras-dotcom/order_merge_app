// ── Shipping v0 Phase 2: read-only query-document registry ────────────────────
// docs/SHIPPING-PHASE2-DESIGN.md Revision 3.3, section 12.1.
//
// Pure module: document constants, their pinned sha256 hashes, their
// validation status and the worst-case bounds each was designed for, plus the
// fail-closed response-shape and bounds checks the documents specify.
//
// EVERY document here is a PROPOSAL and is UNVALIDATED (12.1). None has been
// executed against Shopify. A document becomes validated only when its exact
// text — identified by its sha256 — has run read-only on the approved
// development store and the sanitized request and response are archived
// under docs/evidence/shipping-v0/ (section 17). Any edit to a document's
// text resets it to UNVALIDATED, which is why each sha256 is pinned by test.
//
// This module cannot call Shopify and does not execute the documents. The
// GraphQL read documents never contain the word `mutation` (3.2 rule 9) — a
// test asserts it for every document, and readOnlyAdmin independently
// refuses any document that does before it reaches the wire.

import { createHash } from "node:crypto";

import {
  APP_GID_PATTERN,
  ORDER_GID_PATTERN,
  ORDER_TRANSACTION_GID_PATTERN,
  REFUND_GID_PATTERN,
} from "./shipping-refund-contract";

const ORDER_GID_RE = new RegExp(ORDER_GID_PATTERN);
const ORDER_TRANSACTION_GID_RE = new RegExp(ORDER_TRANSACTION_GID_PATTERN);
const REFUND_GID_RE = new RegExp(REFUND_GID_PATTERN);
const APP_GID_RE = new RegExp(APP_GID_PATTERN);

// ── Document identity ─────────────────────────────────────────────────────────

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Validation status of a read-only document (12.1 validation register).
 * Documents start UNVALIDATED; VALIDATED may be recorded only after the
 * exact text (this sha256) ran read-only on the dev store and the sanitized
 * evidence was archived — i.e. after G-READBACK / G-AGREEMENT Part A,
 * which are separate evidence gates, not this batch.
 */
export type QueryValidationStatus = "UNVALIDATED" | "VALIDATED";

export interface ShippingRefundQueryDocument {
  readonly name: string;
  /** The exact normalized document text (LF endings, no trailing whitespace). */
  readonly document: string;
  /** sha256 of `document`; pinned by test. */
  readonly documentSha256: string;
  readonly validationStatus: QueryValidationStatus;
  /** The worst-case bounds the document was designed for (G-READBACK compares measured cost against these). */
  readonly bounds: Readonly<Record<string, number>>;
}

// ── Designed bounds (12.1; the values G-READBACK must measure at) ─────────────

/**
 * Plain-array completeness bound. `refunds` and `transactions` are plain
 * arrays with no pageInfo: `first: 50` truncates. Fewer than 50 entries is a
 * complete list; 50 or more means completeness is unproven and the row goes
 * to review — never silently treated as complete.
 */
export const PLAIN_ARRAY_COMPLETENESS_LIMIT = 50;
/** Q-REFUND-DETAIL: at most 5 refund ids per request (12.1.2). */
export const DETAIL_IDS_PER_REQUEST = 5;
/** Q-REFUND-DETAIL: at most 2 requests per evaluation — 10 refunds total. */
export const DETAIL_REQUESTS_PER_EVALUATION = 2;
/** Q-REFUND-DETAIL: every nested connection is read at first: 10. */
export const DETAIL_CONNECTION_FIRST = 10;
/** Q-AGREEMENTS: agreements(first: 50, after: ...) per page. */
export const AGREEMENTS_PAGE_SIZE = 50;
/** Q-AGREEMENTS: at most 5 pages (250 agreements); more fails closed. */
export const AGREEMENTS_MAX_PAGES = 5;
/**
 * Design acceptance rule for G-READBACK (12.1.2): requestedQueryCost must be
 * at most 500 — half the platform limit, leaving bucket headroom. A design
 * margin chosen by the specification, NOT a Shopify-published figure.
 */
export const QUERY_COST_ACCEPTANCE_LIMIT = 500;

// ── Q-APPID (12.1): the verified current app id — UNVALIDATED for Phase 2 ──────

const Q_APPID_DOCUMENT = `query ShippingRefundAppIdentity {
  currentAppInstallation { app { id } }
}`;

export const Q_APPID: ShippingRefundQueryDocument = {
  name: "Q-APPID",
  document: Q_APPID_DOCUMENT,
  documentSha256: sha256Hex(Q_APPID_DOCUMENT),
  validationStatus: "UNVALIDATED",
  bounds: {},
};

// ── Q-RECHECK (12.1): execution recheck on secondary and primary — UNVALIDATED ─

const Q_RECHECK_DOCUMENT = `query ShippingRefundExecRecheck($source: ID!, $primary: ID!) {
  source: order(id: $source) {
    id
    cancelledAt
    closed
    displayFinancialStatus
    currencyCode
    totalRefundedSet { presentmentMoney { amount currencyCode } }
    totalRefundedShippingSet { presentmentMoney { amount currencyCode } }
    refunds(first: 50) { id }
    transactions(first: 50) {
      id
      kind
      status
      gateway
      test
      amountSet { presentmentMoney { amount currencyCode } }
      parentTransaction { id }
    }
  }
  primary: order(id: $primary) {
    id
    cancelledAt
    displayFinancialStatus
    currencyCode
  }
}`;

export const Q_RECHECK: ShippingRefundQueryDocument = {
  name: "Q-RECHECK",
  document: Q_RECHECK_DOCUMENT,
  documentSha256: sha256Hex(Q_RECHECK_DOCUMENT),
  validationStatus: "UNVALIDATED",
  bounds: { refunds: PLAIN_ARRAY_COMPLETENESS_LIMIT, transactions: PLAIN_ARRAY_COMPLETENESS_LIMIT },
};

// ── Q-RECONCILE (12.1.2): the cheap refund list — UNVALIDATED ──────────────────

const Q_RECONCILE_DOCUMENT = `query ShippingRefundReconcile($source: ID!) {
  order(id: $source) {
    id
    cancelledAt
    closed
    displayFinancialStatus
    currencyCode
    totalRefundedSet { presentmentMoney { amount currencyCode } }
    totalRefundedShippingSet { presentmentMoney { amount currencyCode } }
    refunds(first: 50) {
      id
      note
      createdAt
      processedAt
      totalRefundedSet { presentmentMoney { amount currencyCode } }
    }
    transactions(first: 50) {
      id
      kind
      status
      gateway
      test
      amountSet { presentmentMoney { amount currencyCode } }
      parentTransaction { id }
    }
  }
}`;

export const Q_RECONCILE: ShippingRefundQueryDocument = {
  name: "Q-RECONCILE",
  document: Q_RECONCILE_DOCUMENT,
  documentSha256: sha256Hex(Q_RECONCILE_DOCUMENT),
  validationStatus: "UNVALIDATED",
  bounds: { refunds: PLAIN_ARRAY_COMPLETENESS_LIMIT, transactions: PLAIN_ARRAY_COMPLETENESS_LIMIT },
};

// ── Q-REFUND-DETAIL (12.1.2): bounded nested records by id — UNVALIDATED ───────

const Q_REFUND_DETAIL_DOCUMENT = `query ShippingRefundDetail($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Refund {
      id
      note
      createdAt
      processedAt
      order { id }
      totalRefundedSet { presentmentMoney { amount currencyCode } }
      duties { amountSet { presentmentMoney { amount currencyCode } } }
      refundShippingLines(first: 10) {
        nodes {
          subtotalAmountSet { presentmentMoney { amount currencyCode } }
          taxAmountSet { presentmentMoney { amount currencyCode } }
        }
        pageInfo { hasNextPage }
      }
      refundLineItems(first: 10) {
        nodes { id }
        pageInfo { hasNextPage }
      }
      orderAdjustments(first: 10) {
        nodes { id }
        pageInfo { hasNextPage }
      }
      transactions(first: 10) {
        nodes {
          id
          kind
          status
          gateway
          test
          amountSet { presentmentMoney { amount currencyCode } }
          parentTransaction { id }
        }
        pageInfo { hasNextPage }
      }
    }
  }
}`;

export const Q_REFUND_DETAIL: ShippingRefundQueryDocument = {
  name: "Q-REFUND-DETAIL",
  document: Q_REFUND_DETAIL_DOCUMENT,
  documentSha256: sha256Hex(Q_REFUND_DETAIL_DOCUMENT),
  validationStatus: "UNVALIDATED",
  bounds: {
    idsPerRequest: DETAIL_IDS_PER_REQUEST,
    requestsPerEvaluation: DETAIL_REQUESTS_PER_EVALUATION,
    nestedConnectionFirst: DETAIL_CONNECTION_FIRST,
  },
};

// ── Q-AGREEMENTS (12.1): refund attribution via RefundAgreement — UNVALIDATED ──

const Q_AGREEMENTS_DOCUMENT = `query ShippingRefundAgreements($source: ID!, $after: String) {
  order(id: $source) {
    agreements(first: 50, after: $after) {
      nodes {
        __typename
        id
        happenedAt
        reason
        app { id }
        ... on RefundAgreement {
          refund { id }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export const Q_AGREEMENTS: ShippingRefundQueryDocument = {
  name: "Q-AGREEMENTS",
  document: Q_AGREEMENTS_DOCUMENT,
  documentSha256: sha256Hex(Q_AGREEMENTS_DOCUMENT),
  validationStatus: "UNVALIDATED",
  bounds: { pageSize: AGREEMENTS_PAGE_SIZE, maxPages: AGREEMENTS_MAX_PAGES },
};

export const SHIPPING_REFUND_QUERY_DOCUMENTS = [
  Q_APPID,
  Q_RECHECK,
  Q_RECONCILE,
  Q_REFUND_DETAIL,
  Q_AGREEMENTS,
] as const;

// ── Fail-closed response-shape and bounds checks ───────────────────────────────
// These are pure validators over an already-obtained GraphQL response body.
// They never interpret absence as evidence: a malformed shape, an unproven-
// complete list or a broken connection is always a failure, and the caller
// decides whether the failure class is transient (lag) or review.

export type QueryCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const checkOk: QueryCheck = { ok: true };
const checkFail = (reason: string): QueryCheck => ({ ok: false, reason });

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** GraphQL response body must be an object with an object `data` and no top-level errors. */
function dataField(body: unknown): { data: Record<string, unknown> } | QueryCheck {
  if (!isObject(body)) return checkFail("response body is not an object");
  if ("errors" in body) {
    const errors = (body as Record<string, unknown>).errors;
    if (errors !== undefined && errors !== null && (!Array.isArray(errors) || errors.length > 0)) {
      return checkFail("response carries top-level errors");
    }
  }
  const data = (body as Record<string, unknown>).data;
  if (!isObject(data)) return checkFail("response data is missing or not an object");
  return { data };
}

/**
 * Plain-array completeness (12.1 schema table): the field must be an array
 * and `first: 50` truncation means length < 50 is required — 50 or more is
 * "completeness unproven". A missing or non-array field is a malformed
 * shape, not an empty list.
 */
export function validatePlainArrayField(value: unknown, label: string): QueryCheck {
  if (!Array.isArray(value)) return checkFail(`${label}: expected an array`);
  if (value.length >= PLAIN_ARRAY_COMPLETENESS_LIMIT) {
    return checkFail(`${label}: ${value.length} entries — completeness unproven`);
  }
  return checkOk;
}

/**
 * Connection completeness for the nested Refund connections (12.1 schema
 * table): `pageInfo.hasNextPage` must be exactly `false`. `true`, a missing
 * pageInfo or a malformed connection is "completeness unproven", never a
 * short read.
 */
export function validateCompleteConnection(value: unknown, label: string): QueryCheck {
  if (!isObject(value)) return checkFail(`${label}: expected a connection object`);
  if (!Array.isArray(value.nodes)) return checkFail(`${label}: missing nodes array`);
  if (!isObject(value.pageInfo) || value.pageInfo.hasNextPage !== false) {
    return checkFail(`${label}: pageInfo.hasNextPage must be exactly false`);
  }
  return checkOk;
}

/** The id list for one Q-REFUND-DETAIL request: 1..5 unique non-empty strings. */
export function validateDetailRequestIds(ids: unknown): QueryCheck {
  if (!Array.isArray(ids)) return checkFail("detail request ids must be an array");
  if (ids.length === 0) return checkFail("detail request needs at least one refund id");
  if (ids.length > DETAIL_IDS_PER_REQUEST) {
    return checkFail(
      `detail request carries ${ids.length} ids — at most ${DETAIL_IDS_PER_REQUEST} per request`,
    );
  }
  for (const id of ids) {
    if (typeof id !== "string" || !REFUND_GID_RE.test(id)) {
      return checkFail("detail request ids must be Refund GIDs");
    }
  }
  if (new Set(ids).size !== ids.length) return checkFail("detail request ids must be unique");
  return checkOk;
}

/** The per-evaluation detail-request budget: at most 2 requests (10 refunds). */
export function validateDetailRequestBudget(requestCount: number): QueryCheck {
  if (!Number.isInteger(requestCount) || requestCount < 0) {
    return checkFail("detail request count must be a non-negative integer");
  }
  if (requestCount > DETAIL_REQUESTS_PER_EVALUATION) {
    return checkFail(
      `evaluation issued ${requestCount} detail requests — at most ${DETAIL_REQUESTS_PER_EVALUATION}`,
    );
  }
  return checkOk;
}

/** The agreement pagination budget: at most 5 pages. */
export function validateAgreementPageBudget(pageCount: number): QueryCheck {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    return checkFail("agreement page count must be a positive integer");
  }
  if (pageCount > AGREEMENTS_MAX_PAGES) {
    return checkFail(`agreement scan used ${pageCount} pages — at most ${AGREEMENTS_MAX_PAGES}`);
  }
  return checkOk;
}

/** Q-APPID: the app id must come from this live read, never from an env var. */
export function validateAppIdentity(body: unknown): QueryCheck & { readonly appId?: string } {
  const r = dataField(body);
  if (!("data" in r)) return r;
  const install = r.data.currentAppInstallation;
  if (!isObject(install) || !isObject(install.app) || typeof install.app.id !== "string") {
    return checkFail("currentAppInstallation.app.id is missing — attribution unavailable");
  }
  if (!APP_GID_RE.test(install.app.id)) {
    return checkFail(`unexpected app id shape ${JSON.stringify(install.app.id)}`);
  }
  return { ok: true, appId: install.app.id };
}

function orderField(data: Record<string, unknown>, key: string, expectedId: string): QueryCheck {
  const order = data[key];
  if (order === null) {
    return checkFail(`${key} order is null — transient or review, never a pass`);
  }
  if (!isObject(order)) return checkFail(`${key} order is not an object`);
  if (order.id !== expectedId) {
    return checkFail(`${key}.id ${JSON.stringify(order.id)} does not equal the requested ${expectedId}`);
  }
  if (typeof order.id !== "string" || !ORDER_GID_RE.test(order.id)) {
    return checkFail(`${key}.id is not an order GID`);
  }
  return checkOk;
}

/**
 * A plain-array field whose elements are objects carrying a unique typed id
 * (`refunds` / `transactions` on Q-RECHECK and Q-RECONCILE). Completeness is
 * still the <50 bound; every element must be an object with a GID of the
 * expected resource type, and a duplicated id is never a complete read.
 */
function validateBoundedIdList(value: unknown, label: string, re: RegExp): QueryCheck {
  const bounds = validatePlainArrayField(value, label);
  if (!bounds.ok) return bounds;
  const seen = new Set<string>();
  for (const [i, el] of (value as unknown[]).entries()) {
    if (!isObject(el) || typeof el.id !== "string" || !re.test(el.id)) {
      return checkFail(`${label}[${i}] is not an object with a valid id`);
    }
    if (seen.has(el.id)) {
      return checkFail(`${label}[${i}] duplicates id ${JSON.stringify(el.id)}`);
    }
    seen.add(el.id);
  }
  return checkOk;
}

/**
 * Q-RECHECK (12.1): both orders must be present and equal the requested ids
 * (an absent source or primary is a transient or review outcome, never a
 * pass), and the source's `refunds`/`transactions` are bounded arrays of
 * elements whose unique typed ids prove the list is real.
 */
export function validateExecRecheck(
  body: unknown,
  expected: { readonly sourceOrderId: string; readonly primaryOrderId: string },
): QueryCheck {
  const r = dataField(body);
  if (!("data" in r)) return r;
  const src = orderField(r.data, "source", expected.sourceOrderId);
  if (!src.ok) return src;
  const pri = orderField(r.data, "primary", expected.primaryOrderId);
  if (!pri.ok) return pri;
  const source = r.data.source as Record<string, unknown>;
  const refunds = validateBoundedIdList(source.refunds, "source.refunds", REFUND_GID_RE);
  if (!refunds.ok) return refunds;
  const transactions = validateBoundedIdList(
    source.transactions,
    "source.transactions",
    ORDER_TRANSACTION_GID_RE,
  );
  if (!transactions.ok) return transactions;
  return checkOk;
}

/**
 * Q-RECONCILE (12.1.2): the secondary's refund list. The order must be
 * present and equal sourceOrderId; `refunds` and `transactions` are bounded
 * arrays of elements with unique typed ids — a malformed or duplicated id
 * means the list cannot prove completeness.
 */
export function validateRefundList(
  body: unknown,
  expected: { readonly sourceOrderId: string },
): QueryCheck {
  const r = dataField(body);
  if (!("data" in r)) return r;
  const ord = orderField(r.data, "order", expected.sourceOrderId);
  if (!ord.ok) return ord;
  const order = r.data.order as Record<string, unknown>;
  const refunds = validateBoundedIdList(order.refunds, "order.refunds", REFUND_GID_RE);
  if (!refunds.ok) return refunds;
  const transactions = validateBoundedIdList(
    order.transactions,
    "order.transactions",
    ORDER_TRANSACTION_GID_RE,
  );
  if (!transactions.ok) return transactions;
  return checkOk;
}

/**
 * Q-REFUND-DETAIL (12.1.2): nested records for the bounded id set.
 * Fail-closed on every rule the section states:
 *  - nodes length must equal the number of requested ids;
 *  - every element must be an object carrying the requested id at that
 *    position (a non-matching fragment has no `id`; a missing id is null);
 *  - ids must be unique (order-sensitive equality implies both);
 *  - `order.id` must equal the row's sourceOrderId;
 *  - every nested connection's pageInfo.hasNextPage must be exactly false;
 *  - `orderAdjustments` must be empty for our own refund (a shipping-only
 *    refund carries no adjustments) — a non-empty list is a contradiction.
 */
export function validateRefundDetailResponse(
  body: unknown,
  requestedIds: readonly string[],
  expected: { readonly sourceOrderId: string; readonly ownRefundId?: string },
): QueryCheck {
  const bound = validateDetailRequestIds(requestedIds);
  if (!bound.ok) return bound;
  const r = dataField(body);
  if (!("data" in r)) return r;
  const nodes = r.data.nodes;
  if (!Array.isArray(nodes)) return checkFail("nodes is not an array");
  if (nodes.length !== requestedIds.length) {
    return checkFail(
      `nodes length ${nodes.length} does not equal the ${requestedIds.length} requested ids`,
    );
  }
  for (const [i, node] of nodes.entries()) {
    const label = `nodes[${i}]`;
    if (!isObject(node)) {
      return checkFail(`${label}: expected a Refund object for id ${requestedIds[i]}, got ${node === null ? "null" : typeof node}`);
    }
    if (node.id !== requestedIds[i]) {
      return checkFail(
        `${label}: id ${JSON.stringify(node.id)} does not match requested id ${requestedIds[i]}`,
      );
    }
    if (!isObject(node.order) || node.order.id !== expected.sourceOrderId) {
      return checkFail(`${label}: order.id does not equal the row's sourceOrderId`);
    }
    // `duties` is a nullable [RefundDuty!] list (F19): anything that is not an
    // array — null, a bare object, a number — is unproven completeness, never
    // an empty list a classifier could read as "no duties".
    if (!Array.isArray(node.duties)) {
      return checkFail(`${label}.duties: expected an array, got ${node.duties === null ? "null" : typeof node.duties}`);
    }
    for (const conn of ["refundShippingLines", "refundLineItems", "orderAdjustments", "transactions"] as const) {
      const c = validateCompleteConnection(node[conn], `${label}.${conn}`);
      if (!c.ok) return c;
    }
    if (expected.ownRefundId !== undefined && node.id === expected.ownRefundId) {
      const adjustments = node.orderAdjustments as { nodes: unknown[] };
      if (adjustments.nodes.length !== 0) {
        return checkFail(
          `${label}: orderAdjustments is non-empty for our refund — contradiction`,
        );
      }
    }
  }
  return checkOk;
}

/**
 * One Q-AGREEMENTS page (12.1): the order must be present (a null order is a
 * transient or review outcome, never a pass) and the `agreements` connection
 * must be a well-formed connection page — a nodes array of typed agreement
 * objects and a pageInfo with a boolean hasNextPage (true is legal here; the
 * caller paginates up to AGREEMENTS_MAX_PAGES via endCursor). Anything
 * malformed is "completeness unproven". The document binds the order through
 * its $source variable and does not select `id`, so no order.id check is
 * possible here — the document's own selection set defines the shape.
 */
export function validateAgreementsPage(
  body: unknown,
  expected: { readonly sourceOrderId: string },
): QueryCheck {
  const r = dataField(body);
  if (!("data" in r)) return r;
  void expected; // the document binds the order via $source; no id is selected
  const order = r.data.order;
  if (order === null || order === undefined) {
    return checkFail("order is null — transient or review, never a pass");
  }
  if (!isObject(order)) return checkFail("order is not an object");
  const agreements = order.agreements;
  if (!isObject(agreements)) return checkFail("order.agreements is not a connection object");
  if (!Array.isArray(agreements.nodes)) return checkFail("order.agreements.nodes is not an array");
  for (const [i, node] of agreements.nodes.entries()) {
    if (!isObject(node) || typeof node.__typename !== "string" || typeof node.id !== "string") {
      return checkFail(`order.agreements.nodes[${i}] is not a typed agreement object`);
    }
  }
  const pageInfo = agreements.pageInfo;
  if (!isObject(pageInfo) || typeof pageInfo.hasNextPage !== "boolean") {
    return checkFail("order.agreements.pageInfo.hasNextPage must be a boolean");
  }
  if (pageInfo.hasNextPage && (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor.length === 0)) {
    return checkFail("order.agreements.pageInfo.endCursor missing while hasNextPage is true");
  }
  return checkOk;
}
