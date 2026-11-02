// G-E7 / A-NEG campaign read-back runner (docs/G-E7-ANEG-CAMPAIGN-RUNBOOK.md).
// READ-ONLY: executes only the pinned query documents from
// app/lib/shipping-refund-queries.ts (exact text, pinned sha256) plus two
// small campaign guard documents (each archived under its own sha256, like
// the Q-EVENTS-BASE precedent) against the approved development store.
//
// Unlike scripts/shipping-refund-readback.ts — which is bound to the
// historical G-READBACK run and its fixed order/refund set — this runner is
// parameterized for refunds and orders created during the campaign:
//
//   npx vite-node --script scripts/shipping-refund-campaign-readback.ts \
//     --label e7-2-after-create \
//     --order gid://shopify/Order/<id> \
//     --refund gid://shopify/Refund/<id> [--refund <gid> ...]
//
//   --order <gid>        order to reconcile (Q-RECONCILE) and read agreements
//                        (Q-AGREEMENTS) for; repeatable
//   --refund <gid>       refund to inspect (Q-REFUND-DETAIL; <=5 per request);
//                        repeatable; every id is order-bound by the reads
//   --label <name>       purpose label stamped into artifact names
//   --out <dir>          evidence dir (default docs/evidence/shipping-v0-e7);
//                        must live under docs/evidence inside the repo, and is
//                        NEVER allowed to be or contain docs/evidence/shipping-v0
//
// Baseline + expectations (runbook §6): before any send, run with
// --save-baseline to persist per-order baselines (refund ids/count/totals)
// into the evidence dir; the file refuses to be overwritten. After the
// send, re-run with the expectation flags below — the runner then writes an
// expectations-<label>.json artifact whose overall verdict is PASS only
// when the financial read-backs actually match the expected experiment
// result, INCOMPLETE when evidence is missing/truncated, FAIL on a
// definitive mismatch. A response-shape pass is never promoted to a
// financial pass: expectations are checked against read-backs only.
//
//   --save-baseline                     persist baseline-<short>.json per --order
//   --expect-new-refund <gid>           exactly this one new refund vs baseline
//   --expect-order <gid>                its expected order
//   --expect-parent <gid>               its REFUND txn's parent CAPTURE/SALE
//   --expect-amount <decimal>           expected refund amount (e.g. 1.00)
//   --expect-currency <code>            default USD
//   --expect-shipping-delta <decimal>   expected added refunded shipping
//   --expect-available-shipping <dec>   pre-send: remaining shipping >= this
//   --require-agreements                agreement evidence must be complete
//                                       and attribute the new refund for PASS
//
// Behavior (§17, §20.1.1, runbook §6):
//   - refuses to run unless SHIPRB_STORE is exactly the approved
//     development store, on either channel;
//   - proves shop identity (Q-CAMPAIGN-SHOP: myshopifyDomain +
//     partnerDevelopment) and MergeShip app identity (Q-APPID ==
//     gid://shopify/App/426185785345) BEFORE any order read, and aborts the
//     run otherwise;
//   - per order: refund ids/count, refunded and shipping totals;
//   - per refund: node id echo, owning order, transaction kind/status/
//     gateway/test flag/parent transaction/amount, nested-connection
//     completeness — incomplete evidence is recorded as INCOMPLETE, never
//     passed off as complete;
//   - per order: all agreement pages (bounded), each RefundAgreement linked
//     to its refund.id with the agreement's app.id recorded verbatim; the
//     attribution observation preserves the 15-minute visibility rule —
//     inside the window the observation is INCONCLUSIVE;
//   - writes sanitized artifacts (the pinned selections carry no customer
//     PII), a labelled validation register, and MANIFEST.sha256 over EVERY
//     artifact already in the evidence dir — baselines, mutation responses
//     and earlier read-backs accumulate, they are never dropped;
//   - never touches docs/evidence/shipping-v0/ or its pinned manifest;
//   - sends no mutations — any document containing the word is refused
//     before the wire.
//
// Channels (same as shipping-refund-readback.ts):
//   - default: `shopify app execute` (authorized CLI session);
//   - SHIPRB_TOKEN_ENV=<env var holding an offline token>: direct POST with
//     Shopify-GraphQL-Cost-Debug: 1, capturing extensions.cost. The token is
//     never printed or written.
//
// Env: SHIPRB_STORE (default ordermergetest2.myshopify.com), SHIPRB_VERSION
// (default 2026-04), SHIPRB_OUT (overridden by --out).
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  Q_APPID, Q_RECONCILE, Q_REFUND_DETAIL, Q_AGREEMENTS,
  sha256Hex, validateAppIdentity, validateRefundList,
  validateRefundDetailResponse, validateAgreementsPage,
} from "../app/lib/shipping-refund-queries";
import { buildManifestLines, MANIFEST_NAME } from "./lib/evidence-manifest";
import {
  checkBaselineDelta, checkNewRefundFinancials, checkOrderGuard,
  collectCampaignArtifacts, observeAttribution, overallVerdict,
  parseMoneyMinor, resolveCampaignOutDir,
  type CheckItem, type OrderBaseline,
} from "./lib/campaign-checks";

const EXPECTED_STORE = "ordermergetest2.myshopify.com";
const EXPECTED_APP_GID = "gid://shopify/App/426185785345";
const AGREEMENT_PAGE_BUDGET = 5;
const DETAIL_IDS_PER_REQUEST = 5;
const VISIBILITY_WINDOW_MS = 15 * 60 * 1000;

// Campaign guard documents: supplementary read-only docs, each archived
// under its own sha256 (Q-EVENTS-BASE precedent). Not part of the pinned
// five — recorded so an independent reviewer can re-hash them.
const Q_CAMPAIGN_SHOP = {
  name: "Q-CAMPAIGN-SHOP",
  document:
    "query ShippingRefundCampaignShop {\n  shop { myshopifyDomain plan { partnerDevelopment } }\n}",
} as const;
const Q_CAMPAIGN_ORDER_GUARD = {
  name: "Q-CAMPAIGN-ORDER-GUARD",
  document: `query ShippingRefundCampaignOrderGuard($id: ID!) {
  order(id: $id) {
    id
    test
    refundable
    displayFinancialStatus
    paymentGatewayNames
    totalShippingPriceSet { shopMoney { amount currencyCode } }
    totalRefundedShippingSet { shopMoney { amount currencyCode } }
    transactions(first: 50) { id kind status gateway test amountSet { shopMoney { amount currencyCode } } }
  }
}`,
} as const;

const STORE = process.env.SHIPRB_STORE ?? "ordermergetest2.myshopify.com";
const VERSION = process.env.SHIPRB_VERSION ?? "2026-04";
const TOKEN_ENV = process.env.SHIPRB_TOKEN_ENV;
const RUN = new Date().toISOString();
const REPO_ROOT = process.cwd();
const CHANNEL = TOKEN_ENV ? "admin-graphql-http" : "shopify-app-execute";

const args = process.argv.slice(2);
const collect = (flag: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && args[i + 1]) { out.push(args[i + 1]); i += 1; }
  }
  return out;
};
const single = (flag: string): string | undefined => collect(flag).pop();
const has = (flag: string): boolean => args.includes(flag);
const ORDERS = collect("--order");
const REFUNDS = collect("--refund");
const LABEL = (single("--label") ?? "campaign").replace(/[^a-z0-9_-]+/gi, "_").toLowerCase();
const OUT_ARG = single("--out") ?? process.env.SHIPRB_OUT ?? "docs/evidence/shipping-v0-e7";
const SAVE_BASELINE = has("--save-baseline");
const EXPECT_NEW_REFUND = single("--expect-new-refund");
const EXPECT_ORDER = single("--expect-order");
const EXPECT_PARENT = single("--expect-parent");
const EXPECT_AMOUNT = single("--expect-amount");
const EXPECT_CURRENCY = single("--expect-currency") ?? "USD";
const EXPECT_SHIPPING_DELTA = single("--expect-shipping-delta");
const EXPECT_AVAILABLE = single("--expect-available-shipping");
const REQUIRE_AGREEMENTS = has("--require-agreements");
const EXPECT_MODE = EXPECT_NEW_REFUND !== undefined;

if (!ORDERS.length && !REFUNDS.length) {
  console.error(
    "usage: npx vite-node --script scripts/shipping-refund-campaign-readback.ts " +
    "--label <name> [--order <gid> ...] [--refund <gid> ...] [--out <dir>]\n" +
    "       [--save-baseline] [--expect-new-refund <gid> --expect-order <gid> " +
    "--expect-parent <gid> --expect-amount <dec> --expect-shipping-delta <dec>]",
  );
  process.exit(2);
}
for (const gid of [...ORDERS, ...REFUNDS]) {
  if (!/^gid:\/\/shopify\/(Order|Refund)\/\d+$/.test(gid)) {
    throw new Error(`malformed gid argument: ${gid}`);
  }
}
if (EXPECT_MODE && (!EXPECT_ORDER || !EXPECT_PARENT || !EXPECT_AMOUNT || !EXPECT_SHIPPING_DELTA)) {
  throw new Error(
    "--expect-new-refund requires --expect-order, --expect-parent, " +
    "--expect-amount and --expect-shipping-delta",
  );
}
const EXPECT_AMOUNT_MINOR = EXPECT_AMOUNT !== undefined ? parseMoneyMinor(EXPECT_AMOUNT) : null;
const EXPECT_SHIP_DELTA_MINOR = EXPECT_SHIPPING_DELTA !== undefined ? parseMoneyMinor(EXPECT_SHIPPING_DELTA) : null;
const EXPECT_AVAILABLE_MINOR = EXPECT_AVAILABLE !== undefined ? parseMoneyMinor(EXPECT_AVAILABLE) : null;
if (EXPECT_MODE && (EXPECT_AMOUNT_MINOR === null || EXPECT_SHIP_DELTA_MINOR === null)) {
  throw new Error("expectation amounts must be decimal strings like 1.00");
}
if (EXPECT_AVAILABLE !== undefined && EXPECT_AVAILABLE_MINOR === null) {
  throw new Error("--expect-available-shipping must be a decimal string like 2.00");
}

const outRes = resolveCampaignOutDir(REPO_ROOT, OUT_ARG);
if (!outRes.ok) throw new Error(outRes.reason);
const OUT = outRes.dir;

interface ExecResult { data: unknown; errors: unknown; extensions: unknown }

const execQuery = async (
  doc: { name: string; document: string },
  variables?: Record<string, unknown>,
): Promise<ExecResult> => {
  // Read-only boundary (3.2 rule 9): refuse any document containing a
  // mutation operation, on either channel, before it reaches the wire.
  if (/\bmutation\b/.test(doc.document)) {
    throw new Error(`refusing non-read-only document ${doc.name}: contains 'mutation'`);
  }
  if (TOKEN_ENV) {
    const token = process.env[TOKEN_ENV];
    if (!token) throw new Error(`${TOKEN_ENV} is not set`);
    const res = await fetch(`https://${STORE}/admin/api/${VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
        "Shopify-GraphQL-Cost-Debug": "1",
      },
      body: JSON.stringify({ query: doc.document, variables }),
    });
    const body = await res.json();
    return { data: body?.data ?? null, errors: body?.errors ?? null, extensions: body?.extensions ?? null };
  }
  const qf = join(process.env.TEMP ?? "/tmp", `shipc-${doc.name}.graphql`);
  writeFileSync(qf, doc.document);
  const vf = join(process.env.TEMP ?? "/tmp", `shipc-${doc.name}.vars.json`);
  let varArg = "";
  if (variables) {
    writeFileSync(vf, JSON.stringify(variables));
    varArg = ` --variable-file "${vf}"`;
  }
  const raw = execSync(
    `npx shopify app execute --store ${STORE} --version ${VERSION} --query-file "${qf}"${varArg} 2>&1`,
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 },
  );
  const i = raw.indexOf("{"), j = raw.lastIndexOf("}");
  if (i < 0 || j <= i) throw new Error(`CLI returned no JSON body: ${raw.slice(0, 300)}`);
  const body = JSON.parse(raw.slice(i, j + 1));
  if (body && Array.isArray(body.errors) && body.errors.length > 0 && body.data === undefined) {
    return { data: null, errors: body.errors, extensions: null };
  }
  return { data: body.data ?? body, errors: body.errors ?? null, extensions: body.extensions ?? null };
};

const written: string[] = [];
const records: Array<{ name: string; purpose: string; file: string; sha256: string; verdict: string }> = [];
const hasErrors = (r: ExecResult | null) =>
  Array.isArray(r?.errors) && (r!.errors as unknown[]).length > 0;
const fail = (e: unknown) => `FAIL: ${String((e as Error)?.message ?? e).slice(0, 300)}`;

const rec = (
  doc: { name: string; document: string; documentSha256?: string },
  purpose: string,
  variables: Record<string, unknown> | undefined,
  r: ExecResult | null,
  verdict: string,
  extra: Record<string, unknown> = {},
) => {
  const sha = doc.documentSha256 ?? sha256Hex(doc.document);
  const file = `${doc.name.toLowerCase()}-${LABEL}-${purpose.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}.json`;
  writeFileSync(join(OUT, file), JSON.stringify({
    experiment: "G-E7/A-NEG-campaign", runAtUtc: RUN, apiVersion: VERSION,
    store: STORE, channel: CHANNEL,
    document: { name: doc.name, sha256: sha, text: doc.document },
    variables, verdict,
    executionErrors: r?.errors ?? null,
    response: r?.data ?? null,
    cost: (r?.extensions as { cost?: unknown } | null)?.cost ?? null,
    ...extra,
  }, null, 1));
  written.push(file);
  records.push({ name: doc.name, purpose, file, sha256: sha, verdict });
  return r;
};

const orderNodes = new Map<string, Record<string, unknown>>();
const refundNodes = new Map<string, Record<string, unknown>>();
const agreementNodesByOrder = new Map<string, { nodes: Array<Record<string, unknown>>; complete: boolean }>();
const expectationItems: CheckItem[] = [];

async function main() {
  mkdirSync(OUT, { recursive: true });

  // Hard safety boundary on BOTH channels: the campaign is development-store
  // only — a mis-set SHIPRB_STORE aborts before any read.
  if (STORE !== EXPECTED_STORE) {
    throw new Error(`refusing campaign read-back against ${STORE} — only ${EXPECTED_STORE} is approved`);
  }

  // ── Identity gate: shop, then app — before ANY order read ────────────────
  const shopR = await execQuery(Q_CAMPAIGN_SHOP);
  const shop = (shopR.data as { shop?: { myshopifyDomain?: string; plan?: { partnerDevelopment?: boolean } } } | null)?.shop;
  const shopOk = shop?.myshopifyDomain === EXPECTED_STORE && shop?.plan?.partnerDevelopment === true && !hasErrors(shopR);
  rec(Q_CAMPAIGN_SHOP, "identity", undefined, shopR,
    shopOk ? "PASS" : `FAIL: ${hasErrors(shopR) ? "top-level errors" : `shop ${shop?.myshopifyDomain ?? "(none)"} partnerDevelopment=${shop?.plan?.partnerDevelopment}`}`);
  if (!shopOk) {
    throw new Error("refusing order reads: shop identity/partner-development check failed");
  }

  let appId = "";
  const appR = await execQuery(Q_APPID);
  const av = validateAppIdentity({ data: appR.data });
  appId = av.ok ? av.appId! : "";
  rec(Q_APPID, "identity", undefined, appR,
    av.ok && !hasErrors(appR) ? "PASS" : `FAIL: ${av.ok ? "top-level errors" : av.reason}`);
  if (appId !== EXPECTED_APP_GID) {
    throw new Error(`refusing order reads: app identity ${appId || "(none)"} != expected ${EXPECTED_APP_GID}`);
  }

  // ── Per-order: guard doc + reconcile ──────────────────────────────────────
  const refundOrderByReconcile = new Map<string, string>();
  for (const oid of ORDERS) {
    const short = oid.split("/").pop()!;
    let guardOrder: Record<string, unknown> | null = null;
    try {
      const r = await execQuery(Q_CAMPAIGN_ORDER_GUARD, { id: oid });
      guardOrder = (r.data as { order?: Record<string, unknown> } | null)?.order ?? null;
      const items = checkOrderGuard(guardOrder, {
        expectedStoreOrderStatuses: ["PAID", "PARTIALLY_REFUNDED"],
        minAvailableShippingMinor: EXPECT_AVAILABLE_MINOR ?? undefined,
      });
      const v = overallVerdict(items);
      rec(Q_CAMPAIGN_ORDER_GUARD, `order_${short}`, { id: oid }, r,
        `${v}${v !== "PASS" ? `: ${items.filter((i) => i.verdict !== "PASS").map((i) => `${i.name} ${i.detail}`).join("; ")}` : ""}`,
        { checks: items, observed: guardOrder });
      if (EXPECT_AVAILABLE_MINOR !== undefined) {
        expectationItems.push(...items.map((i) => ({ ...i, name: `order_${short}.${i.name}` })));
      }
    } catch (e) { rec(Q_CAMPAIGN_ORDER_GUARD, `order_${short}`, { id: oid }, null, fail(e)); }
    try {
      const r = await execQuery(Q_RECONCILE, { source: oid });
      const v = validateRefundList({ data: r.data }, { sourceOrderId: oid });
      const order = (r.data as { order?: Record<string, unknown> } | null)?.order;
      if (order) orderNodes.set(oid, order);
      const refunds = (order?.refunds as Array<{ id?: string }> | undefined) ?? [];
      for (const rf of refunds) if (rf?.id) refundOrderByReconcile.set(rf.id, oid);
      rec(Q_RECONCILE, `order_${short}`, { source: oid }, r,
        v.ok && !hasErrors(r) ? "PASS" : `FAIL: ${v.ok ? "top-level errors" : v.reason}`,
        {
          refundCount: refunds.length,
          refundIds: refunds.map((x) => x?.id ?? null),
          totalRefundedSet: order?.totalRefundedSet ?? null,
          totalRefundedShippingSet: order?.totalRefundedShippingSet ?? null,
          displayFinancialStatus: order?.displayFinancialStatus ?? null,
          transactions: order?.transactions ?? null,
        });
    } catch (e) { rec(Q_RECONCILE, `order_${short}`, { source: oid }, null, fail(e)); }

    // Baseline persistence: one immutable baseline file per order, in the
    // evidence dir and manifest-covered. Refuses to overwrite — delete the
    // file deliberately to re-baseline.
    if (SAVE_BASELINE) {
      const bf = `baseline-${short}.json`;
      const bpath = join(OUT, bf);
      if (existsSync(bpath)) {
        rec({ name: "BASELINE", document: "" }, `order_${short}`, undefined, null,
          `FAIL: ${bf} already exists — refusing to overwrite a persisted baseline`);
      } else {
        const o = orderNodes.get(oid);
        const refunds = (o?.refunds as Array<{ id?: string }> | undefined) ?? [];
        const baseline: OrderBaseline = {
          orderId: oid,
          runAtUtc: RUN,
          refundIds: refunds.map((x) => x?.id).filter((x): x is string => typeof x === "string"),
          totalRefundedMinor: ((): string => {
            const a = (o?.totalRefundedSet as { presentmentMoney?: { amount?: string } } | undefined)?.presentmentMoney?.amount ?? "0";
            const m = parseMoneyMinor(a);
            return m === null ? a : m.toString();
          })(),
          totalRefundedShippingMinor: ((): string => {
            const a = (o?.totalRefundedShippingSet as { presentmentMoney?: { amount?: string } } | undefined)?.presentmentMoney?.amount ?? "0";
            const m = parseMoneyMinor(a);
            return m === null ? a : m.toString();
          })(),
        };
        writeFileSync(bpath, JSON.stringify({
          experiment: "G-E7/A-NEG-campaign", kind: "order-baseline", ...baseline,
          store: STORE, apiVersion: VERSION,
        }, null, 1));
        written.push(bf);
        records.push({ name: "BASELINE", purpose: `order_${short}`, file: bf, sha256: "", verdict: "PASS" });
      }
    }
  }

  // ── Refund detail: batches of at most DETAIL_IDS_PER_REQUEST ids ─────────
  const NESTED = ["refundShippingLines", "refundLineItems", "orderAdjustments", "transactions"] as const;
  for (let b = 0; b * DETAIL_IDS_PER_REQUEST < REFUNDS.length; b += 1) {
    const ids = REFUNDS.slice(b * DETAIL_IDS_PER_REQUEST, (b + 1) * DETAIL_IDS_PER_REQUEST);
    const purpose = `batch_${b + 1}`;
    try {
      const r = await execQuery(Q_REFUND_DETAIL, { ids });
      const nodes = ((r.data as { nodes?: Array<Record<string, unknown> | null> } | null)?.nodes ?? []) as Array<Record<string, unknown> | null>;
      for (const n of nodes) if (n?.id) refundNodes.set(String(n.id), n);
      const checks = nodes.map((n, i) => {
        const txns = ((n?.transactions as { nodes?: unknown[] } | undefined)?.nodes ?? []) as Array<Record<string, unknown>>;
        return {
          requestedId: ids[i], nodeId: n?.id ?? null,
          orderId: (n?.order as { id?: string } | undefined)?.id ?? null,
          orderBoundByReconcile: refundOrderByReconcile.get(ids[i]) ?? null,
          incompleteConnections: n ? NESTED.filter((c) => (n[c] as { pageInfo?: { hasNextPage?: boolean } } | undefined)?.pageInfo?.hasNextPage !== false) : ["<null node>"],
          transactions: txns.map((t) => ({
            id: t.id, kind: t.kind, status: t.status, gateway: t.gateway, test: t.test,
            amount: (t.amountSet as { presentmentMoney?: { amount?: string; currencyCode?: string } } | undefined)?.presentmentMoney ?? null,
            parentTransaction: (t.parentTransaction as { id?: string } | undefined)?.id ?? null,
          })),
          totalRefundedSet: n?.totalRefundedSet ?? null,
        };
      });
      const executed = nodes.length === ids.length && !hasErrors(r);
      const identityOk = checks.every((c) => c.nodeId === c.requestedId);
      const boundOk = checks.every((c) => c.orderId === (c.orderBoundByReconcile ?? c.orderId));
      const completeOk = checks.every((c) => c.incompleteConnections.length === 0);
      const verdict = !executed ? "FAIL: execution"
        : !identityOk ? "FAIL: identity"
        : !boundOk ? "FAIL: order binding"
        : completeOk ? "PASS"
        : "INCOMPLETE: " + checks.filter((c) => c.incompleteConnections.length)
            .map((c) => `${String(c.requestedId).split("/").pop()}: ${c.incompleteConnections.join("+")}`).join("; ");
      rec(Q_REFUND_DETAIL, purpose, { ids }, r, verdict, { nodeChecks: checks });
    } catch (e) { rec(Q_REFUND_DETAIL, purpose, { ids }, null, fail(e)); }
  }

  // Strict per-refund validator pass (single id, bound to its order when the
  // reconcile read established the binding; unbound refunds are recorded
  // INCOMPLETE rather than checked against an unproven order).
  for (const rid of REFUNDS) {
    const oid = refundOrderByReconcile.get(rid);
    if (!oid) {
      rec(Q_REFUND_DETAIL, `strict_${rid.split("/").pop()}`, { ids: [rid] }, null,
        "INCOMPLETE: no order binding established by the reconcile reads — strict check skipped");
      continue;
    }
    try {
      const r = await execQuery(Q_REFUND_DETAIL, { ids: [rid] });
      const v = validateRefundDetailResponse({ data: r.data }, [rid], { sourceOrderId: oid });
      rec(Q_REFUND_DETAIL, `strict_${rid.split("/").pop()}`, { ids: [rid] }, r,
        v.ok && !hasErrors(r) ? "PASS" : `FAIL: ${v.ok ? "top-level errors" : v.reason}`);
    } catch (e) { rec(Q_REFUND_DETAIL, `strict_${rid.split("/").pop()}`, { ids: [rid] }, null, fail(e)); }
  }

  // ── Per-order agreement pages: bounded, raw pages archived, every
  //    RefundAgreement linked to its refund id with app.id verbatim ─────────
  for (const oid of ORDERS) {
    const short = oid.split("/").pop()!;
    try {
      const pages: Array<Record<string, unknown>> = [];
      let after: string | null = null;
      let vFail: string | null = null;
      let completed = false;
      for (let p = 0; p < AGREEMENT_PAGE_BUDGET; p += 1) {
        const r = await execQuery(Q_AGREEMENTS, { source: oid, after });
        const v = hasErrors(r)
          ? { ok: false as const, reason: "top-level errors" }
          : validateAgreementsPage({ data: r.data }, { sourceOrderId: oid });
        pages.push({
          page: p + 1, variables: { source: oid, after },
          validator: v.ok ? "ok" : v.reason, errors: r.errors ?? null,
          response: r.data, extensions: r.extensions ?? null,
        });
        if (!v.ok) { vFail = v.reason ?? "validator failure"; break; }
        const pi = (r.data as { order?: { agreements?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } } } | null)?.order?.agreements?.pageInfo;
        if (pi?.hasNextPage !== true) { completed = pi?.hasNextPage === false; break; }
        after = pi?.endCursor ?? null;
      }
      const verdict = vFail ? `FAIL: ${vFail}` : completed ? "PASS" : `INCOMPLETE: ${AGREEMENT_PAGE_BUDGET}-page budget exhausted with hasNextPage`;
      const nodes = pages.flatMap((p) => ((p.response as { order?: { agreements?: { nodes?: unknown[] } } } | null | undefined)?.order?.agreements?.nodes ?? []) as Array<Record<string, unknown>>);
      agreementNodesByOrder.set(oid, { nodes, complete: completed && !vFail });
      const refundLinks = nodes
        .filter((a) => a.__typename === "RefundAgreement")
        .map((a) => ({
          agreementId: a.id ?? null,
          reason: a.reason ?? null,
          appId: (a.app as { id?: string } | null | undefined)?.id ?? null,
          happenedAt: a.happenedAt ?? null,
          refundId: (a.refund as { id?: string } | null | undefined)?.id ?? null,
          matchesCampaignRefund: REFUNDS.includes(String((a.refund as { id?: string } | null | undefined)?.id)),
        }));
      rec(Q_AGREEMENTS, `order_${short}`, { source: oid }, null, verdict, {
        pagesScanned: pages.length, pageComplete: completed, verifiedAppId: appId,
        agreementNodes: nodes, refundLinks, rawPages: pages,
      });
    } catch (e) { rec(Q_AGREEMENTS, `order_${short}`, { source: oid }, null, fail(e)); }
  }

  // ── Expectations (post-send): every check is a PASS / FAIL / INCOMPLETE
  //    item; the composite verdict is FAIL on any mismatch, INCOMPLETE on
  //    any gap. Agreement attribution is an observation with the 15-minute
  //    visibility rule — never silently favourable. ────────────────────────
  if (EXPECT_MODE) {
    const bpath = join(OUT, `baseline-${EXPECT_ORDER!.split("/").pop()}.json`);
    let baseline: OrderBaseline | null = null;
    if (existsSync(bpath)) {
      baseline = JSON.parse(readFileSync(bpath, "utf8")) as OrderBaseline;
    } else {
      expectationItems.push({ name: "expect.baseline", verdict: "INCOMPLETE", detail: `no persisted baseline at ${bpath} — run --save-baseline before sends` });
    }
    const order = orderNodes.get(EXPECT_ORDER!);
    if (!order) {
      expectationItems.push({ name: "expect.order", verdict: "INCOMPLETE", detail: `${EXPECT_ORDER} was not among the reconciled orders` });
    }
    if (baseline && order) {
      expectationItems.push(...checkBaselineDelta(baseline, order, {
        newRefundId: EXPECT_NEW_REFUND!,
        shippingDeltaMinor: EXPECT_SHIP_DELTA_MINOR!,
        totalDeltaMinor: EXPECT_AMOUNT_MINOR!,
      }).map((i) => ({ ...i, name: `expect.${i.name}` })));
    }
    const node = refundNodes.get(EXPECT_NEW_REFUND!) ?? null;
    expectationItems.push(...checkNewRefundFinancials(node, {
      refundId: EXPECT_NEW_REFUND!,
      orderId: EXPECT_ORDER!,
      parentTransactionId: EXPECT_PARENT!,
      amountMinor: EXPECT_AMOUNT_MINOR!,
      currency: EXPECT_CURRENCY,
    }).map((i) => ({ ...i, name: `expect.${i.name}` })));

    // Attribution observation on the new refund (visibility rule preserved).
    const ag = agreementNodesByOrder.get(EXPECT_ORDER!);
    const processedAt = String(node?.processedAt ?? "");
    const processedMs = processedAt ? Date.parse(processedAt) : NaN;
    const windowSatisfied = Number.isFinite(processedMs)
      ? Date.parse(RUN) - processedMs >= VISIBILITY_WINDOW_MS
      : false;
    if (!ag || !ag.complete) {
      expectationItems.push({ name: "expect.agreements", verdict: "INCOMPLETE", detail: "agreement read incomplete or missing" });
    } else {
      const obs = observeAttribution(ag.nodes, ag.complete, EXPECT_NEW_REFUND!, EXPECTED_APP_GID, windowSatisfied);
      const item: CheckItem = obs.kind === "APP-ATTRIBUTED"
        ? { name: "expect.agreements", verdict: "PASS", detail: `APP-ATTRIBUTED ${obs.appId}` }
        : obs.kind === "FOREIGN-APP"
          ? { name: "expect.agreements", verdict: "FAIL", detail: `agreement app.id ${obs.appId ?? "null"} != ${EXPECTED_APP_GID}` }
          : obs.kind === "DUPLICATE-LINKS"
            ? { name: "expect.agreements", verdict: "FAIL", detail: `${obs.count} RefundAgreements link the new refund` }
            : { name: "expect.agreements", verdict: "INCOMPLETE", detail: `INCONCLUSIVE: ${obs.kind === "NO-LINKED-AGREEMENT" ? "no linked RefundAgreement" : (obs as { reason?: string }).reason}` };
      // The NO-LINKED/visibility cases stay INCONCLUSIVE unless the operator
      // required agreement evidence now (--require-agreements makes them a
      // FAIL — used only for the post-window re-read).
      if (item.verdict === "INCOMPLETE" && REQUIRE_AGREEMENTS && windowSatisfied && ag.complete) {
        expectationItems.push({ ...item, verdict: "FAIL" });
      } else {
        expectationItems.push(item);
      }
    }
    const ef = `expectations-${LABEL}.json`;
    writeFileSync(join(OUT, ef), JSON.stringify({
      experiment: "G-E7/A-NEG-campaign", runAtUtc: RUN, label: LABEL,
      store: STORE, apiVersion: VERSION,
      expectations: {
        newRefundId: EXPECT_NEW_REFUND, orderId: EXPECT_ORDER,
        parentTransactionId: EXPECT_PARENT, amount: EXPECT_AMOUNT,
        currency: EXPECT_CURRENCY, shippingDelta: EXPECT_SHIPPING_DELTA,
        requireAgreements: REQUIRE_AGREEMENTS,
        visibilityWindowSatisfied: windowSatisfied,
      },
      checks: expectationItems,
      overall: overallVerdict(expectationItems),
    }, null, 1));
    written.push(ef);
    records.push({ name: "EXPECTATIONS", purpose: LABEL, file: ef, sha256: "", verdict: overallVerdict(expectationItems) });
  }

  // ── Register first, manifest LAST over EVERY artifact in the dir ─────────
  // Accumulating: baselines, mutation responses and earlier runs' artifacts
  // all stay covered — the manifest is never narrowed to this run's writes.
  const regFile = `validation-register-${LABEL}.json`;
  writeFileSync(join(OUT, regFile), JSON.stringify({
    runAtUtc: RUN, label: LABEL, store: STORE, apiVersion: VERSION, channel: CHANNEL,
    verifiedShop: EXPECTED_STORE, verifiedAppId: appId,
    orders: ORDERS, refunds: REFUNDS, records,
  }, null, 1));
  written.push(regFile);
  writeFileSync(
    join(OUT, MANIFEST_NAME),
    buildManifestLines(OUT, collectCampaignArtifacts(OUT)).join("\n") + "\n",
  );
  console.log(records.map((r) => `${r.verdict.startsWith("PASS") ? "PASS" : "XXXX"}  ${r.name}  ${r.purpose}  ${r.verdict.slice(0, 100)}`).join("\n"));
  if (EXPECT_MODE) {
    console.log(`EXPECTATIONS ${overallVerdict(expectationItems)}:`);
    for (const i of expectationItems) {
      if (i.verdict !== "PASS") console.log(`  ${i.verdict} ${i.name}: ${i.detail.slice(0, 140)}`);
    }
  }
  console.log("artifacts:", collectCampaignArtifacts(OUT).length + 1, "manifest entries:", collectCampaignArtifacts(OUT).length);
}

await main();
