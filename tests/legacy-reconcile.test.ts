// Plan-level tests for app/lib/legacy-reconcile.server.ts (corrections C1):
// exact-identifier evidence, overlap pre-pass, cancel-certainty phases and the
// rule that driving a converted op can never dispatch a fresh orderCancel.
// Pure classification uses a canned fake admin; the drive assertions use the
// memory stores + FakeShopify.

import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { AdminClient } from "../app/lib/graphql.server";
import {
  planLegacyReconciliation,
  type LegacyReconcileDeps,
  type LegacyVerdict,
} from "../app/lib/legacy-reconcile.server";
import { driveOperation } from "../app/lib/operation-protocol.server";
import type { MergeDeps } from "../app/lib/merge.server";
import {
  APP_ID,
  FakeShopify,
  MemoryJournal,
  makeOrder,
  testDeps,
  type MemoryOperationStore,
} from "./fake-shopify";

const SHOP = "legacy.myshopify.com";
const gid = (n: number) => `gid://shopify/Order/${n}`;
const VARIANT = "gid://shopify/ProductVariant/1";
const NOW = new Date("2026-10-01T12:00:00Z");

let seq = 0;
const legacyOp = (overrides: Record<string, unknown> = {}) => ({
  id: `legacy-op-${++seq}`,
  shop: SHOP,
  status: "COMMITTED",
  primaryOrderId: gid(1),
  primaryOrderName: "#1",
  customerId: "gid://shopify/Customer/1",
  secondaries: [],
  involvedOrderIds: [] as string[],
  createdAt: new Date(NOW.getTime() - 60 * 60_000),
  updatedAt: new Date(NOW.getTime() - 60 * 60_000),
  lastError: null,
  protocolVersion: 1,
  ...overrides,
});

/** The LegacyEvidence document shape, built from friendly knobs. */
const evidenceOrder = (o: {
  cancelledAt?: string | null;
  staffNote?: string | null;
  lines: { id: string; quantity: number; currentQuantity?: number; variantId: string; description?: string }[];
  agreements?: { id?: string; happenedAt: string; appId?: string; sales: { lineItemId: string; quantity?: number }[] }[];
}) => ({
  cancelledAt: o.cancelledAt ?? null,
  displayFulfillmentStatus: "UNFULFILLED",
  cancellation: o.staffNote !== undefined ? { staffNote: o.staffNote } : null,
  lineItems: {
    nodes: o.lines.map((l) => ({
      id: l.id,
      quantity: l.quantity,
      currentQuantity: l.currentQuantity ?? l.quantity,
      variant: { id: l.variantId },
      discountAllocations: l.description
        ? [{ discountApplication: { __typename: "ManualDiscountApplication", description: l.description } }]
        : [],
    })),
  },
  agreements: {
    nodes: (o.agreements ?? []).map((a, i) => ({
      __typename: "OrderEditAgreement",
      id: a.id ?? `gid://shopify/OrderEditAgreement/${i}`,
      happenedAt: a.happenedAt,
      app: { id: a.appId ?? APP_ID },
      sales: {
        nodes: a.sales.map((s) => ({
          __typename: "ProductSale",
          quantity: s.quantity ?? 1,
          lineItem: { id: s.lineItemId },
        })),
      },
    })),
  },
});

/** The named Legacy* documents, served from the same per-order fixtures.
 *  `intercept` may short-circuit a document (return value becomes the body). */
const adminOf = (
  orders: Map<string, any>,
  failOn = new Set<string>(),
  intercept?: (name: string, vars: Record<string, unknown>) => unknown | undefined,
): AdminClient => ({
  graphql: async (query: string, options?: { variables?: Record<string, unknown> }) => {
    const name = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "unknown";
    const vars = options?.variables ?? {};
    const intercepted = intercept?.(name, vars);
    if (intercepted !== undefined) {
      return new Response(JSON.stringify(intercepted));
    }
    if (name === "LegacyCurrentApp") {
      return new Response(
        JSON.stringify({ data: { currentAppInstallation: { app: { id: APP_ID } } } }),
      );
    }
    const orderId = vars.id as string;
    if (failOn.has(orderId)) throw new Error("read failed");
    const o = orders.get(orderId) ?? null;
    if (name === "LegacyOrderState") {
      return new Response(
        JSON.stringify({
          data: {
            order:
              o &&
              (({ lineItems, agreements, ...state }: any) => state)(o),
          },
        }),
      );
    }
    if (name === "LegacyLines") {
      return new Response(
        JSON.stringify({
          data: {
            order: o && {
              lineItems: {
                nodes: o.lineItems?.nodes ?? [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
      );
    }
    if (name === "LegacyAgreements") {
      return new Response(
        JSON.stringify({
          data: {
            order: o && {
              agreements: {
                nodes: (o.agreements?.nodes ?? []).map((a: any) => ({
                  ...a,
                  sales: {
                    nodes: a.sales?.nodes ?? [],
                    pageInfo: { hasNextPage: false },
                  },
                })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
      );
    }
    throw new Error(`canned admin: unhandled document ${name}`);
  },
});

const planDeps = (
  orders: Map<string, any>,
  opts: {
    admin?: AdminClient | null;
    failOn?: Set<string>;
    onAdminFor?: () => void;
    intercept?: (name: string, vars: Record<string, unknown>) => unknown | undefined;
  } = {},
): LegacyReconcileDeps => ({
  db: {} as PrismaClient, // ops are always passed explicitly here
  adminFor: async () => {
    opts.onAdminFor?.();
    return opts.admin !== undefined
      ? opts.admin
      : adminOf(orders, opts.failOn ?? new Set(), opts.intercept);
  },
  now: () => NOW,
});

/** Primary #1 holding its own line plus a v1 token line for `secName`. */
const appliedPrimary = (
  secName: string,
  extra: { description?: string; variantId?: string } = {},
) =>
  evidenceOrder({
    lines: [
      { id: "li-orig", quantity: 1, variantId: VARIANT },
      {
        id: "li-token",
        quantity: 1,
        variantId: extra.variantId ?? VARIANT,
        description: extra.description ?? `Merged from ${secName}, already paid`,
      },
    ],
    agreements: [
      {
        happenedAt: new Date(NOW.getTime() - 50 * 60_000).toISOString(),
        sales: [{ lineItemId: "li-token" }],
      },
    ],
  });

const LEGACY_CANCEL_NOTE = (primary: string) =>
  `Repeat order merged into ${primary} by MergeShip. Items transferred, inventory restocked, not refunded. Ref MS-OLDTOKEN`;

describe("planLegacyReconciliation", () => {
  it("a token line for #123 does not prove the transfer for secondary #12", async () => {
    const sec = { id: gid(12), name: "#12", items: 1 };
    const op = legacyOp({ secondaries: [sec], involvedOrderIds: [gid(1), gid(12)] });
    const orders = new Map([
      [gid(1), appliedPrimary("#123")], // a DIFFERENT order's line is on the primary
      [gid(12), evidenceOrder({ lines: [{ id: "li-12", quantity: 1, variantId: VARIANT }] })],
    ]);
    const [plan] = await planLegacyReconciliation(planDeps(orders), [op]);
    expect(plan.verdict.phase).toBe("REVIEW_REQUIRED");
    expect(plan.verdict.reason).toContain("no evidence");
    expect(plan.verdict.secondaries.map((s) => s.id)).toEqual([gid(12)]);
    expect(plan.verdict.secondaries[0].cancelPhase).toBe("CANCEL_REVIEW");
  });

  it("two v1 ops sharing an involved order are both REVIEW_REQUIRED before any read", async () => {
    const a = legacyOp({
      secondaries: [{ id: gid(2), name: "#2", items: 1 }],
      involvedOrderIds: [gid(1), gid(2), gid(3)],
    });
    const b = legacyOp({
      primaryOrderId: gid(3),
      primaryOrderName: "#3",
      secondaries: [{ id: gid(4), name: "#4", items: 1 }],
      involvedOrderIds: [gid(3), gid(4)],
    });
    let reads = 0;
    const plans = await planLegacyReconciliation(
      planDeps(new Map(), { onAdminFor: () => reads++ }),
      [a, b],
    );
    expect(reads).toBe(0); // the overlap pre-pass runs before any live read
    for (const p of plans) {
      expect(p.verdict.phase).toBe("REVIEW_REQUIRED");
      expect(p.verdict.reason).toBe("overlapping legacy operations");
      expect(p.verdict.secondaries.length).toBe(1);
      expect(p.verdict.secondaries[0].cancelPhase).toBe("CANCEL_REVIEW");
      expect(p.verdict.secondaries[0].secondaryIndex).toBe(1);
    }
  });

  it("a cancelled secondary with the exact v1 staff note: CANCEL_VERIFIED + APPLIED + record", async () => {
    const sec = { id: gid(2), name: "#2", items: 1 };
    const op = legacyOp({ secondaries: [sec], involvedOrderIds: [gid(1), gid(2)] });
    const orders = new Map([
      [gid(1), appliedPrimary("#2")],
      [
        gid(2),
        evidenceOrder({
          cancelledAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
          staffNote: LEGACY_CANCEL_NOTE("#1"),
          lines: [{ id: "li-2", quantity: 1, variantId: VARIANT }],
        }),
      ],
    ]);
    const [plan] = await planLegacyReconciliation(planDeps(orders), [op]);
    expect(plan.verdict.phase).toBe("APPLIED");
    expect(plan.verdict.secondaries[0].cancelPhase).toBe("CANCEL_VERIFIED");
    expect(plan.verdict.records.map((r) => r.id)).toEqual([gid(2)]);
    expect(plan.verdict.appliedEvidence?.agreementId).toBe("gid://shopify/OrderEditAgreement/0");
    expect(plan.verdict.appliedEvidence?.lines).toEqual([
      { secondaryId: gid(2), lineItemId: "li-token", variantId: VARIANT, quantity: 1 },
    ]);
  });

  it("a staff note for a different primary does not prove ours", async () => {
    const sec = { id: gid(2), name: "#2", items: 1 };
    const op = legacyOp({ secondaries: [sec], involvedOrderIds: [gid(1), gid(2)] });
    const orders = new Map([
      [gid(1), appliedPrimary("#2")],
      [
        gid(2),
        evidenceOrder({
          cancelledAt: new Date().toISOString(),
          staffNote: LEGACY_CANCEL_NOTE("#10"), // merged into a DIFFERENT order
          lines: [{ id: "li-2", quantity: 1, variantId: VARIANT }],
        }),
      ],
    ]);
    const [plan] = await planLegacyReconciliation(planDeps(orders), [op]);
    expect(plan.verdict.phase).toBe("REVIEW_REQUIRED");
    expect(plan.verdict.secondaries[0].cancelPhase).toBe("CANCEL_REVIEW");
    expect(plan.verdict.records).toHaveLength(0);
  });

  it("open secondary WITHOUT cancelRequestedAt: CANCEL_REVIEW (never CANCEL_READY) + REVIEW_REQUIRED", async () => {
    const sec = { id: gid(2), name: "#2", items: 1 };
    const op = legacyOp({ secondaries: [sec], involvedOrderIds: [gid(1), gid(2)] });
    const orders = new Map([
      [gid(1), appliedPrimary("#2")],
      [gid(2), evidenceOrder({ lines: [{ id: "li-2", quantity: 1, variantId: VARIANT }] })],
    ]);
    const [plan] = await planLegacyReconciliation(planDeps(orders), [op]);
    // v1 recorded no write-ahead cancellation — whether one was dispatched is
    // unprovable, so the op can never self-drive a cancel.
    expect(plan.verdict.phase).toBe("REVIEW_REQUIRED");
    expect(plan.verdict.secondaries[0].cancelPhase).toBe("CANCEL_REVIEW");
    expect(plan.verdict.syntheticAttempts).toHaveLength(0);
    expect(plan.verdict.appliedEvidence).not.toBeNull();
  });

  it("lost-response legacy cancel (cancelRequestedAt + open): CANCEL_IN_DOUBT + synthetic UNKNOWN attempt", async () => {
    const cancelRequestedAt = new Date(NOW.getTime() - 40 * 60_000).toISOString();
    const sec = { id: gid(2), name: "#2", items: 1, cancelRequestedAt };
    const op = legacyOp({ secondaries: [sec], involvedOrderIds: [gid(1), gid(2)] });
    const orders = new Map([
      [gid(1), appliedPrimary("#2")],
      [gid(2), evidenceOrder({ lines: [{ id: "li-2", quantity: 1, variantId: VARIANT }] })],
    ]);
    const [plan] = await planLegacyReconciliation(planDeps(orders), [op]);
    expect(plan.verdict.phase).toBe("APPLIED");
    expect(plan.verdict.secondaries[0].cancelPhase).toBe("CANCEL_IN_DOUBT");
    expect(plan.verdict.syntheticAttempts).toEqual([
      { targetOrderId: gid(2), dispatchedAt: new Date(cancelRequestedAt) },
    ]);
  });

  it("a read failure on the second secondary still carries EVERY secondary", async () => {
    const s2 = { id: gid(2), name: "#2", items: 1 };
    const s3 = { id: gid(3), name: "#3", items: 1 };
    const op = legacyOp({ secondaries: [s2, s3], involvedOrderIds: [gid(1), gid(2), gid(3)] });
    const orders = new Map([
      [gid(1), appliedPrimary("#2")],
      [gid(2), evidenceOrder({ cancelledAt: "x", staffNote: LEGACY_CANCEL_NOTE("#1"), lines: [] })],
      [gid(3), evidenceOrder({ lines: [{ id: "li-3", quantity: 1, variantId: VARIANT }] })],
    ]);
    const [plan] = await planLegacyReconciliation(
      planDeps(orders, { failOn: new Set([gid(3)]) }),
      [op],
    );
    expect(plan.verdict.phase).toBe("REVIEW_REQUIRED");
    expect(plan.verdict.secondaries.map((s) => s.id)).toEqual([gid(2), gid(3)]);
    // The unread secondary is carried as CANCEL_REVIEW with its index.
    expect(plan.verdict.secondaries[1].cancelPhase).toBe("CANCEL_REVIEW");
    expect(plan.verdict.secondaries[1].secondaryIndex).toBe(2);
  });

  it("an ABANDONED op with positive transfer evidence and an open secondary: REVIEW_REQUIRED + CANCEL_REVIEW", async () => {
    const sec = { id: gid(2), name: "#2", items: 1 };
    const op = legacyOp({
      status: "ABANDONED",
      lastError: "Commit edit rejected: The calculated order does not exist.",
      secondaries: [sec],
      involvedOrderIds: [gid(1), gid(2)],
    });
    const orders = new Map([
      [gid(1), appliedPrimary("#2")], // the "abandoned" commit DID apply
      [gid(2), evidenceOrder({ lines: [{ id: "li-2", quantity: 1, variantId: VARIANT }] })],
    ]);
    const [plan] = await planLegacyReconciliation(planDeps(orders), [op]);
    expect(plan.verdict.phase).toBe("REVIEW_REQUIRED");
    expect(plan.verdict.secondaries[0].cancelPhase).toBe("CANCEL_REVIEW");
    expect(plan.verdict.reason).toContain("cancelled");
    expect(plan.verdict.appliedEvidence).not.toBeNull();
  });

  it("an ABANDONED op past the quiet period with no MergeShip trace: terminal ABANDONED", async () => {
    const sec = { id: gid(2), name: "#2", items: 1 };
    const op = legacyOp({
      status: "ABANDONED",
      createdAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
      updatedAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
      secondaries: [sec],
      involvedOrderIds: [gid(1), gid(2)],
    });
    const orders = new Map([
      // Clean primary: its own line, no token lines, no MergeShip agreement.
      [gid(1), evidenceOrder({ lines: [{ id: "li-orig", quantity: 1, variantId: VARIANT }] })],
      [gid(2), evidenceOrder({ lines: [{ id: "li-2", quantity: 1, variantId: VARIANT }] })],
    ]);
    const [plan] = await planLegacyReconciliation(planDeps(orders), [op]);
    expect(plan.verdict.phase).toBe("ABANDONED");
    expect(plan.verdict.secondaries[0].cancelPhase).toBe("TRANSFER_PENDING");
    expect(plan.verdict.records).toHaveLength(0);
    expect(plan.verdict.syntheticAttempts).toHaveLength(0);
    expect(plan.verdict.expectedTransfer).toEqual([]);
    expect(plan.verdict.appliedEvidence).toBeNull();
  });

  it("an ABANDONED op inside the quiet period: REVIEW_REQUIRED, never terminal", async () => {
    const sec = { id: gid(2), name: "#2", items: 1 };
    const op = legacyOp({
      status: "ABANDONED",
      createdAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
      updatedAt: new Date(NOW.getTime() - 5 * 60_000), // touched 5 minutes ago
      secondaries: [sec],
      involvedOrderIds: [gid(1), gid(2)],
    });
    const orders = new Map([
      [gid(1), evidenceOrder({ lines: [{ id: "li-orig", quantity: 1, variantId: VARIANT }] })],
      [gid(2), evidenceOrder({ lines: [{ id: "li-2", quantity: 1, variantId: VARIANT }] })],
    ]);
    const [plan] = await planLegacyReconciliation(planDeps(orders), [op]);
    expect(plan.verdict.phase).toBe("REVIEW_REQUIRED");
    expect(plan.verdict.reason).toContain("abandonment could not be verified");
    expect(plan.verdict.secondaries[0].cancelPhase).toBe("CANCEL_REVIEW");
  });

  it("an ABANDONED op with a MergeShip agreement in the window but no token lines: REVIEW_REQUIRED", async () => {
    const sec = { id: gid(2), name: "#2", items: 1 };
    const op = legacyOp({
      status: "ABANDONED",
      createdAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
      updatedAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
      secondaries: [sec],
      involvedOrderIds: [gid(1), gid(2)],
    });
    const orders = new Map([
      [
        gid(1),
        evidenceOrder({
          lines: [{ id: "li-orig", quantity: 1, variantId: VARIANT }],
          agreements: [
            {
              happenedAt: new Date(NOW.getTime() - 110 * 60_000).toISOString(),
              sales: [{ lineItemId: "li-orig" }],
            },
          ],
        }),
      ],
      [gid(2), evidenceOrder({ lines: [{ id: "li-2", quantity: 1, variantId: VARIANT }] })],
    ]);
    const [plan] = await planLegacyReconciliation(planDeps(orders), [op]);
    expect(plan.verdict.phase).toBe("REVIEW_REQUIRED");
    expect(plan.verdict.reason).toContain("abandonment could not be verified");
  });

  it("an ABANDONED op with incomplete primary line pagination: REVIEW_REQUIRED (reconcile read failed)", async () => {
    const sec = { id: gid(2), name: "#2", items: 1 };
    const op = legacyOp({
      status: "ABANDONED",
      createdAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
      updatedAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
      secondaries: [sec],
      involvedOrderIds: [gid(1), gid(2)],
    });
    const orders = new Map([
      [gid(1), evidenceOrder({ lines: [{ id: "li-orig", quantity: 1, variantId: VARIANT }] })],
      [gid(2), evidenceOrder({ lines: [{ id: "li-2", quantity: 1, variantId: VARIANT }] })],
    ]);
    const [plan] = await planLegacyReconciliation(
      planDeps(orders, {
        // A page claiming more results with no usable cursor is not a read.
        intercept: (name, vars) =>
          name === "LegacyLines" && vars.id === gid(1)
            ? {
                data: {
                  order: {
                    lineItems: {
                      nodes: [{ id: "li-orig" }],
                      pageInfo: { hasNextPage: true, endCursor: null },
                    },
                  },
                },
              }
            : undefined,
      }),
      [op],
    );
    expect(plan.verdict.phase).toBe("REVIEW_REQUIRED");
    expect(plan.verdict.reason).toContain("reconcile read failed");
  });

  it("an ABANDONED op overlapping another legacy op: both REVIEW_REQUIRED before any read", async () => {
    const a = legacyOp({
      status: "ABANDONED",
      secondaries: [{ id: gid(2), name: "#2", items: 1 }],
      involvedOrderIds: [gid(1), gid(2), gid(3)],
    });
    const b = legacyOp({
      status: "COMMITTED",
      primaryOrderId: gid(3),
      primaryOrderName: "#3",
      secondaries: [{ id: gid(4), name: "#4", items: 1 }],
      involvedOrderIds: [gid(3), gid(4)],
    });
    let reads = 0;
    const plans = await planLegacyReconciliation(
      planDeps(new Map(), { onAdminFor: () => reads++ }),
      [a, b],
    );
    expect(reads).toBe(0);
    for (const p of plans) {
      expect(p.verdict.phase).toBe("REVIEW_REQUIRED");
      expect(p.verdict.reason).toBe("overlapping legacy operations");
    }
  });

  it("a PENDING_COMMIT op on a clean primary is still REVIEW_REQUIRED, never ABANDONED", async () => {
    const sec = { id: gid(2), name: "#2", items: 1 };
    const op = legacyOp({
      status: "PENDING_COMMIT",
      createdAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
      updatedAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
      secondaries: [sec],
      involvedOrderIds: [gid(1), gid(2)],
    });
    const orders = new Map([
      [gid(1), evidenceOrder({ lines: [{ id: "li-orig", quantity: 1, variantId: VARIANT }] })],
      [gid(2), evidenceOrder({ lines: [{ id: "li-2", quantity: 1, variantId: VARIANT }] })],
    ]);
    const [plan] = await planLegacyReconciliation(planDeps(orders), [op]);
    expect(plan.verdict.phase).toBe("REVIEW_REQUIRED");
    expect(plan.verdict.reason).toContain("no evidence");
  });

  it("NEEDS_REVIEW converts straight to REVIEW_REQUIRED without reads", async () => {
    const op = legacyOp({
      status: "NEEDS_REVIEW",
      lastError: "v1 flagged",
      secondaries: [{ id: gid(2), name: "#2", items: 1 }],
      involvedOrderIds: [gid(1), gid(2)],
    });
    let reads = 0;
    const [plan] = await planLegacyReconciliation(
      planDeps(new Map(), { onAdminFor: () => reads++ }),
      [op],
    );
    expect(reads).toBe(0);
    expect(plan.verdict.phase).toBe("REVIEW_REQUIRED");
    expect(plan.verdict.reason).toBe("v1 flagged");
    expect(plan.verdict.secondaries[0].cancelPhase).toBe("TRANSFER_PENDING");
  });
});

// ── Driving converted ops never dispatches a fresh orderCancel ───────────────

type Deps = MergeDeps & { ops: MemoryOperationStore };

function driveSetup() {
  const shopify = new FakeShopify([makeOrder(1), makeOrder(2)]);
  const journal = new MemoryJournal();
  const deps = testDeps(journal) as Deps;
  shopify.clock = deps.now;
  return { shopify, deps, ops: deps.ops };
}

/** A converted-legacy-shaped op in the memory store. */
async function convertedOp(
  ctx: ReturnType<typeof driveSetup>,
  verdict: Pick<LegacyVerdict, "phase" | "secondaries" | "appliedEvidence" | "expectedTransfer">,
) {
  const { ops, deps } = ctx;
  await ops.setControl({ newMergesEnabled: true, completionEnabled: true });
  await deps.claims.acquire(SHOP, [gid(1), gid(2)], "claim", deps.leaseTtlMs);
  const rec = await ops.createOperation({
    shop: SHOP,
    claimToken: "claim",
    involvedOrderIds: [gid(1), gid(2)],
    primaryOrderId: gid(1),
    primaryOrderName: "#1",
    customerId: null,
    primaryLineItemCountBefore: 1,
    addedLineItemCount: 1,
    secondaries: [{ id: gid(2), name: "#2", items: 1, cancelPhase: "TRANSFER_PENDING" }],
    opToken: "LEGACYOP",
    calculatedOrderId: null, // the legacy marker
    expectedTransfer: verdict.expectedTransfer,
    expectedLocationId: null,
    primaryLineItemIdsBefore: [],
    leaseToken: "op-lease",
    ttlMs: 60_000,
  });
  // Mutate the STORED row to the converted-legacy shape and drive that —
  // the createOperation clone still says READY.
  const row = ops.ops.get(rec.id)!;
  row.phase = verdict.phase;
  row.secondaries = verdict.secondaries as any;
  row.appliedEvidence = verdict.appliedEvidence;
  if (verdict.phase === "REVIEW_REQUIRED") row.reviewRequiredAt = ops.clock();
  return row;
}

it("driving a CANCEL_REVIEW legacy secondary never dispatches orderCancel", async () => {
  const ctx = driveSetup();
  const { shopify, deps } = ctx;
  const rec = await convertedOp(ctx, {
    phase: "REVIEW_REQUIRED",
    secondaries: [{ id: gid(2), name: "#2", items: 1, cancelPhase: "CANCEL_REVIEW", secondaryIndex: 1 }],
    appliedEvidence: null,
    expectedTransfer: [],
  });
  const op = await driveOperation(rec, shopify.admin, deps);
  expect(op?.phase).toBe("REVIEW_REQUIRED");
  expect(shopify.mutationCalls("MergeCancelSecondary")).toBe(0);
});

it("driving a CANCEL_IN_DOUBT legacy secondary never dispatches a new orderCancel", async () => {
  const ctx = driveSetup();
  const { shopify, deps, ops } = ctx;
  const rec = await convertedOp(ctx, {
    phase: "APPLIED",
    secondaries: [{ id: gid(2), name: "#2", items: 1, cancelPhase: "CANCEL_IN_DOUBT", secondaryIndex: 1 }],
    appliedEvidence: {
      agreementId: "gid://shopify/OrderEditAgreement/0",
      happenedAt: deps.now().toISOString(),
      lines: [{ secondaryId: gid(2), lineItemId: "li-token", variantId: VARIANT, quantity: 1 }],
    },
    expectedTransfer: [
      {
        secondaryId: gid(2),
        secondaryIndex: 1,
        lines: [{ sourceLineItemId: null, variantId: VARIANT, quantity: 1, sourceQuantity: null, description: "x" }],
      },
    ],
  });
  // The synthetic UNKNOWN attempt the importer wrote (cancelRequestedAt).
  ops.attempts.push({
    id: "att-legacy",
    operationId: rec.id,
    kind: "ORDER_CANCEL",
    targetOrderId: gid(2),
    attemptNo: 1,
    state: "UNKNOWN",
    dispatchToken: `legacy-${rec.id}`,
    dispatchedAt: new Date(deps.now().getTime() - 2 * 60 * 60_000), // ladder long past
    respondedAt: new Date(deps.now().getTime() - 2 * 60 * 60_000),
    responseSummary: "synthetic: cancelRequestedAt was set before cutover",
    jobId: null,
  });
  await driveOperation(rec, shopify.admin, deps);
  // The doubt is reconciled by reading, never by re-dispatching: the stale
  // ladder parks the secondary at CANCEL_REVIEW + REVIEW_REQUIRED.
  expect(shopify.mutationCalls("MergeCancelSecondary")).toBe(0);
  const stored = await ops.getOperation(rec.id);
  expect(stored?.phase).toBe("REVIEW_REQUIRED");
  expect(stored?.secondaries[0]?.cancelPhase).toBe("CANCEL_REVIEW");
});
