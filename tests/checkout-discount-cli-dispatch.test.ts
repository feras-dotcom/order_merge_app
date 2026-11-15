// cli-dispatch regression: without --apply NO mutation function is ever
// reached (a live bug let shutdown/prepare-enable/activate fall through the
// dry-run print and execute); with --apply each runs exactly once; status
// never mutates; mutation errors exit 1 with `error: Name: message`.
import { describe, expect, it, vi } from "vitest";
import { runCheckoutDiscountCommand } from "../app/lib/checkout-discount/cli-dispatch.server";
import { CHECKOUT_DISCOUNT_MESSAGE } from "../app/lib/checkout-discount/config";

const STATE = {
  status: "EXPIRED",
  windowId: "w1",
  percentage: "100.0",
  message: CHECKOUT_DISCOUNT_MESSAGE,
  windowStart: "2026-11-01T00:00:00",
  windowEnd: "2026-12-01T00:00:00",
  functionId: "gid://fn/1",
};

const makeDeps = (over: Record<string, unknown> = {}) => {
  const control = {
    readCheckoutDiscount: vi.fn(async () => STATE),
    resolveCheckoutFunctionId: vi.fn(async () => "gid://fn/1"),
    findExistingCheckoutDiscount: vi.fn(async () => null),
    createCheckoutDiscount: vi.fn(async () => ({ id: "gid://d/1", status: "EXPIRED", created: true })),
    shutdownCheckoutDiscount: vi.fn(async () => ({ id: "gid://d/1", status: "EXPIRED" })),
    prepareEnable: vi.fn(async () => ({ windowId: "w1700000000000", enabledAt: new Date("2026-11-14T00:00:00Z") })),
    activateCheckoutDiscount: vi.fn(async () => ({ id: "gid://d/1", status: "ACTIVE" })),
  };
  const log = vi.fn();
  const errorLog = vi.fn();
  return {
    deps: {
      admin: { graphql: vi.fn() } as any,
      shop: "smoke-a.myshopify.com",
      discountId: "gid://d/1",
      expectedWindowId: "w1700000000000",
      functionId: undefined,
      control: control as any,
      log,
      errorLog,
      ...over,
    },
    control,
    log,
    errorLog,
  };
};

const MUTATIONS = [
  "createCheckoutDiscount",
  "shutdownCheckoutDiscount",
  "prepareEnable",
  "activateCheckoutDiscount",
] as const;

const allMutations = (control: any) => MUTATIONS.map((m) => control[m]);

describe("runCheckoutDiscountCommand dry-run boundary", () => {
  for (const cmd of ["shutdown", "prepare-enable", "activate", "create"] as const) {
    it(`${cmd} without --apply exits 0 and calls ZERO mutations`, async () => {
      const { deps, control } = makeDeps();
      const code = await runCheckoutDiscountCommand({ ...deps, cmd, apply: false });
      expect(code).toBe(0);
      for (const m of allMutations(control)) expect(m).not.toHaveBeenCalled();
    });
  }

  it("status prints state, never mutates, exits 0 — apply or not", async () => {
    for (const apply of [false, true]) {
      const { deps, control, log } = makeDeps();
      const code = await runCheckoutDiscountCommand({ ...deps, cmd: "status", apply });
      expect(code).toBe(0);
      expect(control.readCheckoutDiscount).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain('"found":true');
      for (const m of allMutations(control)) expect(m).not.toHaveBeenCalled();
    }
  });
});

describe("runCheckoutDiscountCommand --apply", () => {
  it("shutdown runs once with admin/shop/discountId", async () => {
    const { deps, control } = makeDeps();
    const code = await runCheckoutDiscountCommand({ ...deps, cmd: "shutdown", apply: true });
    expect(code).toBe(0);
    expect(control.shutdownCheckoutDiscount).toHaveBeenCalledTimes(1);
    expect(control.shutdownCheckoutDiscount).toHaveBeenCalledWith({
      admin: deps.admin,
      shop: deps.shop,
      discountId: deps.discountId,
    });
    for (const m of [control.createCheckoutDiscount, control.prepareEnable, control.activateCheckoutDiscount])
      expect(m).not.toHaveBeenCalled();
  });

  it("prepare-enable runs once with admin/shop/discountId + the approval converted to minor units", async () => {
    const { deps, control } = makeDeps({
      method: "Standard",
      maxShipping: "8.00",
      currency: "USD",
    });
    const code = await runCheckoutDiscountCommand({ ...deps, cmd: "prepare-enable", apply: true });
    expect(code).toBe(0);
    expect(control.prepareEnable).toHaveBeenCalledTimes(1);
    expect(control.prepareEnable).toHaveBeenCalledWith({
      admin: deps.admin,
      shop: deps.shop,
      discountId: deps.discountId,
      method: "Standard",
      maxShippingMinor: 800,
      currency: "USD",
    });
  });

  it("prepare-enable with an unconvertible --max-shipping exits 1 and mutates nothing", async () => {
    const { deps, control, errorLog } = makeDeps({
      method: "Standard",
      maxShipping: "8.001",
      currency: "USD",
    });
    const code = await runCheckoutDiscountCommand({ ...deps, cmd: "prepare-enable", apply: true });
    expect(code).toBe(1);
    expect(errorLog.mock.calls[0][0]).toMatch(/^error: /);
    expect(control.prepareEnable).not.toHaveBeenCalled();
  });

  it("activate runs once with the expectedWindowId", async () => {
    const { deps, control } = makeDeps();
    const code = await runCheckoutDiscountCommand({ ...deps, cmd: "activate", apply: true });
    expect(code).toBe(0);
    expect(control.activateCheckoutDiscount).toHaveBeenCalledTimes(1);
    expect(control.activateCheckoutDiscount).toHaveBeenCalledWith({
      admin: deps.admin,
      shop: deps.shop,
      discountId: deps.discountId,
      expectedWindowId: deps.expectedWindowId,
    });
  });

  it("create runs once with the create args", async () => {
    const { deps, control } = makeDeps({ percentage: "100.0", windowDays: 14 });
    const code = await runCheckoutDiscountCommand({ ...deps, cmd: "create", apply: true });
    expect(code).toBe(0);
    expect(control.createCheckoutDiscount).toHaveBeenCalledTimes(1);
    expect(control.createCheckoutDiscount).toHaveBeenCalledWith({
      admin: deps.admin,
      shop: deps.shop,
      functionId: undefined,
      percentage: "100.0",
      windowDays: 14,
    });
  });

  it("a mutation error exits 1 with `error: Name: message` on stderr", async () => {
    const { deps, control, errorLog } = makeDeps();
    const err = new Error("discount exploded");
    err.name = "DiscountStateError";
    control.shutdownCheckoutDiscount.mockRejectedValueOnce(err);
    const code = await runCheckoutDiscountCommand({ ...deps, cmd: "shutdown", apply: true });
    expect(code).toBe(1);
    expect(errorLog).toHaveBeenCalledWith("error: DiscountStateError: discount exploded");
  });
});
