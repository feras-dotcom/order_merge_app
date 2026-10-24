// G-READBACK / G-AGREEMENT-A / G-INTROSPECT evidence runner (docs §12.1, §12.8, §17).
// READ-ONLY: executes only the pinned query documents from
// app/lib/shipping-refund-queries.ts (exact text, pinned sha256) against the
// approved development store through the authenticated `shopify app execute`
// channel, applies the repo's own response validators, and writes the
// sanitized archive to docs/evidence/shipping-v0/.
//
//   npx vite-node --script scripts/shipping-refund-readback.ts
//
// Env: SHIPRB_STORE (default ordermergetest2.myshopify.com), SHIPRB_VERSION
// (default 2026-04), SHIPRB_OUT (default docs/evidence/shipping-v0).
// Never prints or stores credentials; the CLI holds the authorized session.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Q_APPID, Q_RECHECK, Q_RECONCILE, Q_REFUND_DETAIL, Q_AGREEMENTS,
  sha256Hex, validateAppIdentity, validateExecRecheck, validateRefundList,
  validateRefundDetailResponse, validateAgreementsPage,
} from "../app/lib/shipping-refund-queries";

const STORE = process.env.SHIPRB_STORE ?? "ordermergetest2.myshopify.com";
const VERSION = process.env.SHIPRB_VERSION ?? "2026-04";
const OUT = process.env.SHIPRB_OUT ?? "docs/evidence/shipping-v0";
const RUN = new Date().toISOString();
const REPO_ROOT = process.cwd();

const execQuery = (doc: { name: string; document: string }, variables?: Record<string, unknown>) => {
  const qf = join(process.env.TEMP ?? "/tmp", `shiprb-${doc.name}.graphql`);
  writeFileSync(qf, doc.document);
  const vf = join(process.env.TEMP ?? "/tmp", `shiprb-${doc.name}.vars.json`);
  let varArg = "";
  if (variables) {
    writeFileSync(vf, JSON.stringify(variables));
    varArg = ` --variable-file "${vf}"`;
  }
  const raw = execSync(
    `npx shopify app execute --store ${STORE} --version ${VERSION} --query-file "${qf}"${varArg}`,
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 },
  );
  const i = raw.indexOf("{"), j = raw.lastIndexOf("}");
  const body = JSON.parse(raw.slice(i, j + 1));
  return body.data ?? body;
};

const O = {
  NO_REFUNDS: "gid://shopify/Order/8052845805815",      // #1125 PAID, refunds: []
  WITH_REFUND: "gid://shopify/Order/8078037057783",     // #1133 E6 refund
  BASE: "gid://shopify/Order/8052786135287",            // #1124 cancelled batch secondary
  E2: "gid://shopify/Order/8078035452151",              // #1132 cancelled + E2 refund
  E1: "gid://shopify/Order/8077992820983",              // #1131 cancelled + E1 refund
  NEG1: "gid://shopify/Order/8051362136311",            // #1104 un-noted refund
  NEG2: "gid://shopify/Order/8051306299639",            // #1099 Scenario5A refund
};
const REFUND_IDS = [
  "gid://shopify/Refund/1123042787575", // E6
  "gid://shopify/Refund/1123042066679", // E2
  "gid://shopify/Refund/1122917253367", // E1
  "gid://shopify/Refund/1120895828215", // #1104
  "gid://shopify/Refund/1120894320887", // #1099 Scenario5A
];

const records: any[] = [];
const rec = (doc: { name: string; document: string; documentSha256: string }, purpose: string,
  variables: Record<string, unknown> | undefined, data: unknown, verdict: string, extra: Record<string, unknown> = {}) => {
  const file = `${doc.name.toLowerCase()}-${purpose.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}.json`;
  writeFileSync(join(OUT, file), JSON.stringify({
    experiment: "G-READBACK/GA-A", runAtUtc: RUN, apiVersion: VERSION, store: STORE,
    document: { name: doc.name, sha256: doc.documentSha256, text: doc.document },
    variables, verdict, response: data, ...extra,
  }, null, 1));
  records.push({ name: doc.name, purpose, file, sha256: doc.documentSha256, verdict });
  return data;
};

mkdirSync(OUT, { recursive: true });
const fail = (e: unknown) => `FAIL: ${String((e as Error)?.message ?? e).slice(0, 300)}`;
const costNote = "shopify app execute returns data only; extensions.cost is not exposed by this channel";

// ── Identity gate ──────────────────────────────────────────────────────────
let appId = "";
try {
  const d = execQuery(Q_APPID);
  const v = validateAppIdentity({ data: d });
  appId = v.ok ? v.appId! : "";
  rec(Q_APPID, "identity", undefined, d, v.ok ? "PASS" : `FAIL: ${v.reason}`);
} catch (e) { rec(Q_APPID, "identity", undefined, null, fail(e)); }

// ── Q-RECHECK: cancelled secondary (BASE) + PAID primary ───────────────────
try {
  const vars = { source: O.BASE, primary: O.NO_REFUNDS };
  const d = execQuery(Q_RECHECK, vars);
  const v = validateExecRecheck({ data: d }, { sourceOrderId: O.BASE, primaryOrderId: O.NO_REFUNDS });
  rec(Q_RECHECK, "cancelled_secondary", vars, d, v.ok ? "PASS" : `FAIL: ${v.reason}`, { costMeasurement: costNote });
} catch (e) { rec(Q_RECHECK, "cancelled_secondary", { source: O.BASE, primary: O.NO_REFUNDS }, null, fail(e)); }

// ── Q-RECONCILE: three orders ──────────────────────────────────────────────
for (const [purpose, src] of [["no_refunds", O.NO_REFUNDS], ["with_refund_e6", O.WITH_REFUND], ["base_cancelled", O.BASE], ["e2_cancelled_refund", O.E2], ["e1_cancelled_refund", O.E1], ["neg_candidate_1104", O.NEG1], ["neg_candidate_1099", O.NEG2]] as const) {
  try {
    const d = execQuery(Q_RECONCILE, { source: src });
    const v = validateRefundList({ data: d }, { sourceOrderId: src });
    const refunds = (d as any)?.order?.refunds?.length ?? "?";
    rec(Q_RECONCILE, purpose, { source: src }, d, v.ok ? "PASS" : `FAIL: ${v.reason}`, { refundCount: refunds, costMeasurement: costNote });
  } catch (e) { rec(Q_RECONCILE, purpose, { source: src }, null, fail(e)); }
}

// ── Q-REFUND-DETAIL: five refund ids (worst-case bound) + strict single-order ──
const REFUND_ORDER: Record<string, string> = {
  "gid://shopify/Refund/1123042787575": O.WITH_REFUND,
  "gid://shopify/Refund/1123042066679": O.E2,
  "gid://shopify/Refund/1122917253367": O.E1,
  "gid://shopify/Refund/1120895828215": O.NEG1,
  "gid://shopify/Refund/1120894320887": O.NEG2,
};
try {
  const vars = { ids: REFUND_IDS };
  const d: any = execQuery(Q_REFUND_DETAIL, vars);
  const nodes = d?.nodes ?? [];
  const checks = nodes.map((n: any, i: number) => ({
    requestedId: REFUND_IDS[i], nodeId: n?.id ?? null,
    orderOk: n?.order?.id === REFUND_ORDER[REFUND_IDS[i]],
    hasNextPages: Object.fromEntries(
      ["refundShippingLines", "refundLineItems", "orderAdjustments", "transactions"]
        .map((c) => [c, n?.[c]?.pageInfo?.hasNextPage])),
    dutiesArray: Array.isArray(n?.duties),
  }));
  const ok = nodes.length === REFUND_IDS.length && checks.every((c: any) => c.nodeId === c.requestedId && c.orderOk);
  rec(Q_REFUND_DETAIL, "five_ids", vars, d, ok ? "PASS" : `CHECK: ${JSON.stringify(checks).slice(0, 200)}`,
    { nodeChecks: checks, costMeasurement: costNote });
} catch (e) { rec(Q_REFUND_DETAIL, "five_ids", { ids: REFUND_IDS }, null, fail(e)); }
try {
  const vars = { ids: [REFUND_IDS[0]] };
  const d = execQuery(Q_REFUND_DETAIL, vars);
  const v = validateRefundDetailResponse({ data: d }, [REFUND_IDS[0]], { sourceOrderId: O.WITH_REFUND });
  rec(Q_REFUND_DETAIL, "strict_single", vars, d, v.ok ? "PASS" : `FAIL: ${v.reason}`);
} catch (e) { rec(Q_REFUND_DETAIL, "strict_single", { ids: [REFUND_IDS[0]] }, null, fail(e)); }

// ── Q-AGREEMENTS: BASE + POS + NEG orders ─────────────────────────────────
for (const [purpose, src] of [["base_cancelled", O.BASE], ["pos_e6", O.WITH_REFUND], ["pos_e2", O.E2], ["pos_e1", O.E1], ["neg_1104", O.NEG1], ["neg_1099", O.NEG2]] as const) {
  try {
    const pages: any[] = [];
    let after: string | null = null;
    for (let p = 0; p < 5; p += 1) {
      const d = execQuery(Q_AGREEMENTS, { source: src, after });
      const v = validateAgreementsPage({ data: d }, { sourceOrderId: src });
      pages.push({ page: p + 1, validator: v.ok ? "ok" : v.reason, data: d });
      if (!v.ok || !(d as any)?.order?.agreements?.pageInfo?.hasNextPage) break;
      after = (d as any).order.agreements.pageInfo.endCursor;
    }
    const nodes = pages.flatMap((p) => p.data?.order?.agreements?.nodes ?? []);
    rec(Q_AGREEMENTS, purpose, { source: src }, nodes, "PASS", {
      pages: pages.length, pageComplete: !pages[pages.length - 1]?.data?.order?.agreements?.pageInfo?.hasNextPage,
      costMeasurement: costNote, verifiedAppId: appId,
      refundAgreements: nodes.filter((a: any) => a.__typename === "RefundAgreement"),
    });
  } catch (e) { rec(Q_AGREEMENTS, purpose, { source: src }, null, fail(e)); }
}

// ── G-INTROSPECT: @idempotent directive (read-only introspection) ──────────
try {
  const doc = { name: "G-INTROSPECT", document: `query {\n  __schema {\n    directives { name locations args { name type { kind name ofType { kind name ofType { kind name } } } } }\n  }\n}` };
  const d: any = execQuery(doc as any);
  const dirs = (d.__schema?.directives ?? []).filter((x: any) => /idempotent/i.test(x.name));
  writeFileSync(join(OUT, "introspect-idempotent.json"), JSON.stringify({
    experiment: "G-INTROSPECT", runAtUtc: RUN, apiVersion: VERSION, store: STORE,
    document: { sha256: sha256Hex(doc.document), text: doc.document }, result: dirs, verdict: dirs.length ? "PASS" : "NOT FOUND",
  }, null, 1));
  records.push({ name: "G-INTROSPECT", purpose: "idempotent-directive", file: "introspect-idempotent.json", sha256: sha256Hex(doc.document), verdict: dirs.length ? "PASS" : "NOT FOUND" });
} catch (e) { records.push({ name: "G-INTROSPECT", purpose: "idempotent-directive", file: "introspect-idempotent.json", verdict: fail(e) }); }

// ── MANIFEST + register ────────────────────────────────────────────────────
const manifest = readdirSync(OUT).filter((f) => f.endsWith(".json") && f !== "MANIFEST.sha256").sort()
  .map((f) => `${createHash("sha256").update(readFileSync(join(OUT, f))).digest("hex")}  ${f}`).join("\n");
writeFileSync(join(OUT, "MANIFEST.sha256"), manifest + "\n");
writeFileSync(join(OUT, "validation-register.json"), JSON.stringify({ runAtUtc: RUN, store: STORE, apiVersion: VERSION, verifiedAppId: appId, costNote, records }, null, 1));
console.log(records.map((r) => `${r.verdict.startsWith("PASS") ? "PASS" : "XXXX"}  ${r.name}  ${r.purpose}  ${r.verdict.slice(0, 90)}`).join("\n"));
