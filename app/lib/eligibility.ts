// ── Merge eligibility rules ───────────────────────────────────────────────────
// Pure functions shared by the orders/create webhook (candidate discovery) and
// executeMerge (authoritative re-check). Every rule is conservative: when
// MergeShip cannot positively confirm two orders are safe to combine, they are
// not eligible.

// ── Normalization ─────────────────────────────────────────────────────────────

export const normalizeAddressLine = (line: string | null | undefined): string =>
  line
    ?.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim() ?? "";

/** Trims, collapses whitespace and lowercases so "Standard Shipping " and
 *  "standard  shipping" compare equal. */
export const normalizeShippingTitle = (title: string | null | undefined): string =>
  title?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";

export interface AddressFields {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  provinceCode?: string | null;
  zip?: string | null;
  countryCodeV2?: string | null;
}

// \0 cannot appear in IDs, address text or titles, so it is a safe separator.
const SEP = "\0";

/**
 * Key of (customer) + (recipient + full address). Fields are compared
 * positionally — an empty field stays an empty slot, so values can never shift
 * into a neighbouring field and collide. The recipient name and company are
 * part of the key because the merged package ships under the primary's label.
 * Returns null when there is no customer or the address lacks a street line or
 * country.
 */
export function buildAddressKey(
  customerId: string | null | undefined,
  address: AddressFields | null | undefined,
): string | null {
  if (!customerId || !address) return null;
  const fields = [
    address.firstName,
    address.lastName,
    address.company,
    address.address1,
    address.address2,
    address.city,
    address.provinceCode,
    address.zip,
    address.countryCodeV2,
  ].map(normalizeAddressLine);
  const [, , , address1, , , , , country] = fields;
  if (!address1 || !country) return null;
  return [customerId, ...fields].join(SEP);
}

/**
 * Key of (customer) + (recipient/address) + (shipping method). Orders must
 * have exactly one shipping line; multiple or missing shipping lines cannot be
 * confidently compared and make the order ineligible.
 */
export function buildGroupKey(
  customerId: string | null | undefined,
  address: AddressFields | null | undefined,
  shippingTitles: (string | null | undefined)[],
): string | null {
  const addressKey = buildAddressKey(customerId, address);
  if (!addressKey || shippingTitles.length !== 1) return null;
  const title = normalizeShippingTitle(shippingTitles[0]);
  if (!title) return null;
  return `${addressKey}${SEP}${title}`;
}

// ── Order-level state ─────────────────────────────────────────────────────────

export interface OrderState {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  closed: boolean;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  riskLevel: string | null;
  currencyCode: string;
  presentmentCurrencyCode: string;
  customer: { id: string } | null;
  shippingAddress: AddressFields | null;
  shippingLines: { nodes: { title: string | null }[] };
  fulfillments: { id: string }[];
  note?: string | null;
  tags?: string[];
}

/** Returns why the order may not take part in a merge, or null if it may. */
export function orderStateIneligibility(order: OrderState): string | null {
  if (order.cancelledAt) return `Order ${order.name} is cancelled.`;
  if (order.closed) return `Order ${order.name} is closed.`;
  if (order.displayFinancialStatus !== "PAID") {
    return `Order ${order.name} is not fully paid (${order.displayFinancialStatus ?? "unknown"}).`;
  }
  // Only a completely untouched order qualifies. PARTIALLY_FULFILLED,
  // IN_PROGRESS (accepted by a fulfillment service), PENDING_FULFILLMENT,
  // ON_HOLD, SCHEDULED etc. are all rejected.
  if (order.displayFulfillmentStatus !== "UNFULFILLED") {
    return `Order ${order.name} is not unfulfilled (${order.displayFulfillmentStatus ?? "unknown"}).`;
  }
  if (order.fulfillments.length > 0) {
    return `Order ${order.name} already has fulfillment activity.`;
  }
  if (order.riskLevel !== "LOW") {
    return `Order ${order.name} has Shopify fraud risk ${order.riskLevel ?? "UNKNOWN"}; only LOW-risk orders are merged.`;
  }
  if (!order.customer?.id) return `Order ${order.name} has no customer.`;
  return null;
}

// ── Line-item level ───────────────────────────────────────────────────────────

export interface MergeLineItem {
  id?: string;
  name: string;
  quantity: number;
  currentQuantity: number;
  unfulfilledQuantity: number;
  nonFulfillableQuantity: number;
  requiresShipping: boolean;
  isGiftCard: boolean;
  variant: { id: string } | null;
  customAttributes: { key: string; value: string | null }[];
  sellingPlan: { name: string | null } | null;
  lineItemGroup: { id: string } | null;
}

/** Returns why this order's line items block a merge, or null. */
export function lineItemIneligibility(
  orderName: string,
  items: MergeLineItem[],
  isSecondary: boolean,
): string | null {
  for (const item of items) {
    if (item.currentQuantity <= 0) continue; // removed from the order already
    if (item.customAttributes.length > 0) {
      // orderEditAddVariant cannot carry line-item properties over.
      return `Order ${orderName} has line items with custom properties.`;
    }
    if (item.isGiftCard) return `Order ${orderName} contains a gift card.`;
    if (item.sellingPlan) return `Order ${orderName} contains a subscription item.`;
    if (item.lineItemGroup) return `Order ${orderName} contains a product bundle.`;
    if (!item.requiresShipping) return `Order ${orderName} contains an item that does not require shipping.`;
    if (item.nonFulfillableQuantity > 0 || item.unfulfilledQuantity !== item.currentQuantity) {
      return `Order ${orderName} has line items that are not fully unfulfilled.`;
    }
    if (isSecondary && !item.variant?.id) {
      return `Order ${orderName} contains "${item.name}", a custom item or deleted product that cannot be transferred.`;
    }
  }
  if (!items.some((item) => item.currentQuantity > 0)) {
    return `Order ${orderName} has no remaining line items.`;
  }
  return null;
}

// ── Group evaluation ──────────────────────────────────────────────────────────

export type GroupEvaluation<T extends OrderState> =
  | { ok: true; primary: T; secondaries: T[] }
  | { ok: false; reason: string };

/**
 * Authoritative eligibility check for a candidate group. The oldest order is
 * the primary. Every order must pass the state and line-item rules, share one
 * group key (customer, recipient, address, single shipping method) and share
 * both shop and presentment currency.
 */
export function evaluateMergeGroup<T extends OrderState>(
  orders: T[],
  lineItemsById: Map<string, MergeLineItem[]>,
): GroupEvaluation<T> {
  if (orders.length < 2) return { ok: false, reason: "At least two orders are required to merge." };

  const sorted = [...orders].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  if (sorted.some((o) => isNaN(new Date(o.createdAt).getTime()))) {
    return { ok: false, reason: "An order has an unreadable creation date." };
  }
  const [primary, ...secondaries] = sorted;

  for (const order of sorted) {
    const reason = orderStateIneligibility(order);
    if (reason) return { ok: false, reason };
  }

  const keys = sorted.map((o) =>
    buildGroupKey(
      o.customer?.id,
      o.shippingAddress,
      o.shippingLines.nodes.map((l) => l.title),
    ),
  );
  if (keys.some((k) => !k || k !== keys[0])) {
    return {
      ok: false,
      reason: "Orders do not share the same customer, recipient, shipping address and single shipping method.",
    };
  }

  const currencyMismatch = sorted.find(
    (o) =>
      o.currencyCode !== primary.currencyCode ||
      o.presentmentCurrencyCode !== primary.presentmentCurrencyCode,
  );
  if (currencyMismatch) {
    return { ok: false, reason: `Order ${currencyMismatch.name} uses a different currency.` };
  }

  for (const order of sorted) {
    const items = lineItemsById.get(order.id);
    if (!items) return { ok: false, reason: `Line items for ${order.name} were not loaded.` };
    const reason = lineItemIneligibility(order.name, items, order !== primary);
    if (reason) return { ok: false, reason };
  }

  return { ok: true, primary, secondaries };
}
