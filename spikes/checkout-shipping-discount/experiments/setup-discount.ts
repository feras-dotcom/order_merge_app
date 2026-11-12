// Step 3 — create the automatic app discount bound to our function handle,
// with the $app:config metafield carrying BOTH the function config keys and
// the input-query variables (windowStart/windowEnd, shop-local no-tz).
import { adminGraphql, saveEvidence, log } from "./lib";
import { M_DISCOUNT_CREATE, Q_DISCOUNT } from "./queries";

const SHOP_TZ = "America/New_York";

function shopLocal(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHOP_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}`;
}

export function configValue(now = new Date(), windowId = "w1", startOffsetDays = -1, endOffsetDays = 7): string {
  const start = new Date(now.getTime() + startOffsetDays * 86400e3);
  const end = new Date(now.getTime() + endOffsetDays * 86400e3);
  return JSON.stringify({
    v: 1,
    windowId,
    percentage: "100.0",
    message: "MergeShip spike: shipping discount",
    windowStart: shopLocal(start),
    windowEnd: shopLocal(end),
  });
}

async function main() {
  const now = new Date();
  const input = {
    title: "MS Spike Shipping Discount",
    functionId: process.env.SPIKE_FUNCTION_ID ?? "checkout-shipping-discount",
    discountClasses: ["SHIPPING"],
    combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
    startsAt: new Date(now.getTime() - 3600e3).toISOString(),
    metafields: [
      { namespace: "$app", key: "config", type: "json", value: configValue(now) },
    ],
  };
  const res = await adminGraphql(M_DISCOUNT_CREATE, { input });
  const created = (res.discountAutomaticAppCreate as Record<string, unknown>) ?? {};
  if ((created.userErrors as unknown[] | undefined)?.length) {
    throw new Error(`create userErrors: ${JSON.stringify(created.userErrors)}`);
  }
  const d = created.automaticAppDiscount as { discountId?: string } | null;
  if (!d?.discountId) throw new Error(`no discount created: ${JSON.stringify(created)}`);
  log("created discount", d.discountId);

  const read = await adminGraphql(Q_DISCOUNT, { id: d.discountId });
  const out = { create: created, read };
  const path = saveEvidence("discount-create.json", out);
  log("saved", path);
  console.log(JSON.stringify(out, null, 1));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
