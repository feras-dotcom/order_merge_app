import { adminGraphql } from "./lib";
import { M_DISCOUNT_UPDATE, Q_DISCOUNT } from "./queries";
const DISCOUNT_ID = "gid://shopify/DiscountAutomaticNode/1796967858543";
async function main() {
  const pct = process.env.SPIKE_PCT;
  if (!pct) throw new Error("SPIKE_PCT required");
  const read = await adminGraphql(Q_DISCOUNT, { id: DISCOUNT_ID });
  const cfg = (read.automaticDiscountNode as { metafield?: { jsonValue?: Record<string, unknown> } })?.metafield?.jsonValue ?? {};
  const input = {
    title: "MS Spike Shipping Discount",
    combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
    metafields: [{ namespace: "$app", key: "config", type: "json",
      value: JSON.stringify({ ...cfg, percentage: pct }) }],
  };
  const r = await adminGraphql(M_DISCOUNT_UPDATE, { id: DISCOUNT_ID, input });
  const errs = (r.discountAutomaticAppUpdate as { userErrors?: unknown[] })?.userErrors ?? [];
  if (errs.length) throw new Error(JSON.stringify(errs));
  console.log(`percentage -> ${pct} OK`);
}
main().catch((e) => { console.error(e); process.exit(1); });
