// Query-cost validation for G-READBACK evidence (design §12.1.2, §17).
// Pure helpers: verify that a GraphQL response's `extensions.cost` carries
// numerical requested/actual query costs plus the field-level debug
// breakdown produced by `Shopify-GraphQL-Cost-Debug: 1`, and enforce the
// design's requestedQueryCost <= 500 acceptance threshold per document —
// and per page for paginated documents.

export const COST_ACCEPTANCE_LIMIT = 500;

export interface CostFieldEntry {
  readonly path?: readonly string[];
  readonly requestedQueryCost?: number;
  readonly actualQueryCost?: number;
  [k: string]: unknown;
}

export type CostCheck =
  | {
      readonly ok: true;
      readonly requestedQueryCost: number;
      readonly actualQueryCost: number;
      readonly fields: readonly CostFieldEntry[];
    }
  | { readonly ok: false; readonly reason: string };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Validate one response's `extensions` block. Fails closed: absent
 * extensions, non-numerical costs or a missing field breakdown are all
 * failures — a throttled or error response never counts as a measurement.
 */
export function validateCostExtension(extensions: unknown): CostCheck {
  if (extensions == null || typeof extensions !== "object") {
    return { ok: false, reason: "extensions absent — cost was not measured" };
  }
  const cost = (extensions as Record<string, unknown>).cost;
  if (cost == null || typeof cost !== "object") {
    return { ok: false, reason: "extensions.cost absent — cost was not measured" };
  }
  const c = cost as Record<string, unknown>;
  if (!isNum(c.requestedQueryCost)) {
    return { ok: false, reason: `requestedQueryCost not numerical: ${JSON.stringify(c.requestedQueryCost)}` };
  }
  if (!isNum(c.actualQueryCost)) {
    return { ok: false, reason: `actualQueryCost not numerical: ${JSON.stringify(c.actualQueryCost)}` };
  }
  const fields = c.fields;
  if (!Array.isArray(fields)) {
    return { ok: false, reason: "extensions.cost.fields absent — field-level debug breakdown missing" };
  }
  return {
    ok: true,
    requestedQueryCost: c.requestedQueryCost,
    actualQueryCost: c.actualQueryCost,
    fields: fields as readonly CostFieldEntry[],
  };
}

/**
 * Apply the design threshold to one measured document or page:
 * `requestedQueryCost <= 500`. Actual cost is recorded, not gated — it
 * depends on the data the store happened to hold, not the document's
 * designed bounds.
 */
export function withinCostLimit(requestedQueryCost: number, limit = COST_ACCEPTANCE_LIMIT): boolean {
  return Number.isFinite(requestedQueryCost) && requestedQueryCost <= limit;
}

/** Per-document cost verdict as archived in the validation register. */
export interface DocumentCostVerdict {
  readonly document: string;
  readonly measured: boolean;
  readonly requestedQueryCost: number | null;
  readonly actualQueryCost: number | null;
  readonly withinThreshold: boolean | null;
  readonly pages?: readonly DocumentCostVerdict[];
  readonly status: "PASS" | "FAIL" | "UNMEASURED";
  readonly reason?: string;
}

export function verdictFromCost(document: string, extensions: unknown): DocumentCostVerdict {
  const c = validateCostExtension(extensions);
  if (!c.ok) {
    return { document, measured: false, requestedQueryCost: null, actualQueryCost: null, withinThreshold: null, status: "UNMEASURED", reason: c.reason };
  }
  const within = withinCostLimit(c.requestedQueryCost);
  return {
    document, measured: true,
    requestedQueryCost: c.requestedQueryCost, actualQueryCost: c.actualQueryCost,
    withinThreshold: within,
    status: within ? "PASS" : "FAIL",
    reason: within ? undefined : `requestedQueryCost ${c.requestedQueryCost} exceeds ${COST_ACCEPTANCE_LIMIT}`,
  };
}

/**
 * The gate as a whole: every document's verdict AND every page verdict must
 * be a measurement; PASS requires all within threshold. UNMEASURED is never
 * a pass — absent cost data fails the gate, it does not silently pass it.
 */
export function costGateStatus(verdicts: readonly DocumentCostVerdict[]): "PASS" | "FAIL" | "UNMEASURED" {
  const all = verdicts.flatMap((v) => [v, ...(v.pages ?? [])]);
  if (all.some((v) => v.status === "FAIL")) return "FAIL";
  if (all.some((v) => v.status === "UNMEASURED")) return "UNMEASURED";
  return "PASS";
}
