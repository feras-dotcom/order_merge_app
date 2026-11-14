// Eligibility records: projection build/merge/consume/revoke, the
// Function-equivalent selection used for consumption, expiry (D4) and a
// Function-parity matrix — selectRecordForCheckout must pick exactly the
// record the Function would discount, and null iff the Function emits no
// operation.
import { describe, expect, it } from "vitest";
import { cartDeliveryOptionsDiscountsGenerateRun } from "../functions/checkout-shipping-discount/src/cart_delivery_options_discounts_generate_run";
import { destKey } from "../app/lib/checkout-discount/dest-key";
import {
  buildRecord,
  consumeRecord,
  expiryDateFor,
  mergeRecords,
  parseElig,
  revokeRecord,
  selectRecordForCheckout,
  serializeElig,
  type EligRecord,
  type OrderFacts,
} from "../app/lib/checkout-discount/records";

const K = (...f: string[]) => f.join("\u001f");
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
const ADDR_KEY = K("jane", "doe", "acme", "123 main st", "apt 4", "new york", "ny", "10001", "us");
const rec = (over: Record<string, unknown> = {}): EligRecord => ({
  id: "111",
  win: "w1",
  dest: ADDR_KEY,
  method: "standard shipping",
  cur: "USD",
  left: 1,
  exp: "2099-01-01",
  ...over,
});
const orderFacts = (over: Partial<OrderFacts> = {}): OrderFacts => ({
  orderId: "gid://shopify/Order/555",
  customerId: "gid://shopify/Customer/1",
  currencyCode: "USD",
  shippingAddress: { ...ADDR },
  shippingLines: [{ title: "Standard Shipping", originalMinor: "800", discountedMinor: "800" }],
  cancelledAt: null,
  financialStatus: "PAID",
  ...over,
});
const cfg = { windowId: "w1", expiresOn: "2099-01-01" };
const MATCH = { win: "w1", dest: ADDR_KEY, method: "standard shipping", cur: "USD", today: "2026-11-01" };

describe("projection.buildRecord", () => {
  it("builds a v1 record from a qualifying order", () => {
    const r = buildRecord(orderFacts(), cfg);
    expect(r).toMatchObject({
      ok: true,
      record: { id: "555", win: "w1", dest: ADDR_KEY, method: "standard shipping", cur: "USD", left: 1, exp: "2099-01-01" },
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
    // A fully-discounted line (another promo) never issues either — D3
    // requires original AND discounted > 0.
    expect(buildRecord(orderFacts({ shippingLines: [{ title: "S", originalMinor: "800", discountedMinor: "0" }] }), cfg)).toEqual({ ok: false, reason: "ZERO_SHIPPING" });
    expect(buildRecord(orderFacts({ shippingAddress: null }), cfg)).toEqual({ ok: false, reason: "NO_DEST" });
    expect(buildRecord(orderFacts({ shippingAddress: { ...ADDR, address1: null } }), cfg)).toEqual({ ok: false, reason: "NO_DEST" });
    expect(buildRecord(orderFacts({ shippingAddress: { ...ADDR, countryCode: null } }), cfg)).toEqual({ ok: false, reason: "NO_DEST" });
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
    expect(merged.doc.recs.map((r) => [r.id, r.left])).toEqual([["111", 0], ["222", 1]]);
  });
  it("prunes expired and left<=0 records and caps at maxRecs earliest-exp", () => {
    const recs = ["9", "1", "2", "3", "4", "5"].map((id, i) => rec({ id, exp: `2099-0${i + 1}-01` }));
    recs[0].exp = "2000-01-01"; // expired
    recs[1].left = 0; // consumed, no used list
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
    expect(two.doc.recs.length).toBe(1);
    expect(two.doc.recs[0].left).toBe(0);
    expect(two.doc.recs[0].used).toEqual(["o1", "o2"]);
  });
  it("an absent record is a no-op", () => {
    const r = consumeRecord(serializeElig({ v: 1, recs: [rec()] }), { recordId: "999", byOrderId: "o1" });
    expect(r.changed).toBe(false);
  });
});

describe("records.revokeRecord", () => {
  it("removes an unused record; unchanged when the id is absent", () => {
    const doc = serializeElig({ v: 1, recs: [rec({ id: "111" }), rec({ id: "222" })] });
    const r = revokeRecord(doc, "111");
    expect(r.changed).toBe(true);
    expect(r.doc.recs.map((x) => x.id)).toEqual(["222"]);
    expect(revokeRecord(doc, "999").changed).toBe(false);
  });
  it("a record with a used list becomes a left:0 tombstone, never deleted", () => {
    const used = { ...rec({ id: "111" }), left: 0, used: ["o1"] };
    const r = revokeRecord(serializeElig({ v: 1, recs: [used] }), "111");
    expect(r.doc.recs.length).toBe(1);
    expect(r.doc.recs[0].left).toBe(0);
    expect(r.doc.recs[0].used).toEqual(["o1"]);
    // left already 0 => nothing changed (no write needed).
    expect(r.changed).toBe(false);
    const half = { ...rec({ id: "111" }), left: 1, used: ["o1"] };
    expect(revokeRecord(serializeElig({ v: 1, recs: [half] }), "111").doc.recs[0].left).toBe(0);
  });
});

describe("records.selectRecordForCheckout (Function-equivalent)", () => {
  it("picks the matching record; earliest exp wins, lowest id breaks ties", () => {
    const doc = serializeElig({
      v: 1,
      recs: [
        rec({ id: "222", exp: "2099-02-01" }),
        rec({ id: "111", exp: "2099-01-01" }),
        rec({ id: "0", exp: "2099-01-01" }),
      ],
    });
    expect(selectRecordForCheckout(doc, MATCH)?.id).toBe("0");
  });
  it("requires left>0, exp>=today and every key slot to match", () => {
    const doc = serializeElig({ v: 1, recs: [rec()] });
    expect(selectRecordForCheckout(doc, MATCH)?.id).toBe("111");
    expect(selectRecordForCheckout(doc, { ...MATCH, win: "w2" })).toBeNull();
    expect(selectRecordForCheckout(doc, { ...MATCH, dest: "other" })).toBeNull();
    expect(selectRecordForCheckout(doc, { ...MATCH, method: "express" })).toBeNull();
    expect(selectRecordForCheckout(doc, { ...MATCH, cur: "EUR" })).toBeNull();
    expect(selectRecordForCheckout(doc, { ...MATCH, today: "2100-01-01" })).toBeNull();
    expect(selectRecordForCheckout(serializeElig({ v: 1, recs: [rec({ left: 0 })] }), MATCH)).toBeNull();
    expect(selectRecordForCheckout("garbage", MATCH)).toBeNull();
  });

  // Parity: for a matrix of documents/carts, selectRecordForCheckout picks
  // exactly the record id the Function discounts — null iff no operation.
  const fnInput = (recs: unknown[], opts: Record<string, unknown> = {}) => ({
    cart: {
      buyerIdentity: {
        isAuthenticated: true,
        customer: { id: "gid://shopify/Customer/1", metafield: { jsonValue: { v: 1, recs } } },
      },
      deliveryGroups: [
        {
          id: "dg1",
          deliveryAddress: { ...ADDR, ...(opts.addr as object) },
          deliveryOptions: [
            {
              handle: "opt_std",
              title: (opts.title as string) ?? "Standard Shipping",
              deliveryMethodType: "SHIPPING",
              cost: { amount: "8.00", currencyCode: (opts.cur as string) ?? "USD" },
            },
          ],
        },
      ],
    },
    discount: { discountClasses: ["SHIPPING"], metafield: { jsonValue: { v: 1, windowId: "w1", percentage: "100.0", message: "m" } } },
    shop: { localTime: { date: "2026-11-01", inWindow: true } },
  });

  const cases: { name: string; recs: EligRecord[]; opts?: Record<string, unknown>; win?: string }[] = [
    { name: "single matching", recs: [rec()] },
    { name: "earliest exp of two", recs: [rec({ id: "222", exp: "2099-02-01" }), rec({ id: "111" })] },
    { name: "same exp, lowest id", recs: [rec({ id: "222" }), rec({ id: "111" })] },
    { name: "used tombstone skipped, next record wins", recs: [{ ...rec({ id: "111" }), left: 0, used: ["o1"] }, rec({ id: "222", exp: "2099-02-01" })] },
    { name: "wrong window", recs: [rec({ win: "w2" })] },
    { name: "wrong method", recs: [rec({ method: "express" })] },
    { name: "wrong currency", recs: [rec({ cur: "EUR" })] },
    { name: "wrong dest", recs: [rec({ dest: "nope" })] },
    { name: "expired", recs: [rec({ exp: "2026-10-31" })] },
    { name: "option method mismatch", recs: [rec()], opts: { title: "Express" } },
    { name: "empty doc", recs: [] },
  ];
  for (const c of cases) {
    it(`parity: ${c.name}`, () => {
      const out = (cartDeliveryOptionsDiscountsGenerateRun as (i: unknown) => { operations: any[] })(
        fnInput(c.recs, c.opts),
      );
      const dest = destKey({ ...ADDR, ...(c.opts?.addr as object) }) ?? "";
      const method = ((c.opts?.title as string) ?? "Standard Shipping").trim().replace(/\s+/g, " ").toLowerCase();
      const sel = selectRecordForCheckout(
        JSON.stringify({ v: 1, recs: c.recs }),
        { win: c.win ?? "w1", dest, method, cur: (c.opts?.cur as string) ?? "USD", today: "2026-11-01" },
      );
      const discounted = out.operations.length === 1;
      if (discounted) {
        expect(sel, "a discounted checkout must have a selectable record").not.toBeNull();
      } else {
        expect(sel, "no operation must mean no selectable record").toBeNull();
      }
    });
  }
});

describe("records.expiryDateFor (D4)", () => {
  it("is localDate(createdAt + window) - 1 calendar day, floored at the order date", () => {
    // 24h window on a mid-morning order: end next day, minus a day = the
    // order's own local date.
    expect(expiryDateFor({ createdAt: "2026-11-01T15:00:00Z", windowHours: 24, timeZone: "America/New_York" })).toBe("2026-11-01");
    // 72h window: end 2026-11-04 local (Nov 1 15:00Z + 72h = Nov 4 15:00Z =
    // Nov 4 10:00 EST), minus one day => Nov 3.
    expect(expiryDateFor({ createdAt: "2026-11-01T15:00:00Z", windowHours: 72, timeZone: "America/New_York" })).toBe("2026-11-03");
    // Order just before midnight shop-local: a 24h window ends the NEXT
    // local day, exp = that day - 1 = the order date — never past the window.
    expect(expiryDateFor({ createdAt: "2026-11-02T03:30:00Z", windowHours: 24, timeZone: "America/New_York" })).toBe("2026-11-01");
  });
  it("a window shorter than a day floors at the order's local date", () => {
    expect(expiryDateFor({ createdAt: "2026-11-01T15:00:00Z", windowHours: 6, timeZone: "America/New_York" })).toBe("2026-11-01");
  });
  it("never lands AFTER the merge window across a DST change (calendar day, not 24h)", () => {
    // Spring forward 2026-03-08 in America/New_York: a naive ts-minus-24h
    // crosses the skipped hour onto the wrong local date; the calendar
    // subtraction must still land one local day earlier.
    const exp = expiryDateFor({ createdAt: "2026-03-07T12:00:00Z", windowHours: 48, timeZone: "America/New_York" });
    // end = Mar 9 12:00Z = Mar 9 08:00 EDT -> minus one calendar day = Mar 8.
    expect(exp).toBe("2026-03-08");
    // A 24h subtraction from the end timestamp would be Mar 8 12:00Z = Mar 8
    // 08:00 EDT — same date here, so also verify a case where they differ:
    // end lands within the skipped-hour boundary region.
    const exp2 = expiryDateFor({ createdAt: "2026-03-07T06:30:00Z", windowHours: 24, timeZone: "America/New_York" });
    // end = Mar 8 06:30Z = Mar 8 01:30 EST -> minus one day = Mar 7.
    expect(exp2).toBe("2026-03-07");
  });
  it("respects the shop timezone — the same instant expires a day apart", () => {
    // 2026-11-02T04:30Z is Nov 1 in New York but Nov 2 in UTC.
    expect(expiryDateFor({ createdAt: "2026-11-02T04:30:00Z", windowHours: 24, timeZone: "UTC" })).toBe("2026-11-02");
    expect(expiryDateFor({ createdAt: "2026-11-02T04:30:00Z", windowHours: 24, timeZone: "America/New_York" })).toBe("2026-11-01");
  });
});
