// Parity fixtures — replicate the Function-matrix cases from
// tests/spike-checkout-shipping-discount.test.ts (semantics only; do not
// weaken or alter a case to make parity pass).
export const CFG = { v: 1, windowId: "w1", percentage: "100.0", message: "Free shipping — welcome back" };

// Strict destination key — replicates the engine normalizer
// (lowercase, strip non-letter/number/whitespace, collapse, trim) and the
//  slot layout. Fixture-side helper only; the implementation under
// test computes the same key independently inside the Function.
const NON_LETTER = /[^\p{L}\p{N}\s]/gu;
const norm = (s) => (s == null ? "" : String(s).toLowerCase().replace(NON_LETTER, "").replace(/\s+/g, " ").trim());
const K = (a) =>
  [a.firstName, a.lastName, a.company, a.address1, a.address2, a.city, a.provinceCode, a.zip, a.countryCode]
    .map(norm)
    .join("\u001f");

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
const ADDR_KEY = K(ADDR);

const option = (over = {}) => ({
  handle: "opt_std",
  title: "Standard Shipping",
  deliveryMethodType: "SHIPPING",
  cost: { amount: "8.00", currencyCode: "USD" },
  ...over,
});
const rec = (over = {}) => ({
  id: "111",
  win: "w1",
  dest: ADDR_KEY,
  method: "standard shipping",
  cur: "USD",
  left: 1,
  exp: "2099-01-01",
  ...over,
});
const eligMf = (recs) => ({ jsonValue: { v: 1, recs } });

function base(over = {}) {
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
      ...(over.cart ?? {}),
    },
    discount: { discountClasses: ["SHIPPING"], metafield: { jsonValue: CFG }, ...(over.discount ?? {}) },
    shop: { localTime: { date: "2026-11-01", inWindow: true }, ...(over.shop ?? {}) },
  };
}
const withCustomer = (i, mf) => ({
  ...i,
  cart: { ...i.cart, buyerIdentity: { ...i.cart.buyerIdentity, customer: { ...i.cart.buyerIdentity.customer, metafield: mf } } },
});
const withOptions = (i, opts) => ({
  ...i,
  cart: { ...i.cart, deliveryGroups: [{ ...i.cart.deliveryGroups[0], deliveryOptions: opts }] },
});
const withAddr = (i, addr) => ({
  ...i,
  cart: { ...i.cart, deliveryGroups: [{ ...i.cart.deliveryGroups[0], deliveryAddress: addr }] },
});

const cases = [];
const add = (name, input) => cases.push({ name, input });

add("happy", base());
add("guest-unauthenticated", (() => { const i = base(); i.cart.buyerIdentity = { isAuthenticated: false, customer: null }; return i; })());
add("no-metafield", withCustomer(base(), null));
for (const [n, v] of [
  ["garbage-string", "garbage"],
  ["garbage-number", 42],
  ["garbage-array", []],
  ["garbage-v2", { v: 2, recs: [rec()] }],
  ["garbage-recs-not-array", { v: 1, recs: "no" }],
  ["garbage-bad-rec", { v: 1, recs: [{ id: 1 }] }],
  ["garbage-json-string", "{not json"],
]) add(`metafield-${n}`, withCustomer(base(), { jsonValue: v }));
add("out-of-window", (() => { const i = base(); i.shop.localTime = { ...i.shop.localTime, inWindow: false }; return i; })());
add("exp-equals-date", withCustomer(base(), eligMf([rec({ exp: "2026-11-01" })])));
add("exp-before-date", withCustomer(base(), eligMf([rec({ exp: "2026-10-31" })])));
add("left-zero", withCustomer(base(), eligMf([rec({ left: 0 })])));
add("win-mismatch", withCustomer(base(), eligMf([rec({ win: "w2" })])));
add("currency-mismatch", withCustomer(base(), eligMf([rec({ cur: "EUR" })])));
add("dest-zip-mismatch", withCustomer(base(), eligMf([rec({ dest: K({ ...ADDR, zip: "90210" }) })])));
add("dest-city-mismatch", withCustomer(base(), eligMf([rec({ dest: K({ ...ADDR, city: "Boston" }) })])));
add("dest-country-mismatch", withCustomer(base(), eligMf([rec({ dest: K({ ...ADDR, countryCode: "CA" }) })])));
add("dest-street-mismatch", withCustomer(base(), eligMf([rec({ dest: K({ ...ADDR, address1: "99 Main St" }) })])));
add("dest-unit-mismatch", withCustomer(base(), eligMf([rec({ dest: K({ ...ADDR, address2: "Apt 9" }) })])));
add("dest-name-mismatch", withCustomer(base(), eligMf([rec({ dest: K({ ...ADDR, firstName: "John" }) })])));
add("dest-company-mismatch", withCustomer(base(), eligMf([rec({ dest: K({ ...ADDR, company: "Acme Inc" }) })])));
add("street-punct-equal", withAddr(base(), { ...ADDR, address1: "  123  Main   St. " }));
add(
  "norm-diacritics-sao-paulo",
  withOptions(
    withCustomer(
      withAddr(base(), { ...ADDR, countryCode: "br", provinceCode: null, zip: " 01310-100 ", city: "São  Paulo" }),
      eligMf([rec({ dest: K({ ...ADDR, countryCode: "br", provinceCode: null, zip: " 01310-100 ", city: "São  Paulo" }), cur: "BRL" })]),
    ),
    [option({ cost: { amount: "8.00", currencyCode: "BRL" } })],
  ),
);
add("partial-addr-no-zip", withAddr(base(), { ...ADDR, zip: null }));
add("partial-addr-no-city", withAddr(base(), { ...ADDR, city: null }));
add("partial-addr-no-country", withAddr(base(), { ...ADDR, countryCode: null }));
add("partial-addr-no-address1", withAddr(base(), { ...ADDR, address1: null }));
add("missing-province-ok", withCustomer(
  withAddr(base(), { ...ADDR, countryCode: "IE", provinceCode: null, zip: "D02 X285", city: "Dublin" }),
  eligMf([rec({ dest: K({ ...ADDR, countryCode: "IE", provinceCode: null, zip: "D02 X285", city: "Dublin" }) })]),
));
add("missing-province-wrong-slot", withCustomer(
  withAddr(base(), { ...ADDR, countryCode: "IE", provinceCode: null, zip: "D02 X285", city: "Dublin" }),
  eligMf([rec({ dest: K({ ...ADDR, countryCode: "IE", provinceCode: "xx", zip: "D02 X285", city: "Dublin" }) })]),
));
add("method-mismatch-only", withOptions(base(), [option({ title: "Express", handle: "opt_exp" })]));
add("method-match-among-others", withOptions(base(), [
  option({ title: "Express", handle: "opt_exp" }),
  option({ title: "Standard  Shipping", handle: "opt_std2" }),
  option({ title: "Standard Shipping", handle: "opt_pickup", deliveryMethodType: "PICKUP" }),
]));
add("pickup-same-title", withOptions(base(), [option({ deliveryMethodType: "PICKUP", handle: "opt_p" })]));
add("two-delivery-groups", (() => { const i = base(); i.cart.deliveryGroups.push({ id: "dg2", deliveryAddress: { ...ADDR }, deliveryOptions: [option()] }); return i; })());
add("two-valid-recs-earliest-exp", withOptions(
  withCustomer(base(), eligMf([
    rec({ id: "222", exp: "2099-02-01" }),
    rec({ id: "111", exp: "2099-01-01" }),
  ])),
  [option({ handle: "h_a" }), option({ handle: "h_b" })],
));
add("no-shipping-class", (() => { const i = base(); i.discount.discountClasses = ["PRODUCT"]; return i; })());
for (const [n, p] of [["pct-0", "0"], ["pct-101", "101"], ["pct-abc", "abc"], ["pct-neg", "-5"], ["pct-num", 100], ["pct-missing", undefined]]) {
  add(`bad-percentage-${n}`, (() => { const i = base(); i.discount.metafield = { jsonValue: { ...CFG, percentage: p } }; return i; })());
}
add("bad-config-v2", (() => { const i = base(); i.discount.metafield = { jsonValue: { v: 2 } }; return i; })());
add("missing-config", (() => { const i = base(); i.discount.metafield = null; return i; })());

// Unicode / runtime probes — same function, address/city/zip fields carry
// the probe strings; the record dest is the fixture helper's normalization
// of the SAME address, so any Node-vs-Javy divergence shows as a DIFF.
const probe = (name, addrOver, cur = "USD") => {
  const addr = { ...ADDR, ...addrOver };
  return add(`probe-${name}`, withOptions(
    withCustomer(withAddr(base(), addr), eligMf([rec({ dest: K(addr), cur })])),
    [option({ cost: { amount: "8.00", currencyCode: cur } })],
  ));
};
probe("sao-paulo-nfc", { countryCode: "BR", provinceCode: null, zip: "01310-100", city: "São Paulo" }, "BRL");
probe("sao-paulo-nfd", { countryCode: "BR", provinceCode: null, zip: "01310-100", city: "São Paulo" }, "BRL");
probe("zurich", { countryCode: "CH", provinceCode: "ZH", zip: "8001", city: "Zürich" }, "CHF");
probe("istanbul", { countryCode: "TR", provinceCode: null, zip: "34000", city: "İstanbul" }, "TRY");
probe("cjk-tokyo", { countryCode: "JP", provinceCode: null, zip: "100-0001", city: "東京" }, "JPY");
probe("arabic-riyadh", { countryCode: "SA", provinceCode: null, zip: "11564", city: "الرياض" }, "SAR");
probe("cyrillic-moscow", { countryCode: "RU", provinceCode: null, zip: "101000", city: "Москва" }, "RUB");
probe("emoji-city", { city: "New York 🗽" });
probe("combining-only", { city: "´" });
probe("long-city", { city: `New${" ".repeat(4)}York` });

export const PARITY_CASES = cases;
