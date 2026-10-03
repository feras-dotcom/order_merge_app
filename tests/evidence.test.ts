// Unit tests for verifyTransferEvidence (spec §6, corrections B3): complete
// pagination of line items and agreements, sale attribution/quantity/action
// checks, and every fail-closed ANOMALY path. Plus the resolveAppId
// rejected-promise eviction (B2).

import { describe, expect, it } from "vitest";
import { resolveAppId, verifyTransferEvidence } from "../app/lib/evidence.server";
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
        lines: [{ sourceLineItemId: null, variantId: VARIANT, quantity, description: "x" }],
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
  it("APPLIED on a clean transfer", async () => {
    const { shopify, op } = await appliedPrimary();
    const ev = await verifyTransferEvidence(shopify.admin, op, APP_ID);
    expect(ev.kind).toBe("APPLIED");
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
    expect(shopify.mutationCalls("MergeOrderEvidence")).toBeGreaterThan(3);
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
