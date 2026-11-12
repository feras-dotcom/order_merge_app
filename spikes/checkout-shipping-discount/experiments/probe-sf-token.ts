import { adminGraphql, saveEvidence, redact } from "./lib";
async function main() {
  try {
    const res = await adminGraphql(
      `mutation { storefrontAccessTokenCreate(input: {title: "spike probe"}) {
        storefrontAccessToken { id accessScopes { handle } accessToken title }
        userErrors { field message } } }`,
    );
    const tok = (res.storefrontAccessTokenCreate as Record<string, unknown>)?.storefrontAccessToken as Record<string, unknown> | null;
    if (tok?.accessToken) tok.accessToken = "[REDACTED-PUBLIC-TOKEN]";
    saveEvidence("storefront-token-probe.json", res);
    console.log(JSON.stringify(res, null, 1));
  } catch (e) {
    console.log(redact(String(e)).slice(0, 1500));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
