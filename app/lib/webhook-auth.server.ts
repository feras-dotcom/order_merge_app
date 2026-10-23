import { createHmac, timingSafeEqual } from "node:crypto";
import { SessionNotFoundError } from "@shopify/shopify-app-remix/server";
import { authenticate, unauthenticated } from "../shopify.server";

// ── Dual-secret webhook authentication ────────────────────────────────────────
//
// Transition-only support for rotating the app's client secret. Shopify signs
// webhooks with the OLDEST unrevoked client secret, so during the rotation
// window deliveries still arrive signed with the previous secret while OAuth,
// token exchange and token refresh must already use the new one
// (SHOPIFY_API_SECRET).
//
// When SHOPIFY_API_SECRET_PREVIOUS is set, each POST delivery is first checked
// against the previous secret's webhook HMAC (base64 HMAC-SHA256 of the raw
// body — the exact scheme authenticate.webhook uses). Deliveries it does not
// match fall through to authenticate.webhook under the primary secret.
// A matching previous-secret signature only authorizes webhook processing —
// nothing else — and the context is rebuilt from the same headers the SDK
// reads, so handlers see an identical shape.
//
// When the variable is unset (or empty) this is a pass-through to
// authenticate.webhook, so removing the variable restores single-secret
// behaviour with no code change.

type AdminClient = NonNullable<
  Awaited<ReturnType<typeof unauthenticated.admin>>["admin"]
>;
type StoredSession = NonNullable<
  Awaited<ReturnType<typeof unauthenticated.admin>>["session"]
>;

export interface AuthenticatedWebhookContext {
  apiVersion: string;
  shop: string;
  topic: string;
  webhookId: string;
  payload: unknown;
  session?: StoredSession;
  admin?: AdminClient;
}

// Matches the SDK's topic normalization (registry.mjs topicForStorage).
function topicForStorage(topic: string) {
  return topic.toUpperCase().replace(/\/|\./g, "_");
}

function verifyHmac(rawBody: string, secret: string, header: string): boolean {
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const presented = Buffer.from(header, "base64");
  return presented.length === digest.length && timingSafeEqual(presented, digest);
}

export async function authenticateWebhook(
  request: Request,
): Promise<AuthenticatedWebhookContext> {
  const previousSecret = process.env.SHOPIFY_API_SECRET_PREVIOUS;
  const hmacHeader = request.headers.get("X-Shopify-Hmac-Sha256");
  if (!previousSecret || request.method !== "POST" || !hmacHeader) {
    return authenticate.webhook(request);
  }

  // Read the body once via a clone so the primary validator can still consume
  // the original request when the previous-secret check fails.
  const rawBody = await request.clone().text();
  if (!rawBody || !verifyHmac(rawBody, previousSecret, hmacHeader)) {
    return authenticate.webhook(request);
  }

  const shop = request.headers.get("X-Shopify-Shop-Domain");
  const topic = request.headers.get("X-Shopify-Topic");
  const apiVersion = request.headers.get("X-Shopify-API-Version");
  const webhookId = request.headers.get("X-Shopify-Webhook-Id");
  if (!shop || !topic || !apiVersion || !webhookId) {
    // A genuinely valid signature without the required headers: let the
    // primary validator produce its canonical 400.
    return authenticate.webhook(request);
  }

  // Observability for the transition window: a previous-secret match means
  // dual-secret mode is still armed and Shopify (or a forger holding the old
  // secret) signed this delivery with it. Log shop + webhook id only — never
  // the signature or secret. While this keeps firing past the expected ~1h
  // propagation window the rotation is not done; see docs/RUNBOOK.md.
  console.warn(
    `[webhook-auth] previous-secret HMAC accepted shop=${shop} webhookId=${webhookId} topic=${topic}`,
  );

  const { admin, session } = await unauthenticated.admin(shop).catch(
    (err: unknown) => {
      // authenticate.webhook returns session/admin undefined rather than
      // throwing when a delivery arrives for a shop with no stored session
      // (e.g. after uninstall). Mirror that.
      if (err instanceof SessionNotFoundError) {
        return { admin: undefined, session: undefined };
      }
      throw err;
    },
  );

  return {
    apiVersion,
    shop,
    topic: topicForStorage(topic),
    webhookId,
    payload: JSON.parse(rawBody),
    session,
    admin,
  };
}
