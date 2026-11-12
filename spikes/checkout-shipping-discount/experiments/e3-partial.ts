// e3-partial.ts — E3(d): open "Use a different address" on the signed-in
// checkout (saved address renders collapsed), then type the key fields one at
// a time and record when the shipping discount first appears.
import { connect, buildCartAndCheckout, scrapeCheckout, TEST_ADDRESS } from "./browser";
import { saveEvidence, log } from "./lib";
const disc = (s: unknown) => /MERGESHIP SPIKE|Discounted price|FREE/i.test(JSON.stringify(s));
async function clickText(page: { evaluate<T, A>(f: (a: A) => T | Promise<T>, arg?: A): Promise<T> }, txt: string) {
  return page.evaluate((t: string) => {
    const el = [...document.querySelectorAll("button, a, [role=button], label")].find((x) => (x.textContent || "").trim().toLowerCase().includes(t));
    if (el) { (el as HTMLElement).click(); return true; }
    return false;
  }, txt);
}
async function main() {
  const ctx = await connect();
  try {
    const page = await ctx.newPage();
    await buildCartAndCheckout(page);
    await page.waitForTimeout(4000);
    const steps: Record<string, unknown>[] = [];
    const snap = async (label: string) => { await page.waitForTimeout(3500); const s = await scrapeCheckout(page); steps.push({ step: label, discounted: disc(s) }); log(label, String(disc(s))); };
    await snap("saved-address-collapsed");
    const opened = await clickText(page, "use a different address");
    log("different-address-click", String(opened));
    await page.waitForTimeout(2500);
    const inputs = await page.evaluate(() => [...document.querySelectorAll("input")].map((i) => `${i.name}|${i.autocomplete}`).filter((s) => s[0] !== "|").slice(0, 30));
    steps.push({ step: "form-inputs", inputs });
    // fill progressively with page.fill (React-safe)
    const fillIf = async (sels: string[], v: string) => { for (const s of sels) { if (await page.locator(s).count()) { await page.fill(s, v); return; } } };
    await fillIf(["input[name=firstName]", "input[autocomplete='shipping given-name']"], TEST_ADDRESS.firstName);
    await fillIf(["input[name=lastName]", "input[autocomplete='shipping family-name']"], TEST_ADDRESS.lastName);
    await snap("names-only");
    await fillIf(["input[name=address1]", "input[autocomplete='shipping address-line1']"], TEST_ADDRESS.address1);
    await snap("+address1");
    await fillIf(["input[name=address2]", "input[autocomplete='shipping address-line2']"], TEST_ADDRESS.address2);
    await fillIf(["input[name=city]", "input[autocomplete='shipping address-level2']"], TEST_ADDRESS.city);
    await snap("+address2+city");
    // province is a select
    try { const sel = (await page.locator("select[name=zone]").count()) ? "select[name=zone]" : "select[autocomplete='shipping address-level1']"; await page.selectOption(sel, { label: TEST_ADDRESS.province }); } catch { /* */ }
    await snap("+province");
    await fillIf(["input[name=postalCode]", "input[autocomplete='shipping postal-code']"], TEST_ADDRESS.zip);
    await snap("+zip (key complete)");
    saveEvidence("e3-partial.json", { ts: new Date().toISOString(), steps });
    console.log(JSON.stringify(steps, null, 1));
  } finally { await ctx.close(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
