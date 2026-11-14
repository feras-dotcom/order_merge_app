// e2-direct.ts — DIRECT eligibility-propagation measurement. NO orders are placed.
// Authenticated dev customer (signed-in :9222 Chrome), $24.95 cart (native Standard $8.00 / Express $15.00),
// record method = "Standard". Per trial:
//   clear record + Admin readback -> undiscounted baseline (existing checkout E + fresh checkout)
//   -> write record (timestamped) + Admin readback -> poll until the STRICT discounted signal appears
//      in (a) a genuinely FRESH checkout each time and (b) the EXISTING checkout E being reloaded
//   -> clear record + readback -> poll until baseline returns (staleness after revocation).
// Strict signal: see signal.ts (MergeShip message AND Standard $8.00 -> $0 AND Express $15 AND summary $0).
// Env: SPIKE_APP_DIR, SPIKE_CUSTOMER_ID, SPIKE_TRIALS (5), VARIANT (68100323508591), CAP_S (420)
import { connect, TEST_ADDRESS } from "./browser";
import { admin, saveEvidence, log } from "./lib";
import { buildRecord, mergeRecords } from "../projection/records";
import { writeProjection } from "../projection/write";
import { VARIANT, sleep, iso, ms, openExisting, freshObserve, pollUntil, summarize, type Pg, type Obs } from "./e2-lib";

const CID = `gid://shopify/Customer/${(process.env.SPIKE_CUSTOMER_ID ?? "").replace(/^.*\//, "")}`;
const TRIALS = Number(process.env.SPIKE_TRIALS ?? 5);
const shopToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const plusDays = (d: string, n: number) => new Date(new Date(d + "T00:00:00Z").getTime() + n * 86400e3).toISOString().slice(0, 10);


async function setRecord(on: boolean) {
  const t0 = iso();
  let rec: unknown = null;
  if (on) {
    const built = buildRecord(
      { orderId: `gid://shopify/Order/9${String(Date.now()).slice(-9)}`, customerId: CID, currencyCode: "USD",
        shippingAddress: { ...TEST_ADDRESS }, shippingLines: [{ title: "Standard", originalMinor: 800, discountedMinor: 800 }],
        cancelledAt: null, financialStatus: "PAID" },
      { windowId: "w1", expiresOn: plusDays(shopToday(), 3) },
    );
    if (!built.ok) throw new Error(`buildRecord ${built.reason}`);
    rec = built.record;
    await writeProjection(admin, CID, () => ({ serialized: mergeRecords(null, [built.record], { todayDate: shopToday() }).serialized }), { sleep, random: Math.random });
  } else {
    await writeProjection(admin, CID, () => ({ serialized: JSON.stringify({ recs: [], v: 1 }) }), { sleep, random: Math.random });
  }
  const t1 = iso();
  const rb = (await admin.graphql(
    `query($id: ID!) { customer(id: $id) { metafield(namespace: "$app", key: "ship_elig") { jsonValue } } }`,
    { variables: { id: CID } },
  )) as { data: { customer: { metafield: { jsonValue: { recs?: { method: string }[] } } | null } } };
  const t2 = iso();
  const recs = rb.data.customer.metafield?.jsonValue?.recs ?? [];
  void rec;
  return { writeStart: t0, writeEnd: t1, readbackEnd: t2, readbackCount: recs.length, readbackMethod: recs[0]?.method ?? null };
}

async function main() {
  if (!process.env.SPIKE_CUSTOMER_ID) throw new Error("SPIKE_CUSTOMER_ID required");
  const ctx = await connect();
  const trials: Record<string, unknown>[] = [];
  try {
    for (let i = 0; i < TRIALS; i++) {
      const tr: Record<string, unknown> = { trial: i, startedAt: iso() };
      // 1. clear + readback
      tr.clear0 = await setRecord(false);
      // 2. baseline: existing checkout E + fresh checkout must both be undiscounted baseline
      const bw0 = iso();
      let existing: { page: Pg; obs: Obs } | null = null;
      let baselineOk = false;
      for (let a = 0; a < 20 && !baselineOk; a++) {
        if (existing) await existing.page.close();
        existing = await openExisting(ctx);
        const f = await freshObserve(ctx);
        baselineOk = existing.obs.kind === "baseline" && f.kind === "baseline";
        tr.baselineAttempts = a + 1;
        if (!baselineOk) { tr.baselineLast = { existing: existing.obs.kind, fresh: f.kind }; await sleep(10000); }
      }
      tr.baselineConfirmed = baselineOk;
      tr.baselineWaitMs = ms(bw0, iso());
      if (!baselineOk || !existing) { tr.aborted = "baseline never confirmed"; trials.push(tr); break; }
      // 3. write + readback, then poll for the discount
      // polling starts BEFORE the write (overlap): pre-write observations prove the baseline and any
      // post-write baseline observation gives a true lower bound on propagation.
      const appearP = pollUntil("discounted", ctx, existing.page);
      await sleep(3000);
      const w = await setRecord(true);
      tr.write = w;
      const appear = await appearP;
      tr.appear = summarize(appear, "discounted", w.writeEnd);
      // 4. revoke + readback, then poll for the discount to disappear (incl. staleness in the existing checkout)
      const goneP = pollUntil("baseline", ctx, existing.page);
      await sleep(3000);
      const c = await setRecord(false);
      tr.revoke = c;
      const gone = await goneP;
      tr.disappear = summarize(gone, "baseline", c.writeEnd);
      await existing.page.close();
      tr.endedAt = iso();
      log(`trial ${i}`, JSON.stringify({ appear: tr.appear && Object.fromEntries(Object.entries(tr.appear as object).map(([k, v]) => [k, { lo: (v as { lowerBoundMs: number | null }).lowerBoundMs, hi: (v as { upperBoundMs: number | null }).upperBoundMs }])), disappear: Object.fromEntries(Object.entries(tr.disappear as object).map(([k, v]) => [k, { lo: (v as { lowerBoundMs: number | null }).lowerBoundMs, hi: (v as { upperBoundMs: number | null }).upperBoundMs }])) }));
      trials.push(tr);
      saveEvidence("e2-direct.json", { cart: { variant: VARIANT, price: "24.95" }, trials });
    }
  } finally {
    try { await setRecord(false); } catch { /* best effort cleanup */ }
    await ctx.close();
  }
  saveEvidence("e2-direct.json", { cart: { variant: VARIANT, price: "24.95" }, trials });
}
main().catch((e) => { console.error(String(e?.message ?? e).replace(/\S+@\S+/g, "[EMAIL]")); process.exit(1); });
