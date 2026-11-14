// e2-lib.ts — shared checkout observation helpers for the E2 direct and real-order experiments.
// Strict signal only (signal.ts). All timestamps ISO UTC.
import { SHOP_ORIGIN, type BrowserPage } from "./browser";
import { readSignal, type SignalKind, type CheckoutSignal } from "./signal";

export const VARIANT = process.env.VARIANT ?? "68100323508591";
export const CAP_MS = Number(process.env.CAP_S ?? 420) * 1000;
export const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
export const iso = () => new Date().toISOString();
export const ms = (a: string, b: string) => new Date(b).getTime() - new Date(a).getTime();

export type Pg = BrowserPage & { reload?(o?: Record<string, unknown>): Promise<unknown> };
export interface Obs { loop: "fresh" | "existing"; start: string; end: string; kind: SignalKind; lines?: string[] }
export type Ctx = { newPage(): Promise<BrowserPage> };

export async function settle(page: Pg, tries = 14): Promise<CheckoutSignal> {
  let s = await readSignal(page);
  for (let i = 0; i < tries && !(s.stdTokens.length > 0 && s.summaryTokens.length > 0); i++) {
    await page.waitForTimeout(1000);
    try { s = await readSignal(page); } catch { /* navigation in flight */ }
  }
  return s;
}

export async function freshObserve(ctx: Ctx): Promise<Obs> {
  const start = iso();
  const page = (await ctx.newPage()) as Pg;
  try {
    await page.goto(`${SHOP_ORIGIN}/cart/clear`, { waitUntil: "domcontentloaded" });
    await page.goto(`${SHOP_ORIGIN}/cart/${VARIANT}:1`, { waitUntil: "domcontentloaded" });
    await page.goto(`${SHOP_ORIGIN}/checkout`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const s = await settle(page);
    return { loop: "fresh", start, end: iso(), kind: s.kind, lines: s.lines };
  } finally { await page.close(); }
}

export async function openExisting(ctx: Ctx): Promise<{ page: Pg; obs: Obs }> {
  const start = iso();
  const page = (await ctx.newPage()) as Pg;
  await page.goto(`${SHOP_ORIGIN}/cart/clear`, { waitUntil: "domcontentloaded" });
  await page.goto(`${SHOP_ORIGIN}/cart/${VARIANT}:1`, { waitUntil: "domcontentloaded" });
  await page.goto(`${SHOP_ORIGIN}/checkout`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const s = await settle(page);
  return { page, obs: { loop: "existing", start, end: iso(), kind: s.kind, lines: s.lines } };
}

export async function reloadObserve(page: Pg): Promise<Obs> {
  const start = iso();
  try { await (page.reload ? page.reload({ waitUntil: "domcontentloaded" }) : page.goto(page.url(), { waitUntil: "domcontentloaded" })); } catch { /* */ }
  await page.waitForTimeout(1500);
  const s = await settle(page);
  return { loop: "existing", start, end: iso(), kind: s.kind, lines: s.lines };
}

// Poll both loops concurrently until each has observed `want` (or the cap). Returns all observations.
export async function pollUntil(want: SignalKind, ctx: Ctx, existing: Pg) {
  const obs: Obs[] = [];
  const t0 = Date.now();
  const done = { fresh: false, existing: false };
  const loop = async (kind: "fresh" | "existing") => {
    while (!done[kind] && Date.now() - t0 < CAP_MS) {
      const o = kind === "fresh" ? await freshObserve(ctx) : await reloadObserve(existing);
      obs.push(o);
      if (o.kind === want) done[kind] = true;
      else await sleep(kind === "fresh" ? 1500 : 3000);
    }
  };
  await Promise.all([loop("fresh"), loop("existing")]);
  return obs;
}

export function summarize(obs: Obs[], want: SignalKind, ref: string) {
  const out: Record<string, unknown> = {};
  for (const loopName of ["fresh", "existing"] as const) {
    const mine = obs.filter((o) => o.loop === loopName).sort((a, b) => a.start.localeCompare(b.start));
    const first = mine.find((o) => o.kind === want);
    const before = first ? mine.filter((o) => o.start < first.start && o.kind !== want) : mine.filter((o) => o.kind !== want);
    const lastNot = before.filter((o) => o.start >= ref).pop();
    out[loopName] = {
      observations: mine.length,
      kinds: mine.map((o) => o.kind),
      reached: !!first,
      // true visibility time lies in (lastNot.start, first.end]; the Function ran during a page load.
      lowerBoundMs: lastNot ? ms(ref, lastNot.start) : null,
      firstSeenLoadStartMs: first ? ms(ref, first.start) : null,
      upperBoundMs: first ? ms(ref, first.end) : null,
      evidenceLines: (first ?? mine[mine.length - 1])?.lines?.map((l) => l.replace(/\S+@\S+/g, "[EMAIL]")),
    };
  }
  return out;
}

