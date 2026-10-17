// Mocked/static tests for the S1-A trigger manifest and migration agreement
// (spec 5.4.7, 19.3, 20.1). No database is touched: catalog rows are injected
// fixtures, and the migration file is verified as text. The real-PostgreSQL
// behavior proofs live in tests/shipping-refund-schema-pg.test.ts, which only
// runs inside the separately authorized disposable-database suite.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  SHIPPING_REFUND_TRIGGER_MANIFEST,
  TRIGGER_CATALOG_SQL,
  checkTriggerIntegrity,
  compareTriggerCatalog,
  decodeTriggerType,
  expectedCatalogRow,
  type ShippingRefundTriggerCatalogRow,
} from "../app/lib/shipping-refund-trigger-manifest";

const REPO_ROOT = join(__dirname, "..");
const MIGRATION_PATH = join(
  REPO_ROOT,
  "prisma/migrations/20261021000000_shipping_v0_phase_2_s1a/migration.sql",
);
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf8");
const PARSED_TRIGGERS = parseCreateTriggers(MIGRATION_SQL);

// ── Catalog fixtures ──

function catalogFromManifest(): ShippingRefundTriggerCatalogRow[] {
  return SHIPPING_REFUND_TRIGGER_MANIFEST.map((e) => expectedCatalogRow(e));
}

function rowsFor(name: string): ShippingRefundTriggerCatalogRow {
  const entry = SHIPPING_REFUND_TRIGGER_MANIFEST.find((e) => e.name === name);
  if (!entry) throw new Error(`no manifest entry ${name}`);
  return expectedCatalogRow(entry);
}

function verdictCodes(verdict: { reasons: readonly { code: string }[] }): string[] {
  return verdict.reasons.map((r) => r.code);
}

// ── Migration text parsing ──

interface ParsedTrigger {
  name: string;
  timing: string;
  events: string[];
  table: string;
  level: string;
  functionSchema: string;
  functionName: string;
  args: string;
  when: string | null;
}

function parseCreateTriggers(sql: string): ParsedTrigger[] {
  const re =
    /CREATE TRIGGER\s+([a-z_]+)\s+(BEFORE|AFTER|INSTEAD OF)\s+((?:INSERT|UPDATE|DELETE|TRUNCATE)(?:\s+OR\s+(?:INSERT|UPDATE|DELETE|TRUNCATE))*)\s+ON\s+"?([A-Za-z]+)"?\s+FOR\s+EACH\s+(ROW|STATEMENT)\s+(WHEN\s*\([^;]*?\)\s+)?EXECUTE\s+FUNCTION\s+(?:([a-z_]+)\.)?([a-z_]+)\s*\(([^)]*)\)\s*;/g;
  const out: ParsedTrigger[] = [];
  for (const m of sql.matchAll(re)) {
    out.push({
      name: m[1],
      timing: m[2],
      events: m[3].split(/\s+OR\s+/),
      table: m[4],
      level: m[5],
      when: m[6]?.trim() ?? null,
      functionSchema: m[7] ?? "public",
      functionName: m[8],
      args: m[9].trim(),
    });
  }
  return out;
}

function extractFunctionBody(sql: string, fnName: string): string {
  const marker = `CREATE FUNCTION ${fnName}(`;
  const start = sql.indexOf(marker);
  if (start < 0) throw new Error(`function ${fnName} not found in migration`);
  const end = sql.indexOf("$fn$;", start);
  if (end < 0) throw new Error(`function ${fnName} body not terminated`);
  return sql.slice(start, end);
}

// ── 1. Manifest exactness (20.1) ──

describe("manifest", () => {
  it("contains exactly the ten canonical triggers", () => {
    expect(SHIPPING_REFUND_TRIGGER_MANIFEST.map((e) => e.name)).toEqual([
      "shippingrefund_insert_guard",
      "shippingrefund_transition_guard",
      "shippingrefund_frozen_columns_guard",
      "shippingrefund_shape_guard",
      "shippingrefund_evidence_integrity_guard",
      "shippingrefund_no_delete",
      "shippingrefund_no_truncate",
      "shippingrefund_event_writer",
      "shippingrefundevent_no_update_delete",
      "shippingrefundevent_no_truncate",
    ]);
  });

  it("prescribes the exact table, timing, events, level and function per entry", () => {
    const byName = new Map(SHIPPING_REFUND_TRIGGER_MANIFEST.map((e) => [e.name, e]));
    expect(byName.get("shippingrefund_insert_guard")).toMatchObject({
      schema: "public", table: "ShippingRefund", timing: "BEFORE",
      events: ["INSERT"], level: "ROW",
      functionSchema: "public", functionName: "shipping_refund_fn_insert_guard",
    });
    expect(byName.get("shippingrefund_transition_guard")).toMatchObject({
      table: "ShippingRefund", timing: "BEFORE", events: ["UPDATE"], level: "ROW",
      functionName: "shipping_refund_fn_transition_guard",
    });
    expect(byName.get("shippingrefund_frozen_columns_guard")).toMatchObject({
      table: "ShippingRefund", timing: "BEFORE", events: ["UPDATE"], level: "ROW",
      functionName: "shipping_refund_fn_frozen_columns_guard",
    });
    expect(byName.get("shippingrefund_shape_guard")).toMatchObject({
      table: "ShippingRefund", timing: "BEFORE", events: ["INSERT", "UPDATE"], level: "ROW",
      functionName: "shipping_refund_fn_shape_guard",
    });
    expect(byName.get("shippingrefund_evidence_integrity_guard")).toMatchObject({
      table: "ShippingRefund", timing: "BEFORE", events: ["UPDATE"], level: "ROW",
      functionName: "shipping_refund_fn_evidence_integrity_guard",
    });
    expect(byName.get("shippingrefund_no_delete")).toMatchObject({
      table: "ShippingRefund", timing: "BEFORE", events: ["DELETE"], level: "ROW",
      functionName: "shipping_refund_fn_always_raise",
    });
    expect(byName.get("shippingrefund_no_truncate")).toMatchObject({
      table: "ShippingRefund", timing: "BEFORE", events: ["TRUNCATE"], level: "STATEMENT",
      functionName: "shipping_refund_fn_always_raise",
    });
    expect(byName.get("shippingrefund_event_writer")).toMatchObject({
      table: "ShippingRefund", timing: "AFTER", events: ["INSERT", "UPDATE"], level: "ROW",
      functionName: "shipping_refund_fn_event_writer",
    });
    expect(byName.get("shippingrefundevent_no_update_delete")).toMatchObject({
      table: "ShippingRefundEvent", timing: "BEFORE", events: ["UPDATE", "DELETE"], level: "ROW",
      functionName: "shipping_refund_fn_always_raise",
    });
    expect(byName.get("shippingrefundevent_no_truncate")).toMatchObject({
      table: "ShippingRefundEvent", timing: "BEFORE", events: ["TRUNCATE"], level: "STATEMENT",
      functionName: "shipping_refund_fn_always_raise",
    });
  });

  it("uses a distinct evidence-integrity function independent of the transition function", () => {
    const transition = SHIPPING_REFUND_TRIGGER_MANIFEST.find((e) => e.name === "shippingrefund_transition_guard")!;
    const evidence = SHIPPING_REFUND_TRIGGER_MANIFEST.find((e) => e.name === "shippingrefund_evidence_integrity_guard")!;
    expect(evidence.functionName).not.toBe(transition.functionName);
  });

  it("restricts the catalog query to exactly the two journal tables and the session role read", () => {
    expect(TRIGGER_CATALOG_SQL).toContain('public."ShippingRefund"');
    expect(TRIGGER_CATALOG_SQL).toContain('public."ShippingRefundEvent"');
    expect(TRIGGER_CATALOG_SQL).toContain("current_setting('session_replication_role')");
    expect(TRIGGER_CATALOG_SQL).toMatch(/NOT t\.tgisinternal/);
    // Read-only: the query is a single SELECT with no mutation statement.
    expect(TRIGGER_CATALOG_SQL.trim()).toMatch(/^SELECT\b/i);
    expect(TRIGGER_CATALOG_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|SET)\s+/i);
  });
});

// ── 2. tgtype decoding ──

describe("decodeTriggerType", () => {
  it("decodes each manifest entry's catalog type back to its definition", () => {
    for (const entry of SHIPPING_REFUND_TRIGGER_MANIFEST) {
      const row = expectedCatalogRow(entry);
      const decoded = decodeTriggerType(row.tgtype);
      expect(decoded.timing).toBe(entry.timing);
      expect(decoded.level).toBe(entry.level);
      expect([...decoded.events].sort()).toEqual([...entry.events].sort());
    }
  });

  it("decodes INSTEAD OF as a timing variant", () => {
    // INSTEAD_OF(1<<6) | ROW(1) | INSERT(4)
    expect(decodeTriggerType(0b1000101).timing).toBe("INSTEAD_OF");
  });

  it("rejects malformed and eventless tgtype values", () => {
    expect(() => decodeTriggerType(-1)).toThrow();
    expect(() => decodeTriggerType(1.5)).toThrow();
    expect(() => decodeTriggerType(0b10000000)).toThrow();
    expect(() => decodeTriggerType(1)).toThrow(); // ROW bit, no event bits
  });
});

// ── 3. compareTriggerCatalog ──

describe("compareTriggerCatalog", () => {
  it("accepts the exact manifest catalog in any order", () => {
    const rows = catalogFromManifest().reverse();
    expect(compareTriggerCatalog(SHIPPING_REFUND_TRIGGER_MANIFEST, rows, "origin")).toEqual({
      intact: true,
      reasons: [],
    });
  });

  it.each(SHIPPING_REFUND_TRIGGER_MANIFEST.map((e) => [e.name] as const))(
    "reports MISSING when %s is absent",
    (name) => {
      const rows = catalogFromManifest().filter((r) => r.triggerName !== name);
      const v = compareTriggerCatalog(SHIPPING_REFUND_TRIGGER_MANIFEST, rows, "origin");
      expect(v.intact).toBe(false);
      const miss = v.reasons.filter((r) => r.code === "MISSING");
      expect(miss).toHaveLength(1);
      expect(miss[0].trigger).toBe(name);
    },
  );

  it.each(["D", "R", "A"] as const)("reports DISABLED(%s) when a trigger is not 'O'", (tgenabled) => {
    const rows = catalogFromManifest().map((r) =>
      r.triggerName === "shippingrefund_no_delete" ? { ...r, tgenabled } : r,
    );
    const v = compareTriggerCatalog(SHIPPING_REFUND_TRIGGER_MANIFEST, rows, "origin");
    expect(v.intact).toBe(false);
    const reason = v.reasons.find((r) => r.code === "DISABLED");
    expect(reason?.trigger).toBe("shippingrefund_no_delete");
    expect(reason?.detail).toContain(`DISABLED(${tgenabled})`);
  });

  it.each(["replica", "local"] as const)("fails closed on session_replication_role=%s", (role) => {
    const rows = catalogFromManifest();
    const v = compareTriggerCatalog(SHIPPING_REFUND_TRIGGER_MANIFEST, rows, role);
    expect(v.intact).toBe(false);
    expect(verdictCodes(v)).toContain("NON_ORIGIN_ROLE");
  });

  it("reports CATALOG_ERROR for malformed rows and null required fields", () => {
    const base = catalogFromManifest();
    const malformed: ShippingRefundTriggerCatalogRow[] = base.map((r, i) =>
      i === 0 ? ({ ...r, tgtype: null } as unknown as ShippingRefundTriggerCatalogRow) : r,
    );
    let v = compareTriggerCatalog(SHIPPING_REFUND_TRIGGER_MANIFEST, malformed, "origin");
    expect(v.intact).toBe(false);
    expect(verdictCodes(v)).toContain("CATALOG_ERROR");

    const nullField = base.map((r, i) =>
      i === 1 ? ({ ...r, functionName: null } as unknown as ShippingRefundTriggerCatalogRow) : r,
    );
    v = compareTriggerCatalog(SHIPPING_REFUND_TRIGGER_MANIFEST, nullField, "origin");
    expect(verdictCodes(v)).toContain("CATALOG_ERROR");
  });

  it("reports DUPLICATE for a repeated catalog row", () => {
    const rows = [...catalogFromManifest(), rowsFor("shippingrefund_insert_guard")];
    const v = compareTriggerCatalog(SHIPPING_REFUND_TRIGGER_MANIFEST, rows, "origin");
    expect(v.intact).toBe(false);
    expect(verdictCodes(v)).toContain("DUPLICATE");
  });

  it("fails closed on unexpected triggers, even disabled or harmless-looking ones", () => {
    const extra = (over: Partial<ShippingRefundTriggerCatalogRow>): ShippingRefundTriggerCatalogRow => ({
      triggerName: "rogue_trigger",
      tableSchema: "public",
      tableName: "ShippingRefund",
      tgtype: 0b0010111, // BEFORE UPDATE ROW — a plausible-looking default
      tgenabled: "O",
      functionSchema: "public",
      functionName: "some_fn",
      isInternal: false,
      hasWhenClause: false,
      hasColumnList: false,
      argCount: 0,
      isConstraint: false,
      deferrable: false,
      initdeferred: false,
      sessionReplicationRole: "origin",
      ...over,
    });
    const variants: ShippingRefundTriggerCatalogRow[] = [
      extra({}),
      extra({ tgenabled: "D" }), // disabled
      extra({ tgtype: 0b0000101 }), // AFTER INSERT ROW
      extra({ tgtype: 0b0100000, tableName: "ShippingRefundEvent" }), // TRUNCATE stmt on event table
      extra({ triggerName: "shippingrefund_transition_guard", tableName: "ShippingRefundEvent" }),
    ];
    for (const rogue of variants) {
      const v = compareTriggerCatalog(
        SHIPPING_REFUND_TRIGGER_MANIFEST,
        [...catalogFromManifest(), rogue],
        "origin",
      );
      expect(v.intact).toBe(false);
      expect(verdictCodes(v)).toContain("UNEXPECTED");
    }
  });

  it("never matches a same-named trigger across tables", () => {
    // Move the transition guard row onto the event table: entry goes missing
    // AND the stray row is unexpected.
    const rows = catalogFromManifest().map((r) =>
      r.triggerName === "shippingrefund_transition_guard"
        ? { ...r, tableName: "ShippingRefundEvent" }
        : r,
    );
    const v = compareTriggerCatalog(SHIPPING_REFUND_TRIGGER_MANIFEST, rows, "origin");
    expect(v.intact).toBe(false);
    expect(verdictCodes(v)).toContain("WRONG_TABLE_OR_SCHEMA");
    expect(verdictCodes(v)).toContain("UNEXPECTED");
  });

  it("reports WRONG_TIMING when BEFORE becomes AFTER", () => {
    const rows = catalogFromManifest().map((r) =>
      r.triggerName === "shippingrefund_no_delete" ? { ...r, tgtype: 0b0001001 } : r, // AFTER DELETE ROW
    );
    const v = compareTriggerCatalog(SHIPPING_REFUND_TRIGGER_MANIFEST, rows, "origin");
    expect(v.intact).toBe(false);
    const r = v.reasons.find((x) => x.trigger === "shippingrefund_no_delete");
    expect(r?.code).toBe("WRONG_TIMING");
  });

  it("reports WRONG_EVENTS when an event is added or removed", () => {
    const rows = catalogFromManifest().map((r) =>
      r.triggerName === "shippingrefund_transition_guard"
        ? { ...r, tgtype: 0b0011111 } // BEFORE INSERT OR UPDATE OR DELETE ROW
        : r,
    );
    const v = compareTriggerCatalog(SHIPPING_REFUND_TRIGGER_MANIFEST, rows, "origin");
    const r = v.reasons.find((x) => x.trigger === "shippingrefund_transition_guard");
    expect(r?.code).toBe("WRONG_EVENTS");
  });

  it("reports WRONG_LEVEL when ROW becomes STATEMENT", () => {
    const rows = catalogFromManifest().map((r) =>
      r.triggerName === "shippingrefund_no_delete" ? { ...r, tgtype: 0b0001010 } : r, // BEFORE DELETE STATEMENT
    );
    const v = compareTriggerCatalog(SHIPPING_REFUND_TRIGGER_MANIFEST, rows, "origin");
    const r = v.reasons.find((x) => x.trigger === "shippingrefund_no_delete");
    expect(r?.code).toBe("WRONG_LEVEL");
  });

  it("reports WRONG_FUNCTION for a renamed or differently schemed function", () => {
    for (const over of [
      { functionName: "shipping_refund_fn_insert_guard_v2" },
      { functionSchema: "extensions" },
    ] as const) {
      const rows = catalogFromManifest().map((r) =>
        r.triggerName === "shippingrefund_insert_guard" ? { ...r, ...over } : r,
      );
      const v = compareTriggerCatalog(SHIPPING_REFUND_TRIGGER_MANIFEST, rows, "origin");
      const r = v.reasons.find((x) => x.trigger === "shippingrefund_insert_guard");
      expect(r?.code).toBe("WRONG_FUNCTION");
    }
  });

  it("reports WRONG_MODIFIERS for WHEN, UPDATE OF, args, constraint or deferrable metadata", () => {
    for (const over of [
      { hasWhenClause: true },
      { hasColumnList: true },
      { argCount: 1 },
      { isConstraint: true },
      { deferrable: true },
      { initdeferred: true },
    ] as const) {
      const rows = catalogFromManifest().map((r) =>
        r.triggerName === "shippingrefund_shape_guard" ? { ...r, ...over } : r,
      );
      const v = compareTriggerCatalog(SHIPPING_REFUND_TRIGGER_MANIFEST, rows, "origin");
      const r = v.reasons.find((x) => x.trigger === "shippingrefund_shape_guard");
      expect(r?.code).toBe("WRONG_MODIFIERS");
    }
  });

  it("does not count an internal trigger as a match", () => {
    const rows = catalogFromManifest().map((r) =>
      r.triggerName === "shippingrefund_insert_guard" ? { ...r, isInternal: true } : r,
    );
    const v = compareTriggerCatalog(SHIPPING_REFUND_TRIGGER_MANIFEST, rows, "origin");
    expect(v.intact).toBe(false);
    const r = v.reasons.find((x) => x.trigger === "shippingrefund_insert_guard");
    expect(r?.code).toBe("MISSING");
    // ...and the internal row is not flagged UNEXPECTED (it never reaches the
    // real query; an injected one is simply not a match).
    expect(verdictCodes(v)).not.toContain("UNEXPECTED");
  });
});

// ── 4. checkTriggerIntegrity with an injected read-only query ──

describe("checkTriggerIntegrity", () => {
  it("returns intact for a perfect catalog", async () => {
    const v = await checkTriggerIntegrity(async () => catalogFromManifest());
    expect(v.intact).toBe(true);
  });

  it("fails closed when the catalog query throws or times out", async () => {
    const v = await checkTriggerIntegrity(async () => {
      throw new Error("timeout");
    });
    expect(v.intact).toBe(false);
    expect(verdictCodes(v)).toEqual(["CATALOG_ERROR"]);
  });

  it("fails closed on an empty or malformed catalog result", async () => {
    for (const result of [[], null, 42, "x"]) {
      const v = await checkTriggerIntegrity(
        async () => result as unknown as ShippingRefundTriggerCatalogRow[],
      );
      expect(v.intact).toBe(false);
      expect(v.reasons.length).toBeGreaterThan(0);
    }
  });

  it("fails closed when the replication role field is absent or inconsistent", async () => {
    const stripped = catalogFromManifest().map((r) => {
      const { sessionReplicationRole: _omit, ...rest } = r;
      return rest as ShippingRefundTriggerCatalogRow;
    });
    expect((await checkTriggerIntegrity(async () => stripped)).intact).toBe(false);
    const inconsistent = catalogFromManifest().map((r, i) =>
      i === 0 ? { ...r, sessionReplicationRole: "replica" } : r,
    );
    expect((await checkTriggerIntegrity(async () => inconsistent)).intact).toBe(false);
  });
});

// ── 5. Migration SQL versus manifest agreement (20.1, 5.4.7) ──

describe("migration SQL", () => {
  const parsed = PARSED_TRIGGERS;

  it("defines exactly the ten manifest triggers, same names and definitions", () => {
    expect(parsed.map((t) => t.name).sort()).toEqual(
      SHIPPING_REFUND_TRIGGER_MANIFEST.map((e) => e.name).slice().sort(),
    );
    for (const entry of SHIPPING_REFUND_TRIGGER_MANIFEST) {
      const t = parsed.find((p) => p.name === entry.name);
      expect(t, entry.name).toBeDefined();
      expect(t!.table).toBe(entry.table);
      expect(t!.timing).toBe(entry.timing);
      expect([...t!.events].sort()).toEqual([...entry.events].sort());
      expect(t!.level).toBe(entry.level);
      expect(t!.functionSchema).toBe(entry.functionSchema);
      expect(t!.functionName).toBe(entry.functionName);
      expect(t!.when).toBeNull();
      expect(t!.args).toBe("");
    }
  });

  it("defines every manifest function and no unmanifested trigger", () => {
    for (const entry of SHIPPING_REFUND_TRIGGER_MANIFEST) {
      expect(MIGRATION_SQL).toContain(`CREATE FUNCTION ${entry.functionName}(`);
    }
    expect(parsed).toHaveLength(SHIPPING_REFUND_TRIGGER_MANIFEST.length);
    expect(MIGRATION_SQL).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?(CONSTRAINT\s+)?TRIGGER\b(?!\s+shippingrefund)/i);
  });

  it("uses no WHEN clause, UPDATE OF list, constraint trigger or arguments", () => {
    expect(MIGRATION_SQL).not.toMatch(/UPDATE OF/i);
    expect(MIGRATION_SQL).not.toMatch(/CONSTRAINT TRIGGER/i);
    expect(MIGRATION_SQL).not.toMatch(/\bDEFERRABLE\b/i);
    for (const t of parsed) {
      expect(t.when).toBeNull();
      expect(t.args).toBe("");
    }
  });
});

// ── 6. S1 transition graph in the migration (6.1/6.2, 19.3, I27) ──

describe("S1 transition graph (migration text)", () => {
  const transitionBody = extractFunctionBody(MIGRATION_SQL, "shipping_refund_fn_transition_guard");
  const insertBody = extractFunctionBody(MIGRATION_SQL, "shipping_refund_fn_insert_guard");
  const evidenceBody = extractFunctionBody(
    MIGRATION_SQL,
    "shipping_refund_fn_evidence_integrity_guard",
  );

  it("the transition graph has no edge INTO DISPATCHING", () => {
    // Exit edges from DISPATCHING exist (DISPATCHING -> REFUND_RECORDED,
    // DISPATCHING -> IN_DOUBT); nothing may enter it in S1 (I27).
    expect(transitionBody).not.toMatch(/NEW\."status"\s*=\s*'DISPATCHING'/);
    expect(transitionBody).not.toMatch(/NEW\."status" IN \([^)]*DISPATCHING/);
  });

  it("admits exactly the S1 edges", () => {
    const edgeRe = /IF OLD\."status" = '([A-Z_]+)' AND NEW\."status" (?:= '([A-Z_]+)'|IN \(([^)]*)\))(?: AND OLD\."lane" = '([A-Z]+)')? THEN RETURN NEW;/g;
    const edges: string[] = [];
    for (const m of transitionBody.matchAll(edgeRe)) {
      const targets = m[2] ? [m[2]] : m[3].replace(/'/g, "").split(",");
      for (const t of targets) edges.push(`${m[1]}->${t}${m[4] ? `[${m[4]}]` : ""}`);
    }
    expect(edges.sort()).toEqual([
      "DISPATCHING->IN_DOUBT",
      "DISPATCHING->REFUND_RECORDED",
      "IN_DOUBT->REFUND_RECORDED",
      "IN_DOUBT->REVIEW_REQUIRED",
      "PREPARED->ABORTED",
      "PREPARED->REVIEW_REQUIRED",
      "QUEUED->ABORTED",
      "QUEUED->INELIGIBLE",
      "QUEUED->OBSERVED[OBSERVE]",
      "QUEUED->PREPARED[EXECUTE]",
      "QUEUED->REVIEW_REQUIRED",
      "QUEUED->SKIPPED",
      "REFUND_RECORDED->REVIEW_REQUIRED",
      "REFUND_RECORDED->VERIFIED",
      "REVIEW_REQUIRED->RESOLVED",
    ].sort());
  });

  it("treats every terminal status as fully immutable", () => {
    expect(transitionBody).toContain(
      "OLD.\"status\" IN ('OBSERVED','SKIPPED','INELIGIBLE','ABORTED','VERIFIED','RESOLVED')",
    );
  });

  it("insert guard admits only the claim statuses", () => {
    expect(insertBody).toContain(
      "NEW.\"status\" NOT IN ('QUEUED','SKIPPED','INELIGIBLE','REVIEW_REQUIRED')",
    );
    expect(insertBody).not.toContain("PREPARED' THEN RETURN");
  });

  it("evidence function names PREPARED -> DISPATCHING only as the evidence gate", () => {
    // It is the one legitimate mention: first-stamping dispatch evidence.
    expect(evidenceBody).toContain("NEW.\"status\" = 'DISPATCHING'");
    expect(evidenceBody).toContain("OLD.\"status\" = 'PREPARED'");
  });

  it("sourceCancelledAt immutability uses NULL-safe IS DISTINCT FROM", () => {
    const frozen = extractFunctionBody(MIGRATION_SQL, "shipping_refund_fn_frozen_columns_guard");
    expect(frozen).toContain('NEW."sourceCancelledAt" IS DISTINCT FROM OLD."sourceCancelledAt"');
    expect(frozen).not.toMatch(/sourceCancelledAt"?\s*<>\s*OLD/);
    expect(frozen).not.toMatch(/sourceCancelledAt"?\s*=\s*OLD/);
  });

  it("keeps the event journal append-only: no delete/update/truncate escape", () => {
    expect(MIGRATION_SQL).toContain("shipping_refund_fn_always_raise");
    for (const name of [
      "shippingrefund_no_delete",
      "shippingrefund_no_truncate",
      "shippingrefundevent_no_update_delete",
      "shippingrefundevent_no_truncate",
    ]) {
      expect(PARSED_TRIGGERS.find((t) => t.name === name)?.functionName).toBe(
        "shipping_refund_fn_always_raise",
      );
    }
  });
});

// ── 7. Forbidden trigger-bypass and dispatch paths (3.2 rules 7-11, 19.2) ──

function* walk(dir: string, exts: readonly string[]): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      yield* walk(p, exts);
    } else if (exts.some((e) => p.endsWith(e))) {
      yield p;
    }
  }
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .replace(/\/\/[^\n]*/g, "");
}

describe("forbidden trigger bypass (spec 3.2 rules 7-11)", () => {
  // The catalog role token is assembled so this test file does not itself
  // contain the forbidden mutation-form tokens as contiguous text.
  const ROLE = ["session", "replication", "role"].join("_");
  const mutationForms: RegExp[] = [
    new RegExp(`\\bSET\\s+(LOCAL\\s+|SESSION\\s+)?${ROLE}\\b`, "i"),
    new RegExp(`set_config\\s*\\(\\s*'${ROLE}'`, "i"),
    new RegExp(`\\bRESET\\s+${ROLE}\\b`, "i"),
    new RegExp(`\\bALTER\\s+(SYSTEM|ROLE|DATABASE)[^;]*${ROLE}`, "i"),
    new RegExp(`-c\\s*${ROLE}`, "i"),
    /\bPGOPTIONS\b/i,
    /\b(DISABLE|ENABLE)\s+TRIGGER\b/i,
    /\bDISABLE\s+TRIGGER\s+ALL\b/i,
  ];

  const allowlisted = new Set([
    "app/lib/shipping-refund-trigger-manifest.ts", // the read-only catalog query
    "tests/shipping-refund-trigger-manifest.test.ts", // may name the setting to assert on it
    "tests/shipping-refund-schema-pg.test.ts",
    "tests/helpers/shipping-refund-fixture.ts", // the only future fixture that may suspend a trigger
  ]);

  const scanRoots = ["app", "scripts", "prisma/migrations", "tests/helpers", "tests"];

  it("no non-allowlisted source mutates the replication role or toggles triggers", () => {
    const offenders: string[] = [];
    for (const root of scanRoots) {
      const abs = join(REPO_ROOT, root);
      let files: string[] = [];
      try {
        files = [...walk(abs, [".ts", ".tsx", ".sql"])];
      } catch {
        continue;
      }
      for (const f of files) {
        const rel = relative(REPO_ROOT, f).split("\\").join("/");
        if (allowlisted.has(rel)) continue;
        const text = stripComments(readFileSync(f, "utf8"));
        for (const re of mutationForms) {
          if (re.test(text)) offenders.push(`${rel}: ${re.source}`);
        }
        // Even the read form is only allowed in allowlisted files.
        if (text.includes(ROLE)) offenders.push(`${rel}: names ${ROLE}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("allowlisted sources contain only the read-only catalog form", () => {
    const manifestSrc = readFileSync(
      join(REPO_ROOT, "app/lib/shipping-refund-trigger-manifest.ts"),
      "utf8",
    );
    for (const re of mutationForms) {
      expect(stripComments(manifestSrc)).not.toMatch(re);
    }
    expect(manifestSrc).toContain(`current_setting('${ROLE}')`);
  });
});

describe("no dispatch path in S1-A", () => {
  it("no app/ or scripts/ source assigns a ShippingRefund status of 'DISPATCHING'", () => {
    // The existing merge protocol legitimately uses a 'DISPATCHING' literal
    // for MergeMutationAttempt.state — a different table and column. What the
    // architecture test must forbid is a STATUS assignment into DISPATCHING.
    const offenders: string[] = [];
    for (const root of ["app", "scripts"]) {
      for (const f of walk(join(REPO_ROOT, root), [".ts", ".tsx"])) {
        const text = stripComments(readFileSync(f, "utf8"));
        if (
          /\bstatus\s*[:=]\s*['"]DISPATCHING['"]/.test(text) ||
          /SET\s+"?status"?\s*=\s*'DISPATCHING'/i.test(text) ||
          /ShippingRefund[\s\S]{0,200}'DISPATCHING'/.test(text)
        ) {
          offenders.push(relative(REPO_ROOT, f));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the migration contains no UPDATE ... SET status='DISPATCHING' path", () => {
    expect(MIGRATION_SQL).not.toMatch(/SET\s+"?status"?\s*=\s*'DISPATCHING'/i);
  });

  it("no dispatcher, worker, DispatchPermit, sendRefund or Shopify mutation path exists", () => {
    const banned = /\b(DispatchPermit|sendRefund|shipping[-_]?refund[-_]?(dispatch|worker)|refundCreate|MERGESHIP_SHIPPING_REFUNDS)\b/i;
    const offenders: string[] = [];
    for (const root of ["app", "scripts", "tests/helpers"]) {
      for (const f of walk(join(REPO_ROOT, root), [".ts", ".tsx"])) {
        if (banned.test(stripComments(readFileSync(f, "utf8")))) {
          offenders.push(relative(REPO_ROOT, f));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("ShippingAdjustment is not referenced by any S1-A file", () => {
    for (const f of [MIGRATION_PATH, join(REPO_ROOT, "app/lib/shipping-refund-trigger-manifest.ts")]) {
      expect(readFileSync(f, "utf8")).not.toContain("ShippingAdjustment");
    }
  });
});

// ── 8. Control seed and defaults (4.2, 19.3) ──

describe("control defaults", () => {
  it("seeds the control singleton fully off", () => {
    expect(MIGRATION_SQL).toMatch(
      /INSERT INTO "ShippingExecuteControl"[\s\S]*?VALUES\s*\(\s*'control',\s*false,\s*NULL,\s*false,\s*NULL,\s*0/i,
    );
    expect(MIGRATION_SQL).toContain('"dispatchEnabled" BOOLEAN NOT NULL DEFAULT false');
    expect(MIGRATION_SQL).toContain('"admissionEnabled" BOOLEAN NOT NULL DEFAULT false');
  });

  it("dispatch cannot be enabled while admission is off", () => {
    expect(MIGRATION_SQL).toContain('NOT "dispatchEnabled" OR "admissionEnabled"');
    expect(MIGRATION_SQL).toContain('("admissionEnabledAt" IS NOT NULL) = "admissionEnabled"');
    expect(MIGRATION_SQL).toContain('("dispatchEnabledAt" IS NOT NULL) = "dispatchEnabled"');
  });
});
