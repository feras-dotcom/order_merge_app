// createCheckoutDiscount: resolves the Function by apiType+handle (never
// guesses), refuses a second MergeShip discount by config message, creates
// the automatic app discount with the inert w-unset windowId, and only
// returns after deactivation is verified EXPIRED — an unverifiable state
// throws with the shutdown command. Plus the Function-level proof that
// w-unset can never grant: records carry w<epochMs> windowIds.
import { describe, expect, it, vi } from "vitest";
import { cartDeliveryOptionsDiscountsGenerateRun } from "../functions/checkout-shipping-discount/src/cart_delivery_options_discounts_generate_run";
import {
  createCheckoutDiscount,
  resolveCheckoutFunctionId,
  DiscountStateError,
  ShutdownNotVerifiedError,
} from "../app/lib/checkout-discount/discount-control.server";
import { CHECKOUT_DISCOUNT_MESSAGE } from "../app/lib/checkout-discount/config";

vi.mock("../app/db.server", () => ({ default: {} }));

const SHOP = "s.myshopify.com";
const DID = "gid://shopify/DiscountAutomaticNode/55";
const FN = "gid://shopify/ShopifyFunction/7";
const APP = "gid://shopify/App/1";
const NOW = new Date("2026-11-20T12:00:00Z");

const ourConfig = {
  v: 1,
  windowId: "w-unset",
  percentage: "100.0",
  message: CHECKOUT_DISCOUNT_MESSAGE,
  windowStart: "2026-11-01T00:00:00",
  windowEnd: "2026-12-01T00:00:00",
};

/** Fake Admin for create: the functions list, the discountNodes
 *  inventory, discountAutomaticAppCreate, deactivate and the status-only
 *  verification read. `state.existing` pre-seeds one app discount whose
 *  config carries OUR message — the idempotency case. */
const makeCreateAdmin = (init: {
  functions?: { id: string; apiType?: string; appKey?: string | null; handle?: string | null }[];
  existing?: { id: string; status: string; config?: unknown } | null;
  createUserErrors?: { field?: string[]; message: string }[];
  stuckVerifyStatus?: string | null;
  failVerify?: boolean;
}) => {
  const state = {
    created: false,
    createCalls: 0,
    deactivateCalls: 0,
    status: "ACTIVE",
    createInput: null as any,
  };
  const admin = {
    state,
    async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
      const respond = (body: any) => ({ ok: true, status: 200, json: async () => body });
      const vars = options?.variables ?? {};
      if (query.includes("discountNodes")) {
        const nodes = init.existing
          ? [
              {
                id: init.existing.id,
                discount: {
                  __typename: "DiscountAutomaticApp",
                  status: init.existing.status,
                  appDiscountType: { functionId: FN, app: { id: APP } },
                },
                metafield: { jsonValue: init.existing.config ?? ourConfig },
              },
            ]
          : [];
        return respond({ data: { discountNodes: { nodes } } });
      }
      if (query.includes("shopifyFunctions")) {
        const nodes = (init.functions ?? [
          {
            id: FN,
            apiType: "discount",
            appKey: "04b77142ce8ad421f49735b05c7d0a86",
            handle: "checkout-shipping-discount",
          },
        ]).map((f) => ({ app: { id: APP }, title: "fn", ...f }));
        return respond({ data: { shopifyFunctions: { nodes } } });
      }
      if (query.includes("discountAutomaticAppCreate")) {
        state.createCalls += 1;
        state.createInput = vars.input;
        if (init.createUserErrors) {
          return respond({
            data: {
              discountAutomaticAppCreate: {
                automaticAppDiscount: null,
                userErrors: init.createUserErrors,
              },
            },
          });
        }
        state.created = true;
        state.status = "ACTIVE"; // a create lands ACTIVE until deactivated
        return respond({
          data: {
            discountAutomaticAppCreate: {
              automaticAppDiscount: { discountId: DID, status: "ACTIVE" },
              userErrors: [],
            },
          },
        });
      }
      if (query.includes("discountAutomaticDeactivate")) {
        state.deactivateCalls += 1;
        state.status = "EXPIRED";
        return respond({
          data: {
            discountAutomaticDeactivate: { automaticDiscountNode: { id: DID }, userErrors: [] },
          },
        });
      }
      if (query.includes("CheckoutDiscountStatus")) {
        if (init.failVerify) return respond({ errors: [{ message: "verify read fail" }] });
        return respond({
          data: {
            automaticDiscountNode: {
              id: vars.id ?? DID,
              automaticDiscount: {
                __typename: "DiscountAutomaticApp",
                status: init.stuckVerifyStatus ?? state.status,
              },
            },
          },
        });
      }
      if (query.includes("ianaTimezone")) {
        return respond({ data: { shop: { ianaTimezone: "UTC" } } });
      }
      throw new Error(`fake create admin: unhandled ${query.slice(0, 60)}`);
    },
  };
  return admin;
};

describe("resolveCheckoutFunctionId", () => {
  it("finds the app's discount Function by apiType + handle (real production shape)", async () => {
    const admin = makeCreateAdmin({});
    await expect(resolveCheckoutFunctionId(admin as any)).resolves.toBe(FN);
  });
  it("--function-id wins and never queries", async () => {
    const admin = makeCreateAdmin({ functions: [] });
    await expect(resolveCheckoutFunctionId(admin as any, "gid://fn/9")).resolves.toBe(
      "gid://fn/9",
    );
  });
  it("a discount Function with another handle does not match", async () => {
    const admin = makeCreateAdmin({
      functions: [
        {
          id: "gid://fn/other",
          apiType: "discount",
          appKey: "04b77142ce8ad421f49735b05c7d0a86",
          handle: "other-handle",
        },
      ],
    });
    await expect(resolveCheckoutFunctionId(admin as any)).rejects.toThrow(DiscountStateError);
  });
  it("appKey carrying the handle string still does not match — handle is the key", async () => {
    const admin = makeCreateAdmin({
      functions: [
        {
          id: "gid://fn/wrong",
          apiType: "discount",
          appKey: "checkout-shipping-discount",
          handle: "other-handle",
        },
      ],
    });
    await expect(resolveCheckoutFunctionId(admin as any)).rejects.toThrow(DiscountStateError);
  });
  it("no match errors — never guesses", async () => {
    const admin = makeCreateAdmin({ functions: [] });
    await expect(resolveCheckoutFunctionId(admin as any)).rejects.toThrow(DiscountStateError);
  });
  it("ambiguous match errors — never guesses", async () => {
    const admin = makeCreateAdmin({
      functions: [
        {
          id: "gid://fn/a",
          apiType: "discount",
          appKey: "04b77142ce8ad421f49735b05c7d0a86",
          handle: "checkout-shipping-discount",
        },
        {
          id: "gid://fn/b",
          apiType: "discount",
          appKey: "04b77142ce8ad421f49735b05c7d0a86",
          handle: "checkout-shipping-discount",
        },
      ],
    });
    await expect(resolveCheckoutFunctionId(admin as any)).rejects.toThrow(DiscountStateError);
  });
});

describe("createCheckoutDiscount", () => {
  it("idempotent: an existing MergeShip discount returns it, creates nothing", async () => {
    const admin = makeCreateAdmin({
      existing: { id: DID, status: "EXPIRED", config: ourConfig },
    });
    const r = await createCheckoutDiscount({
      admin: admin as any,
      shop: SHOP,
      shopTimezone: "UTC",
      now: () => NOW,
    });
    expect(r).toEqual({ id: DID, status: "EXPIRED", created: false });
    expect(admin.state.createCalls).toBe(0);
  });
  it("a foreign config message does not count as ours", async () => {
    const admin = makeCreateAdmin({
      existing: { id: DID, status: "EXPIRED", config: { ...ourConfig, message: "other app" } },
    });
    const r = await createCheckoutDiscount({
      admin: admin as any,
      shop: SHOP,
      shopTimezone: "UTC",
      now: () => NOW,
    });
    expect(r.created).toBe(true); // the foreign discount does not block create
  });
  it("creates with w-unset + requested window, deactivates, verifies EXPIRED", async () => {
    const admin = makeCreateAdmin({});
    const r = await createCheckoutDiscount({
      admin: admin as any,
      shop: SHOP,
      windowDays: 14,
      percentage: "50.0",
      shopTimezone: "UTC",
      now: () => NOW,
    });
    expect(r).toEqual({ id: DID, status: "EXPIRED", created: true });
    expect(admin.state.deactivateCalls).toBe(1);
    const cfg = JSON.parse(
      admin.state.createInput.metafields.find((m: any) => m.key === "config").value,
    );
    expect(cfg.windowId).toBe("w-unset");
    expect(cfg.percentage).toBe("50.0");
    expect(cfg.message).toBe(CHECKOUT_DISCOUNT_MESSAGE);
    expect(cfg.windowEnd).toBe("2026-12-04T12:00:00"); // now + 14d shop-local
    expect(admin.state.createInput.functionId).toBe(FN);
    expect(admin.state.createInput.discountClasses).toEqual(["SHIPPING"]);
    expect(admin.state.createInput.endsAt).toBeUndefined();
  });
  it("create userErrors fail before any deactivation", async () => {
    const admin = makeCreateAdmin({ createUserErrors: [{ message: "nope" }] });
    await expect(
      createCheckoutDiscount({ admin: admin as any, shop: SHOP, shopTimezone: "UTC" }),
    ).rejects.toThrow(DiscountStateError);
    expect(admin.state.deactivateCalls).toBe(0);
  });
  it("unverifiable deactivation throws with the shutdown command", async () => {
    const admin = makeCreateAdmin({ stuckVerifyStatus: "ACTIVE" });
    const err = await createCheckoutDiscount({
      admin: admin as any,
      shop: SHOP,
      shopTimezone: "UTC",
    }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(ShutdownNotVerifiedError);
    expect(String(err?.message)).toMatch(/shutdown --shop .* --discount-id .* --apply/);
    expect(String(err?.message)).toContain(DID);
  });
  it("rejects a non-decimal / out-of-range percentage before any call", async () => {
    const admin = makeCreateAdmin({});
    for (const p of ["0", "101", "abc", "50.55.5"]) {
      await expect(
        createCheckoutDiscount({ admin: admin as any, shop: SHOP, percentage: p }),
      ).rejects.toThrow(DiscountStateError);
    }
    expect(admin.state.createCalls).toBe(0);
  });
});

describe("w-unset can never grant (Function parity)", () => {
  const runFn = cartDeliveryOptionsDiscountsGenerateRun as (i: unknown) => { operations: any[] };
  const input = {
    cart: {
      buyerIdentity: {
        isAuthenticated: true,
        customer: {
          id: "gid://shopify/Customer/1",
          numberOfOrders: 1,
          metafield: {
            jsonValue: {
              v: 1,
              recs: [
                // a live record issued under a real w<epochMs> windowId
                { id: "111", win: "w1763227200000", dest: "k", method: "standard shipping", cur: "USD", left: 1, exp: "2099-01-01" },
              ],
            },
          },
        },
      },
      deliveryGroups: [
        {
          id: "dg1",
          deliveryAddress: {
            firstName: "J", lastName: "D", company: "", address1: "1 St", address2: "",
            city: "C", provinceCode: "NY", zip: "10001", countryCode: "US",
          },
          selectedDeliveryOption: {
            handle: "o1", title: "Standard Shipping", deliveryMethodType: "SHIPPING",
            cost: { amount: "8.00", currencyCode: "USD" },
          },
          deliveryOptions: [
            {
              handle: "o1", title: "Standard Shipping", deliveryMethodType: "SHIPPING",
              cost: { amount: "8.00", currencyCode: "USD" },
            },
          ],
        },
      ],
    },
    discount: {
      discountClasses: ["SHIPPING"],
      metafield: {
        jsonValue: {
          v: 1, windowId: "w-unset", percentage: "100.0",
          message: CHECKOUT_DISCOUNT_MESSAGE,
          windowStart: "2026-11-01T00:00:00", windowEnd: "2099-01-01T00:00:00",
        },
      },
    },
    shop: { localTime: { date: "2026-11-20", inWindow: true } },
  };
  it("a discount whose config windowId is w-unset grants nothing even with a live record", () => {
    expect(runFn(input)).toEqual({ operations: [] });
  });
});
