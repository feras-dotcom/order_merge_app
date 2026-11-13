// discount-state.ts — read-only (SPIKE_ACTION unset) / disable (SPIKE_ACTION=deactivate) / activate for the
// spike's app discount only. Prints sanitized state. Spike store only (lib hard-guards the shop).
import { admin, saveEvidence, log } from "./lib";

const ids = (process.env.SPIKE_DISCOUNT_IDS ?? "gid://shopify/DiscountAutomaticNode/1796967858543").split(",");

async function main() {
  const action = process.env.SPIKE_ACTION ?? "read";
  const out: Record<string, unknown> = { ts: new Date().toISOString(), action, results: [] as unknown[] };
  for (const id of ids) {
    if (action === "deactivate" || action === "activate") {
      const m = action === "deactivate" ? "discountAutomaticDeactivate" : "discountAutomaticActivate";
      const r = (await admin.graphql(
        `mutation($id: ID!) { ${m}(id: $id) { automaticDiscountNode { id automaticDiscount { __typename ... on DiscountAutomaticApp { title status } } } userErrors { field message } } }`,
        { variables: { id } },
      )) as { data: unknown };
      (out.results as unknown[]).push({ id, mutation: m, r: r.data });
    }
    const q = (await admin.graphql(
      `query($id: ID!) { discountNode(id: $id) { id discount { __typename ... on DiscountAutomaticApp { title status discountClasses appDiscountType { functionId title } combinesWith { shippingDiscounts orderDiscounts productDiscounts } } } } }`,
      { variables: { id } },
    ).catch((e) => ({ data: { error: String(e?.message ?? e).slice(0, 500) } }))) as { data: unknown };
    (out.results as unknown[]).push({ id, state: q.data });
  }
  saveEvidence(`discount-state-${action}.json`, out);
  log(JSON.stringify(out, null, 1));
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
