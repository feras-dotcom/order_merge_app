const currencyPrecisions = new Map<string, number>(
  ([
    [0, "BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF"],
    [2, "AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CNY COP COU CRC CUP CVE CZK DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD HNL HTG HUF IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT LAK LBP LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN QAR RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TOP TRY TTD TWD TZS UAH USD USN UYU UZS VED VES WST XAD XCD XCG YER ZAR ZMW ZWG"],
    [3, "BHD IQD JOD KWD LYD OMR TND"],
    [4, "CLF UYW"],
  ] as const).flatMap(([precision, codes]) => codes.split(" ").map((code) => [code, precision] as const)),
);

export function getCurrencyPrecision(currencyCode: unknown): number | null {
  return typeof currencyCode === "string" ? currencyPrecisions.get(currencyCode) ?? null : null;
}

export function parseShopMoney(value: unknown): { currencyCode: string; minorUnits: bigint } | null {
  if (!value || typeof value !== "object") return null;
  const { amount, currencyCode } = value as { amount?: unknown; currencyCode?: unknown };
  if (typeof currencyCode !== "string" || typeof amount !== "string" || amount.length > 128) return null;
  const precision = getCurrencyPrecision(currencyCode);
  if (precision === null || !/^\d+(?:\.\d+)?$/.test(amount)) return null;
  const [whole, fraction = ""] = amount.split(".");
  if (/[1-9]/.test(fraction.slice(precision))) return null;
  return {
    currencyCode,
    minorUnits: BigInt(whole) * 10n ** BigInt(precision) + BigInt(fraction.slice(0, precision).padEnd(precision, "0") || "0"),
  };
}

export function isFullyDiscounted(line: any, currencyCode: unknown): boolean {
  if (!Number.isSafeInteger(line?.quantity) || line.quantity <= 0 || line.quantity > 2147483647 || !Array.isArray(line.discountAllocations)) return false;
  const unit = parseShopMoney(line.originalUnitPriceSet?.shopMoney);
  if (!unit || unit.currencyCode !== currencyCode) return false;
  let allocated = 0n;
  for (const allocation of line.discountAllocations) {
    const application = allocation?.discountApplication;
    const money = parseShopMoney(allocation?.allocatedAmountSet?.shopMoney);
    if (!money || money.currencyCode !== unit.currencyCode || typeof application?.__typename !== "string" ||
      !application.__typename || application.__typename === "ManualDiscountApplication" && typeof application.description !== "string") return false;
    allocated += money.minorUnits;
  }
  return allocated === unit.minorUnits * BigInt(line.quantity);
}
