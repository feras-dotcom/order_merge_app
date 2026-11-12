import { adminGraphql } from "./lib";
async function main() {
  const r = await adminGraphql(`query { webhookSubscriptions(first: 10) { nodes { id endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } }`);
  console.log(JSON.stringify(r));
}
main().catch((e) => { console.error(String(e).slice(0,300)); process.exit(1); });
