// Browser harness — ported from the spike's experiments/browser.ts, made
// injectable: playwright-core is resolved from a caller-supplied workspace
// dir (never a repo dependency), the persistent profile lives there too,
// and the shop origin / cart variant are parameters. Screenshots go to
// --out only, never the repo. The browser itself is injected into the
// driver so unit tests never launch one.
import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// $24.95 variant on the spike store — NEVER the $629.95 variant that
// qualifies for native free shipping.
export const DEFAULT_VARIANT_NUMERIC = "68100323508591";

export const TEST_ADDRESS = {
  firstName: "Spike",
  lastName: "Test",
  company: "",
  address1: "100 Test Street",
  address2: "Unit 5",
  city: "New York",
  province: "New York",
  provinceCode: "NY",
  zip: "10001",
  countryCode: "US",
};
export type TestAddress = typeof TEST_ADDRESS;

export interface BrowserPage {
  selectOption(sel: string, v: { label: string }): Promise<unknown>;
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  fill(sel: string, v: string): Promise<void>;
  click(sel: string): Promise<void>;
  waitForSelector(sel: string, opts?: Record<string, unknown>): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<unknown>;
  evaluate<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T>;
  locator(sel: string): { count(): Promise<number>; allInnerTexts(): Promise<string[]> };
  close(): Promise<void>;
}
export interface BrowserCtx {
  newPage(): Promise<BrowserPage>;
  pages(): BrowserPage[];
  close(): Promise<void>;
}
export interface BrowserFactory {
  connect(): Promise<BrowserCtx>;
  launch(opts?: Record<string, unknown>): Promise<BrowserCtx>;
}

export function makeBrowserFactory(workspaceDir: string): BrowserFactory {
  const req = createRequire(join(workspaceDir, "noop.cjs"));
  const { chromium } = req("playwright-core") as {
    chromium: {
      launchPersistentContext(dir: string, opts: Record<string, unknown>): Promise<BrowserCtx>;
      connectOverCDP(u: string): Promise<{ contexts(): BrowserCtx[]; close(): Promise<void> }>;
    };
  };
  const profileDir = join(workspaceDir, "browser-profile");
  return {
    // CDP attach to the operator's plain Chrome (stays open on disconnect).
    async connect() {
      const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
      const ctx0 = b.contexts()[0];
      return { newPage: () => ctx0.newPage(), pages: () => ctx0.pages(), close: () => b.close() };
    },
    async launch(opts = {}) {
      mkdirSync(profileDir, { recursive: true });
      return chromium.launchPersistentContext(profileDir, {
        channel: "chrome",
        headless: false,
        viewport: { width: 1280, height: 900 },
        ignoreHTTPSErrors: false,
        ...opts,
      });
    },
  };
}

// Scrape the checkout page's shipping options + discount rows from DOM text.
export interface ScrapedCheckout {
  optionLines: string[];
  discounts: string[];
  total: string | null;
  shipping: string | null;
  url: string;
  bodyText: string;
  shippingBlock: string;
}

export async function scrapeCheckout(page: BrowserPage): Promise<ScrapedCheckout> {
  const text = await page.evaluate(() => (document as unknown as { body: { innerText: string } }).body.innerText);
  const shippingBlock = /shipping method[\s\S]{0,4000}?order summary/i.exec(text)?.[0] ?? text.slice(0, 4000);
  // One-page checkout puts title, delivery estimate and price on separate
  // lines ("Standard\nFri, Nov 20–Tue, Nov 24\n$8.00"). Keep raw non-empty
  // lines; extractOptions pairs each price with its title.
  const optionLines = shippingBlock
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 40);
  const discounts = [...text.matchAll(/([^\n]{0,80}?discount[^\n]*|[^\n]{0,80}?MergeShip[^\n]*)/gi)]
    .map((m) => m[1].trim())
    .slice(0, 10);
  const total = /total[^\n]*\$?\s*([\d,]+\.\d{2})/i.exec(text)?.[1] ?? null;
  const shipping = /shipping[^\n]*?(?:\$?\s*([\d,]+\.\d{2})|FREE|free)/i.exec(text)?.[0] ?? null;
  return { optionLines, discounts, total, shipping, url: page.url(), bodyText: text.slice(0, 4000), shippingBlock };
}

export async function buildCartAndCheckout(
  page: BrowserPage,
  shopOrigin: string,
  variantNumeric: string,
  qty = 1,
): Promise<void> {
  await page.goto(`${shopOrigin}/cart/${variantNumeric}:${qty}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.goto(`${shopOrigin}/checkout`, { waitUntil: "domcontentloaded" });
}

export async function fillAddress(page: BrowserPage, addr: TestAddress): Promise<void> {
  const tryFill = async (sels: string[], v: string) => {
    for (const s of sels) {
      const loc = page.locator(s);
      if ((await loc.count()) > 0) {
        try {
          await page.fill(s, v);
          return;
        } catch { /* next */ }
      }
    }
  };
  await tryFill(["input[name=firstName]", "#TextField0"], addr.firstName);
  await tryFill(["input[name=lastName]", "#TextField1"], addr.lastName);
  await tryFill(["input[name=company]"], addr.company);
  await tryFill(["input[name=address1]", "input[autocomplete='address-line1']"], addr.address1);
  await tryFill(["input[name=address2]", "input[autocomplete='address-line2']"], addr.address2);
  await tryFill(["input[name=city]", "input[autocomplete='address-level2']"], addr.city);
  try {
    await page.selectOption("select[name=zone]", { label: addr.province });
  } catch {
    try {
      await page.selectOption("select[autocomplete='address-level1']", { label: addr.province });
    } catch { /* noop */ }
  }
  await tryFill(["input[name=postalCode]", "input[autocomplete='postal-code']"], addr.zip);
  await page.waitForTimeout(2500); // delivery options recompute + Function runs
}
