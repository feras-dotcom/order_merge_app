// Static + behavioural guard for the dual-secret webhook-auth reconciliation:
// every webhook entry point must go through authenticateWebhook (the
// SHOPIFY_API_SECRET_PREVIOUS-aware wrapper), never authenticate.webhook
// directly. The second half drives handleCheckoutEligibilityWebhook through
// the REAL authenticateWebhook (only ../app/shopify.server is mocked, the way
// tests/webhook-dual-secret.test.ts does).
import "@shopify/shopify-app-remix/adapters/node";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleCheckoutEligibilityWebhook } from "../app/lib/checkout-discount/webhook.server";
import { memoryCheckoutWorkStore } from "../app/lib/checkout-discount/work.server";
import type { CheckoutGateResult } from "../app/lib/checkout-discount/gate.server";

// ── Static coverage scan ─────────────────────────────────────────────────────

const ROUTES_DIR = join(__dirname, "..", "app", "routes");
const EXTRA_FILES = [
  join(__dirname, "..", "app", "lib", "checkout-discount", "webhook.server.ts"),
];

function webhookEntryPoints(): string[] {
  const routes = readdirSync(ROUTES_DIR)
    .filter((f) => /^webhooks\..*\.tsx$/.test(f))
    .map((f) => join(ROUTES_DIR, f));
  return [...routes, ...EXTRA_FILES];
}

const SHOPIFY_SERVER_IMPORT = /import\s*\{[^}]*\bauthenticate\b[^}]*\}\s*from\s*["'][^"']*shopify\.server["']/;
const SDK_WEBHOOK_CALL = /\bauthenticate\.webhook\s*\(/;
// Every webhook entry point must reach authenticateWebhook: directly, or by
// delegating to handleCheckoutEligibilityWebhook — the single checkout choke
// point, itself scanned here and required to reference it literally.
const COMPLIANT_REFERENCE = /\bauthenticateWebhook\b|\bhandleCheckoutEligibilityWebhook\b/;

function scanSource(source: string): string[] {
  const problems: string[] = [];
  if (!COMPLIANT_REFERENCE.test(source)) {
    problems.push("references neither authenticateWebhook nor the checkout webhook helper");
  }
  if (SHOPIFY_SERVER_IMPORT.test(source)) {
    problems.push("imports authenticate from shopify.server");
  }
  if (SDK_WEBHOOK_CALL.test(source)) {
    problems.push("calls authenticate.webhook(");
  }
  return problems;
}

// ── End-to-end through the real authenticateWebhook ──────────────────────────

const SHOP = "reconcile-test.myshopify.com";
const OID = "gid://shopify/Order/4242";
const OLD_SECRET = "previous-client-secret";
const NEW_SECRET = "current-client-secret";
const BODY = JSON.stringify({ admin_graphql_api_id: OID });
const URL = "https://app.example.com/webhooks/orders/paid";

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
  return new Request(URL, {
    method: "POST",
    headers: {
      "X-Shopify-Hmac-Sha256": hmac(secret, body),
      "X-Shopify-Shop-Domain": SHOP,
      "X-Shopify-Topic": "orders/paid",
      "X-Shopify-API-Version": "2026-04",
      "X-Shopify-Webhook-Id": "wh-reconcile-1",
      "Content-Type": "application/json",
    },
    body,
  });
}

vi.stubEnv("SHOPIFY_API_KEY", "test-api-key");
vi.stubEnv("SHOPIFY_APP_URL", "https://app.example.com");
vi.stubEnv("SHOPIFY_API_SECRET", NEW_SECRET);

const GATE_ON: CheckoutGateResult = {
  on: true,
  enabledAt: new Date("2026-10-01T00:00:00Z"),
  mergeWindowHours: 24,
  windowId: "w-test",
};

describe("webhook-auth coverage (static)", () => {
  it("every webhook entry point goes through authenticateWebhook", () => {
    const files = webhookEntryPoints();
    // Sanity: the checkout routes and the converted production routes exist.
    expect(files.length).toBeGreaterThanOrEqual(13);
    const offenders = files
      .map((f) => ({ f, problems: scanSource(readFileSync(f, "utf8")) }))
      .filter((o) => o.problems.length > 0);
    expect(offenders).toEqual([]);
    // The choke point itself must authenticate via the dual-secret wrapper.
    for (const f of EXTRA_FILES) {
      expect(readFileSync(f, "utf8")).toContain("authenticateWebhook(");
    }
  });

  it("the scanner flags a synthetic offending source", () => {
    const bad = [
      `import { authenticate } from "../shopify.server";`,
      `const { topic } = await authenticate.webhook(request);`,
    ].join("\n");
    expect(scanSource(bad)).toEqual([
      "references neither authenticateWebhook nor the checkout webhook helper",
      "imports authenticate from shopify.server",
      "calls authenticate.webhook(",
    ]);
    const good = [
      `import { authenticateWebhook } from "../webhook-auth.server";`,
      `const { topic } = await authenticateWebhook(request);`,
    ].join("\n");
    expect(scanSource(good)).toEqual([]);
  });
});

describe("handleCheckoutEligibilityWebhook through the real authenticateWebhook", () => {
  beforeEach(() => {
    authenticateWebhookMock.mockReset();
    unauthenticatedAdminMock.mockReset();
    vi.stubEnv("SHOPIFY_API_SECRET_PREVIOUS", OLD_SECRET);
  });

  it("accepts a previous-secret-signed delivery and records one work row", async () => {
    // No stored session for the shop: ctx.admin is undefined, so the handler
    // leaves the row for the sweeper instead of inline processing.
    unauthenticatedAdminMock.mockResolvedValue({ admin: undefined, session: undefined });
    const work = memoryCheckoutWorkStore(() => Date.now());

    const res = await handleCheckoutEligibilityWebhook(webhookRequest(OLD_SECRET), "ORDERS_PAID", {
      work,
      gate: async () => GATE_ON,
    });

    expect(res.status).toBe(200);
    // Previous-secret path: the SDK validator was never consulted; the topic
    // was normalized by authenticateWebhook and matched the expected topic.
    expect(authenticateWebhookMock).not.toHaveBeenCalled();
    expect(unauthenticatedAdminMock).toHaveBeenCalledWith(SHOP);
    const row = await work.find(SHOP, OID);
    expect(row).toMatchObject({ status: "PENDING", gen: 1 });
  });

  it("a delivery signed with neither secret is rejected by the primary validator", async () => {
    // The SDK's rejection shape: authenticate.webhook throws a Response.
    authenticateWebhookMock.mockRejectedValue(new Response("Unauthorized", { status: 401 }));
    const work = memoryCheckoutWorkStore(() => Date.now());

    const request = webhookRequest("not-a-real-secret");
    await expect(
      handleCheckoutEligibilityWebhook(request, "ORDERS_PAID", {
        work,
        gate: async () => GATE_ON,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(authenticateWebhookMock).toHaveBeenCalledWith(request);
    expect(await work.find(SHOP, OID)).toBeNull();
  });

  it("is a pass-through to authenticate.webhook when SHOPIFY_API_SECRET_PREVIOUS is unset", async () => {
    delete process.env.SHOPIFY_API_SECRET_PREVIOUS;
    // The primary validator accepts and returns the SDK context shape.
    authenticateWebhookMock.mockResolvedValue({
      apiVersion: "2026-04",
      shop: SHOP,
      topic: "ORDERS_PAID",
      webhookId: "wh-reconcile-1",
      payload: JSON.parse(BODY),
      session: undefined,
      admin: undefined,
    });
    const work = memoryCheckoutWorkStore(() => Date.now());

    const request = webhookRequest(NEW_SECRET);
    const res = await handleCheckoutEligibilityWebhook(request, "ORDERS_PAID", {
      work,
      gate: async () => GATE_ON,
    });

    expect(res.status).toBe(200);
    expect(authenticateWebhookMock).toHaveBeenCalledWith(request);
    expect(unauthenticatedAdminMock).not.toHaveBeenCalled();
    expect(await work.find(SHOP, OID)).toMatchObject({ status: "PENDING", gen: 1 });
  });
});
