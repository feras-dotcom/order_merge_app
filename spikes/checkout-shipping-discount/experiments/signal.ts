// signal.ts — STRICT checkout signal parser for the $24.95 cart (native Standard $8.00, Express $15.00).
// "discounted" requires ALL of: the MergeShip-specific discount message is visible, Standard goes from $8.00 to $0,
// Express is still $15.00, and the order-summary shipping line also ends at $0. A generic FREE, a struck-through
// price, or any single text match is never enough.
import type { BrowserPage } from "./browser";

export type SignalKind = "discounted" | "baseline" | "native-free" | "other";
export interface CheckoutSignal {
  kind: SignalKind;
  message: boolean;
  stdTokens: string[];
  expressTokens: string[];
  summaryTokens: string[];
  lines: string[];
}

const PRICE = /^(\$[\d.,]+|FREE)$/i;
const MESSAGE = /mergeship spike: shipping discount/i;
const toNum = (s: string | undefined): number | null =>
  s === undefined ? null : /^free$/i.test(s) ? 0 : PRICE.test(s) ? Number(s.replace(/[$,]/g, "")) : null;
const prices = (kl: string[], from: number, to: number) => kl.slice(from, to).filter((l) => PRICE.test(l));

export function parseSignal(text: string): CheckoutSignal {
  const kl = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const message = kl.some((l) => MESSAGE.test(l));
  const choose = Math.max(kl.indexOf("Choose a shipping method"), 0);
  const stdIdx = kl.indexOf("Standard", choose);
  const expIdx = kl.indexOf("Express", choose);
  const stdTokens = stdIdx >= 0 ? prices(kl, stdIdx + 1, expIdx > stdIdx ? expIdx : stdIdx + 6) : [];
  const expEnd = expIdx >= 0 ? kl.findIndex((l, i) => i > expIdx && /^(Subtotal|Pay with|Total)/.test(l)) : -1;
  const expressTokens = expIdx >= 0 ? prices(kl, expIdx + 1, Math.min(expIdx + 5, expEnd > expIdx ? expEnd : expIdx + 5)) : [];
  const sub = kl.lastIndexOf("Subtotal");
  const shipSummary = sub >= 0 ? kl.indexOf("Shipping", sub) : -1;
  const totalIdx = shipSummary >= 0 ? kl.indexOf("Total", shipSummary) : -1;
  const summaryTokens = shipSummary >= 0 ? prices(kl, shipSummary + 1, totalIdx > shipSummary ? totalIdx : shipSummary + 4) : [];
  const lines = kl.filter((l) => /standard|express|free|shipping|subtotal|total|savings|mergeship|^\$\d/i.test(l)).filter((l) => !/security code/i.test(l)).slice(0, 40);

  const stdOrig = toNum(stdTokens[0]);
  const stdFinal = toNum(stdTokens[stdTokens.length - 1]);
  const express = toNum(expressTokens[expressTokens.length - 1]);
  const sumFinal = toNum(summaryTokens[summaryTokens.length - 1]);
  let kind: SignalKind = "other";
  if (message && stdTokens.length >= 2 && stdOrig === 8 && stdFinal === 0 && express === 15 && sumFinal === 0) kind = "discounted";
  else if (!message && stdTokens.length === 1 && stdOrig === 8 && express === 15 && sumFinal === 8) kind = "baseline";
  else if (!message && stdFinal === 0) kind = "native-free";
  return { kind, message, stdTokens, expressTokens, summaryTokens, lines };
}

export async function readSignal(page: BrowserPage): Promise<CheckoutSignal> {
  return parseSignal(await page.evaluate(() => document.body.innerText));
}
