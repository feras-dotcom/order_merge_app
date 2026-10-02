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
import { OwnershipLostError } from "../app/lib/ownership.server";
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
}

export class MemoryJournal implements MergeJournal {
  ops = new Map<string, MergeOperationRecord>();
  history: MergeHistoryEntry[] = [];
  failCreate = false;
  private seq = 1;
  clock: () => Date = () => new Date();

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
  async findBlockingOrderStatuses(shop: string) {
    const map = new Map<string, MergeOperationRecord["status"]>();
    for (const o of this.ops.values()) {
      if (o.shop !== shop || !["PENDING_COMMIT", "COMMITTED", "NEEDS_REVIEW"].includes(o.status)) continue;
      for (const orderId of o.involvedOrderIds) map.set(orderId, o.status);
    }
    return map;
  }
  async findShopsWithUnfinished() {
    return [
      ...new Set(
        [...this.ops.values()]
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

export function testDeps(journal: MemoryJournal, overrides: Partial<MergeDeps> = {}): MergeDeps {
  let now = new Date("2026-10-01T12:00:00Z").getTime();
  journal.clock = () => new Date(now);
  const claims = new MemoryClaimStore();
  claims.clock = () => new Date(now);
  return {
    journal,
    claims,
    leaseTtlMs: 90_000,
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

  async markDone(id: string, token: string, outcome: WorkOutcome, reason: string) {
    const item = this.owned(id, token);
    if (!item) return false;
    item.status = "DONE";
    item.outcome = outcome;
    item.lastReason = reason;
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

/** One shop, one fake clock shared by the journal/claims/work stores, the
 *  merge deps and the sweeper. `webhook` mirrors the orders/create route
 *  (settings gate, durable insert, background processing) and `sweep` runs
 *  one sweeper pass with the same stores. */
export function makeHarness(orders: FakeOrder[], opts: { settings?: Partial<MergeSettings> } = {}) {
  const SHOP = "test.myshopify.com";
  let now = new Date("2026-10-01T12:00:00Z").getTime();
  const clock = () => new Date(now);
  const shopify = new FakeShopify(orders);
  const journal = new MemoryJournal();
  journal.clock = clock;
  const claims = new MemoryClaimStore();
  claims.clock = clock;
  const work = new MemoryWorkStore();
  work.clock = clock;
  const deps: MergeDeps = {
    journal,
    claims,
    leaseTtlMs: 90_000,
    sleep: async (ms) => {
      now += ms;
    },
    now: clock,
    cancelPollAttempts: 3,
    cancelPollIntervalMs: 1000,
    maxCancelAttempts: 2,
    pendingCommitGraceMs: 5 * 60 * 1000,
    cancelRequestGraceMs: 10 * 60 * 1000,
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
      work,
      deps,
      adminFactory,
      settings: getSettings,
      now: clock,
      random: () => 0.5,
      ...overrides,
    });
  return {
    shopify,
    journal,
    claims,
    work,
    deps,
    clock,
    settings,
    getSettings,
    adminFactory,
    webhook,
    sweep,
    stats,
    advance: (ms: number) => (now += ms),
    SHOP,
  };
}
