// store-discounts-audit.ts — read-only: list every automatic + code discount on the SPIKE store
// (type, status, class, combinesWith) and the customer eligibility metafield state (no PII).
import { admin, saveEvidence, log } from "./lib";

async function main() {
  const auto = (await admin.graphql(
    `{ automaticDiscountNodes(first: 50) { nodes { id automaticDiscount {
        __typename
        ... on DiscountAutomaticApp { title status discountClasses combinesWith { shippingDiscounts orderDiscounts productDiscounts } startsAt endsAt }
        ... on DiscountAutomaticBasic { title status discountClasses startsAt endsAt }
        ... on DiscountAutomaticBxgy { title status discountClasses startsAt endsAt }
        ... on DiscountAutomaticFreeShipping { title status discountClasses startsAt endsAt minimumRequirement { __typename } }
    } } } }`,
  )) as { data: unknown };
  const code = (await admin.graphql(
    `{ codeDiscountNodes(first: 50) { nodes { id codeDiscount { __typename
        ... on DiscountCodeFreeShipping { title status startsAt endsAt }
        ... on DiscountCodeBasic { title status startsAt endsAt }
        ... on DiscountCodeApp { title status startsAt endsAt }
    } } } }`,
  )) as { data: unknown };
  const meta = (await admin.graphql(
    `query($id: ID!) { customer(id: $id) { metafield(namespace: "$app", key: "ship_elig") { jsonValue } } }`,
    { variables: { id: "gid://shopify/Customer/31443516522863" } },
  )) as { data: { customer: { metafield: { jsonValue: { recs?: unknown[] } } | null } } };
  const out = {
    ts: new Date().toISOString(),
    automatic: auto.data,
    code: code.data,
    eligibilityRecordCount: meta.data.customer?.metafield?.jsonValue?.recs?.length ?? null,
  };
  saveEvidence("store-discounts-audit.json", out);
  log(JSON.stringify(out, null, 1));
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
