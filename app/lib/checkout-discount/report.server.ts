// Checkout-discount exposure report (operator tooling, read-only): counts
// the durable work rows, sums granted shipping allocations per currency,
// and classifies every grant order merged / open / unmerged_expired — the
// last being REALIZED exposure (the merge window passed without the order
// merging, so the discounted shipping was never recouped by combining).
// Injectable deps; output carries ids/codes/counts only.
//
// Overdraw — SHARED WITH THE MONITOR: the processor settles a grant it
// cannot reconcile as OVERDRAW (processor.server.ts settle calls with
// kind "OVERDRAW"): outcome CONSUMED_NO_RECORD is definitive overdraw;
// outcome CUSTOMER_GONE is shared between the ISSUE refuse ("order has no
// customer") and the CONSUME overdraw ("consumed order has no customer")
// paths, so only the consumed reason counts — matched on the exact
// lastReason string the processor writes.
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { gqlData, type AdminClient } from "../graphql.server";
import { getCurrencyPrecision, parseShopMoney } from "../money";
import { detectShippingDiscountGrant } from "./grant";
import { CHECKOUT_DISCOUNT_MESSAGE } from "./config";

/** Overdraw predicate shared by report + monitor (one implementation —
 *  see the header note). `since` bounds to rows updated in the window. */
export const OVERDRAW_WHERE = Prisma.sql`
  ("outcome" = 'CONSUMED_NO_RECORD'
   OR ("outcome" = 'CUSTOMER_GONE' AND "lastReason" = 'consumed order has no customer'))`;

export async function countOverdraw(
  db: PrismaClient,
  opts: { shop?: string; sinceMs?: number } = {},
): Promise<number> {
  // (?::timestamptz AT TIME ZONE 'UTC') — every column stores the naive
  // UTC wall clock; a bare Date bind would land in the session timezone.
  const sinceTs = opts.sinceMs !== undefined ? new Date(opts.sinceMs).toISOString() : null;
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM "CheckoutEligibilityWork"
    WHERE ${OVERDRAW_WHERE}
      ${opts.shop !== undefined ? Prisma.sql`AND "shop" = ${opts.shop}` : Prisma.empty}
      ${sinceTs !== null
        ? Prisma.sql`AND COALESCE("doneAt", "updatedAt") >= (${sinceTs}::timestamptz AT TIME ZONE 'UTC')`
        : Prisma.empty}`;
  return Number(rows[0]?.n ?? 0);
}

/** Shops the tooling reports on by default: checkout flag on, or a
 *  recorded discount node (the flag may have been cleared by shutdown
 *  while exposure is still outstanding). */
export async function reportShops(db: PrismaClient, shop?: string): Promise<string[]> {
  if (shop) return [shop];
  const rows = await db.$queryRaw<{ shop: string }[]>`
    SELECT "shop" FROM "Settings"
    WHERE "checkoutDiscountEnabled" = true OR "checkoutDiscountNodeId" IS NOT NULL
    ORDER BY "shop"`;
  return rows.map((r) => r.shop);
}

// Orders paged since --since with the engine's own shipping selection
// (original vs discounted shopMoney) plus the allocation evidence
// detectShippingDiscountGrant consumes. presentmentMoney matches what the
// customer was shown; the amounts the planner uses are shopMoney — the
// grant detector runs on shopMoney minors here (one currency per order).
const Q_ORDERS_SINCE = `#graphql
  query CheckoutReportOrders($cursor: String, $query: String!) {
    orders(first: 50, after: $cursor, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        createdAt
        currencyCode
        shippingLines(first: 5) {
          nodes {
            title
            originalPriceSet { shopMoney { amount currencyCode } }
            discountedPriceSet { shopMoney { amount currencyCode } }
            discountAllocations {
              allocatedAmountSet { shopMoney { amount currencyCode } }
              discountApplication {
                __typename
                targetType
                ... on AutomaticDiscountApplication { title }
              }
            }
          }
        }
        discountApplications(first: 20) {
          nodes {
            __typename
            targetType
            ... on AutomaticDiscountApplication { title }
          }
        }
      }
    }
  }`;

const ORDERS_LIMIT = 500;

export interface GrantOrderRow {
  orderId: string;
  grantedMinor: string;
  currency: string;
  createdAt: string;
  merged: boolean;
  open: boolean;
}

export interface ReportResult {
  shop: string;
  work: {
    byStatus: Record<string, number>;
    byOutcome: Record<string, number>;
    consumedGrants: number;
    overdraw: number;
    outstandingProjected: number;
  };
  orders: null | {
    truncated: boolean;
    grantOrders: number;
    ambiguous: number;
    totals: Record<string, string>;
    classes: { merged: number; open: number; unmerged_expired: number };
    realizedExposure: Record<string, string>;
  };
  caps: {
    capGrants: number | null;
    capAmount: string | null;
    currency: string | null;
    breach: string[];
  };
  withinCaps: boolean;
}

interface OrderNode {
  id: string;
  createdAt: string;
  currencyCode: string;
  shippingLines: {
    nodes: {
      title?: string | null;
      originalPriceSet?: { shopMoney: { amount: string; currencyCode: string } } | null;
      discountedPriceSet?: { shopMoney: { amount: string; currencyCode: string } } | null;
      discountAllocations?: {
        allocatedAmountSet?: { shopMoney: { amount: string; currencyCode: string } } | null;
        discountApplication?: { targetType?: string | null; title?: string | null } | null;
      }[];
    }[];
  };
  discountApplications?: { nodes: { targetType?: string | null; title?: string | null }[] } | null;
}

export interface ReportDeps {
  db: PrismaClient;
  shop: string;
  since?: Date;
  orders?: boolean;
  admin?: AdminClient;
  listOrders?: (cursor: string | null) => Promise<{
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: OrderNode[];
  }>;
  capGrants?: number;
  capAmount?: string;
  currency?: string;
  now?: Date;
}

const minorSum = (a: bigint, b: bigint) => a + b;

export async function runReport(deps: ReportDeps): Promise<ReportResult> {
  const now = deps.now ?? new Date();
  const sinceMs = deps.since?.getTime();

  const statusRows = await deps.db.$queryRaw<{ status: string; n: bigint }[]>`
    SELECT "status", COUNT(*)::bigint AS n FROM "CheckoutEligibilityWork"
    WHERE "shop" = ${deps.shop}
    GROUP BY "status"`;
  const outcomeRows = await deps.db.$queryRaw<{ outcome: string; n: bigint }[]>`
    SELECT "outcome", COUNT(*)::bigint AS n FROM "CheckoutEligibilityWork"
    WHERE "shop" = ${deps.shop} AND "outcome" IS NOT NULL
    GROUP BY "outcome"`;
  const sinceTs = sinceMs !== undefined ? new Date(sinceMs).toISOString() : null;
  const consumedRows = await deps.db.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM "CheckoutEligibilityWork"
    WHERE "shop" = ${deps.shop} AND "grantConsumedAt" IS NOT NULL
      ${sinceTs !== null
        ? Prisma.sql`AND "grantConsumedAt" >= (${sinceTs}::timestamptz AT TIME ZONE 'UTC')`
        : Prisma.empty}`;
  const outstandingRows = await deps.db.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM "CheckoutEligibilityWork"
    WHERE "shop" = ${deps.shop} AND "status" = 'DONE' AND "outcome" = 'PROJECTED'
      AND "grantConsumedAt" IS NULL`;
  const overdraw = await countOverdraw(deps.db, { shop: deps.shop, sinceMs });

  const work = {
    byStatus: Object.fromEntries(statusRows.map((r) => [r.status, Number(r.n)])),
    byOutcome: Object.fromEntries(outcomeRows.map((r) => [r.outcome, Number(r.n)])),
    consumedGrants: Number(consumedRows[0]?.n ?? 0),
    overdraw,
    outstandingProjected: Number(outstandingRows[0]?.n ?? 0),
  };

  const settingsRows = await deps.db.$queryRaw<{ mergeWindowHours: number }[]>`
    SELECT "mergeWindowHours" FROM "Settings" WHERE "shop" = ${deps.shop}`;
  const mergeWindowMs = (settingsRows[0]?.mergeWindowHours ?? 24) * 3_600_000;

  let orders: ReportResult["orders"] = null;
  const breach: string[] = [];

  if (deps.orders) {
    const list =
      deps.listOrders ??
      (async (cursor: string | null) => {
        if (!deps.admin) throw new Error("--orders requires an Admin client");
        const query = `created_at:>=${deps.since?.toISOString() ?? "1970-01-01T00:00:00Z"}`;
        const data = await gqlData<{
          orders: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: OrderNode[];
          };
        }>(deps.admin, "Report orders", Q_ORDERS_SINCE, { cursor, query });
        if (!data?.orders) throw new Error("Report orders returned no payload");
        return data.orders;
      });

    const totals = new Map<string, bigint>();
    const realized = new Map<string, bigint>();
    const classes = { merged: 0, open: 0, unmerged_expired: 0 };
    let grantOrders = 0;
    let ambiguous = 0;
    let truncated = false;
    let seen = 0;

    let cursor: string | null = null;
    page: while (true) {
      const page = await list(cursor);
      for (const order of page.nodes) {
        seen++;
        if (seen > ORDERS_LIMIT) {
          truncated = true;
          break page;
        }
        const facts = {
          shippingLines: order.shippingLines.nodes.map((l) => ({
            title: l.title ?? "",
            originalMinor:
              parseShopMoney(l.originalPriceSet?.shopMoney)?.minorUnits.toString() ?? "0",
            discountedMinor:
              parseShopMoney(l.discountedPriceSet?.shopMoney)?.minorUnits.toString() ?? "0",
            discountAllocations: (l.discountAllocations ?? []).map((a) => ({
              amountMinor:
                parseShopMoney(a.allocatedAmountSet?.shopMoney)?.minorUnits.toString() ?? "0",
              applicationTitle: a.discountApplication?.title ?? null,
            })),
          })),
          discountApplications: (order.discountApplications?.nodes ?? []).map((a) => ({
            targetType: a.targetType ?? null,
            title: a.title ?? null,
          })),
        };
        const g = detectShippingDiscountGrant(facts, {
          titleToken: CHECKOUT_DISCOUNT_MESSAGE,
        });
        if (!g.granted) continue;
        grantOrders++;
        if (g.ambiguous) ambiguous++;
        const cur = order.currencyCode;
        totals.set(cur, minorSum(totals.get(cur) ?? 0n, BigInt(g.grantedMinor)));

        const mergedRows = await deps.db.$queryRaw<{ n: bigint }[]>`
          SELECT COUNT(*)::bigint AS n FROM "MergeRecord"
          WHERE "shop" = ${deps.shop} AND "mergedOrderId" = ${order.id}`;
        const merged = Number(mergedRows[0]?.n ?? 0) > 0;
        const open = now.getTime() < new Date(order.createdAt).getTime() + mergeWindowMs;
        if (merged) {
          classes.merged++;
        } else if (open) {
          classes.open++;
        } else {
          classes.unmerged_expired++;
          realized.set(cur, minorSum(realized.get(cur) ?? 0n, BigInt(g.grantedMinor)));
        }
      }
      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
      if (cursor === null) break;
    }

    orders = {
      truncated,
      grantOrders,
      ambiguous,
      totals: Object.fromEntries([...totals].map(([k, v]) => [k, v.toString()])),
      classes,
      realizedExposure: Object.fromEntries([...realized].map(([k, v]) => [k, v.toString()])),
    };

    if (deps.capGrants !== undefined && grantOrders > deps.capGrants) {
      breach.push("CAP_GRANTS");
    }
    if (deps.capAmount !== undefined) {
      const cur = deps.currency ?? order2CurrencyFallback(totals);
      const capMinor = amountToMinor(deps.capAmount, cur);
      const total = (cur !== null ? totals.get(cur) : undefined) ?? 0n;
      if (capMinor !== null && total > capMinor) breach.push("CAP_AMOUNT");
    }
    if (truncated) breach.push("TRUNCATED");
  }

  if (overdraw > 0) breach.push("OVERDRAW");

  return {
    shop: deps.shop,
    work,
    orders,
    caps: {
      capGrants: deps.capGrants ?? null,
      capAmount: deps.capAmount ?? null,
      currency: deps.currency ?? null,
      breach,
    },
    withinCaps: breach.length === 0,
  };
}

const order2CurrencyFallback = (totals: Map<string, bigint>): string | null =>
  totals.size === 1 ? [...totals.keys()][0] : null;

function amountToMinor(amount: string, currency: string | null): bigint | null {
  if (!currency) return null;
  const p = getCurrencyPrecision(currency);
  if (p === null) return null;
  const m = amount.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const frac = (m[2] ?? "").padEnd(p, "0").slice(0, p);
  if ((m[2] ?? "").length > p) return null;
  return BigInt(m[1] + frac);
}
