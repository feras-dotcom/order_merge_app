// Fixture provenance for Shopify response fixtures (design §20.1.1, §12.8.5).
//
// Every Shopify response node a reconciliation test serves carries exactly
// one provenance tag:
//   - "archived": derived from a sanitized response under
//     docs/evidence/shipping-v0/, carrying the evidence-run id, the exact
//     document sha256 (void unless it equals the document pinned today), the
//     source file and its manifest hash, and every derivation applied
//     (identifier/timestamp/note rebinding to the fixture row, or an amount
//     set on the archived money shape);
//   - "schema-derived": only for a shape on SCHEMA_DERIVED_ALLOWED — shapes
//     that cannot be observed on the development store before G-REAL, plus
//     the attribution-path agreement variants while G-AGREEMENT is not
//     CONFIRMED;
//   - "fault-injection": a deliberately malformed input that tests fail-closed
//     handling and claims nothing about what Shopify returns
//     (FAULT_INJECTIONS).
// Tags live in a WeakMap, so the served objects are unchanged.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ATTRIBUTION_STATUS } from "../../app/lib/shipping-refund-gate";
import { SHIPPING_REFUND_QUERY_DOCUMENTS } from "../../app/lib/shipping-refund-queries";
import { MANIFEST_NAME, verifyManifest } from "../../scripts/lib/evidence-manifest";

export const EVIDENCE_DIR = join(__dirname, "../../docs/evidence/shipping-v0");

/** The archived run every fixture here derives from (validation-register.json runAtUtc). */
export const EVIDENCE_RUN_ID = "G-READBACK/GA-A 2026-10-25T10:29:49.706Z";

/** sha256 of the MANIFEST.sha256 the fixtures were derived from. Any change
 *  to the archive changes this hash: re-review the fixtures, then re-pin. */
export const ARCHIVE_MANIFEST_SHA256 =
  "9277b92faa0a9866131e18c1ed5fcaa93d4fc0b723d2a7409acdb536df6174d7";

/**
 * The reviewed allowlist (§20.1.1). Transaction statuses that cannot be
 * produced on the development store before G-REAL (register, §12.1) and,
 * while G-AGREEMENT is not CONFIRMED, the agreement shapes the attribution
 * paths need. Changing it changes SCHEMA_DERIVED_ALLOWED_SHA256 — a test
 * fails until the pin is updated in a reviewed change.
 */
export const SCHEMA_DERIVED_ALLOWED = [
  "transaction-status:PENDING",
  "transaction-status:AWAITING_RESPONSE",
  "transaction-status:FAILURE",
  "transaction-status:ERROR",
  "transaction-status:UNKNOWN",
  "agreement-attribution:foreign-app",
  "agreement-attribution:duplicate-link",
  "agreement-attribution:other-refund-link",
  "agreement-attribution:incomplete-page",
] as const;
export type SchemaDerivedShape = (typeof SCHEMA_DERIVED_ALLOWED)[number];
export const SCHEMA_DERIVED_ALLOWED_SHA256 =
  "e6f460e0dc0454209291daeb3a8059cbcd79b9f98fc87d55a6eb6535a8d66c85";

/** Deliberate malformations; not claims about Shopify's shapes. */
export const FAULT_INJECTIONS = ["detail-node-missing"] as const;
export type FaultInjection = (typeof FAULT_INJECTIONS)[number];

export type Derivation =
  | "rebind:order-id"
  | "rebind:refund-id"
  | "rebind:transaction-id"
  | "rebind:agreement-id"
  | "rebind:app-id"
  | "rebind:note"
  | "rebind:timestamps"
  | "set:amount"
  | "set:refunds"
  | "set:transactions";

export type FixtureProvenance =
  | {
      readonly kind: "archived";
      readonly evidenceRunId: string;
      readonly documentName: string;
      readonly documentSha256: string;
      readonly sourceFile: string;
      readonly sourceSha256: string;
      readonly manifestSha256: string;
      readonly derivations: readonly Derivation[];
    }
  | { readonly kind: "schema-derived"; readonly shape: SchemaDerivedShape }
  | { readonly kind: "fault-injection"; readonly fault: FaultInjection };

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

// ── archive access (fail closed) ──────────────────────────────────────────

const manifestEntries = (): ReadonlyMap<string, string> => {
  const map = new Map<string, string>();
  for (const line of readFileSync(join(EVIDENCE_DIR, MANIFEST_NAME), "utf8").split("\n")) {
    const m = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    if (m) map.set(m[2], m[1]);
  }
  return map;
};

export const currentManifestSha256 = () => sha256(readFileSync(join(EVIDENCE_DIR, MANIFEST_NAME)));

const pinnedDocumentSha256 = (name: string): string => {
  const d = SHIPPING_REFUND_QUERY_DOCUMENTS.find((x) => x.name === name);
  if (!d) throw new Error(`no pinned document named ${name}`);
  return d.documentSha256;
};

export interface ArchivedArtifact {
  readonly file: string;
  readonly sourceSha256: string;
  readonly documentName: string;
  readonly documentSha256: string;
  readonly body: Record<string, any>;
}

const artifactCache = new Map<string, ArchivedArtifact>();

/**
 * Load one archived query artifact. Throws unless the whole archive verifies
 * against its manifest, this file's bytes equal its manifest entry, the
 * manifest is the one the fixtures were derived from, and the artifact's
 * document sha256 equals the document pinned in code today (a fixture whose
 * document changed is void, §20.1.1).
 */
export function loadArchivedArtifact(
  file: string,
  pins: { readonly manifestSha256?: string; readonly documentSha256?: string } = {},
): ArchivedArtifact {
  const cached = artifactCache.get(file);
  if (cached && pins.manifestSha256 === undefined && pins.documentSha256 === undefined) return cached;
  const verified = verifyManifest(EVIDENCE_DIR);
  if (!verified.ok) throw new Error(`evidence archive does not verify: ${verified.reason}`);
  const manifestSha = currentManifestSha256();
  if (manifestSha !== (pins.manifestSha256 ?? ARCHIVE_MANIFEST_SHA256)) {
    throw new Error(`evidence manifest ${manifestSha} is not the one these fixtures were derived from — re-review and re-pin`);
  }
  const bytes = readFileSync(join(EVIDENCE_DIR, file));
  const sourceSha256 = sha256(bytes);
  if (manifestEntries().get(file) !== sourceSha256) throw new Error(`${file} does not match its manifest entry`);
  const body = JSON.parse(bytes.toString("utf8"));
  const documentName = String(body?.document?.name ?? "");
  const documentSha256 = String(body?.document?.sha256 ?? "");
  const expected = pins.documentSha256 ?? pinnedDocumentSha256(documentName);
  if (documentSha256 !== expected || sha256(String(body.document.text)) !== documentSha256) {
    throw new Error(`${file}: archived document ${documentName} ${documentSha256} differs from the pinned ${expected} — fixture void`);
  }
  const artifact = { file, sourceSha256, documentName, documentSha256, body };
  if (pins.manifestSha256 === undefined && pins.documentSha256 === undefined) artifactCache.set(file, artifact);
  return artifact;
}

// ── provenance registry ───────────────────────────────────────────────────

const registry = new WeakMap<object, FixtureProvenance>();

export const provenanceOf = (node: unknown): FixtureProvenance | undefined =>
  node !== null && typeof node === "object" ? registry.get(node) : undefined;

const clone = <T>(v: T): T => structuredClone(v);

function archived<T extends object>(artifact: ArchivedArtifact, node: T, derivations: readonly Derivation[]): T {
  registry.set(node, {
    kind: "archived",
    evidenceRunId: EVIDENCE_RUN_ID,
    documentName: artifact.documentName,
    documentSha256: artifact.documentSha256,
    sourceFile: artifact.file,
    sourceSha256: artifact.sourceSha256,
    manifestSha256: ARCHIVE_MANIFEST_SHA256,
    derivations: [...new Set(derivations)],
  });
  return node;
}

export function schemaDerived<T extends object>(shape: string, node: T): T {
  if (!(SCHEMA_DERIVED_ALLOWED as readonly string[]).includes(shape)) {
    throw new Error(`schema-derived fixture for ${shape} is not on SCHEMA_DERIVED_ALLOWED`);
  }
  registry.set(node, { kind: "schema-derived", shape: shape as SchemaDerivedShape });
  return node;
}

export function faultInjection<T extends object>(fault: FaultInjection, node: T): T {
  registry.set(node, { kind: "fault-injection", fault });
  return node;
}

/** Validate one tag: archived tags must still match the archive and the pinned document. */
export function provenanceProblem(p: FixtureProvenance | undefined): string | null {
  if (!p) return "untagged Shopify response fixture";
  if (p.kind === "schema-derived") {
    return (SCHEMA_DERIVED_ALLOWED as readonly string[]).includes(p.shape) ? null : `schema-derived ${p.shape} not allowlisted`;
  }
  if (p.kind === "fault-injection") {
    return (FAULT_INJECTIONS as readonly string[]).includes(p.fault) ? null : `unknown fault injection ${p.fault}`;
  }
  if (p.evidenceRunId !== EVIDENCE_RUN_ID) return `unknown evidence run ${p.evidenceRunId}`;
  if (p.documentSha256 !== pinnedDocumentSha256(p.documentName)) return `${p.sourceFile}: document no longer pinned`;
  if (p.manifestSha256 !== currentManifestSha256()) return "archive manifest changed since derivation";
  if (manifestEntries().get(p.sourceFile) !== p.sourceSha256) return `${p.sourceFile}: source hash differs from manifest`;
  return null;
}

/** True while the allowlist may still carry the agreement attribution variants. */
export const agreementVariantsPermitted = () => ATTRIBUTION_STATUS !== "CONFIRMED";

// ── archived sources ──────────────────────────────────────────────────────

const A = {
  reconcile: (purpose: string) => loadArchivedArtifact(`q-reconcile-${purpose}.json`),
  detailFive: () => loadArchivedArtifact("q-refund-detail-five_ids.json"),
  detailSingle: () => loadArchivedArtifact("q-refund-detail-strict_single_e6.json"),
  agreements: (purpose: string) => loadArchivedArtifact(`q-agreements-${purpose}.json`),
  recheck: () => loadArchivedArtifact("q-recheck-cancelled_secondary.json"),
  appId: () => loadArchivedArtifact("q-appid-identity.json"),
};
export const ARCHIVED_SOURCES = A;

/** Archived refund ids (E2 is the shipping-only refund on a cancelled + closed order). */
export const ARCHIVED_REFUND = {
  E6: "gid://shopify/Refund/1123042787575",
  E2: "gid://shopify/Refund/1123042066679",
  E1: "gid://shopify/Refund/1122917253367",
  ZERO_RESTOCK_1104: "gid://shopify/Refund/1120895828215",
  MONETARY_1099: "gid://shopify/Refund/1120894320887",
} as const;

/** Shopify prints decimals without trailing zeros beyond one place ("8.0", "0.4"). */
export const shopifyDecimal = (amount: string): string => {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error(`not a decimal: ${amount}`);
  const [int, frac = ""] = amount.split(".");
  const trimmed = frac.replace(/0+$/, "");
  return `${int}.${trimmed === "" ? "0" : trimmed}`;
};
/** Shopify DateTime: second precision, Z suffix. */
export const shopifyDateTime = (iso: string) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");

const setMoney = (bag: any, amount: string | undefined, d: Derivation[]) => {
  if (amount === undefined) return;
  const v = shopifyDecimal(amount);
  if (bag.presentmentMoney.amount !== v) {
    bag.presentmentMoney.amount = v;
    d.push("set:amount");
  }
};

// ── archived-derived builders (Q-RECONCILE / Q-REFUND-DETAIL / Q-AGREEMENTS / Q-APPID) ──

type TxnKind = "AUTHORIZATION" | "CAPTURE" | "REFUND";

/** A transaction element from the E2 Q-RECONCILE archive (bogus gateway, test). */
export function archivedTransaction(
  kind: TxnKind,
  over: { id: string; parentId: string | null; amount?: string; status?: string },
): Record<string, any> {
  const art = A.reconcile("e2_cancelled_refund");
  const src = (art.body.response.order.transactions as any[]).find((t) => t.kind === kind);
  if (!src) throw new Error(`no archived ${kind} transaction`);
  const t = clone(src);
  const d: Derivation[] = ["rebind:transaction-id"];
  t.id = over.id;
  t.parentTransaction = over.parentId === null ? null : { id: over.parentId };
  setMoney(t.amountSet, over.amount, d);
  const status = over.status ?? "SUCCESS";
  if (status !== t.status) {
    t.status = status;
    return schemaDerived(`transaction-status:${status}`, t);
  }
  return archived(art, t, d);
}

/** A Refund element of Q-RECONCILE's refunds list (E2 archive shape). */
export function archivedListRefund(over: {
  id: string;
  note: string | null;
  createdAt: string;
  processedAt: string;
  amount?: string;
}): Record<string, any> {
  const art = A.reconcile("e2_cancelled_refund");
  const r = clone(art.body.response.order.refunds[0]);
  const d: Derivation[] = ["rebind:refund-id", "rebind:note", "rebind:timestamps"];
  r.id = over.id;
  r.note = over.note;
  r.createdAt = shopifyDateTime(over.createdAt);
  r.processedAt = shopifyDateTime(over.processedAt);
  setMoney(r.totalRefundedSet, over.amount, d);
  return archived(art, r, d);
}

/** The Q-RECONCILE order node: the MergeShip-cancelled BASE secondary while no
 *  refund is listed, the cancelled + closed + refunded E2 order otherwise. */
export function archivedReconcileOrder(over: {
  id: string;
  refunds: readonly Record<string, any>[];
  transactions: readonly Record<string, any>[];
  totalRefunded?: string;
  totalRefundedShipping?: string;
}): Record<string, any> {
  const art = A.reconcile(over.refunds.length === 0 ? "base_cancelled" : "e2_cancelled_refund");
  const o = clone(art.body.response.order);
  const d: Derivation[] = ["rebind:order-id", "set:refunds", "set:transactions"];
  o.id = over.id;
  o.refunds = [...over.refunds];
  o.transactions = [...over.transactions];
  setMoney(o.totalRefundedSet, over.totalRefunded ?? "0.0", d);
  setMoney(o.totalRefundedShippingSet, over.totalRefundedShipping ?? "0.0", d);
  return archived(art, o, d);
}

/** A Q-REFUND-DETAIL node (the archived E2 shipping-only refund). */
export function archivedDetailNode(over: {
  id: string;
  orderId: string;
  note: string | null;
  createdAt: string | null;
  processedAt: string | null;
  total?: string;
  shipping?: readonly { subtotal: string; tax: string }[];
  transactions?: readonly Record<string, any>[];
}): Record<string, any> {
  const art = A.detailFive();
  const n = clone((art.body.response.nodes as any[]).find((x) => x.id === ARCHIVED_REFUND.E2));
  const d: Derivation[] = ["rebind:refund-id", "rebind:order-id", "rebind:note", "rebind:timestamps"];
  n.id = over.id;
  n.order = { id: over.orderId };
  n.note = over.note;
  n.createdAt = over.createdAt === null ? null : shopifyDateTime(over.createdAt);
  n.processedAt = over.processedAt === null ? null : shopifyDateTime(over.processedAt);
  setMoney(n.totalRefundedSet, over.total, d);
  if (over.shipping) {
    const line = n.refundShippingLines.nodes[0];
    n.refundShippingLines.nodes = over.shipping.map((s) => {
      const l = clone(line);
      setMoney(l.subtotalAmountSet, s.subtotal, d);
      setMoney(l.taxAmountSet, s.tax, d);
      return l;
    });
  } else if (over.total !== undefined) {
    setMoney(n.refundShippingLines.nodes[0].subtotalAmountSet, over.total, d);
  }
  if (over.transactions) {
    n.transactions.nodes = [...over.transactions];
    d.push("set:transactions");
  }
  return archived(art, n, d);
}

/** The RefundAgreement node of the archived E2 agreement page, rebound to a fixture refund. */
export function archivedRefundAgreement(over: {
  id: string;
  appId: string;
  refundId: string;
  happenedAt: string;
}): Record<string, any> {
  const art = A.agreements("pos_e2");
  const src = (art.body.agreementNodes as any[]).find((a) => a.__typename === "RefundAgreement");
  const a = clone(src);
  a.id = over.id;
  a.app = { id: over.appId };
  a.refund = { id: over.refundId };
  a.happenedAt = shopifyDateTime(over.happenedAt);
  return archived(art, a, ["rebind:agreement-id", "rebind:app-id", "rebind:refund-id", "rebind:timestamps"]);
}

/** The order's own OrderAgreement (archived verbatim) — every real agreement list carries one. */
export function archivedOrderAgreement(): Record<string, any> {
  const art = A.agreements("pos_e2");
  const src = (art.body.agreementNodes as any[]).find((a) => a.__typename === "OrderAgreement");
  return archived(art, clone(src), []);
}

/** A complete final page's pageInfo as Shopify returned it. */
export function archivedCompletePageInfo(): Record<string, any> {
  const art = A.agreements("pos_e2");
  return archived(art, clone(art.body.rawPages[0].response.order.agreements.pageInfo), []);
}

/** Q-APPID payload, rebound to the fixture app id. */
export function archivedAppIdentity(appId: string): Record<string, any> {
  const art = A.appId();
  const install = clone(art.body.response.currentAppInstallation);
  install.app.id = appId;
  return archived(art, install, ["rebind:app-id"]);
}

// ── schema-derived attribution variants (allowlisted while not CONFIRMED) ──

export function agreementVariant(
  variant: "foreign-app" | "duplicate-link" | "other-refund-link",
  over: { id: string; appId: string | null; refundId: string; happenedAt: string },
): Record<string, any> {
  if (!agreementVariantsPermitted()) throw new Error("agreement variants are not allowlisted once G-AGREEMENT is CONFIRMED");
  return schemaDerived(`agreement-attribution:${variant}`, {
    __typename: "RefundAgreement",
    id: over.id,
    happenedAt: shopifyDateTime(over.happenedAt),
    reason: "REFUND",
    app: over.appId === null ? null : { id: over.appId },
    refund: { id: over.refundId },
  });
}

export function incompletePageInfo(endCursor: string): Record<string, any> {
  return schemaDerived("agreement-attribution:incomplete-page", { hasNextPage: true, endCursor });
}

// ── served-response ledger ────────────────────────────────────────────────

export interface LedgerEntry {
  readonly role: string;
  readonly problem: string | null;
}

/**
 * Walk one served `data` payload of a pinned document and check every
 * Shopify response node it carries. Returns one entry per node.
 */
export function auditServedPayload(query: string, payload: any): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  const check = (role: string, node: unknown) => out.push({ role, problem: provenanceProblem(provenanceOf(node)) });
  if (query.includes("ShippingRefundAppIdentity")) {
    check("app-identity", payload?.currentAppInstallation);
  } else if (query.includes("ShippingRefundDetail")) {
    for (const n of payload?.nodes ?? []) {
      check("refund-detail", n);
      for (const t of n?.transactions?.nodes ?? []) check("refund-detail.transaction", t);
    }
  } else if (query.includes("ShippingRefundAgreements")) {
    for (const n of payload?.order?.agreements?.nodes ?? []) check("agreement", n);
    check("agreement-page-info", payload?.order?.agreements?.pageInfo);
  } else if (query.includes("ShippingRefundReconcile")) {
    check("order", payload?.order);
    for (const r of payload?.order?.refunds ?? []) check("order.refund", r);
    for (const t of payload?.order?.transactions ?? []) check("order.transaction", t);
  } else {
    out.push({ role: "unknown-document", problem: "payload for an unpinned document" });
  }
  return out;
}
