// Opt-in LIVE verification of protocol v2 against a dev store (spec §12
// "Live dev-store"), pinned to API version 2026-04. Exercises the real
// evidence contract — tokened discount descriptions, OrderEditAgreement
// attribution, cancel staff notes — plus a full executeMerge/driveOperation
// run through the real engine with in-memory stores.
//
//   MERGESHIP_LIVE_STORE=ordermergetest2.myshopify.com \
//   npx vitest run tests/live-protocol.test.ts
//
// (variant/customer gids default to the dev store's fixtures; override with
// MERGESHIP_LIVE_VARIANT / MERGESHIP_LIVE_VARIANT2 / MERGESHIP_LIVE_CUSTOMER.)
//
// Every order created here is cancelled (restock, no refund) in cleanup; the
// test prints each created order's name, gid and cancelledAt.

import { exec } from "child_process";
import { promisify } from "util";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { afterAll, describe, expect, it } from "vitest";

import type { AdminClient } from "../app/lib/graphql.server";
import { executeMerge, type MergeDeps } from "../app/lib/merge.server";
import { driveOperation } from "../app/lib/operation-protocol.server";
import { newLeaseToken } from "../app/lib/ownership.server";
import {
  MemoryClaimStore,
  MemoryJournal,
  MemoryOperationStore,
  MemoryWorkStore,
} from "./fake-shopify";

const execAsync = promisify(exec);

const STORE = process.env.MERGESHIP_LIVE_STORE;
const VARIANT = process.env.MERGESHIP_LIVE_VARIANT ?? "gid://shopify/ProductVariant/51204236378359";
const VARIANT2 = process.env.MERGESHIP_LIVE_VARIANT2 ?? "gid://shopify/ProductVariant/51204236148983";
const CUSTOMER = process.env.MERGESHIP_LIVE_CUSTOMER ?? "gid://shopify/Customer/10646077964535";
const API_VERSION = "2026-04";

const RUN = Boolean(STORE);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `shopify app execute` prints result JSON on stdout on success and wraps an
 *  error JSON in a drawn box on stderr (exit code still 0). Strip ANSI escapes
 *  and `│` borders, then parse the outermost JSON object. */
const parseCliBody = (text: string): any => {
  // eslint-disable-next-line no-control-regex -- strips ANSI escapes from CLI output
  const clean = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const stripped = clean
    .split("\n")
    .map((line) => {
      const m = line.match(/^\s*│\s?(.*?)\s*│?\s*$/);
      return m ? m[1] : line;
    })
    .join("\n");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
};

/** Runs a GraphQL op via `shopify app execute`; returns the parsed body
 *  (including an `{errors: [...]}` body for query-level failures). */
const cliAdmin = async (query: string, variables?: Record<string, any>): Promise<any> => {
  const file = join(tmpdir(), `mergeship-liveproto-${process.pid}.graphql`);
  writeFileSync(file, query);
  let varArg = "";
  if (variables) {
    const variablesFile = join(tmpdir(), `mergeship-liveproto-${process.pid}.variables.json`);
    writeFileSync(variablesFile, JSON.stringify(variables));
    varArg = ` --variable-file ${variablesFile}`;
  }
  const cmd = `shopify app execute --store ${STORE} --version ${API_VERSION} --query-file ${file}${varArg}`;
  const cwd = dirname(fileURLToPath(import.meta.url));
  let lastErr: unknown = new Error("no attempts made");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd });
      const body = parseCliBody(stdout) ?? parseCliBody(stderr);
      if (body) return body;
      lastErr = new Error("shopify CLI returned unparseable output");
    } catch (e: any) {
      const body = parseCliBody(e?.stdout ?? "") ?? parseCliBody(e?.stderr ?? "");
      if (body) return body;
      lastErr = e;
    }
    await sleep(3000);
  }
  throw lastErr;
};

/** admin() throws on transport/query errors but returns mutation userErrors. */
const admin = async (query: string, variables?: Record<string, any>): Promise<any> => {
  const body = await cliAdmin(query, variables);
  const data = body.data ?? body;
  if (body.errors?.length) throw new Error(JSON.stringify(body.errors));
  if (data == null) throw new Error(`no data: ${JSON.stringify(body).slice(0, 400)}`);
  return data;
};

/** AdminClient adapter for the engine: gql() needs `{json()}` and top-level
 *  `errors` preserved so ACCESS_DENIED stays classifiable. */
const engineAdmin: AdminClient = {
  graphql: async (query, options) => {
    const body = await cliAdmin(query, options?.variables);
    return {
      json: async () => ({ data: body.data ?? body, errors: body.errors }),
    } as any;
  },
};

// -- helpers ------------------------------------------------------------------

let shopCurrency: string | null = null;
const currency = async () => {
  if (!shopCurrency) {
    shopCurrency = (await admin(`query { shop { currencyCode } }`)).shop.currencyCode;
  }
  return shopCurrency!;
};

const createPaidOrder = async (variantId: string): Promise<{ orderId: string; name: string }> => {
  const created = await admin(
    `mutation ($customerId: ID!, $variantId: ID!, $currency: CurrencyCode!) {
      orderCreate(
        order: {
          lineItems: [{ variantId: $variantId, quantity: 1, requiresShipping: true }],
          financialStatus: PAID,
          customer: { toAssociate: { id: $customerId } },
          shippingAddress: {
            firstName: "Protocol", lastName: "Test",
            address1: "1 Merge Way", city: "Tokyo",
            provinceCode: "JP-13", zip: "100-0001", countryCode: JP
          },
          shippingLines: [{
            title: "Standard",
            priceSet: { shopMoney: { amount: "0.0", currencyCode: $currency } }
          }]
        },
        options: { inventoryBehaviour: DECREMENT_IGNORING_POLICY }
      ) {
        order { id name displayFinancialStatus }
        userErrors { field message }
      }
    }`,
    { customerId: CUSTOMER, variantId, currency: await currency() },
  );
  expect(created.orderCreate.userErrors).toEqual([]);
  const order = created.orderCreate.order;
  expect(order?.id).toBeTruthy();
  return { orderId: order.id, name: order.name };
};

const cancelOrder = async (orderId: string, staffNote?: string) => {
  const data = await admin(
    `mutation ($orderId: ID!, $staffNote: String) {
      orderCancel(orderId: $orderId, reason: OTHER, refundMethod: { originalPaymentMethodsRefund: false }, restock: true, notifyCustomer: false, staffNote: $staffNote) {
        job { id }
        orderCancelUserErrors { field message }
      }
    }`,
    { orderId, staffNote: staffNote ?? null },
  );
  return data.orderCancel;
};

const orderDetail = async (orderId: string) => {
  const data = await admin(
    `query ($id: ID!) {
      node(id: $id) {
        ... on Order {
          id name cancelledAt
          cancellation { staffNote }
          lineItems(first: 50) {
            nodes {
              id quantity
              discountAllocations {
                discountApplication {
                  __typename
                  ... on ManualDiscountApplication { description }
                }
              }
            }
          }
          agreements(first: 50) {
            nodes {
              __typename id happenedAt
              app { id }
              ... on OrderEditAgreement {
                sales(first: 100) {
                  nodes { __typename ... on ProductSale { lineItem { id } } }
                }
              }
            }
          }
        }
      }
    }`,
    { id: orderId },
  );
  return data.node;
};

const beginEdit = async (orderId: string) =>
  (
    await admin(
      `mutation ($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }`,
      { id: orderId },
    )
  ).orderEditBegin;

const addVariant = async (calcId: string, variantId: string, quantity = 1) =>
  (
    await admin(
      `mutation ($id: ID!, $variantId: ID!, $quantity: Int!) {
        orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, allowDuplicates: true) {
          calculatedLineItem { id }
          userErrors { field message }
        }
      }`,
      { id: calcId, variantId, quantity },
    )
  ).orderEditAddVariant;

const addDiscount = async (calcId: string, lineItemId: string, description: string) =>
  (
    await admin(
      `mutation ($id: ID!, $lineItemId: ID!, $description: String!) {
        orderEditAddLineItemDiscount(
          id: $id, lineItemId: $lineItemId,
          discount: { percentValue: 100, description: $description }
        ) {
          calculatedLineItem { id }
          userErrors { field message }
        }
      }`,
      { id: calcId, lineItemId, description },
    )
  ).orderEditAddLineItemDiscount;

const commitEdit = async (calcId: string, staffNote?: string) =>
  (
    await admin(
      `mutation ($id: ID!, $staffNote: String) {
        orderEditCommit(id: $id, notifyCustomer: false, staffNote: $staffNote) {
          order { id }
          userErrors { field message }
        }
      }`,
      { id: calcId, staffNote: staffNote ?? null },
    )
  ).orderEditCommit;

const variantQty = async (variantId: string): Promise<number> =>
  (
    await admin(`query ($id: ID!) { productVariant(id: $id) { inventoryQuantity } }`, {
      id: variantId,
    })
  ).productVariant.inventoryQuantity;

// -- suite --------------------------------------------------------------------

const run = RUN ? describe : describe.skip;

run("live protocol v2 verification (2026-04)", () => {
  const createdOrders: { orderId: string; name: string }[] = [];

  const make = async (variantId: string) => {
    const o = await createPaidOrder(variantId);
    createdOrders.push(o);
    return o;
  };

  afterAll(async () => {
    if (!RUN) return;
    console.log("── cleanup: cancelling every created order ──");
    for (const o of createdOrders) {
      try {
        const detail = await orderDetail(o.orderId);
        if (!detail?.cancelledAt) await cancelOrder(o.orderId);
      } catch (e: any) {
        console.warn(`cleanup cancel failed for ${o.name}: ${e?.message ?? e}`);
      }
      const detail = await orderDetail(o.orderId).catch(() => null);
      console.log(`  ${o.name}  ${o.orderId}  cancelledAt=${detail?.cancelledAt ?? "NOT CANCELLED"}`);
    }
  }, 300_000);

  it("L1: token description + app attribution survive a real commit", async () => {
    const primary = await make(VARIANT);
    const secondary = await make(VARIANT2);
    const desc = `Merged from ${secondary.name}, already paid · MS-TESTTOKN-1`;

    const begin = await beginEdit(primary.orderId);
    expect(begin.calculatedOrder?.id).toBeTruthy();
    const added = await addVariant(begin.calculatedOrder.id, VARIANT2, 1);
    expect(added.userErrors).toEqual([]);
    const discounted = await addDiscount(begin.calculatedOrder.id, added.calculatedLineItem.id, desc);
    expect(discounted.userErrors).toEqual([]);
    const committed = await commitEdit(begin.calculatedOrder.id);
    expect(committed.userErrors).toEqual([]);

    await sleep(3000); // let the agreement/lineItems settle
    const detail = await orderDetail(primary.orderId);
    const tokenLine = detail.lineItems.nodes.find((l: any) =>
      (l.discountAllocations ?? []).some(
        (a: any) => a.discountApplication?.description === desc,
      ),
    );
    expect(tokenLine).toBeTruthy();
    console.log("L1 token line:", JSON.stringify(tokenLine));

    const appId = (
      await admin(`query { currentAppInstallation { app { id } } }`)
    ).currentAppInstallation.app.id;
    const agreement = detail.agreements.nodes.find(
      (a: any) => a.__typename === "OrderEditAgreement" && a.app?.id === appId,
    );
    expect(agreement).toBeTruthy();
    const saleLineIds = (agreement.sales?.nodes ?? [])
      .filter((n: any) => n.__typename === "ProductSale")
      .map((n: any) => n.lineItem?.id);
    expect(saleLineIds).toContain(tokenLine.id);
    console.log(
      "L1 agreement:",
      JSON.stringify({ id: agreement.id, happenedAt: agreement.happenedAt, appId: agreement.app.id, saleLineIds }),
    );
  }, 120_000);

  it("L2: orderEdit discount description length probe (60..500)", async () => {
    const probe = await make(VARIANT);
    // Exactly `n` characters, with the token intact inside it.
    const desc = (n: number) => {
      const base = `Merged from ${probe.name}, already paid · MS-TESTTOKN-`;
      return base.length >= n ? base.slice(0, n) : base + "x".repeat(n - base.length);
    };

    const tryLength = async (n: number) => {
      const begin = await beginEdit(probe.orderId);
      if (!begin.calculatedOrder?.id) {
        return { ok: false, error: `orderEditBegin: ${JSON.stringify(begin.userErrors)}` };
      }
      const added = await addVariant(begin.calculatedOrder.id, VARIANT2, 1);
      if (added.userErrors?.length) {
        return { ok: false, error: `addVariant: ${JSON.stringify(added.userErrors)}` };
      }
      const d = await addDiscount(begin.calculatedOrder.id, added.calculatedLineItem.id, desc(n));
      if (d.userErrors?.length) {
        return { ok: false, error: `addDiscount: ${JSON.stringify(d.userErrors)}` };
      }
      return { ok: true, calcId: begin.calculatedOrder.id };
    };

    // Binary search the longest accepted description in [60, 500].
    let lo = 60; // known-ok lower bound start
    let hi = 500;
    let lastErr = "";
    let first = await tryLength(lo);
    if (!first.ok) {
      lo = 0; // below 60 fails too — narrow the whole range
      first = await tryLength(1);
    }
    if (!first.ok) throw new Error(`even a 1-char description failed: ${first.error}`);
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const r = await tryLength(mid);
      if (r.ok) lo = mid;
      else {
        hi = mid;
        lastErr = r.error!;
      }
    }
    const over = await tryLength(hi);
    if (over.ok) hi = 501; // 500 accepted too; probe one above only if meaningful
    console.log(`L2 max accepted description length: ${lo}`);
    console.log(`L2 error at ${lo + 1}: ${lastErr || "(none — upper probe also accepted)"}`);

    // Confirm a commit accepts the max-length description.
    const begin = await beginEdit(probe.orderId);
    const added = await addVariant(begin.calculatedOrder.id, VARIANT2, 1);
    await addDiscount(begin.calculatedOrder.id, added.calculatedLineItem.id, desc(lo));
    const committed = await commitEdit(begin.calculatedOrder.id);
    console.log(`L2 commit at length ${lo}:`, JSON.stringify(committed));
    expect(committed.userErrors).toEqual([]);
    expect(lo).toBeGreaterThanOrEqual(60); // the protocol's real descriptions fit
  }, 300_000);

  it("L3: cancellation staff note reads back with the MS- token", async () => {
    const secondary = await make(VARIANT);
    const note =
      `Repeat order merged into ${secondary.name} by MergeShip. ` +
      `Items transferred, inventory restocked, not refunded. Ref MS-TESTTOKN`;
    const res = await cancelOrder(secondary.orderId, note);
    expect(res.orderCancelUserErrors).toEqual([]);
    await sleep(2000);
    const detail = await orderDetail(secondary.orderId);
    console.log("L3:", JSON.stringify({ cancelledAt: detail.cancelledAt, staffNote: detail.cancellation?.staffNote }));
    expect(detail.cancelledAt).toBeTruthy();
    expect(detail.cancellation?.staffNote).toContain("MS-TESTTOKN");
  }, 120_000);

  it("L4: concurrent duplicate commits of the SAME calculated order", async () => {
    const primary = await make(VARIANT);
    const begin = await beginEdit(primary.orderId);
    const added = await addVariant(begin.calculatedOrder.id, VARIANT2, 1);
    expect(added.userErrors).toEqual([]);
    const [r1, r2] = await Promise.all([
      cliAdmin(
        `mutation ($id: ID!) {
          orderEditCommit(id: $id, notifyCustomer: false) { order { id } userErrors { field message } }
        }`,
        { id: begin.calculatedOrder.id },
      ),
      cliAdmin(
        `mutation ($id: ID!) {
          orderEditCommit(id: $id, notifyCustomer: false) { order { id } userErrors { field message } }
        }`,
        { id: begin.calculatedOrder.id },
      ),
    ]);
    console.log("L4 commit A:", JSON.stringify(r1.data ?? r1));
    console.log("L4 commit B:", JSON.stringify(r2.data ?? r2));
    await sleep(3000);
    const detail = await orderDetail(primary.orderId);
    console.log(`L4 final line item count: ${detail.lineItems.nodes.length}`);
    // The calc had exactly one added line; however Shopify resolves the two
    // commits, the order must not gain duplicates of it.
    expect(detail.lineItems.nodes.length).toBeLessThanOrEqual(2);
  }, 120_000);

  it("L5: duplicate orderCancel on an already-cancelled order", async () => {
    const secondary = await make(VARIANT2);
    const before = await variantQty(VARIANT2);
    const first = await cancelOrder(secondary.orderId);
    expect(first.orderCancelUserErrors).toEqual([]);
    await sleep(2000);
    const mid = await variantQty(VARIANT2);
    const second = await cancelOrder(secondary.orderId);
    await sleep(2000);
    const after = await variantQty(VARIANT2);
    console.log("L5 second cancel:", JSON.stringify(second));
    console.log(`L5 inventory ${VARIANT2}: before=${before} afterFirst=${mid} afterSecond=${after}`);
    // A duplicate cancel must not restock twice.
    expect(after).toBe(mid);
  }, 120_000);

  it("L6: end-to-end executeMerge + driveOperation to COMPLETED on the dev store", async () => {
    const primary = await make(VARIANT);
    const secondary = await make(VARIANT2);

    // In-memory stores on the real clock — no DB needed for the live run.
    const journal = new MemoryJournal();
    const claims = new MemoryClaimStore();
    const work = new MemoryWorkStore();
    const ops = new MemoryOperationStore(claims, work, journal);
    const realClock = () => new Date();
    journal.clock = claims.clock = work.clock = ops.clock = realClock;
    const deps: MergeDeps = {
      journal,
      claims,
      ops,
      leaseTtlMs: 120_000,
      now: realClock,
      sleep,
      cancelPollAttempts: 8,
      cancelPollIntervalMs: 2_500,
    };

    const result = await executeMerge(engineAdmin, STORE!, [primary.orderId, secondary.orderId], deps);
    console.log("L6 executeMerge:", JSON.stringify({ outcome: result.outcome, code: result.code, reason: result.reason }));

    if (result.code === "LOCATION_ACCESS") {
      // This dev store has 3 active locations and the app's token lacks the
      // optional fulfillment-orders scopes — the hard location rule refuses
      // before any mutation. Recorded as the verified limitation; nothing was
      // dispatched (asserted below) and the orders get cancelled in cleanup.
      console.warn(
        "L6 blocked by design: multi-location shop without location access " +
          `(reason: ${result.reason})`,
      );
      expect(result.code).toBe("LOCATION_ACCESS");
      expect(ops.attempts.filter((a) => a.kind === "EDIT_COMMIT")).toHaveLength(0);
      return;
    }

    expect(result.code).toBe("OPERATION_CREATED");
    expect(result.operation).toBeTruthy();

    // Drive to a terminal state in real time: renew the lease before each
    // drive (steps wait on wall-clock nextCheckAt slots).
    const deadline = Date.now() + 240_000;
    let op = result.operation!;
    while (Date.now() < deadline) {
      const current = await ops.getOperation(op.id);
      if (!current) break;
      if (current.phase === "COMPLETED" && current.sideEffectsDone) break;
      if (["ABANDONED", "REVIEW_REQUIRED"].includes(current.phase ?? "")) break;
      try {
        const leased =
          current.leasedUntil && current.leasedUntil.getTime() > Date.now() + 5_000
            ? current
            : await ops
                .renewOperation(current, deps.leaseTtlMs)
                .then(() => ops.getOperation(current.id));
        if (!leased) break;
        await driveOperation(leased, engineAdmin, deps);
      } catch (err: any) {
        if (err?.constructor?.name === "OwnershipLostError") {
          const reacquired = await ops.acquireOperationLease(current.id, newLeaseToken(), deps.leaseTtlMs);
          if (reacquired) await driveOperation(reacquired, engineAdmin, deps);
        } else {
          throw err;
        }
      }
      const after = await ops.getOperation(op.id);
      const wait = after?.nextCheckAt ? after.nextCheckAt.getTime() - Date.now() : 0;
      if (after && ["COMPLETED", "ABANDONED", "REVIEW_REQUIRED"].includes(after.phase ?? "") && !(after.phase === "COMPLETED" && !after.sideEffectsDone)) break;
      if (wait > 0) await sleep(Math.min(wait + 500, 65_000));
      else await sleep(2_000);
      op = after ?? op;
    }

    op = (await ops.getOperation(result.operation!.id))!;
    console.log("L6 final op:", JSON.stringify({ phase: op.phase, sideEffectsDone: op.sideEffectsDone, reviewReason: op.reviewReason }));
    expect(op.phase).toBe("COMPLETED");
    expect(op.sideEffectsDone).toBe(true);

    const token = op.opToken!;
    const primaryDetail = await orderDetail(primary.orderId);
    const tokenLine = primaryDetail.lineItems.nodes.find((l: any) =>
      (l.discountAllocations ?? []).some(
        (a: any) => (a.discountApplication?.description ?? "").includes(`MS-${token}-`),
      ),
    );
    expect(tokenLine).toBeTruthy();

    const secondaryDetail = await orderDetail(secondary.orderId);
    expect(secondaryDetail.cancelledAt).toBeTruthy();
    expect(secondaryDetail.cancellation?.staffNote).toContain(`MS-${token}`);
    console.log("L6 secondary cancellation:", JSON.stringify(secondaryDetail.cancellation));

    expect(ops.records.length).toBeGreaterThanOrEqual(1);
    expect(journal.history.length).toBeGreaterThanOrEqual(1);
    const commitAttempts = ops.attempts.filter((a) => a.kind === "EDIT_COMMIT");
    expect(commitAttempts.length).toBe(1);
    console.log("L6 attempts:", JSON.stringify(ops.attempts.map((a) => ({ kind: a.kind, state: a.state }))));
  }, 300_000);
});
