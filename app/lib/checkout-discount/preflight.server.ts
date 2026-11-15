// Checkout-discount pilot preflight (read-only — no mutation under any
// flag): every lever the pilot needs before create/prepare-enable, reported
// as {check, ok, detail-code} lines. Admin reads are the validated
// 2026-04 documents; the shop-local levers reuse the gate pieces with no
// Admin call. Output carries codes/booleans/counts only — never customer
// data, names or the config message.
import fs from "node:fs";
import path from "node:path";
import { gqlData, type AdminClient } from "../graphql.server";
import { getSettings, type MergeSettings } from "../settings.server";
import { prismaOperationStore } from "../operation-store.server";
import { isOnboardingComplete } from "../onboarding";
import { methodApprovalFromSettings } from "./gate.server";
import { CHECKOUT_DISCOUNT_MESSAGE, MIN_CHECKOUT_WINDOW_HOURS } from "./config";
import { readCheckoutDiscount, DiscountConfigError } from "./discount-control.server";

const REQUIRED_SCOPES = ["write_customers", "write_discounts"] as const;

/** Required webhook deliveries: the Admin enum name (webhookSubscriptions
 *  reports this) mapped to the Shopify topic string the bundled
 *  shopify.app.checkout-first.toml declares, with the exact route the
 *  declaration's `uri` must equal — `/webhooks/<topic>`. A topic is
 *  satisfied by EITHER source: the Admin listing only ever shows
 *  shop-scoped API subscriptions, so app-scoped TOML declarations never
 *  appear there and must be checked against the bundled file. */
const REQUIRED_TOPICS = [
  { api: "ORDERS_PAID", topic: "orders/paid" },
  { api: "ORDERS_UPDATED", topic: "orders/updated" },
  { api: "ORDERS_CANCELLED", topic: "orders/cancelled" },
  { api: "ORDERS_FULFILLED", topic: "orders/fulfilled" },
  { api: "ORDERS_PARTIALLY_FULFILLED", topic: "orders/partially_fulfilled" },
  { api: "REFUNDS_CREATE", topic: "refunds/create" },
  { api: "ORDERS_RISK_ASSESSMENT_CHANGED", topic: "orders/risk_assessment_changed" },
] as const;

export interface DeclaredWebhookSub {
  uri: string;
  topics: string[];
}

/** Parse the `[[webhooks.subscriptions]]` blocks of an app TOML — a small
 *  line parser, no dependency. Each block's `uri` and `topics` (single or
 *  multi-line array) are captured; [webhooks.privacy_compliance] and every
 *  other section are ignored. */
export function parseDeclaredWebhooks(text: string): DeclaredWebhookSub[] {
  const subs: DeclaredWebhookSub[] = [];
  let cur: DeclaredWebhookSub | null = null;
  let inTopics = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (/^\[\[webhooks\.subscriptions\]\]/.test(line)) {
      cur = { uri: "", topics: [] };
      subs.push(cur);
      inTopics = false;
      continue;
    }
    if (line.startsWith("[")) {
      cur = null;
      inTopics = false;
      continue;
    }
    if (!cur) continue;
    if (inTopics) {
      for (const m of line.matchAll(/"([^"]*)"/g)) cur.topics.push(m[1]);
      if (line.includes("]")) inTopics = false;
      continue;
    }
    const uri = line.match(/^uri\s*=\s*"([^"]*)"/);
    if (uri) {
      cur.uri = uri[1];
      continue;
    }
    const topics = line.match(/^topics\s*=\s*\[(.*)$/);
    if (topics) {
      for (const m of topics[1].matchAll(/"([^"]*)"/g)) cur.topics.push(m[1]);
      if (!topics[1].includes("]")) inTopics = true;
    }
  }
  return subs;
}

const defaultReadConfig = (): string =>
  fs.readFileSync(
    path.join(process.cwd(), "shopify.app.checkout-first.toml"),
    "utf8",
  );

// Validated against Admin 2026-04 (webhookSubscriptions.uri — endpoint is
// deprecated; plan.publicDisplayName — displayName is deprecated).
const Q_PREFLIGHT = `#graphql
  query CheckoutPreflight {
    currentAppInstallation {
      accessScopes { handle }
      app { id }
    }
    webhookSubscriptions(first: 25) {
      nodes { id topic uri }
    }
    shop {
      plan { partnerDevelopment shopifyPlus publicDisplayName }
    }
  }`;

// Protected-customer-data probe: exactly one recent order's shipping
// address fields. ACCESS_DENIED on a GraphQL error means the protected
// data approval is missing; NO_ORDERS cannot prove anything (warn).
const Q_PROTECTED_PROBE = `#graphql
  query CheckoutProtectedProbe {
    orders(first: 1, reverse: true) {
      nodes {
        id
        shippingAddress { firstName lastName address1 }
      }
    }
  }`;

export interface PreflightCheck {
  check: string;
  ok: boolean | "warn";
  detail: string;
}

export interface PreflightDeps {
  admin: AdminClient;
  shop: string;
  env?: (name: string) => string | undefined;
  settings?: (shop: string) => Promise<MergeSettings>;
  control?: () => Promise<{
    checkoutDiscountEnabled?: boolean;
    checkoutDiscountAllowShops?: string[];
  } | null>;
  /** The app base URL a webhook subscription must point at
   *  (process.env.SHOPIFY_APP_URL by default). */
  appUrl?: string;
  /** Returns the bundled shopify.app.checkout-first.toml text (injected for
   *  tests; default reads <cwd>/shopify.app.checkout-first.toml). */
  readConfig?: () => string;
}

interface PreflightData {
  currentAppInstallation?: {
    accessScopes?: { handle?: string }[];
    app?: { id?: string } | null;
  } | null;
  webhookSubscriptions?: {
    nodes?: { id?: string; topic?: string; uri?: string }[];
  } | null;
  shop?: {
    plan?: {
      partnerDevelopment?: boolean;
      shopifyPlus?: boolean;
      publicDisplayName?: string | null;
    } | null;
  } | null;
}

const errText = (err: any) => String(err?.message ?? err);

export async function runPreflight(deps: PreflightDeps): Promise<PreflightCheck[]> {
  const env = deps.env ?? ((n: string) => process.env[n]);
  const settings = await (deps.settings ?? getSettings)(deps.shop);
  const control = await (deps.control ?? (() => prismaOperationStore.getControl()))();
  const appUrl = deps.appUrl ?? process.env.SHOPIFY_APP_URL ?? "";
  const checks: PreflightCheck[] = [];

  // ── Admin-side checks (one read) ──
  let preflightData: PreflightData | null = null;
  let adminError: string | null = null;
  try {
    preflightData = await gqlData<PreflightData>(deps.admin, "Checkout preflight", Q_PREFLIGHT, {});
  } catch (err: any) {
    adminError = errText(err);
  }
  const scopes = new Set(
    (preflightData?.currentAppInstallation?.accessScopes ?? [])
      .map((s) => s?.handle)
      .filter((h): h is string => typeof h === "string"),
  );
  const missingScopes = REQUIRED_SCOPES.filter((s) => !scopes.has(s));
  checks.push({
    check: "scopes",
    ok: adminError !== null ? false : missingScopes.length === 0,
    detail: adminError !== null
      ? `ADMIN_READ_FAILED`
      : missingScopes.length
        ? `MISSING_${missingScopes.join("+").toUpperCase()}`
        : "OK",
  });

  const subs = preflightData?.webhookSubscriptions?.nodes ?? [];
  // Bundled app-scope declaration: a required topic is satisfied by EITHER
  // an API subscription for appUrl OR a declaration whose topic ↔ uri is
  // exactly `/webhooks/<topic>`. A declaration the app cannot read or parse
  // satisfies nothing.
  let declared: DeclaredWebhookSub[] | null = null;
  try {
    const parsed = parseDeclaredWebhooks(
      (deps.readConfig ?? defaultReadConfig)(),
    );
    declared = parsed.length > 0 ? parsed : null;
  } catch {
    declared = null;
  }
  const apiSatisfied = new Set(
    REQUIRED_TOPICS.filter((t) =>
      subs.some((n) => n?.topic === t.api && (n?.uri ?? "").startsWith(appUrl)),
    ).map((t) => t.api),
  );
  const missingTopics = REQUIRED_TOPICS.filter(
    (t) =>
      !apiSatisfied.has(t.api) &&
      !(declared ?? []).some(
        (d) => d.topics.includes(t.topic) && d.uri === `/webhooks/${t.topic}`,
      ),
  );
  checks.push({
    check: "webhooks",
    ok:
      adminError !== null
        ? false
        : declared === null
          ? apiSatisfied.size === REQUIRED_TOPICS.length
          : missingTopics.length === 0,
    detail:
      adminError !== null
        ? `ADMIN_READ_FAILED`
        : declared === null && apiSatisfied.size < REQUIRED_TOPICS.length
          ? `DECLARATION_UNREADABLE`
          : missingTopics.length
            ? `MISSING_${missingTopics.length}_TOPICS`
            : apiSatisfied.size === REQUIRED_TOPICS.length
              ? "OK_API"
              : "OK_DECLARED",
  });
  // Declaration-satisfied topics only prove the BUNDLED config — whether the
  // released version declares them needs the runbook's `shopify app config
  // pull` diff plus a real delivery. Warn, never fail.
  if (
    adminError === null &&
    missingTopics.length === 0 &&
    apiSatisfied.size < REQUIRED_TOPICS.length
  ) {
    checks.push({ check: "webhooks-release", ok: "warn", detail: "VERIFY_RELEASED_VERSION" });
  }
  if (adminError !== null) {
    // surface the read failure once so it is greppable
    checks.push({ check: "admin-read", ok: false, detail: "ADMIN_READ_FAILED" });
  }

  // ── Recorded discount ──
  const nodeId = settings.checkoutDiscountNodeId;
  if (!nodeId) {
    checks.push({ check: "discount", ok: false, detail: "NO_RECORDED_DISCOUNT" });
  } else {
    try {
      const d = await readCheckoutDiscount(deps.admin, nodeId);
      if (!d) {
        checks.push({ check: "discount", ok: false, detail: "NOT_FOUND" });
      } else if (d.typename !== "DiscountAutomaticApp") {
        checks.push({ check: "discount", ok: false, detail: "WRONG_TYPE" });
      } else if (!d.ownsThisApp) {
        checks.push({ check: "discount", ok: false, detail: "NOT_APP_OWNED" });
      } else if (d.message !== CHECKOUT_DISCOUNT_MESSAGE) {
        checks.push({ check: "discount", ok: false, detail: "WRONG_MESSAGE" });
      } else if (d.status === "ACTIVE" || d.status === "SCHEDULED") {
        checks.push({ check: "discount", ok: false, detail: `STATUS_${d.status}` });
      } else {
        checks.push({ check: "discount", ok: true, detail: `STATUS_${d.status}` });
      }
    } catch (err: any) {
      checks.push({
        check: "discount",
        ok: false,
        detail: err instanceof DiscountConfigError ? "CONFIG_INVALID" : "ADMIN_READ_FAILED",
      });
    }
  }

  // ── Shop-local levers (no Admin call) ──
  checks.push({
    check: "env-flag",
    ok: env("MERGESHIP_CHECKOUT_DISCOUNT") === "enabled",
    detail: env("MERGESHIP_CHECKOUT_DISCOUNT") === "enabled" ? "ENABLED" : "UNSET",
  });
  checks.push({
    check: "control-switch",
    ok: control?.checkoutDiscountEnabled === true,
    detail: control?.checkoutDiscountEnabled === true ? "ON" : "OFF",
  });
  checks.push({
    check: "allowlist",
    ok: (control?.checkoutDiscountAllowShops ?? []).includes(deps.shop),
    detail: (control?.checkoutDiscountAllowShops ?? []).includes(deps.shop) ? "LISTED" : "ABSENT",
  });
  checks.push({
    check: "auto-merge",
    ok: settings.autoMergeEnabled === true,
    detail: settings.autoMergeEnabled === true ? "ON" : "OFF",
  });
  checks.push({
    check: "onboarding",
    ok: isOnboardingComplete(settings),
    detail: isOnboardingComplete(settings) ? "COMPLETE" : "INCOMPLETE",
  });
  checks.push({
    check: "merge-window",
    ok: settings.mergeWindowHours >= MIN_CHECKOUT_WINDOW_HOURS,
    detail: settings.mergeWindowHours >= MIN_CHECKOUT_WINDOW_HOURS ? "OK" : "WINDOW_UNSUPPORTED",
  });
  checks.push({
    check: "shop-flag",
    ok: settings.checkoutDiscountEnabled === true && settings.checkoutDiscountEnabledAt != null,
    detail: settings.checkoutDiscountEnabled === true ? "ON" : "OFF",
  });
  // Pilot method approval (operator-set, no Admin call): present+valid.
  checks.push({
    check: "method-approval",
    ok: methodApprovalFromSettings(settings) !== null,
    detail: methodApprovalFromSettings(settings) !== null ? "OK" : "UNSET",
  });

  // ── Protected-customer-data probe (warn, never fails) ──
  try {
    const probe = await gqlData<{ orders?: { nodes?: { id?: string }[] } | null }>(
      deps.admin,
      "Protected data probe",
      Q_PROTECTED_PROBE,
      {},
    );
    const n = probe?.orders?.nodes?.length ?? 0;
    checks.push({
      check: "protected-data",
      ok: n > 0 ? "warn" : "warn",
      detail: n > 0 ? "OK" : "NO_ORDERS",
    });
  } catch {
    checks.push({ check: "protected-data", ok: "warn", detail: "ACCESS_DENIED" });
  }

  // ── Plan (informational) ──
  const plan = preflightData?.shop?.plan;
  checks.push({
    check: "shop-plan",
    ok: "warn",
    detail: plan
      ? `${plan.publicDisplayName ?? "UNKNOWN"}${plan.partnerDevelopment ? "+DEV" : ""}${plan.shopifyPlus ? "+PLUS" : ""}`
      : "UNREADABLE",
  });

  return checks;
}
