import { describe, expect, it } from "vitest";
import { isFullyDiscounted, parseShopMoney } from "../app/lib/money";

const line = (currencyCode: string, unit: unknown, allocated: unknown, quantity = 1) => ({
  quantity,
  originalUnitPriceSet: { shopMoney: { amount: unit, currencyCode } },
  discountAllocations: [{
    allocatedAmountSet: { shopMoney: { amount: allocated, currencyCode } },
    discountApplication: { __typename: "ManualDiscountApplication", description: "MS-TESTTEST-1" },
  }],
});

describe("strict currency-aware minor units", () => {
  it.each([
    ["USD", "0.1000", 10n],
    ["EUR", "10.25", 1025n],
    ["JOD", "10.000", 10000n],
    ["KWD", "9.996", 9996n],
    ["JPY", "10.00", 10n],
    ["CLF", "1.2345", 12345n],
    ["USD", "9007199254740993.00", 900719925474099300n],
  ] as const)("parses %s %s without Number conversion", (currencyCode, amount, minorUnits) => {
    expect(parseShopMoney({ amount, currencyCode })).toEqual({ currencyCode, minorUnits });
  });

  it.each(["XXX", "XTS", "XAU", "USDC", "ZZZ", "usd", "toString", undefined])("unknown precision %s fails closed", (currencyCode) => {
    expect(parseShopMoney({ amount: "10.00", currencyCode })).toBeNull();
  });

  it.each([NaN, Infinity, -Infinity, 10, null, undefined, "NaN", "Infinity", "-Infinity", "0x10", "1e1", " 10", "+10", "-10", "10.", ".10", "1_000", "10,00", "", "1".repeat(129)])(
    "rejects malformed or non-string decimal %s", (amount) => expect(parseShopMoney({ amount, currencyCode: "USD" })).toBeNull(),
  );

  it("rejects sub-minor-unit precision rather than rounding", () => {
    expect(parseShopMoney({ amount: "0.001", currencyCode: "USD" })).toBeNull();
    expect(parseShopMoney({ amount: "0.0001", currencyCode: "JOD" })).toBeNull();
    expect(parseShopMoney({ amount: "1.1", currencyCode: "JPY" })).toBeNull();
  });

  it("missing prices/allocations cannot masquerade as a fully discounted zero-price line", () => {
    expect(isFullyDiscounted(line("USD", undefined, undefined), "USD")).toBe(false);
    expect(isFullyDiscounted(line("USD", "0.00", undefined), "USD")).toBe(false);
  });

  it.each(["Infinity", "-Infinity", "NaN", Infinity, NaN])("non-finite minus non-finite (%s) never proves equality", (amount) => {
    expect(isFullyDiscounted(line("USD", amount, amount), "USD")).toBe(false);
  });

  it("distinguishes the three-decimal near-miss previously accepted by 0.005", () => {
    expect(isFullyDiscounted(line("JOD", "10.000", "10.000"), "JOD")).toBe(true);
    expect(isFullyDiscounted(line("JOD", "10.000", "9.996"), "JOD")).toBe(false);
  });

  it("rejects currency mismatch even when both bags match one another", () => {
    expect(isFullyDiscounted(line("EUR", "10.00", "10.00"), "USD")).toBe(false);
  });

  it.each([NaN, Infinity, 0, -1, 1.5, 2147483648, Number.MAX_SAFE_INTEGER + 1])("invalid GraphQL quantity %s fails closed", (quantity) => {
    expect(isFullyDiscounted(line("USD", "0.00", "0.00", quantity), "USD")).toBe(false);
  });
});
