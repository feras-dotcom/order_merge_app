// Checkout-discount monitor (operator tooling, read-only): one JSON
// finding per rule, shared exit-code mapping in the thin script. Every
// predicate reuses the engine's own pieces — shopLevelGateOff for the
// shop-level levers, the shutdown enforcer's pending predicate, the
// report's overdraw WHERE — never a re-derived copy.
//
// Row states (work.server.ts): status PENDING | DONE | REVIEW; EXHAUSTED
// is an outcome (exhaustDue writes status REVIEW + outcome EXHAUSTED) —
// there is no FAILED row state (FAILED is a diag kind only), so "stuck"
// means PENDING untouched > 30 min while the gate is on, or any REVIEW /
// EXHAUSTED row.
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { AdminClient } from "../graphql.server";
import { dbWallPlus } from "../ownership.server";
import { getSettings, type MergeSettings } from "../settings.server";
import { prismaOperationStore } from "../operation-store.server";
import { shopLevelGateOff } from "./gate.server";
import {
  readCheckoutDiscount,
  shopLocalNow,
  type CheckoutDiscountState,
} from "./discount-control.server";
import { countOverdraw, reportShops } from "./report.server";

export interface MonitorFinding {
  severity: "CRITICAL" | "WARN";
  code:
    | "PENDING_SHUTDOWN"
    | "DISCOUNT_ACTIVE_WHILE_OFF"
    | "OVERDRAW_24H"
    | "DISCOUNT_WINDOW_ENDED"
    | "DISCOUNT_WINDOW_ENDS_SOON"
    | "WORK_STUCK"
    | "SWEEPER_STALE";
  shop?: string;
}

const OVERDRAW_WINDOW_MS = 24 * 3_600_000;
const WORK_STUCK_MS = 30 * 60_000;
const SWEEPER_STALE_MS = 5 * 60_000;
const WINDOW_ENDS_SOON_MS = 72 * 3_600_000;

export interface MonitorDeps {
  db: PrismaClient;
  shop?: string;
  noAdmin?: boolean;
  env?: (name: string) => string | undefined;
  settings?: (shop: string) => Promise<MergeSettings>;
  control?: () => Promise<{
    checkoutDiscountEnabled?: boolean;
    checkoutDiscountAllowShops?: string[];
  } | null>;
  adminFactory?: (shop: string) => Promise<AdminClient | null>;
  discountReader?: (
    admin: AdminClient,
    nodeId: string,
  ) => Promise<CheckoutDiscountState | null>;
  timezoneReader?: (admin: AdminClient) => Promise<string>;
  now?: () => Date;
}

export async function runMonitor(deps: MonitorDeps): Promise<MonitorFinding[]> {
  const env = deps.env ?? ((n: string) => process.env[n]);
  const settingsOf = deps.settings ?? getSettings;
  const controlOf = deps.control ?? (() => prismaOperationStore.getControl());
  const discountReader = deps.discountReader ?? readCheckoutDiscount;
  const now = deps.now?.() ?? new Date();
  const findings: MonitorFinding[] = [];
  const crit = (code: MonitorFinding["code"], shop?: string) =>
    findings.push({ severity: "CRITICAL", code, shop });
  const warn = (code: MonitorFinding["code"], shop?: string) =>
    findings.push({ severity: "WARN", code, shop });

  const shops = await reportShops(deps.db, deps.shop);
  const control = await controlOf();
  const globalLeversOn =
    env("MERGESHIP_CHECKOUT_DISCOUNT") === "enabled" &&
    control?.checkoutDiscountEnabled === true;

  // Sweeper liveness is app-wide, not per-shop: no fresh heartbeat means
  // shutdown enforcement, consumption and revocation are all stopped.
  const liveWorkers = await deps.db.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM "WorkerInstance"
    WHERE "heartbeatAt" > ${dbWallPlus(-SWEEPER_STALE_MS)}`;
  if (shops.length > 0 && Number(liveWorkers[0]?.n ?? 0) === 0) {
    warn("SWEEPER_STALE");
  }

  for (const shop of shops) {
    const settings = await settingsOf(shop);
    const shopLevelOff = shopLevelGateOff(settings);
    const shopFlagOn = settings.checkoutDiscountEnabled === true;
    const allowlisted = (control?.checkoutDiscountAllowShops ?? []).includes(shop);
    const gateOn =
      globalLeversOn && allowlisted && shopFlagOn && shopLevelOff === null;

    // The enforcer's own pending predicate: flag on + a failing per-shop
    // lever is the durable marker the sweeper is supposed to clear.
    if (shopFlagOn && shopLevelOff !== null) crit("PENDING_SHUTDOWN", shop);

    const overdraw = await countOverdraw(deps.db, {
      shop,
      sinceMs: now.getTime() - OVERDRAW_WINDOW_MS,
    });
    if (overdraw > 0) crit("OVERDRAW_24H", shop);

    // Stuck work: PENDING rows untouched for 30 min while the gate is on
    // (a row being actively processed has a recent updatedAt), or any row
    // parked in REVIEW / settled EXHAUSTED — the exact row states from
    // work.server.ts.
    const stuck = await deps.db.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM "CheckoutEligibilityWork"
      WHERE "shop" = ${shop}
        AND ("status" = 'REVIEW' OR "outcome" = 'EXHAUSTED'
          ${gateOn
            ? Prisma.sql`OR ("status" = 'PENDING' AND "updatedAt" < ${dbWallPlus(-WORK_STUCK_MS)})`
            : Prisma.empty})`;
    if (Number(stuck[0]?.n ?? 0) > 0) warn("WORK_STUCK", shop);

    if (deps.noAdmin) continue;
    if (!settings.checkoutDiscountNodeId) continue;
    let admin: AdminClient | null = null;
    try {
      if (deps.adminFactory) {
        admin = await deps.adminFactory(shop);
      } else {
        const { unauthenticated } = await import("../../shopify.server");
        admin = (await unauthenticated.admin(shop)).admin;
      }
    } catch {
      admin = null; // no session / uninstalled shop: Admin findings skipped
    }
    if (!admin) continue;

    const state = await discountReader(admin, settings.checkoutDiscountNodeId);
    if (!state) continue;

    // ACTIVE while any lever is off = the leaked discount: checkout is
    // granting even though the app believes it is disabled.
    if (state.status === "ACTIVE" && !gateOn) {
      crit("DISCOUNT_ACTIVE_WHILE_OFF", shop);
    }
    if (state.status === "ACTIVE") {
      // windowEnd is shop-local DateTimeWithoutTimezone: compare against
      // the same shop-local clock the config was written with — a string
      // compare between two shopLocalNow stamps IS a time compare.
      let tz = "UTC";
      try {
        if (deps.timezoneReader) {
          tz = await deps.timezoneReader(admin);
        } else {
          const { gqlData } = await import("../graphql.server");
          const data = await gqlData<{ shop?: { ianaTimezone?: string } }>(
            admin,
            "Read shop timezone",
            `#graphql query MonitorShopTz { shop { ianaTimezone } }`,
            {},
          );
          tz = data?.shop?.ianaTimezone ?? "UTC";
        }
      } catch {
        tz = "UTC";
      }
      if (state.windowEnd <= shopLocalNow(now, tz)) {
        crit("DISCOUNT_WINDOW_ENDED", shop);
      } else if (
        state.windowEnd <=
        shopLocalNow(new Date(now.getTime() + WINDOW_ENDS_SOON_MS), tz)
      ) {
        warn("DISCOUNT_WINDOW_ENDS_SOON", shop);
      }
    }
  }
  return findings;
}
