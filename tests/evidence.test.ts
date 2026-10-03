// Unit tests for verifyTransferEvidence (spec §6, corrections B3): complete
// pagination of line items and agreements, sale attribution/quantity/action
// checks, and every fail-closed ANOMALY path. Plus the resolveAppId
// rejected-promise eviction (B2).

import { describe, expect, it } from "vitest";
import {
  resolveAppId,
  transferredLinesMismatch,
  verifyTransferEvidence,
} from "../app/lib/evidence.server";
import type { OperationRecord } from "../app/lib/operation-store.server";
import {
  APP_ID,
  FakeShopify,
  makeLineItem,
  makeOrder,
  OTHER_APP_ID,
  topLevelError,
} from "./fake-shopify";

const id = (n: number) => `gid://shopify/Order/${n}`;
const VARIANT = "gid://shopify/ProductVariant/1";

const opFor = (beforeIds: string[], quantity = 1): OperationRecord =>
  ({
    expectedTransfer: [
      {
        secondaryId: id(2),
        secondaryIndex: 1,
        lines: [
          {
            sourceLineItemId: null,
            variantId: VARIANT,
            quantity,
            sourceQuantity: null,
            description: "x",
          },
        ],
      },
    ],
    primaryLineItemIdsBefore: beforeIds,
    firstDispatchAt: new Date(Date.now() - 60_000),
    primaryOrderId: id(1),
    opToken: "TESTTEST",
  }) as unknown as OperationRecord;

/** A primary holding one MergeShip-applied token line of `quantity` units. */
async function appliedPrimary(quantity = 1) {
  const shopify = new FakeShopify([makeOrder(1), makeOrder(2)]);
  const beforeIds = shopify.order(1).lineItems.map((i) => i.id!);
  const calcId = shopify.stageEdit(id(1), [
    {
      variantId: VARIANT,
      quantity,
      description: "Merged from #2, already paid · MS-TESTTEST-1",
    },
  ]);
  shopify.applyCommit(calcId);
  return {
    shopify,
    tokenLine: shopify.order(1).lineItems.at(-1)!,
    agreement: shopify.order(1).agreements!.at(-1)!,
    op: opFor(beforeIds, quantity),
  };
}

describe("verifyTransferEvidence", () => {
  it("APPLIED on a clean transfer, with the recheck's fresh state", async () => {
    const { shopify, tokenLine, op } = await appliedPrimary();
    const ev = await verifyTransferEvidence(shopify.admin, op, APP_ID);
    expect(ev.kind).toBe("APPLIED");
    if (ev.kind !== "APPLIED") return;
    expect(ev.recheck.primary.id).toBe(id(1));
    expect(ev.recheck.lines).toHaveLength(1);
    expect(ev.recheck.lines[0]).toMatchObject({
      id: tokenLine.id,
      variantId: VARIANT,
      quantity: 1,
      currentQuantity: 1,
      unfulfilledQuantity: 1,
    });
    expect(shopify.mutationCalls("MergeTransferRecheck")).toBe(1);
  });

  for (const [label, saleQty] of [
    ["zero", 0],
    ["partial", 1],
    ["excess", 3],
  ] as const) {
    it(`sale quantity ${label} → ANOMALY`, async () => {
      const { shopify, tokenLine, agreement, op } = await appliedPrimary(2);
      shopify.setSaleQuantity(id(1), agreement.id, tokenLine.id!, saleQty);
      const ev = await verifyTransferEvidence(shopify.admin, op, APP_ID);
      expect(ev.kind).toBe("ANOMALY");
    });
  }

  it("token line currentQuantity reduced → ANOMALY", async () => {
    const { shopify, tokenLine, op } = await appliedPrimary();
    tokenLine.currentQuantity = tokenLine.quantity - 1; // edited after the merge
    const ev = await verifyTransferEvidence(shopify.admin, op, APP_ID);
    expect(ev).toMatchObject({ kind: "ANOMALY" });
  });

  it("a sale attributed to a different app → ANOMALY", async () => {
    const { shopify, agreement, op } = await appliedPrimary();
    agreement.app = { id: OTHER_APP_ID };
    const ev = await verifyTransferEvidence(shopify.admin, op, APP_ID);
    expect(ev).toMatchObject({ kind: "ANOMALY" });
  });

  it("two MergeShip agreements covering the same line → ANOMALY", async () => {
    const { shopify, tokenLine, agreement, op } = await appliedPrimary();
    shopify.order(1).agreements!.push({
      __typename: "OrderEditAgreement",
      id: "gid://shopify/OrderEditAgreement/second",
      happenedAt: agreement.happenedAt,
      app: { id: APP_ID },
      sales: {
        nodes: [
          { __typename: "ProductSale", quantity: 1, actionType: "ORDER", lineItem: { id: tokenLine.id } },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    const ev = await verifyTransferEvidence(shopify.admin, op, APP_ID);
    expect(ev).toMatchObject({ kind: "ANOMALY" });
  });

  it("a MergeShip agreement with truncated sales → ANOMALY (fail closed)", async () => {
    const { shopify, agreement, op } = await appliedPrimary();
    agreement.sales.pageInfo = { hasNextPage: true };
    const ev = await verifyTransferEvidence(shopify.admin, op, APP_ID);
    expect(ev).toMatchObject({ kind: "ANOMALY" });
  });

  it("the primary order missing → ANOMALY, not a transient throw", async () => {
    const { shopify, op } = await appliedPrimary();
    shopify.orders.delete(id(1));
    const ev = await verifyTransferEvidence(shopify.admin, op, APP_ID);
    expect(ev).toMatchObject({ kind: "ANOMALY" });
  });

  it("paginates 150 line items and 60 agreements to completion → APPLIED", async () => {
    const lines = Array.from({ length: 149 }, () => makeLineItem());
    const shopify = new FakeShopify([makeOrder(1, { lineItems: lines }), makeOrder(2)]);
    for (let i = 0; i < 59; i++) {
      shopify.order(1).agreements!.push({
        __typename: "OrderEditAgreement",
        id: `gid://shopify/OrderEditAgreement/other-${i}`,
        happenedAt: shopify.clock().toISOString(),
        app: { id: OTHER_APP_ID },
        sales: { nodes: [], pageInfo: { hasNextPage: false } },
      });
    }
    shopify.evidencePageSize = 25; // 6 line-item pages, 3 agreement pages
    const beforeIds = shopify.order(1).lineItems.map((i) => i.id!);
    const calcId = shopify.stageEdit(id(1), [
      {
        variantId: VARIANT,
        quantity: 1,
        description: "Merged from #2, already paid · MS-TESTTEST-1",
      },
    ]);
    shopify.applyCommit(calcId);
    const ev = await verifyTransferEvidence(shopify.admin, opFor(beforeIds), APP_ID);
    expect(ev.kind).toBe("APPLIED");
    expect(shopify.mutationCalls("MergeOrderEvidenceLines")).toBe(6);
    expect(shopify.mutationCalls("MergeOrderEvidenceAgreements")).toBe(3);
    expect(shopify.mutationCalls("MergeTransferRecheck")).toBe(1);
  });

  it("paginates each connection independently (many lines, one agreements page)", async () => {
    const lines = Array.from({ length: 50 }, () => makeLineItem());
    const shopify = new FakeShopify([makeOrder(1, { lineItems: lines }), makeOrder(2)]);
    shopify.evidencePageSize = 25; // 51 lines → 3 pages; 1 agreement → 1 page
    const beforeIds = shopify.order(1).lineItems.map((i) => i.id!);
    const calcId = shopify.stageEdit(id(1), [
      {
        variantId: VARIANT,
        quantity: 1,
        description: "Merged from #2, already paid · MS-TESTTEST-1",
      },
    ]);
    shopify.applyCommit(calcId);
    const ev = await verifyTransferEvidence(shopify.admin, opFor(beforeIds), APP_ID);
    expect(ev.kind).toBe("APPLIED");
    // A finished connection must not restart at cursor null: exactly 3
    // line-item calls (no extra restart) and exactly 1 agreements call.
    expect(shopify.mutationCalls("MergeOrderEvidenceLines")).toBe(3);
    expect(shopify.mutationCalls("MergeOrderEvidenceAgreements")).toBe(1);
    expect(shopify.mutationCalls("MergeTransferRecheck")).toBe(1);
  });

  it("paginates each connection independently (one lines page, many agreements)", async () => {
    const shopify = new FakeShopify([makeOrder(1), makeOrder(2)]);
    for (let i = 0; i < 59; i++) {
      shopify.order(1).agreements!.push({
        __typename: "OrderEditAgreement",
        id: `gid://shopify/OrderEditAgreement/other-${i}`,
        happenedAt: shopify.clock().toISOString(),
        app: { id: OTHER_APP_ID },
        sales: { nodes: [], pageInfo: { hasNextPage: false } },
      });
    }
    shopify.evidencePageSize = 25; // 2 lines → 1 page; 60 agreements → 3 pages
    const beforeIds = shopify.order(1).lineItems.map((i) => i.id!);
    const calcId = shopify.stageEdit(id(1), [
      {
        variantId: VARIANT,
        quantity: 1,
        description: "Merged from #2, already paid · MS-TESTTEST-1",
      },
    ]);
    shopify.applyCommit(calcId);
    const ev = await verifyTransferEvidence(shopify.admin, opFor(beforeIds), APP_ID);
    expect(ev.kind).toBe("APPLIED");
    expect(shopify.mutationCalls("MergeOrderEvidenceLines")).toBe(1);
    expect(shopify.mutationCalls("MergeOrderEvidenceAgreements")).toBe(3);
    expect(shopify.mutationCalls("MergeTransferRecheck")).toBe(1);
  });

  it("a page with no pageInfo → ANOMALY, not 'complete'", async () => {
    const { shopify, op } = await appliedPrimary();
    shopify.on("MergeOrderEvidenceLines", () => ({
      data: {
        order: { lineItems: { nodes: structuredClone(shopify.order(1).lineItems) } },
      },
    }));
    const ev = await verifyTransferEvidence(shopify.admin, op, APP_ID);
    expect(ev).toMatchObject({ kind: "ANOMALY" });
  });

  it("hasNextPage with a null endCursor → ANOMALY", async () => {
    const { shopify, op } = await appliedPrimary();
    shopify.on("MergeOrderEvidenceLines", () => ({
      data: {
        order: {
          lineItems: {
            nodes: [structuredClone(shopify.order(1).lineItems[0])],
            pageInfo: { hasNextPage: true, endCursor: null },
          },
        },
      },
    }));
    const ev = await verifyTransferEvidence(shopify.admin, op, APP_ID);
    expect(ev).toMatchObject({ kind: "ANOMALY" });
  });

  it("a cursor that does not progress → ANOMALY", async () => {
    const { shopify, op } = await appliedPrimary();
    // Every page serves the same endCursor — the second page repeats a
    // cursor that was already consumed.
    shopify.on("MergeOrderEvidenceLines", () => ({
      data: {
        order: {
          lineItems: {
            nodes: [structuredClone(shopify.order(1).lineItems[0])],
            pageInfo: { hasNextPage: true, endCursor: "cursor-same" },
          },
        },
      },
    }));
    const ev = await verifyTransferEvidence(shopify.admin, op, APP_ID);
    expect(ev).toMatchObject({ kind: "ANOMALY" });
    expect(shopify.mutationCalls("MergeOrderEvidenceLines")).toBe(2);
  });

  it("hasNextPage on an empty page → ANOMALY", async () => {
    const { shopify, op } = await appliedPrimary();
    shopify.on("MergeOrderEvidenceAgreements", () => ({
      data: {
        order: {
          agreements: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "cursor-0" } },
        },
      },
    }));
    const ev = await verifyTransferEvidence(shopify.admin, op, APP_ID);
    expect(ev).toMatchObject({ kind: "ANOMALY" });
  });

  it("a MergeShip agreement whose sales have no pageInfo → ANOMALY", async () => {
    const { shopify, agreement, op } = await appliedPrimary();
    delete (agreement.sales as any).pageInfo;
    const ev = await verifyTransferEvidence(shopify.admin, op, APP_ID);
    expect(ev).toMatchObject({ kind: "ANOMALY" });
  });

  it("a token line removed between the scan and the recheck → ANOMALY", async () => {
    const { shopify, tokenLine, op } = await appliedPrimary();
    shopify.on("MergeTransferRecheck", () => {
      shopify.removeLine(id(1), tokenLine.id!);
      return undefined; // the default handler serves the post-mutation state
    });
    const ev = await verifyTransferEvidence(shopify.admin, op, APP_ID);
    expect(ev).toMatchObject({ kind: "ANOMALY" });
  });

  it("a token line emptied between the scan and the recheck → ANOMALY", async () => {
    const { shopify, tokenLine, op } = await appliedPrimary();
    shopify.on("MergeTransferRecheck", () => {
      tokenLine.currentQuantity = 0;
      return undefined;
    });
    const ev = await verifyTransferEvidence(shopify.admin, op, APP_ID);
    expect(ev).toMatchObject({ kind: "ANOMALY" });
  });

  it("a token line re-varied between the scan and the recheck → ANOMALY", async () => {
    const { shopify, tokenLine, op } = await appliedPrimary();
    shopify.on("MergeTransferRecheck", () => {
      shopify.setLineVariant(id(1), tokenLine.id!, "gid://shopify/ProductVariant/99");
      return undefined;
    });
    const ev = await verifyTransferEvidence(shopify.admin, op, APP_ID);
    expect(ev).toMatchObject({ kind: "ANOMALY" });
  });

  it("the primary unreadable at recheck → ANOMALY", async () => {
    const { shopify, op } = await appliedPrimary();
    shopify.on("MergeTransferRecheck", () => {
      shopify.orders.delete(id(1));
      return undefined;
    });
    const ev = await verifyTransferEvidence(shopify.admin, op, APP_ID);
    expect(ev).toMatchObject({ kind: "ANOMALY" });
  });
});

describe("resolveAppId", () => {
  it("evicts a rejected lookup so the next call retries (2 calls, then cached)", async () => {
    const shopify = new FakeShopify([makeOrder(1)]);
    shopify.on("MergeCurrentApp", (_v, call) => (call === 1 ? topLevelError("down") : undefined));
    await expect(resolveAppId(shopify.admin, "retry-shop.myshopify.com")).rejects.toThrow();
    await expect(resolveAppId(shopify.admin, "retry-shop.myshopify.com")).resolves.toBe(APP_ID);
    await expect(resolveAppId(shopify.admin, "retry-shop.myshopify.com")).resolves.toBe(APP_ID);
    expect(shopify.mutationCalls("MergeCurrentApp")).toBe(2); // cached after the good call
  });
});

describe("transferredLinesMismatch (the cancel snapshot's transferred-line proof)", () => {
  const S2 = id(2);
  const S3 = id(3);
  const stored = [
    { secondaryId: S2, lineItemId: "li-t1", variantId: VARIANT, quantity: 1 },
    { secondaryId: S3, lineItemId: "li-t2", variantId: VARIANT, quantity: 2 },
  ];
  const expected = [
    { secondaryId: S2, secondaryIndex: 1, lines: [] },
    { secondaryId: S3, secondaryIndex: 2, lines: [] },
  ];
  const node = (overrides: Record<string, unknown> = {}): any => ({
    __typename: "LineItem",
    id: "li-t1",
    quantity: 1,
    currentQuantity: 1,
    unfulfilledQuantity: 1,
    variant: { id: VARIANT },
    originalUnitPriceSet: { shopMoney: { amount: "10.00" } },
    discountAllocations: [
      {
        allocatedAmountSet: { shopMoney: { amount: "10.00" } },
        discountApplication: {
          __typename: "ManualDiscountApplication",
          title: "Merged from #2, already paid",
          description: "Merged from #2, already paid · MS-TESTTEST-1",
        },
      },
    ],
    ...overrides,
  });
  const nodes = () => [
    node(),
    node({
      id: "li-t2",
      quantity: 2,
      currentQuantity: 2,
      unfulfilledQuantity: 2,
      originalUnitPriceSet: { shopMoney: { amount: "10.00" } },
      discountAllocations: [
        {
          allocatedAmountSet: { shopMoney: { amount: "20.00" } },
          discountApplication: {
            __typename: "ManualDiscountApplication",
            title: "Merged from #3, already paid",
            description: "Merged from #3, already paid · MS-TESTTEST-2",
          },
        },
      ],
    }),
  ];
  const check = (transferred: (any | null)[], forSecondaryId = S2) =>
    transferredLinesMismatch(stored, expected as any, transferred, "TESTTEST", forSecondaryId);

  it("intact lines → null", () => {
    expect(check(nodes())).toBeNull();
  });
  it("a missing node → reason naming the line", () => {
    expect(check([nodes()[1]])).toContain("li-t1");
  });
  it("a null node → reason naming the line", () => {
    expect(check([null, nodes()[1]])).toContain("li-t1");
  });
  it("a wrong variant → reason", () => {
    expect(
      check([node({ variant: { id: "gid://shopify/ProductVariant/9" } }), nodes()[1]]),
    ).toContain("li-t1");
  });
  it("a changed quantity → reason", () => {
    expect(check([node({ quantity: 3 }), nodes()[1]])).toContain("li-t1");
  });
  it("currentQuantity below quantity → reason", () => {
    expect(check([node({ currentQuantity: 0 }), nodes()[1]])).toContain("li-t1");
  });
  it("the wrong token index → reason", () => {
    const n = node();
    n.discountAllocations[0].discountApplication.description =
      "Merged from #2, already paid · MS-TESTTEST-9";
    expect(check([n, nodes()[1]])).toContain("li-t1");
  });
  it("a stripped discount → reason", () => {
    expect(check([node({ discountAllocations: [] }), nodes()[1]])).toContain("li-t1");
  });
  it("an extra non-null node → reason", () => {
    expect(check([...nodes(), node({ id: "li-extra" })])).not.toBeNull();
  });
  it("an unfulfilled line of THIS secondary → reason; of another → null", () => {
    // Own line partially fulfilled — the merchandise cannot be "put back".
    expect(check([node({ unfulfilledQuantity: 0 }), nodes()[1]])).toContain("li-t1");
    // The OTHER secondary's line may be fulfilled without blocking this one.
    expect(check([nodes()[0], node({ id: "li-t2", quantity: 2, currentQuantity: 2, unfulfilledQuantity: 0,
      discountAllocations: [
        {
          allocatedAmountSet: { shopMoney: { amount: "20.00" } },
          discountApplication: {
            __typename: "ManualDiscountApplication",
            title: "Merged from #3, already paid",
            description: "Merged from #3, already paid · MS-TESTTEST-2",
          },
        },
      ] })], S2)).toBeNull();
  });
});
