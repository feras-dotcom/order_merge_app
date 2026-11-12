// Step 2 — read-only store facts via Admin GraphQL 2026-04.
import { adminGraphql, saveEvidence, log, redact } from "./lib";
import { Q_SHOP, Q_SHIPPING, Q_PRODUCTS, Q_LOCATIONS } from "./queries";

async function main() {
  const facts: Record<string, unknown> = {};
  for (const [name, q] of Object.entries({
    shop: Q_SHOP,
    deliveryProfiles: Q_SHIPPING,
    products: Q_PRODUCTS,
    locations: Q_LOCATIONS,
  })) {
    try {
      facts[name] = await adminGraphql(q);
    } catch (e) {
      facts[name] = { error: redact(String(e)).slice(0, 1200) };
      log(`${name}: ${redact(String(e)).slice(0, 300)}`);
    }
  }
  const path = saveEvidence("store-facts.json", facts);
  log("saved", path);
  console.log(JSON.stringify(facts, null, 1).slice(0, 6000));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
