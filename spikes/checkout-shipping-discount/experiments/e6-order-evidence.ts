// e6-order-evidence.ts — read an order back via Admin and run the spike's
// detectShippingDiscountGrant on the real JSON shape.
// Env: SPIKE_ORDER_ID (gid or numeric), or SPIKE_ORDER_NAME like "#1001".
import { adminGraphql, saveEvidence } from "./lib";
import { detectShippingDiscountGrant } from "../projection/grant";

const Q_ORDER = `query O($id: ID!) { order(id: $id) {
  id name createdAt processedAt displayFinancialStatus
  shippingLines { title originalPriceSet { shopMoney { amount currencyCode } }
    discountedPriceSet { shopMoney { amount } }
    discountAllocations { allocatedAmountSet { shopMoney { amount } } discountApplication { __typename targetType title } } }
  discountApplications(first: 20) { nodes { __typename targetType title value { __typename ... on PricingPercentageValue { percentage } } } }
  customer { id }
} }`;

async function main() {
  let id = process.env.SPIKE_ORDER_ID;
  if (!id && process.env.SPIKE_ORDER_NAME) {
    const r = await adminGraphql(
      `query F($q: String!) { orders(first: 1, query: $q) { nodes { id } } }`,
      { q: `name:${process.env.SPIKE_ORDER_NAME}` },
    );
    id = ((r.orders as { nodes: { id: string }[] }).nodes[0]?.id);
  }
  if (!id) throw new Error("SPIKE_ORDER_ID or SPIKE_ORDER_NAME required");
  if (!id.startsWith("gid://")) id = `gid://shopify/Order/${id}`;
  const res = await adminGraphql(Q_ORDER, { id });
  const order = res.order as Record<string, unknown>;
  if (!order) throw new Error("order not found");

  // adapt real JSON to detector facts
  const minor = (s: { shopMoney?: { amount?: string } } | undefined, cur: string) =>
    BigInt(Math.round(parseFloat(s?.shopMoney?.amount ?? "0") * 100));
  const facts = {
    shippingLines: ((order.shippingLines as unknown[]) ?? []).map((l) => {
      const line = l as { title?: unknown; originalPriceSet?: { shopMoney?: { amount?: string } }; discountedPriceSet?: { shopMoney?: { amount?: string } }; discountAllocations?: unknown[] };
      return {
        title: String(line.title ?? ""),
        originalMinor: minor(line.originalPriceSet, "USD"),
        discountedMinor: minor(line.discountedPriceSet, "USD"),
        discountAllocations: (line.discountAllocations ?? []).map((a) => {
          const al = a as { allocatedAmountSet?: { shopMoney?: { amount?: string } }; discountApplication?: { title?: string } };
          return { amountMinor: minor(al.allocatedAmountSet, "USD"), applicationTitle: al.discountApplication?.title ?? null };
        }),
      };
    }),
    discountApplications: ((order.discountApplications as { nodes: unknown[] }).nodes ?? []).map((a) => {
      const ap = a as { targetType?: string; title?: string };
      return { targetType: ap.targetType ?? "", title: ap.title ?? null };
    }),
  };
  const verdict = detectShippingDiscountGrant(facts as never, { titleToken: "MergeShip spike" });
  saveEvidence("e6-order.json", { order, facts, verdict });
  console.log(JSON.stringify({ facts, verdict }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
