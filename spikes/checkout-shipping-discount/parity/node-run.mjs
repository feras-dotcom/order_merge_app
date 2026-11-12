// Node-side parity runner: bundles the spike Function src with esbuild and
// evaluates every case, writing out-node.json. Run from repo root.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PARITY_CASES } from "./cases.mjs";

const DIR = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const REPO = join(DIR, "..", "..", "..");
const ENTRY = join(DIR, "..", "extension", "src", "cart_delivery_options_discounts_generate_run.ts");
const BUNDLE = join(DIR, "out-fn.mjs");

execSync(`"${join(REPO, "node_modules", ".bin", "esbuild")}" "${ENTRY}" --bundle --format=esm --platform=node --outfile="${BUNDLE}"`, {
  cwd: REPO,
  stdio: "inherit",
});
const { cartDeliveryOptionsDiscountsGenerateRun } = await import(pathToFileURL(BUNDLE).href);
const out = {};
for (const c of PARITY_CASES) out[c.name] = cartDeliveryOptionsDiscountsGenerateRun(c.input);
writeFileSync(join(DIR, "out-node.json"), JSON.stringify(out, null, 2));
console.log(`wrote ${Object.keys(out).length} node outputs`);
