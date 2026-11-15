// Operator control for the checkout shipping discount (spec E). The
// app-side gate only controls whether the APP projects eligibility
// records — the Shopify automatic discount's status is the only thing
// that stops checkout discounting, so shutdown deactivates it FIRST and
// verifies before touching the app flags.
//
// Dry-run by default — reads and prints state, mutates nothing. --apply
// performs the mutations.
//
//   npx vite-node scripts/checkout-discount-control.ts status         --shop <store> --discount-id <gid>
//   npx vite-node scripts/checkout-discount-control.ts shutdown       --shop <store> --discount-id <gid> --apply
//   npx vite-node scripts/checkout-discount-control.ts prepare-enable --shop <store> --discount-id <gid> --apply
//   npx vite-node scripts/checkout-discount-control.ts activate       --shop <store> --discount-id <gid> --window-id <w<epochMs>> --apply
//   npx vite-node scripts/checkout-discount-control.ts create         --shop <store> [--function-id <gid>] [--percentage <0<p<=100>] [--window-days 14] [--apply]
//   npx vite-node scripts/checkout-discount-control.ts preflight      --shop <store>
//
// prepare-enable prints the derived windowId; pass it to activate's
// --window-id. create resolves the Function id itself (or honors
// --function-id), refuses to create a second MergeShip discount, and
// verifies the new discount deactivated (EXPIRED) before returning;
// preflight is read-only — --apply changes nothing for it. Output is
// codes/ids/booleans only — never the config message or customer data.

import "./require-database-url";

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const shop = opt("shop");
const suppliedDiscountId = opt("discount-id");
const expectedWindowId = opt("window-id");
const functionId = opt("function-id");
const percentage = opt("percentage");
const windowDays = opt("window-days");
const apply = argv.includes("--apply");

const usage =
  "usage: npx vite-node scripts/checkout-discount-control.ts <status|shutdown|prepare-enable|activate|create|preflight> --shop <store> [--discount-id <gid>] [--window-id <id>] [--function-id <gid>] [--percentage <p>] [--window-days <n>] [--apply]\n" +
  "  --discount-id is optional for status/shutdown/activate (defaults to the recorded\n" +
  "  checkoutDiscountNodeId; a supplied id must match it) and REQUIRED for prepare-enable\n" +
  "  (prepare-enable records it). create and preflight take no --discount-id.";
if (
  !["status", "shutdown", "prepare-enable", "activate", "create", "preflight"].includes(
    cmd ?? "",
  ) ||
  !shop
) {
  console.error(usage);
  process.exit(2);
}
if (cmd === "prepare-enable" && !suppliedDiscountId) {
  console.error("prepare-enable requires --discount-id <gid> (the discount it records)");
  process.exit(2);
}
if (cmd === "activate" && !expectedWindowId) {
  console.error("activate requires --window-id <w<epochMs>> (printed by prepare-enable)");
  process.exit(2);
}
if ((cmd === "create" || cmd === "preflight") && suppliedDiscountId) {
  console.error(`${cmd} takes no --discount-id`);
  process.exit(2);
}

// Resolve the discount id: the recorded checkoutDiscountNodeId is the
// default for status/shutdown/activate; an explicit --discount-id that
// disagrees with the recorded id is refused (never operate on an
// unrelated discount).
let discountId = suppliedDiscountId;
if (cmd !== "prepare-enable" && cmd !== "create" && cmd !== "preflight") {
  const { getSettings } = await import("../app/lib/settings.server");
  const recorded = (await getSettings(shop!)).checkoutDiscountNodeId;
  if (suppliedDiscountId && recorded && suppliedDiscountId !== recorded) {
    console.error(
      `error: --discount-id ${suppliedDiscountId} does not match the recorded ${recorded} — refusing`,
    );
    process.exit(2);
  }
  discountId = discountId ?? recorded ?? undefined;
  if (!discountId) {
    console.error("error: no checkout discount node id recorded — run prepare-enable first");
    process.exit(2);
  }
}
if (cmd !== "status" && cmd !== "preflight" && !apply) {
  console.log(`dry-run: re-run with --apply to ${cmd} discount ${cmd === "create" ? "(new)" : discountId} on ${shop}`);
}

const { unauthenticated } = await import("../app/shopify.server");
const control = await import("../app/lib/checkout-discount/discount-control.server");

const { admin } = await unauthenticated.admin(shop!);

// preflight is read-only under every flag — --apply changes nothing.
if (cmd === "preflight") {
  const { runPreflight } = await import("../app/lib/checkout-discount/preflight.server");
  const checks = await runPreflight({ admin, shop: shop! });
  for (const c of checks) {
    console.log(JSON.stringify({ check: c.check, ok: c.ok, detail: c.detail }));
  }
  process.exit(checks.some((c) => c.ok === false) ? 1 : 0);
}

// The print/dry-run/mutation decision lives in cli-dispatch.server.ts so
// the boundary is unit-tested — without --apply no mutation may run.
const { runCheckoutDiscountCommand } = await import(
  "../app/lib/checkout-discount/cli-dispatch.server"
);
process.exit(
  await runCheckoutDiscountCommand({
    cmd: cmd as "status" | "shutdown" | "prepare-enable" | "activate" | "create",
    apply,
    admin,
    shop: shop!,
    discountId,
    expectedWindowId,
    functionId,
    percentage,
    windowDays: windowDays !== undefined ? Number(windowDays) : undefined,
    control,
  }),
);
