import { connect, buildCartAndCheckout } from "./browser";
async function main() {
  const ctx = await connect();
  try {
    const page = await ctx.newPage();
    await buildCartAndCheckout(page);
    await page.waitForTimeout(4000);
    const info = await page.evaluate(() => ({
      inputs: [...document.querySelectorAll("input")].map((i) => `${i.name}|${i.autocomplete}|${i.type}`).filter((s) => !/off|hidden/.test(s)).slice(0, 40),
      addrSection: (document.body.innerText.match(/ship to[\s\S]{0,300}/i)?.[0] ?? "").slice(0, 300),
    }));
    console.log(JSON.stringify(info, null, 1));
  } finally { await ctx.close(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
