// Smoke harness lib — ported from the spike's experiments/lib.ts, made
// injectable: credentials come from a caller-supplied env file (never from
// the repo), the store/client-id are parameters, and every network call is
// behind `makeAdmin`. Dev stores only — the dev-store guard itself lives in
// checkout-discount-smoke.ts (plan.partnerDevelopment must be true).
import { readFileSync } from "node:fs";

export interface SmokeCredentials {
  apiKey: string;
  apiSecret: string;
}

export function parseEnvText(text: string): SmokeCredentials {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return { apiKey: env.SHOPIFY_API_KEY ?? "", apiSecret: env.SHOPIFY_API_SECRET ?? "" };
}

export function loadEnvFile(path: string): SmokeCredentials {
  return parseEnvText(readFileSync(path, "utf8"));
}

// ── redaction: tokens, secrets, shp*_ credentials, auth headers ──────────
export function makeRedactor(extraSecrets: string[] = []) {
  let liveToken = "";
  const redact = (input: unknown): string => {
    let s = typeof input === "string" ? input : JSON.stringify(input, null, 2) ?? String(input);
    s = s.replace(/shp[a-z]{2,4}_[A-Za-z0-9]+/g, "[REDACTED-CRED]");
    for (const v of extraSecrets) if (v) s = s.split(v).join("[REDACTED-CRED]");
    if (liveToken) s = s.split(liveToken).join("[REDACTED-TOKEN]");
    s = s.replace(/("?(?:Authorization|X-Shopify-Access-Token)"?\s*[:=]\s*)"?[^"\s,}]+/gi, "$1[REDACTED]");
    return s;
  };
  return { redact, setToken: (t: string) => (liveToken = t) };
}

export const API_VERSION = "2026-04";

export interface SmokeAdmin {
  /** Raw Admin GraphQL; resolves to `data`; throws on transport/top-level errors. */
  adminGraphql(query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Adapter matching the repo's AdminGraphql/AdminClient shape ({ data }). */
  admin: { graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<{ data: unknown }> };
}

export function makeAdmin(deps: {
  store: string;
  credentials: SmokeCredentials;
  redactor?: ReturnType<typeof makeRedactor>;
  fetchImpl?: typeof fetch;
}): SmokeAdmin {
  const red = deps.redactor ?? makeRedactor([deps.credentials.apiSecret]);
  const fetchImpl = deps.fetchImpl ?? fetch;
  let token = "";

  const getToken = async (): Promise<string> => {
    if (token) return token;
    const res = await fetchImpl(`https://${deps.store}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: deps.credentials.apiKey,
        client_secret: deps.credentials.apiSecret,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string };
    if (!res.ok || !body.access_token) {
      throw new Error(`token grant failed HTTP ${res.status}: ${red.redact(body)}`);
    }
    token = body.access_token;
    red.setToken(token);
    return token;
  };

  const adminGraphql = async (
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const t = await getToken();
    const res = await fetchImpl(`https://${deps.store}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": t },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || body.errors) {
      throw new Error(`graphql HTTP ${res.status}: ${red.redact(body).slice(0, 3000)}`);
    }
    return (body.data ?? {}) as Record<string, unknown>;
  };

  return {
    adminGraphql,
    admin: { graphql: (query, options) => adminGraphql(query, options?.variables).then((data) => ({ data })) },
  };
}
