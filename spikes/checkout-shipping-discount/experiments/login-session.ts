// login-session.ts — THE ONE FOUNDER-INTERACTIVE STEP.
// Launches headed persistent-profile Chrome, opens the store, and waits until
// the founder has (a) passed the storefront password and (b) signed into the
// hosted customer account. Writes a NON-SECRET status marker and exits;
// later scripts reuse the persisted profile.
// Run: SPIKE_APP_DIR=<isolated app dir> npx jiti spikes/checkout-shipping-discount/experiments/login-session.ts
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { launch, SHOP_ORIGIN, PROFILE_DIR } from "./browser";
import { saveEvidence, log } from "./lib";

const marker = join(PROFILE_DIR, "..", "login-state.json");

async function signedIn(page: { url(): string; content(): Promise<string> }): Promise<boolean> {
  if (!page.url().startsWith(SHOP_ORIGIN + "/account")) return false;
  const html = (await page.content()).toLowerCase();
  return html.includes("order history") || html.includes("log out") || html.includes("sign out");
}

async function main() {
  console.log("================================================================");
  console.log("FOUNDER ACTION REQUIRED — storefront login (one-time)");
  console.log("1. In the Chrome window that opens, enter the storefront password.");
  console.log("2. Sign in via the hosted account page (email + one-time code).");
  console.log("3. When your account page (order history) is visible, press ENTER");
  console.log("   in this terminal. The script auto-detects sign-in too.");
  console.log("================================================================");
  const ctx = await launch();
  const page = await ctx.newPage();
  await page.goto(`${SHOP_ORIGIN}/account`, { waitUntil: "domcontentloaded" });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const enter = new Promise<void>((r) => rl.once("line", () => r()));

  const deadline = Date.now() + 10 * 60_000;
  let detected = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    try {
      if (await signedIn(page)) {
        detected = true;
        break;
      }
      // nudge: re-hit /account so a completed sign-in redirects back to the store
      if (!page.url().includes("/account")) await page.goto(`${SHOP_ORIGIN}/account`, { waitUntil: "domcontentloaded" });
    } catch { /* nav in flight */ }
    if (await Promise.race([enter.then(() => true), page.waitForTimeout(1).then(() => false)])) break;
  }
  rl.close();

  const state = {
    detected,
    confirmedByEnter: !detected,
    ts: new Date().toISOString(),
    profileDir: PROFILE_DIR,
    shop: SHOP_ORIGIN,
  };
  writeFileSync(marker, JSON.stringify(state, null, 1));
  saveEvidence("login-state.json", state);
  log("login state written:", JSON.stringify(state));
  await ctx.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
