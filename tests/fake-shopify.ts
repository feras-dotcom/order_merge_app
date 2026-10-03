// In-memory stand-in for the Shopify Admin GraphQL API and the merge journal,
// covering exactly the operations merge.server.ts performs. Each operation is
// dispatched by its GraphQL operation name; tests inject failures per name.

import type {
  FulfillmentOrderInfo,
  MergeLineItem,
  OrderState,
  ShippingLineInfo,
} from "../app/lib/eligibility";
import type {
  MergeHistoryEntry,
  MergeJournal,
  MergeOperationRecord,
  NewMergeOperation,
} from "../app/lib/merge-journal.server";
import type { MergeDeps } from "../app/lib/merge.server";
import type { ClaimStore } from "../app/lib/claims.server";
import type {
  AttemptKind,
  ControlRow,
  MutationAttempt,
  NewOperationV2,
  OperationPatch,
  OperationPhase,
  OperationRecord,
  OperationStore,
} from "../app/lib/operation-store.server";
import { ClaimContentionError, OwnershipLostError } from "../app/lib/ownership.server";
import { isOnboardingComplete } from "../app/lib/onboarding";
import type { MergeSettings } from "../app/lib/settings.server";
import { runSweepOnce, type SweepContext } from "../app/lib/background-worker.server";
import { processOrderWork } from "../app/lib/order-work-processor.server";
import {
  MAX_ATTEMPTS,
  WORK_DEADLINE_MS,
  type WorkItem,
  type WorkOutcome,
  type WorkStore,
} from "../app/lib/order-work.server";

export interface FakeOrder extends OrderState {
  lineItems: MergeLineItem[];
  /** Reads of the order before a requested cancellation becomes visible. */
  cancelDelayReads?: number;
  pendingCancelReads?: number | null;
  /** The staffNote a delayed cancellation applies once it becomes visible. */
  pendingStaffNote?: string | null;
  /** Job id of the in-flight orderCancel (delay mode). */
  pendingCancelJobId?: string | null;
  cancelCount: number;
  /** Shopify's Order.cancellation — set when the order is cancelled. */
  cancellation?: { staffNote: string | null } | null;
  /** OrderEditAgreement history (app + sales attribution for evidence). */
  agreements?: any[];
  /** Explicit fulfillment orders; by default one OPEN fulfillment order at
   *  `location` covering every line item. */
  fulfillmentOrders?: FulfillmentOrderInfo[];
  location?: string;
}

export const LOC_A = "gid://shopify/Location/1";
export const LOC_B = "gid://shopify/Location/2";
/** The app id evidence checks attribute OrderEditAgreements to. */
export const APP_ID = "gid://shopify/App/426185785345";
/** A different app id used for merchant/unrelated edits. */
export const OTHER_APP_ID = "gid://shopify/App/999";

export function makeFulfillmentOrder(
  location: string | null,
  items: { id?: string; currentQuantity: number }[],
  overrides: Partial<FulfillmentOrderInfo> = {},
): FulfillmentOrderInfo {
  return {
    status: "OPEN",
    requestStatus: "UNSUBMITTED",
    fulfillmentHolds: [],
    assignedLocation: { location: location ? { id: location } : null },
    lineItems: {
      nodes: items.map((i) => ({ remainingQuantity: i.currentQuantity, lineItem: { id: i.id! } })),
      pageInfo: { hasNextPage: false },
    },
    ...overrides,
  };
}

type Handler = (vars: any) => any;
/** Returning undefined falls through to the default behaviour. May be async —
 *  a returned Promise is awaited, so a test can pause one worker mid-call
 *  while a second worker runs. */
export type Interceptor = (vars: any, call: number) => any | Promise<any> | undefined;

let lineItemSeq = 1000;

export function makeLineItem(overrides: Partial<MergeLineItem> = {}): MergeLineItem {
  const id = `gid://shopify/LineItem/${lineItemSeq++}`;
  return {
    id,
    name: "T-Shirt",
    quantity: 1,
    currentQuantity: 1,
    unfulfilledQuantity: 1,
    nonFulfillableQuantity: 0,
    requiresShipping: true,
    isGiftCard: false,
    variant: { id: "gid://shopify/ProductVariant/1" },
    customAttributes: [],
    sellingPlan: null,
    lineItemGroup: null,
    ...overrides,
  };
}

/** A shipping-profile rate, shaped like the live data for "International Shipping". */
export function standardRate(overrides: Partial<ShippingLineInfo> = {}): ShippingLineInfo {
  return {
    title: "Standard",
    code: "Standard",
    source: "shopify",
    carrierIdentifier: null,
    custom: false,
    originalPriceSet: { shopMoney: { amount: "5.0", currencyCode: "USD" } },
    ...overrides,
  };
}

/** A manually entered rate, shaped like the live data for Draft Order "Custom" shipping. */
export function customRate(amount: string, overrides: Partial<ShippingLineInfo> = {}): ShippingLineInfo {
  return standardRate({
    title: "Custom",
    code: "custom",
    custom: true,
    originalPriceSet: { shopMoney: { amount, currencyCode: "USD" } },
    ...overrides,
  });
}

export function makeOrder(
  n: number,
  overrides: Partial<FakeOrder> = {},
): FakeOrder {
  return {
    id: `gid://shopify/Order/${n}`,
    name: `#${n}`,
    createdAt: new Date(Date.UTC(2026, 9, 1, 10, n)).toISOString(),
    cancelledAt: null,
    closed: false,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    riskLevel: "LOW",
    currencyCode: "USD",
    presentmentCurrencyCode: "USD",
    customer: { id: "gid://shopify/Customer/1" },
    shippingAddress: {
      firstName: "Jane",
      lastName: "Doe",
      company: null,
      address1: "1 Main St",
      address2: null,
      city: "Springfield",
      provinceCode: "IL",
      zip: "62701",
      countryCodeV2: "US",
    },
    shippingLines: { nodes: [standardRate()] },
    fulfillments: [],
    note: null,
    tags: [],
    lineItems: [makeLineItem()],
    cancellation: null,
    agreements: [],
    cancelCount: 0,
    ...overrides,
  };
}

export class FakeShopify {
  orders = new Map<string, FakeOrder>();
  activeLocations = 1;
  /** Whether the optional read_merchant_managed_fulfillment_orders scope is granted. */
  fulfillmentOrdersScope = false;
  /** Whether the optional read_locations scope is granted. Without it Shopify
   *  denies assignedLocation.location even when fulfillment orders are readable. */
  locationsScope = false;
  /** locationId passed to each orderEditAddVariant call. */
  addVariantLocations: (string | null | undefined)[] = [];
  /** Index-lag knob: ids listed here are invisible to the candidate search
   *  (MergeCandidateOrders) only — direct order loads still see them. */
  hiddenFromSearch = new Set<string>();
  /** Page size for the MergeOrderEvidence connections (0 = unlimited). */
  evidencePageSize = 0;
  /** v2: commit behaviour per calc id (or '*'):
   *  apply — applies immediately and returns success;
   *  lose-apply-later — the response is lost; the commit applies when
   *    deliverPendingCommit(calcId) is called;
   *  lose-never — the response is lost and the commit never applies;
   *  reject — the definitive userError "The calculated order does not exist.";
   *  reject-internal — an ambiguous "Internal error" userError; the commit
   *    may still apply via deliverPendingCommit. */
  commitMode = new Map<string, "apply" | "lose-apply-later" | "lose-never" | "reject" | "reject-internal">();
  /** v2: orderCancel behaviour per order id (or '*'):
   *  apply — cancels and returns the job;
   *  delay — accepts the job; cancelledAt becomes visible after reads;
   *  lose — applies but returns a top-level error (response lost);
   *  reject — an orderCancelUserErrors entry, no state change. */
  cancelMode = new Map<string, "apply" | "delay" | "lose" | "reject">();
  /** job(id).done responses, keyed by job gid. */
  jobs = new Map<string, { done: boolean }>();
  /** orderUpdate inputs seen, for asserting tags are never written there. */
  orderUpdateInputs: any[] = [];
  /** Shared clock for agreement happenedAt / cancelledAt (the harness sets it
   *  to the fake clock so evidence windows compare on one timeline). */
  clock: () => Date = () => new Date();
  calls: string[] = [];
  interceptors = new Map<string, Interceptor>();
  private callCounts = new Map<string, number>();
  private edits = new Map<
    string,
    {
      orderId: string;
      added: { calculatedLineItemId: string; variantId: string; quantity: number; description: string }[];
      saved: boolean;
    }
  >();
  private pendingCommits = new Map<string, { orderId: string; added: any[]; saved: boolean }>();
  private editSeq = 1;
  private jobSeq = 1;
  private agreementSeq = 1;

  constructor(orders: FakeOrder[]) {
    for (const o of orders) this.orders.set(o.id, o);
  }

  order(n: number) {
    return this.orders.get(`gid://shopify/Order/${n}`)!;
  }

  mutationCalls(name: string) {
    return this.calls.filter((c) => c === name).length;
  }

  /** Called before an operation's default handler; may mutate state. */
  on(name: string, fn: Interceptor) {
    this.interceptors.set(name, fn);
    return this;
  }

  private snapshot(o: FakeOrder): OrderState {
    // Simulate orderCancel being asynchronous.
    if (o.pendingCancelReads != null) {
      if (o.pendingCancelReads <= 0) {
        this.applyCancel(o, o.pendingStaffNote ?? null, o.pendingCancelJobId ?? null);
        o.pendingCancelReads = null;
        o.pendingStaffNote = null;
        o.pendingCancelJobId = null;
      } else {
        o.pendingCancelReads -= 1;
      }
    }
    const {
      lineItems,
      cancelDelayReads,
      pendingCancelReads,
      pendingStaffNote,
      pendingCancelJobId,
      cancelCount,
      fulfillmentOrders,
      location,
      agreements,
      ...state
    } = o;
    return structuredClone(state);
  }

  /** Marks an order cancelled with the staffNote Shopify recorded. */
  private applyCancel(o: FakeOrder, staffNote: string | null, jobId: string | null) {
    o.cancelledAt = this.clock().toISOString();
    o.cancellation = { staffNote };
    if (jobId) {
      const job = this.jobs.get(jobId);
      if (job) job.done = true;
    }
  }

  fulfillmentOrdersOf(o: FakeOrder): FulfillmentOrderInfo[] {
    return o.fulfillmentOrders ?? [makeFulfillmentOrder(o.location ?? LOC_A, o.lineItems)];
  }

  private handlers: Record<string, Handler> = {
    MergeLocationCount: () => ({ data: { locationsCount: { count: this.activeLocations } } }),
    // The customer's recent orders, matching the route's search filter
    // (open, unfulfilled, paid) — minus the index-lag knob.
    MergeCandidateOrders: ({ customerId }) => ({
      data: {
        customer: {
          orders: {
            nodes: [...this.orders.values()]
              .filter(
                (o) =>
                  o.customer?.id === customerId &&
                  !o.cancelledAt &&
                  !o.closed &&
                  o.displayFinancialStatus === "PAID" &&
                  o.displayFulfillmentStatus === "UNFULFILLED" &&
                  !this.hiddenFromSearch.has(o.id),
              )
              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
              .map((o) => ({
                id: o.id,
                name: o.name,
                createdAt: o.createdAt,
                shippingAddress: structuredClone(o.shippingAddress),
                shippingLines: structuredClone(o.shippingLines),
              })),
          },
        },
      },
    }),
    MergeOrderState: ({ ids }) => ({
      data: { nodes: ids.map((id: string) => (this.orders.has(id) ? this.snapshot(this.orders.get(id)!) : null)) },
    }),
    MergeOrderLineItems: ({ id }) => {
      const o = this.orders.get(id);
      return {
        data: {
          order: o && {
            lineItems: {
              nodes: structuredClone(o.lineItems),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    },
    MergeFulfillmentOrders: ({ id }) => {
      if (!this.fulfillmentOrdersScope) {
        return {
          errors: [{ message: "Access denied for fulfillmentOrders field.", extensions: { code: "ACCESS_DENIED" } }],
          data: { order: null },
        };
      }
      if (!this.locationsScope) {
        // Exact shape observed live on ordermergetest2 with only the first scope granted.
        return {
          errors: [
            {
              message:
                "Access denied for location field. Required access: `read_locations` access scope, `read_inventory` access scope or `read_markets_home` access scope.",
              extensions: { code: "ACCESS_DENIED" },
              path: ["order", "fulfillmentOrders", "nodes", 0, "assignedLocation", "location"],
            },
          ],
        };
      }
      const o = this.orders.get(id);
      return {
        data: {
          order: o && {
            fulfillmentOrders: {
              nodes: structuredClone(this.fulfillmentOrdersOf(o)),
              pageInfo: { hasNextPage: false },
            },
          },
        },
      };
    },
    MergeEditBegin: ({ id }) => {
      const calcId = `gid://shopify/CalculatedOrder/${this.editSeq++}`;
      this.edits.set(calcId, { orderId: id, added: [], saved: false });
      return { data: { orderEditBegin: { calculatedOrder: { id: calcId }, userErrors: [] } } };
    },
    MergeEditAddVariant: ({ id, variantId, quantity, locationId }) => {
      this.addVariantLocations.push(locationId);
      const edit = this.edits.get(id)!;
      const calculatedLineItemId = `calc-li-${lineItemSeq++}`;
      edit.added.push({ calculatedLineItemId, variantId, quantity, description: "" });
      return { data: { orderEditAddVariant: { calculatedLineItem: { id: calculatedLineItemId }, userErrors: [] } } };
    },
    MergeEditDiscount: ({ id, lineItemId, discount }) => {
      const edit = this.edits.get(id)!;
      const line = edit.added.find((a) => a.calculatedLineItemId === lineItemId);
      if (line) line.description = discount.description ?? "";
      return { data: { orderEditAddLineItemDiscount: { calculatedLineItem: { id: lineItemId }, userErrors: [] } } };
    },
    // Shopify stops returning a committed calculated order (2026-01+).
    MergeCalculatedOrder: ({ id }) => {
      const edit = this.edits.get(id) ?? this.pendingCommits.get(id);
      if (!edit || edit.saved) return { data: { node: null } };
      return {
        data: {
          node: {
            id,
            addedLineItems: {
              nodes: edit.added.map((a) => ({
                id: a.calculatedLineItemId,
                quantity: a.quantity,
                variant: { id: a.variantId },
                calculatedDiscountAllocations: [
                  { discountApplication: { description: a.description } },
                ],
              })),
            },
          },
        },
      };
    },
    MergeEditCommit: ({ id }) => {
      const edit = this.edits.get(id) ?? this.pendingCommits.get(id);
      if (!edit || edit.saved) {
        return {
          data: {
            orderEditCommit: {
              order: null,
              userErrors: [{ field: null, message: "The calculated order has already been saved." }],
            },
          },
        };
      }
      const mode = this.commitMode.get(id) ?? this.commitMode.get("*") ?? "apply";
      if (mode === "reject") {
        return {
          data: {
            orderEditCommit: {
              order: null,
              // The wording Shopify uses for an already-consumed calculated
              // order — the only userError that definitively means "not us".
              userErrors: [{ field: null, message: "The calculated order does not exist." }],
            },
          },
        };
      }
      if (mode === "reject-internal") {
        // An ambiguous rejection: the response says error, but the commit
        // may still apply — parked until deliverPendingCommit.
        this.pendingCommits.set(id, edit);
        return {
          data: {
            orderEditCommit: {
              order: null,
              userErrors: [{ field: null, message: "Internal error" }],
            },
          },
        };
      }
      edit.saved = true;
      if (mode === "apply") {
        this.applyCommit(id);
        return { data: { orderEditCommit: { order: { id: edit.orderId }, userErrors: [] } } };
      }
      // The response never reached the caller; the commit may still apply.
      if (mode === "lose-apply-later") this.pendingCommits.set(id, edit);
      return { errors: [{ message: "upstream request timeout" }] };
    },
    MergeCancelSecondary: ({ orderId, staffNote }) => {
      const o = this.orders.get(orderId)!;
      o.cancelCount += 1;
      if (o.cancelledAt) {
        return {
          data: {
            orderCancel: {
              job: null,
              order: { id: o.id },
              orderCancelUserErrors: [
                { field: null, message: "Cannot cancel an order that has already been canceled", code: "INVALID" },
              ],
            },
          },
        };
      }
      const mode = this.cancelMode.get(orderId) ?? this.cancelMode.get("*") ?? "apply";
      if (mode === "reject") {
        return {
          data: {
            orderCancel: {
              job: null,
              order: { id: o.id },
              orderCancelUserErrors: [
                { field: null, message: "The order cannot be canceled", code: "INTERNAL_ERROR" },
              ],
            },
          },
        };
      }
      const jobId = `gid://shopify/Job/${this.jobSeq++}`;
      if (mode === "lose") {
        // Applied but the response never reached the caller.
        this.applyCancel(o, staffNote ?? null, jobId);
        return { errors: [{ message: "upstream request timeout" }] };
      }
      if (mode === "delay" || o.cancelDelayReads) {
        o.pendingCancelReads = o.cancelDelayReads ?? 2;
        o.pendingStaffNote = staffNote ?? null;
        o.pendingCancelJobId = jobId;
        this.jobs.set(jobId, { done: false });
        return { data: { orderCancel: { job: { id: jobId }, order: { id: o.id }, orderCancelUserErrors: [] } } };
      }
      this.jobs.set(jobId, { done: true });
      this.applyCancel(o, staffNote ?? null, jobId);
      return { data: { orderCancel: { job: { id: jobId }, order: { id: o.id }, orderCancelUserErrors: [] } } };
    },
    MergeJob: ({ id }) => ({ data: { job: { done: this.jobs.get(id)?.done ?? false } } }),
    MergeCurrentApp: () => ({ data: { currentAppInstallation: { app: { id: APP_ID } } } }),
    // The §6 evidence read: line items with discount allocations + agreements,
    // both paginated when evidencePageSize is set (cursors are opaque "cursor-N").
    MergeOrderEvidence: ({ id, after, agreementsAfter }) => {
      const o = this.orders.get(id);
      const paginate = (all: any[], cursor: string | null | undefined) => {
        if (!this.evidencePageSize) {
          return { nodes: structuredClone(all), pageInfo: { hasNextPage: false, endCursor: null } };
        }
        const start = cursor ? Number(cursor.replace("cursor-", "")) + 1 : 0;
        const nodes = all.slice(start, start + this.evidencePageSize);
        const end = start + nodes.length - 1;
        return {
          nodes: structuredClone(nodes),
          pageInfo: {
            hasNextPage: end < all.length - 1,
            endCursor: nodes.length ? `cursor-${end}` : null,
          },
        };
      };
      return {
        data: {
          order: o && {
            lineItems: paginate(o.lineItems, after),
            agreements: paginate(o.agreements ?? [], agreementsAfter),
          },
        },
      };
    },
    MergeTagsAdd: ({ id, tags }) => {
      const o = this.orders.get(id)!;
      o.tags = [...new Set([...(o.tags ?? []), ...(tags as string[])])];
      return { data: { tagsAdd: { node: { id }, userErrors: [] } } };
    },
    MergeAnnotateNote: ({ input }) => {
      const o = this.orders.get(input.id)!;
      this.orderUpdateInputs.push(input);
      if (input.note !== undefined) o.note = input.note;
      return { data: { orderUpdate: { order: { id: o.id, note: o.note }, userErrors: [] } } };
    },
    MergeOrderClose: ({ input }) => {
      this.orders.get(input.id)!.closed = true;
      return { data: { orderClose: { order: { id: input.id }, userErrors: [] } } };
    },
    // Legacy names kept so older tests' interceptors keep working if called.
    MergeAnnotateOrder: ({ input }) => {
      const o = this.orders.get(input.id)!;
      this.orderUpdateInputs.push(input);
      if (input.tags) o.tags = input.tags;
      if (input.note !== undefined) o.note = input.note;
      return { data: { orderUpdate: { order: { id: o.id }, userErrors: [] } } };
    },
    MergeCloseSecondary: ({ input }) => {
      this.orders.get(input.id)!.closed = true;
      return { data: { orderClose: { order: { id: input.id }, userErrors: [] } } };
    },
  };

  /**
   * Applies a calculated order to the real order (what a commit does): the
   * added lines appear with a fully-covering ManualDiscountApplication whose
   * description carries the op token, inside one OrderEditAgreement
   * attributed to this app with happenedAt on the fake clock.
   */
  applyCommit(calcId: string) {
    const edit = this.edits.get(calcId) ?? this.pendingCommits.get(calcId);
    if (!edit) return;
    edit.saved = true;
    const order = this.orders.get(edit.orderId)!;
    const sales: any[] = [];
    for (const added of edit.added) {
      const item: any = makeLineItem({
        variant: { id: added.variantId },
        quantity: added.quantity,
        currentQuantity: added.quantity,
        unfulfilledQuantity: added.quantity,
      });
      // originalUnitPriceSet is the UNIT price; the allocation covers it fully.
      item.originalUnitPriceSet = { shopMoney: { amount: "10.00" } };
      item.discountAllocations = [
        {
          allocatedAmountSet: { shopMoney: { amount: (10 * added.quantity).toFixed(2) } },
          discountApplication: {
            __typename: "ManualDiscountApplication",
            title: added.description,
            description: added.description,
          },
        },
      ];
      order.lineItems.push(item);
      sales.push({
        __typename: "ProductSale",
        quantity: added.quantity,
        actionType: "ORDER",
        lineItem: { id: item.id },
      });
    }
    (order.agreements ??= []).push({
      __typename: "OrderEditAgreement",
      id: `gid://shopify/OrderEditAgreement/${this.agreementSeq++}`,
      happenedAt: this.clock().toISOString(),
      app: { id: APP_ID },
      sales: { nodes: sales, pageInfo: { hasNextPage: false } },
    });
    this.edits.delete(calcId);
    this.pendingCommits.delete(calcId);
  }

  /** Applies a commit whose response was lost (lose-apply-later mode). */
  deliverPendingCommit(calcId: string) {
    this.applyCommit(calcId);
  }

  /** Stages the edit buildOrderEdit would have made — the applyCommit
   *  target — without the begin/addVariant/discount GraphQL ceremony. */
  stageEdit(
    orderId: string,
    added: { variantId: string; quantity: number; description?: string }[],
  ) {
    const calcId = `gid://shopify/CalculatedOrder/${this.editSeq++}`;
    this.edits.set(calcId, {
      orderId,
      added: added.map((a) => ({
        calculatedLineItemId: `calc-li-${lineItemSeq++}`,
        variantId: a.variantId,
        quantity: a.quantity,
        description: a.description ?? "",
      })),
      saved: false,
    });
    return calcId;
  }

  /** An order edit made outside MergeShip: a line without the token and an
   *  agreement attributed to another app. */
  merchantAddLine(orderId: string, variantId = "gid://shopify/ProductVariant/9", quantity = 1) {
    const o = this.orders.get(orderId)!;
    const item: any = makeLineItem({
      variant: { id: variantId },
      quantity,
      currentQuantity: quantity,
      unfulfilledQuantity: quantity,
    });
    item.originalUnitPriceSet = { shopMoney: { amount: "10.00" } };
    item.discountAllocations = [];
    o.lineItems.push(item);
    (o.agreements ??= []).push({
      __typename: "OrderEditAgreement",
      id: `gid://shopify/OrderEditAgreement/${this.agreementSeq++}`,
      happenedAt: this.clock().toISOString(),
      app: { id: OTHER_APP_ID },
      sales: {
        nodes: [{ __typename: "ProductSale", quantity, actionType: "ORDER", lineItem: { id: item.id } }],
        pageInfo: { hasNextPage: false },
      },
    });
    return item;
  }

  /** Deletes the calculated order — Shopify stops returning it once the
   *  edit is committed or expired. */
  deleteCalculatedOrder(calcId: string) {
    this.edits.delete(calcId);
    this.pendingCommits.delete(calcId);
  }

  /** Changes a line's quantity fields together (a post-merge order edit). */
  setLineQuantity(orderId: string, lineItemId: string, qty: number) {
    const item = this.orders.get(orderId)!.lineItems.find((i) => i.id === lineItemId)!;
    item.quantity = qty;
    item.currentQuantity = qty;
    item.unfulfilledQuantity = qty;
  }

  /** A plain new line on the order — no agreement, no token. */
  addSourceLine(orderId: string, variantId = "gid://shopify/ProductVariant/9", quantity = 1) {
    const o = this.orders.get(orderId)!;
    const item = makeLineItem({
      variant: { id: variantId },
      quantity,
      currentQuantity: quantity,
      unfulfilledQuantity: quantity,
    });
    o.lineItems.push(item);
    return item;
  }

  removeLine(orderId: string, lineItemId: string) {
    const o = this.orders.get(orderId)!;
    o.lineItems = o.lineItems.filter((i) => i.id !== lineItemId);
  }

  setLineVariant(orderId: string, lineItemId: string, variantId: string) {
    const item = this.orders.get(orderId)!.lineItems.find((i) => i.id === lineItemId)!;
    item.variant = { id: variantId };
  }

  /** Marks the line fulfilled: no unfulfilled units, a fulfillment object and
   *  a PARTIALLY_FULFILLED display status. */
  fulfillLine(orderId: string, lineItemId: string) {
    const o = this.orders.get(orderId)!;
    const item = o.lineItems.find((i) => i.id === lineItemId)!;
    item.unfulfilledQuantity = 0;
    o.displayFulfillmentStatus = "PARTIALLY_FULFILLED";
    o.fulfillments = [
      ...(o.fulfillments ?? []),
      { id: `gid://shopify/Fulfillment/${(o.fulfillments?.length ?? 0) + 1}` },
    ];
  }

  stripDiscount(orderId: string, lineItemId: string) {
    const item: any = this.orders.get(orderId)!.lineItems.find((i) => i.id === lineItemId)!;
    item.discountAllocations = [];
  }

  rewriteDiscountDescription(orderId: string, lineItemId: string, text: string) {
    const item: any = this.orders.get(orderId)!.lineItems.find((i) => i.id === lineItemId)!;
    for (const alloc of item.discountAllocations ?? []) {
      if (alloc.discountApplication) alloc.discountApplication.description = text;
    }
  }

  setSaleQuantity(orderId: string, agreementId: string, lineItemId: string, qty: number) {
    const o = this.orders.get(orderId)!;
    const agreement = (o.agreements ?? []).find((a) => a.id === agreementId);
    const sale = (agreement?.sales?.nodes ?? []).find((s: any) => s.lineItem?.id === lineItemId);
    if (sale) sale.quantity = qty;
  }

  lastCalcId() {
    return [...this.edits.keys()].at(-1)!;
  }

  admin = {
    graphql: async (query: string, options?: { variables?: Record<string, unknown> }) => {
      const name = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "unknown";
      this.calls.push(name);
      const count = (this.callCounts.get(name) ?? 0) + 1;
      this.callCounts.set(name, count);
      const vars = options?.variables ?? {};
      const intercepted = await this.interceptors.get(name)?.(vars, count);
      if (intercepted !== undefined) return new Response(JSON.stringify(intercepted));
      const handler = this.handlers[name];
      if (!handler) throw new Error(`FakeShopify: unhandled operation ${name}`);
      return new Response(JSON.stringify(handler(vars)));
    },
  };
}

/** In-memory claims with the same token+expiry semantics as the Postgres
 *  store. Share `clock` between workers so their leases race on one timeline. */
export class MemoryClaimStore implements ClaimStore {
  claims = new Map<string, { token: string; leasedUntil: number }>();
  clock: () => Date = () => new Date();

  private key(shop: string, orderId: string) {
    return `${shop} ${orderId}`;
  }

  async acquire(shop: string, orderIds: string[], token: string, ttlMs: number) {
    const ids = [...new Set(orderIds)].sort();
    const now = this.clock().getTime();
    // All-or-nothing, like the transactional insert.
    if (
      ids.some((id) => {
        const claim = this.claims.get(this.key(shop, id));
        return claim && claim.leasedUntil >= now;
      })
    ) {
      return false;
    }
    for (const id of ids) {
      this.claims.set(this.key(shop, id), { token, leasedUntil: now + ttlMs });
    }
    return true;
  }

  async renew(shop: string, orderIds: string[], token: string, ttlMs: number) {
    const now = this.clock().getTime();
    const ids = [...new Set(orderIds)];
    const matched = ids.filter((id) => {
      const claim = this.claims.get(this.key(shop, id));
      return claim && claim.token === token && claim.leasedUntil >= now;
    });
    if (matched.length !== ids.length) {
      throw new OwnershipLostError(`Merge claim lost for ${shop}.`);
    }
    for (const id of ids) this.claims.get(this.key(shop, id))!.leasedUntil = now + ttlMs;
  }

  async release(shop: string, orderIds: string[], token: string) {
    for (const id of new Set(orderIds)) {
      const key = this.key(shop, id);
      if (this.claims.get(key)?.token === token) this.claims.delete(key);
    }
  }

  async reapExpired() {
    const now = this.clock().getTime();
    let reaped = 0;
    for (const [key, claim] of this.claims) {
      if (claim.leasedUntil < now) {
        this.claims.delete(key);
        reaped += 1;
      }
    }
    return reaped;
  }

  async findHeld(shop: string, orderIds: string[]) {
    const now = this.clock().getTime();
    return new Set(
      [...new Set(orderIds)].filter((orderId) => {
        const claim = this.claims.get(this.key(shop, orderId));
        return claim != null && claim.leasedUntil >= now;
      }),
    );
  }
}

export class MemoryJournal implements MergeJournal {
  ops = new Map<string, MergeOperationRecord>();
  /** The companion v2 store. Its rows share the MergeOperation table shape
   *  (a legacy `status` shield next to `phase`), so the v1 queries below must
   *  look at them — and must filter them back out. */
  linkedOps?: MemoryOperationStore;
  history: MergeHistoryEntry[] = [];
  failCreate = false;
  private seq = 1;
  clock: () => Date = () => new Date();

  /** Rows the v1 queries see: this map (legacy fixtures carry no
   *  protocolVersion → 1) plus linkedOps' v2 rows, filtered to version 1 —
   *  exactly what the SQL `protocolVersion = 1` predicate does. */
  private v1Rows(): MergeOperationRecord[] {
    const rows: MergeOperationRecord[] = [
      ...this.ops.values(),
      ...([...(this.linkedOps?.ops.values() ?? [])] as unknown as MergeOperationRecord[]),
    ];
    return rows.filter(
      (o) => ((o as { protocolVersion?: number }).protocolVersion ?? 1) === 1,
    );
  }

  private owned(op: Pick<MergeOperationRecord, "id" | "leaseToken">): MergeOperationRecord {
    const row = this.ops.get(op.id);
    const now = this.clock().getTime();
    if (!row || row.leaseToken !== op.leaseToken || !row.leasedUntil || row.leasedUntil.getTime() < now) {
      throw new OwnershipLostError(`Merge operation ${op.id} is owned by another worker.`);
    }
    return row;
  }

  async create(op: NewMergeOperation, token: string, ttlMs: number) {
    if (this.failCreate) throw new Error("database unavailable");
    const now = this.clock();
    const record: MergeOperationRecord = {
      ...structuredClone(op),
      id: `op-${this.seq++}`,
      attempts: 0,
      lastError: null,
      leaseToken: token,
      leasedUntil: new Date(now.getTime() + ttlMs),
      updatedAt: now,
    };
    this.ops.set(record.id, record);
    return structuredClone(record);
  }
  async update(op: Pick<MergeOperationRecord, "id" | "leaseToken">, patch: Partial<MergeOperationRecord>) {
    Object.assign(this.owned(op), structuredClone(patch), { updatedAt: this.clock() });
  }
  async renew(op: Pick<MergeOperationRecord, "id" | "leaseToken">, ttlMs: number) {
    const row = this.owned(op);
    row.leasedUntil = new Date(this.clock().getTime() + ttlMs);
    row.updatedAt = this.clock();
  }
  async acquireLease(opId: string, token: string, ttlMs: number) {
    const row = this.ops.get(opId);
    const now = this.clock().getTime();
    if (!row || !["PENDING_COMMIT", "COMMITTED"].includes(row.status)) return null;
    if (row.leasedUntil && row.leasedUntil.getTime() >= now) return null;
    row.leaseToken = token;
    row.leasedUntil = new Date(now + ttlMs);
    row.updatedAt = this.clock();
    return structuredClone(row);
  }
  async findUnfinished(shop: string) {
    return this.v1Rows()
      .filter((o) => o.shop === shop && ["PENDING_COMMIT", "COMMITTED"].includes(o.status))
      .map((o) => structuredClone(o) as MergeOperationRecord);
  }
  async findBlockingOrderIds(shop: string) {
    return new Set(
      this.v1Rows()
        .filter((o) => o.shop === shop && ["PENDING_COMMIT", "COMMITTED", "NEEDS_REVIEW"].includes(o.status))
        .flatMap((o) => o.involvedOrderIds),
    );
  }
  async findBlockingOrderStatuses(shop: string) {
    const map = new Map<string, MergeOperationRecord["status"]>();
    for (const o of this.v1Rows()) {
      if (o.shop !== shop || !["PENDING_COMMIT", "COMMITTED", "NEEDS_REVIEW"].includes(o.status)) continue;
      for (const orderId of o.involvedOrderIds) map.set(orderId, o.status);
    }
    return map;
  }
  async findShopsWithUnfinished() {
    return [
      ...new Set(
        this.v1Rows()
          .filter((o) => ["PENDING_COMMIT", "COMMITTED"].includes(o.status))
          .map((o) => o.shop),
      ),
    ];
  }
  async recordHistory(entry: MergeHistoryEntry) {
    if (!this.history.some((h) => h.shop === entry.shop && h.mergedOrderId === entry.mergedOrderId)) {
      this.history.push(entry);
    }
  }
  only() {
    const all = [...this.ops.values()];
    if (all.length !== 1) throw new Error(`expected exactly one op, found ${all.length}`);
    return all[0];
  }
}

export function testDeps(journal: MemoryJournal, overrides: Partial<MergeDeps> = {}): MergeDeps & {
  ops: MemoryOperationStore;
  workStore: MemoryWorkStore;
} {
  let now = new Date("2026-10-01T12:00:00Z").getTime();
  journal.clock = () => new Date(now);
  const claims = new MemoryClaimStore();
  claims.clock = () => new Date(now);
  const workStore = new MemoryWorkStore();
  workStore.clock = () => new Date(now);
  const ops = new MemoryOperationStore(claims, workStore, journal);
  ops.clock = () => new Date(now);
  journal.linkedOps = ops;
  return {
    journal,
    claims,
    leaseTtlMs: 90_000,
    sleep: async (ms: number) => {
      now += ms;
    },
    now: () => new Date(now),
    cancelPollAttempts: 3,
    cancelPollIntervalMs: 1000,
    ...overrides,
    ops: (overrides.ops as MemoryOperationStore | undefined) ?? ops,
    workStore,
    // allow tests to move time forward
    ...({ advance: (ms: number) => (now += ms) } as any),
  } as unknown as MergeDeps & { ops: MemoryOperationStore; workStore: MemoryWorkStore };
}

export const advance = (deps: MergeDeps, ms: number) => (deps as any).advance(ms);

export const topLevelError = (message = "Throttled") => ({ errors: [{ message }] });
export const userError = (root: string, key = "userErrors", message = "Rejected") => ({
  data: { [root]: { [key]: [{ field: null, message }] } },
});

/** In-memory work items with the same conditional semantics as the Postgres
 *  store: token+unexpired(+PENDING) guards on every ownership write, a fresh
 *  token per claimDue row, and "not already leased" standing in for
 *  FOR UPDATE SKIP LOCKED. Share `clock` with the other stores. */
export class MemoryWorkStore implements WorkStore {
  items = new Map<string, WorkItem>();
  private byOrder = new Map<string, string>();
  private seq = 1;
  clock: () => Date = () => new Date();

  private owned(id: string, token: string): WorkItem | null {
    const item = this.items.get(id);
    if (
      !item ||
      item.status !== "PENDING" ||
      item.leaseToken !== token ||
      !item.leasedUntil ||
      item.leasedUntil.getTime() < this.clock().getTime()
    ) {
      return null;
    }
    return item;
  }

  async insertLeased(shop: string, orderId: string, token: string, ttlMs: number, deadlineMs: number) {
    const key = `${shop} ${orderId}`;
    if (this.byOrder.has(key)) return null;
    const now = this.clock();
    const item: WorkItem = {
      id: `work-${this.seq++}`,
      shop,
      orderId,
      status: "PENDING",
      attempts: 1,
      retryAfter: now,
      leaseToken: token,
      leasedUntil: new Date(now.getTime() + ttlMs),
      outcome: null,
      lastReason: null,
      deadlineAt: new Date(now.getTime() + deadlineMs),
      createdAt: now,
      doneAt: null,
      reviewReason: null,
      operationId: null,
    };
    this.items.set(item.id, item);
    this.byOrder.set(key, item.id);
    return structuredClone(item);
  }

  async claimDue(limit: number, ttlMs: number) {
    const now = this.clock().getTime();
    const due = [...this.items.values()]
      .filter(
        (i) =>
          i.status === "PENDING" &&
          i.retryAfter !== null &&
          i.retryAfter.getTime() <= now &&
          (!i.leasedUntil || i.leasedUntil.getTime() < now),
      )
      .sort((a, b) => a.retryAfter!.getTime() - b.retryAfter!.getTime())
      .slice(0, limit);
    return due.map((item) => {
      item.leaseToken = `lease-${crypto.randomUUID()}`;
      item.leasedUntil = new Date(now + ttlMs);
      item.attempts += 1;
      return structuredClone(item);
    });
  }

  async exhaustDue() {
    const now = this.clock().getTime();
    let exhausted = 0;
    for (const item of this.items.values()) {
      if (
        item.status === "PENDING" &&
        (!item.leasedUntil || item.leasedUntil.getTime() < now) &&
        (item.attempts >= MAX_ATTEMPTS || (item.deadlineAt && item.deadlineAt.getTime() < now))
      ) {
        item.status = "REVIEW";
        item.outcome = "EXHAUSTED";
        item.reviewReason = item.lastReason ?? "retry limit reached";
        item.leaseToken = null;
        item.leasedUntil = null;
        item.retryAfter = null;
        exhausted += 1;
      }
    }
    return exhausted;
  }

  async linkOperation(id: string, token: string, operationId: string) {
    const item = this.owned(id, token);
    if (!item) return false;
    item.status = "DONE";
    item.outcome = "OPERATION_CREATED";
    item.operationId = operationId;
    item.doneAt = this.clock();
    item.retryAfter = null;
    item.leaseToken = null;
    item.leasedUntil = null;
    return true;
  }

  async requeueFromOperation(workItemId: string, operationId: string, reason: string) {
    const item = this.items.get(workItemId);
    if (
      !item ||
      item.status !== "DONE" ||
      item.outcome !== "OPERATION_CREATED" ||
      item.operationId !== operationId
    ) {
      return false;
    }
    item.status = "PENDING";
    item.retryAfter = this.clock();
    item.outcome = null;
    item.lastReason = reason;
    item.leaseToken = null;
    item.leasedUntil = null;
    return true;
  }

  async settleFromOperation(
    workItemId: string,
    operationId: string,
    outcome: "MERGED" | "OPERATION_REVIEW",
  ) {
    const item = this.items.get(workItemId);
    if (
      !item ||
      item.status !== "DONE" ||
      item.outcome !== "OPERATION_CREATED" ||
      item.operationId !== operationId
    ) {
      return false;
    }
    item.status = "DONE";
    item.outcome = outcome;
    item.doneAt = this.clock();
    return true;
  }

  async renew(id: string, token: string, ttlMs: number) {
    const item = this.items.get(id);
    const now = this.clock().getTime();
    if (!item || item.leaseToken !== token || !item.leasedUntil || item.leasedUntil.getTime() < now) {
      throw new OwnershipLostError(`Work item ${id} is owned by another worker.`);
    }
    item.leasedUntil = new Date(now + ttlMs);
  }

  async markDone(id: string, token: string, outcome: WorkOutcome, reason: string, operationId?: string) {
    const item = this.owned(id, token);
    if (!item) return false;
    item.status = "DONE";
    item.outcome = outcome;
    item.lastReason = reason;
    if (operationId !== undefined) item.operationId = operationId;
    item.doneAt = this.clock();
    item.retryAfter = null;
    item.leaseToken = null;
    item.leasedUntil = null;
    return true;
  }

  async scheduleRetry(id: string, token: string, delayMs: number, reason: string) {
    const item = this.owned(id, token);
    if (!item) return false;
    item.retryAfter = new Date(this.clock().getTime() + delayMs);
    item.lastReason = reason;
    item.leaseToken = null;
    item.leasedUntil = null;
    return true;
  }

  async purgeDone(olderThanMs: number) {
    const cutoff = this.clock().getTime() - olderThanMs;
    let purged = 0;
    for (const [id, item] of this.items) {
      // COALESCE(doneAt, createdAt): overlap-era DONE rows never got a doneAt.
      const finishedAt = item.doneAt ?? item.createdAt;
      if (item.status === "DONE" && finishedAt.getTime() < cutoff) {
        this.items.delete(id);
        this.byOrder.delete(`${item.shop} ${item.orderId}`);
        purged += 1;
      }
    }
    return purged;
  }

  async find(shop: string, orderId: string) {
    const id = this.byOrder.get(`${shop} ${orderId}`);
    const item = id ? this.items.get(id) : undefined;
    return item ? structuredClone(item) : null;
  }
}

// ── Memory operation store ────────────────────────────────────────────────────
// Implements OperationStore with the SAME conditional semantics as the SQL
// version: durable lock uniqueness, write-ahead attempt guards, lease/phase
// CAS, and terminal lock deletion + work settlement — all on the fake clock.

export class MemoryOperationStore implements OperationStore {
  ops = new Map<string, OperationRecord>();
  /** key `${shop} ${orderId}` → operationId */
  locks = new Map<string, string>();
  attempts: MutationAttempt[] = [];
  control: ControlRow = {
    id: "control",
    newMergesEnabled: true,
    completionEnabled: true,
    allowShops: [],
    note: null,
  };
  /** Mirrors the MERGESHIP_MUTATIONS env precheck. */
  mutationsEnabled = true;
  /** MergeRecord history written via recordHistoryAndVerifyCancel. */
  records: MergeHistoryEntry[] = [];
  instances = new Map<
    string,
    { instanceId: string; railwayDeploymentId: string | null; version: string | null; heartbeatAt: Date }
  >();
  private seq = 1;
  private attemptSeq = 1;
  clock: () => Date = () => new Date();

  constructor(
    claims?: MemoryClaimStore,
    work?: MemoryWorkStore,
    journal?: MemoryJournal,
  ) {
    this.claims = claims;
    this.work = work;
    this.journal = journal;
  }

  private claims?: MemoryClaimStore;
  private work?: MemoryWorkStore;
  private journal?: MemoryJournal;

  private key(shop: string, orderId: string) {
    return `${shop} ${orderId}`;
  }

  private owned(row: OperationRecord | undefined, op: { id: string; leaseToken: string | null }, marginMs = 0) {
    const now = this.clock().getTime();
    return (
      !!row &&
      row.leaseToken === op.leaseToken &&
      row.leasedUntil != null &&
      row.leasedUntil.getTime() > now + marginMs
    );
  }

  private clone<T>(v: T): T {
    return structuredClone(v);
  }

  async createOperation(input: NewOperationV2): Promise<OperationRecord> {
    const ids = [...new Set(input.involvedOrderIds)].sort();
    const now = this.clock().getTime();
    // 0. Kill switch — the creation gate the SQL enforces inside its tx.
    if (
      !this.control.newMergesEnabled ||
      (this.control.allowShops.length > 0 && !this.control.allowShops.includes(input.shop))
    ) {
      throw new ClaimContentionError("New merges are disabled (AppControl).");
    }
    // 1. Every claim held by this token with ≥30s of margin.
    if (this.claims) {
      for (const id of ids) {
        const c = this.claims.claims.get(this.key(input.shop, id));
        if (!c || c.token !== input.claimToken || c.leasedUntil <= now + 30_000) {
          throw new OwnershipLostError(`Merge claims lost for ${input.shop} before operation create.`);
        }
      }
    }
    // 2. Settle the linked work item (same lease semantics as the SQL).
    if (input.workItemId && this.work) {
      const wi = this.work.items.get(input.workItemId);
      if (
        !wi ||
        wi.status !== "PENDING" ||
        wi.leaseToken !== input.workToken ||
        !wi.leasedUntil ||
        wi.leasedUntil.getTime() <= now
      ) {
        throw new OwnershipLostError(`Work item ${input.workItemId} is owned by another worker.`);
      }
    }
    // 3. No blocking lock / v1 op.
    for (const id of ids) {
      if (this.locks.has(this.key(input.shop, id))) {
        throw new ClaimContentionError(`Order ${id} is locked.`);
      }
    }
    if (this.journal) {
      for (const j of this.journal.ops.values()) {
        if (
          (j as any).protocolVersion !== 2 &&
          j.shop === input.shop &&
          ["PENDING_COMMIT", "COMMITTED", "NEEDS_REVIEW"].includes(j.status) &&
          j.involvedOrderIds.some((x) => ids.includes(x))
        ) {
          throw new ClaimContentionError(`Order involved in blocking op ${j.id}.`);
        }
      }
    }
    // Writes — nothing above may interleave.
    const opId = `op-${this.seq++}`;
    if (input.workItemId && this.work) {
      const wi = this.work.items.get(input.workItemId)!;
      wi.status = "DONE";
      wi.outcome = "OPERATION_CREATED";
      wi.operationId = opId;
      wi.doneAt = this.clock();
      wi.leaseToken = null;
      wi.leasedUntil = null;
      wi.retryAfter = null;
    }
    const record: OperationRecord = {
      id: opId,
      shop: input.shop,
      status: "NEEDS_REVIEW",
      protocolVersion: 2,
      phase: "READY",
      opToken: input.opToken,
      primaryOrderId: input.primaryOrderId,
      primaryOrderName: input.primaryOrderName,
      customerId: input.customerId,
      primaryLineItemCountBefore: input.primaryLineItemCountBefore,
      addedLineItemCount: input.addedLineItemCount,
      secondaries: this.clone(input.secondaries),
      involvedOrderIds: ids,
      attempts: 0,
      lastError: null,
      leaseToken: input.leaseToken,
      leasedUntil: new Date(now + input.ttlMs),
      calculatedOrderId: input.calculatedOrderId,
      expectedTransfer: this.clone(input.expectedTransfer),
      expectedLocationId: input.expectedLocationId,
      primaryLineItemIdsBefore: [...input.primaryLineItemIdsBefore],
      appliedEvidence: null,
      firstDispatchAt: null,
      nextCheckAt: this.clock(),
      reviewReason: null,
      reviewRequiredAt: null,
      workItemId: input.workItemId ?? null,
      sideEffectsDone: false,
      createdAt: this.clock(),
      updatedAt: this.clock(),
    };
    this.ops.set(record.id, record);
    for (const id of ids) this.locks.set(this.key(input.shop, id), record.id);
    return this.clone(record);
  }

  async acquireOperationLease(opId: string | undefined, token: string, ttlMs: number) {
    const now = this.clock().getTime();
    const due = [...this.ops.values()]
      .filter(
        (o) =>
          o.protocolVersion === 2 &&
          (opId === undefined || o.id === opId) &&
          !(o.phase === "ABANDONED" || (o.phase === "COMPLETED" && o.sideEffectsDone)) &&
          o.nextCheckAt != null &&
          o.nextCheckAt.getTime() <= now &&
          (!o.leasedUntil || o.leasedUntil.getTime() < now),
      )
      .sort((a, b) => a.nextCheckAt!.getTime() - b.nextCheckAt!.getTime());
    const row = due[0];
    if (!row) return null;
    row.leaseToken = token;
    row.leasedUntil = new Date(now + ttlMs);
    row.updatedAt = this.clock();
    return this.clone(row);
  }

  async renewOperation(op: Pick<OperationRecord, "id" | "leaseToken">, ttlMs: number) {
    const row = this.ops.get(op.id);
    if (!this.owned(row, op)) {
      throw new OwnershipLostError(`Merge operation ${op.id} is owned by another worker.`);
    }
    row!.leasedUntil = new Date(this.clock().getTime() + ttlMs);
    row!.updatedAt = this.clock();
  }

  async transition(
    op: Pick<OperationRecord, "id" | "leaseToken" | "workItemId">,
    patch: OperationPatch,
  ): Promise<void> {
    const row = this.ops.get(op.id);
    if (!this.owned(row, op)) {
      throw new OwnershipLostError(`Merge operation ${op.id} is owned by another worker.`);
    }
    if (patch.expectedPhase !== undefined && row!.phase !== patch.expectedPhase) {
      throw new OwnershipLostError(`Merge operation ${op.id} is now ${row!.phase}; expected ${patch.expectedPhase}.`);
    }
    // READY→ABANDONED is only legal before the first EDIT_COMMIT attempt —
    // the SQL encodes it as NOT EXISTS in the guarded UPDATE, so a violation
    // surfaces as OwnershipLostError here too.
    if (
      patch.phase === "ABANDONED" &&
      patch.expectedPhase === "READY" &&
      this.attempts.some((a) => a.operationId === op.id && a.kind === "EDIT_COMMIT")
    ) {
      throw new OwnershipLostError(
        `Merge operation ${op.id} cannot be abandoned: an EDIT_COMMIT was already attempted.`,
      );
    }
    if (patch.phase !== undefined) {
      row!.phase = patch.phase;
      row!.status =
        patch.phase === "COMPLETED" || patch.phase === "ABANDONED" ? patch.phase : "NEEDS_REVIEW";
      if (patch.phase === "REVIEW_REQUIRED") row!.reviewRequiredAt = this.clock();
    }
    if (patch.nextCheckAt !== undefined) {
      row!.nextCheckAt =
        patch.nextCheckAt === null
          ? null
          : patch.nextCheckAt === "now"
            ? this.clock()
            : patch.nextCheckAt instanceof Date
              ? patch.nextCheckAt
              : new Date(this.clock().getTime() + patch.nextCheckAt);
    }
    if (patch.appliedEvidence !== undefined) row!.appliedEvidence = this.clone(patch.appliedEvidence);
    if (patch.reviewReason !== undefined) row!.reviewReason = patch.reviewReason;
    if (patch.secondaries !== undefined) row!.secondaries = this.clone(patch.secondaries);
    if (patch.lastError !== undefined) row!.lastError = patch.lastError;
    if (patch.firstDispatchAt === "now") row!.firstDispatchAt = this.clock();
    if (patch.attempts !== undefined) row!.attempts = patch.attempts;
    row!.updatedAt = this.clock();

    if (row!.phase === "COMPLETED" || row!.phase === "ABANDONED") {
      for (const id of row!.involvedOrderIds) this.locks.delete(this.key(row!.shop, id));
      const wi = row!.workItemId ? this.work?.items.get(row!.workItemId) : undefined;
      if (wi && wi.status === "DONE" && wi.outcome === "OPERATION_CREATED" && wi.operationId === row!.id) {
        if (row!.phase === "COMPLETED") {
          wi.outcome = "MERGED";
          wi.doneAt = this.clock();
        } else {
          wi.status = "PENDING";
          wi.retryAfter = this.clock();
          wi.outcome = null;
          wi.lastReason = row!.lastError ?? "operation abandoned";
        }
      }
    } else if (row!.phase === "REVIEW_REQUIRED") {
      const wi = row!.workItemId ? this.work?.items.get(row!.workItemId) : undefined;
      if (wi && wi.status === "DONE" && wi.outcome === "OPERATION_CREATED" && wi.operationId === row!.id) {
        wi.outcome = "OPERATION_REVIEW";
        wi.doneAt = this.clock();
      }
    }
  }

  async openDispatchGate({
    op,
    kind,
    targetOrderId,
    dispatchToken,
    requiredPhase,
  }: {
    op: Pick<OperationRecord, "id" | "shop" | "leaseToken">;
    kind: AttemptKind;
    targetOrderId: string;
    dispatchToken: string;
    requiredPhase: OperationRecord["phase"];
  }): Promise<MutationAttempt | null> {
    if (!this.mutationsEnabled) return null;
    const row = this.ops.get(op.id);
    if (!this.owned(row, op, 30_000) || row!.phase !== requiredPhase) return null;
    const sw = kind === "EDIT_COMMIT" ? "newMergesEnabled" : "completionEnabled";
    if (
      !this.control[sw] ||
      (this.control.allowShops.length > 0 && !this.control.allowShops.includes(row!.shop))
    ) {
      return null;
    }
    if (kind === "EDIT_COMMIT") {
      if (this.attempts.some((a) => a.operationId === op.id && a.kind === "EDIT_COMMIT")) return null;
    } else if (kind === "ORDER_CANCEL") {
      const inDoubt = this.attempts.some(
        (a) =>
          a.operationId === op.id &&
          a.kind === "ORDER_CANCEL" &&
          a.targetOrderId === targetOrderId &&
          ["DISPATCHING", "UNKNOWN", "SUCCEEDED"].includes(a.state),
      );
      const rejects = this.attempts.filter(
        (a) =>
          a.operationId === op.id &&
          a.kind === "ORDER_CANCEL" &&
          a.targetOrderId === targetOrderId &&
          a.state === "REJECTED",
      ).length;
      if (inDoubt || rejects >= 3) return null;
    } else {
      const count = this.attempts.filter(
        (a) => a.operationId === op.id && a.kind === kind && a.targetOrderId === targetOrderId,
      ).length;
      if (count >= 3) return null;
    }
    // Phase flip + 30s first-check throttle, mirroring the SQL gate.
    const now = this.clock();
    if (kind === "EDIT_COMMIT") {
      row!.phase = "COMMIT_IN_DOUBT";
      row!.firstDispatchAt ??= now;
    }
    row!.nextCheckAt = new Date(now.getTime() + 30_000);
    row!.updatedAt = now;
    const attempt: MutationAttempt = {
      id: `att-${this.attemptSeq++}`,
      operationId: op.id,
      kind,
      targetOrderId,
      attemptNo:
        this.attempts.filter((a) => a.operationId === op.id && a.kind === kind && a.targetOrderId === targetOrderId)
          .length + 1,
      state: "DISPATCHING",
      dispatchToken,
      dispatchedAt: this.clock(),
      respondedAt: null,
      responseSummary: null,
      jobId: null,
    };
    this.attempts.push(attempt);
    return this.clone(attempt);
  }

  async recordAttempt(
    attemptId: string,
    dispatchToken: string,
    state: Exclude<MutationAttempt["state"], "DISPATCHING">,
    summary: string | null,
    jobId?: string | null,
  ): Promise<boolean> {
    const row = this.attempts.find((a) => a.id === attemptId);
    if (!row || row.state !== "DISPATCHING" || row.dispatchToken !== dispatchToken) return false;
    row.state = state;
    row.respondedAt = this.clock();
    row.responseSummary = summary;
    row.jobId = jobId ?? row.jobId;
    return true;
  }

  async listAttempts(opId: string, kind?: AttemptKind, targetOrderId?: string) {
    return this.clone(
      this.attempts.filter(
        (a) =>
          a.operationId === opId &&
          (kind === undefined || a.kind === kind) &&
          (targetOrderId === undefined || a.targetOrderId === targetOrderId),
      ),
    );
  }

  async recordHistoryAndVerifyCancel(
    op: OperationRecord,
    secondaryId: string,
    evidence: { cancelledAt: string },
  ): Promise<void> {
    const row = this.ops.get(op.id);
    if (!this.owned(row, op) || row!.phase !== "APPLIED") {
      throw new OwnershipLostError(`Merge operation ${op.id} is owned by another worker.`);
    }
    row!.secondaries = row!.secondaries.map((s) =>
      s.id === secondaryId
        ? { ...s, cancelPhase: "CANCEL_VERIFIED" as const, cancelledAt: evidence.cancelledAt, staffNoteMatched: true, done: true }
        : s,
    );
    row!.updatedAt = this.clock();
    const secondary = row!.secondaries.find((s) => s.id === secondaryId);
    const entry: MergeHistoryEntry = {
      shop: row!.shop,
      primaryOrderId: row!.primaryOrderId,
      primaryOrderName: row!.primaryOrderName,
      mergedOrderId: secondaryId,
      mergedOrderName: secondary?.name ?? secondaryId,
      customerId: row!.customerId,
      itemsCombined: secondary?.items ?? 0,
    };
    if (!this.records.some((r) => r.shop === entry.shop && r.mergedOrderId === entry.mergedOrderId)) {
      this.records.push(entry);
    }
    await this.journal?.recordHistory(entry);
  }

  async findLockedOrderIds(shop: string, ids: string[]) {
    const found = new Set<string>();
    for (const id of ids) if (this.locks.has(this.key(shop, id))) found.add(id);
    return found;
  }

  async findLocks(shop: string, ids: string[]) {
    const found = new Map<string, { operationId: string; phase: OperationPhase | null }>();
    for (const oid of ids) {
      const operationId = this.locks.get(this.key(shop, oid));
      if (operationId) {
        found.set(oid, { operationId, phase: this.ops.get(operationId)?.phase ?? null });
      }
    }
    return found;
  }

  async findBlockingV1(shop: string, ids: string[]) {
    const found = new Set<string>();
    for (const j of this.journal?.ops.values() ?? []) {
      if (
        (j as any).protocolVersion !== 2 &&
        j.shop === shop &&
        ["PENDING_COMMIT", "COMMITTED", "NEEDS_REVIEW"].includes(j.status)
      ) {
        for (const id of j.involvedOrderIds) if (ids.includes(id)) found.add(id);
      }
    }
    return found;
  }

  async getOperation(id: string) {
    const row = this.ops.get(id);
    return row ? this.clone(row) : null;
  }

  async lockOwner(shop: string, orderId: string) {
    const operationId = this.locks.get(this.key(shop, orderId));
    if (!operationId) return null;
    const row = this.ops.get(operationId);
    return { operationId, phase: row?.phase ?? null };
  }

  async markSideEffectsDone(op: Pick<OperationRecord, "id" | "leaseToken">) {
    const row = this.ops.get(op.id);
    if (!this.owned(row, op)) return false;
    row!.sideEffectsDone = true;
    row!.nextCheckAt = null;
    row!.updatedAt = this.clock();
    return true;
  }

  async getControl() {
    return this.clone(this.control);
  }

  async setControl(patch: Partial<Omit<ControlRow, "id">>) {
    Object.assign(this.control, this.clone(patch));
  }

  async isEnabled(shop: string, sw: "newMergesEnabled" | "completionEnabled") {
    if (!this.control[sw]) return false;
    return this.control.allowShops.length === 0 || this.control.allowShops.includes(shop);
  }

  async heartbeat(instanceId: string, railwayDeploymentId: string | null, version: string | null) {
    this.instances.set(instanceId, {
      instanceId,
      railwayDeploymentId,
      version,
      heartbeatAt: this.clock(),
    });
  }

  async listRecentInstances() {
    return [...this.instances.values()].sort((a, b) => b.heartbeatAt.getTime() - a.heartbeatAt.getTime());
  }

  async purgeOldInstances(olderThanMs: number) {
    const cutoff = this.clock().getTime() - olderThanMs;
    let removed = 0;
    for (const [id, inst] of this.instances) {
      if (inst.heartbeatAt.getTime() < cutoff) {
        this.instances.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

/** One shop, one fake clock shared by the journal/claims/work stores, the
 *  merge deps and the sweeper. `webhook` mirrors the orders/create route
 *  (settings gate, durable insert, background processing) and `sweep` runs
 *  one sweeper pass with the same stores. */
export function makeHarness(orders: FakeOrder[], opts: { settings?: Partial<MergeSettings> } = {}) {
  const SHOP = "test.myshopify.com";
  let now = new Date("2026-10-01T12:00:00Z").getTime();
  const clock = () => new Date(now);
  const shopify = new FakeShopify(orders);
  shopify.clock = clock;
  const journal = new MemoryJournal();
  journal.clock = clock;
  const claims = new MemoryClaimStore();
  claims.clock = clock;
  const work = new MemoryWorkStore();
  work.clock = clock;
  const ops = new MemoryOperationStore(claims, work, journal);
  ops.clock = clock;
  journal.linkedOps = ops;
  const deps: MergeDeps = {
    journal,
    claims,
    ops,
    leaseTtlMs: 120_000,
    sleep: async (ms) => {
      now += ms;
    },
    now: clock,
    cancelPollAttempts: 3,
    cancelPollIntervalMs: 1000,
  };
  const settings: MergeSettings = {
    autoMergeEnabled: true,
    mergeWindowHours: 24,
    shippingCostSavings: 8.5,
    shopifyShopGid: "gid://shopify/Shop/1",
    autoMergeAcknowledgedAt: new Date(now),
    onboardingStartedAt: new Date(now),
    onboardingCompletedAt: new Date(now),
    ...opts.settings,
  };
  const getSettings = async () => settings;
  const adminFactory = async () => shopify.admin;
  const stats = { processCalls: 0 };
  const webhook = async (orderId: string, process = true) => {
    if (!settings.autoMergeEnabled || !isOnboardingComplete(settings)) return null;
    const token = `wh-${crypto.randomUUID()}`;
    const item = await work.insertLeased(SHOP, orderId, token, deps.leaseTtlMs, WORK_DEADLINE_MS);
    if (!item) return null;
    if (process) {
      stats.processCalls += 1;
      await processOrderWork({
        item,
        token,
        shop: SHOP,
        admin: shopify.admin,
        deps,
        work,
        settings: getSettings,
        now: clock,
        random: () => 0.5,
      });
    }
    return item;
  };
  const sweep = (overrides: Partial<SweepContext> = {}) =>
    runSweepOnce({
      claims,
      journal,
      ops,
      work,
      deps,
      adminFactory,
      settings: getSettings,
      now: clock,
      random: () => 0.5,
      ...overrides,
    });
  /** Drive `driveOperation` until the op reaches a waiting point that time
   *  alone cannot pass within `maxMs` of advancement, or is terminal. */
  const driveUntilIdle = async (opId: string, maxMs = 90 * 60 * 1000) => {
    let advanced = 0;
    for (let i = 0; i < 200; i++) {
      const op = await ops.getOperation(opId);
      if (!op) return null;
      const terminal =
        op.phase === "ABANDONED" ||
        (op.phase === "COMPLETED" && op.sideEffectsDone) ||
        op.phase === "REVIEW_REQUIRED";
      if (terminal) return op;
      if (op.nextCheckAt && op.nextCheckAt.getTime() > now) {
        const jump = op.nextCheckAt.getTime() - now;
        if (advanced + jump > maxMs) return op;
        now += jump;
        advanced += jump;
        continue;
      }
      if (op.leasedUntil && op.leasedUntil.getTime() >= now) {
        // Still leased — clear it on the store row so the sweep can pick the
        // op up (the previous drive call counts as its owner's last act).
        const row = ops.ops.get(op.id);
        if (row) {
          row.leasedUntil = null;
          row.leaseToken = null;
        }
      }
      await sweep();
    }
    return ops.getOperation(opId);
  };
  return {
    shopify,
    journal,
    claims,
    work,
    ops,
    deps,
    clock,
    settings,
    getSettings,
    adminFactory,
    webhook,
    sweep,
    driveUntilIdle,
    stats,
    advance: (ms: number) => (now += ms),
    SHOP,
  };
}
