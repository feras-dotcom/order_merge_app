// Byte-identity check: repo spike sources vs the generated extension copies.
// Usage: node spikes/checkout-shipping-discount/parity/check-sync.mjs [extDir]
import { readFileSync } from "node:fs";
import { join } from "node:path";

const extDir =
  process.argv[2] ??
  "C:/Users/feero/Desktop/mergeship-checkout-spike/app/ms-checkout-spike-app/extensions/checkout-shipping-discount";
const spikeSrc = "spikes/checkout-shipping-discount/extension/src";
const files = [
  "cart_delivery_options_discounts_generate_run.ts",
  "cart_delivery_options_discounts_generate_run.graphql",
  "dest-key.ts",
];
let bad = 0;
for (const f of files) {
  const a = readFileSync(join(spikeSrc, f));
  const b = readFileSync(join(extDir, "src", f));
  const same = Buffer.compare(a, b) === 0;
  console.log(`${same ? "SYNC " : "DIFF "} ${f}`);
  if (!same) bad++;
}
console.log(bad === 0 ? "check-sync: PASS" : `check-sync: FAIL (${bad} files differ)`);
process.exit(bad ? 1 : 0);
