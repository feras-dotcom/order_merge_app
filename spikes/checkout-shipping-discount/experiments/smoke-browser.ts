import { launch, SHOP_ORIGIN, SHOTS_DIR } from "./browser";
import { join } from "node:path";
async function main() {
  const ctx = await launch();
  const page = await ctx.newPage();
  await page.goto(SHOP_ORIGIN + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(8000); // allow CF/password interstitials
  const url = page.url();
  const title = await page.title();
  const html = (await page.content()).toLowerCase();
  await page.screenshot({ path: join(SHOTS_DIR, "smoke-password.png") });
  await ctx.close();
  console.log(JSON.stringify({
    url, title,
    passwordPage: html.includes("password") || url.includes("/password"),
    cfChallenge: html.includes("verifying your connection") || html.includes("challenge-platform"),
    storeContent: html.includes("snowboard") || html.includes("ski"),
  }));
}
main().catch((e) => { console.error(e); process.exit(1); });
