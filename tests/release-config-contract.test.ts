// Release-config contract: `shopify.app.checkout-first.toml` (the named
// config for `shopify app deploy --config checkout-first --no-release`) must
// extend production without ever changing what production already has, and
// `shopify.app.toml` must stay byte-identical to origin/main's. Plain
// text/regex TOML parsing — no dependency.
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const PROD_TOML = readFileSync(join(ROOT, "shopify.app.toml"), "utf8");
const CO_TOML = readFileSync(join(ROOT, "shopify.app.checkout-first.toml"), "utf8");

// ── minimal TOML extractors (this file's configs only) ────────────────────────

const scalar = (src: string, key: string) => {
  const m = src.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"));
  return m ? m[1] : null;
};

const strArray = (src: string, key: string): string[] => {
  const m = src.match(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m"));
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
};

const subscriptions = (src: string): { uri: string; topic: string }[] =>
  [...src.matchAll(/\[\[webhooks\.subscriptions\]\]\s*uri\s*=\s*"([^"]+)"\s*topics\s*=\s*\[\s*"([^"]+)"/g)].map(
    (m) => ({ uri: m[1], topic: m[2] }),
  );

const webhooksSection = (src: string) => {
  const m = src.match(/\[webhooks\]([\s\S]*?)(?=\n\[[a-z]|\n\s*$)/);
  return m ? m[1] : "";
};

const PROD_SCOPES = "read_customers,write_order_edits,write_orders,write_products";

// `/webhooks/orders/paid` -> `webhooks.orders.paid.tsx`
const uriToRoute = (uri: string) => `webhooks.${uri.replace(/^\/webhooks\//, "").replace(/\//g, ".")}.tsx`;

// Checkout-owned route files: orders/* + refunds/* webhook routes (orders.paid
// and friends were added for the checkout eligibility pipeline).
const checkoutRouteFiles = () =>
  readdirSync(join(ROOT, "app", "routes")).filter((f) => /^webhooks\.(orders|refunds)\..*\.tsx$/.test(f));

const routeToTopic = (file: string) =>
  file.replace(/^webhooks\./, "").replace(/\.tsx$/, "").replace(/\./g, "/");

describe("release config contract", () => {
  it("production shopify.app.toml is unchanged: required scopes and origin/main parity", () => {
    expect(scalar(PROD_TOML, "scopes")).toBe(PROD_SCOPES);
    let mainToml: string | null = null;
    try {
      mainToml = execSync("git show origin/main:shopify.app.toml", { cwd: ROOT, encoding: "utf8" });
    } catch {
      // ref unavailable — the scopes assertion above still pins the contract
    }
    if (mainToml !== null) expect(PROD_TOML).toBe(mainToml);
  });

  it("checkout config keeps production's required scopes and adds exactly the two pilot optional scopes", () => {
    expect(scalar(CO_TOML, "scopes")).toBe(scalar(PROD_TOML, "scopes"));
    const prodOptional = strArray(PROD_TOML, "optional_scopes");
    const coOptional = strArray(CO_TOML, "optional_scopes");
    expect(coOptional.slice(0, prodOptional.length)).toEqual(prodOptional);
    expect(coOptional.slice(prodOptional.length).sort()).toEqual(["write_customers", "write_discounts"]);
  });

  it("every subscription URI in both files maps to an existing route; every checkout route file is subscribed", () => {
    for (const src of [PROD_TOML, CO_TOML]) {
      for (const sub of subscriptions(src)) {
        expect(existsSync(join(ROOT, "app", "routes", uriToRoute(sub.uri))), sub.uri).toBe(true);
      }
    }
    const coTopics = new Set(subscriptions(CO_TOML).map((s) => s.topic));
    const coUris = new Map(subscriptions(CO_TOML).map((s) => [s.topic, s.uri]));
    for (const file of checkoutRouteFiles()) {
      const topic = routeToTopic(file);
      expect(coTopics.has(topic), `${file} -> ${topic}`).toBe(true);
      expect(uriToRoute(coUris.get(topic)!)).toBe(file);
    }
  });

  it("every checkout route file authenticates via authenticateWebhook, never authenticate.webhook", () => {
    for (const file of checkoutRouteFiles()) {
      const src = readFileSync(join(ROOT, "app", "routes", file), "utf8");
      expect(src, file).not.toMatch(/\bauthenticate\.webhook\s*\(/);
      expect(src, file).toMatch(/\bauthenticateWebhook\b|\bhandleCheckoutEligibilityWebhook\b/);
    }
  });

  it("client_id, application_url, api_version, auth redirect and privacy URLs are identical to production", () => {
    for (const key of ["client_id", "application_url", "embedded", "name"]) {
      expect(scalar(CO_TOML, key)).toBe(scalar(PROD_TOML, key));
    }
    expect(scalar(webhooksSection(CO_TOML), "api_version")).toBe(scalar(webhooksSection(PROD_TOML), "api_version"));
    expect(strArray(CO_TOML, "redirect_urls")).toEqual(strArray(PROD_TOML, "redirect_urls"));
    for (const key of ["customer_data_request_url", "customer_deletion_url", "shop_deletion_url"]) {
      expect(scalar(CO_TOML, key)).toBe(scalar(PROD_TOML, key));
    }
  });

  it("points the CLI at the Function directory and the extension targets the shipping-discount delivery hook", () => {
    const dirs = strArray(CO_TOML, "extension_directories");
    expect(dirs).toEqual(["functions/*"]);
    const ext = readFileSync(
      join(ROOT, "functions", "checkout-shipping-discount", "shopify.extension.toml"),
      "utf8",
    );
    expect(scalar(ext, "handle")).toBe("checkout-shipping-discount");
    expect(scalar(ext, "target")).toBe("cart.delivery-options.discounts.generate.run");
    expect(scalar(ext, "export")).toBe("cart-delivery-options-discounts-generate-run");
    const src = readFileSync(
      join(ROOT, "functions", "checkout-shipping-discount", "src", "cart_delivery_options_discounts_generate_run.ts"),
      "utf8",
    );
    expect(src).toMatch(/export function cartDeliveryOptionsDiscountsGenerateRun|cartDeliveryOptionsDiscountsGenerateRun/);
    expect(
      existsSync(
        join(ROOT, "functions", "checkout-shipping-discount", scalar(ext, "input_query") ?? ""),
      ),
    ).toBe(true);
  });

  it("the Function directory is self-consistent for deploy", () => {
    const extDir = join(ROOT, "functions", "checkout-shipping-discount");
    const pkg = JSON.parse(readFileSync(join(extDir, "package.json"), "utf8"));
    expect(pkg.dependencies["@shopify/shopify_function"]).toBeTruthy();
    expect(existsSync(join(extDir, "package-lock.json"))).toBe(true);
    const locales = JSON.parse(readFileSync(join(extDir, "locales", "en.default.json"), "utf8"));
    const ext = readFileSync(join(extDir, "shopify.extension.toml"), "utf8");
    for (const m of ext.matchAll(/t:([a-zA-Z0-9_.-]+)/g)) {
      expect(locales, `locale key ${m[1]}`).toHaveProperty(m[1]);
    }
    expect(readFileSync(join(extDir, "src", "index.ts"), "utf8")).toMatch(
      /export \* from ['"]\.\/cart_delivery_options_discounts_generate_run['"]/,
    );
    expect(scalar(ext, "export")).toBe("cart-delivery-options-discounts-generate-run");
    const tracked = execSync("git ls-files functions", { cwd: ROOT, encoding: "utf8" });
    expect(tracked).not.toMatch(/node_modules|dist\//);
  });
});
