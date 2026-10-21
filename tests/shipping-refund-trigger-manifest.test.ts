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

  it("the sourceCancelledAt terminal exception is NULL-safe (no UNKNOWN pass)", () => {
    // A bare reasonCode = '...' is NULL when reasonCode is NULL, and CHECK
    // treats UNKNOWN as pass — the CHECK must use explicit NULL handling.
    expect(MIGRATION_SQL).toContain('COALESCE("reasonCode", \'\') = \'CANCELLED_AT_INVALID\'');
    expect(MIGRATION_SQL).not.toMatch(
      /"reasonCode" = 'CANCELLED_AT_INVALID' AND "status"/,
    );
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

// ── Source-aware scanning (spec 3.2 rule 10, 19.3 item 3) ──
//
// A comment is never a source occurrence, but SQL lives inside string and
// template literals — their contents are kept VERBATIM so a `//` inside a
// URL or a `--` inside an option string can never erase text, and a comment
// can never hide a statement either. `${...}` interpolation holes collapse
// to a __dynamic__ marker (their contents are still scanned as code) so a
// dynamic trigger name can never read as a literal. Concatenated literals
// ("A" + "B") fold into the contiguous text they build at runtime.

const DYN = ["__dyna", "mic__"].join("");

function significantText(source: string, kind: "ts" | "sql"): string {
  const out: string[] = [];
  const holes: string[] = []; // "brace" | "interp" — tracks ${ } nesting
  let state: "code" | "template" = "code";
  let i = 0;
  const n = source.length;

  const skipWs = (at: number): number => {
    while (at < n && /\s/.test(source[at])) at += 1;
    return at;
  };
  // After a literal ends, `lit + lit` folds: if only whitespace, a + and
  // another literal follow, continue directly into it.
  const foldNext = (at: number): number => {
    const k = skipWs(at);
    if (source[k] !== "+") return at;
    const k2 = skipWs(k + 1);
    const q = source[k2];
    return q === "'" || q === '"' || q === "`" ? k2 : at;
  };
  // Emit string contents WITHOUT delimiters; handles backslash escapes and
  // the SQL '' doubled quote. Unterminated single-line strings end at \n.
  const emitStringContents = (at: number, quote: string): number => {
    let j = at + 1;
    while (j < n) {
      const ch = source[j];
      if (ch === "\\") {
        out.push(source.slice(j, j + 2));
        j += 2;
        continue;
      }
      if (ch === quote) {
        if (kind === "sql" && quote === "'" && source[j + 1] === "'") {
          out.push("''");
          j += 2;
          continue;
        }
        return kind === "ts" ? foldNext(j + 1) : j + 1;
      }
      if (kind === "ts" && ch === "\n") return j;
      out.push(ch);
      j += 1;
    }
    return n;
  };
  // SQL "quoted identifier" — emitted verbatim INCLUDING the quotes.
  const emitQuotedIdent = (at: number): number => {
    let j = at;
    while (j < n) {
      out.push(source[j]);
      if (source[j] === '"') {
        if (source[j + 1] === '"') {
          out.push('"');
          j += 2;
          continue;
        }
        return j + 1;
      }
      j += 1;
    }
    return n;
  };
  // PostgreSQL dollar-quoted body ($tag$ ... $tag$) — emitted verbatim:
  // function bodies are executable code and stay in the scanned text.
  const emitDollarQuoted = (at: number, tag: string): number => {
    const end = source.indexOf(tag, at + tag.length);
    if (end < 0) {
      out.push(source.slice(at + tag.length));
      return n;
    }
    out.push(source.slice(at + tag.length, end));
    return end + tag.length;
  };
  // A `/` in code is a regex literal start when the previous significant
  // token cannot end an expression; otherwise it is division and is emitted.
  const REGEX_AFTER_CHARS = "=(:,[!&|?{};+-*%~^<>";
  const REGEX_AFTER_WORDS = new Set([
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
    "throw", "else", "do", "case", "yield", "await",
  ]);
  const emitMaybeRegex = (at: number): number => {
    const trimmed = out.join("").replace(/\s+$/, "");
    const lastChar = trimmed.slice(-1);
    const lastWord = /[A-Za-z_$]+$/.exec(trimmed)?.[0] ?? "";
    const isRegex =
      lastChar === "" || REGEX_AFTER_CHARS.includes(lastChar) || REGEX_AFTER_WORDS.has(lastWord);
    if (!isRegex) {
      out.push("/");
      return at + 1;
    }
    let j = at + 1;
    let inClass = false;
    while (j < n) {
      const ch = source[j];
      if (ch === "\\") {
        out.push(source.slice(j, j + 2));
        j += 2;
        continue;
      }
      if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) {
        j += 1;
        while (j < n && /[a-z]/i.test(source[j])) j += 1; // flags
        return j;
      } else if (ch === "\n") {
        return j;
      }
      out.push(ch);
      j += 1;
    }
    return n;
  };

  while (i < n) {
    const c = source[i];
    if (state === "template") {
      if (c === "\\") {
        out.push(source.slice(i, i + 2));
        i += 2;
        continue;
      }
      if (c === "`") {
        state = "code";
        i = foldNext(i + 1);
        continue;
      }
      if (c === "$" && source[i + 1] === "{") {
        out.push(` ${DYN} `);
        holes.push("interp");
        state = "code";
        i += 2;
        continue;
      }
      out.push(c);
      i += 1;
      continue;
    }
    if (kind === "ts") {
      if (c === "/" && source[i + 1] === "/") {
        const nl = source.indexOf("\n", i);
        i = nl < 0 ? n : nl;
        out.push(" ");
        continue;
      }
      if (c === "/" && source[i + 1] === "*") {
        const e = source.indexOf("*/", i + 2);
        i = e < 0 ? n : e + 2;
        out.push(" ");
        continue;
      }
      if (c === "'" || c === '"') {
        i = emitStringContents(i, c);
        continue;
      }
      if (c === "`") {
        state = "template";
        i += 1;
        continue;
      }
      if (c === "/") {
        i = emitMaybeRegex(i);
        continue;
      }
    } else {
      if (c === "-" && source[i + 1] === "-") {
        const nl = source.indexOf("\n", i);
        i = nl < 0 ? n : nl;
        out.push(" ");
        continue;
      }
      if (c === "/" && source[i + 1] === "*") {
        const e = source.indexOf("*/", i + 2);
        i = e < 0 ? n : e + 2;
        out.push(" ");
        continue;
      }
      if (c === "'") {
        i = emitStringContents(i, "'");
        continue;
      }
      if (c === '"') {
        i = emitQuotedIdent(i);
        continue;
      }
      if (c === "$") {
        const m = /^\$[A-Za-z_0-9]*\$/.exec(source.slice(i));
        if (m) {
          i = emitDollarQuoted(i, m[0]);
          continue;
        }
      }
    }
    if (c === "{") {
      holes.push("brace");
      out.push(c);
      i += 1;
      continue;
    }
    if (c === "}") {
      const top = holes.pop();
      if (top === "interp") {
        out.push(" ");
        state = "template";
      } else {
        out.push(c);
      }
      i += 1;
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join("");
}

describe("forbidden trigger bypass (spec 3.2 rules 7-11, 19.2)", () => {
  // Every sensitive token is assembled from fragments so this file itself
  // never contains a forbidden form as contiguous text and stays scannable.
  const ROLE = ["session", "replication", "role"].join("_");
  const DIS = ["DIS", "ABLE"].join("");
  const ENA = ["EN", "ABLE"].join("");
  const TRIG = ["TRIG", "GER"].join("");
  const REPLICA = ["REPL", "ICA"].join("");
  const ALWAYS = ["ALW", "AYS"].join("");
  const SET_ = ["SE", "T"].join("");
  const RST = ["RE", "SET"].join("");
  const CFG = ["set_", "config"].join("");
  const ALT = ["AL", "TER"].join("");
  const UPD = ["UP", "DATE"].join("");
  const PGS = ["pg", "settings"].join("_");
  const PGO = ["PG", "OPTIONS"].join("");
  const OPT = ["opt", "ions"].join("");
  const TRIGGER_TOGGLE = new RegExp(
    `\\b(${DIS}|${ENA})\\s+((?:${REPLICA}|${ALWAYS})\\s+)?${TRIG}S?\\s*("[^"\\n]*"|${DYN}|ALL|USER|[A-Za-z_][A-Za-z0-9_]*|\\S)?`,
    "gi",
  );
  const NAMED_TRANSITION_TRIGGER = "shippingrefund_transition_guard";
  // The ONLY file permitted to contain a trigger toggle, and only for the
  // one named transition trigger (spec 19.2 fixture isolation).
  const FIXTURE_HELPER = "tests/helpers/shipping-refund-fixture.ts";
  // The only places the setting may be referenced AT ALL (3.2 rule 10):
  // the authorized integrity module and the fixture verification — and in
  // those files every occurrence must be the exact read-only form.
  // String delimiters are dropped during scanning (concatenated literals
  // fold), so the permitted read form tolerates either the quoted literal
  // inside a template or the delimiter-stripped form.
  const READ_FORM = new RegExp(`current_setting\\s*\\(\\s*'?\\s*${ROLE}\\s*'?\\s*\\)`, "g");
  const READ_FORM_ONLY = new Set([
    "app/lib/shipping-refund-trigger-manifest.ts",
    FIXTURE_HELPER,
  ]);
  // The architecture test may name the setting in order to assert on it;
  // mutation forms remain forbidden here as everywhere. The fixture PG
  // suite names it for the same reason — it asserts the helper never
  // emits a mutation form.
  const MAY_ASSERT_ROLE = new Set([
    "tests/shipping-refund-trigger-manifest.test.ts",
    "tests/shipping-refund-fixture-pg.test.ts",
  ]);

  const roleMutationForms: RegExp[] = [
    // SET [LOCAL|SESSION] of the role — bare or quoted identifier.
    new RegExp(`\\b${SET_}\\s+(?:LOCAL\\s+|SESSION\\s+)?["'\\\`]{0,3}${ROLE}\\b`, "gi"),
    new RegExp(`\\b${CFG}\\s*\\(\\s*["'\\\`]{1,3}${ROLE}\\b`, "gi"),
    new RegExp(`\\b${RST}\\s+["'\\\`]{0,3}${ROLE}\\b`, "gi"),
    // RESET ALL resets the role among everything else.
    new RegExp(`\\b${RST}\\s+ALL\\b`, "gi"),
    new RegExp(`\\b${ALT}\\s+(?:SYSTEM|ROLE|USER|DATABASE|ALL)\\b[^;\\n]*${ROLE}\\b`, "gi"),
    // A direct catalog write aimed at the setting.
    new RegExp(`\\b${UPD}\\s+(?:ONLY\\s+)?(?:pg_catalog\\s*\\.\\s*)?${PGS}\\b`, "gi"),
    // Environment or connection-string overrides that can carry -c/-- sets.
    new RegExp(`\\b${PGO}\\b`, "g"),
    new RegExp(`-c\\s*["'\\\`]{0,3}${ROLE}\\b`, "gi"),
    new RegExp(`-{2}${ROLE}\\b`, "gi"),
    // libpq options= embedding any command-line switch (-c, --set...).
    new RegExp(`\\b${OPT}\\s*=\\s*["'\\\`]{0,2}-`, "gi"),
  ];

  const scanRoots = ["app", "scripts", "prisma/migrations", "tests"];

  /** The single predicate the scan applies to every scanned source. */
  function scanSource(text: string, relPath: string): string[] {
    const offenders: string[] = [];
    const sig = significantText(text, relPath.endsWith(".sql") ? "sql" : "ts");
    for (const re of roleMutationForms) {
      for (const m of sig.matchAll(re)) {
        offenders.push(`${relPath}: role mutation ${m[0]}`);
      }
    }
    // 19.3 item 3: every non-comment occurrence of the token is classified.
    // It is legal only as the exact read form and only in the allowlisted
    // modules; this architecture test may name it to assert on it.
    if (sig.includes(ROLE)) {
      const residual = sig.replace(READ_FORM, " ");
      if (READ_FORM_ONLY.has(relPath)) {
        if (residual.includes(ROLE)) {
          offenders.push(`${relPath}: ${ROLE} outside the permitted read form`);
        }
      } else if (!MAY_ASSERT_ROLE.has(relPath)) {
        offenders.push(`${relPath}: names ${ROLE}`);
      }
    }
    for (const m of sig.matchAll(TRIGGER_TOGGLE)) {
      const rawName = (m[3] ?? "").replace(/^"|"$/g, "");
      const permitted =
        relPath === FIXTURE_HELPER &&
        !m[2] &&
        rawName === NAMED_TRANSITION_TRIGGER;
      if (!permitted) offenders.push(`${relPath}: ${m[0]}`);
    }
    return offenders;
  }

  it("no source mutates the replication role or toggles triggers outside the fixture contract", () => {
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
        offenders.push(...scanSource(readFileSync(f, "utf8"), rel));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("synthetic negative: the previously offending statement is caught by the scan", () => {
    // Reconstructs exactly the statement that used to live in the pg suite.
    const offending = `ALTER TABLE "ShippingRefund" ${DIS} ${TRIG} ${NAMED_TRANSITION_TRIGGER}`;
    expect(scanSource(offending, "tests/shipping-refund-schema-pg.test.ts")).not.toEqual([]);
    // The narrow exception: only the fixture helper, only that named trigger
    // (unquoted or quoted — the same one named trigger).
    expect(scanSource(offending, FIXTURE_HELPER)).toEqual([]);
    expect(
      scanSource(
        `ALTER TABLE "ShippingRefund" ${DIS} ${TRIG} "${NAMED_TRANSITION_TRIGGER}"`,
        FIXTURE_HELPER,
      ),
    ).toEqual([]);
    // Any wider toggle is rejected even in the fixture helper.
    expect(
      scanSource(`ALTER TABLE "ShippingRefund" ${DIS} ${TRIG} ALL`, FIXTURE_HELPER),
    ).not.toEqual([]);
    expect(
      scanSource(`ALTER TABLE t ${ENA} ${REPLICA} ${TRIG} x`, FIXTURE_HELPER),
    ).not.toEqual([]);
    expect(
      scanSource(`ALTER TABLE t ${ENA} ${ALWAYS} ${TRIG} x`, FIXTURE_HELPER),
    ).not.toEqual([]);
    // A quoted or interpolated name is still a toggle — and never qualifies
    // for the fixture exception. (DYN_EXPR is the literal text ${t}.)
    const DYN_EXPR = ["$", "{t}"].join("");
    expect(
      scanSource(
        `ALTER TABLE "ShippingRefund" ${DIS} ${TRIG} "shippingrefund_shape_guard"`,
        "tests/x.ts",
      ),
    ).not.toEqual([]);
    expect(
      scanSource(
        `ALTER TABLE "ShippingRefund" ${DIS} ${TRIG} "${NAMED_TRANSITION_TRIGGER}"`,
        "tests/x.ts",
      ),
    ).not.toEqual([]);
    expect(
      scanSource(`ALTER TABLE t ${DIS} ${TRIG} ${DYN_EXPR}`, FIXTURE_HELPER),
    ).not.toEqual([]);
    expect(
      scanSource(`ALTER TABLE t ${DIS} ${TRIG} ${DYN_EXPR}`, "tests/x.ts"),
    ).not.toEqual([]);
    // A toggle assembled by string concatenation scans as its runtime form.
    expect(
      scanSource(
        `const s = "ALTER TABLE t ${DIS}" + " ${TRIG} ${NAMED_TRANSITION_TRIGGER}"`,
        "tests/x.ts",
      ),
    ).not.toEqual([]);
    // DISABLE TRIGGER USER / a bare toggle with no name are caught too.
    expect(scanSource(`ALTER TABLE t ${DIS} ${TRIG} USER`, FIXTURE_HELPER)).not.toEqual([]);
  });

  it("synthetic negative: every replication-role mutation form is caught", () => {
    const ANY_FILE = "app/lib/anything.ts";
    const mutations = [
      `${SET_} ${ROLE} = 'replica'`,
      `${SET_} LOCAL ${ROLE} = 'replica'`,
      `${SET_} SESSION ${ROLE} = 'replica'`,
      `${SET_} LOCAL "${ROLE}" = 'replica'`,
      `${SET_} '${ROLE}' = 'replica'`,
      `${CFG}('${ROLE}', 'replica', false)`,
      `${CFG}("${ROLE}", 'replica', false)`,
      `${RST} ${ROLE}`,
      `${RST} ALL`,
      `${ALT} ROLE app ${SET_} ${ROLE} = 'replica'`,
      `${ALT} DATABASE d ${SET_} ${ROLE} = 'replica'`,
      `${ALT} SYSTEM ${SET_} ${ROLE} = 'replica'`,
      `${UPD} ${PGS} ${SET_} setting = 'replica' WHERE name = '${ROLE}'`,
      `-c ${ROLE}=replica`,
      `-c"${ROLE}=replica"`,
      `--${ROLE}=replica`,
      `${OPT}=-c ${ROLE}=replica`,
      `${OPT}=--${ROLE}=replica`,
      `${PGO}="-c statement_timeout=1"`,
      `const u = "postgresql://u@127.0.0.1:5432/db?${OPT}=-c ${ROLE}=replica"`,
      `const u = "postgresql://u@127.0.0.1:5432/db?${OPT}=--${ROLE}=replica"`,
    ];
    for (const stmt of mutations) {
      expect(scanSource(stmt, ANY_FILE), stmt).not.toEqual([]);
      // A mutation form fails even inside an allowlisted file.
      expect(
        scanSource(stmt, "app/lib/shipping-refund-trigger-manifest.ts"),
        `${stmt} (allowlisted)`,
      ).not.toEqual([]);
    }
  });

  it("classifies the token: the read form only in allowlisted files, nowhere else", () => {
    // The read form alone passes only inside the allowlisted modules.
    expect(
      scanSource(
        `SELECT current_setting('${ROLE}')`,
        "app/lib/shipping-refund-trigger-manifest.ts",
      ),
    ).toEqual([]);
    expect(scanSource(`SELECT current_setting('${ROLE}')`, FIXTURE_HELPER)).toEqual([]);
    // The same read form is still forbidden anywhere else.
    expect(scanSource(`SELECT current_setting('${ROLE}')`, "app/lib/anything.ts")).not.toEqual([]);
    expect(scanSource(`SELECT current_setting('${ROLE}')`, "prisma/migrations/x.sql")).not.toEqual([]);
    // A non-read mention fails even in an allowlisted file.
    expect(
      scanSource(`const s = "${ROLE} is the setting"`, "app/lib/shipping-refund-trigger-manifest.ts"),
    ).not.toEqual([]);
    expect(
      scanSource(`SHOW ${ROLE}`, "app/lib/shipping-refund-trigger-manifest.ts"),
    ).not.toEqual([]);
    // A second-argument read form is not the permitted single-argument read.
    expect(
      scanSource(
        `SELECT current_setting('${ROLE}', true)`,
        "app/lib/shipping-refund-trigger-manifest.ts",
      ),
    ).not.toEqual([]);
    // This architecture test may name the token to assert on it.
    expect(
      scanSource(`// asserts on ${ROLE}`, "tests/shipping-refund-trigger-manifest.test.ts"),
    ).toEqual([]);
  });

  it("comments and string punctuation can neither hide statements nor create them", () => {
    // A comment is never a source occurrence — forbidden-looking text inside
    // comments is not an offender.
    expect(scanSource(`// ${DIS} ${TRIG} x and ${SET_} ${ROLE}='replica'`, "x.ts")).toEqual([]);
    expect(scanSource(`/* ${DIS} ${TRIG} x ${SET_} ${ROLE} */`, "x.ts")).toEqual([]);
    expect(scanSource(`-- ${SET_} ${ROLE} = 'replica'`, "x.sql")).toEqual([]);
    expect(scanSource(`/* ${SET_} ${ROLE} = 'replica' */`, "x.sql")).toEqual([]);
    // A // or -- inside a string is content, not a comment: the mutation
    // after it is still seen.
    expect(
      scanSource(
        `const u = "postgresql://u@127.0.0.1:5432/db?${OPT}=-c ${ROLE}=replica"`,
        "x.ts",
      ),
    ).not.toEqual([]);
    expect(
      scanSource(`const s = "note -- ${SET_} ${ROLE} = 'replica'"`, "x.ts"),
    ).not.toEqual([]);
    // Benign URLs, dashes and mentions inside strings are not offenders.
    expect(
      scanSource(`const u = "postgresql://u@127.0.0.1:5432/mergeship_test_x"`, "x.ts"),
    ).toEqual([]);
    expect(scanSource(`const s = "a -- b // c"`, "x.ts")).toEqual([]);
    expect(scanSource(`/* nothing */ const n = 1 -- 2;`, "x.sql")).toEqual([]);
  });

  it("the integrity module contains only the read-only catalog form", () => {
    const manifestSrc = readFileSync(
      join(REPO_ROOT, "app/lib/shipping-refund-trigger-manifest.ts"),
      "utf8",
    );
    expect(scanSource(manifestSrc, "app/lib/shipping-refund-trigger-manifest.ts")).toEqual([]);
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
        const text = significantText(readFileSync(f, "utf8"), "ts");
        if (
          /\bstatus\s*[:=]\s*['"]?DISPATCHING\b/.test(text) ||
          /SET\s+"?status"?\s*=\s*'?DISPATCHING\b/i.test(text) ||
          /ShippingRefund[\s\S]{0,200}DISPATCHING\b/.test(text)
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
    // The mutation DOCUMENT text is data (section 10): the contract module is
    // the one file allowed to carry `refundCreate`, exposed through a single
    // accessor (3.2 rule 5). Everything that could EXECUTE a dispatch —
    // DispatchPermit, sendRefund, a dispatch/worker module, the worker env
    // flag — stays banned everywhere in S1.
    const CONTRACT_PATH = "app/lib/shipping-refund-contract.ts";
    const banned = /\b(DispatchPermit|sendRefund|shipping[-_]?refund[-_]?(dispatch|worker)|MERGESHIP_SHIPPING_REFUNDS)\b/i;
    const offenders: string[] = [];
    const mutationText: string[] = [];
    for (const root of ["app", "scripts", "tests/helpers"]) {
      for (const f of walk(join(REPO_ROOT, root), [".ts", ".tsx"])) {
        const text = significantText(readFileSync(f, "utf8"), "ts");
        const rel = relative(REPO_ROOT, f).replace(/\\/g, "/");
        if (banned.test(text)) {
          offenders.push(rel);
        }
        if (/\brefundCreate\b/.test(text) && rel !== CONTRACT_PATH) {
          mutationText.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(mutationText).toEqual([]);
  });

  it("the mutation document text accessor is referenced only inside the contract module (3.2 rule 5)", () => {
    const CONTRACT_PATH = "app/lib/shipping-refund-contract.ts";
    const offenders: string[] = [];
    for (const root of ["app", "scripts"]) {
      for (const f of walk(join(REPO_ROOT, root), [".ts", ".tsx"])) {
        const rel = relative(REPO_ROOT, f).replace(/\\/g, "/");
        if (rel === CONTRACT_PATH) continue;
        const text = significantText(readFileSync(f, "utf8"), "ts");
        if (/shippingRefundMutationDocument/.test(text)) {
          offenders.push(rel);
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

// ── 12.3.1 attribution pin (19.3): CONFIRMED has no runtime-mutable source ──

describe("attribution CONFIRMED cannot be activated (12.3.1, 19.3)", () => {
  it("no app/ or scripts/ source binds attributionStatus to anything but the pin", () => {
    // Every `attributionStatus` binding in production sources must be a type
    // annotation or the pinned `deps.attributionStatus ?? ATTRIBUTION_STATUS`
    // default. No env var, Settings row, request value or literal may ever
    // feed it — the "CONFIRMED" union member exists only so the injected
    // test seam can exercise the 12.8.2 branch on fixtures.
    const offenders: string[] = [];
    for (const root of ["app", "scripts"]) {
      for (const f of walk(join(REPO_ROOT, root), [".ts", ".tsx"])) {
        const text = significantText(readFileSync(f, "utf8"), "ts");
        const rel = relative(REPO_ROOT, f).split("\\").join("/");
        for (const m of text.matchAll(
          /\battributionStatus\b\s*(?:\?\s*)?[:=](?![=>])\s*([^;,}\n]+)/g,
        )) {
          const rhs = (m[1] ?? "").trim();
          const allowed =
            /^AttributionStatus\b/.test(rhs) ||
            /^deps\.attributionStatus\s*\?\?\s*ATTRIBUTION_STATUS\b/.test(rhs);
          if (!allowed) {
            offenders.push(`${rel}: attributionStatus bound to '${rhs.slice(0, 80)}'`);
          }
        }
        // The environment must never reach attribution.
        if (
          /process\.env[\s\S]{0,160}attribution/i.test(text) ||
          /attribution[\s\S]{0,160}process\.env/i.test(text)
        ) {
          offenders.push(`${rel}: env-driven attribution`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the CONFIRMED literal exists only inside the gate module", () => {
    // 'CONFIRMED' appears in exactly one file: the ATTRIBUTION_STATUS
    // declaration itself and the G-AGREEMENT 12.8.2 evidence-outcome
    // classifier (a different domain — it describes recorded fixture
    // evidence, never the activation flag).
    const offenders: string[] = [];
    for (const root of ["app", "scripts"]) {
      for (const f of walk(join(REPO_ROOT, root), [".ts", ".tsx"])) {
        const text = significantText(readFileSync(f, "utf8"), "ts");
        const rel = relative(REPO_ROOT, f).split("\\").join("/");
        if (/"CONFIRMED"|'CONFIRMED'/.test(text) &&
            rel !== "app/lib/shipping-refund-gate.ts") {
          offenders.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the pinned value itself is UNVERIFIED", async () => {
    const gate = await import("../app/lib/shipping-refund-gate");
    expect(gate.ATTRIBUTION_STATUS).toBe("UNVERIFIED");
  });
});
