import { adminGraphql } from "./lib";
async function main() {
  const r = await adminGraphql(
    `mutation { discountAutomaticFreeShippingCreate(freeShippingAutomaticDiscount: {
      title: "PROBE Native Free Shipping", startsAt: "2026-11-11T00:00:00Z",
      minimumRequirement: { quantity: { greaterThanOrEqualToQuantity: "1" } },
      combinesWith: { orderDiscounts: true, productDiscounts: true }
    }) { automaticDiscountNode { id automaticDiscount { ... on DiscountAutomaticFreeShipping { title status } } } userErrors { field message } } }`,
  );
  console.log(JSON.stringify(r, null, 1).slice(0, 1500));
}
main().catch((e) => { console.error(String(e).slice(0,800)); process.exit(1); });
