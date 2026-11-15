// Checkout-discount monitor (read-only): one JSON line per finding
// {severity, code, shop?}. For cron: exit 2 = any CRITICAL, 1 = only WARN,
// 0 = clean, 64 = usage.
//
//   npx vite-node scripts/checkout-discount-monitor.ts [--shop <store>] [--no-admin]
//
// Default shops: every shop with checkoutDiscountEnabled or a recorded
// discount node. --no-admin skips the Admin-based findings
// (DISCOUNT_ACTIVE_WHILE_OFF, DISCOUNT_WINDOW_ENDED/ENDS_SOON) and says so.

import "./require-database-url";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const shop = opt("shop");
const noAdmin = argv.includes("--no-admin");
const allowed = new Set(["--shop", "--no-admin"]);
if (
  argv.some(
    (a, i) => a.startsWith("--") && !allowed.has(a),
  ) ||
  (shop !== undefined && argv.indexOf("--shop") === argv.length - 1)
) {
  console.error(
    "usage: npx vite-node scripts/checkout-discount-monitor.ts [--shop <store>] [--no-admin]",
  );
  process.exit(64);
}
if (noAdmin) {
  console.log(
    JSON.stringify({ note: "no-admin", skipped: ["DISCOUNT_ACTIVE_WHILE_OFF", "DISCOUNT_WINDOW_ENDED", "DISCOUNT_WINDOW_ENDS_SOON"] }),
  );
}

const { default: db } = await import("../app/db.server");
const { runMonitor } = await import("../app/lib/checkout-discount/monitor.server");

const findings = await runMonitor({ db, shop, noAdmin });
for (const f of findings) console.log(JSON.stringify(f));
if (findings.length === 0) console.log(JSON.stringify({ findings: 0 }));

process.exit(
  findings.some((f) => f.severity === "CRITICAL") ? 2 : findings.length > 0 ? 1 : 0,
);
