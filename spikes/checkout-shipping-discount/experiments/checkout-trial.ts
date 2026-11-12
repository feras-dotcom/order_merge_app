// checkout-trial.ts — ONE browser checkout observation on the persisted
// signed-in profile: cart permalink -> /checkout -> fill fixed address ->
// scrape shipping options/prices/discount/total -> evidence JSON + local
// screenshot. Env: SCENARIO (name), ADDR_* overrides, HEADED=0 for headless.
import { launch, buildCartAndCheckout, fillAddress, scrapeCheckout, TEST_ADDRESS, SHOTS_DIR } from "./browser";
import { saveEvidence, log } from "./lib";
import { join } from "node:path";

export async function runTrial(opts: { scenario?: string; address?: typeof TEST_ADDRESS; fillAddr?: boolean } = {}) {
  const scenario = opts.scenario ?? process.env.SCENARIO ?? "trial";
  const ctx = await launch({ headless: process.env.HEADED === "0" });
  try {
    const page = await ctx.newPage();
    await buildCartAndCheckout(page);
    await page.waitForTimeout(3000);
    const addr = opts.address ?? TEST_ADDRESS;
    if (opts.fillAddr !== false) await fillAddress(page, addr);
    await page.waitForTimeout(4000); // delivery options + Function
    const scraped = await scrapeCheckout(page);
    const shot = join(SHOTS_DIR, `${scenario}-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    const evidence = { ts: new Date().toISOString(), scenario, address: { ...addr, email: "[signed-in]" }, scraped, shot };
    saveEvidence(`trial-${scenario}.json`, evidence);
    log(scenario, JSON.stringify(scraped).slice(0, 1200));
    return evidence;
  } finally {
    await ctx.close();
  }
}
if (process.argv[1]?.endsWith("checkout-trial.ts")) {
  runTrial().catch((e) => { console.error(e); process.exit(1); });
}
