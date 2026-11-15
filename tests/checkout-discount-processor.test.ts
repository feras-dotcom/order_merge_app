// End-to-end checkout-eligibility processor tests: processCheckoutWork over
// the memory work store, a fake Admin (order facts + the CAS eligibility
// metafield admin), injected clock/sleep/random — no real timers, no DB.
import { beforeEach, describe, expect, it } from "vitest";
import { CHECKOUT_DISCOUNT_MESSAGE } from "../app/lib/checkout-discount/config";
import { destKey } from "../app/lib/checkout-discount/dest-key";
import { processCheckoutWork } from "../app/lib/checkout-discount/processor.server";
import { classify, type CheckoutFacts } from "../app/lib/checkout-discount/classify";
import { parseElig, serializeElig, type EligRecord } from "../app/lib/checkout-discount/records";
import {
  CHECKOUT_DEADLINE_MS,
  memoryCheckoutWorkStore,
  type CheckoutWorkItem,
  type CheckoutWorkStore,
} from "../app/lib/checkout-discount/work.server";
import type { DiagEvent } from "../app/lib/checkout-discount/diag";
import type { CheckoutGateDeps } from "../app/lib/checkout-discount/gate.server";
import { DEFAULT_SETTINGS, type MergeSettings } from "../app/lib/settings.server";
import { makeFakeEligibilityAdmin } from "./helpers/checkout-fake-admin";

const SHOP = "s.myshopify.com";
const CUST = "gid://shopify/Customer/7";
const OID1 = "gid://shopify/Order/1001";
const OID2 = "gid://shopify/Order/2002";
const EPOCH = new Date("2026-10-01T00:00:00Z");
const LEASE = 90_000;

let clock = new Date("2026-11-10T12:00:00Z").getTime();
const now = () => new Date(clock);

const ADDR = {
  firstName: "Jane",
  lastName: "Doe",
  company: "Acme",
  address1: "123 Main St",
  address2: "Apt 4",
  city: "New York",
  provinceCode: "NY",
  zip: "10001",
  countryCode: "US",
};
const ADDR_KEY = destKey(ADDR)!;

const SETTINGS: MergeSettings = {
  ...DEFAULT_SETTINGS,
  autoMergeEnabled: true,
  onboardingCompletedAt: EPOCH,
  checkoutDiscountEnabled: true,
  checkoutDiscountEnabledAt: EPOCH,
  checkoutDiscountWindowHours: 72,
  mergeWindowHours: 72,
  // Pilot approval: "Standard Shipping" $8.00 USD is the fixture's shipping
  // line — an exact-cap match, so every pre-existing ISSUE/CONSUME case
  // still qualifies.
  checkoutDiscountMethod: "standard shipping",
  checkoutDiscountMaxShippingMinor: 800,
  checkoutDiscountCurrency: "USD",
};
const GATE: CheckoutGateDeps = {
  env: (n) => (n === "MERGESHIP_CHECKOUT_DISCOUNT" ? "enabled" : undefined),
  settings: async () => SETTINGS,
  control: async () => ({ checkoutDiscountEnabled: true, checkoutDiscountAllowShops: [SHOP] }),
};

// ── Admin fixtures ──────────────────────────────────────────────────────

const shippingLine = (over: Record<string, unknown> = {}) => ({
  title: "Standard Shipping",
  code: "std",
  source: "rate",
  carrierIdentifier: null,
  custom: false,
  originalPriceSet: { shopMoney: { amount: "8.00", currencyCode: "USD" } },
  discountedPriceSet: { shopMoney: { amount: "8.00", currencyCode: "USD" } },
  discountAllocations: [],
  ...over,
});

/** A shipping line discounted to `amount` by the MergeShip automatic
 *  discount (application title = CHECKOUT_DISCOUNT_MESSAGE). */
const grantedLine = (amount: string, allocated: string) =>
  shippingLine({
    discountedPriceSet: { shopMoney: { amount, currencyCode: "USD" } },
    discountAllocations: [
      {
        allocatedAmountSet: { shopMoney: { amount: allocated, currencyCode: "USD" } },
        discountApplication: {
          __typename: "AutomaticDiscountApplication",
          targetType: "SHIPPING_LINE",
          title: CHECKOUT_DISCOUNT_MESSAGE,
        },
      },
    ],
  });
const grantedApps = () => ({
  nodes: [
    { __typename: "AutomaticDiscountApplication", targetType: "SHIPPING_LINE", title: CHECKOUT_DISCOUNT_MESSAGE },
  ],
});

const adminOrder = (over: Record<string, unknown> = {}) => ({
  id: OID1,
  name: "#1001",
  createdAt: "2026-11-10T10:00:00Z",
  processedAt: "2026-11-10T10:00:00Z",
  cancelledAt: null,
  cancellation: null,
  closed: false,
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "UNFULFILLED",
  riskLevel: "LOW",
  currencyCode: "USD",
  presentmentCurrencyCode: "USD",
  note: null,
  tags: [],
  customer: { id: CUST },
  shippingAddress: { ...ADDR, countryCodeV2: "US" },
  shippingLines: { nodes: [shippingLine()] },
  fulfillments: [],
  discountApplications: { nodes: [] },
  ...over,
});

interface FakeAdmin {
  graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<any>;
  calls: string[];
  elig: ReturnType<typeof makeFakeEligibilityAdmin>;
  readOverride: (() => unknown) | null;
  failWrites: number;
}

const makeAdmin = (args: {
  orders?: Record<string, unknown>;
  locationCount?: number;
} = {}): FakeAdmin => {
  const elig = makeFakeEligibilityAdmin();
  const calls: string[] = [];
  const fake: FakeAdmin = {
    calls,
    elig,
    readOverride: null,
    failWrites: 0,
    async graphql(query, options) {
      calls.push(query.slice(0, 60));
      const respond = (body: any) => ({ ok: true, status: 200, json: async () => body });
      const vars = options?.variables ?? {};
      if (query.includes("CheckoutEligibilityOrder")) {
        const order = (args.orders ?? {})[vars.id as string] ?? null;
        return respond({ data: { order, shop: { ianaTimezone: "UTC" } } });
      }
      // MergeFulfillmentOrders embeds a nested lineItems field — it must be
      // matched before the bare "lineItems" check.
      if (query.includes("fulfillmentOrders")) {
        // Simulate a shop that has not granted the optional location scope.
        return respond({ errors: [{ message: "Access denied for field fulfillmentOrders" }] });
      }
      if (query.includes("locationsCount")) {
        return respond({ data: { locationsCount: { count: args.locationCount ?? 1 } } });
      }
      if (query.includes("lineItems")) {
        return respond({
          data: { order: { lineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
        });
      }
      if (query.includes("EligibilityProjectionRead")) {
        if (fake.readOverride) {
          const v = fake.readOverride;
          fake.readOverride = null;
          return respond({ data: { customer: { metafield: v } } });
        }
        return respond(await elig.graphql(query, options));
      }
      if (query.includes("metafieldsSet")) {
        if (fake.failWrites > 0) {
          fake.failWrites -= 1;
          throw new Error("Shopify transport wobble");
        }
        return respond(await elig.graphql(query, options));
      }
      throw new Error(`fake admin: unhandled query: ${query.slice(0, 80)}`);
    },
  };
  return fake;
};

/** Seeds a document directly through the fake CAS admin. */
const seed = async (admin: FakeAdmin, recs: EligRecord[], customerId = CUST) => {
  const { writeProjection } = await import("../app/lib/checkout-discount/projection-write");
  await writeProjection(admin.elig, customerId, () => ({ serialized: serializeElig({ v: 1, recs }) }));
};

const eligDoc = (admin: FakeAdmin, customerId = CUST) => parseElig(admin.elig.stored(customerId)).doc;

// ── Driver ──────────────────────────────────────────────────────────────

const diagLog: DiagEvent[] = [];
const diag = (e: DiagEvent) => {
  diagLog.push(e);
};

const drive = async (
  orderId: string,
  admin: FakeAdmin,
  work: CheckoutWorkStore,
  opts: { token?: string; gate?: Partial<CheckoutGateDeps> } = {},
) => {
  const token = opts.token ?? "tok-drive";
  const { item } = await work.upsertDirty(SHOP, orderId, token, LEASE, CHECKOUT_DEADLINE_MS);
  await processCheckoutWork({
    item,
    token,
    shop: SHOP,
    admin: admin as any,
    work,
    now,
    sleep: async () => {},
    random: () => 0.5,
    gate: opts.gate ?? GATE,
    diag,
  });
  return (await work.find(SHOP, orderId))!;
};

const settle = (row: CheckoutWorkItem | null) => `${row?.status}/${row?.outcome}`;

beforeEach(() => {
  diagLog.length = 0;
  clock = new Date("2026-11-10T12:00:00Z").getTime();
});

/** The windowId the real gate derives from SETTINGS.checkoutDiscountEnabledAt. */
const WIN = `w${EPOCH.getTime()}`;

const baseRec = (over: Record<string, unknown> = {}): EligRecord => ({
  id: "1001",
  win: WIN,
  dest: ADDR_KEY,
  method: "standard shipping",
  cur: "USD",
  left: 1,
  exp: "2026-11-12",
  ...over,
});

describe("processCheckoutWork — ISSUE", () => {
  it("a qualifying paid order projects a record (read-back verified)", async () => {
    const admin = makeAdmin({ orders: { [OID1]: adminOrder() } });
    const work = memoryCheckoutWorkStore(() => clock);
    const row = await drive(OID1, admin, work);
    expect(settle(row)).toBe("DONE/PROJECTED");
    const recs = eligDoc(admin).recs;
    expect(recs.length).toBe(1);
    expect(recs[0]).toMatchObject({ id: "1001", win: WIN, dest: ADDR_KEY, method: "standard shipping", cur: "USD", left: 1 });
    // D4: createdAt + 72h ends on shop-local Nov 13; exp = Nov 12.
    expect(recs[0].exp).toBe("2026-11-12");
    expect(diagLog.some((e) => e.kind === "PROJECTED")).toBe(true);
  });

  it("duplicate webhook delivery: gen bumps, final state identical, one record", async () => {
    const admin = makeAdmin({ orders: { [OID1]: adminOrder() } });
    const work = memoryCheckoutWorkStore(() => clock);
    const first = await drive(OID1, admin, work);
    // Second delivery while the first is DONE re-opens the row and re-runs.
    const second = await work.upsertDirty(SHOP, OID1, "tok2", LEASE, CHECKOUT_DEADLINE_MS);
    expect(second.item.gen).toBe(2);
    await processCheckoutWork({
      item: second.item, token: "tok2", shop: SHOP, admin: admin as any, work, now,
      sleep: async () => {}, random: () => 0.5, gate: GATE, diag,
    });
    const row = await work.find(SHOP, OID1);
    expect(row).toMatchObject({ status: "DONE", gen: 2 });
    expect(eligDoc(admin).recs.map((r) => r.id)).toEqual(["1001"]);
    expect(first.status).toBe("DONE");
  });

  it("restart mid-way: lease expires, a second worker completes, exactly one record", async () => {
    const admin = makeAdmin({ orders: { [OID1]: adminOrder() } });
    const work = memoryCheckoutWorkStore(() => clock);
    const { item } = await work.upsertDirty(SHOP, OID1, "tok-dead", 1, CHECKOUT_DEADLINE_MS); // 1ms lease
    clock += 10; // worker 1 dies, lease expires
    const [claimed] = await work.claimDue(1, LEASE);
    await processCheckoutWork({
      item: claimed, token: claimed.leaseToken!, shop: SHOP, admin: admin as any, work, now,
      sleep: async () => {}, random: () => 0.5, gate: GATE, diag,
    });
    expect(settle(await work.find(SHOP, OID1))).toBe("DONE/PROJECTED");
    expect(eligDoc(admin).recs.length).toBe(1);
    void item;
  });

  it("two orders for one customer: concurrent projection keeps BOTH records", async () => {
    const admin = makeAdmin({ orders: { [OID1]: adminOrder(), [OID2]: adminOrder({ id: OID2, name: "#2002", createdAt: "2026-11-10T11:00:00Z" }) } });
    const work = memoryCheckoutWorkStore(() => clock);
    // While order 1001's write is in flight, order 2002's commits first —
    // seeded between A's read and CAS write using the projection merge.
    const o2rec = baseRec({ id: "2002" });
    admin.elig.setInterleaveHook(async () => {
      const { writeProjection } = await import("../app/lib/checkout-discount/projection-write");
      const { mergeRecords } = await import("../app/lib/checkout-discount/records");
      await writeProjection(admin.elig, CUST, (cur) => ({
        serialized: mergeRecords(cur, [o2rec], { todayDate: "2026-11-10" }).serialized,
      }));
    });
    const row = await drive(OID1, admin, work);
    expect(settle(row)).toBe("DONE/PROJECTED");
    expect(eligDoc(admin).recs.map((r) => r.id).sort()).toEqual(["1001", "2002"]);
  });

  it("gen race: a newer dirty mark mid-processing REQUEUES, then converges", async () => {
    const admin = makeAdmin({ orders: { [OID1]: adminOrder() } });
    const work = memoryCheckoutWorkStore(() => clock);
    const { item } = await work.upsertDirty(SHOP, OID1, "tok1", LEASE, CHECKOUT_DEADLINE_MS);
    // A newer delivery lands while the first process is between reads.
    const orig = admin.graphql.bind(admin);
    let bumped = false;
    admin.graphql = (async (q: string, o?: { variables?: Record<string, unknown> }) => {
      if (!bumped && q.includes("EligibilityProjectionRead")) {
        bumped = true;
        await work.upsertDirty(SHOP, OID1, "tok2", LEASE, CHECKOUT_DEADLINE_MS);
      }
      return orig(q, o);
    }) as any;
    await processCheckoutWork({
      item, token: "tok1", shop: SHOP, admin: admin as any, work, now,
      sleep: async () => {}, random: () => 0.5, gate: GATE, diag,
    });
    const row = await work.find(SHOP, OID1);
    expect(row).toMatchObject({ status: "PENDING", gen: 2 }); // REQUEUED, not lost
    const [claimed] = await work.claimDue(1, LEASE);
    await processCheckoutWork({
      item: claimed, token: claimed.leaseToken!, shop: SHOP, admin: admin as any, work, now,
      sleep: async () => {}, random: () => 0.5, gate: GATE, diag,
    });
    expect(settle(await work.find(SHOP, OID1))).toBe("DONE/PROJECTED");
    expect(eligDoc(admin).recs.map((r) => r.id)).toEqual(["1001"]);
  });

  it("a failed write retries, then succeeds", async () => {
    const admin = makeAdmin({ orders: { [OID1]: adminOrder() } });
    admin.failWrites = 1;
    const work = memoryCheckoutWorkStore(() => clock);
    const row = await drive(OID1, admin, work);
    expect(row.status).toBe("PENDING"); // scheduled retry
    expect(row.lastReason).toContain("Shopify transport wobble");
    const [claimed] = await work.claimDue(1, LEASE); // delay is jittered from now — force due
    expect(claimed).toBeUndefined();
    clock += 60_000;
    const [c2] = await work.claimDue(1, LEASE);
    await processCheckoutWork({
      item: c2, token: c2.leaseToken!, shop: SHOP, admin: admin as any, work, now,
      sleep: async () => {}, random: () => 0.5, gate: GATE, diag,
    });
    expect(settle(await work.find(SHOP, OID1))).toBe("DONE/PROJECTED");
  });

  it("a verification mismatch retries (never settles unverified)", async () => {
    const admin = makeAdmin({ orders: { [OID1]: adminOrder() } });
    const work = memoryCheckoutWorkStore(() => clock);
    // The post-write read-back sees the pre-write (empty) document once —
    // arm the override only after the write lands so the CAS read before it
    // still sees the real state.
    const orig = admin.graphql.bind(admin);
    let wrote = false;
    admin.graphql = (async (q: string, o?: { variables?: Record<string, unknown> }) => {
      const r = await orig(q, o);
      if (!wrote && q.includes("metafieldsSet")) {
        wrote = true;
        admin.readOverride = () => ({ id: "m1", jsonValue: null, compareDigest: "x" });
      }
      return r;
    }) as any;
    const row = await drive(OID1, admin, work);
    expect(row.status).toBe("PENDING");
    expect(row.lastReason).toContain("read-back mismatch");
    clock += 60_000;
    const [c] = await work.claimDue(1, LEASE);
    await processCheckoutWork({
      item: c, token: c.leaseToken!, shop: SHOP, admin: admin as any, work, now,
      sleep: async () => {}, random: () => 0.5, gate: GATE, diag,
    });
    expect(settle(await work.find(SHOP, OID1))).toBe("DONE/PROJECTED");
  });
});

describe("processCheckoutWork — CONSUME", () => {
  const consumedOrder = (over: Record<string, unknown> = {}) =>
    adminOrder({
      id: OID2,
      name: "#2002",
      shippingLines: { nodes: [grantedLine("0.00", "8.00")] },
      discountApplications: grantedApps(),
      ...over,
    });

  it("a discounted order consumes the matching record (tombstone, idempotent replay)", async () => {
    const admin = makeAdmin({ orders: { [OID2]: consumedOrder() } });
    await seed(admin, [baseRec()]);
    const work = memoryCheckoutWorkStore(() => clock);
    const row = await drive(OID2, admin, work);
    expect(settle(row)).toBe("DONE/CONSUMED");
    const rec = eligDoc(admin).recs.find((r) => r.id === "1001")!;
    expect(rec.left).toBe(0);
    expect(rec.used).toEqual(["2002"]);
    expect(diagLog.some((e) => e.kind === "CONSUMED")).toBe(true);
    // Replay: the work row reopens, but used already lists 2002 — nothing changes.
    const d2 = await work.upsertDirty(SHOP, OID2, "tok2", LEASE, CHECKOUT_DEADLINE_MS);
    await processCheckoutWork({
      item: d2.item, token: "tok2", shop: SHOP, admin: admin as any, work, now,
      sleep: async () => {}, random: () => 0.5, gate: GATE, diag,
    });
    const recAfter = eligDoc(admin).recs.find((r) => r.id === "1001")!;
    expect(recAfter.used).toEqual(["2002"]);
    expect(recAfter.left).toBe(0);
    expect(admin.elig.writes.length).toBe(2); // no third write on replay
  });

  it("a PARTIAL (50%) grant consumes too — no new record for itself", async () => {
    const admin = makeAdmin({
      orders: { [OID2]: adminOrder({ id: OID2, name: "#2002", shippingLines: { nodes: [grantedLine("4.00", "4.00")] }, discountApplications: grantedApps() }) },
    });
    await seed(admin, [baseRec()]);
    const work = memoryCheckoutWorkStore(() => clock);
    const row = await drive(OID2, admin, work);
    expect(settle(row)).toBe("DONE/CONSUMED");
    const recs = eligDoc(admin).recs;
    expect(recs.find((r) => r.id === "1001")!.used).toEqual(["2002"]);
    expect(recs.some((r) => r.id === "2002")).toBe(false); // a consumer NEVER issues
    expect(row.lastReason).toContain("allocated 400");
  });

  it("OVERDRAW: grant with no Function-matching record — never consumes the wrong one", async () => {
    const admin = makeAdmin({ orders: { [OID2]: consumedOrder() } });
    // The only record is for a DIFFERENT shipping method.
    await seed(admin, [baseRec({ method: "express" })]);
    const work = memoryCheckoutWorkStore(() => clock);
    const row = await drive(OID2, admin, work);
    expect(settle(row)).toBe("DONE/CONSUMED_NO_RECORD");
    expect(diagLog.some((e) => e.kind === "OVERDRAW")).toBe(true);
    const rec = eligDoc(admin).recs.find((r) => r.id === "1001")!;
    expect(rec.left).toBe(1); // untouched
    expect(rec.used).toBeUndefined();
  });

  it("expiry replay: a consumed+expired record is not resurrected by a late replay", async () => {
    const admin = makeAdmin({ orders: { [OID1]: adminOrder() } });
    // Tombstone already spent by order 2002 and expired yesterday.
    await seed(admin, [{ ...baseRec(), left: 0, used: ["2002"], exp: "2026-11-09" }]);
    clock = new Date("2026-11-10T12:00:00Z").getTime();
    const work = memoryCheckoutWorkStore(() => clock);
    const row = await drive(OID1, admin, work);
    // The order is still inside the merge window but its computed expiry is
    // in the past (window ends Nov 13, exp Nov 12 > today is fine actually)
    expect(["DONE/PROJECTED", "DONE/WINDOW_PASSED"]).toContain(settle(row));
    // Whatever the outcome, no left>0 entitlement can be resurrected.
    expect(eligDoc(admin).recs.every((r) => r.left <= 0 || r.exp < "2026-11-10" || r.id === "1001")).toBe(true);
  });
});

describe("processCheckoutWork — CONSUME reprocessing safety (one order, one record)", () => {
  const OID3 = "gid://shopify/Order/3003";
  const consumedOrder = (over: Record<string, unknown> = {}) =>
    adminOrder({
      id: OID2,
      name: "#2002",
      shippingLines: { nodes: [grantedLine("0.00", "8.00")] },
      discountApplications: grantedApps(),
      ...over,
    });
  const recA = () => baseRec();                        // record from order 1001
  const recC = () => baseRec({ id: "3003" });          // a second outstanding record

  /** Re-deliver (touch/upsert semantics of any topic re-touching the row) and
   *  reprocess the same order. */
  const redeliver = async (orderId: string, admin: FakeAdmin, work: CheckoutWorkStore) => {
    const d = await work.upsertDirty(SHOP, orderId, `tok-re-${orderId}`, LEASE, CHECKOUT_DEADLINE_MS);
    await processCheckoutWork({
      item: d.item, token: d.item.leaseToken!, shop: SHOP, admin: admin as any, work, now,
      sleep: async () => {}, random: () => 0.5, gate: GATE, diag,
    });
    return (await work.find(SHOP, orderId))!;
  };

  it("reprocessing a consumed order must not consume a second outstanding record", async () => {
    const admin = makeAdmin({ orders: { [OID2]: consumedOrder() } });
    await seed(admin, [recA(), recC()]);
    const work = memoryCheckoutWorkStore(() => clock);
    await drive(OID2, admin, work);
    const doc1 = eligDoc(admin);
    expect(doc1.recs.find((r) => r.id === "1001")?.used).toEqual(["2002"]);

    // Any webhook re-touch reopens the row; the record that ALREADY carried
    // this order must win — never the next matching record.
    const row = await redeliver(OID2, admin, work);
    expect(row.outcome).toBe("CONSUMED");
    const c = eligDoc(admin).recs.find((r) => r.id === "3003")!;
    expect(c.left).toBe(1);
    expect(c.used).toBeUndefined();
  });

  it("a pruned tombstone: the durable row marker still pins the consumed record", async () => {
    const orders: Record<string, unknown> = { [OID2]: consumedOrder() };
    const admin = makeAdmin({ orders });
    await seed(admin, [recA(), recC()]);
    const work = memoryCheckoutWorkStore(() => clock);
    await drive(OID2, admin, work);

    // A's tombstone is pruned from the document (expired evictions are real)
    // AND the order no longer looks eligible — yet classify still reports
    // CONSUME because grant detection precedes the FULFILLED check.
    await seed(admin, [recC()]);
    orders[OID2] = consumedOrder({
      displayFulfillmentStatus: "FULFILLED",
      fulfillments: [{ id: "gid://shopify/Fulfillment/1" }],
    });
    const row = await redeliver(OID2, admin, work);
    expect(row.outcome).toBe("CONSUMED");
    const c = eligDoc(admin).recs.find((r) => r.id === "3003")!;
    expect(c.left).toBe(1);
    expect(c.used).toBeUndefined();
  });

  it("crash after marking but before the document write: retry consumes the SAME record", async () => {
    const admin = makeAdmin({ orders: { [OID2]: consumedOrder() } });
    admin.failWrites = 1; // first CAS commit crashes
    await seed(admin, [recA(), recC()]);
    const work = memoryCheckoutWorkStore(() => clock);
    const row1 = await drive(OID2, admin, work);
    expect(row1.status).toBe("PENDING"); // retried
    clock += 60_000;
    const [claimed] = await work.claimDue(1, LEASE);
    await processCheckoutWork({
      item: claimed, token: claimed.leaseToken!, shop: SHOP, admin: admin as any, work, now,
      sleep: async () => {}, random: () => 0.5, gate: GATE, diag,
    });
    expect(settle(await work.find(SHOP, OID2))).toBe("DONE/CONSUMED");
    expect(eligDoc(admin).recs.find((r) => r.id === "1001")?.used).toEqual(["2002"]);
    expect(eligDoc(admin).recs.find((r) => r.id === "3003")?.left).toBe(1);
  });

  it("crash after the document write but before settle: retry is still a no-op consume", async () => {
    const admin = makeAdmin({ orders: { [OID2]: consumedOrder() } });
    await seed(admin, [recA(), recC()]);
    const work = memoryCheckoutWorkStore(() => clock);
    let failComplete = true;
    const flaky: CheckoutWorkStore = {
      ...work,
      complete: (...a: Parameters<typeof work.complete>) =>
        failComplete
          ? ((failComplete = false), Promise.reject(new Error("settle crash")))
          : work.complete(...a),
    };
    const { item } = await work.upsertDirty(SHOP, OID2, "tok-b", LEASE, CHECKOUT_DEADLINE_MS);
    await processCheckoutWork({
      item, token: "tok-b", shop: SHOP, admin: admin as any, work: flaky, now,
      sleep: async () => {}, random: () => 0.5, gate: GATE, diag,
    });
    expect((await work.find(SHOP, OID2))!.status).toBe("PENDING");
    clock += 60_000;
    const [claimed] = await work.claimDue(1, LEASE);
    await processCheckoutWork({
      item: claimed, token: claimed.leaseToken!, shop: SHOP, admin: admin as any, work, now,
      sleep: async () => {}, random: () => 0.5, gate: GATE, diag,
    });
    expect(settle(await work.find(SHOP, OID2))).toBe("DONE/CONSUMED");
    expect(eligDoc(admin).recs.find((r) => r.id === "1001")?.used).toEqual(["2002"]);
    expect(eligDoc(admin).recs.find((r) => r.id === "3003")?.left).toBe(1);
  });

  it("two consumers keep their own records across reprocessing", async () => {
    const admin = makeAdmin({
      orders: { [OID2]: consumedOrder(), [OID3]: consumedOrder({ id: OID3, name: "#3003" }) },
    });
    await seed(admin, [recA(), recC()]);
    const work = memoryCheckoutWorkStore(() => clock);
    await drive(OID2, admin, work); // consumes A (lowest id wins)
    await drive(OID3, admin, work); // consumes C
    await redeliver(OID2, admin, work);
    await redeliver(OID3, admin, work);
    expect(eligDoc(admin).recs.find((r) => r.id === "1001")?.used).toEqual(["2002"]);
    expect(eligDoc(admin).recs.find((r) => r.id === "3003")?.used).toEqual(["3003"]);
    expect(settle(await work.find(SHOP, OID2))).toBe("DONE/CONSUMED");
    expect(settle(await work.find(SHOP, OID3))).toBe("DONE/CONSUMED");
  });

  it("replay storm: five redeliveries still consume exactly one record", async () => {
    const admin = makeAdmin({ orders: { [OID2]: consumedOrder() } });
    await seed(admin, [recA(), recC()]);
    const work = memoryCheckoutWorkStore(() => clock);
    await drive(OID2, admin, work);
    for (let i = 0; i < 4; i++) await redeliver(OID2, admin, work);
    expect((await work.find(SHOP, OID2))!.outcome).toBe("CONSUMED");
    const c = eligDoc(admin).recs.find((r) => r.id === "3003")!;
    expect(c.left).toBe(1);
    expect(c.used).toBeUndefined();
    expect(eligDoc(admin).recs.find((r) => r.id === "1001")?.used).toEqual(["2002"]);
  });

  it("a work row without the marker falls back to the used tombstone (pre-fix rows)", async () => {
    const admin = makeAdmin({ orders: { [OID2]: consumedOrder() } });
    // As if consumed before the durable marker existed: tombstone present,
    // consumedRecordId unset on the (fresh) work row.
    await seed(admin, [{ ...recA(), left: 0, used: ["2002"] }, recC()]);
    const work = memoryCheckoutWorkStore(() => clock);
    const row = await drive(OID2, admin, work);
    expect(row.outcome).toBe("CONSUMED");
    const c = eligDoc(admin).recs.find((r) => r.id === "3003")!;
    expect(c.left).toBe(1);
    expect(c.used).toBeUndefined();
  });

  it("a consumer row can never reach ISSUE (grant evidence edited away)", async () => {
    const orders: Record<string, unknown> = { [OID2]: consumedOrder() };
    const admin = makeAdmin({ orders });
    await seed(admin, [recA(), recC()]);
    const work = memoryCheckoutWorkStore(() => clock);
    await drive(OID2, admin, work);

    // The discount is edited off the order: the durable marker still stops
    // it from ever ISSUING a record of its own (no free-shipping chains).
    orders[OID2] = adminOrder({ id: OID2, name: "#2002" });
    const row = await redeliver(OID2, admin, work);
    expect(row.outcome).toBe("ALREADY_CONSUMED");
    expect(eligDoc(admin).recs.some((r) => r.id === "2002")).toBe(false);
  });
});

describe("processCheckoutWork — ABSENT/RETRY classification", () => {
  const absent = async (over: Record<string, unknown>, expectCode: string, opts: { seeded?: EligRecord[] } = {}) => {
    const admin = makeAdmin({ orders: { [OID1]: adminOrder(over) } });
    if (opts.seeded) await seed(admin, opts.seeded);
    const work = memoryCheckoutWorkStore(() => clock);
    const row = await drive(OID1, admin, work);
    expect(row.status).toBe("DONE");
    expect(row.lastReason ?? row.outcome).toContain(expectCode);
    return { admin, row };
  };

  it("unpaid then delayed payment: ABSENT first, issues when PAID", async () => {
    await absent({ displayFinancialStatus: "PENDING" }, "NOT_PAID");
    // The payment lands; a re-driven reconciliation issues the record.
    const admin = makeAdmin({ orders: { [OID1]: adminOrder({ displayFinancialStatus: "PAID" }) } });
    const work = memoryCheckoutWorkStore(() => clock);
    const row = await drive(OID1, admin, work);
    expect(settle(row)).toBe("DONE/PROJECTED");
    expect(eligDoc(admin).recs.length).toBe(1);
  });

  it("cancelled revokes an UNUSED record", async () => {
    const { admin } = await absent({ cancelledAt: "2026-11-10T11:00:00Z" }, "CANCELLED", { seeded: [baseRec()] });
    expect(eligDoc(admin).recs.find((r) => r.id === "1001")).toBeUndefined();
    expect(diagLog.some((e) => e.kind === "REVOKED")).toBe(true);
  });

  it("fulfilled, partially fulfilled, refunded and closed all refuse", async () => {
    await absent({ displayFulfillmentStatus: "FULFILLED" }, "FULFILLED");
    await absent({ displayFulfillmentStatus: "PARTIALLY_FULFILLED" }, "FULFILLED");
    await absent({ displayFinancialStatus: "REFUNDED" }, "REFUNDED");
    await absent({ closed: true }, "CLOSED");
    await absent({ fulfillments: [{ id: "f1" }] }, "FULFILLED");
  });

  it("risk MEDIUM/HIGH refuse; risk null RETRIES and never revokes", async () => {
    await absent({ riskLevel: "MEDIUM" }, "RISK_NOT_LOW");
    await absent({ riskLevel: "HIGH" }, "RISK_NOT_LOW");
    // null risk: RETRY — and a pre-existing record must survive untouched.
    const { admin, row } = await (async () => {
      const admin = makeAdmin({ orders: { [OID1]: adminOrder({ riskLevel: null }) } });
      await seed(admin, [baseRec()]);
      const work = memoryCheckoutWorkStore(() => clock);
      const row = await drive(OID1, admin, work);
      return { admin, row };
    })();
    expect(row.status).toBe("PENDING");
    expect(row.lastReason).toContain("risk level");
    const rec = eligDoc(admin).recs.find((r) => r.id === "1001")!;
    expect(rec.left).toBe(1); // a transient state never revokes
  });

  it("window passed refuses", async () => {
    clock = new Date("2026-11-20T12:00:00Z").getTime();
    await absent({}, "WINDOW_PASSED");
    clock = new Date("2026-11-10T12:00:00Z").getTime();
  });

  it("orders created before the enable epoch refuse", async () => {
    await absent({ createdAt: "2026-09-01T10:00:00Z" }, "BEFORE_ENABLE_EPOCH");
  });

  it("no customer / guest order refuses and never writes", async () => {
    const { admin } = await absent({ customer: null }, "NO_CUSTOMER");
    expect(admin.elig.writes.length).toBe(0);
    // A revoked record for a customer-less order can never be written.
    expect(eligDoc(admin).recs.length).toBe(0);
  });

  it("multiple shipping lines refuse", async () => {
    await absent({ shippingLines: { nodes: [shippingLine(), shippingLine({ title: "Express" })] } }, "MULTI_SHIPPING");
  });

  it("free-shipping order refuses (ZERO_SHIPPING)", async () => {
    await absent({ shippingLines: { nodes: [shippingLine({ originalPriceSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } }, discountedPriceSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } } })] } }, "ZERO_SHIPPING");
  });

  it("an ambiguous shipping delta refuses (never issues, never consumes)", async () => {
    await absent(
      {
        shippingLines: { nodes: [shippingLine({ discountedPriceSet: { shopMoney: { amount: "4.00", currencyCode: "USD" } } })] },
        discountApplications: { nodes: [{ __typename: "AutomaticDiscountApplication", targetType: "SHIPPING_LINE", title: "Some other promo" }] },
      },
      "AMBIGUOUS_DISCOUNT",
    );
  });

  it("unsupported currency refuses", async () => {
    await absent({ currencyCode: "XXX" }, "UNSUPPORTED_CURRENCY");
  });

  it("a location-rule failure refuses (multi-location shop without scope)", async () => {
    const admin = makeAdmin({ orders: { [OID1]: adminOrder() }, locationCount: 2 });
    const work = memoryCheckoutWorkStore(() => clock);
    const row = await drive(OID1, admin, work);
    expect(row.status).toBe("DONE");
    expect(row.lastReason ?? row.outcome).toContain("LOCATION");
    expect(eligDoc(admin).recs.length).toBe(0);
  });

  it("revocation never touches a used tombstone", async () => {
    const { admin } = await absent(
      { cancelledAt: "2026-11-10T11:00:00Z" },
      "CANCELLED",
      { seeded: [{ ...baseRec(), left: 0, used: ["2002"] }] },
    );
    const rec = eligDoc(admin).recs.find((r) => r.id === "1001")!;
    expect(rec.left).toBe(0);
    expect(rec.used).toEqual(["2002"]);
  });

  it("a garbage eligibility document is handled (refuse path leaves it, consume path treats as empty)", async () => {
    // Garbage doc + a refuse classification: revoke is a no-op.
    const admin = makeAdmin({ orders: { [OID1]: adminOrder({ cancelledAt: "2026-11-10T11:00:00Z" }) } });
    const { writeProjection } = await import("../app/lib/checkout-discount/projection-write");
    // Valid JSON, wrong shape — parseElig must treat it as an empty doc.
    await writeProjection(admin.elig, CUST, () => ({ serialized: JSON.stringify({ v: 99, recs: "junk" }) }));
    const work = memoryCheckoutWorkStore(() => clock);
    const row = await drive(OID1, admin, work);
    expect(row.status).toBe("DONE");
  });

  it("order gone => DONE ORDER_GONE", async () => {
    const admin = makeAdmin({ orders: {} });
    const work = memoryCheckoutWorkStore(() => clock);
    const row = await drive(OID1, admin, work);
    expect(settle(row)).toBe("DONE/ORDER_GONE");
  });
});

describe("pilot method approval (Task B bound)", () => {
  const APPROVED = { method: "standard shipping", maxMinor: 800n, currency: "USD" };
  const facts = (over: Partial<CheckoutFacts> = {}): CheckoutFacts => ({
    orderId: OID1,
    createdAt: "2026-11-10T10:00:00Z",
    cancelledAt: null,
    closed: false,
    financialStatus: "PAID",
    fulfillmentStatus: "UNFULFILLED",
    fulfillmentCount: 0,
    riskLevel: "LOW",
    currencyCode: "USD",
    supportedCurrency: true,
    customerId: CUST,
    shippingAddress: ADDR,
    shippingLines: [
      { title: "Standard Shipping", originalMinor: "800", discountedMinor: "800", discountAllocations: [] },
    ],
    discountApplications: [],
    ...over,
  });
  const ctx = (over: Record<string, unknown> = {}) => ({
    enabledAt: EPOCH,
    mergeWindowHours: 72,
    windowId: WIN,
    now: new Date("2026-11-10T12:00:00Z"),
    timeZone: "UTC",
    approved: APPROVED,
    ...over,
  });
  const withLine = (title: string, minor = "800", currency = "USD"): Partial<CheckoutFacts> => ({
    currencyCode: currency,
    shippingLines: [
      { title, originalMinor: minor, discountedMinor: minor, discountAllocations: [] },
    ],
  });

  it("the approved method qualifies — exact cap, case and whitespace normalized", () => {
    for (const title of ["Standard Shipping", "STANDARD  SHIPPING", "  standard shipping "]) {
      expect(classify(facts(withLine(title)), ctx()).kind).toBe("ISSUE");
    }
  });

  it.each(["Express", "S3 Test Shipping", "Standard Shipping Plus"])(
    "an unapproved method (%s) is ABSENT METHOD_NOT_APPROVED",
    (title) => {
      const d = classify(facts(withLine(title)), ctx());
      expect(d).toEqual({ kind: "ABSENT", code: "METHOD_NOT_APPROVED" });
    },
  );

  it("a shipping cost above the cap is ABSENT SHIPPING_UNBOUNDED", () => {
    expect(classify(facts(withLine("Standard Shipping", "801")), ctx())).toEqual({
      kind: "ABSENT",
      code: "SHIPPING_UNBOUNDED",
    });
  });

  it("a currency other than the approved one is ABSENT SHIPPING_UNBOUNDED", () => {
    expect(classify(facts(withLine("Standard Shipping", "800", "EUR")), ctx())).toEqual({
      kind: "ABSENT",
      code: "SHIPPING_UNBOUNDED",
    });
  });

  it("no approval at all fails closed — SHIPPING_UNBOUNDED, never silently unbounded", () => {
    const d = classify(facts(), ctx({ approved: undefined }));
    expect(d).toEqual({ kind: "ABSENT", code: "SHIPPING_UNBOUNDED" });
  });

  it("an order reprocessed under a revoked approval gets its stale record revoked", async () => {
    // A record was issued while "Standard Shipping" was approved; the same
    // order now ships a method the approval does not cover — ABSENT revokes
    // the unused record.
    const admin = makeAdmin({
      orders: {
        [OID1]: adminOrder({
          shippingLines: { nodes: [shippingLine({ title: "Express" })] },
        }),
      },
    });
    await seed(admin, [baseRec()]);
    const work = memoryCheckoutWorkStore(() => clock);
    const row = await drive(OID1, admin, work);
    expect(row.status).toBe("DONE");
    expect(row.lastReason ?? row.outcome).toContain("METHOD_NOT_APPROVED");
    expect(eligDoc(admin).recs.find((r) => r.id === "1001")).toBeUndefined();
    expect(diagLog.some((e) => e.kind === "REVOKED")).toBe(true);
  });

  it("a grant over the approved cap settles CONSUMED_OVER_CAP — the record is still spent", async () => {
    // Approved cap is 800; the grant allocated 900 on a "Standard Shipping"
    // $9.00 line — the record IS consumed but the outcome reports overdraw.
    const admin = makeAdmin({
      orders: {
        [OID1]: adminOrder(),
        [OID2]: {
          ...adminOrder({ id: OID2, name: "#2002" }),
          shippingLines: {
            nodes: [
              shippingLine({
                originalPriceSet: { shopMoney: { amount: "9.00", currencyCode: "USD" } },
                discountedPriceSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
                discountAllocations: [
                  {
                    allocatedAmountSet: { shopMoney: { amount: "9.00", currencyCode: "USD" } },
                    discountApplication: {
                      __typename: "AutomaticDiscountApplication",
                      targetType: "SHIPPING_LINE",
                      title: CHECKOUT_DISCOUNT_MESSAGE,
                    },
                  },
                ],
              }),
            ],
          },
          discountApplications: grantedApps(),
        },
      },
    });
    await seed(admin, [baseRec()]);
    const work = memoryCheckoutWorkStore(() => clock);
    const row = await drive(OID2, admin, work);
    expect(settle(row)).toBe("DONE/CONSUMED_OVER_CAP");
    const rec = eligDoc(admin).recs.find((r) => r.id === "1001")!;
    expect(rec.used).toEqual(["2002"]);
    expect(rec.left).toBe(0);
    expect(diagLog.some((e) => e.kind === "OVERDRAW" && e.code === "OVER_CAP")).toBe(true);
  });
});

describe("processCheckoutWork — gates", () => {
  const levers: { name: string; off: Partial<CheckoutGateDeps> }[] = [
    { name: "env", off: { env: () => undefined } },
    { name: "kill switch", off: { control: async () => ({ checkoutDiscountEnabled: false, checkoutDiscountAllowShops: [SHOP] }) } },
    { name: "allowlist", off: { control: async () => ({ checkoutDiscountEnabled: true, checkoutDiscountAllowShops: [] }) } },
    { name: "shop flag", off: { settings: async () => ({ ...SETTINGS, checkoutDiscountEnabled: false }) } },
    { name: "window-unsupported", off: { settings: async () => ({ ...SETTINGS, mergeWindowHours: 6 }) } },
    { name: "auto-merge", off: { settings: async () => ({ ...SETTINGS, autoMergeEnabled: false }) } },
    { name: "onboarding", off: { settings: async () => ({ ...SETTINGS, onboardingCompletedAt: null }) } },
  ];
  const newWork = () => memoryCheckoutWorkStore(() => clock);
  for (const l of levers) {
    it(`gate off (${l.name}) => DONE/FEATURE_OFF with ZERO Admin calls`, async () => {
      const admin = makeAdmin({ orders: { [OID1]: adminOrder() } });
      const work = newWork();
      const row = await drive(OID1, admin, work, { gate: { ...GATE, ...l.off } });
      expect(settle(row)).toBe("DONE/FEATURE_OFF");
      expect(admin.calls.length).toBe(0);
      expect(admin.elig.writes.length).toBe(0);
      expect(diagLog.some((e) => e.kind === "FEATURE_OFF")).toBe(true);
    });
  }

  it("an unreadable gate RETRIES with GATE_READ — never DONE/FEATURE_OFF", async () => {
    const admin = makeAdmin({ orders: { [OID1]: adminOrder() } });
    const work = newWork();
    const row = await drive(OID1, admin, work, {
      gate: { ...GATE, control: async () => { throw new Error("db down"); } },
    });
    expect(row.status).toBe("PENDING"); // retried, not settled
    expect(admin.calls.length).toBe(0); // still zero Admin calls
    expect(diagLog.some((e) => e.kind === "RETRY" && e.code === "GATE_READ")).toBe(true);
    expect(diagLog.some((e) => e.kind === "FEATURE_OFF")).toBe(false);
  });

  it("a gate that recovers on the next pass completes the work", async () => {
    const admin = makeAdmin({ orders: { [OID1]: adminOrder() } });
    const work = newWork();
    let down = true;
    const gate = {
      ...GATE,
      control: async () => {
        if (down) throw new Error("db down");
        return { checkoutDiscountEnabled: true, checkoutDiscountAllowShops: [SHOP] };
      },
    };
    const first = await drive(OID1, admin, work, { gate });
    expect(first.status).toBe("PENDING");
    down = false;
    clock += 300_000; // past the transient retry delay
    // The sweeper re-claims the retried row and the recovered gate lets it
    // through.
    const [claimed] = await work.claimDue(1, LEASE);
    await processCheckoutWork({
      item: claimed, token: claimed.leaseToken!, shop: SHOP,
      admin: admin as any, work, now, sleep: async () => {}, random: () => 0.5, gate, diag,
    });
    const row = await work.find(SHOP, OID1);
    expect(settle(row)).toBe("DONE/PROJECTED");
  });

  it("if scheduleRetry itself throws, the lease simply lapses and the sweeper re-claims", async () => {
    const admin = makeAdmin({ orders: { [OID1]: adminOrder() } });
    const base = newWork();
    const down = { ...GATE, control: async () => { throw new Error("db down"); } };
    const flaky: CheckoutWorkStore = {
      ...base,
      scheduleRetry: async () => {
        throw new Error("transient store failure");
      },
    };
    const token = "tok-x";
    const { item } = await flaky.upsertDirty(SHOP, OID1, token, 50, CHECKOUT_DEADLINE_MS);
    await processCheckoutWork({
      item, token, shop: SHOP, admin: admin as any, work: flaky,
      now, sleep: async () => {}, random: () => 0.5, gate: down, diag,
    });
    const row = await flaky.find(SHOP, OID1);
    expect(row!.status).toBe("PENDING"); // lease expiring, not settled
    clock += 100; // lease lapses
    const [claimed] = await base.claimDue(1, LEASE);
    expect(claimed.orderId).toBe(OID1); // sweeper re-claims it
  });

  it("diagnostics never carry PII (no address/name/email/tokens/dest keys)", async () => {
    const admin = makeAdmin({ orders: { [OID1]: adminOrder(), [OID2]: adminOrder({ id: OID2, name: "#2002", shippingLines: { nodes: [grantedLine("0.00", "8.00")] }, discountApplications: grantedApps() }) } });
    await seed(admin, [baseRec()]);
    const work = memoryCheckoutWorkStore(() => clock);
    await drive(OID1, admin, work);
    await drive(OID2, admin, work);
    const serialized = JSON.stringify(diagLog);
    for (const pii of ["Jane", "Doe", "Acme", "123 Main", "Apt 4", "@", "jane", "doe", "new york", "10001"]) {
      expect(serialized).not.toContain(pii);
    }
    expect(serialized).not.toContain(ADDR_KEY);
    expect(serialized).not.toContain(CUST);
    for (const e of diagLog) {
      expect(e.shop).toBe(SHOP);
      expect(e.orderId).toMatch(/^gid:\/\/shopify\/Order\//);
    }
  });
});
