// Shipping v0 Phase 1.1 — shadow evaluator unit tests.
// A memory ShippingShadowStore mirrors the Postgres semantics (unique
// (shop, sourceOrderId), lease fencing on a fake clock, nextCheckAt
// deferral, atomic-gate comparison via an injected cutoff provider) so the
// driver logic is exercised without a database; the real-SQL store is
// covered separately in tests/shipping-shadow-pg.test.ts.

import { describe, expect, it } from "vitest";
import type { AdminClient } from "../app/lib/graphql.server";
import { OwnershipLostError } from "../app/lib/ownership.server";
import type { MutationAttempt, OperationRecord } from "../app/lib/operation-store.server";
import { shippingActivationCutoff } from "../app/lib/shipping-activation";
import { MemoryOperationStore } from "./fake-shopify";
import {
  GateChangedError,
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

const sameInstant = (a: Date | null, b: Date | null) =>
  a instanceof Date && b instanceof Date && a.getTime() === b.getTime();

// ── Memory store mirroring the Postgres lease/dedupe/gate semantics ───────────

class MemoryShadowStore implements ShippingShadowStore {
  rows = new Map<string, ShippingShadowRow>();
  private seq = 0;
  clock: () => Date = () => new Date();
  /** Mirrors the FOR SHARE cutoff recompute inside claim/settle. */
  gateCutoff?: (shop: string) => Date | null;
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

  async findUnevaluatedOps(shop: string, limit: number) {
    return this.clone(
      this.opsList
        .filter(
          (o) =>
            o.shop === shop &&
            o.protocolVersion === 2 &&
            o.phase === "COMPLETED" &&
            (o.secondaries ?? []).some(
              (s) => ![...this.rows.values()].some((r) => r.shop === shop && r.sourceOrderId === s.id),
            ),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, limit),
    );
  }
  async findDuePending(shop: string, limit: number) {
    const now = this.clock().getTime();
    return this.clone(
      [...this.rows.values()]
        .filter(
          (r) =>
            r.shop === shop &&
            r.status === "PENDING" &&
            (r.nextCheckAt == null || r.nextCheckAt.getTime() <= now),
        )
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
      activationCutoffAt: identity.activationCutoffAt,
      mode: "SHADOW",
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
    if (this.gateCutoff && !sameInstant(this.gateCutoff(identity.shop), identity.activationCutoffAt)) {
      return "GATE_CHANGED" as const;
    }
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
    if (patch.status === "READY" && this.gateCutoff) {
      const live = this.gateCutoff(stored.shop);
      if (!sameInstant(live, stored.activationCutoffAt)) {
        throw new GateChangedError(
          `Shipping intent ${id}: activation cutoff changed since intent creation.`,
        );
      }
    }
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

const EPOCH = new Date("2026-10-20T00:00:00Z");
const OP_CREATED = new Date("2026-10-20T12:00:00Z");

function completedOp(overrides: Partial<OperationRecord> = {}): OperationRecord {
  const secondaryId = overrides.secondaries?.[0]?.id ?? oid(200);
  const primaryId = overrides.primaryOrderId ?? oid(100);
  return {
    id: "op-1",
    shop: SHOP,
    status: "COMPLETED",
    protocolVersion: 2,
    phase: "COMPLETED",
    opToken: "7K2Q9XHD",
    primaryOrderId: primaryId,
    primaryOrderName: "#1000",
    customerId: "gid://shopify/Customer/1",
    primaryLineItemCountBefore: 1,
    addedLineItemCount: 1,
    secondaries: [
      {
        id: secondaryId,
        name: "#2000",
        items: 1,
        done: true,
        cancelPhase: "CANCEL_VERIFIED",
        cancelledAt: "2026-10-20T12:05:00Z",
        staffNoteMatched: true,
      },
    ],
    involvedOrderIds: [primaryId, secondaryId],
    attempts: 0,
    lastError: null,
    leaseToken: null,
    leasedUntil: null,
    calculatedOrderId: "gid://shopify/CalculatedOrder/1",
    expectedTransfer: [
      {
        secondaryId,
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
        { secondaryId, lineItemId: "gid://shopify/LineItem/10", variantId: "gid://shopify/ProductVariant/9", quantity: 1 },
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

const mergeAttempts = (opId = "op-1", primaryId = oid(100), secondaryId = oid(200)): MutationAttempt[] => [
  {
    id: `a1-${opId}`, operationId: opId, kind: "EDIT_COMMIT", targetOrderId: primaryId,
    attemptNo: 1, state: "SUCCEEDED", dispatchToken: "t", dispatchedAt: OP_CREATED,
    respondedAt: OP_CREATED, responseSummary: null, jobId: null,
  },
  {
    id: `a2-${opId}`, operationId: opId, kind: "ORDER_CANCEL", targetOrderId: secondaryId,
    attemptNo: 1, state: "SUCCEEDED", dispatchToken: "t", dispatchedAt: OP_CREATED,
    respondedAt: OP_CREATED, responseSummary: null, jobId: "job-1",
  },
];

const mergeRecordsFor = (op: OperationRecord) =>
  (op.secondaries ?? []).map((s) => ({
    shop: SHOP,
    mergedOrderId: s.id,
    primaryOrderId: op.primaryOrderId,
    operationId: op.id,
  }));

const settingsOn = (overrides: Partial<MergeSettings> = {}): MergeSettings => ({
  ...DEFAULT_SETTINGS,
  shippingAdjustmentEnabled: true,
  shippingAdjustmentEnabledAt: EPOCH,
  shippingRolloutAt: EPOCH,
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
          discountedPriceSet: { presentmentMoney: MONEY("8.00") },
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
          parentTransaction: { id: "txn-cap", kind: "CAPTURE", status: "SUCCESS", gateway: "bogus", test: true },
        },
      ],
      ...overrides,
    },
  };
}

/**
 * AdminClient stub: routes by document content AND records every call —
 * query VARIABLES are asserted by tests (e.g. the preview's shippingAmount),
 * so a wrong variable can never pass silently.
 */
function fakeAdmin(handlers: {
  order?: (vars: any) => any;
  preview?: (vars: any) => any;
}): AdminClient & { calls: { query: string; variables: any }[] } {
  const calls: { query: string; variables: any }[] = [];
  const admin = {
    calls,
    graphql: async (query: string, options?: { variables?: any }) => {
      calls.push({ query, variables: options?.variables });
      const isPreview = query.includes("suggestedRefund");
      return {
        json: async () => ({
          data: {
            order: isPreview
              ? handlers.preview?.(options?.variables) ?? shopifyPreview()
              : handlers.order?.(options?.variables) ?? shopifyOrder(),
          },
        }),
      } as any;
    },
  };
  return admin as any;
}

function makeDeps(overrides: {
  store?: MemoryShadowStore;
  ops?: MemoryOperationStore;
  settings?: MergeSettings;
  admin?: AdminClient | null;
  opsList?: OperationRecord[];
  records?: ReturnType<typeof mergeRecordsFor>;
}): { deps: ShadowDeps; store: MemoryShadowStore; ops: MemoryOperationStore; settings: MergeSettings } {
  const op = completedOp();
  const ops = overrides.ops ?? new MemoryOperationStore();
  ops.control.shippingAdjustmentsEnabled = true;
  ops.control.shippingEnabledAt = EPOCH;
  ops.control.shippingAllowShops = [SHOP];
  const opsList = overrides.opsList ?? [op];
  for (const o of opsList) {
    ops.ops.set(o.id, o);
    ops.attempts.push(...mergeAttempts(o.id, o.primaryOrderId, ...(o.secondaries ?? []).map((s) => s.id)));
  }
  const store = overrides.store ?? new MemoryShadowStore(
    opsList,
    overrides.records ?? opsList.flatMap(mergeRecordsFor),
  );
  const settings = overrides.settings ?? settingsOn();
  // Faithful atomic gate: the store recomputes the cutoff the same way the
  // SQL store does under FOR SHARE.
  store.gateCutoff = (s) =>
    shippingActivationCutoff({
      shippingAdjustmentsEnabled: ops.control.shippingAdjustmentsEnabled,
      shippingEnabledAt: ops.control.shippingEnabledAt,
      shippingAllowShops: ops.control.shippingAllowShops,
      shop: s,
      shippingRolloutAt: settings.shippingRolloutAt,
      shopEnabled: settings.shippingAdjustmentEnabled,
      enabledAt: settings.shippingAdjustmentEnabledAt,
    });
  return {
    deps: {
      store,
      ops,
      settings: async () => settings,
      adminFactory: async () => (overrides.admin === undefined ? fakeAdmin({}) : overrides.admin),
    },
    store,
    ops,
    settings,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("shipping shadow evaluator (Phase 1.1)", () => {
  it("produces a READY intent with a frozen payload for an eligible secondary", async () => {
    const { deps, store } = makeDeps({});
    const report = await runShadowScan(deps, { apply: true });
    const row = store.rowFor(oid(200))!;
    expect(row.status).toBe("READY");
    expect(row.mode).toBe("SHADOW");
    expect(row.sourceShippingMinor).toBe("800");
    expect(row.plannedRefundMinor).toBe("800");
    expect(row.currencyCode).toBe("USD");
    expect(row.policyKind).toBe("REFUND_ALL");
    expect(row.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.marker).toMatch(/^MS-SHIP-/);
    expect(row.activationCutoffAt?.getTime()).toBe(EPOCH.getTime());
    const payload = row.requestPayload as any;
    expect(payload.shipping).toEqual({
      shippingRefundAmount: { amount: "8.00", currencyCode: "USD" },
      fullRefund: false,
    });
    expect(payload.transactions).toHaveLength(1);
    expect(payload.transactions[0].parentId).toBe("txn-cap");
    expect(payload.transactions[0].kind).toBe("REFUND");
    expect(payload.transactions[0].amount).toBe("8.00");
    expect(String(payload.note)).toContain(row.marker);
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("READY");
  });

  it("requests a preview for exactly the policy amount — variables are asserted", async () => {
    const admin = fakeAdmin({});
    const { deps } = makeDeps({ admin });
    await runShadowScan(deps, { apply: true });
    const preview = admin.calls.find((c) => c.query.includes("suggestedRefund"));
    expect(preview?.variables).toEqual({ id: oid(200), shippingAmount: "8.00" });
  });

  it("dry run evaluates but writes nothing", async () => {
    const { deps, store } = makeDeps({});
    const report = await runShadowScan(deps, { apply: false });
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("READY");
    expect(store.rows.size).toBe(0);
  });

  it("is idempotent across repeated scans — evaluated combines leave the scan window", async () => {
    const { deps, store } = makeDeps({});
    await runShadowScan(deps, { apply: true });
    const report = await runShadowScan(deps, { apply: true });
    expect(store.rows.size).toBe(1);
    // The op's only secondary has a row — the combine falls out of the
    // unevaluated-ops window entirely (H5: terminal rows never starve later
    // combines and never re-scan).
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))).toBeUndefined();
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

  it("B1: a combine completed before the shop joined the rollout can never become eligible", async () => {
    // Merchant opted in at EPOCH; shop not yet allowlisted; combine at
    // OP_CREATED completes; the shop is allowlisted LATER (fresh rollout
    // epoch). The earlier combine must get a durable BEFORE_EPOCH skip —
    // never a refund candidate.
    const rolloutAt = new Date("2026-10-21T00:00:00Z"); // after OP_CREATED
    const { deps, store } = makeDeps({
      settings: settingsOn({ shippingRolloutAt: rolloutAt }),
    });
    const report = await runShadowScan(deps, { apply: true });
    const row = store.rowFor(oid(200))!;
    expect(row.status).toBe("SKIPPED");
    expect(row.reasonCode).toBe("BEFORE_EPOCH");
    expect(row.activationCutoffAt?.getTime()).toBe(rolloutAt.getTime());
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("SKIPPED");
  });

  it("B1: a combine completed while the kill switch was off can never become eligible", async () => {
    // Switch re-enabled at a later epoch — combines from the off-gap are cut.
    const { deps, store, ops } = makeDeps({});
    ops.control.shippingEnabledAt = new Date("2026-10-21T00:00:00Z");
    const report = await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("SKIPPED");
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("SKIPPED");
  });

  it("a combine predating the activation cutoff is durably SKIPPED", async () => {
    const { deps, store } = makeDeps({
      settings: settingsOn({ shippingAdjustmentEnabledAt: new Date("2026-10-21T00:00:00Z") }),
    });
    const report = await runShadowScan(deps, { apply: true });
    const row = store.rowFor(oid(200))!;
    expect(row.status).toBe("SKIPPED");
    expect(row.reasonCode).toBe("BEFORE_EPOCH");
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("SKIPPED");
  });

  it("a combine created after the cutoff still qualifies", async () => {
    const { deps, store } = makeDeps({});
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("READY");
  });

  it("a PENDING intent whose activation state changed settles REVIEW, never READY", async () => {
    // Claim under cutoff EPOCH; then the rollout membership is re-stamped at
    // a later instant (control toggle) → the row's snapshot is stale.
    const now = new Date("2026-10-20T13:00:00Z");
    const { deps, store, settings } = makeDeps({});
    store.clock = () => now;
    const claimed = await store.claimIntent(
      {
        shop: SHOP,
        mergeOperationId: "op-1",
        sourceOrderId: oid(200),
        operationCreatedAt: OP_CREATED,
        activationCutoffAt: EPOCH,
        policyKind: "REFUND_ALL",
        policyRetainedMinor: null,
        policyCurrencyCode: null,
      },
      60_000,
    );
    expect(claimed).not.toBeNull();
    // Rollout re-add stamps a NEW epoch — the intent's snapshot is stale.
    settings.shippingRolloutAt = new Date("2026-10-21T00:00:00Z");
    now.setTime(now.getTime() + 61_000);
    const report = await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
    expect(store.rowFor(oid(200))?.reviewReason).toContain("Activation state changed");
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("REVIEW_REQUIRED");
  });

  it("a READY settle races a control change: GATE_CHANGED, row stays PENDING", async () => {
    // Simulate the scan-versus-kill-switch race: claim succeeds, then the
    // kill-switch epoch moves before the READY write — settleIntent must
    // refuse rather than persist misleading READY evidence.
    const { store, settings } = makeDeps({});
    const claimed = (await store.claimIntent(
      {
        shop: SHOP,
        mergeOperationId: "op-1",
        sourceOrderId: oid(200),
        operationCreatedAt: OP_CREATED,
        activationCutoffAt: EPOCH,
        policyKind: "REFUND_ALL",
        policyRetainedMinor: null,
        policyCurrencyCode: null,
      },
      60_000,
    )) as ShippingShadowRow;
    settings.shippingRolloutAt = new Date("2026-10-22T00:00:00Z");
    await expect(
      store.settleIntent(claimed.id, claimed.leaseToken!, {
        status: "READY",
        sourceShippingMinor: "800",
        plannedRefundMinor: "800",
        currencyCode: "USD",
      }),
    ).rejects.toBeInstanceOf(GateChangedError);
    expect(store.rowFor(oid(200))?.status).toBe("PENDING");
    // A non-READY settle (deterministic evidence) is still allowed.
    await store.settleIntent(claimed.id, claimed.leaseToken!, {
      status: "REVIEW_REQUIRED",
      reviewReason: "gate changed mid-flight",
    });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
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
    expect(shopifyCalls).toBe(0);
  });

  it("an EDIT_COMMIT attempt targeting a different order is not evidence for this combine", async () => {
    const op = completedOp();
    const store = new MemoryShadowStore([op], mergeRecordsFor(op));
    const ops = new MemoryOperationStore();
    const { deps } = makeDeps({ store, ops });
    ops.attempts.length = 0;
    ops.attempts.push(
      { id: "a1", operationId: "op-1", kind: "EDIT_COMMIT", targetOrderId: oid(999), attemptNo: 1, state: "SUCCEEDED", dispatchToken: "t", dispatchedAt: OP_CREATED, respondedAt: OP_CREATED, responseSummary: null, jobId: null },
      { id: "a2", operationId: "op-1", kind: "ORDER_CANCEL", targetOrderId: oid(200), attemptNo: 1, state: "SUCCEEDED", dispatchToken: "t", dispatchedAt: OP_CREATED, respondedAt: OP_CREATED, responseSummary: null, jobId: null },
    );
    const report = await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.detail).toContain("commit");
  });

  it("a secondary missing verified-cancellation evidence is REVIEW", async () => {
    const op = completedOp();
    op.secondaries[0].cancelPhase = "CANCEL_READY";
    op.secondaries[0].done = false;
    const store = new MemoryShadowStore([op], mergeRecordsFor(op));
    const { deps } = makeDeps({ store });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
  });

  it("preview mismatch with the policy amount is REVIEW, never a guessed amount", async () => {
    const admin = fakeAdmin({
      preview: () =>
        shopifyPreview({ shipping: { amountSet: { presentmentMoney: MONEY("7.50") }, taxSet: { presentmentMoney: MONEY("0.00") }, maximumRefundableSet: { presentmentMoney: MONEY("8.00") } } }),
    });
    const { deps, store } = makeDeps({ admin });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
  });

  it("tax-bearing shipping is REVIEW (E3 pending)", async () => {
    const admin = fakeAdmin({
      order: () =>
        shopifyOrder({
          shippingLines: {
            nodes: [{
              title: "Standard",
              originalPriceSet: { presentmentMoney: MONEY("8.00") },
              discountedPriceSet: { presentmentMoney: MONEY("8.00") },
              taxLines: [{ priceSet: { presentmentMoney: MONEY("0.64") } }],
            }],
            pageInfo: { hasNextPage: false },
          },
        }),
    });
    const { deps, store } = makeDeps({ admin });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
  });

  it("tax-inclusive orders are REVIEW (E3 pending)", async () => {
    const admin = fakeAdmin({ order: () => shopifyOrder({ taxesIncluded: true }) });
    const { deps, store } = makeDeps({ admin });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
  });

  it("prior shipping refunds are REVIEW", async () => {
    const admin = fakeAdmin({
      order: () =>
        shopifyOrder({
          totalRefundedShippingSet: { presentmentMoney: MONEY("2.00") },
          refunds: [
            {
              id: "r1",
              note: "earlier",
              refundShippingLines: {
                nodes: [{ subtotalAmountSet: { presentmentMoney: MONEY("2.00") }, taxAmountSet: { presentmentMoney: MONEY("0.00") } }],
                pageInfo: { hasNextPage: false },
              },
            },
          ],
        }),
    });
    const { deps, store } = makeDeps({ admin });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
  });

  it("a bounded refund history that hits the bound is REVIEW (completeness unproven)", async () => {
    const admin = fakeAdmin({
      order: () =>
        shopifyOrder({
          refunds: Array.from({ length: 50 }, (_, i) => ({
            id: `r${i}`,
            note: null,
            refundShippingLines: { nodes: [], pageInfo: { hasNextPage: false } },
          })),
        }),
    });
    const { deps, store } = makeDeps({ admin });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
    expect(store.rowFor(oid(200))?.reviewReason).toContain("bounded");
  });

  it("a bounded transaction history that hits the bound is REVIEW", async () => {
    const admin = fakeAdmin({
      order: () =>
        shopifyOrder({
          transactions: Array.from({ length: 50 }, (_, i) => ({
            id: `t${i}`, kind: "CAPTURE", status: "SUCCESS", gateway: "bogus", test: true,
            amountSet: { presentmentMoney: MONEY("1.00") }, parentTransaction: null,
          })),
        }),
    });
    const { deps, store } = makeDeps({ admin });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
  });

  it("an uncancelled secondary is REVIEW", async () => {
    const admin = fakeAdmin({ order: () => shopifyOrder({ cancelledAt: null }) });
    const { deps, store } = makeDeps({ admin });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
  });

  it("an unclosed secondary is REVIEW once combine side effects are done", async () => {
    const admin = fakeAdmin({ order: () => shopifyOrder({ closed: false, closedAt: null }) });
    const { deps, store } = makeDeps({ admin });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
  });

  it("a combine with unfinished side effects is deferred, never parked", async () => {
    const op = completedOp({ sideEffectsDone: false });
    const store = new MemoryShadowStore([op], mergeRecordsFor(op));
    const { deps } = makeDeps({ store });
    const report = await runShadowScan(deps, { apply: true });
    expect(store.rows.size).toBe(0);
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("EXISTS");
  });

  it("a missing Shopify session is REVIEW", async () => {
    const { deps, store } = makeDeps({ admin: null });
    const report = await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("NO_SESSION");
  });

  it("a session LOOKUP failure is transient — rescheduled, never a permanent REVIEW", async () => {
    const { deps, store } = makeDeps({});
    deps.adminFactory = async () => {
      throw new Error("session store connection reset");
    };
    const report = await runShadowScan(deps, { apply: true });
    const row = store.rowFor(oid(200))!;
    expect(row.status).toBe("PENDING");
    expect(row.reasonCode).toBe("TRANSIENT");
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("RETRY_SCHEDULED");
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
    // The deferral is real: a scan before nextCheckAt produces no entry.
    const early = await runShadowScan(deps, { apply: true });
    expect(early.entries.find((e) => e.sourceOrderId === oid(200))).toBeUndefined();
    expect(store.rowFor(oid(200))?.status).toBe("PENDING");
  });

  it("a PENDING intent is re-leased only after its lease expires, then settles", async () => {
    const now = new Date("2026-10-20T13:00:00Z");
    const { deps, store } = makeDeps({});
    store.clock = () => now;
    const claimed = await store.claimIntent(
      {
        shop: SHOP,
        mergeOperationId: "op-1",
        sourceOrderId: oid(200),
        operationCreatedAt: OP_CREATED,
        activationCutoffAt: EPOCH,
        policyKind: "REFUND_ALL",
        policyRetainedMinor: null,
        policyCurrencyCode: null,
      },
      60_000,
    );
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

  it("repeated transient failures park only after the FULL attempt budget", async () => {
    const now = new Date("2026-10-20T13:00:00Z");
    const { deps, store } = makeDeps({ admin: null });
    store.clock = () => now;
    const claimed = await store.claimIntent(
      {
        shop: SHOP,
        mergeOperationId: "op-1",
        sourceOrderId: oid(200),
        operationCreatedAt: OP_CREATED,
        activationCutoffAt: EPOCH,
        policyKind: "REFUND_ALL",
        policyRetainedMinor: null,
        policyCurrencyCode: null,
      },
      60_000,
    );
    // Reclaim increments attempts before evaluation; seeding 7 means the
    // reclaim lands exactly ON the cap (8) and still evaluates.
    store.rows.get((claimed as ShippingShadowRow).id)!.attempts = 7;
    now.setTime(now.getTime() + 61_000);
    const report = await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED"); // evaluated: no session
    expect(report.entries.find((e) => e.sourceOrderId === oid(200))?.outcome).toBe("NO_SESSION");
  });

  it("an intent past the attempt cap parks without a Shopify read", async () => {
    const now = new Date("2026-10-20T13:00:00Z");
    const { deps, store } = makeDeps({});
    store.clock = () => now;
    let shopifyCalls = 0;
    deps.adminFactory = async () =>
      fakeAdmin({
        order: () => {
          shopifyCalls++;
          return shopifyOrder();
        },
      });
    const claimed = await store.claimIntent(
      {
        shop: SHOP,
        mergeOperationId: "op-1",
        sourceOrderId: oid(200),
        operationCreatedAt: OP_CREATED,
        activationCutoffAt: EPOCH,
        policyKind: "REFUND_ALL",
        policyRetainedMinor: null,
        policyCurrencyCode: null,
      },
      60_000,
    );
    // Reclaim increments to 9 — over the cap of 8 — so parking happens
    // without a single Shopify read.
    store.rows.get((claimed as ShippingShadowRow).id)!.attempts = 8;
    now.setTime(now.getTime() + 61_000);
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
    expect(store.rowFor(oid(200))?.reviewReason).toContain("attempt cap");
    expect(shopifyCalls).toBe(0);
  });

  it("RETAIN_FIXED snapshots the policy into the intent", async () => {
    const admin = fakeAdmin({
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
              parentTransaction: { id: "txn-cap", kind: "CAPTURE", status: "SUCCESS", gateway: "bogus", test: true },
            },
          ],
        }),
    });
    const { deps, store } = makeDeps({
      admin,
      settings: settingsOn({
        shippingPolicy: "RETAIN_FIXED",
        shippingRetainedMinor: "300",
        shippingRetainedCurrency: "USD",
      }),
    });
    await runShadowScan(deps, { apply: true });
    const row = store.rowFor(oid(200))!;
    expect(row.status).toBe("READY");
    expect(row.policyKind).toBe("RETAIN_FIXED");
    expect(row.policyRetainedMinor).toBe("300");
    expect(row.plannedRefundMinor).toBe("500");
    const preview = admin.calls.find((c) => c.query.includes("suggestedRefund"));
    expect(preview?.variables?.shippingAmount).toBe("5.00");
  });

  it("an unsupported settings policy is REVIEW without touching the CHECK constraint", async () => {
    const { deps, store } = makeDeps({
      settings: settingsOn({ shippingPolicy: "WEIRD" }),
    });
    await runShadowScan(deps, { apply: true });
    const row = store.rowFor(oid(200))!;
    expect(row.status).toBe("REVIEW_REQUIRED");
    expect(row.policyKind).toBe("REFUND_ALL"); // fallback snapshot, reason recorded
    expect(row.reviewReason).toContain("WEIRD");
  });

  it("a suggested transaction without a verifiable capture parent is REVIEW", async () => {
    const admin = fakeAdmin({
      preview: () =>
        shopifyPreview({
          suggestedTransactions: [
            {
              kind: "SUGGESTED_REFUND",
              gateway: "bogus",
              amountSet: { presentmentMoney: MONEY("8.00") },
              parentTransaction: { id: "txn-missing", kind: "CAPTURE", status: "SUCCESS", gateway: "bogus", test: true },
            },
          ],
        }),
    });
    const { deps, store } = makeDeps({ admin });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
  });

  it("split suggested refunds across two transactions are REVIEW — never guessed", async () => {
    const admin = fakeAdmin({
      preview: () =>
        shopifyPreview({
          suggestedTransactions: [
            {
              kind: "SUGGESTED_REFUND",
              gateway: "bogus",
              amountSet: { presentmentMoney: MONEY("4.00") },
              parentTransaction: { id: "txn-cap", kind: "CAPTURE", status: "SUCCESS", gateway: "bogus", test: true },
            },
            {
              kind: "SUGGESTED_REFUND",
              gateway: "gift_card",
              amountSet: { presentmentMoney: MONEY("4.00") },
              parentTransaction: { id: "txn-gc", kind: "SALE", status: "SUCCESS", gateway: "gift_card", test: true },
            },
          ],
        }),
    });
    const { deps, store } = makeDeps({ admin });
    await runShadowScan(deps, { apply: true });
    const row = store.rowFor(oid(200))!;
    expect(row.status).toBe("REVIEW_REQUIRED");
    expect(row.reviewReason).toContain("2 transactions");
  });

  it("a suggested transaction whose amount differs from the planned total is REVIEW", async () => {
    const admin = fakeAdmin({
      preview: () =>
        shopifyPreview({
          suggestedTransactions: [
            {
              kind: "SUGGESTED_REFUND",
              gateway: "bogus",
              amountSet: { presentmentMoney: MONEY("7.00") }, // preview total is 8.00
              parentTransaction: { id: "txn-cap", kind: "CAPTURE", status: "SUCCESS", gateway: "bogus", test: true },
            },
          ],
        }),
    });
    const { deps, store } = makeDeps({ admin });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
  });

  it("manual and gift-card gateways are REVIEW even on otherwise-valid orders", async () => {
    for (const gateway of ["manual", "gift_card", "cash", "shopify_payments"]) {
      const store = new MemoryShadowStore([completedOp()], mergeRecordsFor(completedOp()));
      const admin = fakeAdmin({
        order: () =>
          shopifyOrder({
            transactions: [
              { id: "txn-sale", kind: "SALE", status: "SUCCESS", gateway, test: gateway === "bogus", amountSet: { presentmentMoney: MONEY("18.00") }, parentTransaction: null },
            ],
          }),
        preview: () =>
          shopifyPreview({
            suggestedTransactions: [
              {
                kind: "SUGGESTED_REFUND",
                gateway,
                amountSet: { presentmentMoney: MONEY("8.00") },
                parentTransaction: { id: "txn-sale", kind: "SALE", status: "SUCCESS", gateway, test: true },
              },
            ],
          }),
      });
      const { deps } = makeDeps({ store, admin });
      await runShadowScan(deps, { apply: true });
      const row = store.rowFor(oid(200))!;
      expect(row.status, `gateway ${gateway}`).toBe("REVIEW_REQUIRED");
      expect(row.reviewReason, `gateway ${gateway}`).toMatch(/gateway|Gateway/i);
    }
  });

  it("a non-test transaction on a non-test order is REVIEW (bogus is test-only)", async () => {
    const admin = fakeAdmin({
      order: () =>
        shopifyOrder({
          test: false,
          transactions: [
            { id: "txn-cap", kind: "CAPTURE", status: "SUCCESS", gateway: "bogus", test: false, amountSet: { presentmentMoney: MONEY("18.00") }, parentTransaction: null },
          ],
        }),
      preview: () =>
        shopifyPreview({
          suggestedTransactions: [
            {
              kind: "SUGGESTED_REFUND",
              gateway: "bogus",
              amountSet: { presentmentMoney: MONEY("8.00") },
              parentTransaction: { id: "txn-cap", kind: "CAPTURE", status: "SUCCESS", gateway: "bogus", test: false },
            },
          ],
        }),
    });
    const { deps, store } = makeDeps({ admin });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
  });

  it("discounted shipping: the customer paid the DISCOUNTED price — REFUND_ALL", async () => {
    const admin = fakeAdmin({
      order: () =>
        shopifyOrder({
          shippingLines: {
            nodes: [{
              title: "Standard",
              originalPriceSet: { presentmentMoney: MONEY("10.00") },
              discountedPriceSet: { presentmentMoney: MONEY("6.00") }, // $4 shipping discount
              taxLines: [],
            }],
            pageInfo: { hasNextPage: false },
          },
        }),
      preview: () =>
        shopifyPreview({
          amountSet: { presentmentMoney: MONEY("6.00") },
          shipping: {
            amountSet: { presentmentMoney: MONEY("6.00") },
            taxSet: { presentmentMoney: MONEY("0.00") },
            maximumRefundableSet: { presentmentMoney: MONEY("6.00") },
          },
          suggestedTransactions: [
            {
              kind: "SUGGESTED_REFUND",
              gateway: "bogus",
              amountSet: { presentmentMoney: MONEY("6.00") },
              parentTransaction: { id: "txn-cap", kind: "CAPTURE", status: "SUCCESS", gateway: "bogus", test: true },
            },
          ],
        }),
    });
    const { deps, store } = makeDeps({ admin });
    await runShadowScan(deps, { apply: true });
    const row = store.rowFor(oid(200))!;
    expect(row.status).toBe("READY");
    expect(row.sourceShippingMinor).toBe("600"); // discounted, not 1000
    expect(row.plannedRefundMinor).toBe("600");
    const preview = admin.calls.find((c) => c.query.includes("suggestedRefund"));
    expect(preview?.variables?.shippingAmount).toBe("6.00");
  });

  it("discounted shipping under RETAIN_FIXED: refund = discounted − retained", async () => {
    // $10 shipping, $4 discount → paid $6; retain $3 → refund $3.
    const admin = fakeAdmin({
      order: () =>
        shopifyOrder({
          shippingLines: {
            nodes: [{
              title: "Standard",
              originalPriceSet: { presentmentMoney: MONEY("10.00") },
              discountedPriceSet: { presentmentMoney: MONEY("6.00") },
              taxLines: [],
            }],
            pageInfo: { hasNextPage: false },
          },
        }),
      preview: () =>
        shopifyPreview({
          amountSet: { presentmentMoney: MONEY("3.00") },
          shipping: {
            amountSet: { presentmentMoney: MONEY("3.00") },
            taxSet: { presentmentMoney: MONEY("0.00") },
            maximumRefundableSet: { presentmentMoney: MONEY("6.00") },
          },
          suggestedTransactions: [
            {
              kind: "SUGGESTED_REFUND",
              gateway: "bogus",
              amountSet: { presentmentMoney: MONEY("3.00") },
              parentTransaction: { id: "txn-cap", kind: "CAPTURE", status: "SUCCESS", gateway: "bogus", test: true },
            },
          ],
        }),
    });
    const { deps, store } = makeDeps({
      admin,
      settings: settingsOn({
        shippingPolicy: "RETAIN_FIXED",
        shippingRetainedMinor: "300",
        shippingRetainedCurrency: "USD",
      }),
    });
    await runShadowScan(deps, { apply: true });
    const row = store.rowFor(oid(200))!;
    expect(row.status).toBe("READY");
    expect(row.plannedRefundMinor).toBe("300");
  });

  it("more than 50 completed combines do not starve later ones — scan makes progress", async () => {
    // 60 combines, one secondary each: after two scans every one is settled.
    const opsList = Array.from({ length: 60 }, (_, i) => {
      const sec = oid(1000 + i);
      return completedOp({
        id: `op-${i}`,
        primaryOrderId: oid(2000 + i),
        secondaries: [
          {
            id: sec,
            name: `#${2000 + i}`,
            items: 1,
            done: true,
            cancelPhase: "CANCEL_VERIFIED" as const,
            cancelledAt: "2026-10-20T12:05:00Z",
            staffNoteMatched: true,
          },
        ],
        expectedTransfer: [{ secondaryId: sec, secondaryIndex: 1, lines: [{ sourceLineItemId: "l", variantId: "v", quantity: 1 }] }],
        appliedEvidence: { agreementId: "ag", happenedAt: "t", lines: [{ secondaryId: sec, lineItemId: "li", variantId: "v", quantity: 1 }] },
      });
    });
    const { deps, store } = makeDeps({
      opsList,
      records: opsList.flatMap(mergeRecordsFor),
    });
    await runShadowScan(deps, { apply: true });
    const afterFirst = store.rows.size;
    expect(afterFirst).toBe(50); // bounded per scan
    await runShadowScan(deps, { apply: true });
    expect(store.rows.size).toBe(60);
    expect([...store.rows.values()].every((r) => r.status === "READY")).toBe(true);
  });

  it("mixed presentment/shop currencies fail closed", async () => {
    const admin = fakeAdmin({ order: () => shopifyOrder({ presentmentCurrencyCode: "EUR" }) });
    const { deps, store } = makeDeps({ admin });
    await runShadowScan(deps, { apply: true });
    expect(store.rowFor(oid(200))?.status).toBe("REVIEW_REQUIRED");
  });

  it("unknown currency precision fails closed", async () => {
    const xxx = (a: string) => ({ amount: a, currencyCode: "XXX" });
    const admin = fakeAdmin({
      order: () =>
        shopifyOrder({
          currencyCode: "XXX",
          presentmentCurrencyCode: "XXX",
          totalRefundedShippingSet: { presentmentMoney: xxx("0.00") },
          totalRefundedSet: { presentmentMoney: xxx("0.00") },
          shippingLines: {
            nodes: [{
              title: "Standard",
              originalPriceSet: { presentmentMoney: xxx("8.00") },
              discountedPriceSet: { presentmentMoney: xxx("8.00") },
              taxLines: [],
            }],
            pageInfo: { hasNextPage: false },
          },
          transactions: [
            { id: "txn-cap", kind: "CAPTURE", status: "SUCCESS", gateway: "bogus", test: true, amountSet: { presentmentMoney: xxx("18.00") }, parentTransaction: null },
          ],
        }),
    });
    const { deps, store } = makeDeps({ admin });
    await runShadowScan(deps, { apply: true });
    const row = store.rowFor(oid(200))!;
    expect(row.status).toBe("REVIEW_REQUIRED");
    // XXX has no minor-unit precision, so the monetary parser refuses it at
    // the first sum — the outcome is fail-closed REVIEW either way.
    expect(row.reviewReason).toMatch(/currency/i);
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

  it("the combine's own rows are never touched — real stores see zero writes", async () => {
    const { deps, ops, store } = makeDeps({});
    const opBefore = structuredClone([...ops.ops.values()]);
    const attemptSnapshot = structuredClone(ops.attempts);
    const controlSnapshot = { ...ops.control };
    await runShadowScan(deps, { apply: true });
    expect(structuredClone([...ops.ops.values()])).toEqual(opBefore);
    expect(structuredClone(ops.attempts)).toEqual(attemptSnapshot);
    expect(ops.control).toEqual(controlSnapshot);
    expect(ops.records).toHaveLength(0); // the evaluator never writes MergeRecord
    expect(ops.locks.size).toBe(0);
    expect([...store.rows.values()].every((r) => r.mode === "SHADOW")).toBe(true);
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
