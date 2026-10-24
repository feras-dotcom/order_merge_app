// G-READBACK / G-AGREEMENT-A / G-INTROSPECT evidence runner (docs §12.1, §12.8, §17).
// READ-ONLY: executes only the pinned query documents from
// app/lib/shipping-refund-queries.ts (exact text, pinned sha256) against the
// approved development store, applies the repo's own response validators, and
// writes the sanitized archive to docs/evidence/shipping-v0/.
//
//   npx vite-node --script scripts/shipping-refund-readback.ts
//
// Channels:
//   - default: `shopify app execute` (authorized CLI session; returns `data`
//     only — `extensions.cost` is not exposed).
//   - SHIPRB_TOKEN_ENV=<env var name holding an offline access token for the
//     store>: direct POST to /admin/api/<ver>/graphql.json with
//     `Shopify-GraphQL-Cost-Debug: 1`, capturing extensions.cost. The token is
//     read from the named environment variable at run time and is never
//     printed or written to evidence.
//
// Env: SHIPRB_STORE (default ordermergetest2.myshopify.com), SHIPRB_VERSION
// (default 2026-04), SHIPRB_OUT (default docs/evidence/shipping-v0).
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Q_APPID, Q_RECHECK, Q_RECONCILE, Q_REFUND_DETAIL, Q_AGREEMENTS,
  sha256Hex, validateAppIdentity, validateExecRecheck, validateRefundList,
  validateRefundDetailResponse, validateAgreementsPage,
} from "../app/lib/shipping-refund-queries";
import { buildManifestLines, MANIFEST_NAME } from "./lib/evidence-manifest";
import { verdictFromCost, costGateStatus, type DocumentCostVerdict } from "./lib/evidence-cost";

const STORE = process.env.SHIPRB_STORE ?? "ordermergetest2.myshopify.com";
const VERSION = process.env.SHIPRB_VERSION ?? "2026-04";
const OUT = process.env.SHIPRB_OUT ?? "docs/evidence/shipping-v0";
const TOKEN_ENV = process.env.SHIPRB_TOKEN_ENV;
const RUN = new Date().toISOString();
const REPO_ROOT = process.cwd();
const CHANNEL = TOKEN_ENV ? "admin-graphql-http" : "shopify-app-execute";

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
  const qf = join(process.env.TEMP ?? "/tmp", `shiprb-${doc.name}.graphql`);
  writeFileSync(qf, doc.document);
  const vf = join(process.env.TEMP ?? "/tmp", `shiprb-${doc.name}.vars.json`);
  let varArg = "";
  if (variables) {
    writeFileSync(vf, JSON.stringify(variables));
    varArg = ` --variable-file "${vf}"`;
  }
  // stderr merged: the CLI draws GraphQL error bodies on stderr.
  const raw = execSync(
    `npx shopify app execute --store ${STORE} --version ${VERSION} --query-file "${qf}"${varArg} 2>&1`,
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 },
  );
  const i = raw.indexOf("{"), j = raw.lastIndexOf("}");
  if (i < 0 || j <= i) throw new Error(`CLI returned no JSON body: ${raw.slice(0, 300)}`);
  const body = JSON.parse(raw.slice(i, j + 1));
  // The CLI prints the data object; a failed operation prints {errors:[...]}.
  if (body && Array.isArray(body.errors) && body.errors.length > 0 && body.data === undefined) {
    return { data: null, errors: body.errors, extensions: null };
  }
  return { data: body.data ?? body, errors: body.errors ?? null, extensions: body.extensions ?? null };
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
  "gid://shopify/Refund/1120895828215", // #1104 restock-shaped, 0.00
  "gid://shopify/Refund/1120894320887", // #1099 Scenario5A
];
const REFUND_ORDER: Record<string, string> = {
  "gid://shopify/Refund/1123042787575": O.WITH_REFUND,
  "gid://shopify/Refund/1123042066679": O.E2,
  "gid://shopify/Refund/1122917253367": O.E1,
  "gid://shopify/Refund/1120895828215": O.NEG1,
  "gid://shopify/Refund/1120894320887": O.NEG2,
};
const NESTED_CONNS = ["refundShippingLines", "refundLineItems", "orderAdjustments", "transactions"] as const;

const written: string[] = [];
const records: any[] = [];

const writeArtifact = (file: string, payload: Record<string, unknown>) => {
  writeFileSync(join(OUT, file), JSON.stringify(payload, null, 1));
  written.push(file);
};

const rec = (doc: { name: string; document: string; documentSha256: string }, purpose: string,
  variables: Record<string, unknown> | undefined, r: ExecResult | null, verdict: string,
  extra: Record<string, unknown> = {}) => {
  const file = `${doc.name.toLowerCase()}-${purpose.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}.json`;
  writeArtifact(file, {
    experiment: "G-READBACK/GA-A", runAtUtc: RUN, apiVersion: VERSION, store: STORE,
    channel: CHANNEL,
    document: { name: doc.name, sha256: doc.documentSha256, text: doc.document },
    variables, verdict,
    executionErrors: r?.errors ?? null,
    response: r?.data ?? null,
    cost: (r?.extensions as any)?.cost ?? null,
    ...extra,
  });
  records.push({ name: doc.name, purpose, file, sha256: doc.documentSha256, verdict });
  return r;
};

const fail = (e: unknown) => `FAIL: ${String((e as Error)?.message ?? e).slice(0, 300)}`;
const costNote = TOKEN_ENV
  ? "extensions.cost captured via Shopify-GraphQL-Cost-Debug: 1"
  : "shopify app execute returns data only; extensions.cost is not exposed by this channel";
const hasErrors = (r: ExecResult | null) => Array.isArray(r?.errors) && (r!.errors as unknown[]).length > 0;

// Hard safety boundary for the token channel: before ANY order query runs,
// the target must be the approved development store and Q-APPID must return
// the independently archived MergeShip app id. Any mismatch aborts the run.
const EXPECTED_STORE = "ordermergetest2.myshopify.com";
const EXPECTED_APP_GID = "gid://shopify/App/426185785345";

async function main() {
  mkdirSync(OUT, { recursive: true });
  if (TOKEN_ENV && STORE !== EXPECTED_STORE) {
    throw new Error(`refusing token-channel run against ${STORE} — only ${EXPECTED_STORE} is approved`);
  }

  // ── Q-APPID ────────────────────────────────────────────────────────────────
  let appId = "";
  try {
    const r = await execQuery(Q_APPID);
    const v = validateAppIdentity({ data: r.data });
    appId = v.ok ? v.appId! : "";
    rec(Q_APPID, "identity", undefined, r, v.ok && !hasErrors(r) ? "PASS" : `FAIL: ${v.ok ? "top-level errors" : v.reason}`);
  } catch (e) { rec(Q_APPID, "identity", undefined, null, fail(e)); }
  if (TOKEN_ENV && appId !== EXPECTED_APP_GID) {
    throw new Error(`refusing order reads: app identity ${appId || "(none)"} != expected ${EXPECTED_APP_GID}`);
  }

  // ── Q-RECHECK: cancelled secondary (BASE) + PAID primary ───────────────────
  try {
    const vars = { source: O.BASE, primary: O.NO_REFUNDS };
    const r = await execQuery(Q_RECHECK, vars);
    const v = validateExecRecheck({ data: r.data }, { sourceOrderId: O.BASE, primaryOrderId: O.NO_REFUNDS });
    rec(Q_RECHECK, "cancelled_secondary", vars, r, v.ok && !hasErrors(r) ? "PASS" : `FAIL: ${v.ok ? "top-level errors" : v.reason}`);
  } catch (e) { rec(Q_RECHECK, "cancelled_secondary", { source: O.BASE, primary: O.NO_REFUNDS }, null, fail(e)); }

  // ── Q-RECONCILE over the order set ─────────────────────────────────────────
  for (const [purpose, src] of [["no_refunds", O.NO_REFUNDS], ["with_refund_e6", O.WITH_REFUND],
    ["base_cancelled", O.BASE], ["e2_cancelled_refund", O.E2], ["e1_cancelled_refund", O.E1],
    ["neg_candidate_1104", O.NEG1], ["neg_candidate_1099", O.NEG2]] as const) {
    try {
      const r = await execQuery(Q_RECONCILE, { source: src });
      const v = validateRefundList({ data: r.data }, { sourceOrderId: src });
      const refunds = (r.data as any)?.order?.refunds?.length ?? "?";
      rec(Q_RECONCILE, purpose, { source: src }, r,
        v.ok && !hasErrors(r) ? "PASS" : `FAIL: ${v.ok ? "top-level errors" : v.reason}`,
        { refundCount: refunds });
    } catch (e) { rec(Q_RECONCILE, purpose, { source: src }, null, fail(e)); }
  }

  // ── Q-REFUND-DETAIL: five ids (worst-case bound) — execution vs identity vs
  //    nested-evidence completeness are separate verdict dimensions ──────────
  try {
    const vars = { ids: REFUND_IDS };
    const r = await execQuery(Q_REFUND_DETAIL, vars);
    const nodes = (r.data as any)?.nodes ?? [];
    const checks = nodes.map((n: any, i: number) => {
      const incompletes = NESTED_CONNS.filter((c) => n?.[c]?.pageInfo?.hasNextPage !== false);
      return {
        requestedId: REFUND_IDS[i], nodeId: n?.id ?? null,
        orderOk: n?.order?.id === REFUND_ORDER[REFUND_IDS[i]],
        incompleteConnections: incompletes,
        dutiesArray: Array.isArray(n?.duties),
      };
    });
    const executed = nodes.length === REFUND_IDS.length && !hasErrors(r);
    const identityOk = checks.every((c: any) => c.nodeId === c.requestedId && c.orderOk);
    const completeOk = checks.every((c: any) => c.incompleteConnections.length === 0 && c.dutiesArray);
    const verdict = !executed ? "FAIL: execution"
      : !identityOk ? "FAIL: identity/order association"
      : completeOk ? "PASS"
      : "INCOMPLETE: " + checks.filter((c: any) => c.incompleteConnections.length || !c.dutiesArray)
        .map((c: any) => `${String(c.requestedId).split("/").pop()}: ${c.incompleteConnections.join("+") || "duties not array"}`).join("; ");
    rec(Q_REFUND_DETAIL, "five_ids", vars, r, verdict,
      { verdictDimensions: { execution: executed ? "ok" : "fail", identity: identityOk ? "ok" : "fail", nestedEvidenceComplete: completeOk }, nodeChecks: checks });
  } catch (e) { rec(Q_REFUND_DETAIL, "five_ids", { ids: REFUND_IDS }, null, fail(e)); }
  // Strict single-refund check (E6) against the repo validator.
  try {
    const vars = { ids: [REFUND_IDS[0]] };
    const r = await execQuery(Q_REFUND_DETAIL, vars);
    const v = validateRefundDetailResponse({ data: r.data }, [REFUND_IDS[0]], { sourceOrderId: O.WITH_REFUND });
    rec(Q_REFUND_DETAIL, "strict_single_e6", vars, r, v.ok && !hasErrors(r) ? "PASS" : `FAIL: ${v.ok ? "top-level errors" : v.reason}`);
  } catch (e) { rec(Q_REFUND_DETAIL, "strict_single_e6", { ids: [REFUND_IDS[0]] }, null, fail(e)); }

  // ── Q-AGREEMENTS: raw per-page responses archived; verdict reflects
  //    validator results and whether the connection completed in ≤5 pages ────
  for (const [purpose, src] of [["base_cancelled", O.BASE], ["pos_e6", O.WITH_REFUND],
    ["pos_e2", O.E2], ["pos_e1", O.E1], ["neg_1104", O.NEG1], ["neg_1099", O.NEG2]] as const) {
    try {
      const pages: any[] = [];
      let after: string | null = null;
      let vFail: string | null = null;
      let completed = false;
      for (let p = 0; p < 5; p += 1) {
        const r = await execQuery(Q_AGREEMENTS, { source: src, after });
        const v = hasErrors(r)
          ? { ok: false as const, reason: "top-level errors" }
          : validateAgreementsPage({ data: r.data }, { sourceOrderId: src });
        pages.push({ page: p + 1, variables: { source: src, after }, validator: v.ok ? "ok" : v.reason, errors: r.errors ?? null, response: r.data, extensions: r.extensions ?? null });
        if (!v.ok) { vFail = v.reason ?? "validator failure"; break; }
        const pi = (r.data as any)?.order?.agreements?.pageInfo;
        if (pi?.hasNextPage !== true) { completed = pi?.hasNextPage === false; break; }
        after = pi.endCursor;
      }
      const verdict = vFail ? `FAIL: ${vFail}` : completed ? "PASS" : "INCOMPLETE: 5-page budget exhausted with hasNextPage";
      const nodes = pages.flatMap((p) => p.response?.order?.agreements?.nodes ?? []);
      // Cost is per-request: every page keeps its own extensions.cost (was
      // dropped in E-2's flattened fix — retain it here).
      const pageCosts = pages.map((p) => ({ page: p.page, verdict: p.validator, cost: p.extensions?.cost ?? null }));
      rec(Q_AGREEMENTS, purpose, { source: src }, null, verdict, {
        pagesScanned: pages.length, pageComplete: completed, verifiedAppId: appId,
        agreementNodes: nodes,
        refundAgreements: nodes.filter((a: any) => a.__typename === "RefundAgreement"),
        rawPages: pages, // sanitized per-page responses incl. pageInfo (E-2)
        costPerPage: pageCosts, // per-request cost retention
      });
    } catch (e) { rec(Q_AGREEMENTS, purpose, { source: src }, null, fail(e)); }
  }

  // ── G-INTROSPECT: @idempotent directive ────────────────────────────────────
  try {
    const doc = { name: "G-INTROSPECT", document: `query {\n  __schema {\n    directives { name locations args { name type { kind name ofType { kind name ofType { kind name } } } } }\n  }\n}` };
    const r = await execQuery(doc as any);
    const dirs = ((r.data as any)?.__schema?.directives ?? []).filter((x: any) => /idempotent/i.test(x.name));
    const verdict = hasErrors(r) ? "FAIL: top-level errors" : dirs.length ? "PASS" : "NOT FOUND";
    writeArtifact("introspect-idempotent.json", {
      experiment: "G-INTROSPECT", runAtUtc: RUN, apiVersion: VERSION, store: STORE, channel: CHANNEL,
      document: { sha256: sha256Hex(doc.document), text: doc.document },
      executionErrors: r.errors ?? null, result: dirs, verdict,
    });
    records.push({ name: "G-INTROSPECT", purpose: "idempotent-directive", file: "introspect-idempotent.json", sha256: sha256Hex(doc.document), verdict });
  } catch (e) { records.push({ name: "G-INTROSPECT", purpose: "idempotent-directive", file: "introspect-idempotent.json", verdict: fail(e) }); }

  // ── BASE provenance: order events proving who cancelled/restocked (E-4) ───
  // Supplementary (non-pinned) read-only query; archived under its own sha256.
  try {
    const doc = { name: "Q-EVENTS-BASE", document: `query BaseCancelEvents($id: ID!) {\n  order(id: $id) {\n    id\n    cancelledAt\n    events(first: 30) {\n      nodes { __typename id createdAt ... on BasicEvent { message appTitle } }\n      pageInfo { hasNextPage endCursor }\n    }\n  }\n}` };
    const r = await execQuery(doc as any, { id: O.BASE });
    writeArtifact("base-cancel-events.json", {
      experiment: "G-AGREEMENT-A/BASE-provenance", runAtUtc: RUN, apiVersion: VERSION, store: STORE, channel: CHANNEL,
      document: { name: doc.name, sha256: sha256Hex(doc.document), text: doc.document },
      variables: { id: O.BASE }, executionErrors: r.errors ?? null, response: r.data,
      verdict: hasErrors(r) ? "FAIL: top-level errors" : "PASS",
    });
    records.push({ name: "Q-EVENTS-BASE", purpose: "base-cancel-provenance", file: "base-cancel-events.json", sha256: sha256Hex(doc.document), verdict: hasErrors(r) ? "FAIL" : "PASS" });
  } catch (e) { records.push({ name: "Q-EVENTS-BASE", purpose: "base-cancel-provenance", file: "base-cancel-events.json", verdict: fail(e) }); }

  // ── Cost gate (12.1.2): per document and per agreement page ───────────────
  // UNMEASURED is never a pass: absent extensions fail the gate.
  const costVerdicts: DocumentCostVerdict[] = records
    .filter((r) => r.name !== "G-INTROSPECT" && r.name !== "Q-EVENTS-BASE")
    .map((r) => {
      try {
        const artifact = JSON.parse(readFileSync(join(OUT, r.file), "utf8"));
        if (r.name === "Q-AGREEMENTS") {
          const pageVerdicts = (artifact.costPerPage ?? []).map((p: any) =>
            verdictFromCost(`${r.name}-p${p.page}`, { cost: p.cost }));
          const doc: DocumentCostVerdict = {
            document: r.name, measured: pageVerdicts.every((v: DocumentCostVerdict) => v.measured),
            requestedQueryCost: pageVerdicts.map((v: DocumentCostVerdict) => v.requestedQueryCost).filter((n): n is number => n !== null).reduce((a, b) => a + b, 0) || null,
            actualQueryCost: pageVerdicts.map((v: DocumentCostVerdict) => v.actualQueryCost).filter((n): n is number => n !== null).reduce((a, b) => a + b, 0) || null,
            withinThreshold: pageVerdicts.every((v: DocumentCostVerdict) => v.withinThreshold === true) ? true : null,
            pages: pageVerdicts,
            status: pageVerdicts.every((v: DocumentCostVerdict) => v.measured && v.withinThreshold) ? "PASS"
              : pageVerdicts.every((v: DocumentCostVerdict) => v.measured) ? "FAIL" : "UNMEASURED",
          };
          return doc;
        }
        return verdictFromCost(r.name, artifact.cost ? { cost: artifact.cost } : artifact.extensions ?? null);
      } catch {
        return verdictFromCost(r.name, null);
      }
    });
  const gate = costGateStatus(costVerdicts);

  // ── Register first, manifest LAST over every intended artifact (E-3) ──────
  writeArtifact("validation-register.json", {
    runAtUtc: RUN, store: STORE, apiVersion: VERSION, channel: CHANNEL, verifiedAppId: appId,
    costNote, costGate: gate, costVerdicts, records,
  });
  const files = [...written, "README.md"].filter((f, i, a) => a.indexOf(f) === i);
  writeFileSync(join(OUT, MANIFEST_NAME), buildManifestLines(OUT, files).join("\n") + "\n");
  console.log(records.map((r) => `${String(r.verdict).startsWith("PASS") ? "PASS" : "XXXX"}  ${r.name}  ${r.purpose}  ${String(r.verdict).slice(0, 100)}`).join("\n"));
  console.log("artifacts:", readdirSync(OUT).length, "manifest entries:", files.length);
}

await main();
