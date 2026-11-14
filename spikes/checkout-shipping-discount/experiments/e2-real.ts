// e2-real.ts — REAL order pipeline, no synthetic records:
//   real paid bogus-gateway order (signed-in :9222 Chrome, $24.95 cart) -> orders/paid webhook (tunnel-webhooks.ts must be
//   running) -> worker fetches the REAL order from the Admin API -> buildRecord(order facts) -> writeProjection ->
//   Admin readback -> STRICT checkout signal (fresh checkout + existing checkout reloaded) at the second checkout.
// The second checkout is only VIEWED; no second order is placed.
// Env: SPIKE_APP_DIR, SPIKE_CUSTOMER_ID, ORDERS (3), VARIANT, CAP_S
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { connect, SHOP_ORIGIN, TEST_ADDRESS, type BrowserPage } from "./browser";
import { admin, adminGraphql, saveEvidence, log, appDir } from "./lib";
import { buildRecord, mergeRecords, type OrderFacts } from "../projection/records";
import { writeProjection } from "../projection/write";
import { readSignal } from "./signal";
import { VARIANT, sleep, iso, ms, openExisting, freshObserve, pollUntil, summarize, type Pg, type Obs } from "./e2-lib";

const CID = `gid://shopify/Customer/${(process.env.SPIKE_CUSTOMER_ID ?? "").replace(/^.*\//, "")}`;
const ORDERS = Number(process.env.ORDERS ?? 3);
const LOG = join(appDir, "..", "..", "webhook-events.jsonl");
const shopToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const plusDays = (d: string, n: number) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 86400e3).toISOString().slice(0, 10);

const minor = (amount: string): number => Math.round(Number(amount) * 100);

async function clearRecord() {
  await writeProjection(admin, CID, () => ({ serialized: JSON.stringify({ recs: [], v: 1 }) }), { sleep, random: Math.random });
  const rb = (await admin.graphql(`query($id: ID!) { customer(id: $id) { metafield(namespace: "$app", key: "ship_elig") { jsonValue } } }`, { variables: { id: CID } })) as {
    data: { customer: { metafield: { jsonValue: { recs?: unknown[] } } | null } };
  };
  return rb.data.customer.metafield?.jsonValue?.recs?.length ?? 0;
}

async function latestOrder() {
  const r = await adminGraphql(`query { orders(first: 1, sortKey: CREATED_AT, reverse: true) { nodes { id name createdAt processedAt } } }`);
  return (r.orders as { nodes: { id: string; name: string; createdAt: string; processedAt: string | null }[] }).nodes[0] ?? null;
}

async function fillCard(page: Pg) {
  const fl = page.frameLocator;
  if (!fl) throw new Error("frameLocator unavailable");
  await fl.call(page, "iframe[name^='card-fields-number']").locator("#number").fill("1");
  await fl.call(page, "iframe[name^='card-fields-name']").locator("#name").fill("Spike Test");
  await fl.call(page, "iframe[name^='card-fields-expiry']").locator("#expiry").fill("12/30");
  await fl.call(page, "iframe[name^='card-fields-verification_value']").locator("#verification_value").fill("111");
}

async function placeOrder(ctx: { newPage(): Promise<BrowserPage> }) {
  const page = (await ctx.newPage()) as Pg;
  try {
    await page.goto(`${SHOP_ORIGIN}/cart/clear`, { waitUntil: "domcontentloaded" });
    await page.goto(`${SHOP_ORIGIN}/cart/${VARIANT}:1`, { waitUntil: "domcontentloaded" });
    await page.goto(`${SHOP_ORIGIN}/checkout`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    let pre = await readSignal(page);
    for (let i = 0; i < 10 && pre.stdTokens.length === 0; i++) { await page.waitForTimeout(1000); pre = await readSignal(page); }
    if (pre.kind !== "baseline") throw new Error(`pre-pay checkout is not the $8.00 baseline (${pre.kind}); refusing to place the order`);
    await fillCard(page);
    await page.waitForTimeout(1000);
    const tClick = iso();
    await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /pay now/i.test(x.innerText || "")); (b as HTMLButtonElement | undefined)?.click(); });
    let tThankYou: string | null = null;
    for (let i = 0; i < 120 && !tThankYou; i++) {
      if (/thank|\/orders\//i.test(page.url())) tThankYou = iso();
      else await sleep(500);
    }
    return { tClick, tThankYou, preKind: pre.kind };
  } finally { await page.close(); }
}

async function waitWebhook(orderGid: string, timeoutMs = 120000): Promise<string | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(LOG)) {
      for (const l of readFileSync(LOG, "utf8").split("\n").filter(Boolean)) {
        try { const e = JSON.parse(l); if (e.topic === "orders/paid" && e.ok && e.orderGid === orderGid) return e.ts as string; } catch { /* */ }
      }
    }
    await sleep(300);
  }
  return null;
}

async function project(orderGid: string) {
  const fetchStart = iso();
  const r = await adminGraphql(
    `query($id: ID!) { order(id: $id) { id createdAt processedAt cancelledAt displayFinancialStatus currencyCode customer { id }
        shippingAddress { firstName lastName company address1 address2 city provinceCode zip countryCode }
        shippingLines(first: 3) { nodes { title originalPriceSet { shopMoney { amount } } discountedPriceSet { shopMoney { amount } } } } } }`,
    { id: orderGid },
  );
  const o = r.order as {
    id: string; createdAt: string; processedAt: string | null; cancelledAt: string | null; displayFinancialStatus: string; currencyCode: string;
    customer: { id: string } | null; shippingAddress: OrderFacts["shippingAddress"];
    shippingLines: { nodes: { title: string; originalPriceSet: { shopMoney: { amount: string } }; discountedPriceSet: { shopMoney: { amount: string } } }[] };
  };
  const fetchEnd = iso();
  const facts: OrderFacts = {
    orderId: o.id, customerId: o.customer?.id ?? null, currencyCode: o.currencyCode, shippingAddress: o.shippingAddress,
    shippingLines: o.shippingLines.nodes.map((s) => ({ title: s.title, originalMinor: minor(s.originalPriceSet.shopMoney.amount), discountedMinor: minor(s.discountedPriceSet.shopMoney.amount) })),
    cancelledAt: o.cancelledAt, financialStatus: o.displayFinancialStatus,
  };
  const built = buildRecord(facts, { windowId: "w1", expiresOn: plusDays(shopToday(), 3) });
  if (!built.ok) return { fetchStart, fetchEnd, refused: built.reason, shipping: facts.shippingLines, customerMatches: facts.customerId === CID };
  const writeStart = iso();
  await writeProjection(admin, facts.customerId!, (cur) => ({ serialized: mergeRecords(cur, [built.record], { todayDate: shopToday() }).serialized }), { sleep, random: Math.random });
  const writeEnd = iso();
  const rb = (await admin.graphql(`query($id: ID!) { customer(id: $id) { metafield(namespace: "$app", key: "ship_elig") { jsonValue } } }`, { variables: { id: facts.customerId } })) as {
    data: { customer: { metafield: { jsonValue: { recs?: { id: string; method: string }[] } } | null } };
  };
  const readbackEnd = iso();
  const recs = rb.data.customer.metafield?.jsonValue?.recs ?? [];
  return {
    fetchStart, fetchEnd, writeStart, writeEnd, readbackEnd,
    orderCreatedAt: o.createdAt, orderProcessedAt: o.processedAt,
    shipping: facts.shippingLines, customerMatches: facts.customerId === CID,
    record: { id: built.record.id, method: built.record.method, left: built.record.left, exp: built.record.exp },
    readbackHasRecordForOrder: recs.some((x) => x.id === built.record.id),
  };
}

async function main() {
  if (!process.env.SPIKE_CUSTOMER_ID) throw new Error("SPIKE_CUSTOMER_ID required");
  const ctx = await connect();
  const trials: Record<string, unknown>[] = [];
  try {
    for (let i = 0; i < ORDERS; i++) {
      const tr: Record<string, unknown> = { trial: i, startedAt: iso() };
      tr.clearedRecordCount = await clearRecord();
      const f0 = await freshObserve(ctx);
      tr.baselineKind = f0.kind;
      if (f0.kind !== "baseline") { tr.aborted = `baseline not confirmed (${f0.kind})`; trials.push(tr); break; }
      const prev = await latestOrder();
      const placed = await placeOrder(ctx);
      Object.assign(tr, placed);
      // order confirmation as seen by Admin
      let order = await latestOrder();
      for (let a = 0; a < 40 && (!order || order.id === prev?.id); a++) { await sleep(1000); order = await latestOrder(); }
      if (!order || order.id === prev?.id) { tr.aborted = "new order never appeared in Admin"; trials.push(tr); break; }
      tr.adminSeenAt = iso();
      tr.orderName = order.name;
      tr.orderCreatedAt = order.createdAt;
      // existing checkout opened BEFORE the projection exists; polling overlaps webhook + write
      const existing = await openExisting(ctx);
      tr.existingBaselineKind = existing.obs.kind;
      const pollP = pollUntil("discounted", ctx, existing.page);
      const workerP = (async () => {
        const tHook = await waitWebhook(order!.id);
        if (!tHook) return { webhookReceivedAt: null as string | null };
        const p = await project(order!.id);
        return { webhookReceivedAt: tHook, ...p };
      })();
      const [obs, w] = await Promise.all([pollP, workerP]);
      await existing.page.close();
      Object.assign(tr, { worker: w });
      const wr = w as { writeEnd?: string; webhookReceivedAt: string | null };
      if (wr.writeEnd) {
        tr.visible = summarize(obs as Obs[], "discounted", wr.writeEnd);
        const created = order.createdAt;
        const vis = tr.visible as Record<string, { upperBoundMs: number | null }>;
        tr.deltasMs = {
          orderCreated_to_webhookReceived: wr.webhookReceivedAt ? ms(created, wr.webhookReceivedAt) : null,
          webhookReceived_to_writeEnd: wr.webhookReceivedAt ? ms(wr.webhookReceivedAt, wr.writeEnd) : null,
          writeEnd_to_discountVisibleUpper_fresh: vis.fresh.upperBoundMs,
          writeEnd_to_discountVisibleUpper_existing: vis.existing.upperBoundMs,
        };
      }
      tr.cleanedRecordCount = await clearRecord();
      tr.endedAt = iso();
      log(`trial ${i}`, JSON.stringify({ order: tr.orderName, deltas: tr.deltasMs, refused: (w as { refused?: string }).refused }));
      trials.push(tr);
      saveEvidence(process.env.EVIDENCE_NAME ?? "e2-real.json", { cart: { variant: VARIANT, price: "24.95" }, trials });
    }
  } finally {
    try { await clearRecord(); } catch { /* best effort */ }
    await ctx.close();
  }
  saveEvidence(process.env.EVIDENCE_NAME ?? "e2-real.json", { cart: { variant: VARIANT, price: "24.95" }, trials });
}
main().catch((e) => { console.error(String(e?.message ?? e).replace(/\S+@\S+/g, "[EMAIL]")); process.exit(1); });
void TEST_ADDRESS;
