// tunnel-webhooks.ts — E2 plumbing. Starts a local HMAC-verifying webhook
// receiver, opens a cloudflared quick tunnel, registers orders/paid +
// orders/create subscriptions on the spike store, then idles. Ctrl+C /
// `stop` deletes the subscriptions and kills everything.
// Env: SPIKE_ACTION=start|stop   PORT (default 49322)
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { spawn, ChildProcess } from "node:child_process";
import { join } from "node:path";
import { adminGraphql, saveEvidence, log, redact, appDir } from "./lib";

const workspaceDir = join(appDir, "..", "..");
const CLOUDFLARED = join(workspaceDir, "bin", "cloudflared.exe");
const PORT = Number(process.env.PORT ?? 49322);
const LOG = join(workspaceDir, "webhook-events.jsonl");
const SUBS_FILE = join(workspaceDir, "webhook-subs.json");

const secret = Object.fromEntries(
  readFileSync(join(appDir, ".env"), "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
).SHOPIFY_API_SECRET;

function verifyHmac(raw: Buffer, header: string): boolean {
  const digest = createHmac("sha256", secret).update(raw).digest("base64");
  try { return timingSafeEqual(Buffer.from(digest), Buffer.from(header)); } catch { return false; }
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const ok = verifyHmac(raw, String(req.headers["x-shopify-hmac-sha256"] ?? ""));
    const topic = String(req.headers["x-shopify-topic"] ?? "?");
    const shop = String(req.headers["x-shopify-shop-domain"] ?? "?");
    let orderGid: string | undefined;
    try { orderGid = (JSON.parse(raw.toString("utf8")) as { admin_graphql_api_id?: string }).admin_graphql_api_id; } catch { /* non-JSON */ }
    appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), topic, shop, ok, bytes: raw.length, orderGid }) + "\n");
    log(`webhook ${topic} shop=${shop} hmac=${ok}`);
    res.writeHead(ok ? 200 : 401).end();
  });
});

let tunnel: ChildProcess | null = null;
async function getTunnelUrl(): Promise<string> {
  tunnel = spawn(CLOUDFLARED, ["tunnel", "--url", `http://localhost:${PORT}`, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("tunnel url timeout")), 30000);
    const onData = (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { clearTimeout(t); resolve(m[0]); }
    };
    tunnel!.stdout!.on("data", onData);
    tunnel!.stderr!.on("data", onData);
    tunnel!.on("exit", () => reject(new Error("cloudflared exited")));
  });
}

async function subscribe(topic: string, url: string) {
  const res = await adminGraphql(
    `mutation WS($topic: WebhookSubscriptionTopic!, $webhook: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhook) {
        webhookSubscription { id endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } format }
        userErrors { field message } } }`,
    { topic, webhook: { callbackUrl: url, format: "JSON" } },
  );
  const out = res.webhookSubscriptionCreate as Record<string, unknown>;
  if ((out.userErrors as unknown[]).length) throw new Error(`sub ${topic}: ${JSON.stringify(out.userErrors)}`);
  return (out.webhookSubscription as { id: string }).id;
}

async function main() {
  const action = process.env.SPIKE_ACTION ?? "start";
  if (action === "stop") {
    if (existsSync(SUBS_FILE)) {
      const { ids } = JSON.parse(readFileSync(SUBS_FILE, "utf8")) as { ids: string[] };
      for (const id of ids) {
        const r = await adminGraphql(
          `mutation D($id: ID!) { webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { message } } }`,
          { id },
        );
        log("deleted sub", id, JSON.stringify(r).slice(0, 200));
      }
    }
    return;
  }
  server.listen(PORT);
  const url = await getTunnelUrl();
  log("tunnel", url);
  const ids = [await subscribe("ORDERS_PAID", url), await subscribe("ORDERS_CREATE", url)];
  saveEvidence("webhook-subs.json", { url, ids });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(SUBS_FILE, JSON.stringify({ url, ids }));
  log("subscriptions live; Ctrl+C to tear down (then run SPIKE_ACTION=stop)");
  process.on("SIGINT", () => { tunnel?.kill(); server.close(); process.exit(0); });
}
main().catch((e) => { tunnel?.kill(); console.error(redact(String(e))); process.exit(1); });
