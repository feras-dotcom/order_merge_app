// Automatic checkout-discount shutdown enforcement. The durable pending
// marker IS the persisted state: checkoutDiscountEnabled=true with a
// failing per-shop gate lever. shutdownCheckoutDiscount flips the flag off
// only AFTER the Shopify discount is verified EXPIRED/DELETED, so a crash,
// a restart, or a failed attempt leaves the marker set and the sweeper
// retries — no separate queue table is needed.
import db from "../../db.server";
import type { AdminClient } from "../graphql.server";
import { getSettings, type MergeSettings } from "../settings.server";
import { shopLevelGateOff } from "./gate.server";
import { shutdownCheckoutDiscount } from "./discount-control.server";
import { defaultDiag, type Diag } from "./diag";

export const PENDING_SHUTDOWN_MIN_RETRY_MS = 5 * 60_000;

export type EnforceResult =
  | { action: "none" }
  | { action: "shutdown"; status: string }
  | { action: "failed"; code: string };

export interface EnforceShopDeps {
  shop: string;
  admin: AdminClient;
  getSettings?: (shop: string) => Promise<MergeSettings>;
  shutdown?: (deps: {
    admin: AdminClient;
    shop: string;
    discountId: string;
  }) => Promise<{ status: string }>;
  diag?: Diag;
}

const diagFail = (diag: Diag, shop: string, code: string) =>
  diag({ kind: "FAILED", shop, orderId: "", code });

/** Enforce shutdown for ONE shop: deactivate the merchant's own recorded
 *  checkout discount when checkout is still enabled but a per-shop gate
 *  lever (auto-merge, onboarding, window) has failed. Never throws —
 *  failures are returned and diag'd so the caller is never blocked and the
 *  marker (flag still on) keeps the retry pending. Only the recorded
 *  checkoutDiscountNodeId is ever touched; other discounts are never read
 *  or mutated. */
export async function enforceShopShutdown(
  deps: EnforceShopDeps,
): Promise<EnforceResult> {
  const diag = deps.diag ?? defaultDiag;
  try {
    const settings = await (deps.getSettings ?? getSettings)(deps.shop);
    if (!settings.checkoutDiscountEnabled) return { action: "none" };
    if (shopLevelGateOff(settings) === null) return { action: "none" };
    if (!settings.checkoutDiscountNodeId) {
      diagFail(diag, deps.shop, "NO_DISCOUNT_ID");
      return { action: "failed", code: "NO_DISCOUNT_ID" };
    }
    const doShutdown = deps.shutdown ?? shutdownCheckoutDiscount;
    const result = await doShutdown({
      admin: deps.admin,
      shop: deps.shop,
      discountId: settings.checkoutDiscountNodeId,
    });
    return { action: "shutdown", status: result.status };
  } catch (err: any) {
    // Stable codes only — never a free-form message that could carry
    // customer data into diagnostics. constructor.name surfaces the typed
    // error class (ShutdownNotVerifiedError, DiscountStateError, ...).
    const code =
      err instanceof Error ? (err.constructor?.name || err.name || "ERROR") : "ERROR";
    diagFail(diag, deps.shop, code);
    return { action: "failed", code };
  }
}

export interface PendingShopResult {
  shop: string;
  result: EnforceResult | { action: "skipped"; code: string };
}

export interface EnforcePendingDeps {
  /** Shops with checkoutDiscountEnabled=true (default: a Settings read) —
   *  the shop domain comes from the row itself. */
  listShops?: () => Promise<(MergeSettings & { shop: string })[]>;
  /** Offline admin for a shop; null = no session (uninstalled). */
  adminFactory: (shop: string) => Promise<AdminClient | null>;
  enforce?: (deps: EnforceShopDeps) => Promise<EnforceResult>;
  now?: () => Date;
  minRetryMs?: number;
  /** Per-shop last-failure clock for retry spacing (in-memory; injectable
   *  for tests). */
  backoff?: Map<string, number>;
}

const defaultBackoff = new Map<string, number>();

/** Sweeper step: retry every pending checkout shutdown. Reads fresh
 *  settings per shop, spaces retries after a failed attempt so a
 *  persistent failure does not hammer Shopify every sweep, reports a
 *  missing session explicitly, and never lets one shop stop the others.
 *  Never throws for an individual shop's failure. */
export async function enforcePendingShutdowns(
  deps: EnforcePendingDeps,
): Promise<PendingShopResult[]> {
  const now = deps.now ?? (() => new Date());
  const minRetryMs = deps.minRetryMs ?? PENDING_SHUTDOWN_MIN_RETRY_MS;
  const backoff = deps.backoff ?? defaultBackoff;
  const enforce = deps.enforce ?? enforceShopShutdown;
  const listShops =
    deps.listShops ??
    (async () =>
      (await db.settings.findMany({
        where: { checkoutDiscountEnabled: true },
      })) as unknown as (MergeSettings & { shop: string })[]);
  const results: PendingShopResult[] = [];
  // A failed listing is NOT silent: it propagates so the sweeper logs it
  // and the next tick retries (the pending marker is persistent state).
  const shops = await listShops();
  for (const settings of shops) {
    const shop = settings.shop;
    // A lever restored between the flag being set and now means nothing is
    // pending for this shop.
    if (shopLevelGateOff(settings) === null) continue;
    const lastFail = backoff.get(shop);
    if (lastFail !== undefined && now().getTime() - lastFail < minRetryMs) {
      results.push({ shop, result: { action: "skipped", code: "BACKOFF" } });
      continue;
    }
    let admin: AdminClient | null = null;
    try {
      admin = await deps.adminFactory(shop);
    } catch {
      admin = null;
    }
    if (!admin) {
      results.push({ shop, result: { action: "skipped", code: "NO_SESSION" } });
      continue;
    }
    const result = await enforce({ shop, admin });
    if (result.action === "failed") backoff.set(shop, now().getTime());
    else backoff.delete(shop);
    results.push({ shop, result });
  }
  return results;
}
