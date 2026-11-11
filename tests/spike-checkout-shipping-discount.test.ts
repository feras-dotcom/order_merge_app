// Offline feasibility-spike tests: the checkout shipping-discount Function
// and the eligibility projection. No Shopify, no DB — fixtures + the fake
// CAS admin only.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cartDeliveryOptionsDiscountsGenerateRun } from "../spikes/checkout-shipping-discount/extension/src/cart_delivery_options_discounts_generate_run";
import { destKey, normMethod, normZip } from "../spikes/checkout-shipping-discount/extension/src/dest-key";
import {
  buildRecord, consumeRecord, mergeRecords, parseElig, serializeElig,
  type EligRecord, type OrderFacts,
} from "../spikes/checkout-shipping-discount/projection/records";
import {
  ProjectionConflictError, ProjectionWriteError, writeProjection,
} from "../spikes/checkout-shipping-discount/projection/write";
import { detectShippingDiscountGrant } from "../spikes/checkout-shipping-discount/projection/grant";
import { makeFakeEligibilityAdmin } from "../spikes/checkout-shipping-discount/projection/fake-admin";

const SPIKES = join(__dirname, "..", "spikes");
const EXT_SRC = join(SPIKES, "checkout-shipping-discount", "extension", "src");
const FN_SRC = readFileSync(join(EXT_SRC, "cart_delivery_options_discounts_generate_run.ts"), "utf8");
const INPUT_QUERY = readFileSync(join(EXT_SRC, "cart_delivery_options_discounts_generate_run.graphql"), "utf8");

// ── Function input factory ──────────────────────────────────────────────

const CFG = { v: 1, windowId: "w1", percentage: "100.0", message: "Free shipping — welcome back" };
const ADDR = { countryCode: "US", provinceCode: "NY", zip: "10001", city: "New York" };
const option = (over: Record<string, unknown> = {}) => ({
  handle: "opt_std",
  title: "Standard Shipping",
  deliveryMethodType: "SHIPPING",
  cost: { amount: "8.00", currencyCode: "USD" },
  ...over,
});
const rec = (over: Record<string, unknown> = {}): EligRecord => ({
  id: "111",
  win: "w1",
  dest: "us|ny|10001|new york",
  method: "standard shipping",
  cur: "USD",
  left: 1,
  exp: "2099-01-01",
  ...over,
});
const eligMf = (recs: unknown) => ({ jsonValue: { v: 1, recs } });

function makeInput(over: Record<string, unknown> = {}) {
  return {
    cart: {
      buyerIdentity: {
        isAuthenticated: true,
        customer: { id: "gid://shopify/Customer/1", numberOfOrders: 3, metafield: eligMf([rec()]) },
      },
      deliveryGroups: [
        {
          id: "dg1",
          deliveryAddress: { ...ADDR },
          selectedDeliveryOption: option(),
          deliveryOptions: [option()],
        },
      ],
      ...((over.cart as object) ?? {}),
    },
    discount: { discountClasses: ["SHIPPING"], metafield: { jsonValue: CFG }, ...((over.discount as object) ?? {}) },
    shop: { localTime: { date: "2026-11-01", inWindow: true }, ...((over.shop as object) ?? {}) },
  };
}
const withCustomer = (input: any, mf: unknown) => {
  const c = { ...input.cart.buyerIdentity.customer, metafield: mf };
  return { ...input, cart: { ...input.cart, buyerIdentity: { ...input.cart.buyerIdentity, customer: c } } };
};
const withOptions = (input: any, opts: unknown[]) => {
  const g = { ...input.cart.deliveryGroups[0], deliveryOptions: opts };
  return { ...input, cart: { ...input.cart, deliveryGroups: [g] } };
};
const withAddr = (input: any, addr: unknown) => {
  const g = { ...input.cart.deliveryGroups[0], deliveryAddress: addr };
  return { ...input, cart: { ...input.cart, deliveryGroups: [g] } };
};
const runFn = cartDeliveryOptionsDiscountsGenerateRun as (i: unknown) => { operations: any[] };

describe("checkout shipping-discount Function", () => {
  it("happy path emits exactly ONE deliveryDiscountsAdd/FIRST/one candidate targeting the matching handle with the percentage string", () => {
    const out = runFn(makeInput());
    expect(out).toEqual({
      operations: [
        {
          deliveryDiscountsAdd: {
            selectionStrategy: "FIRST",
            candidates: [
              {
                targets: [{ deliveryOption: { handle: "opt_std" } }],
                value: { percentage: { value: "100.0" } },
                message: "Free shipping — welcome back",
              },
            ],
          },
        },
      ],
    });
  });

  it("is deterministic — identical input, identical output", () => {
    expect(runFn(makeInput())).toEqual(runFn(makeInput()));
  });

  it("guest checkout (unauthenticated, customer null) gets nothing", () => {
    const i = makeInput();
    i.cart.buyerIdentity = { isAuthenticated: false, customer: null } as any;
    expect(runFn(i)).toEqual({ operations: [] });
  });

  it("authenticated customer without the metafield gets nothing", () => {
    expect(runFn(withCustomer(makeInput(), null))).toEqual({ operations: [] });
  });

  for (const bad of ["garbage", 42, [], { v: 2, recs: [rec()] }, { v: 1, recs: "no" }, { v: 1, recs: [{ id: 1 }] }, "{not json"]) {
    it(`malformed eligibility value ${JSON.stringify(bad)} ⇒ empty, no throw`, () => {
      expect(runFn(withCustomer(makeInput(), { jsonValue: bad }))).toEqual({ operations: [] });
    });
  }

  it("out-of-window discount config does nothing", () => {
    const i = makeInput();
    (i.shop.localTime as any).inWindow = false;
    expect(runFn(i)).toEqual({ operations: [] });
  });

  it("exp boundary: exp == shop date is eligible, exp < date is not", () => {
    expect(runFn(withCustomer(makeInput(), eligMf([rec({ exp: "2026-11-01" })]))).operations.length).toBe(1);
    expect(runFn(withCustomer(makeInput(), eligMf([rec({ exp: "2026-10-31" })]))).operations).toEqual([]);
  });

  it("left 0, win mismatch and currency mismatch are all ineligible", () => {
    expect(runFn(withCustomer(makeInput(), eligMf([rec({ left: 0 })]))).operations).toEqual([]);
    expect(runFn(withCustomer(makeInput(), eligMf([rec({ win: "w2" })]))).operations).toEqual([]);
    expect(runFn(withCustomer(makeInput(), eligMf([rec({ cur: "EUR" })]))).operations).toEqual([]);
  });

  it("destination mismatches (zip, city, country) are ineligible", () => {
    expect(runFn(withCustomer(makeInput(), eligMf([rec({ dest: "us|ny|90210|new york" })]))).operations).toEqual([]);
    expect(runFn(withCustomer(makeInput(), eligMf([rec({ dest: "us|ny|10001|boston" })]))).operations).toEqual([]);
    expect(runFn(withCustomer(makeInput(), eligMf([rec({ dest: "ca|ny|10001|new york" })]))).operations).toEqual([]);
  });

  it("destination normalization: case, whitespace, diacritics and zip spacing all match", () => {
    const i = withAddr(makeInput(), { countryCode: "br", provinceCode: null, zip: " 01310-100 ", city: "São Paulo" });
    const j = withCustomer(i, eligMf([rec({ dest: "br||01310100|sao paulo", cur: "BRL" })]));
    const k = withOptions(j, [option({ cost: { amount: "8.00", currencyCode: "BRL" } })]);
    expect(runFn(k).operations.length).toBe(1);
  });

  for (const addr of [{ ...ADDR, zip: null }, { ...ADDR, city: null }, { ...ADDR, countryCode: null }]) {
    it(`partial address missing ${Object.keys(addr).filter((k) => (addr as any)[k] === null)} ⇒ no discount`, () => {
      expect(runFn(withAddr(makeInput(), addr))).toEqual({ operations: [] });
    });
  }

  it("missing province still keys (empty slot), but only for a matching record", () => {
    const i = withAddr(makeInput(), { countryCode: "IE", provinceCode: null, zip: "D02 X285", city: "Dublin" });
    const j = withCustomer(i, eligMf([rec({ dest: "ie||d02x285|dublin" })]));
    expect(runFn(j).operations.length).toBe(1);
    const k = withCustomer(i, eligMf([rec({ dest: "ie|xx|d02x285|dublin" })]));
    expect(runFn(k)).toEqual({ operations: [] });
  });

  it("method mismatch: no matching SHIPPING option ⇒ empty; a matching option is discounted while others are untouched", () => {
    const j = withOptions(makeInput(), [option({ title: "Express", handle: "opt_exp" })]);
    expect(runFn(j)).toEqual({ operations: [] });
    const k = withOptions(makeInput(), [
      option({ title: "Express", handle: "opt_exp" }),
      option({ title: "Standard  Shipping", handle: "opt_std2" }),
      option({ title: "Standard Shipping", handle: "opt_pickup", deliveryMethodType: "PICKUP" }),
    ]);
    const out = runFn(k);
    const targets = out.operations[0].deliveryDiscountsAdd.candidates[0].targets;
    expect(targets).toEqual([{ deliveryOption: { handle: "opt_std2" } }]);
  });

  it("a PICKUP option carrying the same title is excluded", () => {
    const j = withOptions(makeInput(), [option({ deliveryMethodType: "PICKUP", handle: "opt_p" })]);
    expect(runFn(j)).toEqual({ operations: [] });
  });

  it("two delivery groups (split cart) ⇒ empty", () => {
    const i = makeInput();
    (i.cart.deliveryGroups as any[]).push({ id: "dg2", deliveryAddress: { ...ADDR }, deliveryOptions: [option()] });
    expect(runFn(i)).toEqual({ operations: [] });
  });

  it("multiple valid records ⇒ exactly one candidate set for the earliest-exp record", () => {
    const j = withCustomer(
      makeInput(),
      eligMf([
        rec({ id: "222", exp: "2099-02-01", method: "standard shipping" }),
        rec({ id: "111", exp: "2099-01-01", method: "standard shipping" }),
      ]),
    );
    const k = withOptions(j, [option({ handle: "h_a" }), option({ handle: "h_b" })]);
    const out = runFn(k);
    expect(out.operations.length).toBe(1);
    const cand = out.operations[0].deliveryDiscountsAdd.candidates;
    expect(cand.length).toBe(1);
    expect(cand[0].targets).toEqual([{ deliveryOption: { handle: "h_a" } }, { deliveryOption: { handle: "h_b" } }]);
  });

  it("discountClasses lacking SHIPPING ⇒ empty", () => {
    const i = makeInput();
    i.discount.discountClasses = ["PRODUCT"];
    expect(runFn(i)).toEqual({ operations: [] });
  });

  for (const p of ["0", "101", "abc", "-5", 100, undefined]) {
    it(`percentage ${JSON.stringify(p)} ⇒ empty`, () => {
      const i = makeInput();
      i.discount.metafield = { jsonValue: { ...CFG, percentage: p } } as any;
      expect(runFn(i)).toEqual({ operations: [] });
    });
  }

  it("malformed config (no v:1 / bad message) ⇒ empty", () => {
    const i = makeInput();
    i.discount.metafield = { jsonValue: { v: 2 } } as any;
    expect(runFn(i)).toEqual({ operations: [] });
  });

  it("function source has no forbidden runtime APIs", () => {
    for (const bad of ["Date", "Math.random", "fetch", "Intl", "process", "require("]) {
      const hits = FN_SRC.split("\n").filter((l) => !l.trimStart().startsWith("//") && l.includes(bad));
      expect(hits, `source must not contain ${bad}`).toEqual([]);
    }
    expect(readFileSync(join(EXT_SRC, "dest-key.ts"), "utf8")).not.toMatch(/\bDate\b|Math\.random|fetch|Intl|process|require\(/);
  });

  it("every field the function reads exists in the input query selection", () => {
    const needed = [
      "isAuthenticated", "customer", "metafield", "jsonValue", "deliveryGroups",
      "deliveryAddress", "countryCode", "provinceCode", "zip", "city",
      "deliveryOptions", "handle", "title", "deliveryMethodType", "cost",
      "currencyCode", "discount", "discountClasses", "shop", "localTime",
      "date", "buyerIdentity", "cart",
    ];
    for (const f of needed) {
      expect(INPUT_QUERY, `input query must select ${f}`).toContain(f);
    }
    // And it must select inWindow via the dateTimeBetween alias.
    expect(INPUT_QUERY).toContain("inWindow: dateTimeBetween");
  });
});

describe("dest-key normalization", () => {
  it("folds case, whitespace, diacritics and zip punctuation", () => {
    expect(destKey({ countryCode: " BR ", provinceCode: "SP", zip: "01310-100", city: "São  Paulo" })).toBe("br|sp|01310100|sao paulo");
    expect(destKey({ countryCode: "GB", provinceCode: null, zip: "SW1A 1AA", city: "London" })).toBe("gb||sw1a1aa|london");
    expect(normZip(" SW1A   1AA ")).toBe("sw1a1aa");
    expect(normMethod("  Express   Saver ")).toBe("express saver");
  });
  it("null when country/zip/city are missing or normalize empty", () => {
    expect(destKey(null)).toBeNull();
    expect(destKey({ countryCode: null, zip: "1", city: "x" })).toBeNull();
    expect(destKey({ countryCode: "US", zip: null, city: "x" })).toBeNull();
    expect(destKey({ countryCode: "US", zip: "   ", city: "x" })).toBeNull();
    expect(destKey({ countryCode: "US", zip: "1", city: null })).toBeNull();
  });
});

// ── Projection ──────────────────────────────────────────────────────────

const orderFacts = (over: Partial<OrderFacts> = {}): OrderFacts => ({
  orderId: "gid://shopify/Order/555",
  customerId: "gid://shopify/Customer/1",
  currencyCode: "USD",
  shippingAddress: { countryCode: "US", provinceCode: "NY", zip: "10001", city: "New York" },
  shippingLines: [{ title: "Standard Shipping", originalMinor: "800", discountedMinor: "800" }],
  cancelledAt: null,
  financialStatus: "PAID",
  ...over,
});
const cfg = { windowId: "w1", expiresOn: "2099-01-01" };

describe("projection.buildRecord", () => {
  it("builds a v1 record from a qualifying order", () => {
    const r = buildRecord(orderFacts(), cfg);
    expect(r).toMatchObject({
      ok: true,
      record: { id: "555", win: "w1", dest: "us|ny|10001|new york", method: "standard shipping", cur: "USD", left: 1, exp: "2099-01-01" },
    });
  });
  it("refuses each disqualifier with a typed reason", () => {
    expect(buildRecord(orderFacts({ customerId: null }), cfg)).toEqual({ ok: false, reason: "NO_CUSTOMER" });
    expect(buildRecord(orderFacts({ cancelledAt: "2026-11-01" }), cfg)).toEqual({ ok: false, reason: "CANCELLED" });
    expect(buildRecord(orderFacts({ financialStatus: "PENDING" }), cfg)).toEqual({ ok: false, reason: "NOT_PAID" });
    expect(buildRecord(orderFacts({ shippingLines: [] }), cfg)).toEqual({ ok: false, reason: "NOT_SINGLE_SHIPPING_LINE" });
    expect(buildRecord(orderFacts({ shippingLines: [
      { title: "A", originalMinor: "100", discountedMinor: "100" },
      { title: "B", originalMinor: "100", discountedMinor: "100" },
    ] }), cfg)).toEqual({ ok: false, reason: "NOT_SINGLE_SHIPPING_LINE" });
    expect(buildRecord(orderFacts({ shippingLines: [{ title: "Free", originalMinor: "0", discountedMinor: "0" }] }), cfg)).toEqual({ ok: false, reason: "ZERO_SHIPPING" });
    expect(buildRecord(orderFacts({ shippingAddress: null }), cfg)).toEqual({ ok: false, reason: "NO_DEST" });
  });
});

describe("projection.mergeRecords", () => {
  const r1 = rec({ id: "111" });
  const r2 = rec({ id: "222", exp: "2099-02-01" });
  it("unions new ids, is idempotent and byte-stable", () => {
    const first = mergeRecords(null, [r1], { todayDate: "2026-11-01" });
    const again = mergeRecords(first.serialized, [r1], { todayDate: "2026-11-01" });
    expect(again.serialized).toBe(first.serialized);
    const uni = mergeRecords(first.serialized, [r2], { todayDate: "2026-11-01" });
    expect(uni.doc.recs.map((r) => r.id)).toEqual(["111", "222"]);
    expect(uni.serialized).toBe(serializeElig(uni.doc));
  });
  it("an existing id keeps its (possibly consumed) left — replays never reset", () => {
    const consumed = consumeRecord(serializeElig({ v: 1, recs: [r1] }), { recordId: "111", byOrderId: "o1" });
    const merged = mergeRecords(consumed.serialized, [r1, r2], { todayDate: "2026-11-01" });
    // r1 stays only as a left:0 tombstone (used:["o1"]): the replay cannot
    // restore left, and the Function ignores left<=0 records entirely.
    expect(merged.doc.recs.map((r) => [r.id, r.left])).toEqual([["111", 0], ["222", 1]]);
  });
  it("prunes expired and left<=0 records and caps at maxRecs earliest-exp", () => {
    const recs = ["9", "1", "2", "3", "4", "5"].map((id, i) => rec({ id, exp: `2099-0${i + 1}-01` }));
    recs[0].exp = "2000-01-01"; // expired
    recs[1].left = 0; // consumed
    const merged = mergeRecords(null, recs, { todayDate: "2026-11-01", maxRecs: 3 });
    expect(merged.doc.recs.map((r) => r.id)).toEqual(["2", "3", "4"]);
  });
  it("tolerates garbage and reports it", () => {
    expect(mergeRecords("{{{", [r1], { todayDate: "2026-11-01" }).garbage).toBe(true);
    expect(mergeRecords({ v: 2 }, [r1], { todayDate: "2026-11-01" }).garbage).toBe(true);
    expect(mergeRecords(null, [r1], { todayDate: "2026-11-01" }).garbage).toBe(false);
    expect(parseElig("not json").doc.recs).toEqual([]);
    expect(parseElig({ v: 1, recs: [{ bad: 1 }, r1] }).doc.recs.map((r) => r.id)).toEqual(["111"]);
  });
});

describe("projection.consumeRecord", () => {
  it("decrements once per byOrderId — idempotent under replay", () => {
    const start = serializeElig({ v: 1, recs: [rec({ id: "111", left: 2 })] });
    const one = consumeRecord(start, { recordId: "111", byOrderId: "o1" });
    expect(one.changed).toBe(true);
    expect(one.doc.recs[0].left).toBe(1);
    const replay = consumeRecord(one.serialized, { recordId: "111", byOrderId: "o1" });
    expect(replay.changed).toBe(false);
    expect(replay.serialized).toBe(one.serialized);
    const two = consumeRecord(one.serialized, { recordId: "111", byOrderId: "o2" });
    // left hit 0 → kept only as a used tombstone (never grants, pruned on exp).
    expect(two.doc.recs.length).toBe(1);
    expect(two.doc.recs[0].left).toBe(0);
    expect(two.doc.recs[0].used).toEqual(["o1", "o2"]);
  });
});

describe("projection.writeProjection (fake CAS admin)", () => {
  const gid = "gid://shopify/Customer/1";
  const sleepLog: number[] = [];
  const sleep = async (ms: number) => {
    sleepLog.push(ms);
  };

  it("first write uses compareDigest null and persists", async () => {
    const admin = makeFakeEligibilityAdmin();
    const r = await writeProjection(admin, gid, () => ({ serialized: serializeElig({ v: 1, recs: [r1v()] }) }));
    expect(r).toEqual({ written: true, attempts: 1 });
    expect(admin.writes.length).toBe(1);
    expect(admin.stored(gid)).toMatchObject({ v: 1 });
  });

  it("no-ops on byte-identical state — zero writes", async () => {
    const admin = makeFakeEligibilityAdmin();
    const s = serializeElig({ v: 1, recs: [r1v()] });
    await writeProjection(admin, gid, () => ({ serialized: s }));
    const r = await writeProjection(admin, gid, () => ({ serialized: s }));
    expect(r.written).toBe(false);
    expect(admin.writes.length).toBe(1);
  });

  it("two concurrent writers for DIFFERENT orders converge to the union — one retry, no lost update", async () => {
    const admin = makeFakeEligibilityAdmin();
    const o1 = { ...r1v(), id: "111" };
    const o2 = { ...r1v(), id: "222" };
    admin.setInterleaveHook(async () => {
      // B commits entirely inside A's read→write gap.
      await writeProjection(admin, gid, () => ({ serialized: serializeElig({ v: 1, recs: [o2] }) }));
    });
    const a = await writeProjection(admin, gid, (cur) => {
      const m = mergeRecords(cur, [o1], { todayDate: "2026-11-01" });
      return { serialized: m.serialized };
    });
    expect(a.written).toBe(true);
    expect(a.attempts).toBe(2); // one CAS loss, retried
    expect(admin.stored(gid)).toMatchObject({ v: 1, recs: [{ id: "111" }, { id: "222" }] });
  });

  it("same order projected twice concurrently ⇒ one record", async () => {
    const admin = makeFakeEligibilityAdmin();
    const o1 = r1v();
    admin.setInterleaveHook(async () => {
      await writeProjection(admin, gid, () => ({ serialized: serializeElig({ v: 1, recs: [o1] }) }));
    });
    const r = await writeProjection(admin, gid, (cur) => {
      const m = mergeRecords(cur, [o1], { todayDate: "2026-11-01" });
      return { serialized: m.serialized };
    });
    // A's CAS lost once (B committed first); the retry re-reads the same
    // record, merges to byte-identical state and no-ops — either return is
    // correct, what matters is the CAS collided exactly once.
    expect(r.attempts).toBe(2);
    const stored = admin.stored(gid) as { recs: { id: string }[] };
    expect(stored.recs.length).toBe(1);
    expect(stored.recs[0].id).toBe("111");
  });

  it("exhausts retries to ProjectionConflictError with injected sleep (no timers)", async () => {
    const admin = makeFakeEligibilityAdmin();
    sleepLog.length = 0;
    // Every CAS write sees another writer first — always stale. The hook
    // disarms itself for its own nested write, then re-arms.
    const collide = async () => {
      admin.setInterleaveHook(async () => {});
      await writeProjection(admin, gid, (cur) => ({
        serialized: serializeElig(mergeRecords(cur, [{ ...r1v(), id: `x${admin.callCount}` }], { todayDate: "2026-11-01" }).doc),
      }));
      admin.setInterleaveHook(collide);
    };
    admin.setInterleaveHook(collide);
    await expect(
      writeProjection(admin, gid, (cur) => ({ serialized: serializeElig(mergeRecords(cur, [r1v()], { todayDate: "2026-11-01" }).doc) }), { maxRetries: 3, sleep, random: () => 0.5 }),
    ).rejects.toBeInstanceOf(ProjectionConflictError);
    expect(sleepLog.length).toBe(3); // one injected backoff per stale CAS loss
  });

  it("a non-STALE userError throws ProjectionWriteError", async () => {
    const admin = makeFakeEligibilityAdmin();
    const orig = admin.graphql.bind(admin);
    admin.graphql = (async (q: string, o?: { variables?: Record<string, unknown> }) => {
      if (q.includes("metafieldsSet")) {
        return { data: { metafieldsSet: { metafields: [], userErrors: [{ code: "TOO_LONG", field: ["value"], message: "too long", elementIndex: 0 }] } } };
      }
      return orig(q, o);
    }) as typeof admin.graphql;
    await expect(
      writeProjection(admin, gid, () => ({ serialized: serializeElig({ v: 1, recs: [r1v()] }) })),
    ).rejects.toBeInstanceOf(ProjectionWriteError);
  });
});

function r1v(): EligRecord {
  return rec({ id: "111" });
}

// ── Grant detection ─────────────────────────────────────────────────────

const grantOrder = (over: Record<string, unknown> = {}) => ({
  shippingLines: [
    {
      title: "Standard Shipping",
      originalMinor: "800",
      discountedMinor: "0",
      discountAllocations: [{ amountMinor: "800", applicationTitle: "Free shipping — welcome back" }],
    },
  ],
  discountApplications: [{ targetType: "SHIPPING_LINE", title: "Free shipping — welcome back" }],
  ...over,
});
const MSG = "Free shipping — welcome back";

describe("detectShippingDiscountGrant", () => {
  it("no discount ⇒ NONE", () => {
    const r = detectShippingDiscountGrant(grantOrder({
      shippingLines: [{ originalMinor: "800", discountedMinor: "800", discountAllocations: [] }],
      discountApplications: [],
    }), { titleToken: MSG });
    expect(r).toEqual({ granted: false, grantedMinor: "0", evidence: "NONE", ambiguous: false });
  });
  it("full free shipping with a titled SHIPPING_LINE application ⇒ ALLOCATION", () => {
    const r = detectShippingDiscountGrant(grantOrder(), { titleToken: MSG });
    expect(r).toEqual({ granted: true, grantedMinor: "800", evidence: "ALLOCATION", ambiguous: false });
  });
  it("partial shipping discount ⇒ PRICE_DELTA ambiguous (unattributed)", () => {
    const r = detectShippingDiscountGrant(grantOrder({
      shippingLines: [{ originalMinor: "800", discountedMinor: "600", discountAllocations: [] }],
      discountApplications: [],
    }), { titleToken: MSG });
    expect(r).toEqual({ granted: true, grantedMinor: "200", evidence: "PRICE_DELTA", ambiguous: true });
  });
  it("an unrelated shipping discount ⇒ granted + ambiguous (fail-safe suppress)", () => {
    const r = detectShippingDiscountGrant(grantOrder({
      discountApplications: [{ targetType: "SHIPPING_LINE", title: "Some other promo" }],
    }), { titleToken: MSG });
    expect(r.granted).toBe(true);
    expect(r.ambiguous).toBe(true);
  });
  it("multiple shipping lines and multiple shipping apps sum the delta and stay ambiguous", () => {
    const r = detectShippingDiscountGrant(grantOrder({
      shippingLines: [
        { originalMinor: "800", discountedMinor: "400" },
        { originalMinor: "300", discountedMinor: "300" },
      ],
      discountApplications: [
        { targetType: "SHIPPING_LINE", title: MSG },
        { targetType: "SHIPPING_LINE", title: "Other" },
      ],
    }), { titleToken: MSG });
    expect(r).toEqual({ granted: true, grantedMinor: "400", evidence: "PRICE_DELTA", ambiguous: true });
  });
});

// ── Isolation ───────────────────────────────────────────────────────────

it("nothing under spikes/ imports from app/ — the prototype stays isolated", () => {
  const stack = [SPIKES];
  const files: string[] = [];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) files.push(p);
    }
  }
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const imports = src.match(/from\s+["'][^"']+["']|require\([^)]+\)/g) ?? [];
    for (const imp of imports) {
      expect(imp, `${f} must not import app/`).not.toMatch(/app\/|\.\.\/\.\.\/app/);
    }
  }
});
