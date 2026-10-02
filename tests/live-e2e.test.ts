// Opt-in live check against a real dev store through the Shopify CLI:
//   MERGESHIP_LIVE_STORE=ordermergetest.myshopify.com \
//   MERGESHIP_LIVE_VARIANT=gid://shopify/ProductVariant/... \
//   MERGESHIP_LIVE_CUSTOMER=gid://shopify/Customer/... \
//   npx vitest run tests/live-e2e.test.ts
//
// Creates two fresh test orders, runs the real executeMerge against Shopify,
// and verifies the result. Orders are created unpaid and then marked paid so
// the production orders/create webhook (which skips unpaid orders) cannot race
// the test. The single-location check is overridden because the dev stores
// have several locations — everything else is the production code path.

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultMergeDeps, executeMerge } from "../app/lib/merge.server";
import { MemoryJournal } from "./fake-shopify";

const STORE = process.env.MERGESHIP_LIVE_STORE;
const VARIANT = process.env.MERGESHIP_LIVE_VARIANT;
const CUSTOMER = process.env.MERGESHIP_LIVE_CUSTOMER;
const VERSION = process.env.MERGESHIP_LIVE_API_VERSION ?? "2025-10";

const dir = mkdtempSync(join(tmpdir(), "mergeship-live-"));
let seq = 0;

/** Admin client that runs each operation with `shopify app execute`. */
const cliAdmin = {
  graphql: async (query: string, options?: { variables?: Record<string, unknown> }) => {
    const n = seq++;
    const q = join(dir, `${n}.graphql`);
    const v = join(dir, `${n}.json`);
    const out = join(dir, `${n}.out.json`);
    writeFileSync(q, query.replace(/^\s*#graphql/, ""));
    writeFileSync(v, JSON.stringify(options?.variables ?? {}));
    if (/query\s+MergeLocationCount/.test(query)) {
      return new Response(JSON.stringify({ data: { locationsCount: { count: 1 } } }));
    }
    // Async so the test worker's event loop is not blocked between CLI calls.
    const { stdout } = await promisify(exec)(
      `npx shopify app execute --store ${STORE} --version ${VERSION} --query-file "${q}" --variable-file "${v}" --output-file "${out}"`,
      { encoding: "utf8" },
    );
    if (/operation failed/i.test(stdout)) {
      return new Response(JSON.stringify({ errors: [{ message: stdout.replace(/[│╭╮╰╯─]/g, "").trim() }] }));
    }
    return new Response(JSON.stringify({ data: JSON.parse(readFileSync(out, "utf8")) }));
  },
};

async function run(query: string, variables: Record<string, unknown> = {}) {
  const body = await (await cliAdmin.graphql(query, { variables })).json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

const address = {
  firstName: "Merge",
  lastName: "Tester",
  address1: "1 Test Street",
  city: "Ottawa",
  provinceCode: "ON",
  zip: "K2P2L8",
  countryCode: "CA",
};

async function createPaidOrder(label: string) {
  const created = await run(
    `mutation LiveOrderCreate($order: OrderCreateOrderInput!) {
      orderCreate(order: $order, options: { sendReceipt: false, sendFulfillmentReceipt: false }) {
        order { id name }
        userErrors { field message }
      }
    }`,
    {
      order: {
        customerId: CUSTOMER,
        currency: "USD",
        financialStatus: "PENDING",
        // orderCreate defaults requiresShipping to false; checkout orders set it.
        lineItems: [{ variantId: VARIANT, quantity: 1, requiresShipping: true }],
        shippingAddress: address,
        billingAddress: address,
        shippingLines: [{ title: "Standard", priceSet: { shopMoney: { amount: "5.00", currencyCode: "USD" } } }],
        tags: ["mergeship-live-test"],
        note: `live e2e ${label}`,
      },
    },
  );
  const { order, userErrors } = created.orderCreate;
  if (userErrors.length) throw new Error(JSON.stringify(userErrors));
  const paid = await run(
    `mutation LiveMarkPaid($input: OrderMarkAsPaidInput!) {
      orderMarkAsPaid(input: $input) { order { id displayFinancialStatus } userErrors { message } }
    }`,
    { input: { id: order.id } },
  );
  if (paid.orderMarkAsPaid.userErrors.length) throw new Error(JSON.stringify(paid.orderMarkAsPaid.userErrors));
  return order as { id: string; name: string };
}

describe.skipIf(!STORE || !VARIANT || !CUSTOMER)("live end-to-end merge", () => {
  it(
    "merges two real orders, confirms the async cancellation and keeps a stable line-item fingerprint",
    async () => {
      const a = await createPaidOrder("A");
      const b = await createPaidOrder("B");

      const journal = new MemoryJournal();
      const result = await executeMerge(cliAdmin, STORE!, [b.id, a.id], {
        ...defaultMergeDeps(),
        journal,
        cancelPollAttempts: 10,
        cancelPollIntervalMs: 3000,
      });
      console.log("live result", result, [...journal.ops.values()]);
      expect(result.outcome).toBe("merged");

      const after = await run(
        `query LiveVerify($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Order {
              name cancelledAt closed tags note displayFinancialStatus
              lineItems(first: 20) { nodes { name currentQuantity } }
            }
          }
        }`,
        { ids: [a.id, b.id] },
      );
      const [primary, secondary] = after.nodes;
      console.log(JSON.stringify(after, null, 2));

      // Fingerprint assumption used by commit reconciliation: one new line item per transferred item.
      const op = journal.only();
      expect(primary.lineItems.nodes).toHaveLength(op.primaryLineItemCountBefore + op.addedLineItemCount);
      expect(primary.cancelledAt).toBeNull();
      expect(primary.tags).toContain("Consolidated");
      expect(primary.note).toContain("Note from");
      expect(secondary.cancelledAt).not.toBeNull();
      expect(secondary.tags).toContain("Merged");
      expect(journal.history).toHaveLength(1);

      // Clean up: cancel the test primary too (restock, no refund).
      await run(
        `mutation LiveCleanup($id: ID!) {
          orderCancel(orderId: $id, reason: OTHER, notifyCustomer: false, restock: true, refundMethod: { originalPaymentMethodsRefund: false }, staffNote: "MergeShip live test cleanup") {
            orderCancelUserErrors { message }
          }
        }`,
        { id: a.id },
      );
    },
    10 * 60 * 1000,
  );
});
