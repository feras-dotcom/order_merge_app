// e6-place-order.ts — complete ONE bogus-gateway checkout on the signed-in
// profile and capture the order name from the confirmation page.
// Requires: eligibility already seeded (run seed-eligibility.ts first).
import { connect, buildCartAndCheckout, fillAddress, scrapeCheckout, TEST_ADDRESS, SHOTS_DIR } from "./browser";
import { saveEvidence, log } from "./lib";
import { join } from "node:path";

async function fillCard(page: { frameLocator?: (s: string) => { locator(s: string): { fill(v: string): Promise<void> } } }) {
  const fl = page.frameLocator;
  if (!fl) throw new Error("frameLocator unavailable");
  await fl.call(page, "iframe[name^='card-fields-number']").locator("#number").fill("1");
  await fl.call(page, "iframe[name^='card-fields-name']").locator("#name").fill("Spike Test");
  await fl.call(page, "iframe[name^='card-fields-expiry']").locator("#expiry").fill("12/30");
  await fl.call(page, "iframe[name^='card-fields-verification_value']").locator("#verification_value").fill("111");
}

async function main() {
  const ctx = await connect();
  try {
    const page = await ctx.newPage();
    await buildCartAndCheckout(page);
    await page.waitForTimeout(3000);
    await fillAddress(page, TEST_ADDRESS);
    await page.waitForTimeout(5000);
    const before = await scrapeCheckout(page);
    log("pre-pay", JSON.stringify(before).slice(0, 600));
    await fillCard(page);
    await page.waitForTimeout(1500);
    // click the Pay now button (its label contains the total)
    const clicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /pay now/i.test(x.innerText || ""));
      if (b) { (b as HTMLButtonElement).click(); return true; }
      return false;
    });
    log("pay-click", String(clicked));
    // wait for order status / thank-you
    let confirmation: Record<string, unknown> = { url: null, text: null };
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(2000);
      const u = page.url();
      if (/thank|orders?\/|status/i.test(u) || (await page.evaluate(() => /order|thank/i.test(document.body.innerText.slice(0, 800))))) {
        const text = await page.evaluate(() => document.body.innerText.slice(0, 1500));
        confirmation = { url: u, text };
        const name = /#(\d{3,6})/.exec(text)?.[0] ?? null;
        confirmation.orderName = name;
        break;
      }
    }
    const shot = join(SHOTS_DIR, `e6-order-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    const ev = { ts: new Date().toISOString(), before, confirmation, shot };
    saveEvidence("e6-place-order.json", ev);
    console.log(JSON.stringify({ before: before.optionLines, confirmation }, null, 1));
  } finally { await ctx.close(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
