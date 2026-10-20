// Tests for the pure pre-claim validation (S1-C2): parseCancelledAt and
// validateOperationForClaim. docs/SHIPPING-PHASE2-DESIGN.md Revision 3.3,
// sections 5.3, 7.2, 7.2.1, 7.2.2 and 7.5.
//
// Expected epochs come from an independent year-by-year day count (not the
// parser under test, not Date.UTC(year, …)); anchored to published epoch
// constants below.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DB_WALL_INVALID,
  ORDER_GID_PATTERN,
  parseCancelledAt,
  validateOperationForClaim,
} from "../app/lib/shipping-refund-gate";
import { ORDER_GID_PATTERN as CONTRACT_ORDER_GID_PATTERN } from "../app/lib/shipping-refund-contract";

// ── Independent civil-time oracle ─────────────────────────────────────────
const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const MDAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const ordinal = (y: number, m: number, d: number) => {
  let n = 0;
  for (let k = 1; k < y; k++) n += leap(k) ? 366 : 365;
  for (let k = 1; k < m; k++) n += k === 2 && leap(k) ? 29 : MDAYS[k - 1];
  return n + d - 1;
};
const EPOCH_ORD = ordinal(1970, 1, 1);
/** Expected epoch ms for a UTC civil instant, minus `offMin` minutes. */
const oracle = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0, offMin = 0) =>
  (ordinal(y, mo, d) - EPOCH_ORD) * 86_400_000 + ((h * 60 + mi - offMin) * 60 + s) * 1000 + ms;

const CANCELLED_FLOOR = oracle(2000, 1, 1);
const WALL_MS = oracle(2026, 10, 20, 12, 0, 0);
const WALL = new Date(WALL_MS);
const at = (ms: number) => new Date(ms);
const ISO = (ms: number) => at(ms).toISOString();

const reason = (v: unknown, wall: unknown = WALL) => {
  const r = parseCancelledAt(v, wall);
  return r instanceof Date ? `ACCEPTED:${r.getTime()}` : r.invalid;
};
// Like `reason` but never substitutes the default wall — passes dbWall verbatim.
const reasonWall = (v: unknown, wall: unknown) => {
  const r = parseCancelledAt(v, wall);
  return r instanceof Date ? `ACCEPTED:${r.getTime()}` : r.invalid;
};

// ── parseCancelledAt: acceptance matrix ───────────────────────────────────
describe("parseCancelledAt — acceptance (7.2.1)", () => {
  it("oracle anchors to published epoch constants", () => {
    expect(oracle(1970, 1, 1)).toBe(0);
    expect(oracle(2000, 1, 1)).toBe(946_684_800_000);
    expect(oracle(2024, 2, 29)).toBe(1_709_164_800_000);
  });

  it.each([
    ["2024-02-29T00:00:00Z", oracle(2024, 2, 29)], // valid leap day
    ["2024-02-29T23:59:59.999Z", oracle(2024, 2, 29, 23, 59, 59, 999)],
    ["2025-06-15T12:34:56+05:30", oracle(2025, 6, 15, 12, 34, 56, 0, 330)],
    ["2025-06-15T12:34:56-07:00", oracle(2025, 6, 15, 12, 34, 56, 0, -420)],
    ["2025-06-15T12:34:56+00:00", oracle(2025, 6, 15, 12, 34, 56)],
    ["2025-01-01T00:00:00-23:59", oracle(2025, 1, 1, 23, 59)],
    ["2025-01-01T23:59:00+23:59", oracle(2025, 1, 1)],
    ["2026-10-20T00:00:00+09:00", oracle(2026, 10, 19, 15, 0)],
    // fractional digits: 1, 3, 6, 9 — truncated to milliseconds
    ["2025-06-15T12:34:56.1Z", oracle(2025, 6, 15, 12, 34, 56, 100)],
    ["2025-06-15T12:34:56.789Z", oracle(2025, 6, 15, 12, 34, 56, 789)],
    ["2025-06-15T12:34:56.789123Z", oracle(2025, 6, 15, 12, 34, 56, 789)],
    ["2025-06-15T12:34:56.789123999Z", oracle(2025, 6, 15, 12, 34, 56, 789)],
    // truncation, never rounding
    ["2025-06-15T12:34:56.7899Z", oracle(2025, 6, 15, 12, 34, 56, 789)],
    ["2025-06-15T12:34:56.999999999Z", oracle(2025, 6, 15, 12, 34, 56, 999)],
    ["2025-06-15T12:34:56.0009Z", oracle(2025, 6, 15, 12, 34, 56)],
    ["2025-06-15T12:34:56.0000Z", oracle(2025, 6, 15, 12, 34, 56)],
    // bounds: exactly the year-2000 floor and exactly dbWall + 5 minutes
    ["2000-01-01T00:00:00Z", CANCELLED_FLOOR],
    ["2000-01-01T00:00:00.001Z", CANCELLED_FLOOR + 1],
    ["2000-01-01T00:00:00-23:59", oracle(2000, 1, 1, 23, 59)],
    [ISO(WALL_MS + 300_000), WALL_MS + 300_000],
    [ISO(WALL_MS + 299_999), WALL_MS + 299_999],
  ])("%s", (s, ms) => {
    const r = parseCancelledAt(s, WALL);
    expect(r).toBeInstanceOf(Date);
    expect((r as Date).getTime()).toBe(ms);
  });
});

describe("parseCancelledAt — refusal matrix (7.2.1)", () => {
  it.each([
    // calendar components (independently validated, never via Date.parse)
    ["2026-02-30T00:00:00Z", "CALENDAR_INVALID"],
    ["2026-04-31T00:00:00Z", "CALENDAR_INVALID"],
    ["2025-02-29T00:00:00Z", "CALENDAR_INVALID"], // non-leap Feb 29
    ["2100-02-29T00:00:00Z", "CALENDAR_INVALID"], // century non-leap
    ["2026-13-01T00:00:00Z", "CALENDAR_INVALID"],
    ["2026-00-10T00:00:00Z", "CALENDAR_INVALID"],
    ["2026-01-00T00:00:00Z", "CALENDAR_INVALID"],
    ["2026-01-32T00:00:00Z", "CALENDAR_INVALID"],
    ["2026-01-01T24:00:00Z", "CALENDAR_INVALID"],
    ["2026-01-01T00:60:00Z", "CALENDAR_INVALID"],
    ["2026-01-01T00:00:60Z", "CALENDAR_INVALID"], // leap second refused
    ["2026-01-01T00:00:00+24:00", "CALENDAR_INVALID"],
    ["2026-01-01T00:00:00-24:00", "CALENDAR_INVALID"],
    ["2026-01-01T00:00:00+00:60", "CALENDAR_INVALID"],
    // grammar
    [" 2025-06-15T12:34:56Z", "UNPARSEABLE"], // leading whitespace
    ["2025-06-15T12:34:56Z ", "UNPARSEABLE"], // trailing whitespace
    ["2025-06-15T12:34:56", "UNPARSEABLE"],   // no timezone
    ["2025-06-15", "UNPARSEABLE"],            // bare date
    ["2025-06-15 12:34:56Z", "UNPARSEABLE"],  // space separator
    ["2025-06-15t12:34:56z", "UNPARSEABLE"],  // lowercase t/z
    ["2025-6-15T12:34:56Z", "UNPARSEABLE"],   // non-padded month
    ["2025-06-15T12:34Z", "UNPARSEABLE"],     // missing seconds
    ["2025-06-15T12:34:56.Z", "UNPARSEABLE"], // empty fraction
    ["2025-06-15T12:34:56.1234567890Z", "UNPARSEABLE"], // 10 fractional digits
    ["2025-06-15T12:34:56+2:00", "UNPARSEABLE"],        // non-padded offset hour
    ["2025-06-15T12:34:56+02:0", "UNPARSEABLE"],        // non-padded offset minute
    ["2025-06-15T12:34:56+0200", "UNPARSEABLE"],        // offset without colon
    ["2025-06-15T12:34:56+02:00:00", "UNPARSEABLE"],
    ["+002025-06-15T12:34:56Z", "UNPARSEABLE"], // expanded year
    ["", "UNPARSEABLE"],                      // empty string is a string, not an instant
    ["not-a-date", "UNPARSEABLE"],
    // type
    [null, "NOT_A_STRING"],
    [1234567890, "NOT_A_STRING"],
    [true, "NOT_A_STRING"],
    [false, "NOT_A_STRING"],
    [{}, "NOT_A_STRING"],
    [{ cancelledAt: "2025-06-15T12:34:56Z" }, "NOT_A_STRING"],
    [[], "NOT_A_STRING"],
    [["2025-06-15T12:34:56Z"], "NOT_A_STRING"],
    [NaN, "NOT_A_STRING"],
    // absent
    [undefined, "ABSENT"],
    // range
    ["1999-12-31T23:59:59.999Z", "OUT_OF_RANGE"], // one ms before the floor
    ["2000-01-01T00:00:01+00:02", "OUT_OF_RANGE"], // = 1999-12-31T23:59:59Z
    ["1999-12-31T23:29:59.999-00:30", "OUT_OF_RANGE"], // offset, still below floor
    ["0001-01-01T00:00:00Z", "OUT_OF_RANGE"],          // unusually old
    ["0000-12-31T23:59:59.999Z", "OUT_OF_RANGE"],
    ["1970-01-01T00:00:00Z", "OUT_OF_RANGE"],
    ["9999-12-31T23:59:59.999Z", "OUT_OF_RANGE"],      // far future
    ["3026-10-20T12:00:00Z", "OUT_OF_RANGE"],
  ])("%s → %s", (v, expected) => {
    expect(reason(v)).toBe(expected);
  });

  it("refuses exactly one millisecond after dbWall + 5 minutes", () => {
    expect(reason(ISO(WALL_MS + 300_001))).toBe("OUT_OF_RANGE");
    expect(reason("2026-10-20T12:05:00.001Z")).toBe("OUT_OF_RANGE");
  });

  it("missing dbWall input", () => {
    expect(reasonWall("2025-06-15T12:34:56Z", undefined)).toBe(DB_WALL_INVALID);
    // no argument at all (a JS caller can omit it)
    const flex = parseCancelledAt as unknown as (...a: unknown[]) => unknown;
    expect(flex("2025-06-15T12:34:56Z")).toEqual({ invalid: "DB_WALL_INVALID" });
    expect(reason("2025-06-15T12:34:56Z")).toBe("ACCEPTED:" + oracle(2025, 6, 15, 12, 34, 56));
  });

  it.each([
    [null], [undefined], [17_000_000_000], [""], ["garbage"],
    ["2026-02-30T00:00:00Z"], [new Date("bogus")], [NaN], [true], [{}], [[]],
  ])("invalid dbWall %s → DB_WALL_INVALID", (w) => {
    expect(reasonWall("2025-06-15T12:34:56Z", w)).toBe(DB_WALL_INVALID);
  });

  it("accepts dbWall as a Date or a strict instant string", () => {
    const v = "2026-10-20T12:04:59Z";
    expect(parseCancelledAt(v, WALL)).toBeInstanceOf(Date);
    expect(parseCancelledAt(v, WALL.toISOString())).toBeInstanceOf(Date);
    // A string wall obeys the same strict grammar as every instant here.
    expect(reasonWall(v, "2026-10-20T12:00:00")).toBe(DB_WALL_INVALID);
  });

  it("DB_WALL_INVALID takes precedence over every value defect", () => {
    expect(parseCancelledAt(undefined, null)).toEqual({ invalid: "DB_WALL_INVALID" });
    expect(parseCancelledAt("garbage", new Date("x"))).toEqual({ invalid: "DB_WALL_INVALID" });
  });

  it("returns a fresh Date each call (no aliasing)", () => {
    const a = parseCancelledAt("2025-06-15T12:34:56Z", WALL) as Date;
    const b = parseCancelledAt("2025-06-15T12:34:56Z", WALL) as Date;
    expect(a).not.toBe(b);
    a.setTime(0);
    expect((parseCancelledAt("2025-06-15T12:34:56Z", WALL) as Date).getTime()).toBe(
      oracle(2025, 6, 15, 12, 34, 56),
    );
  });
});

// ── validateOperationForClaim ─────────────────────────────────────────────
const GID = (n: number) => `gid://shopify/Order/${n}`;
const OP_CREATED = at(oracle(2026, 10, 10, 8, 30));
const SEC_CANCELLED = "2026-10-15T09:12:03.456Z";

const op = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "op_01JXYZABCDEFGHJKMNPQRSTVWXYZ",
  shop: "test-shop.myshopify.com",
  primaryOrderId: GID(4001),
  primaryOrderName: "#1001",
  createdAt: OP_CREATED,
  protocolVersion: 2,
  phase: "COMPLETED",
  sideEffectsDone: true,
  ...over,
});
const secondary = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: GID(4002),
  name: "#1002",
  cancelledAt: SEC_CANCELLED,
  ...over,
});

const run = (o: unknown, s: unknown, w: unknown = WALL) =>
  validateOperationForClaim(o, s, w);

describe("validateOperationForClaim — valid input", () => {
  it("returns normalized values including ISO instants", () => {
    const r = run(op(), secondary());
    expect(r.outcome).toBe("VALID");
    if (r.outcome !== "VALID") return;
    expect(r.values).toEqual({
      shop: "test-shop.myshopify.com",
      mergeOperationId: "op_01JXYZABCDEFGHJKMNPQRSTVWXYZ",
      sourceOrderId: GID(4002),
      primaryOrderId: GID(4001),
      primaryOrderName: "#1001",
      operationCreatedAt: OP_CREATED,
      operationCreatedAtIso: OP_CREATED.toISOString(),
    });
    expect(r.sourceCancelledAt).toBeInstanceOf(Date);
    expect(r.sourceCancelledAtIso).toBe("2026-10-15T09:12:03.456Z");
    expect(r.sourceCancelledAt.toISOString()).toBe("2026-10-15T09:12:03.456Z");
  });

  it("accepts a string operation createdAt in the strict grammar", () => {
    const r = run(op({ createdAt: OP_CREATED.toISOString() }), secondary());
    expect(r.outcome).toBe("VALID");
    if (r.outcome === "VALID") {
      expect(r.values.operationCreatedAtIso).toBe(OP_CREATED.toISOString());
      expect(r.values.operationCreatedAt.getTime()).toBe(OP_CREATED.getTime());
    }
  });
});

describe("validateOperationForClaim — cancelledAt defects (claimable terminal)", () => {
  it.each([
    [undefined, "ABSENT"],
    [null, "NOT_A_STRING"],
    [42, "NOT_A_STRING"],
    ["garbage", "UNPARSEABLE"],
    ["2026-02-30T00:00:00Z", "CALENDAR_INVALID"],
    ["1999-12-31T23:59:59.999Z", "OUT_OF_RANGE"],
  ] as const)("cancelledAt %s → CANCELLED_AT_INVALID (%s)", (v, why) => {
    const r = run(op(), secondary({ cancelledAt: v }));
    expect(r.outcome).toBe("CANCELLED_AT_INVALID");
    if (r.outcome !== "CANCELLED_AT_INVALID") return;
    expect(r.reasonCode).toBe("CANCELLED_AT_INVALID");
    expect(r.cancelledAtInvalid).toBe(why);
    // The terminal row still gets every validated identity value.
    expect(r.values.sourceOrderId).toBe(GID(4002));
    expect(r.values.primaryOrderId).toBe(GID(4001));
    expect(r.values.mergeOperationId).toBe("op_01JXYZABCDEFGHJKMNPQRSTVWXYZ");
  });

  it("a secondary without the cancelledAt key is ABSENT", () => {
    const s = secondary();
    delete s.cancelledAt;
    const r = run(op(), s);
    expect(r.outcome).toBe("CANCELLED_AT_INVALID");
    if (r.outcome === "CANCELLED_AT_INVALID") expect(r.cancelledAtInvalid).toBe("ABSENT");
  });

  it("cancelledAtPreview holds ≤64 printable characters of the raw value", () => {
    const r1 = run(op(), secondary({ cancelledAt: ` ${"x".repeat(200)}` }));
    if (r1.outcome !== "CANCELLED_AT_INVALID") throw new Error("expected CANCELLED_AT_INVALID");
    expect(r1.cancelledAtPreview.length).toBeLessThanOrEqual(64);
    expect(/[^\x20-\x7E]/.test(r1.cancelledAtPreview)).toBe(false);
    const r2 = run(op(), secondary({ cancelledAt: "bad\nline" }));
    if (r2.outcome !== "CANCELLED_AT_INVALID") throw new Error("expected CANCELLED_AT_INVALID");
    expect(r2.cancelledAtPreview).toBe("bad?line?");
    const r3 = run(op(), secondary({ cancelledAt: 123 }));
    if (r3.outcome !== "CANCELLED_AT_INVALID") throw new Error("expected CANCELLED_AT_INVALID");
    expect(r3.cancelledAtPreview).toBe("123");
  });
});

describe("validateOperationForClaim — field defects (unclaimable)", () => {
  // Each row overrides exactly ONE field so the named check is isolated.
  it.each([
    // [label, op overrides, secondary overrides, field, reason]
    ["malformed primary GID", { primaryOrderId: "gid://shopify/Product/4001" }, {}, "primaryOrderId", "PRIMARY_ORDER_ID_INVALID"],
    ["non-string primary GID", { primaryOrderId: 4001 }, {}, "primaryOrderId", "PRIMARY_ORDER_ID_INVALID"],
    ["null primary GID", { primaryOrderId: null }, {}, "primaryOrderId", "PRIMARY_ORDER_ID_INVALID"],
    ["missing primary GID", { primaryOrderId: undefined }, {}, "primaryOrderId", "PRIMARY_ORDER_ID_INVALID"],
    ["numeric secondary id", {}, { id: 4002 }, "sourceOrderId", "SOURCE_ORDER_ID_INVALID"],
    ["null secondary id", {}, { id: null }, "sourceOrderId", "SOURCE_ORDER_ID_INVALID"],
    ["missing secondary id", {}, { id: undefined }, "sourceOrderId", "SOURCE_ORDER_ID_INVALID"],
    ["Product secondary id", {}, { id: "gid://shopify/Product/4002" }, "sourceOrderId", "SOURCE_ORDER_ID_INVALID"],
    ["secondary id with whitespace", {}, { id: ` ${GID(4002)}` }, "sourceOrderId", "SOURCE_ORDER_ID_INVALID"],
    ["secondary id with suffix", {}, { id: `${GID(4002)}x` }, "sourceOrderId", "SOURCE_ORDER_ID_INVALID"],
    ["secondary equals primary", {}, { id: GID(4001) }, "sourceOrderId", "SOURCE_EQUALS_PRIMARY"],
    ["missing shop", { shop: undefined }, {}, "shop", "SHOP_INVALID"],
    ["empty shop", { shop: "" }, {}, "shop", "SHOP_INVALID"],
    ["numeric shop", { shop: 7 }, {}, "shop", "SHOP_INVALID"],
    ["missing operation id", { id: undefined }, {}, "mergeOperationId", "MERGE_OPERATION_ID_INVALID"],
    ["empty operation id", { id: "" }, {}, "mergeOperationId", "MERGE_OPERATION_ID_INVALID"],
    ["numeric operation id", { id: 12 }, {}, "mergeOperationId", "MERGE_OPERATION_ID_INVALID"],
    ["missing order name", { primaryOrderName: undefined }, {}, "primaryOrderName", "PRIMARY_ORDER_NAME_INVALID"],
    ["empty order name", { primaryOrderName: "" }, {}, "primaryOrderName", "PRIMARY_ORDER_NAME_INVALID"],
    ["numeric order name", { primaryOrderName: 1001 }, {}, "primaryOrderName", "PRIMARY_ORDER_NAME_INVALID"],
    ["null createdAt", { createdAt: null }, {}, "operationCreatedAt", "OPERATION_CREATED_AT_INVALID"],
    ["garbage createdAt", { createdAt: "not a date" }, {}, "operationCreatedAt", "OPERATION_CREATED_AT_INVALID"],
    ["numeric createdAt", { createdAt: 1760000000000 }, {}, "operationCreatedAt", "OPERATION_CREATED_AT_INVALID"],
    ["invalid Date createdAt", { createdAt: new Date("x") }, {}, "operationCreatedAt", "OPERATION_CREATED_AT_INVALID"],
  ] as const)("%s → UNCLAIMABLE(%s)", (_l, opOver, secOver, field, why) => {
    const r = run(op(opOver), secondary(secOver));
    expect(r.outcome).toBe("UNCLAIMABLE");
    if (r.outcome !== "UNCLAIMABLE") return;
    expect(r.field).toBe(field);
    expect(r.reason).toBe(why);
  });

  it("a non-object operation is UNCLAIMABLE", () => {
    for (const o of [null, "op", 42, [op()], undefined]) {
      const r = run(o, secondary());
      expect(r.outcome).toBe("UNCLAIMABLE");
      if (r.outcome === "UNCLAIMABLE") {
        expect(r.field).toBe("operation");
        expect(r.reason).toBe("OPERATION_INVALID");
      }
    }
  });

  it("a non-object secondary is UNCLAIMABLE (cancelledAt retained as ABSENT)", () => {
    for (const s of [null, "sec", 42, [secondary()], undefined]) {
      const r = run(op(), s);
      expect(r.outcome).toBe("UNCLAIMABLE");
      if (r.outcome === "UNCLAIMABLE") {
        expect(r.field).toBe("secondary");
        expect(r.reason).toBe("SECONDARY_INVALID");
        expect(r.cancelledAtInvalid).toBe("ABSENT");
      }
    }
  });

  it("an invalid dbWall is UNCLAIMABLE, never CANCELLED_AT_INVALID", () => {
    const r = run(op(), secondary(), null);
    expect(r.outcome).toBe("UNCLAIMABLE");
    if (r.outcome === "UNCLAIMABLE") {
      expect(r.field).toBe("dbWall");
      expect(r.reason).toBe("DB_WALL_INVALID");
      expect(r.cancelledAtInvalid).toBe(DB_WALL_INVALID);
    }
  });
});

describe("validateOperationForClaim — deterministic precedence", () => {
  it("cancelledAt runs first but UNCLAIMABLE beats CANCELLED_AT_INVALID", () => {
    // Both defects: the terminal row cannot be formed (primaryOrderId
    // violates the CHECK), so the result is UNCLAIMABLE with the
    // cancelledAt reason retained for diagnostics.
    const r = run(
      op({ primaryOrderId: "gid://shopify/Order/abc" }),
      secondary({ cancelledAt: null }),
    );
    expect(r.outcome).toBe("UNCLAIMABLE");
    if (r.outcome === "UNCLAIMABLE") {
      expect(r.reason).toBe("PRIMARY_ORDER_ID_INVALID");
      expect(r.cancelledAtInvalid).toBe("NOT_A_STRING");
    }
  });

  it("field order is fixed: shop → id → primary → name → createdAt → secondary → source id → distinct", () => {
    const expectFirst = (o: unknown, s: unknown, field: string, why: string) => {
      const r = run(o, s);
      if (r.outcome !== "UNCLAIMABLE") throw new Error(`expected UNCLAIMABLE, got ${r.outcome}`);
      expect(r.field).toBe(field);
      expect(r.reason).toBe(why);
    };
    expectFirst(op({ shop: "", id: "", primaryOrderId: "bad" }), secondary({ id: 1 }), "shop", "SHOP_INVALID");
    expectFirst(op({ id: "", primaryOrderId: "bad" }), secondary({ id: 1 }), "mergeOperationId", "MERGE_OPERATION_ID_INVALID");
    expectFirst(op({ primaryOrderId: "bad" }), secondary({ id: 1 }), "primaryOrderId", "PRIMARY_ORDER_ID_INVALID");
    expectFirst(op({ primaryOrderName: "", createdAt: null }), secondary({ id: 1 }), "primaryOrderName", "PRIMARY_ORDER_NAME_INVALID");
    expectFirst(op({ createdAt: null }), secondary({ id: 1 }), "operationCreatedAt", "OPERATION_CREATED_AT_INVALID");
    expectFirst(op(), null, "secondary", "SECONDARY_INVALID");
    expectFirst(op(), secondary({ id: "bad" }), "sourceOrderId", "SOURCE_ORDER_ID_INVALID");
    expectFirst(op(), secondary({ id: GID(4001) }), "sourceOrderId", "SOURCE_EQUALS_PRIMARY");
    expectFirst(op(), secondary({ id: GID(4001).replace("4001", "4001x") }), "sourceOrderId", "SOURCE_ORDER_ID_INVALID");
    // the first failure wins even when cancelledAt is also invalid
    const r = run(op({ shop: "", primaryOrderId: "bad" }), secondary({ id: 1, cancelledAt: 0 }));
    if (r.outcome !== "UNCLAIMABLE") throw new Error("expected UNCLAIMABLE");
    expect(r.field).toBe("shop");
    expect(r.cancelledAtInvalid).toBe("NOT_A_STRING"); // evaluated first, retained
  });

  it("repeated calls are deterministic and inputs are not mutated", () => {
    const o = op();
    const s = secondary();
    Object.freeze(o);
    Object.freeze(s);
    const a = run(o, s);
    const b = run(o, s);
    expect(a).toEqual(b);
    // Mutating returned Dates must not corrupt later results.
    if (a.outcome === "VALID") a.sourceCancelledAt.setTime(0);
    const c = run(o, s);
    if (c.outcome !== "VALID") throw new Error("expected VALID");
    expect(c.sourceCancelledAtIso).toBe("2026-10-15T09:12:03.456Z");
    if (a.outcome === "VALID") a.values.operationCreatedAt.setTime(0);
    const d = run(o, s);
    if (d.outcome !== "VALID") throw new Error("expected VALID");
    expect(d.values.operationCreatedAt.getTime()).toBe(OP_CREATED.getTime());
  });
});

// ── One order-GID pattern across validator, contract and migration ────────
describe("ORDER_GID_PATTERN is the single §5.3/§7.2 pattern", () => {
  const MIGRATION = readFileSync(
    join(__dirname, "..", "prisma", "migrations", "20261021000000_shipping_v0_phase_2_s1a", "migration.sql"),
    "utf8",
  );
  it("equals the specification literal", () => {
    expect(ORDER_GID_PATTERN).toBe("^gid://shopify/Order/[0-9]+$");
  });
  it("equals the canonical contract constant", () => {
    expect(ORDER_GID_PATTERN).toBe(CONTRACT_ORDER_GID_PATTERN);
  });
  it("matches every order-GID CHECK in the accepted S1-A migration", () => {
    const occurrences =
      (MIGRATION.match(/~\s*'[^']*'/g) ?? []).filter((o) => o.includes("gid://shopify/Order/"));
    expect(occurrences.length).toBe(2); // sourceOrderId + primaryOrderId CHECKs
    for (const occ of occurrences) {
      expect(occ).toBe(`~ '${ORDER_GID_PATTERN}'`);
    }
  });
});
