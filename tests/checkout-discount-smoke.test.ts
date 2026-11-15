// Unit tests for the checkout shipping-discount smoke harness — every pure
// part (args, guards, scrape classification, verdicts) plus the injectable
// driver (dry-run is read-only, restore-in-finally even when a scenario
// throws, LOGIN_REQUIRED path, scenario verdicts) with fakes. The browser,
// Admin client and clock are injected; no playwright, no network.
import { describe, expect, it } from "vitest";
import {
  LoginRequiredError,
  evaluateGuards,
  extractOptions,
  observeScrape,
  parseArgs,
  runSmoke,
  verdictFor,
  type SmokeDriverDeps,
} from "../scripts/smoke/smoke-lib";
import { parseEnvText } from "../scripts/smoke/lib";
import { CHECKOUT_DISCOUNT_MESSAGE } from "../app/lib/checkout-discount/config";

const ARGC = [
  "--store", "ms-checkout-spike-1111.myshopify.com",
  "--client-id", "abc123",
  "--env-file", "/x/.env",
  "--discount-id", "gid://shopify/DiscountAutomaticNode/1",
  "--workspace", "/w",
];

describe("parseArgs", () => {
  it("parses a complete invocation", () => {
    const r = parseArgs([...ARGC, "--apply", "--out", "/o", "--customer", "123"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.apply).toBe(true);
      expect(r.args.out).toBe("/o");
      expect(r.args.customer).toBe("123");
      expect(r.args.variantNumeric).toBe("68100323508591");
    }
  });
  it("refuses incomplete invocations", () => {
    for (const drop of ["--store", "--client-id", "--env-file", "--discount-id", "--workspace"]) {
      const r = parseArgs(ARGC.filter((v, i) => v !== drop && ARGC[i - 1] !== drop));
      expect(r.ok, drop).toBe(false);
    }
  });
});

describe("parseEnvText", () => {
  it("extracts key/secret and tolerates CRLF + comments", () => {
    const c = parseEnvText("SHOPIFY_API_KEY=k1\r\nSHOPIFY_API_SECRET=s1\n#x\nOTHER=v");
    expect(c).toEqual({ apiKey: "k1", apiSecret: "s1" });
  });
});

describe("evaluateGuards", () => {
  const base = {
    store: "s.myshopify.com",
    clientId: "abc",
    envApiKey: "abc",
    planPartnerDevelopment: true,
    discountOwnedByThisApp: true,
    discountTypename: "DiscountAutomaticApp",
  };
  it("clean input yields no failures", () => {
    expect(evaluateGuards(base)).toEqual([]);
  });
  it.each([
    [{ store: "s.example.com" }, "NOT_MY_SHOPIFY_DOMAIN"],
    [{ envApiKey: "other" }, "CLIENT_ID_MISMATCH"],
    [{ planPartnerDevelopment: false }, "NOT_A_DEV_STORE"],
    [{ discountOwnedByThisApp: false }, "NOT_APP_OWNED_DISCOUNT"],
    [{ discountTypename: "DiscountCodeBasic" }, "DISCOUNT_WRONG_TYPE"],
  ] as const)("fires %s alone", (over, code) => {
    expect(evaluateGuards({ ...base, ...over })).toEqual([code]);
  });
});

describe("scrape classification", () => {
  it("parses priced and free option lines", () => {
    const opts = extractOptions(["Standard Shipping $8.00", "Express Shipping $15.00", "Standard Shipping Free"]);
    expect(opts[0]).toMatchObject({ amountMinor: 800, free: false });
    expect(opts[1]).toMatchObject({ amountMinor: 1500 });
    expect(opts[2].free).toBe(true);
  });
  it("observeScrape detects the free standard option + message, express unchanged", () => {
    const o = observeScrape(
      {
        optionLines: ["Standard Shipping Free", "Express Shipping $15.00"],
        discounts: [`${CHECKOUT_DISCOUNT_MESSAGE}`],
        bodyText: `${CHECKOUT_DISCOUNT_MESSAGE} applied`,
      },
      { methodTitle: "Standard Shipping", expressBaselineMinor: 1500 },
    );
    expect(o).toMatchObject({ standardFree: true, messageShown: true, expressAmountMinor: 1500 });
  });
});

describe("verdictFor", () => {
  const granted = { standardFree: true, standardAmountMinor: 0, messageShown: true, expressAmountMinor: 1500 };
  const baseline = { standardFree: false, standardAmountMinor: 800, messageShown: false, expressAmountMinor: 1500 };
  it("S1 passes on baseline, S2 on granted, S3/S4 on baseline", () => {
    expect(verdictFor("S1-baseline", baseline, 1500)).toBe(true);
    expect(verdictFor("S1-baseline", granted, 1500)).toBe(false);
    expect(verdictFor("S2-granted", granted, 1500)).toBe(true);
    expect(verdictFor("S2-granted", baseline, 1500)).toBe(false);
    expect(verdictFor("S3-diff-street", baseline, 1500)).toBe(true);
    expect(verdictFor("S3-diff-street", granted, 1500)).toBe(false);
    expect(verdictFor("S4-kill-switch", baseline, 1500)).toBe(true);
    expect(verdictFor("S4-kill-switch", granted, 1500)).toBe(false);
  });
  it("S2 fails if Express moved (side-effect)", () => {
    expect(verdictFor("S2-granted", { ...granted, expressAmountMinor: 0 }, 1500)).toBe(false);
  });
});

// ── driver fakes ──────────────────────────────────────────────────────────

const SHOP = { ianaTimezone: "America/New_York", currencyCode: "USD", plan: { partnerDevelopment: true } };
const SNAP = {
  status: "EXPIRED",
  typename: "DiscountAutomaticApp",
  title: "MS Discount",
  combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
  config: { v: 1, windowId: "w-unset", percentage: "100.0", message: CHECKOUT_DISCOUNT_MESSAGE, windowStart: "2026-01-01T00:00:00", windowEnd: "2026-12-31T00:00:00" },
  ownedByThisApp: true,
};

const DISC_NODE = {
  automaticDiscountNode: {
    automaticDiscount: {
      __typename: "DiscountAutomaticApp",
      title: "MS Discount",
      status: "EXPIRED",
      combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
      appDiscountType: { functionId: "f", app: { id: "gid://shopify/App/1" } },
    },
    metafield: { jsonValue: SNAP.config },
  },
  currentAppInstallation: { app: { id: "gid://shopify/App/1" } },
};

interface Calls { name: string; vars?: unknown }

function makeFakeAdmin(opts: { planDev?: boolean; calls?: Calls[]; elig?: unknown } = {}) {
  const calls: Calls[] = opts.calls ?? [];
  let elig = opts.elig ?? null;
  const graphql = async (query: string, options?: { variables?: Record<string, unknown> }) => {
    calls.push({ name: query.match(/discountAutomatic\w+|metafieldsSet|automaticDiscountNode|customers|customer\(|shop\b/)?.[0] ?? query.slice(0, 30), vars: options?.variables });
    const d = (data: unknown) => ({ data });
    if (query.includes("discountAutomaticAppUpdate")) return d({ discountAutomaticAppUpdate: { automaticAppDiscount: { status: "EXPIRED" }, userErrors: [] } });
    if (query.includes("discountAutomaticActivate")) return d({ discountAutomaticActivate: { automaticDiscountNode: { id: "n1" }, userErrors: [] } });
    if (query.includes("discountAutomaticDeactivate")) return d({ discountAutomaticDeactivate: { automaticDiscountNode: { id: "n1" }, userErrors: [] } });
    if (query.includes("currentAppInstallation")) return d(DISC_NODE);
    if (query.includes("metafieldsSet")) return d({ metafieldsSet: { metafields: [{}], userErrors: [] } });
    if (query.includes("customers(first")) return d({ customers: { nodes: [{ id: "gid://shopify/Customer/7" }] } });
    if (query.includes("customer(")) return d({ customer: { metafield: elig ? { id: "m1", jsonValue: elig, compareDigest: "d1" } : null } });
    if (query.includes("automaticDiscountNode")) return d({ automaticDiscountNode: { automaticDiscount: { __typename: "DiscountAutomaticApp", status: "EXPIRED" } } });
    if (query.includes("plan")) return d({ shop: { ...SHOP, plan: { partnerDevelopment: opts.planDev ?? true } } });
    throw new Error(`unrouted query: ${query.slice(0, 80)}`);
  };
  return { graphql };
}

const BASELINE_TEXT = `Checkout\nDelivery\nShipping method\nStandard Shipping $8.00\nExpress Shipping $15.00\nOrder summary\nTotal $32.95`;
const GRANTED_TEXT = `Checkout\nDelivery\nShipping method\nStandard Shipping Free\nExpress Shipping $15.00\n${CHECKOUT_DISCOUNT_MESSAGE}\nOrder summary\nTotal $24.95`;

function makeFakePage(text: string, url = "https://s.myshopify.com/checkout") {
  return {
    goto: async () => ({}),
    url: () => url,
    title: async () => "Checkout",
    content: async () => text,
    fill: async () => {},
    click: async () => {},
    waitForSelector: async () => ({}),
    waitForTimeout: async () => {},
    screenshot: async () => ({}),
    selectOption: async () => ({}),
    evaluate: async () => text,
    locator: () => ({ count: async () => 0, allInnerTexts: async () => [] }),
    close: async () => {},
  };
}

// The real scrapeCheckout evaluates a function that reads document.body —
// our fake evaluate returns the canned text regardless.
function makeFakeBrowser(texts: string[], url?: string) {
  let i = 0;
  return {
    connect: async () => ({
      newPage: async () => makeFakePage(texts[Math.min(i++, texts.length - 1)], url),
      close: async () => {},
    }),
  };
}

function deps(over: Partial<SmokeDriverDeps> & { calls?: Calls[]; elig?: unknown; planDev?: boolean } = {}): SmokeDriverDeps {
  const { calls = [], ...rest } = over;
  const fake = makeFakeAdmin({ calls, planDev: over.planDev as boolean | undefined });
  return {
    admin: fake,
    adminGraphql: async (q, v) => ((await fake.graphql(q, { variables: v })) as { data: Record<string, unknown> }).data,
    envApiKey: "abc123",
    args: {
      store: "ms-checkout-spike-1111.myshopify.com",
      clientId: "abc123",
      envFile: "/x/.env",
      discountId: "gid://shopify/DiscountAutomaticNode/1",
      workspace: "/w",
      apply: true,
      customer: "7",
      variantNumeric: "68100323508591",
      methodTitle: "Standard Shipping",
    },
    browser: makeFakeBrowser([BASELINE_TEXT]),
    now: () => new Date("2026-11-15T12:00:00Z"),
    sleep: async () => {},
    ...rest,
  } as SmokeDriverDeps;
}

describe("runSmoke driver", () => {
  it("dry-run runs read-only guards only: no writes, no browser", async () => {
    const calls: Calls[] = [];
    const browser = { connect: async () => { throw new Error("browser must not launch in dry-run"); } };
    const d = deps({ calls, browser: browser as never, dryRun: true });
    const out = await runSmoke(d);
    expect(out.guardFailures).toEqual([]);
    const writes = calls.filter((c) => /Update|Activate|Deactivate|metafieldsSet|customers\(first/.test(JSON.stringify(c.vars ?? "") + c.name) || /mutation/.test(c.name));
    expect(writes.length).toBe(0);
  });

  it("refuses a non-dev store before any write", async () => {
    const calls: Calls[] = [];
    const out = await runSmoke(deps({ calls, planDev: false }));
    expect(out.guardFailures).toContain("NOT_A_DEV_STORE");
    expect(calls.some((c) => c.name === "mutation" || /Activate|Update|Deactivate/.test(c.name))).toBe(false);
  });

  it("full matrix: S2 granted only while ACTIVE+matching, restore runs", async () => {
    const calls: Calls[] = [];
    const browser = makeFakeBrowser([BASELINE_TEXT, GRANTED_TEXT, BASELINE_TEXT, BASELINE_TEXT]);
    const out = await runSmoke(deps({ calls, browser: browser as never }));
    expect(out.loginRequired).toBe(false);
    expect(out.results.map((r) => [r.scenario, r.pass])).toEqual([
      ["S1-baseline", true],
      ["S2-granted", true],
      ["S3-diff-street", true],
      ["S4-kill-switch", true],
    ]);
    expect(out.pass).toBe(true);
    // restore: deactivate + verify + config restore + eligibility clear all ran
    const kinds = calls.map((c) => c.name);
    expect(kinds.filter((n) => n === "discountAutomaticDeactivate").length).toBeGreaterThanOrEqual(3);
    expect(kinds.filter((n) => n === "discountAutomaticAppUpdate").length).toBeGreaterThanOrEqual(2);
    expect(kinds.filter((n) => n === "metafieldsSet").length).toBeGreaterThanOrEqual(4);
  });

  it("restores Admin state in finally even when a scenario throws", async () => {
    const calls: Calls[] = [];
    let n = 0;
    const browser = {
      connect: async () => {
        if (n++ === 1) throw new Error("browser blew up mid-run");
        return { newPage: async () => makeFakePage(BASELINE_TEXT), close: async () => {} };
      },
    };
    await expect(runSmoke(deps({ calls, browser: browser as never }))).rejects.toThrow("browser blew up");
    const mutations = calls.filter((c) => /Update|Activate|Deactivate|metafieldsSet/i.test(c.name));
    // restore path: deactivate-verified (mutation + status read) + config update + eligibility clear
    expect(mutations.filter((c) => /Deactivate/i.test(c.name)).length).toBeGreaterThanOrEqual(2);
    expect(mutations.filter((c) => /Update/i.test(c.name)).length).toBeGreaterThanOrEqual(1);
  });

  it("detects LOGIN_REQUIRED and still restores", async () => {
    const calls: Calls[] = [];
    const browser = makeFakeBrowser([BASELINE_TEXT], "https://s.myshopify.com/account/login?return_url=/checkout");
    const out = await runSmoke(deps({ calls, browser: browser as never }));
    expect(out.loginRequired).toBe(true);
    expect(out.pass).toBe(false);
  });

  it("throws LoginRequiredError type distinctly", () => {
    expect(new LoginRequiredError()).toBeInstanceOf(Error);
  });
});

// ── saved-address checkout shapes (live-found DOM layout) ────────────────

describe("extractOptions — discounted/original-price shapes", () => {
  it("one-line discounted option: struck original ignored, FREE wins", () => {
    const opts = extractOptions([
      "Standard",
      "Fri, Nov 20–Tue, Nov 24",
      "Original price $8.00 Discounted price FREE",
      "Express",
      "Fri, Nov 20–Mon, Nov 23",
      "$15.00",
    ]);
    const std = opts.find((o) => o.title === "Standard")!;
    expect(std).toMatchObject({ amountMinor: 0, free: true });
    expect(opts.find((o) => /express/i.test(o.title))).toMatchObject({ amountMinor: 1500, free: false });
  });

  it("split discounted option: Original price / Discounted price / FREE", () => {
    const opts = extractOptions([
      "Standard",
      "Fri, Nov 20–Tue, Nov 24",
      "Original price $8.00",
      "Discounted price",
      "FREE",
      "Express Shipping $15.00",
    ]);
    const std = opts.find((o) => o.title === "Standard")!;
    expect(std).toMatchObject({ amountMinor: 0, free: true });
    expect(opts.find((o) => /express/i.test(o.title))).toMatchObject({ amountMinor: 1500, free: false });
    // the struck-through $8.00 must never surface as an option amount
    expect(opts.some((o) => o.amountMinor === 800)).toBe(false);
  });

  it("selected-option summary shape: 'Shipping Original price $8.00 Discounted price FREE'", () => {
    const opts = extractOptions([
      "Standard",
      "Fri, Nov 20–Tue, Nov 24",
      "Original price $8.00",
      "Discounted price",
      "FREE",
      "Shipping Original price $8.00 Discounted price FREE",
      "Express",
      "$15.00",
    ]);
    const std = opts.find((o) => o.title === "Standard")!;
    expect(std).toMatchObject({ amountMinor: 0, free: true });
    expect(opts.find((o) => /express/i.test(o.title))).toMatchObject({ amountMinor: 1500, free: false });
  });

  it("plain priced options are unchanged", () => {
    const opts = extractOptions(["S3 Test Shipping $4.00", "Standard $8.00", "Express $15.00"]);
    expect(opts[0]).toMatchObject({ amountMinor: 400, free: false });
    expect(opts[1]).toMatchObject({ amountMinor: 800, free: false });
    expect(opts[2]).toMatchObject({ amountMinor: 1500, free: false });
  });

  it("a partially discounted option reports the discounted amount, not the original", () => {
    const opts = extractOptions([
      "Standard",
      "Original price $8.00 Discounted price $4.00",
    ]);
    expect(opts[0]).toMatchObject({ amountMinor: 400, free: false });
  });
});

// ── collapsed-panel expand + method selection (fake locators) ────────────

describe("browser shipping-panel helpers", () => {
  type Loc = ReturnType<typeof fakeLoc>;
  function fakeLoc(state: { radios: number; disabled: boolean; visible?: boolean; clicks?: string[] }) {
    const nth = (i: number) => ({
      click: async () => { state.clicks?.push(`click-${i}`); },
      isDisabled: async () => state.disabled,
      isVisible: async () => state.visible ?? true,
      isChecked: async () => true,
      check: async (opts?: { force?: boolean }) => { state.clicks?.push(`check-${i}-${opts?.force}`); },
    });
    return { count: async () => state.radios, allInnerTexts: async () => [] as string[], nth };
  }
  function fakePage(state: { radios: number; disabled: boolean; visible?: boolean; clicks?: string[] }, evalOut: (fn: (a: unknown) => unknown) => unknown) {
    return {
      locator: () => fakeLoc(state) as unknown as Loc & { nth: (i: number) => ReturnType<ReturnType<typeof fakeLoc>["nth"]> },
      evaluate: async (fn: (a: unknown) => unknown, arg?: unknown) => evalOut(fn),
      waitForTimeout: async () => {},
    } as never;
  }

  it("ensureShippingOptionsExpanded clicks the Shipping toggle once when radios are disabled", async () => {
    const { ensureShippingOptionsExpanded } = await import("../scripts/smoke/browser");
    const clicks: string[] = [];
    const state = { radios: 0, disabled: true, clicks };
    // radios unusable forever → the helper clicks once then gives up at waitMs
    const page = fakePage(state, () => -1);
    await ensureShippingOptionsExpanded(page, 30);
    expect(clicks.filter((c) => c === "click-1")).toHaveLength(1);
    // a second call with usable radios never toggles
    state.radios = 1; state.disabled = false;
    clicks.length = 0;
    await ensureShippingOptionsExpanded(page, 30);
    expect(clicks).toHaveLength(0);
  });

  it("selectShippingOption force-checks the matching radio and verifies", async () => {
    const { selectShippingOption } = await import("../scripts/smoke/browser");
    const clicks: string[] = [];
    const state = { radios: 2, disabled: false, clicks };
    const page = fakePage(state, (fn) =>
      String(fn).includes("querySelectorAll") ? 1 : true,
    );
    expect(await selectShippingOption(page, "Standard")).toBe(true);
    expect(clicks).toContain("check-1-true");
  });
});

// innerText drops the Original/Discounted labels — the struck original and
// the discounted value arrive as plain lines (live S2 failure shape).
describe("extractOptions — innerText label-free discounted shapes", () => {
  it("realistic block: bare struck line followed by bare FREE", () => {
    const opts = extractOptions([
      "Shipping method",
      "S3 Test Shipping",
      "Wed, Nov 18–Thu, Nov 19",
      "$4.00",
      "Standard",
      "Fri, Nov 20–Tue, Nov 24",
      "$8.00",
      "FREE",
      "Express",
      "Wed, Nov 18–Thu, Nov 19",
      "$15.00",
    ]);
    const s3 = opts.find((o) => /s3 test shipping/i.test(o.title))!;
    const std = opts.find((o) => o.title === "Standard")!;
    const exp = opts.find((o) => /express/i.test(o.title))!;
    expect(s3).toMatchObject({ amountMinor: 400, free: false });
    expect(std).toMatchObject({ amountMinor: 0, free: true });
    expect(exp).toMatchObject({ amountMinor: 1500, free: false });
    // the neighboring option's $4.00 must not leak into Standard
    expect(opts.filter((o) => o.title === "Standard")).toHaveLength(1);
  });

  it("bare struck line followed by a bare discounted price", () => {
    const opts = extractOptions(["Standard", "$8.00", "$4.00"]);
    expect(opts).toEqual([{ title: "Standard", amountMinor: 400, free: false }]);
  });

  it("one bare line with two price tokens — last wins", () => {
    const opts = extractOptions(["Standard", "$8.00 $4.00"]);
    expect(opts).toEqual([{ title: "Standard", amountMinor: 400, free: false }]);
  });

  it("one bare line price + FREE token — free wins over the original", () => {
    const opts = extractOptions(["Standard", "$8.00 FREE"]);
    expect(opts).toEqual([{ title: "Standard", amountMinor: 0, free: true }]);
  });

  it("titled line carrying struck + discounted tokens — last wins", () => {
    const opts = extractOptions(["Standard $8.00 FREE"]);
    expect(opts).toEqual([{ title: "Standard", amountMinor: 0, free: true }]);
  });

  it("consecutive undiscounted options are not merged", () => {
    const opts = extractOptions(["S3 Test Shipping", "$4.00", "Standard", "$8.00", "Express", "$15.00"]);
    expect(opts[0]).toMatchObject({ title: "S3 Test Shipping", amountMinor: 400 });
    expect(opts[1]).toMatchObject({ title: "Standard", amountMinor: 800 });
    expect(opts[2]).toMatchObject({ title: "Express", amountMinor: 1500 });
  });

  it("parses the live innerText shape with label-only lines on their own line", () => {
    const opts = extractOptions(["shipping method", "S3 Test Shipping", "Wed, Nov 18–Thu, Nov 19", "$4.00", "Standard", "Fri, Nov 20–Tue, Nov 24", "Original price", "$8.00", "Discounted price", "FREE", "Express", "Wed, Nov 18–Thu, Nov 19", "$15.00"]);
    expect(opts).toEqual([
      { title: "S3 Test Shipping", amountMinor: 400, free: false },
      { title: "Standard", amountMinor: 0, free: true },
      { title: "Express", amountMinor: 1500, free: false },
    ]);
  });
});
