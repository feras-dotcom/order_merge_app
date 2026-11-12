// seed-eligibility.ts — writes $app:ship_elig on a customer via the REAL
// spike projection code (buildRecord + mergeRecords + writeProjection +
// compareDigest CAS). Env: SPIKE_CUSTOMER_EMAIL (required), SPIKE_METHOD
// (shipping title, default "Standard Shipping"), SPIKE_LEFT, SPIKE_EXP
// (YYYY-MM-DD shop-local, default +3 days), SPIKE_CLEAR=1 to empty.
import { admin, saveEvidence, log } from "./lib";
import { buildRecord, mergeRecords } from "../projection/records";
import { writeProjection } from "../projection/write";
import { TEST_ADDRESS } from "./browser";

const SHOP_TZ = "America/New_York";
const shopToday = () => new Date().toLocaleDateString("en-CA", { timeZone: SHOP_TZ });
const plusDays = (d: string, n: number) => {
  const t = new Date(d + "T00:00:00Z").getTime() + n * 86400e3;
  return new Date(t).toISOString().slice(0, 10);
};

async function main() {
  const email = process.env.SPIKE_CUSTOMER_EMAIL;
  if (!email) throw new Error("SPIKE_CUSTOMER_EMAIL required");
  const find = await admin.graphql(
    `query F($q: String!) { customers(first: 1, query: $q) { nodes { id email } } }`,
    { variables: { q: `email:${email}` } },
  );
  const cid = ((find as { data: { customers: { nodes: { id: string }[] } } }).data.customers.nodes[0]?.id) as string | undefined;
  if (!cid) throw new Error(`no customer for email (refusing to create — verify the founder's account)`);
  log("customer", cid);

  const method = process.env.SPIKE_METHOD ?? "Standard Shipping";
  const exp = process.env.SPIKE_EXP ?? plusDays(shopToday(), 3);
  const order = {
    orderId: "gid://shopify/Order/9" + String(Date.now()).slice(-9),
    customerId: cid,
    currencyCode: "USD",
    shippingAddress: { ...TEST_ADDRESS, provinceCode: TEST_ADDRESS.provinceCode },
    shippingLines: [{ title: method, originalMinor: 500, discountedMinor: 500 }],
    cancelledAt: null,
    financialStatus: "PAID",
  };
  const built = buildRecord(order, { windowId: "w1", expiresOn: exp });
  if (!built.ok) throw new Error(`buildRecord refused: ${built.reason}`);
  const rec = built.record;
  if (process.env.SPIKE_LEFT) rec.left = Number(process.env.SPIKE_LEFT);

  const mutate = (cur: unknown) =>
    process.env.SPIKE_CLEAR === "1"
      ? { serialized: JSON.stringify({ recs: [], v: 1 }) }
      : { serialized: mergeRecords(cur, [rec], { todayDate: shopToday() }).serialized };
  const res = await writeProjection(admin, cid, mutate, { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: Math.random });
  log("writeProjection", JSON.stringify(res));

  const rb = await admin.graphql(
    `query RB($id: ID!) { customer(id: $id) { metafield(namespace: "$app", key: "ship_elig") { jsonValue compareDigest } } }`,
    { variables: { id: cid } },
  );
  saveEvidence("seed-eligibility.json", { customerId: cid, record: rec, result: res, readback: rb });
  console.log(JSON.stringify({ record: rec, result: res, readback: rb }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
