import { connect, buildCartAndCheckout, fillAddress, scrapeCheckout, TEST_ADDRESS } from "./browser";
import { admin } from "./lib";
import { writeProjection } from "../projection/write";
const ME = process.env.SPIKE_CUSTOMER_ID!;
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
async function main() {
  const ctx = await connect();
  try {
    const page = await ctx.newPage();
    await buildCartAndCheckout(page);
    await page.waitForTimeout(2500);
    await fillAddress(page, TEST_ADDRESS);
    await page.waitForTimeout(3000);
    const withDisc = await scrapeCheckout(page);
    // clear the record, reload, see if the discount disappears
    await writeProjection(admin, ME, () => ({ serialized: JSON.stringify({ recs: [], v: 1 }) }), { sleep });
    await page.evaluate(() => location.reload());
    await page.waitForTimeout(6000);
    const afterClear = await scrapeCheckout(page);
    console.log(JSON.stringify({ withDisc: withDisc.optionLines, afterClear: afterClear.optionLines }, null, 1));
  } finally { await ctx.close(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
