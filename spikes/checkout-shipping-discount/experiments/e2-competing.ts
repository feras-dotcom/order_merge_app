// INVALID EXPERIMENT (retained for the record): ran on a cart where Standard shipping was natively free and seeded a synthetic record. Do not reuse; see docs/evidence/checkout-first/INVALID-original-e2-e3/README.md
// e2-competing.ts — two simultaneous checkouts for the SAME customer with ONE
// seeded record: proves the stateless Function cannot atomically consume a
// one-use entitlement (both sessions can render the discount).
import { connect, buildCartAndCheckout, fillAddress, scrapeCheckout, TEST_ADDRESS } from "./browser";
import { saveEvidence, log } from "./lib";
async function main() {
  const ctx = await connect();
  try {
    const [p1, p2] = [await ctx.newPage(), await ctx.newPage()];
    for (const p of [p1, p2]) { await buildCartAndCheckout(p); }
    for (const p of [p1, p2]) { await p.waitForTimeout(2000); await fillAddress(p, TEST_ADDRESS); }
    await p1.waitForTimeout(3500);
    const [s1, s2] = [await scrapeCheckout(p1), await scrapeCheckout(p2)];
    // rapid consecutive: reload both once more to double-check stability
    await p1.evaluate(() => location.reload()); await p2.evaluate(() => location.reload());
    await p1.waitForTimeout(5000);
    const [r1, r2] = [await scrapeCheckout(p1), await scrapeCheckout(p2)];
    const disc = (s: unknown) => /MERGESHIP SPIKE|Discounted price|FREE/i.test(JSON.stringify(s));
    const ev = { ts: new Date().toISOString(), tab1: { first: disc(s1), reload: disc(r1), lines: s1.optionLines }, tab2: { first: disc(s2), reload: disc(r2), lines: s2.optionLines }, bothShowed: disc(s1) && disc(s2) };
    saveEvidence("e2-competing.json", ev);
    log("competing", JSON.stringify(ev));
  } finally { await ctx.close(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
