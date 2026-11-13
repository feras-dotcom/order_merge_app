// discount-config-read.ts — read-only: spike discount node dates + $app:config metafield + customer record (no PII).
import { admin, log } from "./lib";

async function main() {
  const r = (await admin.graphql(
    `{ discountNode(id: "gid://shopify/DiscountAutomaticNode/1796967858543") {
        metafield(namespace: "$app", key: "config") { jsonValue }
        discount { ... on DiscountAutomaticApp { status startsAt endsAt asyncUsageCount } } } }`,
  )) as { data: unknown };
  const c = (await admin.graphql(
    `query($id: ID!) { customer(id: $id) { metafield(namespace: "$app", key: "ship_elig") { jsonValue } } }`,
    { variables: { id: "gid://shopify/Customer/31443516522863" } },
  )) as { data: unknown };
  log(JSON.stringify({ now: new Date().toISOString(), discount: r.data, record: c.data }, null, 1));
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
