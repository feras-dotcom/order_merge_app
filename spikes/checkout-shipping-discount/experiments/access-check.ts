// access-check.ts — read-only: can the app read the destination-key fields of a real order? Prints only booleans.
import { admin, adminGraphql, saveEvidence, log } from "./lib";

async function main() {
  const name = process.env.ORDER_NAME ?? "#1037";
  const raw = await adminGraphql(
    `query($q:String!){ orders(first:1, query:$q){ nodes { name displayFinancialStatus customer{id}
      shippingAddress{ firstName lastName company address1 address2 city provinceCode zip countryCode }
      shippingLines(first:2){ nodes{ title originalPriceSet{shopMoney{amount}} discountedPriceSet{shopMoney{amount}} } } } } }`,
    { q: `name:${name.replace("#", "")}` },
  ).catch((e) => ({ thrown: String(e?.message ?? e).slice(0, 300) })) as any;
  const errors = raw.thrown ? (String(raw.thrown).match(/"code": "([A-Z_]+)"/g) ?? [raw.thrown]) : null;
  const o = raw.orders?.nodes?.[0];
  const a = o?.shippingAddress ?? {};
  const present = (k: string) => typeof a[k] === "string" && a[k].length > 0;
  const out = {
    ts: new Date().toISOString(), order: name, authErrors: errors ?? [],
    fields: Object.fromEntries(["firstName", "lastName", "address1", "city", "provinceCode", "zip", "countryCode"].map((k) => [k, present(k)])),
    customerPresent: !!o?.customer?.id, financialStatus: o?.displayFinancialStatus,
    shipping: o?.shippingLines?.nodes?.map((s: any) => `${s.title}:${s.originalPriceSet.shopMoney.amount}->${s.discountedPriceSet.shopMoney.amount}`),
  };
  saveEvidence("name-access-check.json", out);
  log(JSON.stringify(out, null, 1));
}
void admin;
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
