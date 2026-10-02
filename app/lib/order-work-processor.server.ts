// ── Order work processor ──────────────────────────────────────────────────────
// Drives one durable work item (order-work.server.ts) to a terminal outcome:
// evaluates the anchor order on fresh state, finds mergeable siblings, and
// runs executeMerge under a work-item lease renewed by the merge's outer
// fence. Failures classify as contention/transient retries until the item is
// DONE, exhausted, or its deadline passes — a crashed worker's item is picked
// up by the sweeper once its lease expires.

import { SessionNotFoundError } from "@shopify/shopify-app-remix/server";
import { gql, type AdminClient } from "./graphql.server";
import { buildAddressKey, buildGroupKey, orderStateIneligibility, type OrderState } from "./eligibility";
import {
  executeMerge,
  ORDER_STATE_QUERY,
  type MergeDeps,
} from "./merge.server";
import { OwnershipLostError } from "./ownership.server";
import { isOnboardingComplete } from "./onboarding";
import type { MergeSettings } from "./settings.server";
import {
  INDEX_LAG_GRACE_MS,
  MAX_ATTEMPTS,
  retryDelayMs,
  type WorkItem,
  type WorkOutcome,
  type WorkStore,
} from "./order-work.server";

export interface ProcessOrderWorkArgs {
  item: WorkItem;
  /** The token this item is currently leased to (from insertLeased/claimDue). */
  token: string;
  shop: string;
  /** Fast path: the authenticated webhook admin. */
  admin?: AdminClient;
  /** Sweeper path: resolves the offline session; null = no session. */
  adminFactory?: (shop: string) => Promise<AdminClient | null>;
  deps: MergeDeps;
  work: WorkStore;
  settings: (shop: string) => Promise<MergeSettings>;
  now: () => Date;
  random?: () => number;
}

/** The same customer-orders query the old webhook route ran; eligibility is
 *  re-checked on fresh state inside executeMerge, so this only needs the
 *  fields the group key and the window filter use. */
const MERGE_CANDIDATE_QUERY = `#graphql
  query MergeCandidateOrders($customerId: ID!) {
    customer(id: $customerId) {
      orders(
        first: 50
        sortKey: CREATED_AT
        reverse: true
        query: "fulfillment_status:unfulfilled status:open financial_status:paid"
      ) {
        nodes {
          id
          name
          createdAt
          shippingAddress {
            firstName
            lastName
            company
            address1
            address2
            city
            provinceCode
            zip
            countryCodeV2
          }
          shippingLines(first: 5) { nodes { title } }
        }
      }
    }
  }`;

// instanceof plus a constructor-name check so a duplicated copy of the
// shopify-app-remix package still counts (SessionNotFoundError itself does
// not set .name — it stays "Error").
export const isSessionNotFound = (err: unknown) =>
  err instanceof SessionNotFoundError || (err as any)?.constructor?.name === "SessionNotFoundError";

const ACTIVE_STATUSES = ["PENDING_COMMIT", "COMMITTED"];

export async function processOrderWork(args: ProcessOrderWorkArgs): Promise<void> {
  const { item, token, shop, deps, work, now } = args;
  const random = args.random ?? Math.random;
  const label = () => `[work] ${shop} ${item.orderId} (attempt ${item.attempts})`;

  const done = async (outcome: WorkOutcome, reason: string) => {
    if (await work.markDone(item.id, token, outcome, reason)) {
      console.log(`${label()}: ${outcome} — ${reason}`);
    } else {
      console.log(`${label()}: ownership lost; ${outcome} not recorded.`);
    }
  };

  const retry = async (
    kind: "contention" | "transient",
    reason: string,
    delayMs = retryDelayMs(kind, item.attempts, random),
  ) => {
    if (item.attempts >= MAX_ATTEMPTS || (item.deadlineAt && now() > item.deadlineAt)) {
      console.error(`${label()}: EXHAUSTED — ${reason}`);
      await done("EXHAUSTED", reason);
      return;
    }
    console.log(`${label()}: retrying in ${Math.round(delayMs / 1000)}s (${kind}) — ${reason}`);
    if (!(await work.scheduleRetry(item.id, token, delayMs, reason))) {
      console.log(`${label()}: ownership lost; retry not recorded.`);
    }
  };

  try {
    // 1 — Re-checked here: the merchant may have paused between the webhook
    // and a later sweeper pass.
    const settings = await args.settings(shop);
    if (!settings.autoMergeEnabled || !isOnboardingComplete(settings)) {
      return done("AUTOMATION_OFF", "automatic merging is off or setup is incomplete");
    }

    // 2 — Admin client: the webhook passes its session's; the sweeper
    // resolves the offline session (missing session = app was uninstalled).
    let admin = args.admin;
    if (!admin) {
      try {
        admin = (await args.adminFactory?.(shop)) ?? undefined;
      } catch (err) {
        if (isSessionNotFound(err)) return done("SHOP_UNINSTALLED", "no offline session for the shop");
        throw err;
      }
      if (!admin) return done("SHOP_UNINSTALLED", "no offline session for the shop");
    }

    // 3 — Anchor order, fresh. A missing/cancelled/closed order is gone; any
    // other state-level rule failure is a terminal INELIGIBLE.
    const nodes = await gql<(OrderState | null)[]>(
      admin,
      "Load order",
      ORDER_STATE_QUERY,
      { ids: [item.orderId] },
      "nodes",
      null,
    );
    const anchor = nodes?.find((n) => n?.id === item.orderId) ?? null;
    if (!anchor || anchor.cancelledAt || anchor.closed) {
      return done(
        "ANCHOR_GONE",
        anchor ? `order ${anchor.name} is ${anchor.cancelledAt ? "cancelled" : "closed"}` : "order no longer exists",
      );
    }
    const anchorIneligible = orderStateIneligibility(anchor);
    if (anchorIneligible) return done("INELIGIBLE", anchorIneligible);

    // 4 — Group key from the fresh anchor (never the webhook payload).
    const shippingTitles = (anchor.shippingLines?.nodes ?? []).map((l) => l?.title);
    const groupKey = buildGroupKey(anchor.customer?.id, anchor.shippingAddress, shippingTitles);
    if (!groupKey) {
      const why = !buildAddressKey(anchor.customer?.id, anchor.shippingAddress)
        ? "no usable shipping address"
        : shippingTitles.length !== 1
          ? `${shippingTitles.length} shipping lines on the order (exactly one required)`
          : "shipping line has no title";
      return done("INELIGIBLE", `${anchor.name}: ${why}`);
    }

    // 5 — Candidates: the customer's recent open/unfulfilled/paid orders.
    const customer = await gql<{ orders?: { nodes: any[] } }>(
      admin,
      "Load customer orders",
      MERGE_CANDIDATE_QUERY,
      { customerId: anchor.customer!.id },
      "customer",
      null,
    );
    const siblings = customer.orders?.nodes ?? [];

    // 6 — Journal involvement on the anchor itself.
    const statuses = await deps.journal.findBlockingOrderStatuses(shop);
    const anchorStatus = statuses.get(item.orderId);
    if (anchorStatus && ACTIVE_STATUSES.includes(anchorStatus)) {
      return retry("contention", `${anchor.name} is part of an unfinished merge`);
    }
    if (anchorStatus === "NEEDS_REVIEW") {
      return done("REVIEW", `${anchor.name} is part of a merge flagged for review`);
    }

    // 7 — Same-group siblings inside the merge window, partitioned by journal
    // involvement: review-flagged orders are excluded permanently, active ones
    // mean the group is already being merged elsewhere.
    const anchorTime = new Date(anchor.createdAt).getTime();
    const mergeWindowMs = settings.mergeWindowHours * 60 * 60 * 1000;
    const matching = siblings.filter((sibling) => {
      if (sibling.id === item.orderId) return false;
      const key = buildGroupKey(
        anchor.customer!.id,
        sibling.shippingAddress,
        (sibling.shippingLines?.nodes ?? []).map((l: any) => l?.title),
      );
      const t = new Date(sibling.createdAt).getTime();
      return key === groupKey && !isNaN(t) && Math.abs(anchorTime - t) <= mergeWindowMs;
    });
    const active = matching.filter((s) => ACTIVE_STATUSES.includes(statuses.get(s.id) ?? ""));
    const free = matching.filter((s) => !statuses.has(s.id));

    if (free.length) {
      const result = await executeMerge(
        admin,
        shop,
        [item.orderId, ...free.map((s) => s.id as string)],
        // Every merge fence also renews this work item's lease, so a long
        // merge cannot lose it mid-flight.
        { ...deps, outerFence: () => work.renew(item.id, token, deps.leaseTtlMs) },
      );
      if (result.outcome === "merged") return done("MERGED", `merged into ${result.primaryName}`);
      if (result.outcome === "needs_review") return done("REVIEW", result.reason ?? "merge needs review");
      if (result.disposition === "terminal") {
        return done(
          result.code === "LOCATION_ACCESS" ? "LOCATION_ACCESS" : "INELIGIBLE",
          result.reason ?? "not eligible",
        );
      }
      return retry(result.disposition, result.reason ?? result.outcome);
    }
    if (active.length) {
      return retry(
        "contention",
        `sibling(s) ${active.map((s) => s.name ?? s.id).join(", ")} are part of an unfinished merge`,
      );
    }

    // Shopify's search index can lag a brand-new order; give it the grace
    // window before concluding there is genuinely nothing to merge with.
    const indexLagMs = item.createdAt.getTime() + INDEX_LAG_GRACE_MS - now().getTime();
    if (indexLagMs > 0) {
      return retry("transient", "no siblings yet; waiting for the search index", Math.max(indexLagMs, 5_000));
    }
    return done("NO_SIBLINGS", `no matching sibling within ${settings.mergeWindowHours}h`);
  } catch (err: any) {
    // A lost work-item lease (raised by the merge's outer fence or a renew)
    // means another worker owns the item now — write nothing.
    if (err instanceof OwnershipLostError) {
      console.log(`${label()}: lost work lease; another worker owns it.`);
      return;
    }
    return retry("transient", err?.message ?? String(err));
  }
}
