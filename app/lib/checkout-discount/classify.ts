// Desired-state classification for one order (D3): pure — all Admin facts are
// mapped in by the processor; no clock (ctx carries `now`), no I/O.
//
//   CONSUME  the order carries an unambiguous MergeShip shipping grant and is
//            not cancelled — the matching record is consumed for this order id
//            (a consumer order NEVER issues: no free-shipping chains).
//   ISSUE    a qualifying paid order — a record is projected.
//   ABSENT   a durable ineligible state — ensure no unused record exists.
//   RETRY    evidence is not yet available (risk still null, incomplete
//            fields) — the record is left unchanged. A transient state is
//            NEVER ineligible, so it can never revoke by accident.
import { CHECKOUT_DISCOUNT_MESSAGE } from "./config";
import { destKey, normMethod, type DestInput } from "./dest-key";
import { detectShippingDiscountGrant, type GrantOrderFacts } from "./grant";
import { buildRecord, expiryDateFor, type EligRecord } from "./records";

export type AbsentCode =
  | "CANCELLED"
  | "CLOSED"
  | "NOT_PAID"
  | "REFUNDED"
  | "FULFILLED"
  | "RISK_NOT_LOW"
  | "WINDOW_PASSED"
  | "BEFORE_ENABLE_EPOCH"
  | "LOCATION"
  | "NO_CUSTOMER"
  | "NO_DEST"
  | "MULTI_SHIPPING"
  | "ZERO_SHIPPING"
  | "AMBIGUOUS_DISCOUNT"
  | "UNSUPPORTED_CURRENCY"
  | "WINDOW_TOO_SHORT"
  | "METHOD_NOT_APPROVED"
  | "SHIPPING_UNBOUNDED"
  | "ALREADY_CONSUMED";

export type RetryCode = "RISK_UNKNOWN" | "INCOMPLETE";

export type Decision =
  | {
      kind: "CONSUME";
      orderIdNum: string;
      match: { dest: string; method: string; cur: string };
      /** Minor units the grant allocated — diagnostics only. */
      allocatedMinor: string;
    }
  | { kind: "ISSUE"; record: EligRecord }
  | { kind: "ABSENT"; code: AbsentCode }
  | { kind: "RETRY"; code: RetryCode; reason: string };

/** Admin facts for one order, already mapped to plain values by the
 *  processor (money as minor-unit strings, connections unwrapped). */
export interface CheckoutFacts extends GrantOrderFacts {
  orderId: string;
  createdAt: string;
  cancelledAt: string | null;
  closed: boolean;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  /** Number of fulfillments observed (>= 0). */
  fulfillmentCount: number;
  riskLevel: string | null;
  currencyCode: string;
  supportedCurrency: boolean;
  customerId: string | null;
  shippingAddress: DestInput | null;
}

export interface ClassifyContext {
  enabledAt: Date;
  mergeWindowHours: number;
  windowId: string;
  now: Date;
  timeZone: string;
  /** Durable consumed mark on the work row (grantConsumedAt != null): this
   *  order already granted a checkout, so it can never issue a record
   *  again — regardless of what the metafield document currently holds. */
  grantConsumed?: boolean;
  /** Pilot method approval from the settings row the gate already loaded.
   *  When set, only exactly that normalized method, in that currency, with
   *  an original shipping cost within the cap qualifies. `undefined` means
   *  approval is absent — classify then fails closed, because an enabled
   *  gate without approval is a misconfiguration. */
  approved?: { method: string; maxMinor: bigint; currency: string };
}

const orderIdNum = (orderId: string): string =>
  String(orderId).match(/(\d+)$/)?.[1] ?? String(orderId);

export function classify(facts: CheckoutFacts, ctx: ClassifyContext): Decision {
  // Cancelled is durable: it outranks both consumption and every retry.
  if (facts.cancelledAt !== null) return { kind: "ABSENT", code: "CANCELLED" };

  // Fields a durable verdict needs; anything missing means the Admin data is
  // incomplete — retry, never treat as ineligible.
  if (
    facts.financialStatus == null ||
    facts.fulfillmentStatus == null ||
    facts.currencyCode == null ||
    !Array.isArray(facts.shippingLines)
  ) {
    return { kind: "RETRY", code: "INCOMPLETE", reason: "order facts incomplete" };
  }

  // A MergeShip grant takes priority over ISSUE and ABSENT: a consumer order
  // never issues a record (no free-shipping chains). An ambiguous shipping
  // delta can never be attributed, so it never issues and never consumes.
  const grant = detectShippingDiscountGrant(facts, {
    titleToken: CHECKOUT_DISCOUNT_MESSAGE,
  });
  if (grant.granted && grant.evidence === "ALLOCATION" && !grant.ambiguous) {
    const line = facts.shippingLines[0];
    return {
      kind: "CONSUME",
      orderIdNum: orderIdNum(facts.orderId),
      allocatedMinor: grant.grantedMinor,
      match: {
        dest: destKey(facts.shippingAddress) ?? "",
        method: normMethod(line?.title),
        cur: facts.currencyCode,
      },
    };
  }
  if (grant.granted && grant.ambiguous) return { kind: "ABSENT", code: "AMBIGUOUS_DISCOUNT" };

  if (facts.closed) return { kind: "ABSENT", code: "CLOSED" };
  if (facts.financialStatus === "REFUNDED") return { kind: "ABSENT", code: "REFUNDED" };
  if (facts.financialStatus !== "PAID") return { kind: "ABSENT", code: "NOT_PAID" };
  if (!facts.supportedCurrency) return { kind: "ABSENT", code: "UNSUPPORTED_CURRENCY" };
  if (facts.fulfillmentStatus !== "UNFULFILLED" || facts.fulfillmentCount > 0) {
    return { kind: "ABSENT", code: "FULFILLED" };
  }

  // Shopify fraud risk is populated asynchronously: null means the evidence
  // is not yet available — retry, never revoke on it.
  if (facts.riskLevel == null) {
    return { kind: "RETRY", code: "RISK_UNKNOWN", reason: "risk level not yet available" };
  }
  if (facts.riskLevel !== "LOW") return { kind: "ABSENT", code: "RISK_NOT_LOW" };
  if (!facts.customerId) return { kind: "ABSENT", code: "NO_CUSTOMER" };

  const created = new Date(facts.createdAt).getTime();
  if (created < ctx.enabledAt.getTime()) return { kind: "ABSENT", code: "BEFORE_ENABLE_EPOCH" };
  if (ctx.now.getTime() >= created + ctx.mergeWindowHours * 3_600_000) {
    return { kind: "ABSENT", code: "WINDOW_PASSED" };
  }
  if (facts.shippingLines.length !== 1) return { kind: "ABSENT", code: "MULTI_SHIPPING" };

  // Pilot bound — only the operator-approved method within the approved
  // cost cap qualifies. An enabled feature without approval is a
  // misconfiguration and fails closed the same way.
  const shipLine = facts.shippingLines[0];
  if (!ctx.approved) {
    // An enabled feature without approval is a misconfiguration — the gate
    // refuses first (method-unconfigured); classify fails closed too.
    return { kind: "ABSENT", code: "SHIPPING_UNBOUNDED" };
  }
  if (normMethod(shipLine?.title) !== ctx.approved.method) {
    return { kind: "ABSENT", code: "METHOD_NOT_APPROVED" };
  }
  if (facts.currencyCode !== ctx.approved.currency || BigInt(shipLine.originalMinor) > ctx.approved.maxMinor) {
    return { kind: "ABSENT", code: "SHIPPING_UNBOUNDED" };
  }

  // Durable consumed evidence outranks eligibility: the metafield tombstone
  // may have been evicted or pruned, but the work row still knows this order
  // granted — a second record is never built for it.
  if (ctx.grantConsumed) return { kind: "ABSENT", code: "ALREADY_CONSUMED" };

  // No full shop-local day fits inside the merge window — the record could
  // outlive the window it stands in for, so it must never be written.
  const expiresOn = expiryDateFor({
    createdAt: facts.createdAt,
    windowHours: ctx.mergeWindowHours,
    timeZone: ctx.timeZone,
  });
  if (expiresOn === null) return { kind: "ABSENT", code: "WINDOW_TOO_SHORT" };

  const built = buildRecord(
    {
      orderId: facts.orderId,
      customerId: facts.customerId,
      currencyCode: facts.currencyCode,
      shippingAddress: facts.shippingAddress,
      shippingLines: facts.shippingLines.map((l) => ({
        title: l.title ?? "",
        originalMinor: l.originalMinor,
        discountedMinor: l.discountedMinor,
      })),
      cancelledAt: facts.cancelledAt,
      financialStatus: facts.financialStatus,
    },
    { windowId: ctx.windowId, expiresOn },
  );
  if (!built.ok) {
    const code: AbsentCode =
      built.reason === "NOT_SINGLE_SHIPPING_LINE" ? "MULTI_SHIPPING" : built.reason;
    return { kind: "ABSENT", code };
  }
  // An already-dead record can never grant (window > 24h and the replay
  // arrived after its expiry date): treat it like a passed window rather
  // than write an instantly-expired record that verification could never
  // confirm.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: ctx.timeZone }).format(ctx.now);
  if (built.record.exp < today) return { kind: "ABSENT", code: "WINDOW_PASSED" };
  return { kind: "ISSUE", record: built.record };
}
