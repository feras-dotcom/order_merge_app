import { adminGraphql } from "./lib";
async function main() {
  const r = await adminGraphql(`query { products(first: 30) { nodes { title variants(first: 3) { nodes { id title inventoryQuantity inventoryPolicy price } } } } }`) as { products: { nodes: { title: string; variants: { nodes: { id: string; title: string; inventoryQuantity: number; inventoryPolicy: string; price: string }[] } }[] } };
  for (const p of r.products.nodes) for (const v of p.variants.nodes)
    console.log(`${p.title} | ${v.title} | qty=${v.inventoryQuantity} pol=${v.inventoryPolicy} $${v.price} | ${v.id}`);
}
main().catch((e) => { console.error(String(e).slice(0,400)); process.exit(1); });
