// Durable consumed-evidence safety (regression): the customer metafield
// document is NOT the only evidence that a record granted — its tombstone
// can be evicted by the record cap or pruned by expiry, and a later merge
// window change can make the order look eligible again. The durable work-row
// mark (grantConsumedAt) must make every re-check fail closed: no second
// grant, ever, however the replay arrives (webhook delivery, sweeper
// recheck, restart, lease takeover).
import { describe, expect, it } from "vitest";
import { cartDeliveryOptionsDiscountsGenerateRun } from "../functions/checkout-shipping-discount/src/cart_delivery_options_discounts_generate_run";
import { CHECKOUT_DISCOUNT_MESSAGE } from "../app/lib/checkout-discount/config";
import { processCheckoutWork } from "../app/lib/checkout-discount/processor.server";
import type { CheckoutGateDeps } from "../app/lib/checkout-discount/gate.server";
import { parseElig } from "../app/lib/checkout-discount/records";
import {
  CHECKOUT_DEADLINE_MS,
  CHECKOUT_RECHECK_MAX_AGE_MS,
  memoryCheckoutWorkStore,
} from "../app/lib/checkout-discount/work.server";
import { DEFAULT_SETTINGS, type MergeSettings } from "../app/lib/settings.server";
import { makeFakeEligibilityAdmin } from "./helpers/checkout-fake-admin";

const SHOP = "s.myshopify.com";
const CUST = "gid://shopify/Customer/777";
const EPOCH1 = new Date("2026-11-01T00:00:00Z");
const WIN1 = `w${EPOCH1.getTime()}`;

const ADDR = {
  firstName: "Jane", lastName: "Doe", company: "Acme",
  address1: "123 Main", address2: "Apt 4",
  city: "New York", provinceCode: "NY", zip: "10001", countryCode: "US",
};
// A different destination: records for it never match the test cart.
const ADDR2 = {
  firstName: "Bob", lastName: "Roe", company: "Beta",
  address1: "9 Side St", address2: "",
  city: "Toronto", provinceCode: "ON", zip: "M5V 1J1", countryCode: "CA",
};

const orderFixture = (id: string, createdAt: string, over: Record<string, unknown> = {}) => ({
  id,
  name: "#" + id.slice(-4),
  createdAt,
  processedAt: createdAt,
  cancelledAt: null,
  closed: false,
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "UNFULFILLED",
  riskLevel: "LOW",
  currencyCode: "USD",
  customer: { id: CUST },
  shippingAddress: { ...ADDR, countryCodeV2: "US" },
  shippingLines: {
    nodes: [{
      title: "Standard Shipping",
      originalPriceSet: { shopMoney: { amount: "8.00", currencyCode: "USD" } },
      discountedPriceSet: { shopMoney: { amount: "8.00", currencyCode: "USD" } },
      discountAllocations: [],
    }],
  },
  fulfillments: [],
  discountApplications: { nodes: [] },
  ...over,
});

/** An order that carries an unambiguous MergeShip shipping grant — classify
 *  returns CONSUME for it. */
const grantFixture = (id: string, createdAt: string) =>
  orderFixture(id, createdAt, {
    shippingLines: {
      nodes: [{
        title: "Standard Shipping",
        originalPriceSet: { shopMoney: { amount: "8.00", currencyCode: "USD" } },
        discountedPriceSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
        discountAllocations: [{
          allocatedAmountSet: { shopMoney: { amount: "8.00", currencyCode: "USD" } },
          discountApplication: {
            __typename: "AutomaticDiscountApplication",
            targetType: "SHIPPING_LINE",
            title: CHECKOUT_DISCOUNT_MESSAGE,
          },
        }],
      }],
    },
    discountApplications: {
      nodes: [{
        __typename: "AutomaticDiscountApplication",
        targetType: "SHIPPING_LINE",
        title: CHECKOUT_DISCOUNT_MESSAGE,
      }],
    },
  });

const fnInput = (eligDoc: unknown, windowId: string, date = "2026-11-10") => ({
  discount: {
    discountClasses: ["SHIPPING"],
    metafield: { jsonValue: { v: 1, windowId, percentage: "100.0", message: CHECKOUT_DISCOUNT_MESSAGE, windowStart: "2026-11-01T00:00:00", windowEnd: "2026-12-01T00:00:00" } },
  },
  shop: { localTime: { inWindow: true, date } },
  cart: {
    buyerIdentity: { isAuthenticated: true, customer: { metafield: { jsonValue: eligDoc } } },
    deliveryGroups: [{
      deliveryAddress: ADDR,
      deliveryOptions: [{ handle: "o1", deliveryMethodType: "SHIPPING", title: "Standard Shipping", cost: { amount: "8.00", currencyCode: "USD" } }],
    }],
  },
});

const discounts = (input: unknown) =>
  (cartDeliveryOptionsDiscountsGenerateRun(input).operations as unknown[]).length > 0;

/** Mutable window/stamp so a test can change the merchant's merge window the
 *  way the settings route does. The stamp mirrors the enabled-at window. */
const env = { windowHours: 72, stampHours: 72 };
const settingsFor = (enabledAt: Date | null): MergeSettings => ({
  ...DEFAULT_SETTINGS,
  autoMergeEnabled: true,
  onboardingCompletedAt: EPOCH1,
  checkoutDiscountEnabled: enabledAt !== null,
  checkoutDiscountEnabledAt: enabledAt,
  checkoutDiscountNodeId: "gid://shopify/DiscountAutomaticNode/99",
  checkoutDiscountWindowHours: enabledAt !== null ? env.stampHours : null,
  mergeWindowHours: env.windowHours,
});
const gateDeps = (): CheckoutGateDeps => ({
  env: (n) => (n === "MERGESHIP_CHECKOUT_DISCOUNT" ? "enabled" : undefined),
  settings: async () => settingsFor(EPOCH1),
  control: async () => ({ checkoutDiscountEnabled: true, checkoutDiscountAllowShops: [SHOP] }),
});

const setup = () => {
  const clock = { now: Date.parse("2026-11-10T12:00:00Z") };
  const work = memoryCheckoutWorkStore(() => clock.now);
  const elig = makeFakeEligibilityAdmin();
  const orders: Record<string, unknown> = {};
  const admin = {
    async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
      const respond = (body: any) => ({ ok: true, status: 200, json: async () => body });
      const vars = options?.variables ?? {};
      if (query.includes("CheckoutEligibilityOrder")) {
        return respond({ data: { order: orders[vars.id as string] ?? null, shop: { ianaTimezone: "UTC" } } });
      }
      if (query.includes("fulfillmentOrders")) {
        return respond({ errors: [{ message: "Access denied for field fulfillmentOrders" }] });
      }
      if (query.includes("locationsCount")) {
        return respond({ data: { locationsCount: { count: 1 } } });
      }
      if (query.includes("lineItems")) {
        return respond({ data: { order: { lineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } });
      }
      if (query.includes("EligibilityProjectionRead") || query.includes("metafieldsSet")) {
        return respond(await elig.graphql(query, options));
      }
      throw new Error(`unhandled: ${query.slice(0, 60)}`);
    },
  };
  /** Dirties the order's work row and runs the real processor on it. */
  const deliver = async (orderId: string) => {
    const { item } = await work.upsertDirty(SHOP, orderId, `tok-${clock.now}-${orderId}`, 90_000, CHECKOUT_DEADLINE_MS);
    await processCheckoutWork({
      item, token: item.leaseToken!, shop: SHOP, admin: admin as any, work,
      now: () => new Date(clock.now), sleep: async () => {}, random: () => 0.5,
      gate: gateDeps(), diag: () => {},
    });
  };
  /** The sweeper's missed-webhook recheck: re-open outstanding PROJECTED
   *  rows, claim what is due, process each. Returns the reopen count. */
  const recheck = async () => {
    const reopened = await work.reopenOutstanding({
      olderThanMs: 60_000,
      maxAgeMs: CHECKOUT_RECHECK_MAX_AGE_MS,
      limit: 50,
      deadlineMs: CHECKOUT_DEADLINE_MS,
    });
    for (const item of await work.claimDue(50, 90_000)) {
      await processCheckoutWork({
        item, token: item.leaseToken!, shop: SHOP, admin: admin as any, work,
        now: () => new Date(clock.now), sleep: async () => {}, random: () => 0.5,
        gate: gateDeps(), diag: () => {},
      });
    }
    return reopened;
  };
  return { clock, work, elig, orders, admin, deliver, recheck };
};

const OIDA = "gid://shopify/Order/1001";
const OIDB = "gid://shopify/Order/2002";
const OIDC = "gid://shopify/Order/3009";

describe("durable consumed evidence", () => {
  it("cap eviction of a consumed tombstone can never resurrect the grant", async () => {
    env.windowHours = 72;
    env.stampHours = 72;
    const { clock, work, elig, orders, deliver, recheck } = setup();

    // A issues and grants.
    orders[OIDA] = orderFixture(OIDA, "2026-11-10T10:00:00Z");
    await deliver(OIDA);
    expect(discounts(fnInput(elig.stored(CUST), WIN1))).toBe(true);

    // B carries the MergeShip grant -> consumes A's record into a tombstone.
    orders[OIDB] = grantFixture(OIDB, "2026-11-10T11:00:00Z");
    await deliver(OIDB);
    const tomb = parseElig(elig.stored(CUST)).doc.recs.find((r) => r.id === "1001");
    expect(tomb?.left).toBe(0);
    expect(tomb?.used).toEqual(["2002"]);

    // Five more records with an EARLIER exp fill the capped document — the
    // cap is fail-closed: the first four are admitted, the fifth is REFUSED
    // and settles DONE/CAPACITY; A's tombstone is never evicted.
    for (let i = 1; i <= 5; i++) {
      const oid = `gid://shopify/Order/40${i}0`;
      orders[oid] = orderFixture(oid, "2026-11-09T00:00:00Z", {
        shippingAddress: { ...ADDR2, countryCodeV2: "CA" },
      });
      await deliver(oid);
    }
    const full = parseElig(elig.stored(CUST)).doc;
    expect(full.recs).toHaveLength(5);
    expect(full.recs.find((r) => r.id === "1001")?.left).toBe(0); // tombstone kept
    const refused = await work.find(SHOP, "gid://shopify/Order/4050");
    expect(`${refused?.status}/${refused?.outcome}`).toBe("DONE/CAPACITY");

    // The four records expire; A's order is still inside its 72 h window,
    // but its work row carries grantConsumedAt — the recheck skips it and
    // no replay can ever re-ISSUE it.
    clock.now = Date.parse("2026-11-12T01:00:00Z");
    const reopened = await recheck();
    expect(reopened).toBe(4); // the four admitted records only — not A

    // Even a direct redelivery re-dirties the row but classification is
    // ALREADY_CONSUMED — the tombstone is kept, never reset.
    await deliver(OIDA);
    const row = await work.find(SHOP, OIDA);
    expect(row?.outcome).toBe("ALREADY_CONSUMED");
    const recA = parseElig(elig.stored(CUST)).doc.recs.find((r) => r.id === "1001");
    expect(recA?.left ?? 0).toBe(0);
    expect(discounts(fnInput(elig.stored(CUST), WIN1, "2026-11-12"))).toBe(false);
  });

  it("an expired tombstone + a merge-window increase can never re-issue a consumed order", async () => {
    env.windowHours = 72;
    env.stampHours = 72;
    const { clock, work, elig, orders, deliver } = setup();

    orders[OIDA] = orderFixture(OIDA, "2026-11-10T10:00:00Z");
    await deliver(OIDA);
    orders[OIDB] = grantFixture(OIDB, "2026-11-10T11:00:00Z");
    await deliver(OIDB);
    expect(
      parseElig(elig.stored(CUST)).doc.recs.find((r) => r.id === "1001")?.left,
    ).toBe(0);

    // Time passes past the tombstone's exp; another write prunes it.
    clock.now = Date.parse("2026-11-13T01:00:00Z");
    orders[OIDC] = orderFixture(OIDC, "2026-11-13T00:00:00Z", {
      shippingAddress: { ...ADDR2, countryCodeV2: "CA" },
    });
    await deliver(OIDC);
    expect(parseElig(elig.stored(CUST)).doc.recs.some((r) => r.id === "1001")).toBe(false);

    // The merchant widens the merge window (72 -> 168 h). Order A, whose
    // 72 h window had closed, now sits inside the window again — a delayed
    // orders/updated delivery (or recheck) currently re-ISSUES it.
    env.windowHours = 168;
    env.stampHours = 168;
    await deliver(OIDA);

    const row = await work.find(SHOP, OIDA);
    expect(row?.outcome).toBe("ALREADY_CONSUMED");
    const recA = parseElig(elig.stored(CUST)).doc.recs.find((r) => r.id === "1001");
    expect(recA?.left ?? 0).toBe(0);
    expect(discounts(fnInput(elig.stored(CUST), WIN1, "2026-11-13"))).toBe(false);
  });

  it("repeated orders/paid + orders/updated deliveries of the grant consume exactly once", async () => {
    env.windowHours = 72;
    env.stampHours = 72;
    const { work, elig, orders, deliver } = setup();

    orders[OIDA] = orderFixture(OIDA, "2026-11-10T10:00:00Z");
    await deliver(OIDA);
    orders[OIDB] = grantFixture(OIDB, "2026-11-10T11:00:00Z");
    await deliver(OIDB); // orders/paid
    await deliver(OIDB); // orders/updated — same grant, replay
    await deliver(OIDB); // and again
    const mark = (await work.find(SHOP, OIDA))!.grantConsumedAt;
    expect(mark).not.toBe(null);
    const rec = parseElig(elig.stored(CUST)).doc.recs.find((r) => r.id === "1001")!;
    expect(rec.used).toEqual(["2002"]);
    expect(rec.left).toBe(0);
    // The consumed mark is written once — a replay never moves it.
    expect((await work.find(SHOP, OIDA))!.grantConsumedAt).toEqual(mark);
    // A replayed grant order finds no living record — the overdraw branch,
    // still fail-closed (no second consumption, no second record).
    expect((await work.find(SHOP, OIDB))?.outcome).toBe("CONSUMED_NO_RECORD");
  });

  it("enable-epoch rotation: a consumed order can never re-issue under the new window", async () => {
    env.windowHours = 72;
    env.stampHours = 72;
    const { clock, work, elig, orders, admin, deliver } = setup();

    orders[OIDA] = orderFixture(OIDA, "2026-11-10T10:00:00Z");
    await deliver(OIDA);
    orders[OIDB] = grantFixture(OIDB, "2026-11-10T11:00:00Z");
    await deliver(OIDB);
    expect((await work.find(SHOP, OIDA))!.grantConsumedAt).not.toBe(null);

    // Re-enable rotates the enable epoch: a new windowId on the gate.
    const EPOCH2 = new Date("2026-11-14T00:00:00Z");
    const WIN2 = `w${EPOCH2.getTime()}`;
    const gateDeps2 = (): CheckoutGateDeps => ({
      env: (n) => (n === "MERGESHIP_CHECKOUT_DISCOUNT" ? "enabled" : undefined),
      settings: async () => settingsFor(EPOCH2),
      control: async () => ({ checkoutDiscountEnabled: true, checkoutDiscountAllowShops: [SHOP] }),
    });
    // A delayed delivery of A under the new epoch: durable mark wins, the
    // old tombstone is pruned and A is never re-added.
    const { item } = await work.upsertDirty(SHOP, OIDA, `tok-rot-${clock.now}`, 90_000, CHECKOUT_DEADLINE_MS);
    await processCheckoutWork({
      item, token: item.leaseToken!, shop: SHOP, admin: admin as any, work,
      now: () => new Date(clock.now), sleep: async () => {}, random: () => 0.5,
      gate: gateDeps2(), diag: () => {},
    });
    const row = await work.find(SHOP, OIDA);
    // BEFORE_ENABLE_EPOCH (created before the new epoch) or the durable
    // mark — either way the order can never issue under the new window.
    expect(["BEFORE_ENABLE_EPOCH", "ALREADY_CONSUMED"]).toContain(row?.outcome);
    const recA = parseElig(elig.stored(CUST)).doc.recs.find((r) => r.id === "1001");
    expect(recA === undefined || recA.left <= 0).toBe(true);
    expect(discounts(fnInput(elig.stored(CUST), WIN2))).toBe(false);
  });

  it("crash AFTER the durable mark but BEFORE the document write: retry converges, never grants twice", async () => {
    env.windowHours = 72;
    env.stampHours = 72;
    const { clock, work, elig, orders, admin, deliver } = setup();

    orders[OIDA] = orderFixture(OIDA, "2026-11-10T10:00:00Z");
    await deliver(OIDA);
    orders[OIDB] = grantFixture(OIDB, "2026-11-10T11:00:00Z");

    // First consume attempt: the CAS commit crashes mid-write.
    elig.setInterleaveHook(() => {
      throw new Error("commit crash");
    });
    await deliver(OIDB);
    // The durable mark already landed — evidence survives the crash.
    const markA = (await work.find(SHOP, OIDA))!.grantConsumedAt;
    expect(markA).not.toBe(null);
    expect((await work.find(SHOP, OIDB))!.status).toBe("PENDING"); // retried

    // A second worker (lease expired, new claim) finishes the consume.
    clock.now += 60 * 60_000;
    const [claimed] = await work.claimDue(10, 90_000);
    expect(claimed.orderId).toBe(OIDB);
    await processCheckoutWork({
      item: claimed, token: claimed.leaseToken!, shop: SHOP, admin: admin as any, work,
      now: () => new Date(clock.now), sleep: async () => {}, random: () => 0.5,
      gate: gateDeps(), diag: () => {},
    });
    const rec = parseElig(elig.stored(CUST)).doc.recs.find((r) => r.id === "1001")!;
    expect(rec.left).toBe(0);
    expect(rec.used).toEqual(["2002"]);
    // The first mark's timestamp is kept — COALESCE, never re-stamped.
    expect((await work.find(SHOP, OIDA))!.grantConsumedAt).toEqual(markA);
    // And a recheck of A still refuses — the crash ordering held.
    await deliver(OIDA);
    expect((await work.find(SHOP, OIDA))!.outcome).toBe("ALREADY_CONSUMED");
    expect(discounts(fnInput(elig.stored(CUST), WIN1))).toBe(false);
  });

  it("crash AFTER the document write but BEFORE settle: retry is idempotent", async () => {
    env.windowHours = 72;
    env.stampHours = 72;
    const { clock, work, elig, orders, admin, deliver } = setup();

    orders[OIDA] = orderFixture(OIDA, "2026-11-10T10:00:00Z");
    await deliver(OIDA);
    orders[OIDB] = grantFixture(OIDB, "2026-11-10T11:00:00Z");

    // complete() crashes once: the tombstone write already committed.
    let failComplete = true;
    const flaky = {
      ...work,
      complete: (...a: Parameters<typeof work.complete>) =>
        failComplete
          ? ((failComplete = false), Promise.reject(new Error("settle crash")))
          : work.complete(...a),
    };
    const { item } = await work.upsertDirty(SHOP, OIDB, `tok-b-${clock.now}`, 90_000, CHECKOUT_DEADLINE_MS);
    await processCheckoutWork({
      item, token: item.leaseToken!, shop: SHOP, admin: admin as any, work: flaky,
      now: () => new Date(clock.now), sleep: async () => {}, random: () => 0.5,
      gate: gateDeps(), diag: () => {},
    });
    const markA = (await work.find(SHOP, OIDA))!.grantConsumedAt;
    expect(markA).not.toBe(null);
    expect(parseElig(elig.stored(CUST)).doc.recs.find((r) => r.id === "1001")?.left).toBe(0);
    expect((await work.find(SHOP, OIDB))!.status).toBe("PENDING");

    // Retry: consumeRecord is a no-op on the spent record, the mark keeps
    // its first timestamp, the second settle completes.
    clock.now += 60 * 60_000;
    const [claimed] = await work.claimDue(10, 90_000);
    await processCheckoutWork({
      item: claimed, token: claimed.leaseToken!, shop: SHOP, admin: admin as any, work,
      now: () => new Date(clock.now), sleep: async () => {}, random: () => 0.5,
      gate: gateDeps(), diag: () => {},
    });
    const rec = parseElig(elig.stored(CUST)).doc.recs.find((r) => r.id === "1001")!;
    expect(rec.used).toEqual(["2002"]);
    expect((await work.find(SHOP, OIDA))!.grantConsumedAt).toEqual(markA);
    // The retried grant finds no living record — the overdraw branch — but
    // the consumption is still exactly once and the evidence intact.
    expect((await work.find(SHOP, OIDB))?.outcome).toBe("CONSUMED_NO_RECORD");
    expect(discounts(fnInput(elig.stored(CUST), WIN1))).toBe(false);
  });
});

describe("markGrantConsumed — memory store contract", () => {
  const setup = () => {
    const clock = { now: Date.parse("2026-11-10T12:00:00Z") };
    return { clock, work: memoryCheckoutWorkStore(() => clock.now) };
  };

  it("absent row: inserts an inert DONE/GRANT_CONSUMED row carrying the mark", async () => {
    const { work } = setup();
    await work.markGrantConsumed(SHOP, OIDA);
    const row = (await work.find(SHOP, OIDA))!;
    expect(row.status).toBe("DONE");
    expect(row.outcome).toBe("GRANT_CONSUMED");
    expect(row.grantConsumedAt).not.toBe(null);
    expect(row.doneAt).toEqual(row.grantConsumedAt);
    // Inert: never claimed as due work, never re-opened.
    expect(await work.claimDue(10, 60_000)).toHaveLength(0);
    expect(
      await work.reopenOutstanding({ olderThanMs: 0, maxAgeMs: 1e12, limit: 10, deadlineMs: 60_000 }),
    ).toBe(0);
  });

  it("an active PENDING row keeps lease, gen, status and attempts", async () => {
    const { work } = setup();
    const { item } = await work.upsertDirty(SHOP, OIDA, "tok-live", 90_000, CHECKOUT_DEADLINE_MS);
    await work.markGrantConsumed(SHOP, OIDA);
    const row = (await work.find(SHOP, OIDA))!;
    expect(row.status).toBe("PENDING");
    expect(row.gen).toBe(item.gen);
    expect(row.leaseToken).toBe("tok-live");
    expect(row.leasedUntil).toEqual(item.leasedUntil);
    expect(row.attempts).toBe(item.attempts);
    expect(row.grantConsumedAt).not.toBe(null);
  });

  it("a second call keeps the first timestamp", async () => {
    const { clock, work } = setup();
    await work.markGrantConsumed(SHOP, OIDA);
    const first = (await work.find(SHOP, OIDA))!.grantConsumedAt;
    clock.now += 3_600_000;
    await work.markGrantConsumed(SHOP, OIDA);
    expect((await work.find(SHOP, OIDA))!.grantConsumedAt).toEqual(first);
  });

  it("upsertDirty, touchExisting and reopenOutstanding never clear the mark; reopen skips it", async () => {
    const { clock, work } = setup();
    const { item } = await work.upsertDirty(SHOP, OIDA, "tok-1", 90_000, CHECKOUT_DEADLINE_MS);
    await work.complete(item.id, "tok-1", item.gen, "PROJECTED", "ok");
    await work.markGrantConsumed(SHOP, OIDA);
    const mark = (await work.find(SHOP, OIDA))!.grantConsumedAt;

    // touchExisting re-dirties without clearing the mark.
    const touched = await work.touchExisting(SHOP, OIDA, "tok-2", 90_000, CHECKOUT_DEADLINE_MS);
    expect((await work.find(SHOP, OIDA))!.grantConsumedAt).toEqual(mark);
    // Re-settle PROJECTED, age the row: reopenOutstanding must skip it.
    await work.complete(touched!.item.id, "tok-2", touched!.item.gen, "PROJECTED", "ok");
    clock.now += 3600_000;
    expect(
      await work.reopenOutstanding({ olderThanMs: 60_000, maxAgeMs: 1e12, limit: 10, deadlineMs: 60_000 }),
    ).toBe(0);
    expect((await work.find(SHOP, OIDA))!.status).toBe("DONE");
    // upsertDirty preserves the mark too.
    await work.upsertDirty(SHOP, OIDA, "tok-3", 90_000, CHECKOUT_DEADLINE_MS);
    expect((await work.find(SHOP, OIDA))!.grantConsumedAt).toEqual(mark);
  });
});
