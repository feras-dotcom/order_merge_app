// In-memory stand-in for the Shopify Admin GraphQL API and the merge journal,
// covering exactly the operations merge.server.ts performs. Each operation is
// dispatched by its GraphQL operation name; tests inject failures per name.

import type { FulfillmentOrderInfo, MergeLineItem, OrderState } from "../app/lib/eligibility";
import type {
  MergeHistoryEntry,
  MergeJournal,
  MergeOperationRecord,
} from "../app/lib/merge-journal.server";
import type { MergeDeps } from "../app/lib/merge.server";

export interface FakeOrder extends OrderState {
  lineItems: MergeLineItem[];
  /** Reads of the order before a requested cancellation becomes visible. */
  cancelDelayReads?: number;
  pendingCancelReads?: number | null;
  cancelCount: number;
  /** Explicit fulfillment orders; by default one OPEN fulfillment order at
   *  `location` covering every line item. */
  fulfillmentOrders?: FulfillmentOrderInfo[];
  location?: string;
}

export const LOC_A = "gid://shopify/Location/1";
export const LOC_B = "gid://shopify/Location/2";

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
/** Returning undefined falls through to the default behaviour. */
export type Interceptor = (vars: any, call: number) => any | undefined;

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
    shippingLines: { nodes: [{ title: "Standard" }] },
    fulfillments: [],
    note: null,
    tags: [],
    lineItems: [makeLineItem()],
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
  calls: string[] = [];
  interceptors = new Map<string, Interceptor>();
  private callCounts = new Map<string, number>();
  private edits = new Map<string, { orderId: string; added: MergeLineItem[] }>();
  private editSeq = 1;

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
        o.cancelledAt = new Date().toISOString();
        o.pendingCancelReads = null;
      } else {
        o.pendingCancelReads -= 1;
      }
    }
    const { lineItems, cancelDelayReads, pendingCancelReads, cancelCount, fulfillmentOrders, location, ...state } = o;
    return structuredClone(state);
  }

  fulfillmentOrdersOf(o: FakeOrder): FulfillmentOrderInfo[] {
    return o.fulfillmentOrders ?? [makeFulfillmentOrder(o.location ?? LOC_A, o.lineItems)];
  }

  private handlers: Record<string, Handler> = {
    MergeLocationCount: () => ({ data: { locationsCount: { count: this.activeLocations } } }),
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
      this.edits.set(calcId, { orderId: id, added: [] });
      return { data: { orderEditBegin: { calculatedOrder: { id: calcId }, userErrors: [] } } };
    },
    MergeEditAddVariant: ({ id, variantId, quantity, locationId }) => {
      this.addVariantLocations.push(locationId);
      const edit = this.edits.get(id)!;
      const item = makeLineItem({ variant: { id: variantId }, quantity, currentQuantity: quantity, unfulfilledQuantity: quantity });
      edit.added.push(item);
      return { data: { orderEditAddVariant: { calculatedLineItem: { id: `calc-${item.id}` }, userErrors: [] } } };
    },
    MergeEditDiscount: () => ({
      data: { orderEditAddLineItemDiscount: { calculatedLineItem: { id: "x" }, userErrors: [] } },
    }),
    MergeEditCommit: ({ id }) => {
      this.applyCommit(id);
      return { data: { orderEditCommit: { order: { id: "x" }, userErrors: [] } } };
    },
    MergeCancelSecondary: ({ orderId }) => {
      const o = this.orders.get(orderId)!;
      o.cancelCount += 1;
      if (o.cancelDelayReads) o.pendingCancelReads = o.cancelDelayReads;
      else o.cancelledAt = new Date().toISOString();
      return { data: { orderCancel: { job: { id: "job" }, orderCancelUserErrors: [] } } };
    },
    MergeAnnotateOrder: ({ input }) => {
      const o = this.orders.get(input.id)!;
      if (input.tags) o.tags = input.tags;
      if (input.note !== undefined) o.note = input.note;
      return { data: { orderUpdate: { order: { id: o.id }, userErrors: [] } } };
    },
    MergeCloseSecondary: ({ input }) => {
      this.orders.get(input.id)!.closed = true;
      return { data: { orderClose: { order: { id: input.id }, userErrors: [] } } };
    },
  };

  /** Applies a calculated order to the real order (what a commit does). */
  applyCommit(calcId: string) {
    const edit = this.edits.get(calcId)!;
    this.orders.get(edit.orderId)!.lineItems.push(...edit.added);
    this.edits.delete(calcId);
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
      const intercepted = this.interceptors.get(name)?.(vars, count);
      if (intercepted !== undefined) return new Response(JSON.stringify(intercepted));
      const handler = this.handlers[name];
      if (!handler) throw new Error(`FakeShopify: unhandled operation ${name}`);
      return new Response(JSON.stringify(handler(vars)));
    },
  };
}

export class MemoryJournal implements MergeJournal {
  ops = new Map<string, MergeOperationRecord>();
  history: MergeHistoryEntry[] = [];
  failCreate = false;
  private seq = 1;
  clock: () => Date = () => new Date();

  async create(op: Omit<MergeOperationRecord, "id" | "attempts" | "lastError" | "updatedAt">) {
    if (this.failCreate) throw new Error("database unavailable");
    const record: MergeOperationRecord = {
      ...structuredClone(op),
      id: `op-${this.seq++}`,
      attempts: 0,
      lastError: null,
      updatedAt: this.clock(),
    };
    this.ops.set(record.id, record);
    return structuredClone(record);
  }
  async update(id: string, patch: Partial<MergeOperationRecord>) {
    const op = this.ops.get(id)!;
    Object.assign(op, structuredClone(patch), { updatedAt: this.clock() });
  }
  async findUnfinished(shop: string) {
    return [...this.ops.values()]
      .filter((o) => o.shop === shop && ["PENDING_COMMIT", "COMMITTED"].includes(o.status))
      .map((o) => structuredClone(o));
  }
  async findBlockingOrderIds(shop: string) {
    return new Set(
      [...this.ops.values()]
        .filter((o) => o.shop === shop && ["PENDING_COMMIT", "COMMITTED", "NEEDS_REVIEW"].includes(o.status))
        .flatMap((o) => o.involvedOrderIds),
    );
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

export function testDeps(journal: MemoryJournal, overrides: Partial<MergeDeps> = {}): MergeDeps {
  let now = new Date("2026-10-01T12:00:00Z").getTime();
  journal.clock = () => new Date(now);
  return {
    journal,
    sleep: async (ms) => {
      now += ms;
    },
    now: () => new Date(now),
    cancelPollAttempts: 3,
    cancelPollIntervalMs: 1000,
    maxCancelAttempts: 2,
    pendingCommitGraceMs: 5 * 60 * 1000,
    cancelRequestGraceMs: 10 * 60 * 1000,
    ...overrides,
    // allow tests to move time forward
    ...({ advance: (ms: number) => (now += ms) } as any),
  };
}

export const advance = (deps: MergeDeps, ms: number) => (deps as any).advance(ms);

export const topLevelError = (message = "Throttled") => ({ errors: [{ message }] });
export const userError = (root: string, key = "userErrors", message = "Rejected") => ({
  data: { [root]: { [key]: [{ field: null, message }] } },
});
