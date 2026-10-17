// Canonical trigger manifest and catalog-integrity comparison for the
// shipping-refund journal (docs/SHIPPING-PHASE2-DESIGN.md Revision 3.3,
// section 5.4.7). Pure module: no I/O, no mutation, no dependencies beyond
// this file. checkTriggerIntegrity accepts an injected read-only catalog
// query so migration tests, runtime checks, fixture verification and status
// tooling all share exactly one manifest, one catalog query text and one
// comparison.

export type ShippingRefundTriggerTable = "ShippingRefund" | "ShippingRefundEvent";
export type ShippingRefundTriggerTiming = "BEFORE" | "AFTER";
export type ShippingRefundTriggerEvent = "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE";
export type ShippingRefundTriggerLevel = "ROW" | "STATEMENT";

export interface ShippingRefundTriggerManifestEntry {
  /** Unique trigger name (catalog identity). */
  readonly name: string;
  /** Table schema the trigger is attached to. */
  readonly schema: "public";
  /** Table the trigger is attached to. */
  readonly table: ShippingRefundTriggerTable;
  readonly timing: ShippingRefundTriggerTiming;
  /** Exact event set; comparison is order-insensitive, duplicates excluded. */
  readonly events: readonly ShippingRefundTriggerEvent[];
  readonly level: ShippingRefundTriggerLevel;
  readonly functionSchema: "public";
  readonly functionName: string;
  /**
   * The manifest prescribes: no WHEN clause, no UPDATE OF column list,
   * zero arguments, and no constraint/deferrable attributes — anything else
   * is a WRONG_MODIFIERS mismatch.
   */
}

/**
 * The ten canonical triggers, in manifest order. Single source of truth for
 * every comparison: migration SQL versus manifest, catalog versus manifest,
 * the fixture helper's suspend/re-enable list and status tooling.
 */
export const SHIPPING_REFUND_TRIGGER_MANIFEST = [
  { name: "shippingrefund_insert_guard",            schema: "public", table: "ShippingRefund",      timing: "BEFORE", events: ["INSERT"],                 level: "ROW",       functionSchema: "public", functionName: "shipping_refund_fn_insert_guard" },
  { name: "shippingrefund_transition_guard",        schema: "public", table: "ShippingRefund",      timing: "BEFORE", events: ["UPDATE"],                 level: "ROW",       functionSchema: "public", functionName: "shipping_refund_fn_transition_guard" },
  { name: "shippingrefund_frozen_columns_guard",    schema: "public", table: "ShippingRefund",      timing: "BEFORE", events: ["UPDATE"],                 level: "ROW",       functionSchema: "public", functionName: "shipping_refund_fn_frozen_columns_guard" },
  { name: "shippingrefund_shape_guard",             schema: "public", table: "ShippingRefund",      timing: "BEFORE", events: ["INSERT", "UPDATE"],       level: "ROW",       functionSchema: "public", functionName: "shipping_refund_fn_shape_guard" },
  { name: "shippingrefund_evidence_integrity_guard",schema: "public", table: "ShippingRefund",      timing: "BEFORE", events: ["UPDATE"],                 level: "ROW",       functionSchema: "public", functionName: "shipping_refund_fn_evidence_integrity_guard" },
  { name: "shippingrefund_no_delete",               schema: "public", table: "ShippingRefund",      timing: "BEFORE", events: ["DELETE"],                 level: "ROW",       functionSchema: "public", functionName: "shipping_refund_fn_always_raise" },
  { name: "shippingrefund_no_truncate",             schema: "public", table: "ShippingRefund",      timing: "BEFORE", events: ["TRUNCATE"],               level: "STATEMENT", functionSchema: "public", functionName: "shipping_refund_fn_always_raise" },
  { name: "shippingrefund_event_writer",            schema: "public", table: "ShippingRefund",      timing: "AFTER",  events: ["INSERT", "UPDATE"],       level: "ROW",       functionSchema: "public", functionName: "shipping_refund_fn_event_writer" },
  { name: "shippingrefundevent_no_update_delete",   schema: "public", table: "ShippingRefundEvent", timing: "BEFORE", events: ["UPDATE", "DELETE"],       level: "ROW",       functionSchema: "public", functionName: "shipping_refund_fn_always_raise" },
  { name: "shippingrefundevent_no_truncate",        schema: "public", table: "ShippingRefundEvent", timing: "BEFORE", events: ["TRUNCATE"],               level: "STATEMENT", functionSchema: "public", functionName: "shipping_refund_fn_always_raise" },
] as const satisfies readonly ShippingRefundTriggerManifestEntry[];

/**
 * The one read-only catalog query (5.4.7). Restricted to the two journal
 * tables; excludes internal triggers (pg_trigger.tgisinternal); returns the
 * raw pg_catalog fields needed to decode complete trigger definitions plus
 * the session replication role (read-only — nothing may ever SET it).
 *
 * tgtype bit flags (catalog/pg_trigger.h): ROW=1<<0, BEFORE=1<<1,
 * INSERT=1<<2, DELETE=1<<3, UPDATE=1<<4, TRUNCATE=1<<5, INSTEAD_OF=1<<6.
 */
export const TRIGGER_CATALOG_SQL = `SELECT
  t.tgname AS "triggerName",
  n.nspname AS "tableSchema",
  c.relname AS "tableName",
  t.tgtype::integer AS "tgtype",
  t.tgenabled AS "tgenabled",
  fn.nspname AS "functionSchema",
  p.proname AS "functionName",
  t.tgisinternal AS "isInternal",
  (t.tgqual IS NOT NULL) AS "hasWhenClause",
  (t.tgattr::text <> '') AS "hasColumnList",
  t.tgnargs::integer AS "argCount",
  (t.tgconstraint <> 0) AS "isConstraint",
  t.tgdeferrable AS "deferrable",
  t.tginitdeferred AS "initdeferred",
  current_setting('session_replication_role') AS "sessionReplicationRole"
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p ON p.oid = t.tgfoid
JOIN pg_namespace fn ON fn.oid = p.pronamespace
WHERE NOT t.tgisinternal
  AND t.tgrelid IN (
    to_regclass('public."ShippingRefund"'),
    to_regclass('public."ShippingRefundEvent"')
  )
ORDER BY n.nspname, c.relname, t.tgname`;

/** Raw catalog row as returned by TRIGGER_CATALOG_SQL. */
export interface ShippingRefundTriggerCatalogRow {
  readonly triggerName: string;
  readonly tableSchema: string;
  readonly tableName: string;
  readonly tgtype: number;
  readonly tgenabled: string;
  readonly functionSchema: string;
  readonly functionName: string;
  readonly isInternal: boolean;
  readonly hasWhenClause: boolean;
  readonly hasColumnList: boolean;
  readonly argCount: number;
  readonly isConstraint: boolean;
  readonly deferrable: boolean;
  readonly initdeferred: boolean;
  readonly sessionReplicationRole?: string;
}

export type TriggerIntegrityReasonCode =
  | "MISSING"
  | "UNEXPECTED"
  | "DUPLICATE"
  | "DISABLED"
  | "WRONG_TABLE_OR_SCHEMA"
  | "WRONG_TIMING"
  | "WRONG_EVENTS"
  | "WRONG_LEVEL"
  | "WRONG_FUNCTION"
  | "WRONG_MODIFIERS"
  | "NON_ORIGIN_ROLE"
  | "CATALOG_ERROR";

export interface TriggerIntegrityReason {
  readonly code: TriggerIntegrityReasonCode;
  readonly table?: string;
  readonly trigger?: string;
  readonly detail: string;
}

export interface TriggerIntegrityVerdict {
  readonly intact: boolean;
  readonly reasons: readonly TriggerIntegrityReason[];
}

/** Decoded tgtype: timing BEFORE/AFTER/INSTEAD_OF, level, event set. */
export interface DecodedTriggerType {
  readonly timing: "BEFORE" | "AFTER" | "INSTEAD_OF";
  readonly level: "ROW" | "STATEMENT";
  readonly events: readonly ShippingRefundTriggerEvent[];
}

const TGTYPE_ROW = 1 << 0;
const TGTYPE_BEFORE = 1 << 1;
const TGTYPE_INSERT = 1 << 2;
const TGTYPE_DELETE = 1 << 3;
const TGTYPE_UPDATE = 1 << 4;
const TGTYPE_TRUNCATE = 1 << 5;
const TGTYPE_INSTEAD_OF = 1 << 6;

/** Decode pg_trigger.tgtype bit flags. Throws on a malformed value. */
export function decodeTriggerType(tgtype: number): DecodedTriggerType {
  if (!Number.isInteger(tgtype) || tgtype < 0 || tgtype > 0b1111111) {
    throw new Error(`malformed tgtype ${tgtype}`);
  }
  const level = tgtype & TGTYPE_ROW ? "ROW" : "STATEMENT";
  const timing =
    tgtype & TGTYPE_INSTEAD_OF ? "INSTEAD_OF" : tgtype & TGTYPE_BEFORE ? "BEFORE" : "AFTER";
  const events: ShippingRefundTriggerEvent[] = [];
  if (tgtype & TGTYPE_INSERT) events.push("INSERT");
  if (tgtype & TGTYPE_UPDATE) events.push("UPDATE");
  if (tgtype & TGTYPE_DELETE) events.push("DELETE");
  if (tgtype & TGTYPE_TRUNCATE) events.push("TRUNCATE");
  if (events.length === 0) {
    throw new Error(`malformed tgtype ${tgtype}: no event bits`);
  }
  return { timing, level, events };
}

/**
 * Render a manifest entry into the catalog row the real query would return
 * for a perfectly matching trigger — used by tests and by later fixture
 * verification to build expected rows.
 */
export function expectedCatalogRow(
  entry: ShippingRefundTriggerManifestEntry,
  sessionReplicationRole = "origin",
): ShippingRefundTriggerCatalogRow {
  let tgtype = 0;
  if (entry.level === "ROW") tgtype |= TGTYPE_ROW;
  if (entry.timing === "BEFORE") tgtype |= TGTYPE_BEFORE;
  for (const ev of entry.events) {
    tgtype |=
      ev === "INSERT" ? TGTYPE_INSERT
      : ev === "UPDATE" ? TGTYPE_UPDATE
      : ev === "DELETE" ? TGTYPE_DELETE
      : TGTYPE_TRUNCATE;
  }
  return {
    triggerName: entry.name,
    tableSchema: entry.schema,
    tableName: entry.table,
    tgtype,
    tgenabled: "O",
    functionSchema: entry.functionSchema,
    functionName: entry.functionName,
    isInternal: false,
    hasWhenClause: false,
    hasColumnList: false,
    argCount: 0,
    isConstraint: false,
    deferrable: false,
    initdeferred: false,
    sessionReplicationRole,
  };
}

function sameEventSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((e) => b.includes(e));
}

function malformed(detail: string, table?: string, trigger?: string): TriggerIntegrityReason {
  return { code: "CATALOG_ERROR", table, trigger, detail };
}

/**
 * Validate one catalog row's shape. Returns a CATALOG_ERROR reason when a
 * required field is null or malformed, otherwise null.
 */
function validateCatalogRow(
  row: ShippingRefundTriggerCatalogRow | Record<string, unknown>,
  index: number,
): TriggerIntegrityReason | null {
  if (row === null || typeof row !== "object") {
    return malformed(`catalog row ${index}: not an object`);
  }
  const r = row as Record<string, unknown>;
  const trigger = typeof r.triggerName === "string" ? r.triggerName : undefined;
  const table =
    typeof r.tableName === "string" ? r.tableName : undefined;
  const fail = (detail: string) => malformed(`catalog row ${index}: ${detail}`, table, trigger);
  if (typeof r.triggerName !== "string" || r.triggerName.length === 0) return fail("missing triggerName");
  if (typeof r.tableSchema !== "string" || r.tableSchema.length === 0) return fail("missing tableSchema");
  if (typeof r.tableName !== "string" || r.tableName.length === 0) return fail("missing tableName");
  if (!Number.isInteger(r.tgtype) || (r.tgtype as number) < 0 || (r.tgtype as number) > 0b1111111) {
    return fail("malformed tgtype");
  }
  try {
    decodeTriggerType(r.tgtype as number);
  } catch (e) {
    return fail(`undecodable tgtype: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof r.tgenabled !== "string" || r.tgenabled.length === 0) return fail("missing tgenabled");
  if (typeof r.functionSchema !== "string" || r.functionSchema.length === 0) return fail("missing functionSchema");
  if (typeof r.functionName !== "string" || r.functionName.length === 0) return fail("missing functionName");
  for (const f of ["isInternal", "hasWhenClause", "hasColumnList", "isConstraint", "deferrable", "initdeferred"]) {
    if (typeof r[f] !== "boolean") return fail(`missing or non-boolean ${f}`);
  }
  if (!Number.isInteger(r.argCount) || (r.argCount as number) < 0) return fail("malformed argCount");
  return null;
}

/**
 * Compare catalog rows (from TRIGGER_CATALOG_SQL) against the manifest.
 * Fails closed: missing, duplicate, unexpected, disabled, wrongly defined or
 * internal triggers, a non-origin replication role, malformed rows and
 * wrong-schema/-table attachments all produce reasons and intact=false.
 * Function identity is the schema-qualified name only — bodies are not part
 * of catalog identity.
 */
export function compareTriggerCatalog(
  manifest: readonly ShippingRefundTriggerManifestEntry[],
  catalogRows: readonly ShippingRefundTriggerCatalogRow[],
  sessionReplicationRole: string,
): TriggerIntegrityVerdict {
  const reasons: TriggerIntegrityReason[] = [];

  if (sessionReplicationRole !== "origin") {
    reasons.push({
      code: "NON_ORIGIN_ROLE",
      detail: `session_replication_role is '${sessionReplicationRole}', expected 'origin'`,
    });
  }

  // Malformed rows fail closed; internal triggers are not matches — the real
  // query filters them, and an injected row claiming internal is ignored as
  // a match but still cannot hide an expected one.
  const effective: ShippingRefundTriggerCatalogRow[] = [];
  for (let i = 0; i < catalogRows.length; i += 1) {
    const row = catalogRows[i];
    const err = validateCatalogRow(row, i);
    if (err) {
      reasons.push(err);
      continue;
    }
    if (row.isInternal) continue; // internal triggers never match (5.4.7)
    effective.push(row);
  }

  const byKey = new Map<string, ShippingRefundTriggerCatalogRow[]>();
  for (const row of effective) {
    const key = `${row.tableSchema}.${row.tableName}.${row.triggerName}`;
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }
  for (const [key, list] of byKey) {
    if (list.length > 1) {
      reasons.push({
        code: "DUPLICATE",
        table: key.split(".").slice(0, 2).join("."),
        trigger: list[0].triggerName,
        detail: `${list.length} catalog rows for ${key}`,
      });
    }
  }

  const matchedKeys = new Set<string>();
  for (const entry of manifest) {
    const key = `${entry.schema}.${entry.table}.${entry.name}`;
    const rows = byKey.get(key) ?? [];
    if (rows.length === 0) {
      // A same-named trigger attached elsewhere is UNEXPECTED (matched by the
      // unexpected-pass below) and the manifest entry is MISSING — report the
      // wrong attachment explicitly for diagnosis.
      const stray = effective.find((r) => r.triggerName === entry.name);
      reasons.push({
        code: stray ? "WRONG_TABLE_OR_SCHEMA" : "MISSING",
        table: `${entry.schema}.${entry.table}`,
        trigger: entry.name,
        detail: stray
          ? `expected on ${entry.schema}.${entry.table}; found attached to ${stray.tableSchema}.${stray.tableName}`
          : `no trigger named ${entry.name} on ${entry.schema}.${entry.table}`,
      });
      continue;
    }
    matchedKeys.add(key);
    const row = rows[0];

    if (row.tgenabled !== "O") {
      reasons.push({
        code: "DISABLED",
        table: `${entry.schema}.${entry.table}`,
        trigger: entry.name,
        detail: `DISABLED(${row.tgenabled}): tgenabled is '${row.tgenabled}', expected 'O'`,
      });
    }

    let decoded: DecodedTriggerType;
    try {
      decoded = decodeTriggerType(row.tgtype);
    } catch {
      continue; // validateCatalogRow already reported CATALOG_ERROR
    }
    if (decoded.timing === "INSTEAD_OF") {
      reasons.push({
        code: "WRONG_TIMING",
        table: `${entry.schema}.${entry.table}`,
        trigger: entry.name,
        detail: "INSTEAD OF trigger on a table is invalid",
      });
    } else if (decoded.timing !== entry.timing) {
      reasons.push({
        code: "WRONG_TIMING",
        table: `${entry.schema}.${entry.table}`,
        trigger: entry.name,
        detail: `timing ${decoded.timing}, expected ${entry.timing}`,
      });
    }
    if (!sameEventSet(decoded.events, entry.events)) {
      reasons.push({
        code: "WRONG_EVENTS",
        table: `${entry.schema}.${entry.table}`,
        trigger: entry.name,
        detail: `events [${decoded.events.join(",")}], expected [${entry.events.join(",")}]`,
      });
    }
    if (decoded.level !== entry.level) {
      reasons.push({
        code: "WRONG_LEVEL",
        table: `${entry.schema}.${entry.table}`,
        trigger: entry.name,
        detail: `level ${decoded.level}, expected ${entry.level}`,
      });
    }
    if (row.functionSchema !== entry.functionSchema || row.functionName !== entry.functionName) {
      reasons.push({
        code: "WRONG_FUNCTION",
        table: `${entry.schema}.${entry.table}`,
        trigger: entry.name,
        detail: `function ${row.functionSchema}.${row.functionName}, expected ${entry.functionSchema}.${entry.functionName}`,
      });
    }
    if (
      row.hasWhenClause ||
      row.hasColumnList ||
      row.argCount !== 0 ||
      row.isConstraint ||
      row.deferrable ||
      row.initdeferred
    ) {
      reasons.push({
        code: "WRONG_MODIFIERS",
        table: `${entry.schema}.${entry.table}`,
        trigger: entry.name,
        detail:
          `modifiers (hasWhenClause=${row.hasWhenClause}, hasColumnList=${row.hasColumnList}, ` +
          `argCount=${row.argCount}, isConstraint=${row.isConstraint}, ` +
          `deferrable=${row.deferrable}, initdeferred=${row.initdeferred}), all must be absent/0/false`,
      });
    }
  }

  for (const [key, list] of byKey) {
    if (matchedKeys.has(key)) continue;
    for (const row of list) {
      reasons.push({
        code: "UNEXPECTED",
        table: `${row.tableSchema}.${row.tableName}`,
        trigger: row.triggerName,
        detail: `unexpected trigger ${row.tableSchema}.${row.tableName}.${row.triggerName}`,
      });
    }
  }

  return { intact: reasons.length === 0, reasons };
}

/**
 * Run the integrity check against an injected read-only catalog query.
 * The query is expected to execute TRIGGER_CATALOG_SQL verbatim. Any thrown
 * error or exception (including timeouts), a non-array or empty result, a
 * missing/inconsistent replication role or any malformed row fails closed.
 */
export async function checkTriggerIntegrity(
  queryCatalog: () => Promise<readonly ShippingRefundTriggerCatalogRow[]>,
  manifest: readonly ShippingRefundTriggerManifestEntry[] = SHIPPING_REFUND_TRIGGER_MANIFEST,
): Promise<TriggerIntegrityVerdict> {
  let rows: readonly ShippingRefundTriggerCatalogRow[];
  try {
    rows = await queryCatalog();
  } catch (e) {
    return {
      intact: false,
      reasons: [
        {
          code: "CATALOG_ERROR",
          detail: `catalog query failed: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
    };
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      intact: false,
      reasons: [{ code: "CATALOG_ERROR", detail: "catalog query returned no rows" }],
    };
  }
  const role = rows[0]?.sessionReplicationRole;
  if (typeof role !== "string" || role.length === 0) {
    return {
      intact: false,
      reasons: [{ code: "CATALOG_ERROR", detail: "catalog rows lack sessionReplicationRole" }],
    };
  }
  if (rows.some((r) => r && typeof r === "object" && r.sessionReplicationRole !== role)) {
    return {
      intact: false,
      reasons: [{ code: "CATALOG_ERROR", detail: "inconsistent sessionReplicationRole across catalog rows" }],
    };
  }
  return compareTriggerCatalog(manifest, rows, role);
}
