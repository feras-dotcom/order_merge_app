import "@shopify/shopify-app-remix/adapters/node";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { SessionNotFoundError } from "@shopify/shopify-app-remix/server";
import { authenticateWebhook } from "../app/lib/webhook-auth.server";

const NEW_SECRET = "new-client-secret";
const OLD_SECRET = "old-client-secret";
const SHOP = "dual-secret-test.myshopify.com";
const BODY = JSON.stringify({ id: 4242, note: "webhook" });
const WEBHOOK_URL = `https://app.example.com/webhooks/orders/create`;

const authenticateWebhookMock = vi.fn();
const unauthenticatedAdminMock = vi.fn();

vi.mock("../app/shopify.server", () => ({
  apiVersion: "2026-04",
  authenticate: { webhook: (...args: unknown[]) => authenticateWebhookMock(...args) },
  unauthenticated: { admin: (...args: unknown[]) => unauthenticatedAdminMock(...args) },
}));

function hmac(secret: string, body: string) {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

function webhookRequest(secret: string, body = BODY) {
  return new Request(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "X-Shopify-Hmac-Sha256": hmac(secret, body),
      "X-Shopify-Shop-Domain": SHOP,
      "X-Shopify-Topic": "orders/create",
      "X-Shopify-API-Version": "2026-04",
      "X-Shopify-Webhook-Id": "wh-test-1",
      "Content-Type": "application/json",
    },
    body,
  });
}

vi.stubEnv("SHOPIFY_API_KEY", "test-api-key");
vi.stubEnv("SHOPIFY_APP_URL", "https://app.example.com");
vi.stubEnv("SHOPIFY_API_SECRET", NEW_SECRET);

describe("authenticateWebhook (dual-secret transition)", () => {
  beforeEach(() => {
    authenticateWebhookMock.mockReset();
    unauthenticatedAdminMock.mockReset();
    vi.stubEnv("SHOPIFY_API_SECRET_PREVIOUS", OLD_SECRET);
  });

  it("accepts a delivery signed with the previous secret and builds context", async () => {
    const session = { id: `offline_${SHOP}` };
    const admin = { graphql: vi.fn() };
    unauthenticatedAdminMock.mockResolvedValue({ admin, session });

    const ctx = await authenticateWebhook(webhookRequest(OLD_SECRET));

    expect(ctx.shop).toBe(SHOP);
    expect(ctx.topic).toBe("ORDERS_CREATE");
    expect(ctx.webhookId).toBe("wh-test-1");
    expect(ctx.payload).toEqual(JSON.parse(BODY));
    expect(ctx.session).toBe(session);
    expect(ctx.admin).toBe(admin);
    expect(authenticateWebhookMock).not.toHaveBeenCalled();
  });

  it("returns undefined session/admin when the shop has no stored session", async () => {
    unauthenticatedAdminMock.mockRejectedValue(
      new SessionNotFoundError("no session"),
    );

    const ctx = await authenticateWebhook(webhookRequest(OLD_SECRET));

    expect(ctx.shop).toBe(SHOP);
    expect(ctx.session).toBeUndefined();
    expect(ctx.admin).toBeUndefined();
  });

  it("falls through to the primary secret for new-secret signatures", async () => {
    const marker = { topic: "ORDERS_CREATE", shop: SHOP };
    authenticateWebhookMock.mockResolvedValue(marker);
    const request = webhookRequest(NEW_SECRET);

    const ctx = await authenticateWebhook(request);

    expect(ctx).toBe(marker);
    expect(authenticateWebhookMock).toHaveBeenCalledWith(request);
    expect(unauthenticatedAdminMock).not.toHaveBeenCalled();
  });

  it("delegates tampered signatures to the primary validator", async () => {
    const marker = { rejected: true };
    authenticateWebhookMock.mockResolvedValue(marker);
    // HMAC computed over the original body, but the delivered body was altered.
    const request = new Request(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "X-Shopify-Hmac-Sha256": hmac(OLD_SECRET, BODY),
        "X-Shopify-Shop-Domain": SHOP,
        "X-Shopify-Topic": "orders/create",
        "X-Shopify-API-Version": "2026-04",
        "X-Shopify-Webhook-Id": "wh-test-1",
        "Content-Type": "application/json",
      },
      body: BODY + "tampered",
    });

    const ctx = await authenticateWebhook(request);

    expect(ctx).toBe(marker);
    expect(authenticateWebhookMock).toHaveBeenCalledTimes(1);
    expect(unauthenticatedAdminMock).not.toHaveBeenCalled();
  });

  it("delegates to the primary validator when the HMAC header is missing", async () => {
    const marker = { noHmac: true };
    authenticateWebhookMock.mockResolvedValue(marker);
    const request = new Request(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "X-Shopify-Shop-Domain": SHOP,
        "X-Shopify-Topic": "orders/create",
        "X-Shopify-API-Version": "2026-04",
        "X-Shopify-Webhook-Id": "wh-test-1",
        "Content-Type": "application/json",
      },
      body: BODY,
    });

    const ctx = await authenticateWebhook(request);

    expect(ctx).toBe(marker);
    expect(authenticateWebhookMock).toHaveBeenCalledWith(request);
    expect(unauthenticatedAdminMock).not.toHaveBeenCalled();
  });

  it("delegates a malformed base64 HMAC header to the primary validator", async () => {
    const marker = { malformed: true };
    authenticateWebhookMock.mockResolvedValue(marker);
    const request = new Request(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "X-Shopify-Hmac-Sha256": "!!!not-base64!!!",
        "X-Shopify-Shop-Domain": SHOP,
        "X-Shopify-Topic": "orders/create",
        "X-Shopify-API-Version": "2026-04",
        "X-Shopify-Webhook-Id": "wh-test-1",
        "Content-Type": "application/json",
      },
      body: BODY,
    });

    const ctx = await authenticateWebhook(request);

    expect(ctx).toBe(marker);
    expect(authenticateWebhookMock).toHaveBeenCalledWith(request);
    expect(unauthenticatedAdminMock).not.toHaveBeenCalled();
  });

  it("delegates a valid previous-secret signature missing required headers", async () => {
    const marker = { canonical400: true };
    authenticateWebhookMock.mockResolvedValue(marker);
    const request = new Request(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "X-Shopify-Hmac-Sha256": hmac(OLD_SECRET, BODY),
        "X-Shopify-Shop-Domain": SHOP,
        // X-Shopify-Topic / API-Version / Webhook-Id deliberately absent.
        "Content-Type": "application/json",
      },
      body: BODY,
    });

    const ctx = await authenticateWebhook(request);

    expect(ctx).toBe(marker);
    expect(authenticateWebhookMock).toHaveBeenCalledWith(request);
    expect(unauthenticatedAdminMock).not.toHaveBeenCalled();
  });

  it("is a pure pass-through when SHOPIFY_API_SECRET_PREVIOUS is unset", async () => {
    delete process.env.SHOPIFY_API_SECRET_PREVIOUS;
    const marker = { delegated: true };
    authenticateWebhookMock.mockResolvedValue(marker);
    const request = webhookRequest(OLD_SECRET);

    const ctx = await authenticateWebhook(request);

    expect(ctx).toBe(marker);
    expect(authenticateWebhookMock).toHaveBeenCalledWith(request);
  });

  it("delegates non-POST requests to the primary validator", async () => {
    const marker = { method405: true };
    authenticateWebhookMock.mockResolvedValue(marker);
    const request = new Request(WEBHOOK_URL, { method: "GET" });

    const ctx = await authenticateWebhook(request);

    expect(ctx).toBe(marker);
    expect(authenticateWebhookMock).toHaveBeenCalledWith(request);
  });
});
