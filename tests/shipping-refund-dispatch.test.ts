// Focused S2 tests: DispatchPermit semantics (9.3), response
// classification (11) and exactly-one-send transport behavior (10.5) —
// no database, fake admin clients only.
import { describe, expect, it } from "vitest";
import {
  DispatchPermit,
  classifyDispatchResponse,
  sendRefund,
  DISPATCH_PERMIT_TTL_MS,
  shippingRefundsDispatchEnabled,
} from "../app/lib/shipping-refund-dispatch.server";
import { shippingRefundMutationDocument } from "../app/lib/shipping-refund-contract";

const WIRE_VARS = {
  idempotencyKey: "76657d42-302c-43de-af25-fbc615f39cbf",
  input: { orderId: "gid://shopify/Order/1" },
};

const permit = (now: { t: number }) =>
  DispatchPermit.issue("row1", "tok1", WIRE_VARS, () => now.t);

const fakeAdmin = (body: unknown, throws = false) => {
  let calls = 0;
  const admin = {
    graphql: async (doc: string, opts: { variables: unknown }) => {
      calls += 1;
      if (throws) throw new Error("boom");
      return { json: async () => body };
    },
  };
  return { admin: admin as never, calls: () => calls };
};

describe("DispatchPermit (9.3)", () => {
  it("is single-use and marks consumed before the call", async () => {
    const now = { t: 1000 };
    const p = permit(now);
    const { admin, calls } = fakeAdmin({ data: { refundCreate: { refund: { id: "gid://shopify/Refund/1" }, userErrors: [] } } });
    await sendRefund(p, admin);
    expect(calls()).toBe(1);
    await expect(sendRefund(p, admin)).rejects.toThrow(/single-use/);
    expect(calls()).toBe(1); // consumed before the wire: no second request
  });
  it("refuses a permit older than 10 seconds — the row simply stays DISPATCHING", async () => {
    const now = { t: 1000 };
    const p = permit(now);
    now.t += DISPATCH_PERMIT_TTL_MS + 1;
    const { admin, calls } = fakeAdmin({});
    await expect(sendRefund(p, admin)).rejects.toThrow(/expired/);
    expect(calls()).toBe(0);
    expect(p.rowId).toBe("row1");
    expect(p.dispatchToken).toBe("tok1");
  });
  it("refuses a consumed permit even after it expired", async () => {
    const now = { t: 0 };
    const p = permit(now);
    p.consume();
    now.t += 100_000;
    await expect(sendRefund(p, fakeAdmin({}).admin)).rejects.toThrow(/single-use/);
  });
  it("sends the pinned document with the frozen variables and a 45s signal", async () => {
    const now = { t: 0 };
    const p = permit(now);
    let seen: { doc?: string; vars?: unknown; signal?: AbortSignal } = {};
    const admin = {
      graphql: async (doc: string, opts: { variables: unknown; signal: AbortSignal }) => {
        seen = { doc, vars: opts.variables, signal: opts.signal };
        return { json: async () => ({}) };
      },
    } as never;
    await sendRefund(p, admin);
    expect(seen.doc).toBe(shippingRefundMutationDocument());
    expect(seen.vars).toEqual(WIRE_VARS);
    expect(seen.signal).toBeInstanceOf(AbortSignal);
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
