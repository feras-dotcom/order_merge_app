// probe-tmp.ts — fresh-cart checkout observation via CDP (deletes only the
// session cart cookie first, so a brand-new checkout token is minted).
import { createRequire } from "node:module";
import { join } from "node:path";
import { fillAddress, TEST_ADDRESS } from "./browser";
const req = createRequire(join(process.env.SPIKE_APP_DIR!, "..", "..", "noop.cjs"));
const { chromium } = req("playwright-core");
async function main() {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = b.contexts()[0];
  await ctx.clearCookies({ name: "cart" });
  const page = await ctx.newPage();
  await page.goto("https://ms-checkout-spike-1111.myshopify.com/cart/68100324327791:1");
  await page.waitForTimeout(2000);
  await page.goto("https://ms-checkout-spike-1111.myshopify.com/checkout");
  await page.waitForTimeout(5000);
  console.log("co:", page.url());
  await fillAddress(page, TEST_ADDRESS);
  await page.waitForTimeout(4000);
  const text = await page.evaluate(() => document.body.innerText);
  const m = /Cost summary[\s\S]{0,700}/.exec(text);
  console.log(JSON.stringify(m?.[0]?.slice(0, 700)));
  const s = /shipping method[\s\S]{0,900}/i.exec(text);
  console.log(JSON.stringify(s?.[0]?.slice(0, 900)));
  await b.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
