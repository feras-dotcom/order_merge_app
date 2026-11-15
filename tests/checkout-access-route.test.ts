// app.checkout-access: the pilot scope-request page 404s unless ALL
// global levers are on (env flag + AppControl switch + allowlist
// membership) — defaults make it a 404 for everybody — and returns the
// per-scope granted state when they are.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { loader } from "../app/routes/app.checkout-access";

vi.mock("../app/db.server", () => ({ default: {} }));

const SHOP = "s.myshopify.com";
const current = { granted: [] as string[], scopesThrow: false };
vi.mock("../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: SHOP },
      scopes: {
        query: async () => {
          if (current.scopesThrow) throw new Error("scopes read failed");
          return { granted: current.granted };
        },
      },
    }),
  },
}));

const control = {
  row: null as { checkoutDiscountEnabled: boolean; checkoutDiscountAllowShops: string[] } | null,
};
vi.mock("../app/lib/operation-store.server", () => ({
  prismaOperationStore: { getControl: async () => control.row },
}));

const req = () => ({ request: new Request("https://app.example.com/app/checkout-access") }) as any;

const allLevers = () => {
  process.env.MERGESHIP_CHECKOUT_DISCOUNT = "enabled";
  control.row = { checkoutDiscountEnabled: true, checkoutDiscountAllowShops: [SHOP] };
};

beforeEach(() => {
  delete process.env.MERGESHIP_CHECKOUT_DISCOUNT;
  control.row = null;
  current.granted = [];
  current.scopesThrow = false;
});

describe("app.checkout-access loader", () => {
  it("404 with every lever at its default", async () => {
    const res = await loader(req());
    expect(res.status).toBe(404);
  });

  it.each([
    ["env off", () => {
      delete process.env.MERGESHIP_CHECKOUT_DISCOUNT;
    }],
    ["control switch off", () => {
      control.row = { checkoutDiscountEnabled: false, checkoutDiscountAllowShops: [SHOP] };
    }],
    ["shop not allowlisted", () => {
      control.row = { checkoutDiscountEnabled: true, checkoutDiscountAllowShops: [] };
    }],
    ["empty allowlist (inverted semantics = no shops)", () => {
      control.row = { checkoutDiscountEnabled: true, checkoutDiscountAllowShops: [] as string[] };
    }],
    ["control row missing", () => {
      control.row = null;
    }],
  ])("404 with only %s failing", async (_name, breakIt) => {
    allLevers();
    breakIt();
    const res = await loader(req());
    expect(res.status).toBe(404);
  });

  it("200 with all three levers on — reports per-scope state", async () => {
    allLevers();
    current.granted = ["write_customers"];
    const res = await loader(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scopesReadable).toBe(true);
    expect(body.scopes).toEqual([
      { scope: "write_customers", granted: true },
      { scope: "write_discounts", granted: false },
    ]);
  });

  it("both scopes granted", async () => {
    allLevers();
    current.granted = ["write_customers", "write_discounts", "read_orders"];
    const res = await loader(req());
    const body = await res.json();
    expect(body.scopes.every((s: any) => s.granted === true)).toBe(true);
  });

  it("an unreadable scope query reports unknown, never throws", async () => {
    allLevers();
    current.scopesThrow = true;
    const res = await loader(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scopesReadable).toBe(false);
    expect(body.scopes.every((s: any) => s.granted === null)).toBe(true);
  });
});
