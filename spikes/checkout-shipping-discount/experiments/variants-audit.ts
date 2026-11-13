// variants-audit.ts — read-only: shippable variants with price + inventory on the SPIKE store.
import { admin, saveEvidence, log } from "./lib";

async function main() {
  const r = (await admin.graphql(
    `{ productVariants(first: 100) { nodes { id title price inventoryQuantity inventoryPolicy product { title status } inventoryItem { requiresShipping } } } }`,
  )) as { data: { productVariants: { nodes: { id: string; title: string; price: string; inventoryQuantity: number | null; inventoryPolicy: string; product: { title: string; status: string }; inventoryItem: { requiresShipping: boolean } }[] } } };
  const rows = r.data.productVariants.nodes
    .filter((v) => v.inventoryItem.requiresShipping && v.product.status === "ACTIVE")
    .map((v) => ({ id: v.id.split("/").pop(), product: v.product.title, price: v.price, qty: v.inventoryQuantity, policy: v.inventoryPolicy }))
    .sort((a, b) => Number(a.price) - Number(b.price));
  saveEvidence("variants-audit.json", { ts: new Date().toISOString(), rows });
  for (const x of rows.slice(0, 25)) log(JSON.stringify(x));
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
