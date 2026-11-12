// Parity runner: every case in cases.mjs goes through (a) the Node
// implementation (via vite-node + node-run.ts) and (b) the BUILT wasm via
// `shopify app function run` (stdin input, --json). Compares deep-equal JSON
// and prints the table. Run from the repo root:
//   node spikes/checkout-shipping-discount/parity/run-parity.mjs
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PARITY_CASES } from "./cases.mjs";

const DIR = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const REPO = join(DIR, "..", "..", "..");
const EXT_DIR =
  process.env.SPIKE_EXT_DIR ??
  "C:/Users/feero/Desktop/mergeship-checkout-spike/app/ms-checkout-spike-app/extensions/checkout-shipping-discount";
const CLI_JS = "C:/Users/feero/Desktop/mergeship-checkout-spike/node_modules/@shopify/cli/bin/run.js";
const EXPORT = process.env.SPIKE_EXPORT ?? "cart-delivery-options-discounts-generate-run";

// (a) Node outputs
execFileSync("node", [join(DIR, "node-run.mjs")], { cwd: REPO, stdio: "inherit" });
const nodeOut = JSON.parse(readFileSync(join(DIR, "out-node.json"), "utf8"));

// (b) wasm outputs via the built function
const wasmOut = {};
let built = existsSync(join(EXT_DIR, "dist", "function.wasm"));
if (!built) {
  console.error(`no dist/function.wasm in ${EXT_DIR} — run shopify app function build first`);
  process.exit(2);
}
for (const c of PARITY_CASES) {
  const res = execFileSync(
    process.execPath,
    [CLI_JS, "app", "function", "run", "--export", EXPORT, "--json", "--path", EXT_DIR],
    { input: JSON.stringify(c.input), encoding: "utf8", env: { ...process.env, SHOPIFY_CLI_NO_ANALYTICS: "1" } },
  );
  const parsed = JSON.parse(res.trim());
  wasmOut[c.name] = { output: parsed.output, success: parsed.success };
}
writeFileSync(join(DIR, "out-wasm.json"), JSON.stringify(wasmOut, null, 2));

// (c) compare
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let fails = 0;
console.log("case".padEnd(34) + "node=wasm");
for (const c of PARITY_CASES) {
  const w = wasmOut[c.name];
  const ok = w && w.success === true && eq(nodeOut[c.name], w.output);
  if (!ok) fails++;
  console.log(c.name.padEnd(34) + (ok ? "EQUAL" : `DIFF  node=${JSON.stringify(nodeOut[c.name])}  wasm=${JSON.stringify(wasmOut[c.name])}`));
}
console.log(fails === 0 ? `parity: ALL ${PARITY_CASES.length} EQUAL` : `parity: ${fails} DIFF`);
process.exit(fails ? 1 : 0);
