// Checkout-discount exposure report (read-only). Counts the durable work
// rows per shop and, with --orders, pages the shop's Admin orders since
// --since, detects granted shipping discounts with the engine's own
// detector, sums them per currency and classifies each grant order
// merged / open / unmerged_expired (realized exposure).
//
//   npx vite-node scripts/checkout-discount-report.ts \
//     --shop <store> --since <iso> [--orders] \
//     [--cap-grants N] [--cap-amount X.XX] [--currency USD]
//
// Without --shop every shop with checkoutDiscountEnabled or a recorded
// discount node is reported. Exit 0 = within caps, overdraw 0, not
// truncated; exit 1 = cap breach, overdraw > 0, truncated, or any Admin
// read error; exit 64 = usage. Output is ids/codes/counts/amounts only.

import "./require-database-url";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const shop = opt("shop");
const since = opt("since");
const withOrders = argv.includes("--orders");
const capGrants = opt("cap-grants");
const capAmount = opt("cap-amount");
const currency = opt("currency");

const usage =
  "usage: npx vite-node scripts/checkout-discount-report.ts [--shop <store>] [--since <iso>] " +
  "[--orders] [--cap-grants N] [--cap-amount X.XX] [--currency USD]";
if (argv.some((a) => a.startsWith("--") && !["--shop", "--since", "--orders", "--cap-grants", "--cap-amount", "--currency"].includes(a))) {
  console.error(usage);
  process.exit(64);
}
const sinceDate = since !== undefined ? new Date(since) : undefined;
if (since !== undefined && !Number.isFinite(sinceDate!.getTime())) {
  console.error("--since must be an ISO timestamp");
  process.exit(64);
}
if (capGrants !== undefined && !/^\d+$/.test(capGrants)) {
  console.error("--cap-grants must be a non-negative integer");
  process.exit(64);
}
if (capAmount !== undefined && !/^\d+(\.\d+)?$/.test(capAmount)) {
  console.error("--cap-amount must be a decimal like 125.00");
  process.exit(64);
}

const { default: db } = await import("../app/db.server");
const { runReport, reportShops } = await import(
  "../app/lib/checkout-discount/report.server"
);

const shops = await reportShops(db, shop);
if (shops.length === 0) {
  console.log(JSON.stringify({ shops: 0, note: "no shops with checkout discount enabled or recorded" }));
  process.exit(0);
}

let failed = false;
for (const s of shops) {
  try {
    const admin = withOrders
      ? (await (await import("../app/shopify.server")).unauthenticated.admin(s)).admin
      : undefined;
    const r = await runReport({
      db,
      shop: s,
      since: sinceDate,
      orders: withOrders,
      admin,
      capGrants: capGrants !== undefined ? Number(capGrants) : undefined,
      capAmount,
      currency,
    });
    console.log(JSON.stringify({ section: "work", ...r.work, shop: s }));
    if (r.orders) console.log(JSON.stringify({ section: "orders", ...r.orders, shop: s }));
    console.log(JSON.stringify({ section: "caps", ...r.caps, withinCaps: r.withinCaps, shop: s }));
    if (!r.withinCaps) failed = true;
  } catch (err: any) {
    console.log(
      JSON.stringify({ section: "error", shop: s, code: "ADMIN_OR_DB_READ_FAILED" }),
    );
    console.error(`error for ${s}: ${err?.message ?? err}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
