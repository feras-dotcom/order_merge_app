// Strict destination key shared by the Function and the projection —
// positional slots identical (field set, order, per-field normalization) to
// the merge engine's buildAddressKey (app/lib/eligibility.ts), minus the
// customer-id slot (the customer metafield IS per-customer):
//   firstName|lastName|company|address1|address2|city|province|zip|country
// Per-field normalization = normalizeAddressLine: lowercase, strip every
// char that is not a Unicode letter/number/whitespace, collapse whitespace,
// trim (no separate zip punctuation rule — the engine applies one rule to
// every slot, so "SW1A 1AA" -> "sw1a 1aa", "01310-100" -> "01310100").
// Separator \u001f cannot survive normalization (it is stripped from data),
// so slots can never shift; it is ASCII-safe for a JSON metafield.
// Requires non-empty address1 AND country (engine rule) PLUS non-empty zip
// and city (spike rule, kept) — anything missing fails closed to null.
// QuickJS/Javy-verified offline: normalize-free, uses \p{L}/\p{N} property
// escapes which the built wasm executes correctly.

const NON_LETTER = /[^\p{L}\p{N}\s]/gu;

// Identical to the engine's normalizeAddressLine.
export const normAddressLine = (line: string | null | undefined): string =>
  line
    ?.toLowerCase()
    .replace(NON_LETTER, "")
    .replace(/\s+/g, " ")
    .trim() ?? "";

// Identical to the engine's normalizeShippingTitle: trim, collapse
// whitespace, lowercase (no punctuation stripping).
export const normMethod = (title: string | null | undefined): string =>
  title?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";

export const SEP = "\u001f";

export interface DestInput {
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly company?: string | null;
  readonly address1?: string | null;
  readonly address2?: string | null;
  readonly city?: string | null;
  readonly provinceCode?: string | null;
  readonly zip?: string | null;
  readonly countryCode?: string | null;
}

export function destKey(addr: DestInput | null | undefined): string | null {
  if (addr == null) return null;
  const f = [
    addr.firstName,
    addr.lastName,
    addr.company,
    addr.address1,
    addr.address2,
    addr.city,
    addr.provinceCode,
    addr.zip,
    addr.countryCode,
  ].map(normAddressLine);
  const address1 = f[3];
  const city = f[5];
  const zip = f[7];
  const country = f[8];
  if (!address1 || !city || !zip || !country) return null;
  return f.join(SEP);
}
