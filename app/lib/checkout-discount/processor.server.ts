// Checkout-eligibility work processor: reconciles ONE order's desired
// projection state from fresh Admin data (D1/D3). The webhook payload and
// topic are never trusted — a paid, cancelled or fulfilled delivery all run
// the same reconciliation, so duplicates, reordering, delayed payment and
// restarts converge.
//
// Sequence: gate (authoritative re-check) → load order + shop timezone →
// location rule (ISSUE candidates only) → classify → CAS projection write
// (lease renewed immediately before it) → post-write read-back verification
// → complete() fenced on the generation that was processed. A failed or
// unverified write is a retry, never a success; a transient state never
// revokes a record.

import { OwnershipLostError } from "../ownership.server";
import { gqlData, ShopifyGraphqlError, type AdminClient } from "../graphql.server";
import { fetchAllLineItems, resolveMergeLocation } from "../merge.server";
import type { OrderState } from "../eligibility";
import { isSessionNotFound } from "../order-work-processor.server";
import { getCurrencyPrecision, parseShopMoney } from "../money";
import { classify, type CheckoutFacts, type Decision } from "./classify";
import { checkoutDiscountWindowId } from "./config";
import { defaultDiag, type Diag, type DiagEvent } from "./diag";
import { checkoutDiscountGate, type CheckoutGateDeps } from "./gate.server";
import {
  ProjectionConflictError,
  ProjectionWriteError,
  writeProjection,
  PROJECTION_READ,
  type AdminGraphql,
} from "./projection-write";
import {
  consumeRecord,
  mergeRecords,
  parseElig,
  revokeRecord,
  selectRecordForCheckout,
  type EligRecord,
} from "./records";
import {
  CHECKOUT_MAX_ATTEMPTS,
  retryDelayMs,
  type CheckoutWorkItem,
  type CheckoutWorkStore,
} from "./work.server";

// Same fields as the merge engine's ORDER_STATE_FIELDS plus the checkout
// evidence the grant detector needs (live-validated on the spike store):
// discounted shipping price, per-line allocations with the application
// title, the order-level applications and the shop's local timezone.
const CHECKOUT_ORDER_QUERY = `#graphql
  query CheckoutEligibilityOrder($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      processedAt
      cancelledAt
      cancellation { staffNote }
      closed
      displayFinancialStatus
      displayFulfillmentStatus
      riskLevel
      currencyCode
      presentmentCurrencyCode
      note
      tags
      customer { id }
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
      shippingLines(first: 5) {
        nodes {
          title
          code
          source
          carrierIdentifier
          custom
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
      fulfillments(first: 5) { id }
      discountApplications(first: 20) {
        nodes {
          __typename
          targetType
          ... on AutomaticDiscountApplication { title }
        }
      }
    }
    shop { ianaTimezone }
  }`;

interface CheckoutOrderData {
  order: (OrderState & {
    processedAt?: string | null;
    shippingLines: {
      nodes: (OrderState["shippingLines"]["nodes"][number] & {
        discountedPriceSet?: { shopMoney: { amount: string; currencyCode: string } } | null;
        discountAllocations?: {
          allocatedAmountSet?: { shopMoney: { amount: string; currencyCode: string } } | null;
          discountApplication?: { targetType?: string | null; title?: string | null } | null;
        }[];
      })[];
    };
    discountApplications?: {
      nodes: { targetType?: string | null; title?: string | null }[];
    } | null;
  }) | null;
  shop: { ianaTimezone?: string | null } | null;
}

type ShippingLineNode = NonNullable<CheckoutOrderData["order"]>["shippingLines"]["nodes"][number];

const minorOf = (shopMoney: unknown): string | null =>
  parseShopMoney(shopMoney)?.minorUnits.toString() ?? null;

const localDateOf = (epochMs: number, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(epochMs));

const isTransient = (err: unknown): boolean => {
  if (err instanceof ProjectionConflictError) return true;
  if (err instanceof ShopifyGraphqlError) return !err.rejected;
  return err instanceof Error;
};

export interface ProcessCheckoutWorkArgs {
  item: CheckoutWorkItem;
  token: string;
  shop: string;
  admin?: AdminClient;
  /** Same contract as the sweeper's adminFactory: null = no offline session
   *  (shop uninstalled), a throw is retried. */
  adminFactory?: (shop: string) => Promise<AdminClient | null>;
  work: CheckoutWorkStore;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  gate?: Partial<CheckoutGateDeps>;
  diag?: Diag;
  leaseTtlMs?: number;
}

export async function processCheckoutWork(args: ProcessCheckoutWorkArgs): Promise<void> {
  const { item, token, shop, work, now } = args;
  const random = args.random ?? Math.random;
  const sleep = args.sleep ?? (async () => {});
  const diag = args.diag ?? defaultDiag;
  const leaseTtl = args.leaseTtlMs ?? 90_000;
  const started = Date.now();
  const emit = (e: Omit<DiagEvent, "shop" | "orderId" | "attempts" | "durationMs">) =>
    diag({ ...e, attempts: item.attempts, durationMs: Date.now() - started, shop, orderId: item.orderId });

  const settle = async (outcome: string, reason: string, kind?: Parameters<Diag>[0]["kind"], code?: string) => {
    const r = await work.complete(item.id, token, item.gen, outcome, reason);
    if (r === "DONE" && kind) emit({ kind, code });
    if (r !== "DONE") {
      console.log(`[checkout] ${shop} ${item.orderId}: settle ${outcome} -> ${r}`);
    }
  };

  const retry = async (code: string, reason: string, kind: "RETRY" | "FAILED" = "RETRY") => {
    const delay = retryDelayMs("transient", item.attempts, random);
    emit({ kind, code, reason });
    const ok = await work.scheduleRetry(item.id, token, delay, reason);
    if (!ok) console.log(`[checkout] ${shop} ${item.orderId}: retry lost ownership`);
  };

  // (1) Authoritative gate re-check: levers can flip between delivery and
  //     processing. Off => DONE FEATURE_OFF, no Admin call at all.
  const gate = await checkoutDiscountGate(shop, args.gate);
  if (!gate.on) {
    await settle("FEATURE_OFF", `gate off: ${gate.reason}`, "FEATURE_OFF", gate.reason);
    return;
  }

  // (2) Admin client — a missing offline session means the app was
  //     uninstalled: terminal, not a retry.
  let admin: AdminClient | null = null;
  try {
    admin = args.admin ?? (await args.adminFactory?.(shop)) ?? null;
  } catch (err) {
    if (isSessionNotFound(err)) {
      await settle("SHOP_UNINSTALLED", "no Admin session for shop");
      return;
    }
    await retry("SESSION", `admin session failed: ${(err as any)?.message ?? err}`);
    return;
  }
  if (!admin) {
    if (args.admin || args.adminFactory) {
      await settle("SHOP_UNINSTALLED", "no offline session for the shop");
      return;
    }
    await retry("NO_ADMIN", "no admin client available");
    return;
  }

  const adminGql: AdminGraphql = {
    graphql: async (query, options) => {
      const res = await admin!.graphql(query, options);
      const body: any = await res.json().catch(() => null);
      if (!res.ok) {
        throw new ShopifyGraphqlError(`projection call failed: HTTP ${res.status}`, false);
      }
      if (body?.errors?.length) {
        throw new ShopifyGraphqlError(
          `projection call failed: ${JSON.stringify(body.errors)}`,
          false,
        );
      }
      return body;
    },
  };

  // (3) Load the order fresh — the payload/topic is never trusted.
  let data: CheckoutOrderData | null;
  try {
    data = await gqlData<CheckoutOrderData>(
      admin,
      "Load checkout-eligibility order",
      CHECKOUT_ORDER_QUERY,
      { id: item.orderId },
    );
  } catch (err: any) {
    if (isSessionNotFound(err)) {
      await settle("SHOP_UNINSTALLED", "Admin session revoked");
      return;
    }
    await retry("ORDER_LOAD", `order load failed: ${err?.message ?? err}`);
    return;
  }
  const order = data?.order ?? null;
  if (!order) {
    await settle("ORDER_GONE", "order not found", "NO_RECORD", "ORDER_GONE");
    return;
  }
  const timeZone = data?.shop?.ianaTimezone ?? "UTC";
  const nowDate = now();
  const today = localDateOf(nowDate.getTime(), timeZone);

  const supportedCurrency = getCurrencyPrecision(order.currencyCode) !== null;
  const facts: CheckoutFacts = {
    orderId: order.id,
    createdAt: order.createdAt,
    cancelledAt: order.cancelledAt,
    closed: order.closed,
    financialStatus: order.displayFinancialStatus,
    fulfillmentStatus: order.displayFulfillmentStatus,
    fulfillmentCount: order.fulfillments?.length ?? 0,
    riskLevel: order.riskLevel,
    currencyCode: order.currencyCode,
    supportedCurrency,
    customerId: order.customer?.id ?? null,
    shippingAddress: order.shippingAddress
      ? { ...order.shippingAddress, countryCode: order.shippingAddress.countryCodeV2 }
      : null,
    shippingLines: order.shippingLines.nodes.map((l: ShippingLineNode) => ({
      title: l.title ?? "",
      originalMinor: minorOf(l.originalPriceSet?.shopMoney) ?? "0",
      discountedMinor: minorOf(l.discountedPriceSet?.shopMoney) ?? "0",
      discountAllocations: (l.discountAllocations ?? []).map(
        (a: NonNullable<ShippingLineNode["discountAllocations"]>[number]) => ({
          amountMinor: minorOf(a.allocatedAmountSet?.shopMoney) ?? "0",
          applicationTitle: a.discountApplication?.title ?? null,
        }),
      ),
    })),
    discountApplications: (order.discountApplications?.nodes ?? []).map((a: { targetType?: string | null; title?: string | null }) => ({
      targetType: a.targetType ?? null,
      title: a.title ?? null,
    })),
  };

  let decision: Decision = classify(facts, {
    enabledAt: gate.enabledAt,
    mergeWindowHours: gate.mergeWindowHours,
    windowId: checkoutDiscountWindowId(),
    now: nowDate,
    timeZone,
  });

  // (4) The location rule only gates ISSUE — an ISSUE candidate that fails
  //     (or cannot prove) it becomes ABSENT LOCATION; a transient read
  //     failure is a retry, never a revoke.
  if (decision.kind === "ISSUE") {
    try {
      const lineItems = new Map([[order.id, await fetchAllLineItems(admin, order.id)]]);
      const loc = await resolveMergeLocation(admin, [order], lineItems);
      if (!loc.ok) decision = { kind: "ABSENT", code: "LOCATION" };
    } catch (err: any) {
      await retry("LOCATION_READ", `location read failed: ${err?.message ?? err}`);
      return;
    }
  }

  const orderNum = String(order.id).match(/(\d+)$/)?.[1] ?? order.id;

  // (5) Effect. Every projection write goes through the CAS writer; the work
  //     lease is renewed immediately before each write so a stale worker can
  //     never push a metafield.
  const renew = async () => {
    try {
      await work.renew(item.id, token, leaseTtl);
      return true;
    } catch (err) {
      if (err instanceof OwnershipLostError) return false;
      throw err;
    }
  };

  try {
    if (decision.kind === "RETRY") {
      await retry(decision.code, decision.reason);
      return;
    }

    if (decision.kind === "ISSUE") {
      const record: EligRecord = decision.record;
      const customerId = facts.customerId;
      if (!customerId) {
        // classify can only ISSUE with a customer; defensive no-write.
        await settle("CUSTOMER_GONE", "order has no customer", "REFUSED", "NO_CUSTOMER");
        return;
      }
      if (!(await renew())) return;
      // Whether the CAS read saw this id already CONSUMED (a used tombstone
      // or a spent record): mergeRecords deliberately refuses to resurrect
      // it, so "no grantable record" IS the correct converged state then.
      let sawConsumedId = false;
      const { written } = await writeProjection(
        adminGql,
        customerId,
        (current) => {
          const { doc } = parseElig(current);
          if (doc.recs.some((r) => r.id === record.id && (r.used?.length ?? 0) > 0)) {
            sawConsumedId = true;
          }
          const m = mergeRecords(current, [record], { todayDate: today, maxRecs: 5 });
          return { serialized: m.serialized };
        },
        { sleep, random },
      );
      // (7) Read-back verification: the expected record must be visible —
      // unless the id was already consumed, in which case its absence (or a
      // left:0 tombstone) is exactly what must be there.
      const verified = await verify(adminGql, customerId, (doc) =>
        sawConsumedId
          ? doc.recs.every((r) => r.id !== record.id || r.left <= 0)
          : doc.recs.some((r) => r.id === record.id && r.left > 0 && r.exp >= today),
      );
      if (!verified) {
        await retry("VERIFY_MISMATCH", "projection read-back mismatch");
        return;
      }
      await settle("PROJECTED", written ? "record projected" : "record already projected", "PROJECTED");
      return;
    }

    if (decision.kind === "CONSUME") {
      const customerId = facts.customerId;
      if (!customerId) {
        await settle("CUSTOMER_GONE", "consumed order has no customer", "OVERDRAW", "NO_CUSTOMER");
        return;
      }
      // The Function-equivalent selection decides WHICH record granted this
      // checkout — never consume a record it could not have matched.
      const current = await readDoc(adminGql, customerId);
      const match = selectRecordForCheckout(current, {
        win: checkoutDiscountWindowId(),
        dest: decision.match.dest,
        method: decision.match.method,
        cur: decision.match.cur,
        today,
      });
      if (!match) {
        // The signature of simultaneous checkouts (D3/§5): a granted order
        // no living record can explain.
        await settle("CONSUMED_NO_RECORD", "grant with no matching record", "OVERDRAW", "NO_MATCHING_RECORD");
        return;
      }
      if (!(await renew())) return;
      await writeProjection(
        adminGql,
        customerId,
        (cur) => {
          const c = consumeRecord(cur, { recordId: match.id, byOrderId: decision.orderIdNum }, { todayDate: today });
          return c.changed ? { serialized: c.serialized } : null;
        },
        { sleep, random },
      );
      const verified = await verify(adminGql, customerId, (doc) => {
        const rec = doc.recs.find((r) => r.id === match.id);
        // Verified when the tombstone carries this order, or the record is
        // already gone (pruned expired — it can grant nothing either way).
        return rec === undefined || (rec.used ?? []).includes(decision.orderIdNum);
      });
      if (!verified) {
        await retry("VERIFY_MISMATCH", "consumption read-back mismatch");
        return;
      }
      await settle(
        "CONSUMED",
        `record ${match.id} consumed; allocated ${decision.allocatedMinor}`,
        "CONSUMED",
        "ALLOCATION",
      );
      return;
    }

    // ABSENT: ensure no UNUSED record for this order survives. A used
    // tombstone is never touched — revokeRecord keeps it at left:0.
    {
      const customerId = facts.customerId;
      if (!customerId) {
        await settle(decision.code, `no customer (${decision.code})`, "REFUSED", decision.code);
        return;
      }
      if (!(await renew())) return;
      const { written } = await writeProjection(
        adminGql,
        customerId,
        (cur) => {
          const r = revokeRecord(cur, orderNum);
          return r.changed ? { serialized: r.serialized } : null;
        },
        { sleep, random },
      );
      const verified = await verify(adminGql, customerId, (doc) => {
        const rec = doc.recs.find((r) => r.id === orderNum);
        return rec === undefined || rec.left <= 0;
      });
      if (!verified) {
        await retry("VERIFY_MISMATCH", "revocation read-back mismatch");
        return;
      }
      const kind = written ? "REVOKED" : "REFUSED";
      await settle(kind === "REVOKED" ? "REVOKED" : decision.code, decision.code, kind, decision.code);
      return;
    }
  } catch (err: any) {
    if (err instanceof OwnershipLostError) return; // lost the lease mid-write: stop silently
    if (err instanceof ProjectionWriteError || err instanceof ProjectionConflictError) {
      await retry(
        err instanceof ProjectionConflictError ? "CAS_CONFLICT" : "WRITE_REFUSED",
        err.message.slice(0, 200),
        "FAILED",
      );
      return;
    }
    if (isTransient(err)) {
      await retry("TRANSIENT", `${err?.message ?? err}`.slice(0, 200));
      return;
    }
    throw err;
  }
}

const readDoc = async (admin: AdminGraphql, customerId: string) => {
  const res: any = await admin.graphql(PROJECTION_READ, { variables: { ownerId: customerId } });
  const data = res?.data ?? res;
  return data?.customer?.metafield?.jsonValue ?? null;
};

/** Post-write read-back: the freshly read document must satisfy `expect`.
 *  A null customer means the customer is gone (verified — nothing to do). */
const verify = async (
  admin: AdminGraphql,
  customerId: string,
  expect: (doc: ReturnType<typeof parseElig>["doc"]) => boolean,
): Promise<boolean> => {
  const res: any = await admin.graphql(PROJECTION_READ, { variables: { ownerId: customerId } });
  const data = res?.data ?? res;
  const customer = data?.customer;
  if (customer === null || customer === undefined) return false;
  const { doc } = parseElig(customer.metafield?.jsonValue ?? null);
  return expect(doc);
};

export { CHECKOUT_MAX_ATTEMPTS };
