import { connect, buildCartAndCheckout, fillAddress, TEST_ADDRESS } from "./browser";
async function main() {
  const ctx = await connect();
  try {
    const page = await ctx.newPage();
    await buildCartAndCheckout(page);
    await page.waitForTimeout(3000);
    await fillAddress(page, TEST_ADDRESS);
    await page.waitForTimeout(4000);
    const info = await page.evaluate(() => ({
      iframes: [...document.querySelectorAll("iframe")].map((f) => ({ name: f.name, title: f.title, src: (f.src || "").slice(0, 140) })),
      cardInputs: [...document.querySelectorAll("input")].filter((i) => /card|number|expir|cvv|verif/i.test(`${i.name} ${i.id} ${i.autocomplete} ${i.placeholder}`)).map((i) => ({ name: i.name, id: i.id, ac: i.autocomplete })),
      paySectionText: (() => { const m = /pay|payment/i; const el = [...document.querySelectorAll("fieldset,section,div")].find((d) => m.test(d.id || "")); return ((el as HTMLElement)?.innerText || "").slice(0, 500); })(),
    }));
    console.log(JSON.stringify(info, null, 1));
  } finally { await ctx.close(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
