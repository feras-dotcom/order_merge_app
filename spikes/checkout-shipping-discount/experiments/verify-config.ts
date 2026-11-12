// Phase-3 verification: PCD access, discount ACTIVE + window covers now,
// $app:ship_elig definition exists. Read-mostly; creates ONE test customer.
import { adminGraphql, saveEvidence, redact } from "./lib";

const out: Record<string, unknown> = {};

async function main() {
  // 1. PCD: find-or-create clearly-named test customer
  try {
    const find = await adminGraphql(
      `{ customers(first: 1, query: "email:spike-wrong-customer@example.com") { nodes { id } } }`,
    );
    let cid = ((find.customers as { nodes: { id: string }[] })?.nodes ?? [])[0]?.id as string | undefined;
    if (!cid) {
      const res = await adminGraphql(
        `mutation { customerCreate(input: {email: "spike-wrong-customer@example.com", firstName: "Spike", lastName: "WrongCust"}) {
          customer { id } userErrors { field message } } }`,
      );
      const cc = res.customerCreate as { customer: { id: string } | null; userErrors: { message: string }[] };
      out.pcdCustomerCreate = cc;
      cid = cc.customer?.id ?? undefined;
    }
    out.testCustomerId = cid ?? null;
    if (cid) {
      const mf = await adminGraphql(
        `mutation MF($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) {
          metafields { id namespace key } userErrors { field message } } }`,
        {
          metafields: [{
            ownerId: cid, namespace: "$app", key: "ship_elig", type: "json",
            value: JSON.stringify({ v: 1, recs: [] }),
          }],
        },
      );
      out.pcdMetafieldsSet = mf.metafieldsSet;
      const rb = await adminGraphql(
        `query RB($id: ID!) { customer(id: $id) { metafield(namespace: "$app", key: "ship_elig") { id jsonValue compareDigest } } }`,
        { id: cid },
      );
      out.pcdReadback = rb;
    }
  } catch (e) {
    out.pcdError = redact(String(e)).slice(0, 800);
  }

  // 2. Discount active + window covers now
  const d = await adminGraphql(
    `query { automaticDiscountNode(id: "gid://shopify/DiscountAutomaticNode/1796967858543") {
      id automaticDiscount { ... on DiscountAutomaticApp { title status startsAt endsAt
        appDiscountType { functionId } combinesWith { orderDiscounts productDiscounts shippingDiscounts } } }
      metafield(namespace: "$app", key: "config") { jsonValue } } }`,
  );
  out.discount = d;
  const cfg = ((d.automaticDiscountNode as { metafield?: { jsonValue?: { windowStart?: string; windowEnd?: string } } })?.metafield?.jsonValue) ?? {};
  const nowNY = new Date().toLocaleString("en-CA", { timeZone: "America/New_York", hour12: false }).replace(", ", "T").replace(/\//g, "-");
  out.windowCheck = { shopLocalNow: nowNY, windowStart: cfg.windowStart, windowEnd: cfg.windowEnd, covers: String(cfg.windowStart) <= nowNY && nowNY <= String(cfg.windowEnd) };

  // 3. ship_elig definition
  const defs = await adminGraphql(
    `{ metafieldDefinitions(first: 10, ownerType: CUSTOMER) { nodes { name namespace key type { name } ownerType } } }`,
  );
  out.metafieldDefinitions = defs;

  saveEvidence("verify-config.json", out);
  console.log(JSON.stringify(out, null, 1).slice(0, 5000));
}
main().catch((e) => { console.error(redact(String(e))); process.exit(1); });
