// orders-audit.ts — read-only, PII-free: which variant/subtotal/shipping each spike-store test order had,
// to check whether earlier trials ran on a cart where native free shipping could apply.
import { admin, saveEvidence, log } from "./lib";

type Order = {
  name: string;
  createdAt: string;
  currentSubtotalPriceSet: { shopMoney: { amount: string } };
  lineItems: { nodes: { variant: { id: string } | null; title: string }[] };
  shippingLines: { nodes: { title: string; originalPriceSet: { shopMoney: { amount: string } }; discountedPriceSet: { shopMoney: { amount: string } } }[] };
};

async function main() {
  const r = (await admin.graphql(
    `{ orders(first: 60, sortKey: CREATED_AT, reverse: false) { nodes { name createdAt
        currentSubtotalPriceSet { shopMoney { amount } }
        lineItems(first: 3) { nodes { title variant { id } } }
        shippingLines(first: 2) { nodes { title originalPriceSet { shopMoney { amount } } discountedPriceSet { shopMoney { amount } } } }
    } } }`,
  )) as { data: { orders: { nodes: Order[] } } };
  const rows = r.data.orders.nodes.map((o) => ({
    name: o.name,
    createdAt: o.createdAt,
    subtotal: o.currentSubtotalPriceSet.shopMoney.amount,
    variant: o.lineItems.nodes.map((l) => l.variant?.id.split("/").pop()).join(","),
    ship: o.shippingLines.nodes.map((s) => `${s.title}:${s.originalPriceSet.shopMoney.amount}->${s.discountedPriceSet.shopMoney.amount}`).join("|"),
  }));
  saveEvidence("orders-audit.json", { ts: new Date().toISOString(), count: rows.length, rows });
  for (const x of rows) log(`${x.name} ${x.createdAt} sub=${x.subtotal} v=${x.variant} ${x.ship}`);
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
