// Checkout-discount pilot preflight (read-only — no mutation under any
// flag): every lever the pilot needs before create/prepare-enable, reported
// as {check, ok, detail-code} lines. Admin reads are the validated
// 2026-04 documents; the shop-local levers reuse the gate pieces with no
// Admin call. Output carries codes/booleans/counts only — never customer
// data, names or the config message.
import { gqlData, type AdminClient } from "../graphql.server";
import { getSettings, type MergeSettings } from "../settings.server";
import { prismaOperationStore } from "../operation-store.server";
import { isOnboardingComplete } from "../onboarding";
import { CHECKOUT_DISCOUNT_MESSAGE, MIN_CHECKOUT_WINDOW_HOURS } from "./config";
import { readCheckoutDiscount, DiscountConfigError } from "./discount-control.server";

const REQUIRED_SCOPES = ["write_customers", "write_discounts"] as const;
const REQUIRED_TOPICS = [
  "ORDERS_PAID",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "ORDERS_FULFILLED",
  "ORDERS_PARTIALLY_FULFILLED",
  "REFUNDS_CREATE",
  "ORDERS_RISK_ASSESSMENT_CHANGED",
] as const;

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
  const missingTopics = REQUIRED_TOPICS.filter(
    (t) => !subs.some((n) => n?.topic === t && (n?.uri ?? "").startsWith(appUrl)),
  );
  checks.push({
    check: "webhooks",
    ok: adminError !== null ? false : missingTopics.length === 0,
    detail: adminError !== null
      ? `ADMIN_READ_FAILED`
      : missingTopics.length
        ? `MISSING_${missingTopics.length}_TOPICS`
        : "OK",
  });
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
