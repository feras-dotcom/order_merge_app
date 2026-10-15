/**
 * Shipping v0 shadow evaluator (Phase 1) — READ-ONLY on Shopify.
 *
 * Usage:
 *   npx vite-node scripts/shipping-shadow-eval.ts [--shop <shop>] [--limit N] [--apply]
 *
 * Default is a DRY RUN: outcomes are computed with fresh Shopify reads and
 * printed, but nothing is written. --apply persists intents/verdicts — which
 * the store itself refuses unless MERGESHIP_SHADOW_DATABASE exactly matches
 * the connected database (an explicit disposable test database). The
 * evaluator never sends a mutation: Shopify access goes through
 * readOnlyAdmin, and no ShippingAdjustment dispatch path exists yet.
 */
import "./require-database-url";
import db from "../app/db.server";
import type { AdminClient } from "../app/lib/graphql.server";
import { prismaOperationStore } from "../app/lib/operation-store.server";
import {
  makeShippingShadowStore,
  runShadowScan,
  ShadowDatabaseNotAllowedError,
  type ShadowDeps,
} from "../app/lib/shipping-shadow.server";
import { getSettings } from "../app/lib/settings.server";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const shop = opt("--shop");
const limit = opt("--limit") ? Number(opt("--limit")) : undefined;
const apply = args.includes("--apply");
if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
  console.error("error: --limit must be a positive integer");
  process.exit(2);
}

/** Offline session via unauthenticated.admin; missing = null (uninstalled). */
async function sessionAdminFactory(s: string): Promise<AdminClient | null> {
  const { unauthenticated } = await import("../app/shopify.server");
  const { admin } = await unauthenticated.admin(s);
  return admin;
}

const deps: ShadowDeps = {
  store: makeShippingShadowStore(db),
  ops: prismaOperationStore,
  settings: getSettings,
  adminFactory: sessionAdminFactory,
};

try {
  const report = await runShadowScan(deps, { shop, limit, apply });
  console.log(JSON.stringify({
    mode: apply ? "APPLY" : "DRY_RUN",
    shadowDatabaseEnv: process.env.MERGESHIP_SHADOW_DATABASE ?? null,
    subsystemEnabled: report.subsystemEnabled,
    entries: report.entries,
    counts: report.entries.reduce<Record<string, number>>((acc, e) => {
      acc[e.outcome] = (acc[e.outcome] ?? 0) + 1;
      return acc;
    }, {}),
    warnings: [
      "This evaluator never sends Shopify mutations.",
      apply
        ? "Outcomes were persisted to the ShippingAdjustment table (disposable-database guard enforced)."
        : "Nothing was written. Re-run with --apply on a disposable database named by MERGESHIP_SHADOW_DATABASE to persist shadow evidence.",
      "READY describes what a future refund worker WOULD send; no dispatch path exists.",
    ],
  }, null, 2));
} catch (err) {
  if (err instanceof ShadowDatabaseNotAllowedError) {
    console.error(`error: ${err.message}`);
    console.error("Set MERGESHIP_SHADOW_DATABASE to the disposable database's name to persist shadow evidence.");
    process.exit(1);
  }
  throw err;
} finally {
  await db.$disconnect();
}
