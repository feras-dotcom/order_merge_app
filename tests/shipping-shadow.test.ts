// Shipping v0 Phase 1 — shadow evaluator unit tests.
// A memory ShippingShadowStore mirrors the Postgres semantics (unique
// (shop, sourceOrderId), lease fencing on a fake clock) so the driver logic
// is exercised without a database; the real-SQL store is covered separately
// in tests/shipping-shadow-pg.test.ts.

import { describe, expect, it } from "vitest";
import type { AdminClient } from "../app/lib/graphql.server";
import { OwnershipLostError } from "../app/lib/ownership.server";
import type { MutationAttempt, OperationRecord } from "../app/lib/operation-store.server";
import { MemoryOperationStore } from "./fake-shopify";
import {
  minorToDecimal,
  readOnlyAdmin,
  runShadowScan,
  type ShippingShadowRow,
  type ShippingShadowStore,
  type ShadowDeps,
  type ShadowIntentIdentity,
  type ShadowSettlePatch,
} from "../app/lib/shipping-shadow.server";
import { DEFAULT_SETTINGS, type MergeSettings } from "../app/lib/settings.server";

const SHOP = "shadow-test.myshopify.com";
const oid = (n: number) => `gid://shopify/Order/${n}`;

// ── Memory store mirroring the Postgres lease/dedupe semantics ────────────────

class MemoryShadowStore implements ShippingShadowStore {
  rows = new Map<string, ShippingShadowRow>();
  private seq = 0;
  clock: () => Date = () => new Date();
  private opsList: OperationRecord[];
  private records: { shop: string; mergedOrderId: string; primaryOrderId: string; operationId: string | null }[];

  constructor(
    opsList: OperationRecord[],
    records: { shop: string; mergedOrderId: string; primaryOrderId: string; operationId: string | null }[],
  ) {
    this.opsList = opsList;
    this.records = records;
  }

  private key(shop: string, sourceOrderId: string) {
    return `${shop} ${sourceOrderId}`;
  }
  private clone<T>(v: T): T {
    return structuredClone(v);
  }

  async findCompletedOps(shop: string, limit: number) {
    return this.clone(
      this.opsList
        .filter((o) => o.shop === shop && o.protocolVersion === 2 && o.phase === "COMPLETED")
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, limit),
    );
  }
  async listMergeRecords(shop: string, operationId: string) {
    return this.clone(
      this.records.filter((r) => r.shop === shop && r.operationId === operationId),
    );
  }
  async findAdjustments(shop: string, sourceOrderIds: string[]) {
    return this.clone(
      [...this.rows.values()].filter((r) => r.shop === shop && sourceOrderIds.includes(r.sourceOrderId)),
    );
  }
  private insert(status: string, identity: ShadowIntentIdentity): ShippingShadowRow | null {
    const k = this.key(identity.shop, identity.sourceOrderId);
    if ([...this.rows.values()].some((r) => this.key(r.shop, r.sourceOrderId) === k)) return null;
    const now = this.clock();
    const id = `adj-${++this.seq}`;
    const row: ShippingShadowRow = {
      id,
      shop: identity.shop,
      mergeOperationId: identity.mergeOperationId,
      sourceOrderId: identity.sourceOrderId,
      operationCreatedAt: identity.operationCreatedAt,
      policyKind: identity.policyKind,
      policyRetainedMinor: identity.policyRetainedMinor,
      policyCurrencyCode: identity.policyCurrencyCode,
      sourceShippingMinor: null,
      plannedRefundMinor: null,
      currencyCode: null,
      status,
      idempotencyKey: `key-${id}`,
      marker: `MS-SHIP-${id}`,
      requestPayload: null,
      requestHash: null,
      previewEvidence: null,
      leaseToken: null,
      leasedUntil: null,
      nextCheckAt: null,
      attempts: 1,
      reasonCode: null,
      reviewReason: null,
      preparedAt: null,
      dispatchedAt: null,
      refundId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(id, row);
    return this.clone(row);
  }
  async recordTerminal(identity: ShadowIntentIdentity, status: "SKIPPED" | "REVIEW_REQUIRED", reason: { reasonCode?: string; reviewReason?: string }) {
    const row = this.insert(status, identity);
    if (!row) return false;
    const stored = this.rows.get(row.id)!;
    stored.reasonCode = reason.reasonCode ?? null;
    stored.reviewReason = reason.reviewReason ?? null;
    return true;
  }
  async claimIntent(identity: ShadowIntentIdentity, ttlMs: number) {
    const row = this.insert("PENDING", identity);
    if (!row) return null;
    const stored = this.rows.get(row.id)!;
    stored.leaseToken = `tok-${row.id}`;
    stored.leasedUntil = new Date(this.clock().getTime() + ttlMs);
    stored.nextCheckAt = this.clock();
    return this.clone(stored);
  }
  async reclaimIntent(id: string, token: string, ttlMs: number) {
    const stored = this.rows.get(id);
    if (!stored || stored.status !== "PENDING") return null;
    if (stored.leasedUntil && stored.leasedUntil.getTime() >= this.clock().getTime()) return null;
    if (stored.nextCheckAt && stored.nextCheckAt.getTime() > this.clock().getTime()) return null;
    stored.leaseToken = token;
    stored.leasedUntil = new Date(this.clock().getTime() + ttlMs);
    stored.attempts += 1;
    stored.nextCheckAt = this.clock();
    return this.clone(stored);
  }
  private assertOwned(id: string, token: string): ShippingShadowRow {
    const stored = this.rows.get(id);
    if (
      !stored ||
      stored.status !== "PENDING" ||
      stored.leaseToken !== token ||
      !stored.leasedUntil ||
      stored.leasedUntil.getTime() <= this.clock().getTime()
    ) {
      throw new OwnershipLostError(`Shipping intent ${id} is owned by another worker.`);
    }
    return stored;
  }
  async settleIntent(id: string, token: string, patch: ShadowSettlePatch) {
    const stored = this.assertOwned(id, token);
    stored.status = patch.status;
    stored.reasonCode = patch.reasonCode ?? null;
    stored.reviewReason = patch.reviewReason ?? null;
    stored.leaseToken = null;
    stored.leasedUntil = null;
    stored.nextCheckAt = null;
    if (patch.status === "READY") {
      stored.sourceShippingMinor = patch.sourceShippingMinor ?? null;
      stored.plannedRefundMinor = patch.plannedRefundMinor ?? null;
      stored.currencyCode = patch.currencyCode ?? null;
      stored.previewEvidence = patch.previewEvidence ?? null;
      stored.requestPayload = patch.requestPayload ?? null;
      stored.requestHash = patch.requestHash ?? null;
      stored.preparedAt = this.clock();
    }
    stored.updatedAt = this.clock();
  }
  async rescheduleIntent(id: string, token: string, delayMs: number, reason: string) {
    const stored = this.assertOwned(id, token);
    stored.nextCheckAt = new Date(this.clock().getTime() + delayMs);
    stored.reasonCode = reason;
    stored.leaseToken = null;
    stored.leasedUntil = null;
    stored.updatedAt = this.clock();
  }
  rowFor(sourceOrderId: string) {
    return [...this.rows.values()].find((r) => r.sourceOrderId === sourceOrderId);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OP_CREATED = new Date("2026-10-20T12:00:00Z");
const EPOCH = new Date("2026-10-20T00:00:00Z");

function completedOp(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: "op-1",
    shop: SHOP,
    status: "COMPLETED",
    protocolVersion: 2,
    phase: "COMPLETED",
    opToken: "7K2Q9XHD",
    primaryOrderId: oid(100),
    primaryOrderName: "#1000",
    customerId: "gid://shopify/Customer/1",
    primaryLineItemCountBefore: 1,
    addedLineItemCount: 1,
    secondaries: [
      {
        id: oid(200),
        name: "#2000",
        items: 1,
        done: true,
        cancelPhase: "CANCEL_VERIFIED",
        cancelledAt: "2026-10-20T12:05:00Z",
        staffNoteMatched: true,
      },
    ],
    involvedOrderIds: [oid(100), oid(200)],
    attempts: 0,
    lastError: null,
    leaseToken: null,
    leasedUntil: null,
    calculatedOrderId: "gid://shopify/CalculatedOrder/1",
    expectedTransfer: [
      {
        secondaryId: oid(200),
        secondaryIndex: 1,
        lines: [
          {
            sourceLineItemId: "gid://shopify/LineItem/9",
            variantId: "gid://shopify/ProductVariant/9",
            quantity: 1,
            sourceQuantity: 1,
            description: "Merged from #2000, already paid · MS-7K2Q9XHD-1",
          },
        ],
      },
    ],
    expectedLocationId: "gid://shopify/Location/1",
    primaryLineItemIdsBefore: ["gid://shopify/LineItem/1"],
    appliedEvidence: {
      agreementId: "gid://shopify/OrderEditAgreement/1",
      happenedAt: "2026-10-20T12:01:00Z",
      lines: [
        { secondaryId: oid(200), lineItemId: "gid://shopify/LineItem/10", variantId: "gid://shopify/ProductVariant/9", quantity: 1 },
      ],
    },
    firstDispatchAt: OP_CREATED,
    nextCheckAt: null,
    reviewReason: null,
    reviewRequiredAt: null,
    workItemId: null,
    sideEffectsDone: true,
    createdAt: OP_CREATED,
    updatedAt: OP_CREATED,
    ...overrides,
  };
}

const mergeAttempts: MutationAttempt[] = [
  {
    id: "a1", operationId: "op-1", kind: "EDIT_COMMIT", targetOrderId: oid(100),
    attemptNo: 1, state: "SUCCEEDED", dispatchToken: "t", dispatchedAt: OP_CREATED,
    respondedAt: OP_CREATED, responseSummary: null, jobId: null,
  },
  {
    id: "a2", operationId: "op-1", kind: "ORDER_CANCEL", targetOrderId: oid(200),
    attemptNo: 1, state: "SUCCEEDED", dispatchToken: "t", dispatchedAt: OP_CREATED,
    respondedAt: OP_CREATED, responseSummary: null, jobId: "job-1",
  },
];

const mergeRecords = [
  {
    shop: SHOP,
    mergedOrderId: oid(200),
    primaryOrderId: oid(100),
    operationId: "op-1",
  },
];

const settingsOn = (overrides: Partial<MergeSettings> = {}): MergeSettings => ({
  ...DEFAULT_SETTINGS,
  shippingAdjustmentEnabled: true,
  shippingAdjustmentEnabledAt: EPOCH,
  ...overrides,
});

const MONEY = (amount: string, currencyCode = "USD") => ({ amount, currencyCode });

function shopifyOrder(overrides: any = {}): any {
  return {
    id: oid(200),
    name: "#2000",
    test: true,
    cancelledAt: "2026-10-20T12:05:00Z",
    closedAt: "2026-10-20T12:06:00Z",
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
          taxLines: [],
        },
      ],
      pageInfo: { hasNextPage: false },
    },
    refunds: [],
    transactions: [
      { id: "txn-auth", kind: "AUTHORIZATION", status: "SUCCESS", gateway: "bogus", test: true, amountSet: { presentmentMoney: MONEY("18.00") }, parentTransaction: null },
      { id: "txn-cap", kind: "CAPTURE", status: "SUCCESS", gateway: "bogus", test: true, amountSet: { presentmentMoney: MONEY("18.00") }, parentTransaction: { id: "txn-auth" } },
    ],
    ...overrides,
  };
}

function shopifyPreview(overrides: any = {}): any {
  return {
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
          parentTransaction: { id: "txn-cap", kind: "CAPTURE", status: "SUCCESS", gateway: "bogus" },
        },
      ],
      ...overrides,
    },
  };
}

/** AdminClient stub: routes by document content; never sends anything. */
function fakeAdmin(handlers: {
  order?: () => any;
  preview?: () => any;
}): AdminClient {
  return {
    graphql: async (query: string) =>
      ({
        json: async () => ({
          data: {
            order: query.includes("suggestedRefund")
              ? handlers.preview?.() ?? shopifyPreview()
              : handlers.order?.() ?? shopifyOrder(),
          },
        }),
      }) as any,
  };
}

function makeDeps(overrides: {
  store?: MemoryShadowStore;
  ops?: MemoryOperationStore;
  settings?: MergeSettings;
  admin?: AdminClient | null;
}): { deps: ShadowDeps; store: MemoryShadowStore; ops: MemoryOperationStore } {
  const op = completedOp();
  const ops = overrides.ops ?? new MemoryOperationStore();
  ops.control.shippingAdjustmentsEnabled = true;
  ops.control.shippingAllowShops = [SHOP];
  ops.attempts.push(...mergeAttempts.map((a) => ({ ...a })));
  const store = overrides.store ?? new MemoryShadowStore([op], mergeRecords);
  const settings = overrides.settings ?? settingsOn();
  return {
    deps: {
      store,
      ops,
      settings: async () => settings,
      adminFactory: async () => (overrides.admin === undefined ? fakeAdmin({}) : overrides.admin),
    },
    store,
    ops,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("shipping shadow evaluator (Phase 1)", () => {
  it("produces a READY intent with a frozen payload for an eligible secondary", async () => {
    const { deps, store } = makeDeps({});
    const report = await runShadowScan(deps, { apply: true });
    const row = store.rowFor(oid(200))!;
    expect(row.status).toBe("READY");
    expect(row.sourceShippingMinor).toBe("800");
    expect(row.plannedRefundMinor).toBe("800");
    expect(row.currencyCode).toBe("USD");
    expect(row.policyKind).toBe("REFUND_ALL");
    expect(row.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.marker).toMatch(/^MS-SHIP-/);
    const payload = row.requestPayload as any;
    expect(payload.shipping).toEqual({ amount: "8.00", fullRefund: false });
    expect(payload.transactions).toHaveLength(1);
    expect(payload.transactions[0].parentId).toBe("txn-cap");
    expect(payload.transactions[0].kind).toBe("REFUND");
    expect(payload.transactions[0].amount).toBe("8.00");
    expect(String(payload.note)).toContain(row.marker);
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("READY");
  });

  it("dry run evaluates but writes nothing", async () => {
    const { deps, store } = makeDeps({});
    const report = await runShadowScan(deps, { apply: false });
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("READY");
    expect(store.rows.size).toBe(0);
  });

  it("is idempotent across repeated scans — one row per source", async () => {
    const { deps, store } = makeDeps({});
    await runShadowScan(deps, { apply: true });
    const report = await runShadowScan(deps, { apply: true });
    expect(store.rows.size).toBe(1);
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("EXISTS");
  });

  it("subsystem kill switch off: nothing is scanned or written", async () => {
    const { deps, store, ops } = makeDeps({});
    ops.control.shippingAdjustmentsEnabled = false;
    const report = await runShadowScan(deps, { apply: true });
    expect(report.subsystemEnabled).toBe(false);
    expect(report.entries).toHaveLength(0);
    expect(store.rows.size).toBe(0);
  });

  it("empty shipping allowlist means NO shops (inverted semantics)", async () => {
    const { deps, store, ops } = makeDeps({});
    ops.control.shippingAllowShops = [];
    const report = await runShadowScan(deps, { apply: true });
    expect(report.entries).toHaveLength(0);
    expect(store.rows.size).toBe(0);
  });

  it("merchant opt-out: no rows are created at all", async () => {
    const { deps, store } = makeDeps({ settings: settingsOn({ shippingAdjustmentEnabled: false }) });
    const report = await runShadowScan(deps, { apply: true });
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("GATE_CLOSED");
    expect(store.rows.size).toBe(0);
  });

  it("a combine predating the activation epoch is durably SKIPPED", async () => {
    const { deps, store } = makeDeps({
      settings: settingsOn({ shippingAdjustmentEnabledAt: new Date("2026-10-21T00:00:00Z") }),
    });
    const report = await runShadowScan(deps, { apply: true });
    const row = store.rowFor(oid(200))!;
    expect(row.status).toBe("SKIPPED");
    expect(row.reasonCode).toBe("BEFORE_EPOCH");
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("SKIPPED");
  });

  it("a combine created after the epoch still qualifies", async () => {
    const { deps, store } = makeDeps({
      settings: settingsOn({ shippingAdjustmentEnabledAt: new Date("2026-10-19T00:00:00Z") }),
    });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("READY");
  });

  it("incomplete combine evidence parks REVIEW_REQUIRED without a Shopify read", async () => {
    const store = new MemoryShadowStore([completedOp()], []); // no MergeRecord
    const { deps } = makeDeps({ store });
    let shopifyCalls = 0;
    const admin: AdminClient = {
      graphql: async () => {
        shopifyCalls++;
        return { json: async () => ({ data: {} }) } as any;
      },
    };
    deps.adminFactory = async () => admin;
    await runShadowScan(deps, { apply: true });
    const row = store.rowFor(oid(200))!;
    expect(row.status).toBe("REVIEW_REQUIRED");
    expect(row.reviewReason).toContain("MergeRecord");
    expect(shopifyCalls).toBe(0);
  });

  it("a secondary missing verified-cancellation evidence is REVIEW", async () => {
    const op = completedOp({
      secondaries: [
        { id: oid(200), name: "#2000", items: 1, done: true, cancelPhase: "CANCEL_READY" },
      ],
    });
    const store = new MemoryShadowStore([op], mergeRecords);
    const { deps } = makeDeps({ store });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
  });

  it("preview mismatch with the policy amount is REVIEW, never a guessed amount", async () => {
    const { deps, store } = makeDeps({});
    deps.adminFactory = async () =>
      fakeAdmin({
        preview: () =>
          shopifyPreview({
            shipping: {
              amountSet: { presentmentMoney: MONEY("7.00") },
              taxSet: { presentmentMoney: MONEY("0.00") },
              maximumRefundableSet: { presentmentMoney: MONEY("8.00") },
            },
            amountSet: { presentmentMoney: MONEY("7.00") },
          }),
      });
    await runShadowScan(deps, { apply: true });
    const row = store.rowFor(oid(200))!;
    expect(row.status).toBe("REVIEW_REQUIRED");
    expect(row.requestPayload).toBeNull();
  });

  it("tax-bearing shipping is REVIEW (E3 pending)", async () => {
    const { deps, store } = makeDeps({});
    deps.adminFactory = async () =>
      fakeAdmin({
        order: () =>
          shopifyOrder({
            shippingLines: {
              nodes: [
                {
                  title: "Standard",
                  originalPriceSet: { presentmentMoney: MONEY("8.00") },
                  taxLines: [{ priceSet: { presentmentMoney: MONEY("0.68") } }],
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          }),
      });
    await runShadowScan(deps, { apply: true });
    const row = store.rowFor(oid(200))!;
    expect(row.status).toBe("REVIEW_REQUIRED");
    expect(row.reviewReason).toContain("tax");
  });

  it("tax-inclusive orders are REVIEW (E3 pending)", async () => {
    const { deps, store } = makeDeps({});
    deps.adminFactory = async () => fakeAdmin({ order: () => shopifyOrder({ taxesIncluded: true }) });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
  });

  it("prior shipping refunds are REVIEW", async () => {
    const { deps, store } = makeDeps({});
    deps.adminFactory = async () =>
      fakeAdmin({
        order: () =>
          shopifyOrder({
            displayFinancialStatus: "PARTIALLY_REFUNDED",
            totalRefundedShippingSet: { presentmentMoney: MONEY("3.00") },
            refunds: [
              {
                id: "r1",
                refundShippingLines: {
                  nodes: [{ subtotalAmountSet: { presentmentMoney: MONEY("3.00") } }],
                  pageInfo: { hasNextPage: false },
                },
              },
            ],
          }),
      });
    await runShadowScan(deps, { apply: true });
    const row = store.rowFor(oid(200))!;
    expect(row.status).toBe("REVIEW_REQUIRED");
    expect(row.reviewReason).toContain("PAID");
  });

  it("an uncancelled secondary is REVIEW", async () => {
    const { deps, store } = makeDeps({});
    deps.adminFactory = async () =>
      fakeAdmin({ order: () => shopifyOrder({ cancelledAt: null, closed: false, closedAt: null }) });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
  });

  it("an unclosed secondary is REVIEW once combine side effects are done", async () => {
    const { deps, store } = makeDeps({});
    deps.adminFactory = async () => fakeAdmin({ order: () => shopifyOrder({ closed: false, closedAt: null }) });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
  });

  it("a combine with unfinished side effects is deferred, never parked", async () => {
    const store = new MemoryShadowStore([completedOp({ sideEffectsDone: false })], mergeRecords);
    const { deps } = makeDeps({ store });
    await runShadowScan(deps, { apply: true });
    expect(store.rows.size).toBe(0);
  });

  it("a missing Shopify session is REVIEW", async () => {
    const { deps, store } = makeDeps({ admin: null });
    const report = await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("NO_SESSION");
  });

  it("transient Shopify failure reschedules the PENDING intent", async () => {
    const { deps, store } = makeDeps({});
    deps.adminFactory = async () => ({
      graphql: async () => {
        throw new Error("socket hangup");
      },
    });
    const report = await runShadowScan(deps, { apply: true });
    const row = store.rowFor(oid(200))!;
    expect(row.status).toBe("PENDING");
    expect(row.nextCheckAt).not.toBeNull();
    expect(row.reasonCode).toBe("TRANSIENT");
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("RETRY_SCHEDULED");
    // The deferral is real: a scan before nextCheckAt cannot reclaim it.
    const early = await runShadowScan(deps, { apply: true });
    expect(early.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("PENDING_HELD");
  });

  it("a PENDING intent is re-leased only after its lease expires, then settles", async () => {
    const now = new Date("2026-10-20T13:00:00Z");
    const { deps, store } = makeDeps({});
    store.clock = () => now;
    // Crash between claim and settle: leave a live-leased PENDING row.
    const identity = {
      shop: SHOP,
      mergeOperationId: "op-1",
      sourceOrderId: oid(200),
      operationCreatedAt: OP_CREATED,
      policyKind: "REFUND_ALL" as const,
      policyRetainedMinor: null,
      policyCurrencyCode: null,
    };
    const claimed = await store.claimIntent(identity, 60_000);
    expect(claimed).not.toBeNull();
    // Lease still live → the scan cannot take it over.
    const held = await runShadowScan(deps, { apply: true });
    expect(held.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("PENDING_HELD");
    // Lease expires → the next scan reclaims and settles.
    now.setTime(now.getTime() + 61_000);
    const report = await runShadowScan(deps, { apply: true });
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("READY");
    expect(store.rowFor(oid(200))?.status).toBe("READY");
  });

  it("repeated transient failures eventually park at the attempt cap", async () => {
    const now = new Date("2026-10-20T13:00:00Z");
    const { deps, store } = makeDeps({ admin: null });
    store.clock = () => now;
    // Seed a PENDING row at the cap minus one.
    const claimed = await store.claimIntent(
      {
        shop: SHOP,
        mergeOperationId: "op-1",
        sourceOrderId: oid(200),
        operationCreatedAt: OP_CREATED,
        policyKind: "REFUND_ALL",
        policyRetainedMinor: null,
        policyCurrencyCode: null,
      },
      60_000,
    );
    await store.rescheduleIntent(claimed!.id, claimed!.leaseToken!, 300_000, "TRANSIENT");
    store.rows.get(claimed!.id)!.attempts = 8;
    now.setTime(now.getTime() + 400_000);
    const report = await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("REVIEW_REQUIRED");
  });

  it("RETAIN_FIXED snapshots the policy into the intent", async () => {
    const { deps, store } = makeDeps({
      settings: settingsOn({
        shippingPolicy: "RETAIN_FIXED",
        shippingRetainedMinor: "300",
        shippingRetainedCurrency: "USD",
      }),
    });
    deps.adminFactory = async () =>
      fakeAdmin({
        preview: () =>
          shopifyPreview({
            amountSet: { presentmentMoney: MONEY("5.00") },
            shipping: {
              amountSet: { presentmentMoney: MONEY("5.00") },
              taxSet: { presentmentMoney: MONEY("0.00") },
              maximumRefundableSet: { presentmentMoney: MONEY("8.00") },
            },
            suggestedTransactions: [
              {
                kind: "SUGGESTED_REFUND",
                gateway: "bogus",
                amountSet: { presentmentMoney: MONEY("5.00") },
                parentTransaction: { id: "txn-cap", kind: "CAPTURE", status: "SUCCESS", gateway: "bogus" },
              },
            ],
          }),
      });
    await runShadowScan(deps, { apply: true });
    const row = store.rowFor(oid(200))!;
    expect(row.status).toBe("READY");
    expect(row.policyKind).toBe("RETAIN_FIXED");
    expect(row.policyRetainedMinor).toBe("300");
    expect(row.plannedRefundMinor).toBe("500");
    expect((row.requestPayload as any).shipping.amount).toBe("5.00");
  });

  it("an unsupported settings policy is REVIEW without touching the CHECK constraint", async () => {
    const { deps, store } = makeDeps({ settings: settingsOn({ shippingPolicy: "FOO" }) });
    await runShadowScan(deps, { apply: true });
    const row = store.rowFor(oid(200))!;
    expect(row.status).toBe("REVIEW_REQUIRED");
    expect(row.reviewReason).toContain("FOO");
  });

  it("a suggested transaction without a verifiable capture parent is REVIEW", async () => {
    const { deps, store } = makeDeps({});
    deps.adminFactory = async () =>
      fakeAdmin({
        preview: () =>
          shopifyPreview({
            suggestedTransactions: [
              {
                kind: "SUGGESTED_REFUND",
                gateway: "bogus",
                amountSet: { presentmentMoney: MONEY("8.00") },
                parentTransaction: { id: "txn-other", kind: "CAPTURE", status: "SUCCESS", gateway: "bogus" },
              },
            ],
          }),
      });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
  });

  it("no suggested transaction at all is REVIEW", async () => {
    const { deps, store } = makeDeps({});
    deps.adminFactory = async () =>
      fakeAdmin({ preview: () => shopifyPreview({ suggestedTransactions: [] }) });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
  });

  it("mixed presentment/shop currencies fail closed", async () => {
    const { deps, store } = makeDeps({});
    deps.adminFactory = async () =>
      fakeAdmin({ order: () => shopifyOrder({ presentmentCurrencyCode: "CAD" }) });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
  });

  it("unknown currency precision fails closed", async () => {
    const { deps, store } = makeDeps({});
    deps.adminFactory = async () =>
      fakeAdmin({ order: () => shopifyOrder({ currencyCode: "XXX", presentmentCurrencyCode: "XXX" }) });
    await runShadowScan(deps, { apply: true });
    const row = store.rowFor(oid(200))!;
    expect(row.status).toBe("REVIEW_REQUIRED");
    expect(row.reviewReason).toContain("XXX");
  });

  it("readOnlyAdmin refuses mutation documents — the evaluator cannot mutate Shopify", async () => {
    const admin = readOnlyAdmin({
      graphql: async () => ({ json: async () => ({ data: {} }) }) as any,
    });
    await expect(
      admin.graphql("mutation X { refundCreate(input: {}) { refund { id } } }", {}),
    ).rejects.toThrow(/read-only/);
    // Queries still pass through.
    const res = await admin.graphql("query Q { shop { id } }", {});
    await expect(res.json()).resolves.toEqual({ data: {} });
  });

  it("the combine's own rows are never modified — only ShippingAdjustment is written", async () => {
    const { deps, ops } = makeDeps({});
    const attemptSnapshot = structuredClone(ops.attempts);
    const controlSnapshot = { ...ops.control };
    await runShadowScan(deps, { apply: true });
    expect(structuredClone(ops.attempts)).toEqual(attemptSnapshot);
    expect(ops.control).toEqual(controlSnapshot);
    expect(ops.records).toHaveLength(0);
    expect(ops.ops.size).toBe(0); // the op fixture lives in the shadow store's list, untouched
  });
});

describe("minorToDecimal", () => {
  it("converts at the currency precision", () => {
    expect(minorToDecimal("800", 2)).toBe("8.00");
    expect(minorToDecimal("5", 0)).toBe("5");
    expect(minorToDecimal("12345", 3)).toBe("12.345");
    expect(minorToDecimal("7", 2)).toBe("0.07");
  });
});
