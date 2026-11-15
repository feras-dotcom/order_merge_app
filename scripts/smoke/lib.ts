// Smoke harness lib — ported from the spike's experiments/lib.ts, made
// injectable: credentials come from a caller-supplied env file (never from
// the repo), the store/client-id are parameters, and every network call is
// behind `makeAdmin`. Dev stores only — the dev-store guard itself lives in
// checkout-discount-smoke.ts (plan.partnerDevelopment must be true).
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { spawnSync as spawnSyncT } from "node:child_process";

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

// ── railway ssh admin proxy ────────────────────────────────────────────────
// For operators whose PC is outside the app's Admin API IP allowlist: every
// GraphQL call is spawned through `railway ssh` so it originates from the
// Railway service's allowed IP. The remote side is REMOTE_SCRIPT below —
// stdin JSON in, exactly one JSON line out; the token never leaves the
// Railway container and is never printed.

/** Remote one-shot: reads {store,query,variables} on stdin, token-grants
 *  client_credentials from the service env, posts the query, prints ONE
 *  JSON line. Never prints the token or secret. */
export const REMOTE_SCRIPT = `const chunks=[];
for await (const c of process.stdin) chunks.push(c);
const {store,query,variables}=JSON.parse(Buffer.concat(chunks).toString("utf8"));
const tok=await fetch(\`https://\${store}/admin/oauth/access_token\`,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"client_credentials",client_id:process.env.SHOPIFY_API_KEY??"",client_secret:process.env.SHOPIFY_API_SECRET??""})});
const tb=await tok.json().catch(()=>({}));
if(!tok.ok||!tb.access_token){console.log(JSON.stringify({transport:"token",error:{status:tok.status,body:tb}}));process.exit(0)}
const res=await fetch(\`https://\${store}/admin/api/2026-04/graphql.json\`,{method:"POST",headers:{"Content-Type":"application/json","X-Shopify-Access-Token":tb.access_token},body:JSON.stringify({query,variables})});
const body=await res.json().catch(()=>null);
console.log(JSON.stringify({status:res.status,body}));
process.exit(0);
`;

const STORE_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function makeRailwayAdmin(deps: {
  store: string;
  service?: string; // default "MergeShip" — the Railway service name
  railwayBin?: string; // default "railway"
  cwd?: string; // the linked-project checkout dir railway cli needs
  spawn?: typeof spawnSyncT;
  redactor?: ReturnType<typeof makeRedactor>;
}): SmokeAdmin {
  if (!STORE_RE.test(deps.store)) {
    throw new Error(`invalid store for railway admin: ${deps.store}`);
  }
  const red = deps.redactor ?? makeRedactor();
  const service = deps.service ?? "MergeShip";
  const bin = deps.railwayBin ?? "railway";
  const spawnImpl = deps.spawn ?? spawnSync;
  // The script is shipped to the remote shell as base64 — the store, query
  // and variables travel via stdin JSON, never inside the command line.
  const remoteArg = `echo ${Buffer.from(REMOTE_SCRIPT, "utf8").toString("base64")} | base64 -d > /tmp/rw.mjs && node /tmp/rw.mjs`;

  const adminGraphql = async (
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const r = spawnImpl(
      bin,
      ["ssh", "--service", service, "--", "sh", "-c", remoteArg],
      {
        input: JSON.stringify({ store: deps.store, query, variables }),
        cwd: deps.cwd,
        encoding: "utf8",
        maxBuffer: 1 << 24,
      },
    );
    if ((r as { error?: Error }).error) throw (r as { error?: Error }).error;
    // ssh banners/warnings can precede the payload on stdout — take the LAST
    // line that opens with "{".
    const lines = String(r.stdout ?? "")
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith("{"));
    if (!lines.length) {
      throw new Error(
        `railway ssh produced no output: ${red.redact(String(r.stderr ?? "")).slice(0, 300)}`,
      );
    }
    const out = JSON.parse(lines[lines.length - 1]) as {
      transport?: string;
      error?: unknown;
      status?: number;
      body?: { errors?: unknown; data?: unknown } | null;
    };
    if (out.transport === "token") {
      throw new Error(`token grant failed: ${red.redact(out.error)}`);
    }
    if (typeof out.status !== "number" || out.status < 200 || out.status >= 300 || out.body?.errors) {
      throw new Error(`graphql HTTP ${out.status}: ${red.redact(out.body).slice(0, 3000)}`);
    }
    return (out.body?.data ?? {}) as Record<string, unknown>;
  };

  return {
    adminGraphql,
    admin: { graphql: (query, options) => adminGraphql(query, options?.variables).then((data) => ({ data })) },
  };
}
