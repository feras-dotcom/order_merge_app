// Opt-in LIVE experiment (spec §10): probe Shopify's real behaviour when two
// order-edit calculations are opened concurrently on the same order and then
// committed. No merge logic is exercised — the findings inform the merge
// engine's expectations; nothing in the claims/lease design depends on them.
//
//   MERGESHIP_LIVE_STORE=<store>.myshopify.com \
//   MERGESHIP_LIVE_VARIANT=gid://shopify/ProductVariant/<id> \
//   MERGESHIP_LIVE_CUSTOMER=gid://shopify/Customer/<id> \
//   MERGESHIP_LIVE_VARIANT2=gid://shopify/ProductVariant/<id> \   (optional,
//     distinct item for cases 1/3; falls back to VARIANT) \
//   npx vitest run tests/live-concurrent-edit.test.ts
//
// Every created order is cancelled (restock, no refund) at the end of its case.

import { exec } from "child_process";
import { promisify } from "util";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const execAsync = promisify(exec);

const STORE = process.env.MERGESHIP_LIVE_STORE;
const VARIANT = process.env.MERGESHIP_LIVE_VARIANT;
const CUSTOMER = process.env.MERGESHIP_LIVE_CUSTOMER;
const VARIANT2 = process.env.MERGESHIP_LIVE_VARIANT2 ?? VARIANT;
const API_VERSION = "2025-10";

const RUN = Boolean(STORE && VARIANT && CUSTOMER);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs a GraphQL op via `shopify app execute`; returns the parsed body. */
const cliAdmin = async (query: string, variables?: Record<string, any>): Promise<any> => {
  const file = join(tmpdir(), `mergeship-live-${process.pid}.graphql`);
  writeFileSync(file, query);
  let varArg = "";
  if (variables) {
    const variablesFile = join(tmpdir(), `mergeship-live-${process.pid}.variables.json`);
    writeFileSync(variablesFile, JSON.stringify(variables));
    varArg = ` --variable-file ${variablesFile}`;
  }
  const cmd = `shopify app execute --store ${STORE} --version ${API_VERSION} --query-file ${file}${varArg}`;
  const cwd = dirname(fileURLToPath(import.meta.url));
  let lastErr: unknown = new Error("no attempts made");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { stdout } = await execAsync(cmd, { cwd });
      const out = stdout.trim();
      if (out) return JSON.parse(out);
      lastErr = new Error("shopify CLI returned empty output");
    } catch (e) {
      lastErr = e; // transient token/network flakes — retry
    }
    await sleep(3000);
  }
  throw lastErr;
};

/** admin() throws on transport/query errors but returns mutation userErrors. */
const admin = async (query: string, variables?: Record<string, any>): Promise<any> => {
  const body = await cliAdmin(query, variables);
  // `app execute` prints the data payload directly; keep a fallback in case
  // it ever returns the full GraphQL envelope.
  const data = body.data ?? body;
  if (body.errors?.length) throw new Error(JSON.stringify(body.errors));
  if (data == null) throw new Error(`no data: ${JSON.stringify(body).slice(0, 400)}`);
  return data;
};

// -- order setup -------------------------------------------------------------
// draftOrderCreate needs write_draft_orders, which this app does not request;
// orderCreate only needs the already-granted write_orders scope.

const createPaidOrder = async (variantId: string): Promise<{ orderId: string; name: string }> => {
  const created = await admin(
    `mutation ($customerId: ID!, $variantId: ID!) {
      orderCreate(
        order: {
          lineItems: [{ variantId: $variantId, quantity: 1 }],
          financialStatus: PAID,
          customer: { toAssociate: { id: $customerId } }
        },
        options: { inventoryBehaviour: DECREMENT_IGNORING_POLICY }
      ) {
        order { id name displayFinancialStatus }
        userErrors { field message }
      }
    }`,
    { customerId: CUSTOMER, variantId },
  );
  expect(created.orderCreate.userErrors).toEqual([]);
  const order = created.orderCreate.order;
  expect(order?.id).toBeTruthy();
  return { orderId: order.id, name: order.name };
};

/** The variant of an order's first line item — "the secondary's item". */
const orderVariantId = async (orderId: string): Promise<string> => {
  const data = await admin(
    `query ($id: ID!) {
      node(id: $id) { ... on Order { lineItems(first: 5) { nodes { variant { id } } } } }
    }`,
    { id: orderId },
  );
  return data.node.lineItems.nodes[0].variant.id;
};

// -- order-edit primitives ---------------------------------------------------

const beginEdit = async (orderId: string) => {
  const data = await admin(
    `mutation ($id: ID!) {
      orderEditBegin(id: $id) {
        calculatedOrder { id }
        userErrors { field message }
      }
    }`,
    { id: orderId },
  );
  return { calcId: data.orderEditBegin.calculatedOrder?.id, userErrors: data.orderEditBegin.userErrors };
};

const addItem = async (calcId: string, variantId: string, quantity = 1) => {
  const data = await admin(
    `mutation ($id: ID!, $variantId: ID!, $quantity: Int!) {
      orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, allowDuplicates: true) {
        calculatedLineItem { id }
        userErrors { field message }
      }
    }`,
    { id: calcId, variantId, quantity },
  );
  return data.orderEditAddVariant.userErrors;
};

const commitEdit = async (calcId: string) => {
  const data = await admin(
    `mutation ($id: ID!) {
      orderEditCommit(id: $id) {
        order { id }
        userErrors { field message }
      }
    }`,
    { id: calcId },
  );
  return data.orderEditCommit.userErrors;
};

// -- observation -------------------------------------------------------------

const orderState = async (orderId: string) => {
  const data = await admin(
    `query ($id: ID!) {
      node(id: $id) {
        ... on Order {
          id name
          lineItems(first: 50) { nodes { name quantity } }
          totalPriceSet { shopMoney { amount currencyCode } }
        }
      }
    }`,
    { id: orderId },
  );
  return data.node;
};

/** orderEditCommit applies asynchronously — read until line items stabilise. */
const settle = async (orderId: string) => {
  let last = "";
  let state = await orderState(orderId);
  for (let i = 0; i < 20; i++) {
    const sig = JSON.stringify(state?.lineItems?.nodes ?? null);
    if (i > 0 && sig === last) return state;
    last = sig;
    await sleep(1500);
    state = await orderState(orderId);
  }
  return state;
};

const variantQty = async (variantId: string): Promise<number> => {
  const data = await admin(
    `query ($id: ID!) { productVariant(id: $id) { inventoryQuantity } }`,
    { id: variantId },
  );
  return data.productVariant.inventoryQuantity;
};

const cancelOrder = async (orderId: string) => {
  const data = await admin(
    `mutation ($orderId: ID!) {
      orderCancel(orderId: $orderId, reason: OTHER, refund: false, restock: true, notifyCustomer: false) {
        userErrors { field message }
      }
    }`,
    { orderId },
  );
  return data.orderCancel.userErrors;
};

const cancelAll = async (orderIds: string[]) => {
  for (const id of orderIds) {
    try {
      const errs = await cancelOrder(id);
      if (errs.length) console.log(`cancel ${id} userErrors: ${JSON.stringify(errs)}`);
    } catch (e) {
      console.log(`cancel ${id} failed: ${e}`);
    }
  }
};

/** Prints one verbatim result block per case — this IS the experiment output. */
const record = (label: string, r: Record<string, any>) => {
  console.log(`\n===== ${label} =====\n${JSON.stringify(r, null, 2)}\n===== /${label} =====`);
};

const summarise = (state: any, invDelta: number) => ({
  lineItemCount: state?.lineItems?.nodes?.length ?? null,
  lineItems: state?.lineItems?.nodes?.map((n: any) => ({ name: n.name, quantity: n.quantity })) ?? null,
  totalPrice: state?.totalPriceSet?.shopMoney ?? null,
  inventoryDelta: invDelta,
});

describe.skipIf(!RUN)("live concurrent order-edit experiment", () => {
  it(
    "case 1: two calcs add different items; commit A then B",
    async () => {
      const made: string[] = [];
      try {
        const invBefore = await variantQty(VARIANT!);
        const p = await createPaidOrder(VARIANT!);
        const s1 = await createPaidOrder(VARIANT!);
        const s2 = await createPaidOrder(VARIANT2!);
        made.push(p.orderId, s1.orderId, s2.orderId);

        const a = await beginEdit(p.orderId);
        const b = await beginEdit(p.orderId);
        const addA = await addItem(a.calcId, await orderVariantId(s1.orderId));
        const addB = await addItem(b.calcId, await orderVariantId(s2.orderId));
        const c1 = await commitEdit(a.calcId);
        const c2 = await commitEdit(b.calcId);
        const final = await settle(p.orderId);
        const invAfter = await variantQty(VARIANT!);

        record("case 1 (distinct items)", {
          orders: { P: p, S1: s1, S2: s2 },
          beginUserErrors: { A: a.userErrors, B: b.userErrors },
          addUserErrors: { A: addA, B: addB },
          commitUserErrors: { first: c1, second: c2 },
          ...summarise(final, invAfter - invBefore),
        });
      } finally {
        await cancelAll(made);
      }
    },
    300_000,
  );

  it(
    "case 2: two calcs add the SAME secondary item; commit A then B",
    async () => {
      const made: string[] = [];
      try {
        const invBefore = await variantQty(VARIANT!);
        const p = await createPaidOrder(VARIANT!);
        const s1 = await createPaidOrder(VARIANT!);
        const s2 = await createPaidOrder(VARIANT!);
        made.push(p.orderId, s1.orderId, s2.orderId);
        const s1Variant = await orderVariantId(s1.orderId);

        const a = await beginEdit(p.orderId);
        const b = await beginEdit(p.orderId);
        const addA = await addItem(a.calcId, s1Variant);
        const addB = await addItem(b.calcId, s1Variant); // duplicate application
        const c1 = await commitEdit(a.calcId);
        const c2 = await commitEdit(b.calcId);
        const final = await settle(p.orderId);
        const invAfter = await variantQty(VARIANT!);

        record("case 2 (same item added by both calcs)", {
          orders: { P: p, S1: s1, S2: s2 },
          beginUserErrors: { A: a.userErrors, B: b.userErrors },
          addUserErrors: { A: addA, B: addB },
          commitUserErrors: { first: c1, second: c2 },
          ...summarise(final, invAfter - invBefore),
        });
      } finally {
        await cancelAll(made);
      }
    },
    300_000,
  );

  it(
    "case 3: committing the same calc twice — idempotent or error?",
    async () => {
      const made: string[] = [];
      try {
        const invBefore = await variantQty(VARIANT!);
        const p = await createPaidOrder(VARIANT!);
        const s1 = await createPaidOrder(VARIANT!);
        const s2 = await createPaidOrder(VARIANT2!);
        made.push(p.orderId, s1.orderId, s2.orderId);

        const a = await beginEdit(p.orderId);
        const b = await beginEdit(p.orderId);
        const addA = await addItem(a.calcId, await orderVariantId(s1.orderId));
        const addB = await addItem(b.calcId, await orderVariantId(s2.orderId));
        const c1 = await commitEdit(a.calcId);
        const c2 = await commitEdit(b.calcId);
        const c2Again = await commitEdit(b.calcId);
        const final = await settle(p.orderId);
        const invAfter = await variantQty(VARIANT!);

        record("case 3 (calc B committed twice)", {
          orders: { P: p, S1: s1, S2: s2 },
          beginUserErrors: { A: a.userErrors, B: b.userErrors },
          addUserErrors: { A: addA, B: addB },
          commitUserErrors: { A: c1, B: c2, B_again: c2Again },
          ...summarise(final, invAfter - invBefore),
        });
      } finally {
        await cancelAll(made);
      }
    },
    300_000,
  );

  it(
    "case 4: control — fresh edit begun AFTER the first commit",
    async () => {
      const made: string[] = [];
      try {
        const invBefore = await variantQty(VARIANT!);
        const p = await createPaidOrder(VARIANT!);
        const s1 = await createPaidOrder(VARIANT!);
        const s2 = await createPaidOrder(VARIANT2!);
        made.push(p.orderId, s1.orderId, s2.orderId);

        const a = await beginEdit(p.orderId);
        const addA = await addItem(a.calcId, await orderVariantId(s1.orderId));
        const c1 = await commitEdit(a.calcId);
        await settle(p.orderId); // let the first edit finish applying

        const c = await beginEdit(p.orderId); // fresh edit, post-commit
        const addC = await addItem(c.calcId, await orderVariantId(s2.orderId));
        const c2 = await commitEdit(c.calcId);
        const final = await settle(p.orderId);
        const invAfter = await variantQty(VARIANT!);

        record("case 4 (sequential control)", {
          orders: { P: p, S1: s1, S2: s2 },
          beginUserErrors: { A: a.userErrors, C: c.userErrors },
          addUserErrors: { A: addA, C: addC },
          commitUserErrors: { A: c1, C: c2 },
          ...summarise(final, invAfter - invBefore),
        });
      } finally {
        await cancelAll(made);
      }
    },
    300_000,
  );
});
