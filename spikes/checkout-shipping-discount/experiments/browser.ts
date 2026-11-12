// Browser harness: headed persistent-profile Chrome via playwright-core
// installed in the isolated workspace (NOT the repo). Profile dir lives in
// the isolated workspace and is gitignored there; screenshots go to the
// isolated workspace too (may contain the founder's email — never commit).
import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { appDir } from "./lib";

const workspaceDir = join(appDir, "..", "..");
const req = createRequire(join(workspaceDir, "noop.cjs"));
const { chromium } = req("playwright-core") as {
  chromium: { launchPersistentContext(dir: string, opts: Record<string, unknown>): Promise<BrowserCtx> };
};

export const SHOP_ORIGIN = "https://ms-checkout-spike-1111.myshopify.com";
export const VARIANT_NUMERIC = "68100323574127"; // $9.95 shippable ski wax
export const PROFILE_DIR = join(workspaceDir, "browser-profile");
export const SHOTS_DIR = join(workspaceDir, "evidence-shots");

// The fixed test address automation types at checkout. The eligibility
// record's dest key is derived from exactly this data.
export const TEST_ADDRESS = {
  firstName: "Spike",
  lastName: "Test",
  company: "Spike Co",
  address1: "100 Test Street",
  address2: "Unit 5",
  city: "New York",
  province: "New York",
  provinceCode: "NY",
  zip: "10001",
  countryCode: "US",
};

export interface BrowserPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  fill(sel: string, v: string): Promise<void>;
  click(sel: string): Promise<void>;
  waitForSelector(sel: string, opts?: Record<string, unknown>): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<unknown>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  locator(sel: string): { count(): Promise<number>; allInnerTexts(): Promise<string[]> };
  newPage?(): Promise<BrowserPage>;
  close(): Promise<void>;
}
export interface BrowserCtx {
  newPage(): Promise<BrowserPage>;
  pages(): BrowserPage[];
  close(): Promise<void>;
}

export async function connect(): Promise<BrowserCtx> {
  // CDP attach to the founder's plain Chrome (stays open after disconnect).
  const b = await (chromium as unknown as { connectOverCDP(u: string): Promise<{ contexts(): BrowserCtx[]; close(): Promise<void> }> }).connectOverCDP("http://127.0.0.1:9222");
  const ctx0 = b.contexts()[0];
  return { newPage: () => ctx0.newPage(), pages: () => ctx0.pages(), close: () => b.close() };
}

export async function launch(opts: Record<string, unknown> = {}): Promise<BrowserCtx> {
  mkdirSync(PROFILE_DIR, { recursive: true });
  mkdirSync(SHOTS_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: false,
    ...opts,
  });
}

// Scrape the checkout page's shipping + totals + discount rows from DOM text.
export async function scrapeCheckout(page: BrowserPage): Promise<Record<string, unknown>> {
  const text = await page.evaluate(() => document.body.innerText);
  const shippingBlock = /shipping method[\s\S]{0,4000}?order summary/i.exec(text)?.[0] ?? "";
  const optionLines = [...shippingBlock.matchAll(/([^\n]{2,60}?)\s*·?\s*(?:\$|Free|free)\s*([\d.,]+)?/g)]
    .map((m) => m[0].trim())
    .slice(0, 20);
  const discounts = [...text.matchAll(/([^\n]{0,80}?discount[^\n]*)/gi)].map((m) => m[1].trim()).slice(0, 10);
  const total = /total[^\n]*\$?\s*([\d,]+\.\d{2})/i.exec(text)?.[1] ?? null;
  const shipping = /shipping[^\n]*?(?:\$?\s*([\d,]+\.\d{2})|FREE|free)/i.exec(text)?.[0] ?? null;
  return { optionLines, discounts, total, shipping, url: page.url() };
}

export async function buildCartAndCheckout(page: BrowserPage, qty = 1): Promise<void> {
  await page.goto(`${SHOP_ORIGIN}/cart/${VARIANT_NUMERIC}:${qty}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.goto(`${SHOP_ORIGIN}/checkout`, { waitUntil: "domcontentloaded" });
}

// Type the fixed address into checkout fields (checkout extensibility labels
// vary; try several common selectors).
export async function fillAddress(page: BrowserPage, addr: typeof TEST_ADDRESS): Promise<void> {
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
  await tryFill(["select[name=zone]", "select[autocomplete='address-level1']"], addr.province);
  await tryFill(["input[name=postalCode]", "input[autocomplete='postal-code']"], addr.zip);
  await page.waitForTimeout(2500); // let delivery options recompute + Function run
}
