import { adminGraphql } from "./lib";
async function main() {
  const r = await adminGraphql(
    `mutation { discountAutomaticDelete(id: "gid://shopify/DiscountAutomaticNode/1797068980591") { deletedAutomaticDiscountId userErrors { field message } } }`,
  );
  console.log(JSON.stringify(r).slice(0, 400));
}
main().catch((e) => { console.error(String(e).slice(0,500)); process.exit(1); });
