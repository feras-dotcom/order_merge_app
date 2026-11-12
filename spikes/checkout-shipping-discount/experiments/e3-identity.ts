// e3-identity.ts — guest vs signed-in identity coverage.
// GUEST uses a SECOND persistent profile (browser-profile-guest): the founder
// passes the storefront password there once in handoff 2 but never signs in.
// Env: SPIKE_GUEST=1 for guest profile; SPIKE_GUEST_EMAIL typed at checkout.
import { launch, buildCartAndCheckout, fillAddress, scrapeCheckout, TEST_ADDRESS, SHOTS_DIR, PROFILE_DIR } from "./browser";
import { saveEvidence } from "./lib";
import { createRequire } from "node:module";
import { join } from "node:path";

async function main() {
  const guest = process.env.SPIKE_GUEST === "1";
  const workspaceDir = join(PROFILE_DIR, "..");
  const profileDir = guest ? join(workspaceDir, "browser-profile-guest") : PROFILE_DIR;
  let ctx;
  if (guest) {
    const req = createRequire(join(workspaceDir, "..", "noop.cjs"));
    const { chromium } = req("playwright-core") as {
      chromium: { launchPersistentContext(d: string, o: Record<string, unknown>): Promise<import("./browser").BrowserCtx> };
    };
    ctx = await chromium.launchPersistentContext(profileDir, {
      channel: "chrome",
      headless: false,
      viewport: { width: 1280, height: 900 },
    });
  } else {
    ctx = await launch();
  }
  try {
    const page = await ctx.newPage();
    await buildCartAndCheckout(page);
    await page.waitForTimeout(3000);
    const email = process.env.SPIKE_GUEST_EMAIL;
    if (email) {
      const loc = page.locator("input[name=email], input[type=email], #email");
      if ((await loc.count()) > 0) {
        await page.fill("input[name=email], input[type=email], #email", email);
      }
    }
    await fillAddress(page, TEST_ADDRESS);
    await page.waitForTimeout(4000);
    const scraped = await scrapeCheckout(page);
    const scenario = guest ? "e3-guest-existing-email" : "e3-signed-in";
    await page.screenshot({ path: join(SHOTS_DIR, scenario + "-" + Date.now() + ".png"), fullPage: true });
    saveEvidence("trial-" + scenario + ".json", { ts: new Date().toISOString(), scenario, scraped });
    console.log(JSON.stringify(scraped, null, 1).slice(0, 2500));
  } finally {
    await ctx.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
