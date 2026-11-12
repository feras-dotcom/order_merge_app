// Eligibility-record projection: pure, DB-free, clock-free (dates are
// passed in). Schema v1 record:
//   { id, win, dest, method, cur, left, exp, used? }
// inside the customer metafield document { v: 1, recs: [...] }.
import { destKey, normMethod } from "../extension/src/dest-key";

export const ELIG_VERSION = 1 as const;
export const ELIG_NAMESPACE = "$app";
export const ELIG_KEY = "ship_elig";

export interface EligRecord {
  id: string;
  win: string;
  dest: string;
  method: string;
  cur: string;
  left: number;
  exp: string;
  used?: string[];
}

export interface EligDoc {
  v: 1;
  recs: EligRecord[];
}

export type BuildRefusal =
  | "NO_CUSTOMER"
  | "CANCELLED"
  | "NOT_PAID"
  | "NOT_SINGLE_SHIPPING_LINE"
  | "ZERO_SHIPPING"
  | "NO_DEST";

export interface OrderFacts {
  orderId: string;
  customerId: string | null;
  currencyCode: string;
  shippingAddress: {
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    provinceCode?: string | null;
    zip?: string | null;
    countryCode?: string | null;
  } | null;
  shippingLines: {
    title: string;
    originalMinor: bigint | number | string;
    discountedMinor: bigint | number | string;
  }[];
  cancelledAt: string | null;
  financialStatus: string;
}

const minorOf = (v: bigint | number | string): bigint =>
  typeof v === "bigint" ? v : BigInt(String(v));

export function buildRecord(
  order: OrderFacts,
  cfg: { windowId: string; expiresOn: string; left?: number },
): { ok: true; record: EligRecord } | { ok: false; reason: BuildRefusal } {
  if (!order.customerId) return { ok: false, reason: "NO_CUSTOMER" };
  if (order.cancelledAt !== null) return { ok: false, reason: "CANCELLED" };
  if (order.financialStatus !== "PAID") return { ok: false, reason: "NOT_PAID" };
  if (!Array.isArray(order.shippingLines) || order.shippingLines.length !== 1) {
    return { ok: false, reason: "NOT_SINGLE_SHIPPING_LINE" };
  }
  const line = order.shippingLines[0];
  if (minorOf(line.originalMinor) <= 0n || minorOf(line.discountedMinor) <= 0n) {
    return { ok: false, reason: "ZERO_SHIPPING" };
  }
  const dest = destKey(order.shippingAddress);
  if (dest === null) return { ok: false, reason: "NO_DEST" };
  const m = String(order.orderId).match(/(\d+)$/);
  if (!m) return { ok: false, reason: "NO_DEST" };
  return {
    ok: true,
    record: {
      id: m[1],
      win: cfg.windowId,
      dest,
      method: normMethod(String(line.title)),
      cur: order.currencyCode,
      left: cfg.left ?? 1,
      exp: cfg.expiresOn,
    },
  };
}

// ── tolerant parse + stable serialization ──────────────────────────────

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const EXP_FORMAT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

const validRec = (r: unknown): r is EligRecord =>
  isObj(r) &&
  typeof r.id === "string" &&
  typeof r.win === "string" &&
  typeof r.dest === "string" &&
  typeof r.method === "string" &&
  typeof r.cur === "string" &&
  Number.isInteger(r.left) &&
  typeof r.exp === "string" &&
  EXP_FORMAT.test(r.exp) &&
  (r.used === undefined ||
    (Array.isArray(r.used) && r.used.every((u) => typeof u === "string")));

/** Tolerant read of the stored document: anything not matching {v:1,
 *  recs:[valid...]} is treated as empty; `garbage` reports that the raw
 *  value existed but was unusable. */
export function parseElig(raw: unknown): { doc: EligDoc; garbage: boolean } {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return { doc: { v: 1, recs: [] }, garbage: (v as string).length > 0 };
    }
  }
  if (!isObj(v) || v.v !== 1 || !Array.isArray(v.recs)) {
    return { doc: { v: 1, recs: [] }, garbage: v !== null && v !== undefined };
  }
  const recs = v.recs.filter(validRec).map((r) => {
    const out: EligRecord = {
      id: r.id,
      win: r.win,
      dest: r.dest,
      method: r.method,
      cur: r.cur,
      left: r.left,
      exp: r.exp,
    };
    if (r.used !== undefined) out.used = [...r.used];
    return out;
  });
  return { doc: { v: 1, recs }, garbage: false };
}

const sortRecs = (recs: EligRecord[]): EligRecord[] =>
  [...recs].sort((a, b) => (a.exp < b.exp ? -1 : a.exp > b.exp ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const recToJson = (r: EligRecord): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    cur: r.cur,
    dest: r.dest,
    exp: r.exp,
    id: r.id,
    left: r.left,
    method: r.method,
    win: r.win,
  };
  if (r.used !== undefined && r.used.length > 0) out.used = [...r.used].sort();
  return out;
};

/** Stable serialization (sorted keys, sorted recs): equal state produces a
 *  byte-identical string, so the writer can no-op on no change. */
export function serializeElig(doc: EligDoc): string {
  const recs = sortRecs(doc.recs).map(recToJson);
  return JSON.stringify({ recs, v: 1 });
}

export function mergeRecords(
  existing: unknown,
  incoming: EligRecord[],
  opts: { todayDate: string; maxRecs?: number },
): { doc: EligDoc; serialized: string; garbage: boolean } {
  const maxRecs = opts.maxRecs ?? 5;
  const { doc, garbage } = parseElig(existing);
  const byId = new Map<string, EligRecord>();
  // Existing records win on `left` for an id already present — a replayed
  // projection can never reset a consumed record.
  for (const r of doc.recs) byId.set(r.id, r);
  for (const r of incoming) {
    if (validRec(r) && !byId.has(r.id)) byId.set(r.id, { ...r });
  }
  // Prune expired and left<=0 records — except that a left<=0 record with a
  // `used` list stays as a tombstone until exp: without it a replayed order
  // webhook could re-add the id and reset a consumed grant (the Function
  // still requires left>0, so a tombstone grants nothing).
  const recs = sortRecs(
    [...byId.values()].filter(
      (r) => r.exp >= opts.todayDate && (r.left > 0 || (r.used !== undefined && r.used.length > 0)),
    ),
  ).slice(0, maxRecs);
  const next: EligDoc = { v: 1, recs };
  return { doc: next, serialized: serializeElig(next), garbage };
}

export function consumeRecord(
  existing: unknown,
  args: { recordId: string; byOrderId: string },
  opts: { todayDate?: string } = {},
): { doc: EligDoc; serialized: string; changed: boolean } {
  const { doc } = parseElig(existing);
  const rec = doc.recs.find((r) => r.id === args.recordId);
  if (rec === undefined) {
    return { doc, serialized: serializeElig(doc), changed: false };
  }
  const used = rec.used ?? [];
  if (used.includes(args.byOrderId)) {
    return { doc, serialized: serializeElig(doc), changed: false };
  }
  rec.used = [...used.slice(-4), args.byOrderId];
  rec.left = Math.max(0, rec.left - 1);
  // Keep the spent record as a `used` tombstone (pruned on exp/cap by
  // mergeRecords); an expired record drops regardless.
  const recs = doc.recs.filter((r) => opts.todayDate === undefined || r.exp >= opts.todayDate);
  const next: EligDoc = { v: 1, recs };
  return { doc: next, serialized: serializeElig(next), changed: true };
}
