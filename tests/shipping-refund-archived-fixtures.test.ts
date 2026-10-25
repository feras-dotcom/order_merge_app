// Archived real-response fixtures (design §20.1.1, §12.8.5): provenance
// discipline, coverage of every response shape the development store has
// produced through read-only calls, and those exact responses driven through
// the production validators and pure classifiers. No database, no network.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ATTRIBUTION_STATUS, classifyGAgreementEvidence, evaluateRefundAttribution, RECONCILE_TIMING_SKEW_MS, type ReconcileAgreement } from "../app/lib/shipping-refund-gate";
import { admitBaseline, analyzeExecRecheck, buildRefundBaseline, classifyRefundRecord, REFUND_BASELINE_MODE } from "../app/lib/shipping-refund-baseline";
import {
  QUERY_COST_ACCEPTANCE_LIMIT,
  validateAgreementsPage,
  validateAppIdentity,
  validateExecRecheck,
  validateRefundDetailResponse,
  validateRefundList,
} from "../app/lib/shipping-refund-queries";
import { validateCostExtension } from "../scripts/lib/evidence-cost";
import {
  agreementVariant,
  agreementVariantsPermitted,
  ARCHIVE_MANIFEST_SHA256,
  ARCHIVED_REFUND,
  ARCHIVED_SOURCES as A,
  archivedDetailNode,
  archivedTransaction,
  auditServedPayload,
  currentManifestSha256,
  EVIDENCE_DIR,
  EVIDENCE_RUN_ID,
  faultInjection,
  loadArchivedArtifact,
  provenanceOf,
  provenanceProblem,
  SCHEMA_DERIVED_ALLOWED,
  SCHEMA_DERIVED_ALLOWED_SHA256,
  schemaDerived,
  shopifyDecimal,
} from "./helpers/shipping-refund-archived-fixtures";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const MERGESHIP_APP = "gid://shopify/App/426185785345";
const ORDER = {
  NO_REFUNDS: "gid://shopify/Order/8052845805815",
  E6: "gid://shopify/Order/8078037057783",
  BASE: "gid://shopify/Order/8052786135287",
  E2: "gid://shopify/Order/8078035452151",
  E1: "gid://shopify/Order/8077992820983",
  N1104: "gid://shopify/Order/8051362136311",
  N1099: "gid://shopify/Order/8051306299639",
};
const RECONCILE = {
  no_refunds: ORDER.NO_REFUNDS,
  with_refund_e6: ORDER.E6,
  base_cancelled: ORDER.BASE,
  e2_cancelled_refund: ORDER.E2,
  e1_cancelled_refund: ORDER.E1,
  neg_candidate_1104: ORDER.N1104,
  neg_candidate_1099: ORDER.N1099,
} as const;
const AGREEMENTS = { base_cancelled: ORDER.BASE, pos_e6: ORDER.E6, pos_e2: ORDER.E2, pos_e1: ORDER.E1, neg_1104: ORDER.N1104, neg_1099: ORDER.N1099 } as const;
const POS = { pos_e1: ARCHIVED_REFUND.E1, pos_e2: ARCHIVED_REFUND.E2, pos_e6: ARCHIVED_REFUND.E6 } as const;
const data = (art: { body: any }) => ({ data: art.body.response });
const toAgreement = (n: any): ReconcileAgreement => ({
  id: n.id,
  typename: n.__typename,
  reason: n.reason ?? null,
  happenedAt: n.happenedAt ?? null,
  appId: n.app?.id ?? null,
  refundId: n.refund?.id ?? null,
});
const READ_AT_MS = Date.parse("2026-10-25T10:29:49.706Z");

// ── provenance discipline (§20.1.1) ────────────────────────────────────────

describe("fixture provenance", () => {
  it("is derived from the current, verified archive", () => {
    expect(currentManifestSha256()).toBe(ARCHIVE_MANIFEST_SHA256);
    const art = A.reconcile("e2_cancelled_refund");
    expect(art.body.runAtUtc).toBe(EVIDENCE_RUN_ID.split(" ")[1]);
  });

  it("pins the reviewed SCHEMA_DERIVED_ALLOWED list exactly as §20.1.1 states it", () => {
    expect(sha(JSON.stringify(SCHEMA_DERIVED_ALLOWED))).toBe(SCHEMA_DERIVED_ALLOWED_SHA256);
    const statuses = SCHEMA_DERIVED_ALLOWED.filter((s) => s.startsWith("transaction-status:"));
    expect(statuses.map((s) => s.split(":")[1]).sort()).toEqual(["AWAITING_RESPONSE", "ERROR", "FAILURE", "PENDING", "UNKNOWN"]);
    for (const s of SCHEMA_DERIVED_ALLOWED) expect(s).toMatch(/^(transaction-status|agreement-attribution):/);
  });

  it("allows agreement variants only while G-AGREEMENT is not CONFIRMED", () => {
    expect(ATTRIBUTION_STATUS).toBe("UNVERIFIED");
    expect(agreementVariantsPermitted()).toBe(true);
  });

  it("refuses a schema-derived fixture for any shape off the allowlist", () => {
    expect(() => schemaDerived("transaction-status:SUCCESS", {})).toThrow(/not on SCHEMA_DERIVED_ALLOWED/);
    expect(() => schemaDerived("transaction-status:AUTHORIZING", {})).toThrow(/not on SCHEMA_DERIVED_ALLOWED/);
    expect(() => archivedTransaction("REFUND", { id: "gid://shopify/OrderTransaction/1", parentId: null, status: "AUTHORIZING" })).toThrow(/not on SCHEMA_DERIVED_ALLOWED/);
    expect(provenanceOf(archivedTransaction("REFUND", { id: "gid://shopify/OrderTransaction/1", parentId: null, status: "PENDING" }))).toEqual({
      kind: "schema-derived",
      shape: "transaction-status:PENDING",
    });
  });

  it("voids a fixture whose document hash differs from the pinned document", () => {
    expect(() => loadArchivedArtifact("q-reconcile-no_refunds.json", { documentSha256: "0".repeat(64) })).toThrow(/fixture void/);
  });

  it("refuses an archive whose manifest is not the one the fixtures were derived from", () => {
    expect(() => loadArchivedArtifact("q-reconcile-no_refunds.json", { manifestSha256: "f".repeat(64) })).toThrow(/re-review and re-pin/);
  });

  it("tags archived-derived nodes with run id, document hash, source and manifest hashes and derivations", () => {
    const node = archivedDetailNode({
      id: "gid://shopify/Refund/42",
      orderId: "gid://shopify/Order/43",
      note: "n",
      createdAt: "2026-10-20T10:00:00.000Z",
      processedAt: "2026-10-20T10:00:05.000Z",
    });
    const p = provenanceOf(node);
    expect(p).toMatchObject({
      kind: "archived",
      evidenceRunId: EVIDENCE_RUN_ID,
      documentName: "Q-REFUND-DETAIL",
      sourceFile: "q-refund-detail-five_ids.json",
      manifestSha256: ARCHIVE_MANIFEST_SHA256,
    });
    expect(provenanceProblem(p)).toBeNull();
    // Rebinding touched only identity, note and timestamps; the money shape is archived.
    expect(p?.kind === "archived" && p.derivations).toEqual(["rebind:refund-id", "rebind:order-id", "rebind:note", "rebind:timestamps"]);
    expect(node.totalRefundedSet).toEqual({ presentmentMoney: { amount: "8.0", currencyCode: "USD" } });
  });

  it("the served-payload audit flags untagged and unpinned payloads", () => {
    expect(auditServedPayload("query ShippingRefundAppIdentity", { currentAppInstallation: { app: { id: "x" } } })[0].problem).toMatch(/untagged/);
    expect(auditServedPayload("query Other", {})[0].problem).toMatch(/unpinned/);
    expect(auditServedPayload("query ShippingRefundDetail", { nodes: [faultInjection("detail-node-missing", {})] })[0].problem).toBeNull();
    const v = agreementVariant("foreign-app", { id: "gid://shopify/RefundAgreement/1", appId: null, refundId: "gid://shopify/Refund/1", happenedAt: "2026-10-20T10:00:00Z" });
    expect(provenanceProblem(provenanceOf(v))).toBeNull();
  });

  it("formats amounts and instants the way the archived responses do", () => {
    expect(shopifyDecimal("8.00")).toBe("8.0");
    expect(shopifyDecimal("0.40")).toBe("0.4");
    expect(shopifyDecimal("16")).toBe("16.0");
  });
});

// ── coverage of the observed shapes (§20.1.1 bullet 2) ─────────────────────

describe("archived coverage of every read-only-observable response shape", () => {
  const reconcile = (p: keyof typeof RECONCILE) => A.reconcile(p).body.response.order;
  const detailNodes = () => A.detailFive().body.response.nodes as any[];
  const allTxns = () => Object.keys(RECONCILE).flatMap((p) => reconcile(p as keyof typeof RECONCILE).transactions as any[]);
  const allAgreements = () => Object.keys(AGREEMENTS).flatMap((p) => A.agreements(p).body.agreementNodes as any[]);

  it("order shapes: cancelled + closed PAID secondary, cancelled refunded, open PAID", () => {
    expect(reconcile("base_cancelled")).toMatchObject({ closed: true, displayFinancialStatus: "PAID" });
    expect(reconcile("base_cancelled").cancelledAt).toEqual(expect.any(String));
    expect(reconcile("e2_cancelled_refund")).toMatchObject({ closed: true, displayFinancialStatus: "PARTIALLY_REFUNDED" });
    expect(reconcile("e1_cancelled_refund")).toMatchObject({ closed: false, displayFinancialStatus: "PARTIALLY_REFUNDED" });
    expect(reconcile("no_refunds")).toMatchObject({ cancelledAt: null, displayFinancialStatus: "PAID" });
  });

  it("refunds arrays: empty and non-empty", () => {
    expect(reconcile("no_refunds").refunds).toEqual([]);
    expect(reconcile("base_cancelled").refunds).toEqual([]);
    for (const p of ["with_refund_e6", "e2_cancelled_refund", "e1_cancelled_refund", "neg_candidate_1104", "neg_candidate_1099"] as const) {
      expect(reconcile(p).refunds).toHaveLength(1);
    }
  });

  it("transaction shapes that exist on the store", () => {
    const shapes = new Set(allTxns().map((t) => `${t.kind}/${t.status}/${t.gateway}/test=${t.test}`));
    for (const s of ["SALE/SUCCESS/manual/test=false", "AUTHORIZATION/SUCCESS/bogus/test=true", "CAPTURE/SUCCESS/bogus/test=true", "REFUND/SUCCESS/bogus/test=true", "REFUND/SUCCESS/manual/test=false"]) {
      expect(shapes).toContain(s);
    }
    // Only SUCCESS has been observed — every other status is schema-derived on the allowlist.
    expect(new Set(allTxns().map((t) => t.status))).toEqual(new Set(["SUCCESS"]));
  });

  it("refund detail shapes: shipping-only, zero-value restock (incomplete line items), monetary-only with an adjustment", () => {
    const byId = new Map(detailNodes().map((n) => [n.id, n]));
    const e2 = byId.get(ARCHIVED_REFUND.E2);
    expect(e2.refundShippingLines.nodes).toHaveLength(1);
    expect(e2.refundLineItems.nodes).toEqual([]);
    const zero = byId.get(ARCHIVED_REFUND.ZERO_RESTOCK_1104);
    expect(zero.totalRefundedSet.presentmentMoney.amount).toBe("0.0");
    expect(zero.transactions.nodes).toEqual([]);
    expect(zero.refundLineItems.pageInfo.hasNextPage).toBe(true);
    const mon = byId.get(ARCHIVED_REFUND.MONETARY_1099);
    expect(mon.refundShippingLines.nodes).toEqual([]);
    expect(mon.orderAdjustments.nodes).toHaveLength(1);
  });

  it("agreement shapes seen in BASE / POS / NEG candidates", () => {
    const shapes = new Set(allAgreements().map((a) => `${a.__typename}/${a.reason}`));
    expect(shapes).toEqual(new Set(["OrderAgreement/ORDER", "OrderEditAgreement/ORDER_EDIT", "RefundAgreement/REFUND"]));
    expect(new Set(allAgreements().map((a) => a.app?.id))).toEqual(new Set([MERGESHIP_APP, "gid://shopify/App/580111"]));
    expect(A.agreements("base_cancelled").body.agreementNodes.some((a: any) => a.__typename === "RefundAgreement")).toBe(false);
  });

  it("createdAt: only non-null has been observed (null stays unobserved, not schema-derived)", () => {
    const created = Object.keys(RECONCILE).flatMap((p) => (reconcile(p as keyof typeof RECONCILE).refunds as any[]).map((r) => r.createdAt));
    expect(created.length).toBeGreaterThan(0);
    for (const c of created) expect(c).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it("cost measurements exist for every archived query response and stay within the acceptance limit", () => {
    const files = readdirSync(EVIDENCE_DIR).filter((f) => f.startsWith("q-"));
    expect(files.length).toBe(17);
    for (const f of files) {
      const body = loadArchivedArtifact(f).body;
      const costs = body.rawPages ? body.rawPages.map((p: any) => p.extensions?.cost) : [body.cost];
      for (const cost of costs) {
        const c = validateCostExtension({ cost });
        expect(c.ok, f).toBe(true);
        if (c.ok) expect(c.requestedQueryCost).toBeLessThanOrEqual(QUERY_COST_ACCEPTANCE_LIMIT);
      }
    }
  });
});

// ── archived responses through the production validators and classifiers ──

describe("archived responses through production code", () => {
  it("Q-APPID, Q-RECONCILE, Q-RECHECK and Q-AGREEMENTS validate", () => {
    expect(validateAppIdentity(data(A.appId()))).toEqual({ ok: true, appId: MERGESHIP_APP });
    for (const [p, id] of Object.entries(RECONCILE)) expect(validateRefundList(data(A.reconcile(p)), { sourceOrderId: id })).toEqual({ ok: true });
    expect(validateExecRecheck(data(A.recheck()), { sourceOrderId: ORDER.BASE, primaryOrderId: ORDER.NO_REFUNDS })).toEqual({ ok: true });
    for (const [p, id] of Object.entries(AGREEMENTS)) {
      for (const page of A.agreements(p).body.rawPages) expect(validateAgreementsPage({ data: page.response }, { sourceOrderId: id })).toEqual({ ok: true });
    }
  });

  it("Q-REFUND-DETAIL: the strict E6 read passes; the five-id read fails closed on #1104's incomplete line items", () => {
    const single = A.detailSingle();
    expect(validateRefundDetailResponse(data(single), [ARCHIVED_REFUND.E6], { sourceOrderId: ORDER.E6, ownRefundId: ARCHIVED_REFUND.E6 })).toEqual({ ok: true });
    for (const node of A.detailFive().body.response.nodes as any[]) {
      const v = validateRefundDetailResponse({ data: { nodes: [node] } }, [node.id], { sourceOrderId: node.order.id });
      if (node.id === ARCHIVED_REFUND.ZERO_RESTOCK_1104) {
        expect(v).toEqual({ ok: false, reason: "nodes[0].refundLineItems: pageInfo.hasNextPage must be exactly false" });
      } else {
        expect(v).toEqual({ ok: true });
      }
    }
  });

  it("8.2.1 refund-record classes of the real refunds", () => {
    const cls = Object.fromEntries((A.detailFive().body.response.nodes as any[]).map((n) => [n.id, classifyRefundRecord(n, "USD")]));
    expect(cls).toEqual({
      [ARCHIVED_REFUND.E6]: "FINANCIAL",
      [ARCHIVED_REFUND.E2]: "FINANCIAL",
      [ARCHIVED_REFUND.E1]: "FINANCIAL",
      [ARCHIVED_REFUND.ZERO_RESTOCK_1104]: "UNCLASSIFIABLE",
      [ARCHIVED_REFUND.MONETARY_1099]: "FINANCIAL",
    });
  });

  it("the MergeShip-cancelled BASE secondary yields an admitted STRICT_EMPTY baseline", () => {
    const r = analyzeExecRecheck(data(A.recheck()), { sourceOrderId: ORDER.BASE, primaryOrderId: ORDER.NO_REFUNDS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.evidence.refundIds).toEqual([]);
    expect(r.evidence.capture).toMatchObject({ kind: "SALE", status: "SUCCESS", gateway: "manual", test: false });
    expect(r.evidence.authorizationId).toBeNull();
    const baseline = buildRefundBaseline({ capturedAt: "2026-10-25T10:29:49Z", currency: r.evidence.currencyCode, evidence: r.evidence });
    expect(baseline.mode).toBe(REFUND_BASELINE_MODE);
    expect(admitBaseline(baseline)).toEqual({ ok: true, baseline });
  });

  it("each POS refund carries exactly one typed RefundAgreement attributed to the verified app", () => {
    const appId = validateAppIdentity(data(A.appId())).appId!;
    const detail = new Map((A.detailFive().body.response.nodes as any[]).map((n) => [n.id, n]));
    for (const [p, refundId] of Object.entries(POS)) {
      const agreements = (A.agreements(p).body.agreementNodes as any[]).map(toAgreement);
      const processed = Date.parse(detail.get(refundId).processedAt);
      const v = evaluateRefundAttribution({
        refundId,
        agreements: { ok: true, agreements },
        appId: { ok: true, id: appId },
        windowStartMs: processed - RECONCILE_TIMING_SKEW_MS,
        nowMs: READ_AT_MS,
      });
      expect(v.kind, p).toBe("ATTRIBUTED");
    }
  });

  it("G-AGREEMENT Part A on the archived evidence is INCONCLUSIVE: no staff-created NEG exists", () => {
    const appId = validateAppIdentity(data(A.appId())).appId!;
    // #1099's refund is app-created (refund-1099-provenance.json), so it is
    // excluded from NEG; #1104's has no recorded creator and no linked
    // RefundAgreement. No NEG candidate remains.
    const provenance = JSON.parse(readFileSync(join(EVIDENCE_DIR, "refund-1099-provenance.json"), "utf8"));
    expect(provenance.subject.refundId).toBe(ARCHIVED_REFUND.MONETARY_1099);
    expect(provenance.finding.createdBy).toMatch(/not a staff member/);
    const pos = {
      refundId: ARCHIVED_REFUND.E6,
      processedAt: "2026-10-15T08:10:21Z",
      agreements: (A.agreements("pos_e6").body.agreementNodes as any[]).map(toAgreement),
      verifiedAppId: appId,
      readAtMs: READ_AT_MS,
    };
    expect(classifyGAgreementEvidence({ baseRecorded: true, pos, negComparable: false, neg: null })).toEqual({
      outcome: "INCONCLUSIVE",
      detail: "no NEG observation",
    });
  });
});

// ── recovered E-experiment archives tie to the later read-backs ────────────

describe("recovered E0/E1/E2/E6 archives", () => {
  const e = (n: string) => JSON.parse(readFileSync(join(EVIDENCE_DIR, `${n}.json`), "utf8"));
  const step = (doc: any, prefix: string) => doc.steps.find((s: any) => s.step.startsWith(prefix));

  it("carry their own source hashes and never claim more than the record shows", () => {
    for (const n of ["E0", "E1", "E2", "E6"]) {
      const doc = e(n);
      expect(doc.experiment).toBe(n);
      expect(doc.archiveKind).toBe("recovered-contemporaneous-session-record");
      expect(doc.operatorInitials).toEqual({ value: null, classification: "missing", note: "never recorded" });
      for (const s of Object.values<any>(doc.sources)) expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(doc.gaps.length).toBeGreaterThan(0);
    }
  });

  it("each refundCreate response names the refund the G-READBACK detail read later found, with the same totals", () => {
    const detail = new Map((A.detailFive().body.response.nodes as any[]).map((n) => [n.id, n]));
    const cases: [string, any][] = [
      [ARCHIVED_REFUND.E1, step(e("E1"), "E1-4").response.refundCreate],
      [ARCHIVED_REFUND.E2, step(e("E2"), "E2-6").response.refundCreate],
      [ARCHIVED_REFUND.E6, step(e("E6"), "E6-2/3").responseA.refundCreate],
    ];
    for (const [refundId, created] of cases) {
      expect(created.userErrors).toEqual([]);
      expect(created.refund.id).toBe(refundId);
      const later = detail.get(refundId);
      expect(created.refund.totalRefundedSet.presentmentMoney).toEqual(later.totalRefundedSet.presentmentMoney);
      expect(created.refund.processedAt).toBe(later.processedAt);
      expect(created.refund.transactions.nodes.map((t: any) => t.id)).toEqual(later.transactions.nodes.map((t: any) => t.id));
    }
  });

  it("E6: one key, one refund — the concurrent loser, the replay and the changed payload created nothing", () => {
    const doc = e("E6");
    const conc = step(doc, "E6-2/3");
    expect(conc.responseB.refundCreate.refund).toBeNull();
    expect(step(doc, "E6-4").response.refundCreate.refund.id).toBe(ARCHIVED_REFUND.E6);
    expect(step(doc, "E6-4").readbackSummary.refundCount).toBe(1);
    expect(step(doc, "E6-5").response.refundCreate.refund).toBeNull();
    expect(step(doc, "E6-5").response.refundCreate.userErrors[0].message).toBe("Idempotency key has been used with a different request payload.");
    expect(step(doc, "E6-5").readbackSummary.refundCount).toBe(1);
  });

  it("documents are hashed as archived and the mutation path is the app-credential CLI", () => {
    for (const n of ["E1", "E2"]) {
      for (const s of e(n).steps.filter((x: any) => x.document)) expect(sha(s.document.text)).toBe(s.document.sha256);
      expect(e(n).executionTool.mutationPath).toMatch(/shopify app execute/);
    }
    expect(sha(e("E6").document.text)).toBe(e("E6").document.sha256);
  });
});

// ── sanitization (§17 "Exclude, always") ────────────────────────────────────

describe("evidence sanitization", () => {
  it("no evidence file carries an e-mail address, access token, local user path or database URL", () => {
    for (const f of readdirSync(EVIDENCE_DIR)) {
      const t = readFileSync(join(EVIDENCE_DIR, f), "utf8");
      expect(t, f).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      expect(t, f).not.toMatch(/shp(at|ua|ca|ss)_[A-Za-z0-9]/);
      expect(t, f).not.toMatch(/C:\\\\Users\\\\|C:\/Users\//);
      expect(t, f).not.toMatch(/postgres(ql)?:\/\//);
    }
  });
});
