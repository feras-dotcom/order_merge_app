import { adminGraphql } from "./lib";
async function main() {
  const r = await adminGraphql(`query { orders(first: 3, sortKey: CREATED_AT, reverse: true) { nodes { id name createdAt } } }`);
  console.log(JSON.stringify(r));
}
main().catch((e) => { console.error(String(e).slice(0,400)); process.exit(1); });
