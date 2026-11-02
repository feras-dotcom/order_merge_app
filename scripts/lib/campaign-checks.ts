// Pure campaign-expectation checks for the G-E7 / A-NEG read-back runner
// (scripts/shipping-refund-campaign-readback.ts). No I/O except reading a
// directory listing for manifest accumulation — every function takes plain
// response objects so the rules are testable without Shopify.
//
// Verdicts: "PASS" only when the expected experiment result matches the
// Shopify response; "FAIL" on a definitive mismatch; "INCOMPLETE" when the
// evidence needed to decide is unavailable or truncated. An INCOMPLETE
// check is never counted as a pass, and a response-shape pass is never
// promoted to a financial pass — every financial expectation is checked
// against read-back data only.

import { readdirSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

export type CheckVerdict = "PASS" | "FAIL" | "INCOMPLETE";

export interface CheckItem {
  readonly name: string;
  readonly verdict: CheckVerdict;
  readonly detail: string;
}

const pass = (name: string, detail = "ok"): CheckItem => ({ name, verdict: "PASS", detail });
const failCheck = (name: string, detail: string): CheckItem => ({ name, verdict: "FAIL", detail });
const incomplete = (name: string, detail: string): CheckItem => ({ name, verdict: "INCOMPLETE", detail });

export function overallVerdict(items: readonly CheckItem[]): CheckVerdict {
  if (items.some((i) => i.verdict === "FAIL")) return "FAIL";
  if (items.some((i) => i.verdict === "INCOMPLETE")) return "INCOMPLETE";
  return "PASS";
}

// ── Money ───────────────────────────────────────────────────────────────

/** Decimal string -> minor units at <=3 fraction digits; null on any
 *  malformed or higher-precision input. Never floats. */
export function parseMoneyMinor(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d{1,12}(\.\d{1,3})?$/.test(value)) return null;
  const [i, f = ""] = value.split(".");
  return BigInt(i) * 1000n + BigInt((f + "000").slice(0, 3));
}

const moneyAmount = (set: unknown): string | null => {
  const m = (set as { presentmentMoney?: { amount?: unknown }; shopMoney?: { amount?: unknown } } | null | undefined);
  const a = m?.presentmentMoney?.amount ?? m?.shopMoney?.amount;
  return typeof a === "string" ? a : null;
};

export const moneyMinor = (set: unknown): bigint | null => parseMoneyMinor(moneyAmount(set));
const moneyCurrency = (set: unknown): string | null => {
  const m = (set as { presentmentMoney?: { currencyCode?: unknown }; shopMoney?: { currencyCode?: unknown } } | null | undefined);
  const c = m?.presentmentMoney?.currencyCode ?? m?.shopMoney?.currencyCode;
  return typeof c === "string" ? c : null;
};

// ── Order guard (pre-send) ──────────────────────────────────────────────

export interface GuardOptions {
  readonly expectedStoreOrderStatuses: readonly string[];
  readonly minAvailableShippingMinor?: bigint; // optional capacity bound
}

/** Guard expectations for an order about to receive a refund. */
export function checkOrderGuard(order: Record<string, unknown> | null | undefined, opts: GuardOptions): CheckItem[] {
  const items: CheckItem[] = [];
  if (!order) return [failCheck("guard.order", "order is null")];
  items.push(order.test === true
    ? pass("guard.test")
    : failCheck("guard.test", `order.test=${JSON.stringify(order.test)}`));
  items.push(order.refundable === true
    ? pass("guard.refundable")
    : failCheck("guard.refundable", `order.refundable=${JSON.stringify(order.refundable)}`));
  const fin = String(order.displayFinancialStatus ?? "");
  items.push(opts.expectedStoreOrderStatuses.includes(fin)
    ? pass("guard.financialStatus", fin)
    : failCheck("guard.financialStatus", `displayFinancialStatus=${fin || "(missing)"}`));
  const gws = order.paymentGatewayNames;
  items.push(Array.isArray(gws) && gws.length > 0 && gws.every((g) => g === "bogus")
    ? pass("guard.gateways", "bogus only")
    : failCheck("guard.gateways", `paymentGatewayNames=${JSON.stringify(gws)}`));
  const txns = order.transactions;
  if (!Array.isArray(txns)) {
    items.push(failCheck("guard.transactions", "transactions is not an array"));
    return items;
  }
  if (txns.length === 0) {
    items.push(failCheck("guard.transactions", "empty transaction read"));
  } else if (txns.length >= 50) {
    // At the read bound: completeness cannot be proven (plain array may be
    // silently truncated).
    items.push(incomplete("guard.transactions", `read bound reached (${txns.length}) — completeness unproven`));
  } else {
    items.push(pass("guard.transactions", `${txns.length} transactions, complete`));
  }
  items.push(txns.every((t) => (t as { test?: boolean }).test === true)
    ? pass("guard.txTest")
    : failCheck("guard.txTest", "a transaction has test != true"));
  const parent = txns.find((t) => {
    const x = t as { kind?: string; status?: string; gateway?: string; test?: boolean };
    return (x.kind === "CAPTURE" || x.kind === "SALE") && x.status === "SUCCESS" && x.gateway === "bogus" && x.test === true;
  }) as { id?: string } | undefined;
  items.push(parent
    ? pass("guard.parent", `successful test ${(parent as { kind?: string }).kind} ${parent.id ?? ""}`)
    : failCheck("guard.parent", "no successful test CAPTURE/SALE"));
  const ship = moneyMinor(order.totalShippingPriceSet);
  const refundedShip = moneyMinor(order.totalRefundedShippingSet);
  if (ship === null || refundedShip === null) {
    items.push(incomplete("guard.shippingCapacity", "shipping totals unreadable"));
  } else {
    const remaining = ship - refundedShip;
    const cur = moneyCurrency(order.totalShippingPriceSet) ?? "?";
    if (opts.minAvailableShippingMinor !== undefined && remaining < opts.minAvailableShippingMinor) {
      items.push(failCheck("guard.shippingCapacity", `remaining ${remaining} minor < required ${opts.minAvailableShippingMinor} minor (${cur})`));
    } else {
      items.push(pass("guard.shippingCapacity", `remaining ${remaining} minor units (${cur})`));
    }
  }
  return items;
}

// ── Baseline delta (post-send) ──────────────────────────────────────────

export interface OrderBaseline {
  readonly orderId: string;
  readonly runAtUtc: string;
  readonly refundIds: readonly string[];
  readonly totalRefundedMinor: string; // decimal minor at 3dp, as string
  readonly totalRefundedShippingMinor: string;
}

export interface DeltaOptions {
  readonly newRefundId: string;
  readonly shippingDeltaMinor: bigint; // expected additional shipping refunded
  readonly totalDeltaMinor: bigint; // expected additional total refunded
}

/** Compare a reconcile read against the persisted pre-send baseline. */
export function checkBaselineDelta(
  baseline: OrderBaseline,
  order: Record<string, unknown> | null | undefined,
  opts: DeltaOptions,
): CheckItem[] {
  const items: CheckItem[] = [];
  if (!order) return [failCheck("delta.order", "order is null")];
  const refunds = order.refunds;
  if (!Array.isArray(refunds)) return [failCheck("delta.refunds", "refunds is not an array")];
  const nowIds = refunds.map((r) => (r as { id?: string }).id).filter((x): x is string => typeof x === "string");
  const expectedIds = new Set([...baseline.refundIds, opts.newRefundId]);
  const nowSet = new Set(nowIds);
  const missing = [...expectedIds].filter((id) => !nowSet.has(id));
  const unexpected = [...nowSet].filter((id) => !expectedIds.has(id));
  if (nowIds.length !== nowSet.size) {
    items.push(failCheck("delta.refundSet", `duplicate refund ids in read (${nowIds.length} ids, ${nowSet.size} unique)`));
  } else if (missing.length || unexpected.length) {
    items.push(failCheck("delta.refundSet",
      `expected exactly baseline+{${opts.newRefundId}}; missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`));
  } else {
    items.push(pass("delta.refundSet", `exactly one new refund (${nowIds.length} total)`));
  }
  // Baseline fields are stored as minor units (integers); current responses
  // are decimal strings — parsed with the matching readers.
  const asMinor = (v: unknown): bigint | null => {
    if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
    return BigInt(v);
  };
  const shipNow = moneyMinor(order.totalRefundedShippingSet);
  const shipBase = asMinor(baseline.totalRefundedShippingMinor);
  if (shipNow === null || shipBase === null) {
    items.push(incomplete("delta.shipping", "shipping totals unreadable"));
  } else {
    const delta = shipNow - shipBase;
    items.push(delta === opts.shippingDeltaMinor
      ? pass("delta.shipping", `+${delta} minor units`)
      : failCheck("delta.shipping", `delta ${delta} != expected ${opts.shippingDeltaMinor} minor units`));
  }
  const totNow = moneyMinor(order.totalRefundedSet);
  const totBase = asMinor(baseline.totalRefundedMinor);
  if (totNow === null || totBase === null) {
    items.push(incomplete("delta.total", "total refunded unreadable"));
  } else {
    const delta = totNow - totBase;
    items.push(delta === opts.totalDeltaMinor
      ? pass("delta.total", `+${delta} minor units`)
      : failCheck("delta.total", `delta ${delta} != expected ${opts.totalDeltaMinor} minor units`));
  }
  return items;
}

// ── New-refund financials (post-send) ───────────────────────────────────

export interface RefundFinancialOptions {
  readonly refundId: string;
  readonly orderId: string;
  readonly parentTransactionId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
}

/** Verify a single created refund's financial shape from Q-REFUND-DETAIL. */
export function checkNewRefundFinancials(
  node: Record<string, unknown> | null | undefined,
  opts: RefundFinancialOptions,
): CheckItem[] {
  const items: CheckItem[] = [];
  if (!node) return [failCheck("refund.node", "refund node missing")];
  items.push(node.id === opts.refundId
    ? pass("refund.id")
    : failCheck("refund.id", `node id ${node.id} != expected ${opts.refundId}`));
  const orderId = (node.order as { id?: string } | undefined)?.id;
  items.push(orderId === opts.orderId
    ? pass("refund.order")
    : failCheck("refund.order", `order ${orderId} != expected ${opts.orderId}`));
  const tot = moneyAmount(node.totalRefundedSet);
  const totCur = moneyCurrency(node.totalRefundedSet);
  const totMinor = parseMoneyMinor(tot);
  items.push(totMinor !== null && totMinor === opts.amountMinor && totCur === opts.currency
    ? pass("refund.amount", `${tot} ${totCur}`)
    : totMinor === null
      ? incomplete("refund.amount", `totalRefundedSet unreadable (${JSON.stringify(node.totalRefundedSet)})`)
      : failCheck("refund.amount", `total ${tot} ${totCur} != expected ${opts.amountMinor} minor ${opts.currency}`));
  const shipLines = (node.refundShippingLines as { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean } } | undefined);
  if (!shipLines || !Array.isArray(shipLines.nodes)) {
    items.push(incomplete("refund.shippingLines", "connection missing"));
  } else if (shipLines.pageInfo?.hasNextPage === true) {
    items.push(incomplete("refund.shippingLines", "hasNextPage — connection truncated"));
  } else {
    const sum = (shipLines.nodes as Array<Record<string, unknown>>)
      .map((n) => moneyMinor(n.subtotalAmountSet))
      .reduce((a, b) => (a === null || b === null ? null : a + b), 0n as bigint | null);
    items.push(shipLines.nodes.length >= 1 && sum === opts.amountMinor
      ? pass("refund.shippingLines", `${shipLines.nodes.length} line(s), ${sum} minor`)
      : sum === null
        ? incomplete("refund.shippingLines", "a line amount is unreadable")
        : failCheck("refund.shippingLines", `${shipLines.nodes.length} line(s) sum ${sum} != expected ${opts.amountMinor} minor`));
  }
  for (const [name, conn] of [["refundLineItems", node.refundLineItems], ["orderAdjustments", node.orderAdjustments]] as const) {
    const c = conn as { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean } } | undefined;
    if (!c || !Array.isArray(c.nodes) || c.pageInfo?.hasNextPage === true) {
      items.push(incomplete(`refund.${name}`, "connection missing or truncated"));
    } else {
      items.push(c.nodes.length === 0
        ? pass(`refund.${name}`, "empty")
        : failCheck(`refund.${name}`, `${c.nodes.length} unexpected node(s) — not a pure shipping refund`));
    }
  }
  const duties = node.duties;
  items.push(Array.isArray(duties)
    ? (duties.length === 0 ? pass("refund.duties", "empty") : failCheck("refund.duties", `${duties.length} duties`))
    : incomplete("refund.duties", "duties not an array"));
  const tx = (node.transactions as { nodes?: Array<Record<string, unknown>>; pageInfo?: { hasNextPage?: boolean } } | undefined);
  if (!tx || !Array.isArray(tx.nodes)) {
    items.push(incomplete("refund.transactions", "connection missing"));
  } else if (tx.pageInfo?.hasNextPage === true) {
    items.push(incomplete("refund.transactions", "hasNextPage — connection truncated"));
  } else if (tx.nodes.length === 0) {
    items.push(failCheck("refund.transactions", "no refund transaction"));
  } else {
    const refunds = tx.nodes.filter((t) => t.kind === "REFUND");
    const foreign = tx.nodes.filter((t) => t.kind !== "REFUND");
    if (foreign.length) {
      items.push(failCheck("refund.transactions", `${foreign.length} non-REFUND transaction(s) present`));
    }
    if (refunds.length !== 1) {
      items.push(failCheck("refund.transactions", `${refunds.length} REFUND transactions (expected exactly 1)`));
    } else {
      const t = refunds[0];
      const amt = moneyMinor(t.amountSet);
      const parentId = (t.parentTransaction as { id?: string } | undefined)?.id;
      const problems: string[] = [];
      if (t.status !== "SUCCESS") problems.push(`status=${t.status}`);
      if (t.gateway !== "bogus") problems.push(`gateway=${t.gateway}`);
      if (t.test !== true) problems.push(`test=${t.test}`);
      if (amt === null) problems.push("amount unreadable");
      else if (amt !== opts.amountMinor) problems.push(`amount=${amt} minor != ${opts.amountMinor}`);
      if (parentId !== opts.parentTransactionId) problems.push(`parent=${parentId}`);
      items.push(problems.length === 0
        ? pass("refund.transactions", `REFUND/SUCCESS/bogus/test amount ${amt} parent ok`)
        : failCheck("refund.transactions", problems.join("; ")));
    }
  }
  return items;
}

// ── Agreement attribution (observation — never a rule verdict) ─────────

export type AttributionObservation =
  | { kind: "APP-ATTRIBUTED"; appId: string }
  | { kind: "FOREIGN-APP"; appId: string | null }
  | { kind: "NO-LINKED-AGREEMENT" }
  | { kind: "DUPLICATE-LINKS"; count: number }
  | { kind: "INCONCLUSIVE"; reason: string };

/** What the agreement pages say about one refund — observation only. The
 *  12.8 rule verdict stays outside this runner: an observation is reported
 *  verbatim and a gap is INCONCLUSIVE, never silently favourable. */
export function observeAttribution(
  agreementNodes: readonly Record<string, unknown>[],
  pagesComplete: boolean,
  refundId: string,
  expectedAppId: string,
  visibilityWindowSatisfied: boolean,
): AttributionObservation {
  if (!pagesComplete) return { kind: "INCONCLUSIVE", reason: "agreement pages incomplete" };
  if (!visibilityWindowSatisfied) return { kind: "INCONCLUSIVE", reason: "inside the 15-minute visibility window" };
  const links = agreementNodes.filter((a) =>
    a.__typename === "RefundAgreement" &&
    (a.refund as { id?: string } | null | undefined)?.id === refundId);
  if (links.length === 0) return { kind: "NO-LINKED-AGREEMENT" };
  if (links.length > 1) return { kind: "DUPLICATE-LINKS", count: links.length };
  const appId = (links[0].app as { id?: string } | null | undefined)?.id ?? null;
  return appId === expectedAppId ? { kind: "APP-ATTRIBUTED", appId } : { kind: "FOREIGN-APP", appId };
}

// ── Evidence-dir protection and manifest accumulation ───────────────────

/** Resolve and guard the evidence output directory: must not be inside the
 *  pinned S1 archive (docs/evidence/shipping-v0), and a path inside the
 *  repository must live under docs/evidence. Paths outside the repo (test
 *  scratch dirs) are allowed. */
export function resolveCampaignOutDir(repoRoot: string, out: string): { ok: true; dir: string } | { ok: false; reason: string } {
  const root = resolve(repoRoot);
  const dir = resolve(isAbsolute(out) ? out : join(root, out));
  const protectedDir = join(root, "docs", "evidence", "shipping-v0");
  const evidenceRoot = join(root, "docs", "evidence");
  const norm = (p: string) => (p.endsWith(sep) ? p : p + sep);
  if (dir === protectedDir || dir.startsWith(norm(protectedDir))) {
    return { ok: false, reason: `${dir} is inside the pinned S1 evidence archive` };
  }
  if ((dir === root || dir.startsWith(norm(root))) && !(dir === evidenceRoot || dir.startsWith(norm(evidenceRoot)))) {
    return { ok: false, reason: `${dir} is inside the repository but outside docs/evidence — refusing an unintended destination` };
  }
  return { ok: true, dir };
}

/** Every artifact currently in the evidence dir (register files, baselines,
 *  mutation responses, prior read-backs) — the manifest must cover the
 *  accumulated campaign archive, not just this run's writes. */
export function collectCampaignArtifacts(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== "MANIFEST.sha256")
    .map((e) => e.name)
    .sort();
}
