import { adminGraphql } from "./lib";
async function main() {
  const r = await adminGraphql(`query { automaticDiscountNode(id: "gid://shopify/DiscountAutomaticNode/1796967858543") {
    automaticDiscount { ... on DiscountAutomaticApp { title status discountClass appDiscountType { functionId appKey title } } } } }`);
  console.log(JSON.stringify(r, null, 1));
}
main().catch((e) => { console.error(String(e).slice(0,500)); process.exit(1); });
