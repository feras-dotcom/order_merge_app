// Tests for the G-READBACK cost gate (scripts/lib/evidence-cost.ts).
// Absent or malformed extensions must fail; the threshold is per document
// and per agreement page; UNMEASURED never counts as a pass.
import { describe, expect, it } from "vitest";

import {
  COST_ACCEPTANCE_LIMIT, costGateStatus, validateCostExtension, verdictFromCost,
  withinCostLimit,
} from "../scripts/lib/evidence-cost";

const goodExt = (requested = 10, actual = 2) => ({
  cost: {
    requestedQueryCost: requested,
    actualQueryCost: actual,
    fields: [{ path: ["order", "refunds"], requestedQueryCost: 5, actualQueryCost: 1 }],
    throttleStatus: { currentlyAvailable: 990 },
  },
});

describe("validateCostExtension", () => {
  it("accepts a well-formed debug-cost extension", () => {
    const r = validateCostExtension(goodExt(37, 4));
    expect(r).toMatchObject({ ok: true, requestedQueryCost: 37, actualQueryCost: 4 });
    if (r.ok) expect(r.fields[0].path).toEqual(["order", "refunds"]);
  });

  it.each([
    ["absent extensions", null],
    ["absent extensions.cost", { other: 1 }],
    ["non-numerical requestedQueryCost", { cost: { requestedQueryCost: "12", actualQueryCost: 2, fields: [] } }],
    ["missing actualQueryCost", { cost: { requestedQueryCost: 12, fields: [] } }],
    ["missing fields breakdown", { cost: { requestedQueryCost: 12, actualQueryCost: 2 } }],
    ["fields not array", { cost: { requestedQueryCost: 12, actualQueryCost: 2, fields: {} } }],
    ["empty fields breakdown", { cost: { requestedQueryCost: 12, actualQueryCost: 2, fields: [] } }],
    ["fields entry not object", { cost: { requestedQueryCost: 12, actualQueryCost: 2, fields: [null] } }],
    ["fields entry missing cost", { cost: { requestedQueryCost: 12, actualQueryCost: 2, fields: [{ path: ["order"] }] } }],
    ["fields entry non-numeric actual", { cost: { requestedQueryCost: 12, actualQueryCost: 2, fields: [{ requestedQueryCost: 3, actualQueryCost: "x" }] } }],
  ])("fails on %s", (_label, ext) => {
    expect(validateCostExtension(ext).ok).toBe(false);
  });
});

describe("withinCostLimit / verdictFromCost", () => {
  it(`accepts requestedQueryCost at and below ${COST_ACCEPTANCE_LIMIT}`, () => {
    expect(withinCostLimit(COST_ACCEPTANCE_LIMIT)).toBe(true);
    expect(withinCostLimit(1)).toBe(true);
    expect(withinCostLimit(COST_ACCEPTANCE_LIMIT + 1)).toBe(false);
  });

  it("FAILs a document whose requested cost exceeds the limit", () => {
    const v = verdictFromCost("Q-RECHECK", goodExt(COST_ACCEPTANCE_LIMIT + 250, 3));
    expect(v.status).toBe("FAIL");
    expect(v.requestedQueryCost).toBe(COST_ACCEPTANCE_LIMIT + 250);
  });

  it("marks missing cost as UNMEASURED — never a pass", () => {
    expect(verdictFromCost("Q-APPID", null).status).toBe("UNMEASURED");
  });
});

describe("costGateStatus", () => {
  it("empty verdict collection is UNMEASURED, never PASS", () => {
    expect(costGateStatus([])).toBe("UNMEASURED");
  });

  const pass = verdictFromCost("A", goodExt());
  const unmeasured = verdictFromCost("B", null);
  const failDoc = verdictFromCost("C", goodExt(999));

  it("PASS when every document measured within threshold", () => {
    expect(costGateStatus([pass, verdictFromCost("D", goodExt(500, 250))])).toBe("PASS");
  });

  it("UNMEASURED when any document lacks cost", () => {
    expect(costGateStatus([pass, unmeasured])).toBe("UNMEASURED");
  });

  it("FAIL when any document exceeds the limit", () => {
    expect(costGateStatus([pass, failDoc])).toBe("FAIL");
  });

  it("fails the gate when a single agreement page is over budget or unmeasured", () => {
    const docPagesFail = { ...pass, pages: [pass, failDoc] };
    expect(costGateStatus([docPagesFail])).toBe("FAIL");
    const docPagesUnmeasured = { ...pass, pages: [pass, unmeasured] };
    expect(costGateStatus([docPagesUnmeasured])).toBe("UNMEASURED");
  });
});
