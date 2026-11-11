// Post-hoc detection that an already-placed order received a checkout
// shipping discount — pure, from Admin order facts only. A future refund
// fallback consults this; it is deliberately NOT wired into the engine.
export interface GrantOrderFacts {
  shippingLines: {
    title?: string;
    originalMinor: bigint | number | string;
    discountedMinor: bigint | number | string;
    discountAllocations?: { amountMinor: bigint | number | string; applicationTitle?: string | null }[];
  }[];
  discountApplications?: { targetType?: string | null; title?: string | null }[];
}

const minorOf = (v: bigint | number | string): bigint =>
  typeof v === "bigint" ? v : BigInt(String(v));

export function detectShippingDiscountGrant(
  order: GrantOrderFacts,
  cfg: { titleToken?: string | null } = {},
): {
  granted: boolean;
  grantedMinor: string;
  evidence: "ALLOCATION" | "PRICE_DELTA" | "NONE";
  ambiguous: boolean;
} {
  const lines = Array.isArray(order.shippingLines) ? order.shippingLines : [];
  let delta = 0n;
  for (const l of lines) {
    delta += minorOf(l.originalMinor) - minorOf(l.discountedMinor);
  }
  const granted = delta > 0n;
  const shippingApps = (order.discountApplications ?? []).filter(
    (a) => a?.targetType === "SHIPPING_LINE",
  );
  const token = cfg.titleToken ?? null;
  const matching = shippingApps.filter(
    (a) => token !== null && a.title === token,
  );
  if (matching.length === 1 && shippingApps.length === 1) {
    const allocated = lines
      .flatMap((l) => l.discountAllocations ?? [])
      .filter((a) => a.applicationTitle === token)
      .reduce((s, a) => s + minorOf(a.amountMinor), 0n);
    return {
      granted: true,
      grantedMinor: (allocated > 0n ? allocated : delta).toString(),
      evidence: "ALLOCATION",
      ambiguous: false,
    };
  }
  if (!granted) {
    return { granted: false, grantedMinor: "0", evidence: "NONE", ambiguous: false };
  }
  // A shipping price delta we cannot attribute: title mismatch, more than
  // one shipping-targeted application, or no application info at all.
  // Fail-safe: callers suppress rather than risk paying twice.
  return {
    granted: true,
    grantedMinor: delta.toString(),
    evidence: "PRICE_DELTA",
    ambiguous: true,
  };
}
