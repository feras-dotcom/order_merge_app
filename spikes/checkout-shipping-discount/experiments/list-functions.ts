import { adminGraphql, saveEvidence } from "./lib";
async function main() {
  const res = await adminGraphql(`{ shopifyFunctions(first: 10) { nodes { id handle title apiType apiVersion appKey useCreationUi } } }`);
  saveEvidence("functions.json", res);
  console.log(JSON.stringify(res, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
