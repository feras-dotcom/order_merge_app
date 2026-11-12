// e3-guest.ts — E3 guest-email negative control (no order placed).
// PORT=9222 (signed-in positive control) or PORT=9223 (guest Chrome, storefront password
// entered by the founder, NEVER signed in). The test customer's email is fetched in memory
// and typed into the checkout email field for the guest; it is never logged or saved.
import { createRequire } from "node:module";
import { join } from "node:path";
import { admin, appDir, saveEvidence, log } from "./lib";
import { SHOP_ORIGIN, VARIANT_NUMERIC, TEST_ADDRESS, SHOTS_DIR, fillAddress, scrapeCheckout, type BrowserPage } from "./browser";

const port = process.env.PORT ?? "9223";
const mode = port === "9223" ? "guest" : "signed-in-control";
const customerGid = `gid://shopify/Customer/${process.env.SPIKE_CUSTOMER_ID ?? "31443516522863"}`;

async function main() {
  const req = createRequire(join(appDir, "..", "..", "noop.cjs"));
  const { chromium } = req("playwright-core") as {
    chromium: { connectOverCDP(u: string): Promise<{ contexts(): { newPage(): Promise<BrowserPage>; cookies(): Promise<{ name: string; domain: string }[]> }[]; close(): Promise<void> }> };
  };
  const rb = (await admin.graphql(`query($id: ID!) { customer(id: $id) { email } }`, { variables: { id: customerGid } })) as {
    data: { customer: { email: string | null } | null };
  };
  const email = rb.data.customer?.email;
  if (!email) throw new Error("test customer/email not found");

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const ctx = browser.contexts()[0];
  try {
    const cookieNames = (await ctx.cookies()).filter((c) => c.domain.includes("ms-checkout-spike-1111")).map((c) => c.name);
    const hasPasswordCookie = cookieNames.includes("storefront_digest");
    const page = await ctx.newPage();
    await page.goto(`${SHOP_ORIGIN}/cart/${VARIANT_NUMERIC}:1`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await page.goto(`${SHOP_ORIGIN}/checkout`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    const landedOnCheckout = /\/checkouts?\//.test(page.url());
    const emailSel = "input[name=email], input[type=email], #email";
    let typedEmail = false;
    if (mode === "guest" && (await page.locator(emailSel).count()) > 0) {
      await page.fill(emailSel, email);
      typedEmail = true;
    }
    await fillAddress(page, TEST_ADDRESS);
    await page.waitForTimeout(5000);
    const scraped = await scrapeCheckout(page);
    const text = await page.evaluate(() => document.body.innerText);
    const signedInIndicators = {
      mentionsSignOut: /sign out|log out/i.test(text),
      hasSignInLink: /\bsign in\b|\blog in\b/i.test(text),
    };
    const keyLines = text.split("\n").map((l) => l.trim()).filter((l) => /standard|express|free|shipping|subtotal|total|\$\d/i.test(l)).slice(0, 40);
    const shot = join(SHOTS_DIR, `e3-${mode}-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    const scrub = (v: unknown) => JSON.parse(JSON.stringify(v).split(email).join("[EMAIL]").replace(/checkouts\/[^"\s\\]+/g, "checkouts/[TOKEN]").replace(/[?&]key=[^"&]+/g, ""));
    const evidence = scrub({
      ts: new Date().toISOString(),
      scenario: `e3-${mode}`,
      hasPasswordCookie,
      landedOnCheckout,
      typedEmail,
      signedInIndicators,
      keyLines,
      scraped,
    });
    saveEvidence(`e3-${mode}.json`, evidence);
    log(JSON.stringify(evidence).slice(0, 2500));
    await page.close();
  } finally {
    await browser.close(); // disconnects from CDP only
  }
}
main().catch((e) => { console.error(String(e?.message ?? e).split(/\S+@\S+/).join("[EMAIL]")); process.exit(1); });
