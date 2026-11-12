// Phase 2 experiment harness: client-credentials Admin access for the
// ISOLATED spike app on the ISOLATED dev store only. Reads credentials from
// <SPIKE_APP_DIR>/.env (git-ignored there), requests a token in memory only,
// and hard-fails if the store/client-id do not match the spike targets.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const EXPECTED_CLIENT_ID = "09fa5573ee4396c41fd0afa1db6d514b";
export const EXPECTED_SHOP = "ms-checkout-spike-1111.myshopify.com";
export const FORBIDDEN_CLIENT_ID = "04b77142ce8ad421f49735b05c7d0a86";
const API_VERSION = "2026-04";

const appDir: string = process.env.SPIKE_APP_DIR ?? "";
if (!appDir) throw new Error("SPIKE_APP_DIR env var must point at the isolated app dir");

const evidenceDir = join(process.cwd(), "docs", "evidence", "checkout-first");
mkdirSync(evidenceDir, { recursive: true });

// ── secrets ──────────────────────────────────────────────────────────────
const envText = readFileSync(join(appDir, ".env"), "utf8");
const env: Record<string, string> = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2];
}
const CLIENT_SECRET: string = env.SHOPIFY_API_SECRET ?? "";
const CLIENT_ID: string = env.SHOPIFY_API_KEY ?? "";

if (CLIENT_ID !== EXPECTED_CLIENT_ID) throw new Error(`client id mismatch: refusing to run`);
if (String(CLIENT_ID) === String(FORBIDDEN_CLIENT_ID)) throw new Error("production client id in env: aborting");
if (!CLIENT_SECRET) throw new Error("SHOPIFY_API_SECRET missing from .env");

// ── redaction ────────────────────────────────────────────────────────────
const REDACT_VALUES = [CLIENT_SECRET];
let liveToken = "";
export function redact(input: unknown): string {
  let s = typeof input === "string" ? input : JSON.stringify(input, null, 2) ?? String(input);
  s = s.replace(/shp[a-z]{2,4}_[A-Za-z0-9]+/g, "[REDACTED-CRED]");
  for (const v of REDACT_VALUES) if (v) s = s.split(v).join("[REDACTED-CRED]");
  if (liveToken) s = s.split(liveToken).join("[REDACTED-TOKEN]");
  s = s.replace(/("?(?:Authorization|X-Shopify-Access-Token)"?\s*[:=]\s*)"?[^"\s,}]+/gi, "$1[REDACTED]");
  return s;
}
export const log = (...args: unknown[]) => console.log(redact(args.map((a) => (typeof a === "string" ? a : a)).join(" ")));

export function saveEvidence(name: string, data: unknown): string {
  const path = join(evidenceDir, name);
  writeFileSync(path, redact(data) + "\n");
  return path;
}

// ── token ────────────────────────────────────────────────────────────────
async function getToken(): Promise<string> {
  if (liveToken) return liveToken;
  const res = await fetch(`https://${EXPECTED_SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`token grant failed HTTP ${res.status}: ${redact(body)}`);
  }
  liveToken = body.access_token;
  log(`token granted; scope=${body.scope ?? "?"}`);
  return liveToken;
}

// ── admin graphql ────────────────────────────────────────────────────────
export async function adminGraphql(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const token = await getToken();
  const res = await fetch(`https://${EXPECTED_SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.errors) {
    throw new Error(`graphql HTTP ${res.status}: ${redact(body).slice(0, 3000)}`);
  }
  return (body.data ?? {}) as Record<string, unknown>;
}

// Adapter satisfying spikes projection's AdminGraphql interface.
export const admin = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) =>
    adminGraphql(query, options?.variables ?? {}).then((data) => ({ data })),
};

export { appDir, evidenceDir, existsSync };
