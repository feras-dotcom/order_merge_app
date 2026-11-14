// INVALID EXPERIMENT (retained for the record): ran on a cart where Standard shipping was natively free and seeded a synthetic record. Do not reuse; see docs/evidence/checkout-first/INVALID-original-e2-e3/README.md
// e2-pipeline.ts — E2 order-paid -> webhook -> projection write -> checkout
// visibility latency measurement. Requires tunnel-webhooks.ts running
// (subscriptions live) and the signed-in :9222 Chrome.
// Env: SPIKE_TRIALS (default 3), SPIKE_CUSTOMER_ID (gid), SPIKE_METHOD.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { connect, buildCartAndCheckout, fillAddress, scrapeCheckout, TEST_ADDRESS } from "./browser";
import { admin, adminGraphql, saveEvidence, log, appDir } from "./lib";
import { buildRecord, mergeRecords } from "../projection/records";
import { writeProjection } from "../projection/write";

const ME = process.env.SPIKE_CUSTOMER_ID ?? "";
const METHOD = process.env.SPIKE_METHOD ?? "Standard";
const LOG = join(appDir, "..", "..", "webhook-events.jsonl");
const shopToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const now = () => new Date().toISOString();
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

async function clearRec(cid: string) {
  await writeProjection(admin, cid, () => ({ serialized: JSON.stringify({ recs: [], v: 1 }) }), { sleep });
}
async function seedRec(cid: string) {
  const built = buildRecord(
    { orderId: `gid://shopify/Order/9${String(Date.now()).slice(-9)}`, customerId: cid, currencyCode: "USD",
      shippingAddress: { ...TEST_ADDRESS, provinceCode: TEST_ADDRESS.provinceCode },
      shippingLines: [{ title: METHOD, originalMinor: 500, discountedMinor: 500 }],
      cancelledAt: null, financialStatus: "PAID" },
    { windowId: "w1", expiresOn: `${Number(shopToday().slice(0, 4))}-12-31` },
  );
  if (!built.ok) throw new Error(`buildRecord ${built.reason}`);
  await writeProjection(admin, cid, (cur) => ({ serialized: mergeRecords(cur, [built.record], { todayDate: shopToday() }).serialized }), { sleep });
}
const countLog = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").filter(Boolean).length : 0);

async function fillCard(page: { frameLocator?: (s: string) => { locator(s: string): { fill(v: string): Promise<void> } } }) {
  const fl = page.frameLocator!;
  await fl.call(page, "iframe[name^='card-fields-number']").locator("#number").fill("1");
  await fl.call(page, "iframe[name^='card-fields-name']").locator("#name").fill("Spike Test");
  await fl.call(page, "iframe[name^='card-fields-expiry']").locator("#expiry").fill("12/30");
  await fl.call(page, "iframe[name^='card-fields-verification_value']").locator("#verification_value").fill("111");
}

async function waitPaidWebhook(before: number, timeoutMs = 90000): Promise<string | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(LOG)) {
      const lines = readFileSync(LOG, "utf8").split("\n").filter(Boolean).slice(before);
      for (const l of lines) {
        try { const e = JSON.parse(l); if (e.topic === "orders/paid" && e.ok) return e.ts as string; } catch { /* */ }
      }
    }
    await sleep(500);
  }
  return null;
}

async function main() {
  if (!ME) throw new Error("SPIKE_CUSTOMER_ID required");
  const n = Number(process.env.SPIKE_TRIALS ?? 3);
  const trials: Record<string, unknown>[] = [];
  const ctx = await connect();
  try {
    const page = await ctx.newPage();
    for (let i = 0; i < n; i++) {
      const t: Record<string, unknown> = { trial: i };
      await clearRec(ME);
      const logBefore = countLog();
      const tStart = now();
      // 1. place the bogus order
      await buildCartAndCheckout(page);
      await page.waitForTimeout(3000);
      await fillAddress(page, TEST_ADDRESS);
      await page.waitForTimeout(4000);
      await fillCard(page);
      await page.waitForTimeout(1000);
      await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /pay now/i.test(x.innerText || "")); (b as HTMLButtonElement)?.click(); });
      const tPay = now();
      // 2. T1: order createdAt via Admin (poll newest order)
      let t1: string | null = null;
      for (let p = 0; p < 30 && !t1; p++) {
        const r = await adminGraphql(`query { orders(first: 1, sortKey: CREATED_AT, reverse: true) { nodes { createdAt processedAt } } }`);
        const o = (r.orders as { nodes: { createdAt: string; processedAt: string }[] }).nodes[0];
        if (o && new Date(o.createdAt).getTime() >= new Date(tStart).getTime() - 30000) t1 = o.createdAt;
        else await sleep(1500);
      }
      // wait for thank-you (order confirmed) so checkout session frees
      for (let p = 0; p < 30; p++) { if (/thank/.test(page.url())) break; await sleep(1500); }
      // 3. T2: webhook receipt (orders/paid, HMAC-verified)
      const t2 = await waitPaidWebhook(logBefore);
      // 4. T3: projection write completion (what a real worker would do on receipt)
      const tWrite0 = now();
      await seedRec(ME);
      const t3 = now();
      // 5. T4: first poll of a fresh checkout showing the discount; a
      //    reload re-evaluates the Function (verified), so poll by reload.
      let t4: string | null = null;
      await buildCartAndCheckout(page);
      await page.waitForTimeout(2000);
      await fillAddress(page, TEST_ADDRESS);
      await page.waitForTimeout(2500);
      for (let p = 0; p < 40; p++) {
        const s = await scrapeCheckout(page);
        if (/MERGESHIP SPIKE|Discounted price/i.test(JSON.stringify(s))) { t4 = now(); break; }
        await page.evaluate(() => location.reload());
        await page.waitForTimeout(3000);
      }
      Object.assign(t, { tStart, tPay, t1, t2, tWrite0, t3, t4 });
      const ms = (a: string | null, b: string | null) => (a && b ? new Date(b).getTime() - new Date(a).getTime() : null);
      t.deltas = {
        "t1-order": ms(tStart, t1), "t2-webhook": ms(t1, t2), "t3-write": ms(t2, t3),
        "t4-visible": ms(t3, t4), "total": ms(tStart, t4),
      };
      log(`trial ${i}`, JSON.stringify(t.deltas));
      trials.push(t);
    }
  } finally { await ctx.close(); }
  const nums = (k: string) => trials.map((t) => (t.deltas as Record<string, number | null>)[k]).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  const pct = (a: number[], p: number) => (a.length ? a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)] : null);
  const stats = Object.fromEntries(["t1-order", "t2-webhook", "t3-write", "t4-visible", "total"].map((k) => {
    const a = nums(k); return [k, { n: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95), max: a.length ? a[a.length - 1] : null }];
  }));
  saveEvidence("e2-pipeline.json", { trials, stats });
  console.log(JSON.stringify({ trials, stats }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
