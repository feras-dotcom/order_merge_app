// Focused S2 tests: DispatchPermit authorization (9.3), response
// classification (11) and the environment flag — no database needed.
// Permit-dependent send semantics (single-use, expiry, pinned document,
// wire counts) run against real permits in the disposable-database suite
// tests/shipping-refund-dispatch-pg.test.ts, because a permit can now be
// obtained only from a resolved T3 commit — there is no test mint.
import { describe, expect, it } from "vitest";
import {
  DispatchPermit,
  classifyDispatchResponse,
  shippingRefundsDispatchEnabled,
} from "../app/lib/shipping-refund-dispatch.server";

const WIRE_VARS = {
  idempotencyKey: "76657d42-302c-43de-af25-fbc615f39cbf",
  input: { orderId: "gid://shopify/Order/1" },
};

describe("DispatchPermit authorization boundary (9.3, I19)", () => {
  it("refuses every caller that cannot present the module-private T3 authority", () => {
    for (const forged of [undefined, null, Symbol("t3-commit"), "row1", {}, 0]) {
      expect(() =>
        (DispatchPermit.issue as any)(forged, "row1", "tok1", WIRE_VARS, () => 0),
      ).toThrow(/resolved T3 commit/);
    }
  });

  it("the pre-correction public-mint signature is itself refused", () => {
    // The old bypass — DispatchPermit.issue(rowId, dispatchToken, vars,
    // clock), callable from any module — now presents a row id where the
    // module-private mint authority belongs.
    expect(() =>
      (DispatchPermit.issue as any)("row1", "tok1", WIRE_VARS, () => 0),
    ).toThrow(/resolved T3 commit/);
  });

  it("direct construction is refused at runtime as well", () => {
    // TypeScript-private is compile-time only: the constructor itself also
    // demands the authority, so even a cast cannot forge a permit.
    expect(() =>
      new (DispatchPermit as any)("row1", "tok1", WIRE_VARS, 0, () => 0),
    ).toThrow(/resolved T3 commit/);
    expect(() => new (DispatchPermit as any)(Symbol("forged"), "r", "t", {}, 0, () => 0)).toThrow();
  });
});

describe("classifyDispatchResponse (section 11)", () => {
  const accepted = { data: { refundCreate: { refund: { id: "gid://shopify/Refund/9", createdAt: "2026-11-02T10:00:00Z" }, userErrors: [] } } };
  it("ACCEPTED only on a clean refund id", () => {
    const o = classifyDispatchResponse(accepted);
    expect(o).toMatchObject({ kind: "ACCEPTED", refundId: "gid://shopify/Refund/9", refundCreatedAt: "2026-11-02T10:00:00Z", anomaly: false });
  });
  it("USER_ERRORS for a null refund with errors, and flags idempotency anomalies", () => {
    const o = classifyDispatchResponse({
      data: { refundCreate: { refund: null, userErrors: [{ field: null, message: "Idempotency key has been used with a different request payload." }] } },
    });
    expect(o.kind).toBe("USER_ERRORS");
    expect(o.anomaly).toBe(true);
  });
  it("USER_ERRORS when refund and userErrors are both present (never proof of success)", () => {
    const o = classifyDispatchResponse({
      data: { refundCreate: { refund: { id: "gid://shopify/Refund/2" }, userErrors: [{ field: ["x"], message: "partial" }] } },
    });
    expect(o.kind).toBe("USER_ERRORS");
  });
  it("TOP_LEVEL_ERRORS for top-level errors including throttling", () => {
    const o = classifyDispatchResponse({ errors: [{ message: "Throttled" }], data: null });
    expect(o.kind).toBe("TOP_LEVEL_ERRORS");
  });
  it("TRANSPORT for missing, malformed or non-JSON bodies", () => {
    for (const b of [null, undefined, "x", {}, { data: {} }, { data: { refundCreate: {} } }]) {
      expect(classifyDispatchResponse(b).kind).toBe("TRANSPORT");
    }
  });
  it("rejects a refund id that is not a valid Refund GID", () => {
    const o = classifyDispatchResponse({ data: { refundCreate: { refund: { id: "not-a-gid" }, userErrors: [] } } });
    expect(o.kind).toBe("TRANSPORT");
  });
});

describe("environment flag", () => {
  it("reads MERGESHIP_SHIPPING_REFUNDS === enabled", () => {
    delete process.env.MERGESHIP_SHIPPING_REFUNDS;
    expect(shippingRefundsDispatchEnabled()).toBe(false);
    process.env.MERGESHIP_SHIPPING_REFUNDS = "enabled";
    expect(shippingRefundsDispatchEnabled()).toBe(true);
    delete process.env.MERGESHIP_SHIPPING_REFUNDS;
  });
});
