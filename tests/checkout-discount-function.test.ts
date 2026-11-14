// Checkout shipping-discount Function: ported spike tests repointed at
// functions/checkout-shipping-discount/ PLUS the strict output-shape
// regression — every emitted result is validated against a trimmed copy of
// the published Shopify Functions schema (DeliveryDiscountSelectionStrategy
// has exactly one value, ALL; a "FIRST" result is schema-invalid and Shopify
// silently discards it — observed live on the spike store).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSchema, coerceInputValue } from "graphql";
import { cartDeliveryOptionsDiscountsGenerateRun } from "../functions/checkout-shipping-discount/src/cart_delivery_options_discounts_generate_run";
import { destKey, normMethod, normAddressLine, SEP } from "../functions/checkout-shipping-discount/src/dest-key";
import { buildAddressKey } from "../app/lib/eligibility";
import type { EligRecord } from "../app/lib/checkout-discount/records";

const FN_DIR = join(__dirname, "..", "functions", "checkout-shipping-discount");
const EXT_SRC = join(FN_DIR, "src");
const FN_SRC = readFileSync(join(EXT_SRC, "cart_delivery_options_discounts_generate_run.ts"), "utf8");
const INPUT_QUERY = readFileSync(join(EXT_SRC, "cart_delivery_options_discounts_generate_run.graphql"), "utf8");
const SCHEMA = buildSchema(
  readFileSync(join(__dirname, "fixtures", "shopify-function-output-schema.graphql"), "utf8"),
);
const RESULT_TYPE = SCHEMA.getType("CartDeliveryOptionsDiscountsGenerateRunResult") as any;

/** Structural validity of a Function result against the trimmed published
 *  schema — throws on any violation (bad enum, missing field, extra key). */
const assertValidResult = (out: unknown) => coerceInputValue(out, RESULT_TYPE);

// ── Function input factory ──────────────────────────────────────────────

const CFG = { v: 1, windowId: "w1", percentage: "100.0", message: "Free shipping — welcome back" };
// Strict destination key: firstName,lastName,company,address1,address2,
// city,province,zip,country — \u001f-joined, engine-normalized.
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
  dest: ADDR_KEY,
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
  it("happy path emits exactly ONE deliveryDiscountsAdd/ALL/one candidate targeting the matching handle with the percentage string", () => {
    const out = runFn(makeInput());
    expect(out).toEqual({
      operations: [
        {
          deliveryDiscountsAdd: {
            selectionStrategy: "ALL",
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
    expect(runFn(withCustomer(makeInput(), eligMf([rec({ dest: K("jane", "doe", "acme", "123 main st", "apt 4", "new york", "ny", "90210", "us") })]))).operations).toEqual([]);
    expect(runFn(withCustomer(makeInput(), eligMf([rec({ dest: K("jane", "doe", "acme", "123 main st", "apt 4", "boston", "ny", "10001", "us") })]))).operations).toEqual([]);
    expect(runFn(withCustomer(makeInput(), eligMf([rec({ dest: K("jane", "doe", "acme", "123 main st", "apt 4", "new york", "ny", "10001", "ca") })]))).operations).toEqual([]);
  });

  it("destination normalization: case, whitespace, diacritics and zip punctuation all match", () => {
    const i = withAddr(makeInput(), { ...ADDR, countryCode: "br", provinceCode: null, zip: " 01310-100 ", city: "São  Paulo" });
    // Engine rule keeps letters (ã stays), strips punctuation, collapses
    // whitespace, lowercases — the same key the projection wrote.
    const strict = K("jane", "doe", "acme", "123 main st", "apt 4", "são paulo", "", "01310100", "br");
    const k = withOptions(withCustomer(i, eligMf([rec({ dest: strict, cur: "BRL" })])), [option({ cost: { amount: "8.00", currencyCode: "BRL" } })]);
    expect(runFn(k).operations.length).toBe(1);
  });

  for (const addr of [{ ...ADDR, zip: null }, { ...ADDR, city: null }, { ...ADDR, countryCode: null }, { ...ADDR, address1: null }]) {
    it(`partial address missing ${Object.keys(addr).filter((k) => (addr as any)[k] === null)} ⇒ no discount`, () => {
      expect(runFn(withAddr(makeInput(), addr))).toEqual({ operations: [] });
    });
  }

  it("missing province still keys (empty slot), but only for a matching record", () => {
    const i = withAddr(makeInput(), { ...ADDR, countryCode: "IE", provinceCode: null, zip: "D02 X285", city: "Dublin" });
    const j = withCustomer(i, eligMf([rec({ dest: K("jane", "doe", "acme", "123 main st", "apt 4", "dublin", "", "d02 x285", "ie") })]));
    expect(runFn(j).operations.length).toBe(1);
    const k = withCustomer(i, eligMf([rec({ dest: K("jane", "doe", "acme", "123 main st", "apt 4", "dublin", "xx", "d02 x285", "ie") })]));
    expect(runFn(k)).toEqual({ operations: [] });
  });

  it("strict key: different street / unit / recipient / company ⇒ no discount; equal-after-normalization ⇒ discount", () => {
    // different street, same zip
    expect(runFn(withCustomer(makeInput(), eligMf([rec({ dest: K("jane", "doe", "acme", "99 main st", "apt 4", "new york", "ny", "10001", "us") })]))).operations).toEqual([]);
    // same street, different address2
    expect(runFn(withCustomer(makeInput(), eligMf([rec({ dest: K("jane", "doe", "acme", "123 main st", "apt 9", "new york", "ny", "10001", "us") })]))).operations).toEqual([]);
    // different recipient name
    expect(runFn(withCustomer(makeInput(), eligMf([rec({ dest: K("john", "doe", "acme", "123 main st", "apt 4", "new york", "ny", "10001", "us") })]))).operations).toEqual([]);
    // different company
    expect(runFn(withCustomer(makeInput(), eligMf([rec({ dest: K("jane", "doe", "acme inc", "123 main st", "apt 4", "new york", "ny", "10001", "us") })]))).operations).toEqual([]);
    // punctuation/case/whitespace-equal street → same key → discount
    const i = withAddr(makeInput(), { ...ADDR, address1: "  123  Main   St. " });
    expect(runFn(withCustomer(i, eligMf([rec()]))).operations.length).toBe(1);
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
      "firstName", "lastName", "company", "address1", "address2",
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

// ── Output-shape regression (the live "FIRST" incident) ──────────────────

describe("Function output shape vs the published schema", () => {
  it("every positive result the Function emits validates against the trimmed schema", () => {
    const positives = [
      runFn(makeInput()),
      runFn(
        withOptions(
          withCustomer(
            makeInput(),
            eligMf([rec({ id: "222", exp: "2099-02-01" }), rec({ id: "111", exp: "2099-01-01" })]),
          ),
          [option({ handle: "h_a" }), option({ handle: "h_b" })],
        ),
      ),
    ];
    for (const out of positives) {
      expect(out.operations.length).toBe(1);
      expect(() => assertValidResult(out)).not.toThrow();
    }
  });

  it("the validator REJECTS selectionStrategy FIRST — the value Shopify silently discarded", () => {
    const bad = {
      operations: [
        {
          deliveryDiscountsAdd: {
            selectionStrategy: "FIRST",
            candidates: [
              {
                targets: [{ deliveryOption: { handle: "opt_std" } }],
                value: { percentage: { value: "100.0" } },
              },
            ],
          },
        },
      ],
    };
    expect(() => assertValidResult(bad)).toThrow();
  });

  it("the validator REJECTS extra/misspelled keys and missing required fields", () => {
    expect(() =>
      assertValidResult({
        operations: [{ deliveryDiscountsAddd: { candidates: [], selectionStrategy: "ALL" } }],
      }),
    ).toThrow();
    expect(() =>
      assertValidResult({
        operations: [
          { deliveryDiscountsAdd: { candidates: [], selectionStrategy: "ALL", bogus: 1 } },
        ],
      }),
    ).toThrow();
    expect(() =>
      assertValidResult({
        operations: [{ deliveryDiscountsAdd: { candidates: [] } }],
      }),
    ).toThrow();
    // Two members of a @oneOf input is also invalid.
    expect(() =>
      assertValidResult({
        operations: [
          {
            deliveryDiscountsAdd: { candidates: [], selectionStrategy: "ALL" },
            enteredDiscountCodesAccept: { codes: [] },
          },
        ],
      }),
    ).toThrow();
  });

  it("the Function source never emits or names the forbidden strategy", () => {
    expect(FN_SRC).not.toMatch(/["']FIRST["']/);
    expect(FN_SRC).toContain('"ALL"');
  });
});

describe("dest-key normalization (strict, engine-identical)", () => {
  it("folds case, whitespace, diacritics and punctuation into \u001f slots", () => {
    expect(destKey({ ...ADDR, countryCode: " BR ", provinceCode: "SP", zip: "01310-100", city: "São  Paulo" })).toBe(
      K("jane", "doe", "acme", "123 main st", "apt 4", "são paulo", "sp", "01310100", "br"),
    );
    expect(normAddressLine(" SW1A   1AA ")).toBe("sw1a 1aa");
    expect(normAddressLine("Rue de l'Église, #42-B")).toBe("rue de léglise 42b");
    expect(normMethod("  Express   Saver ")).toBe("express saver");
    expect(SEP).toBe("\u001f");
  });
  it("null when address1/country/zip/city are missing or normalize empty", () => {
    expect(destKey(null)).toBeNull();
    expect(destKey({ ...ADDR, countryCode: null })).toBeNull();
    expect(destKey({ ...ADDR, zip: null })).toBeNull();
    expect(destKey({ ...ADDR, zip: "   " })).toBeNull();
    expect(destKey({ ...ADDR, city: null })).toBeNull();
    expect(destKey({ ...ADDR, address1: null })).toBeNull();
    expect(destKey({ ...ADDR, address1: "  " })).toBeNull();
    // Optional slots may be absent.
    expect(destKey({ firstName: null, lastName: null, company: null, address1: "1 st", address2: null, city: "x", provinceCode: null, zip: "1", countryCode: "US" })).toBe(K("", "", "", "1 st", "", "x", "", "1", "us"));
  });
  it("the app-side copy is BYTE-IDENTICAL to the Function source", () => {
    const fn = readFileSync(join(EXT_SRC, "dest-key.ts"), "utf8");
    const app = readFileSync(join(__dirname, "..", "app", "lib", "checkout-discount", "dest-key.ts"), "utf8");
    expect(app).toBe(fn);
  });
  it("matches the merge engine's buildAddressKey over a parity table (read-only import)", () => {
    const table = [
      { firstName: "Jane", lastName: "Doe", company: "Acme, Inc.", address1: "123 Main St.", address2: "Apt 4", city: "New York", provinceCode: "NY", zip: "10001", countryCodeV2: "US" },
      { firstName: "  João ", lastName: "Da-Silva", company: null, address1: "Rua São Bento, 42", address2: null, city: "São Paulo", provinceCode: "SP", zip: "01310-100", countryCodeV2: "BR" },
      { firstName: "Max", lastName: "Müller", company: "", address1: "Hauptstr. 5", address2: "Hinterhaus", city: "Zürich", provinceCode: "ZH", zip: "8001", countryCodeV2: "CH" },
      { firstName: null, lastName: null, company: null, address1: "221B Baker Street", address2: null, city: "London", provinceCode: null, zip: "NW1 6XE", countryCodeV2: "GB" },
      { firstName: "Ali", lastName: "Al-Saud", company: "شركة", address1: "شارع الملك فهد ١٢", address2: "3", city: "الرياض", provinceCode: null, zip: "11564", countryCodeV2: "SA" },
      { firstName: "Mei", lastName: "Ling", company: "Acme!", address1: "東京都千代田区1-1", address2: null, city: "東京", provinceCode: null, zip: "100-0001", countryCodeV2: "JP" },
    ];
    for (const a of table) {
      const engine = buildAddressKey("gid://shopify/Customer/9", a);
      expect(engine).not.toBeNull();
      const engineNoCustomer = engine!.split("\0").slice(1).join(SEP);
      const ours = destKey({
        firstName: a.firstName, lastName: a.lastName, company: a.company,
        address1: a.address1, address2: a.address2, city: a.city,
        provinceCode: a.provinceCode, zip: a.zip, countryCode: a.countryCodeV2,
      });
      expect(ours).toBe(engineNoCustomer);
    }
    // Engine-null inputs (missing address1 or country) are also ours-null;
    // our key is additionally stricter (zip/city required) — never weaker.
    expect(buildAddressKey("gid://shopify/Customer/9", { address1: null, city: "x", countryCodeV2: "US" })).toBeNull();
    expect(destKey({ address1: null, city: "x", zip: "1", countryCode: "US" })).toBeNull();
    expect(destKey({ address1: "1 st", city: null, zip: "1", countryCode: "US" })).toBeNull(); // ours stricter
  });
});
