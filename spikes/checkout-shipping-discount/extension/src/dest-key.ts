// Destination-key normalization shared by the Function and the projection.
// Dependency-free ES2020: runs under the QuickJS/Javy Functions runtime and
// in Node. Uses String.prototype.normalize("NFKD") plus an explicit
// combining-mark range (no Unicode property escapes) so diacritics fold
// ("São Paulo" == "sao paulo"); missing country/zip/city makes the key null
// — never a wildcard.

const COMBINING_MARKS = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/g;

export const normText = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

export const normZip = (s: string): string => normText(s).replace(/[^a-z0-9]/g, "");

export const normMethod = normText;

export interface DestInput {
  readonly countryCode?: string | null;
  readonly provinceCode?: string | null;
  readonly zip?: string | null;
  readonly city?: string | null;
}

export function destKey(addr: DestInput | null | undefined): string | null {
  if (addr == null) return null;
  const country = addr.countryCode == null ? "" : normText(String(addr.countryCode));
  const zip = addr.zip == null ? "" : normZip(String(addr.zip));
  const city = addr.city == null ? "" : normText(String(addr.city));
  if (country === "" || zip === "" || city === "") return null;
  const province = addr.provinceCode == null ? "" : normText(String(addr.provinceCode));
  return `${country}|${province}|${zip}|${city}`;
}
