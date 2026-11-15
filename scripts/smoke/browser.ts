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

export interface BrowserLocator {
  count(): Promise<number>;
  allInnerTexts(): Promise<string[]>;
  nth(i: number): BrowserLocator;
  click(): Promise<void>;
  isDisabled(): Promise<boolean>;
  isVisible(): Promise<boolean>;
  isChecked(): Promise<boolean>;
  check(opts?: { force?: boolean }): Promise<void>;
}

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
  locator(sel: string): BrowserLocator;
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

const SHIPPING_RADIOS = "input[type=radio][name=shipping_methods]";
// Saved-address checkout collapses the two sections into rows; the toggles
// are the unlabeled aria-expanded buttons (nth(0) Ship-to, nth(1) Shipping).
const SHIPPING_TOGGLE = 'button[aria-expanded="false"]:not([aria-label])';

/** With a saved address the one-page checkout renders collapsed rows
 *  ("Ship to" + "Shipping <selected> · $x.xx"); the option radios exist in
 *  the DOM but stay disabled until the Shipping row is expanded — and the
 *  option text can already be present in innerText while collapsed, so the
 *  radio inputs themselves are the only reliable state. Clicks the toggle
 *  exactly once (a second click re-collapses it) and waits for the radios
 *  to become enabled. No-op when the panel is already usable or absent. */
export async function ensureShippingOptionsExpanded(page: BrowserPage, waitMs = 8000): Promise<void> {
  const usable = async (): Promise<boolean> => {
    const loc = page.locator(SHIPPING_RADIOS);
    if ((await loc.count()) === 0) return false;
    const first = loc.nth(0);
    const disabled = await first.isDisabled().catch(() => true);
    const visible = await first.isVisible().catch(() => false);
    return !disabled && visible;
  };
  if (await usable()) return;
  try {
    await page.locator(SHIPPING_TOGGLE).nth(1).click();
  } catch {
    return; // no collapsed shipping row on this page
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await usable()) return;
    await page.waitForTimeout(500);
  }
}

/** Checks the radio of the shipping option whose label matches
 *  `methodTitle` (aria-hidden input -> check({force:true})). The discount
 *  row only renders for the SELECTED option, so every scenario selects the
 *  method before scraping. Retries up to 6x (~3 s apart) and verifies via
 *  the summary "Shipping …" line (selected option title, or the discounted
 *  "Original/Discounted price" shape). Returns whether selection held. */
export async function selectShippingOption(
  page: BrowserPage,
  methodTitle: string,
): Promise<boolean> {
  const findIndex = () =>
    page.evaluate((want: string) => {
      const norm = (s: string) =>
        s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
      const w = norm(want);
      const radios = [
        ...document.querySelectorAll('input[type="radio"][name="shipping_methods"]'),
      ] as HTMLElement[];
      for (let i = 0; i < radios.length; i++) {
        const r = radios[i] as HTMLInputElement;
        const lab =
          (r.id ? document.querySelector(`label[for="${r.id}"]`) : null) ??
          r.closest("label") ??
          r.parentElement;
        const t = norm((lab as HTMLElement | null)?.textContent ?? "");
        if (t && (t.includes(w) || w.includes(t.split(" ").slice(0, 2).join(" ")))) return i;
      }
      return -1;
    }, methodTitle);

  const verified = () =>
    page.evaluate((want: string) => {
      const norm = (s: string) =>
        s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
      const w = norm(want);
      return document.body.innerText.split("\n").some((l) => {
        const n = norm(l);
        // Summary row: "Shipping Standard · $8.00" or, discounted and
        // selected, "Shipping Original price $8.00 Discounted price FREE".
        return /^shipping\b/i.test(l.trim()) && (n.includes(w) || n.includes("discounted price"));
      });
    }, methodTitle);

  for (let attempt = 0; attempt < 6; attempt++) {
    const idx = await findIndex();
    if (idx >= 0) {
      try {
        await page.locator(SHIPPING_RADIOS).nth(idx).check({ force: true });
      } catch {
        // retry loop will re-check
      }
    }
    await page.waitForTimeout(3000);
    if (idx >= 0) {
      const checked = await page
        .locator(SHIPPING_RADIOS)
        .nth(idx)
        .isChecked()
        .catch(() => false);
      if (checked || (await verified())) return true;
    } else if (await verified()) {
      return true;
    }
  }
  return false;
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
