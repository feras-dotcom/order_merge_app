// signal-selftest.ts — offline sanity for the strict parser (no network). Run: npx jiti signal-selftest.ts
import { parseSignal } from "./signal";

const base = ["Shipping method", "Choose a shipping method", "Standard", "Thu, Nov 19–Mon, Nov 23", "$8.00", "Express", "Tue, Nov 17–Wed, Nov 18", "$15.00", "Pay with credit card", "Subtotal", "$24.95", "Shipping", "$8.00", "Total", "$32.95"];
const disc = ["Shipping", "Standard ·", "$8.00", "FREE", "Choose a shipping method", "Standard", "Thu, Nov 19–Mon, Nov 23", "$8.00", "FREE", "Express", "Tue, Nov 17–Wed, Nov 18", "$15.00", "Subtotal", "$24.95", "Shipping", "$8.00", "FREE", "MERGESHIP SPIKE: SHIPPING DISCOUNT", "Total", "$24.95"];
const nat = ["Choose a shipping method", "Standard", "FREE", "Express", "$15.00", "Subtotal", "$629.95", "Shipping", "FREE", "Total", "$629.95"];
const genericFree = disc.filter((l) => !/MERGESHIP/.test(l));
const noStrike = ["Choose a shipping method", "Standard", "FREE", "Express", "$15.00", "Subtotal", "$24.95", "Shipping", "FREE", "MERGESHIP SPIKE: SHIPPING DISCOUNT", "Total", "$24.95"];
const cases: [string, string[], string][] = [
  ["baseline", base, "baseline"],
  ["discounted", disc, "discounted"],
  ["native free (no message)", nat, "native-free"],
  ["generic FREE w/o MergeShip message (never success)", genericFree, "native-free"],
  ["message but no struck-through $8", noStrike, "other"],
];
let bad = 0;
for (const [n, l, want] of cases) {
  const got = parseSignal(l.join("\n")).kind;
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${n}: ${got}`);
}
process.exit(bad ? 1 : 0);
