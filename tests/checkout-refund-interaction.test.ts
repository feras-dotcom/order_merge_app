// Checkout-discount × shipping-refund interaction (release-readiness):
// when an order's shipping was discounted at checkout by the MergeShip
// shipping-discount Function, the EXISTING refund engine must plan at most
// the shipping the customer actually PAID — never the pre-discount price.
//
// Provenance: tests/fixtures/refund-interaction-{1001,1002,1038}.json were
// captured READ-ONLY on 2026-11-15 from the isolated dev store
// ms-checkout-spike-1111.myshopify.com via the engine's exact
// ShippingShadowSource selection (app/lib/shipping-shadow.server.ts) plus
// shippingLines.discountAllocations. Amounts/currency/titles/ids only — no
// customer data. The live orders were never merged, so the evaluator's
// post-merge state gates (cancelledAt/closed/closedAt) are pinned in-test;
// every financial, shipping-line and transaction field is the real
// captured value.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateShadowSource,
  readOnlyAdmin,
} from "../app/lib/shipping-shadow.server";
import type { AdminClient } from "../app/lib/graphql.server";

const fixture = (n: number): any =>
  JSON.parse(
    readFileSync(
      join(__dirname, "fixtures", `refund-interaction-${n}.json`),
      "utf8",
    ),
  ).order;

const MONEY = (amount: string, currencyCode = "USD") => ({ amount, currencyCode });

/** The evaluator requires the cancelled+closed secondary shape (a post-merge
 *  state gate, independent of the refund arithmetic). The live spike orders
 *  are open and unmerged — pin ONLY those three flags; everything else is
 *  the real captured response. */
const asMergedSecondary = (order: any): any => ({
  ...order,
  cancelledAt: order.cancelledAt ?? "2026-11-15T00:00:00Z",
  closed: true,
  closedAt: order.closedAt ?? "2026-11-15T00:01:00Z",
});

/** Shopify's suggestedRefund answer for a shippingAmount request: the real
 *  store echoes the requested amount as shipping.amountSet, zero tax, and
 *  offers a single SUGGESTED_REFUND parented to the captured transaction —
 *  same shape as the engine-verified preview in shipping-shadow.test.ts. */
const previewFor = (order: any, shippingAmount: string) => {
  const capture = order.transactions.find(
    (t: any) => t.kind === "CAPTURE" && t.status === "SUCCESS",
  );
  const money = { presentmentMoney: MONEY(shippingAmount, order.currencyCode) };
  return {
    suggestedRefund: {
      amountSet: money,
      maximumRefundableSet: capture.amountSet,
      shipping: {
        amountSet: money,
        taxSet: {
          presentmentMoney: MONEY("0.0", order.currencyCode),
        },
        maximumRefundableSet:
          order.shippingLines.nodes[0].discountedPriceSet,
      },
      suggestedTransactions: [
        {
          kind: "SUGGESTED_REFUND",
          gateway: capture.gateway,
          amountSet: money,
          parentTransaction: {
            id: capture.id,
            kind: capture.kind,
            status: capture.status,
            gateway: capture.gateway,
            test: capture.test,
          },
        },
      ],
    },
  };
};

/** Same fake-admin pattern as tests/shipping-shadow.test.ts: route on the
 *  document content, record every call + variables. Wrapped in the engine's
 *  own readOnlyAdmin guard so any mutation document would throw. */
const fixtureAdmin = (order: any) => {
  const calls: { query: string; variables: any }[] = [];
  const inner = {
    calls,
    graphql: async (query: string, options?: { variables?: any }) => {
      calls.push({ query, variables: options?.variables });
      const isPreview = query.includes("suggestedRefund");
      return {
        json: async () => ({
          data: {
            order: isPreview
              ? previewFor(order, options?.variables?.shippingAmount)
              : order,
          },
        }),
      } as any;
    },
  };
  return { admin: readOnlyAdmin(inner as AdminClient), calls };
};

const evaluate = async (order: any) => {
  const { admin, calls } = fixtureAdmin(order);
  const outcome = await evaluateShadowSource(admin, {
    sourceOrderId: order.id,
    policy: { kind: "REFUND_ALL" },
    marker: "MS-RX-TEST",
    primaryOrderName: "#9999",
  });
  return { outcome, calls };
};

describe("shipping-refund engine vs checkout-discounted shipping (live-captured)", () => {
  it("#1001 paid 0.00 of original 8.00: the evaluator SKIPs — never a positive refund", async () => {
    const order = asMergedSecondary(fixture(1001));
    const { outcome, calls } = await evaluate(order);
    expect(outcome).toMatchObject({ kind: "SKIP", reasonCode: "NOTHING_REFUNDABLE" });
    // The skip happens before any refund preview — Shopify is never asked.
    expect(calls.every((c) => !c.query.includes("suggestedRefund"))).toBe(true);
  });

  it("#1002 paid 4.00 of original 8.00: planned refund is exactly 4.00, never 8.00", async () => {
    const order = asMergedSecondary(fixture(1002));
    const { outcome, calls } = await evaluate(order);
    if (outcome.kind !== "READY") throw new Error(`expected READY, got ${JSON.stringify(outcome)}`);
    // The planned amount is the discounted (paid) price in minor units.
    expect(outcome.sourceShippingMinor).toBe("400");
    expect(outcome.plannedRefundMinor).toBe("400");
    // And that is what would be sent to refundCreate — 4.00, never 8.00.
    const payload = outcome.requestPayload as any;
    expect(payload.shipping.amount).toBe("4.00");
    expect(payload.transactions[0].amount).toBe("4.00");
    // Shopify was asked to preview exactly the paid amount.
    const preview = calls.find((c) => c.query.includes("suggestedRefund"));
    expect(preview?.variables?.shippingAmount).toBe("4.00");
  });

  it("#1038 undiscounted control: planned refund is the full 8.00", async () => {
    const order = asMergedSecondary(fixture(1038));
    const { outcome } = await evaluate(order);
    if (outcome.kind !== "READY") throw new Error(`expected READY, got ${JSON.stringify(outcome)}`);
    expect(outcome.sourceShippingMinor).toBe("800");
    expect(outcome.plannedRefundMinor).toBe("800");
  });

  it("discrimination: originalPriceSet (8.00) would overstate #1002 to 800 minor", async () => {
    const node = fixture(1002).shippingLines.nodes[0];
    // The fixture really has the two prices diverging, so this test can
    // never pass vacuously.
    expect(node.originalPriceSet.presentmentMoney.amount).toBe("8.0");
    expect(node.discountedPriceSet.presentmentMoney.amount).toBe("4.0");
    const order = asMergedSecondary(fixture(1002));
    const { outcome } = await evaluate(order);
    if (outcome.kind !== "READY") throw new Error(`expected READY, got ${JSON.stringify(outcome)}`);
    // If the engine ever summed originalPriceSet, desired/preview/plan
    // would all be 800 — these would fail loudly.
    expect(outcome.sourceShippingMinor).not.toBe("800");
    expect(outcome.plannedRefundMinor).not.toBe("800");
  });

  it("discount allocation/title fields in the fixture do not change the planned amount", async () => {
    const order = asMergedSecondary(fixture(1002));
    const { outcome: withAlloc } = await evaluate(order);
    const stripped = asMergedSecondary(fixture(1002));
    for (const l of stripped.shippingLines.nodes) delete l.discountAllocations;
    const { outcome: withoutAlloc } = await evaluate(stripped);
    expect(withoutAlloc).toEqual(withAlloc);
    if (withoutAlloc.kind !== "READY") throw new Error("expected READY");
    expect(withoutAlloc.plannedRefundMinor).toBe("400");
  });
});
