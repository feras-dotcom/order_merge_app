// e1-matrix.ts — E1 scenario runner for handoff 2. Each row: set Admin-side
// state (seed/clear eligibility, config window) then run a browser checkout
// trial. The founder's signed-in customer email comes from
// SPIKE_CUSTOMER_EMAIL; SPIKE_WRONG_EMAIL = the second test customer.
// Usage: SPIKE_APP_DIR=.. SPIKE_CUSTOMER_EMAIL=.. npx jiti .../e1-matrix.ts [only-scenario]
import { runTrial } from "./checkout-trial";
import { admin, adminGraphql, saveEvidence } from "./lib";
import { buildRecord, mergeRecords } from "../projection/records";
import { writeProjection } from "../projection/write";
import { TEST_ADDRESS } from "./browser";
import { M_DISCOUNT_UPDATE, Q_DISCOUNT } from "./queries";

const DISCOUNT_ID = "gid://shopify/DiscountAutomaticNode/1796967858543";
const shopToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

async function seedFor(email: string, addr: typeof TEST_ADDRESS, method: string, win = "w1", exp?: string) {
  const find = await admin.graphql(
    `query F($q: String!) { customers(first: 1, query: $q) { nodes { id } } }`,
    { variables: { q: email.startsWith("gid://") ? `id:${email.split("/").pop()}` : `email:${email}` } },
  );
  const cid = (find as { data: { customers: { nodes: { id: string }[] } } }).data.customers.nodes[0]?.id;
  if (!cid) throw new Error(`customer not found: ${email.slice(0, 3)}…`);
  const built = buildRecord(
    {
      orderId: `gid://shopify/Order/9${String(Date.now()).slice(-9)}`,
      customerId: cid, currencyCode: "USD",
      shippingAddress: { ...addr, provinceCode: addr.provinceCode },
      shippingLines: [{ title: method, originalMinor: 500, discountedMinor: 500 }],
      cancelledAt: null, financialStatus: "PAID",
    },
    { windowId: win, expiresOn: exp ?? `${Number(shopToday().slice(0, 4))}-12-31` },
  );
  if (!built.ok) throw new Error(`buildRecord ${built.reason}`);
  await writeProjection(admin, cid, (cur) => ({ serialized: mergeRecords(cur, [built.record], { todayDate: shopToday() }).serialized }),
    { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  return built.record;
}

async function clearFor(email: string) {
  const find = await admin.graphql(`query F($q: String!) { customers(first: 1, query: $q) { nodes { id } } }`, { variables: { q: `email:${email}` } });
  const cid = (find as { data: { customers: { nodes: { id: string }[] } } }).data.customers.nodes[0]?.id;
  if (cid) await writeProjection(admin, cid, () => ({ serialized: JSON.stringify({ recs: [], v: 1 }) }), { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
}

async function setWindow(start: string, end: string) {
  const read = await adminGraphql(Q_DISCOUNT, { id: DISCOUNT_ID });
  const cfg = (read.automaticDiscountNode as { metafield?: { jsonValue?: Record<string, unknown> } })?.metafield?.jsonValue ?? {};
  const input = {
    title: "MS Spike Shipping Discount",
    combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
    metafields: [{ namespace: "$app", key: "config", type: "json",
      value: JSON.stringify({ ...cfg, windowStart: start, windowEnd: end }) }],
  };
  const r = await adminGraphql(M_DISCOUNT_UPDATE, { id: DISCOUNT_ID, input });
  const errs = (r.discountAutomaticAppUpdate as { userErrors?: unknown[] })?.userErrors ?? [];
  if (errs.length) throw new Error(JSON.stringify(errs));
}

const rows: unknown[] = [];
async function scenario(name: string, setup: () => Promise<void>, trialOpts?: Parameters<typeof runTrial>[0]) {
  await setup();
  const ev = await runTrial({ ...trialOpts, scenario: name });
  rows.push({ scenario: name, scraped: ev.scraped });
}

async function main() {
  const ME = process.env.SPIKE_CUSTOMER_ID ?? process.env.SPIKE_CUSTOMER_EMAIL;
  const OTHER = process.env.SPIKE_WRONG_EMAIL ?? "spike-wrong-customer@example.com";
  const METHOD = process.env.SPIKE_METHOD ?? "Standard Shipping";
  if (!ME) throw new Error("SPIKE_CUSTOMER_ID or SPIKE_CUSTOMER_EMAIL required");
  const only = process.argv[2];

  const all: [string, () => Promise<void>, Parameters<typeof runTrial>[0]?][] = [
    ["e1-no-record", async () => { await clearFor(ME); }],
    ["e1-matching", async () => { await seedFor(ME, TEST_ADDRESS, METHOD); }],
    ["e1-other-customer", async () => { await clearFor(ME); await seedFor(OTHER, TEST_ADDRESS, METHOD); }],
    ["e1-diff-street", async () => { await clearFor(ME); await seedFor(ME, { ...TEST_ADDRESS, address1: "999 Other Avenue" }, METHOD); }],
    ["e1-expired-record", async () => { await clearFor(ME); await seedFor(ME, TEST_ADDRESS, METHOD, "w1", "2026-01-01"); }],
    ["e1-window-closed", async () => { await clearFor(ME); await seedFor(ME, TEST_ADDRESS, METHOD); await setWindow("2026-01-01T00:00:00", "2026-01-02T00:00:00"); }],
  ];
  for (const [name, setup, opts] of all) {
    if (only && name !== only) continue;
    await scenario(name, setup, opts);
  }
  // restore open window + a clean eligibility state
  await setWindow("2026-11-10T00:00:00", "2026-11-18T23:59:59");
  await clearFor(ME);
  saveEvidence("e1-matrix.json", rows);
  console.log(JSON.stringify(rows, null, 1).slice(0, 6000));
}
main().catch((e) => { console.error(e); process.exit(1); });
