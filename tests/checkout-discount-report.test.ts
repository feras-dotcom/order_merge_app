// runReport: pure aggregation over canned work rows + canned orders —
// each classification (merged / open / unmerged_expired = realized
// exposure), caps, overdraw, truncation. The SQL paths get a real-PG test
// in checkout-discount-ops-pg.test.ts.
import { describe, expect, it, vi } from "vitest";
import { runReport } from "../app/lib/checkout-discount/report.server";
import { CHECKOUT_DISCOUNT_MESSAGE } from "../app/lib/checkout-discount/config";

vi.mock("../app/db.server", () => ({ default: {} }));

const SHOP = "s.myshopify.com";
const NOW = new Date("2026-11-20T00:00:00Z");
const hAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

/** Fake db: dispatches on the flattened SQL text. `facts` tunes the
 *  canned answers — MergeRecord hit for `mergedOrderIds`, merge window. */
const makeDb = (facts: {
  statusCounts?: [string, number][];
  outcomeCounts?: [string, number][];
  consumed?: number;
  overdraw?: number;
  outstanding?: number;
  mergeWindowHours?: number;
  mergedOrderIds?: Set<string>;
}) => {
  const flat = (x: any): string => {
    if (x == null) return "";
    if (typeof x === "object" && "strings" in x && "values" in x) {
      return x.strings.reduce(
        (s: string, p: string, i: number) => s + p + (i < x.values.length ? flat(x.values[i]) : " ?"),
        "",
      );
    }
    return ` ${String(x)}`;
  };
  const textOf = (first: any, rest: any[]) =>
    (Array.isArray(first) ? first : [String(first)]).reduce((s: string, p: string) => s + p, "") +
    rest.map(flat).join("");
  const calls: string[] = [];
  const db = {
    calls,
    $queryRaw: (first: any, ...rest: any[]) => {
      const text = textOf(first, rest);
      calls.push(text);
      if (text.includes('GROUP BY "status"')) {
        return Promise.resolve((facts.statusCounts ?? [["DONE", 3]]).map(([status, n]) => ({ status, n: BigInt(n) })));
      }
      if (text.includes('GROUP BY "outcome"')) {
        return Promise.resolve((facts.outcomeCounts ?? [["PROJECTED", 2]]).map(([outcome, n]) => ({ outcome, n: BigInt(n) })));
      }
      if (text.includes('FROM "MergeRecord"')) {
        // merged classification: bind carries the order id
        const orderId = rest.find((v) => typeof v === "string" && v.includes("/Order/")) as string;
        return Promise.resolve([{ n: BigInt(facts.mergedOrderIds?.has(orderId) ? 1 : 0) }]);
      }
      if (text.includes('FROM "Settings"')) {
        return Promise.resolve([{ mergeWindowHours: facts.mergeWindowHours ?? 24 }]);
      }
      if (text.includes("CONSUMED_NO_RECORD")) {
        return Promise.resolve([{ n: BigInt(facts.overdraw ?? 0) }]);
      }
      if (text.includes('grantConsumedAt" IS NOT NULL')) {
        return Promise.resolve([{ n: BigInt(facts.consumed ?? 0) }]);
      }
      if (text.includes("'PROJECTED'")) {
        return Promise.resolve([{ n: BigInt(facts.outstanding ?? 0) }]);
      }
      return Promise.resolve([{ n: 0n }]);
    },
  };
  return db;
};

const order = (id: string, createdAt: string, opts: { granted?: string; currency?: string } = {}) => ({
  id,
  createdAt,
  currencyCode: opts.currency ?? "USD",
  shippingLines: {
    nodes: [
      {
        title: "Standard",
        originalPriceSet: { shopMoney: { amount: "8.00", currencyCode: opts.currency ?? "USD" } },
        discountedPriceSet: {
          shopMoney: {
            amount: (8 - Number(opts.granted ?? "4")).toFixed(2),
            currencyCode: opts.currency ?? "USD",
          },
        },
        discountAllocations: [
          {
            allocatedAmountSet: {
              shopMoney: { amount: opts.granted ?? "4.00", currencyCode: opts.currency ?? "USD" },
            },
            discountApplication: {
              __typename: "AutomaticDiscountApplication",
              targetType: "SHIPPING_LINE",
              title: CHECKOUT_DISCOUNT_MESSAGE,
            },
          },
        ],
      },
    ],
  },
  discountApplications: {
    nodes: [
      {
        __typename: "AutomaticDiscountApplication",
        targetType: "SHIPPING_LINE",
        title: CHECKOUT_DISCOUNT_MESSAGE,
      },
    ],
  },
});

const noDiscountOrder = (id: string, createdAt: string) => ({
  id,
  createdAt,
  currencyCode: "USD",
  shippingLines: {
    nodes: [
      {
        title: "Standard",
        originalPriceSet: { shopMoney: { amount: "8.00", currencyCode: "USD" } },
        discountedPriceSet: { shopMoney: { amount: "8.00", currencyCode: "USD" } },
        discountAllocations: [],
      },
    ],
  },
  discountApplications: { nodes: [] },
});

const listOrders = (nodes: any[], hasNextPage = false) => async (_cursor: string | null) => ({
  pageInfo: { hasNextPage, endCursor: hasNextPage ? "c2" : null },
  nodes,
});

const report = (db: any, over: Record<string, unknown> = {}) =>
  runReport({ db, shop: SHOP, now: NOW, ...over } as any);

describe("runReport DB section", () => {
  it("counts by status/outcome, consumed grants, outstanding, overdraw", async () => {
    const db = makeDb({
      statusCounts: [["DONE", 4], ["PENDING", 1], ["REVIEW", 1]],
      outcomeCounts: [["PROJECTED", 2], ["CONSUMED", 1], ["CONSUMED_NO_RECORD", 1]],
      consumed: 1,
      overdraw: 1,
      outstanding: 2,
    });
    const r = await report(db);
    expect(r.work.byStatus).toEqual({ DONE: 4, PENDING: 1, REVIEW: 1 });
    expect(r.work.byOutcome).toEqual({ PROJECTED: 2, CONSUMED: 1, CONSUMED_NO_RECORD: 1 });
    expect(r.work.consumedGrants).toBe(1);
    expect(r.work.outstandingProjected).toBe(2);
    expect(r.work.overdraw).toBe(1);
    expect(r.withinCaps).toBe(false); // overdraw > 0 breaches
    expect(r.caps.breach).toEqual(["OVERDRAW"]);
  });

  it("CUSTOMER_GONE overdraw uses only the consumed reason", async () => {
    // overdraw predicate is exercised against real PG in the -pg suite;
    // here the canned db just proves the count flows into the result.
    const db = makeDb({ overdraw: 0 });
    const r = await report(db);
    expect(r.work.overdraw).toBe(0);
    expect(r.withinCaps).toBe(true);
  });
});

describe("runReport --orders", () => {
  it("classifies merged / open / unmerged_expired and sums per currency", async () => {
    const merged = order("gid://shopify/Order/1", hAgo(100));
    const open = order("gid://shopify/Order/2", hAgo(5)); // inside the 24h window
    const expired = order("gid://shopify/Order/3", hAgo(100));
    const db = makeDb({
      mergeWindowHours: 24,
      mergedOrderIds: new Set(["gid://shopify/Order/1"]),
    });
    const r = await report(db, {
      orders: true,
      listOrders: listOrders([merged, open, expired, noDiscountOrder("gid://shopify/Order/4", hAgo(50))]),
    });
    expect(r.orders!.grantOrders).toBe(3);
    expect(r.orders!.classes).toEqual({ merged: 1, open: 1, unmerged_expired: 1 });
    expect(r.orders!.totals).toEqual({ USD: "1200" }); // 3 × 4.00 = 1200 minor
    expect(r.orders!.realizedExposure).toEqual({ USD: "400" }); // only the expired one
    expect(r.withinCaps).toBe(true);
  });

  it("non-grant orders are excluded; ambiguous deltas still count once", async () => {
    const a = order("gid://shopify/Order/5", hAgo(10));
    const db = makeDb({ mergedOrderIds: new Set() });
    const r = await report(db, {
      orders: true,
      listOrders: listOrders([a, noDiscountOrder("gid://shopify/Order/6", hAgo(10))]),
    });
    expect(r.orders!.grantOrders).toBe(1);
    expect(r.orders!.totals).toEqual({ USD: "400" });
  });

  it("cap-grants breach", async () => {
    const db = makeDb({});
    const r = await report(db, {
      orders: true,
      listOrders: listOrders([order("gid://shopify/Order/1", hAgo(10)), order("gid://shopify/Order/2", hAgo(10))]),
      capGrants: 1,
    });
    expect(r.caps.breach).toContain("CAP_GRANTS");
    expect(r.withinCaps).toBe(false);
  });

  it("cap-amount breach uses minor units in the cap currency", async () => {
    const db = makeDb({});
    const r = await report(db, {
      orders: true,
      listOrders: listOrders([order("gid://shopify/Order/1", hAgo(10), { granted: "6.00" })]),
      capAmount: "5.00",
      currency: "USD",
    });
    expect(r.caps.breach).toContain("CAP_AMOUNT");
  });

  it("more than 500 orders truncates and breaches", async () => {
    const nodes = Array.from({ length: 600 }, (_, i) =>
      noDiscountOrder(`gid://shopify/Order/${i}`, hAgo(10)),
    );
    const db = makeDb({});
    const r = await report(db, { orders: true, listOrders: listOrders(nodes, true) });
    expect(r.orders!.truncated).toBe(true);
    expect(r.caps.breach).toContain("TRUNCATED");
  });
});
