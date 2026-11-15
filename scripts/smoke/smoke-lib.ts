// Checkout shipping-discount smoke — injectable driver + pure guards,
// scenario table and verdict logic. The browser, Admin client and clock are
// injected so every code path is unit-tested with fakes. Ported scenario
// logic from the spike's e1-matrix/seed-eligibility experiments; Admin-side
// state is ALWAYS restored in a finally (discount deactivated and verified
// EXPIRED, eligibility metafield cleared, config metafield restored).
import { buildRecord, mergeRecords } from "../../app/lib/checkout-discount/records";
import { writeProjection } from "../../app/lib/checkout-discount/projection-write";
import {
  CHECKOUT_DISCOUNT_MESSAGE,
  validateCheckoutConfig,
} from "../../app/lib/checkout-discount/discount-control.server";
import { TEST_ADDRESS, type BrowserPage, type ScrapedCheckout, type TestAddress } from "./browser";

// ── args / guards ─────────────────────────────────────────────────────────

export interface SmokeArgs {
  store: string;
  clientId: string;
  envFile: string;
  discountId: string;
  workspace: string;
  out?: string;
  apply: boolean;
  customer?: string; // gid or numeric id of the signed-in customer
  variantNumeric: string;
  methodTitle: string;
  adminVia?: "railway"; // route Admin GraphQL through `railway ssh` (IP allowlist)
  railwayBin?: string;
  railwayCwd?: string;
}

export function parseArgs(argv: string[]): { ok: true; args: SmokeArgs } | { ok: false; error: string } {
  const opt = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const store = opt("--store");
  const clientId = opt("--client-id");
  const envFile = opt("--env-file");
  const discountId = opt("--discount-id");
  const workspace = opt("--workspace");
  const adminVia = opt("--admin-via");
  if (!store || !clientId || !envFile || !discountId || !workspace) {
    return {
      ok: false,
      error:
        "usage: checkout-discount-smoke --store <x.myshopify.com> --client-id <id> --env-file <path> --discount-id <gid> --workspace <dir> [--out <dir>] [--customer <gid>] [--variant <numericId>] [--admin-via railway] [--railway-bin <path>] [--railway-cwd <dir>] [--apply]",
    };
  }
  if (adminVia !== undefined && adminVia !== "railway") {
    return { ok: false, error: `--admin-via only supports "railway" (got "${adminVia}")` };
  }
  return {
    ok: true,
    args: {
      store,
      clientId,
      envFile,
      discountId,
      workspace,
      out: opt("--out"),
      apply: argv.includes("--apply"),
      customer: opt("--customer"),
      variantNumeric: opt("--variant") ?? "68100323508591",
      methodTitle: opt("--method") ?? "Standard",
      adminVia: adminVia as "railway" | undefined,
      railwayBin: opt("--railway-bin"),
      railwayCwd: opt("--railway-cwd"),
    },
  };
}

export type GuardFailure =
  | "NOT_MY_SHOPIFY_DOMAIN"
  | "CLIENT_ID_MISMATCH"
  | "NOT_A_DEV_STORE"
  | "NOT_APP_OWNED_DISCOUNT"
  | "DISCOUNT_WRONG_TYPE"
  | "CONFIG_INVALID";

export interface GuardInput {
  store: string;
  clientId: string;
  envApiKey: string;
  planPartnerDevelopment?: boolean | null;
  discountOwnedByThisApp?: boolean | null;
  discountTypename?: string | null;
}

/** Pure guard evaluation — the driver fills in the Admin-derived fields. */
export function evaluateGuards(g: GuardInput): GuardFailure[] {
  const fails: GuardFailure[] = [];
  if (!g.store.endsWith(".myshopify.com")) fails.push("NOT_MY_SHOPIFY_DOMAIN");
  if (!g.envApiKey || g.envApiKey !== g.clientId) fails.push("CLIENT_ID_MISMATCH");
  if (g.planPartnerDevelopment === false) fails.push("NOT_A_DEV_STORE");
  if (g.discountTypename && g.discountTypename !== "DiscountAutomaticApp") fails.push("DISCOUNT_WRONG_TYPE");
  if (g.discountOwnedByThisApp === false) fails.push("NOT_APP_OWNED_DISCOUNT");
  return fails;
}

// ── scrape → verdict ─────────────────────────────────────────────────────

export interface OptionVerdict {
  title: string;
  amountMinor: number | null;
  free: boolean;
}

const PRICE_RE = /\$?\s*([\d,]+\.\d{2})/;
const PRICE_RE_G = /\$?\s*([\d,]+\.\d{2})/g;
// Delivery-estimate lines ("Fri, Nov 20–Tue, Nov 24", "3 business days")
// are skipped when pairing a price line back to its option title.
const ESTIMATE_RE =
  /(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s*,?|business days|\d+\s*(?:-|–|—|to)\s*\w+|^\d+\s*days?/i;

const DISCOUNTED_RE = /discounted price/i;
const ORIGINAL_RE = /original price/i;
// Label rows that never carry an option title — the struck-through original,
// the discounted-price marker and a lone FREE.
const PRICE_LABEL_RE = /^(original price|discounted price|free)$/i;

/** Parse scraped shipping-block lines into {title, amountMinor, free}.
 *  Handles "Standard $8.00", the three-line layout (title / estimate /
 *  "$8.00"), and the discounted layouts:
 *   - "Original price $8.00 Discounted price FREE" (one line or split),
 *   - innerText's label-free shape: the struck original and the discounted
 *     value on CONSECUTIVE bare lines ("$8.00" then "FREE" / "$8.00" then
 *     "$4.00") or in one bare line ("$8.00 FREE" / "$8.00 $4.00") — the
 *     LAST bare value is the option's real amount.
 *  A struck-through original is never an option's amount (FREE or 0.00 =>
 *  free, amountMinor 0). Each priced line is paired with the nearest
 *  preceding line that is neither a price, an estimate nor a price label. */
export function extractOptions(shippingLines: string[]): OptionVerdict[] {
  const hasPrice = (l: string) => PRICE_RE.test(l) || /free/i.test(l);
  const isMarker = (l: string) => PRICE_LABEL_RE.test(l.trim());
  const bareTitle = (l: string) =>
    l
      .replace(PRICE_RE_G, "")
      .replace(/free/gi, "")
      .replace(/[·\-–—]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  // A line carrying only prices/free markers (no title) — e.g. "$8.00",
  // "FREE", "$8.00 FREE". The label words make it an explicit-label line.
  const isBarePrice = (l: string) =>
    hasPrice(l) && !ORIGINAL_RE.test(l) && !DISCOUNTED_RE.test(l) && bareTitle(l) === "";
  const minorOf = (m: RegExpMatchArray | null) =>
    m ? Math.round(parseFloat(m[1].replace(/,/g, "")) * 100) : null;
  const lastToken = (l: string) => {
    const all = [...l.matchAll(PRICE_RE_G)];
    return all.length ? all[all.length - 1] : null;
  };
  const isFree = (l: string, last: RegExpMatchArray | null) =>
    /free/i.test(l) || (last !== null && parseFloat(last[1].replace(/,/g, "")) === 0);
  const titleBefore = (i: number): string => {
    for (let j = i - 1; j >= 0; j--) {
      const cand = shippingLines[j];
      if (hasPrice(cand) || ESTIMATE_RE.test(cand) || isMarker(cand)) continue;
      return cand;
    }
    return "";
  };
  const out: OptionVerdict[] = [];
  for (let i = 0; i < shippingLines.length; i++) {
    const line = shippingLines[i];
    if (!hasPrice(line)) continue;
    if (DISCOUNTED_RE.test(line)) {
      // The discounted value follows "Discounted price" on this line or the
      // next ("…Discounted price FREE" | "Discounted price\nFREE").
      const tail = line.replace(/^.*?discounted price/i, "").trim();
      const value = tail || shippingLines[i + 1] || "";
      const last = lastToken(value);
      const free = isFree(value, last);
      out.push({ title: titleBefore(i), amountMinor: free ? 0 : minorOf(last), free });
      continue;
    }
    // A bare "Original price $8.00" is a struck-through original — the real
    // amount comes from its "Discounted price" companion line.
    if (ORIGINAL_RE.test(line)) continue;
    // Struck original + discounted value on consecutive bare lines
    // ("$8.00" / "FREE") — merge the run; its last line holds the amount.
    let valueLine = line;
    if (isBarePrice(line)) {
      while (i + 1 < shippingLines.length && isBarePrice(shippingLines[i + 1])) {
        i += 1;
        valueLine = shippingLines[i];
      }
    }
    const last = lastToken(valueLine);
    const free = isFree(valueLine, last);
    const inlineTitle = bareTitle(line);
    out.push({
      title: inlineTitle || titleBefore(i),
      amountMinor: free ? 0 : minorOf(last),
      free,
    });
  }
  return out;
}

const normTitle = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

export interface ScenarioObserved {
  standardFree: boolean;
  standardAmountMinor: number | null;
  messageShown: boolean;
  expressAmountMinor: number | null;
}

export function observeScrape(
  scraped: Pick<ScrapedCheckout, "optionLines" | "discounts" | "bodyText">,
  opts: { methodTitle: string; expressBaselineMinor: number; message?: string },
): ScenarioObserved {
  const options = extractOptions(scraped.optionLines);
  const want = normTitle(opts.methodTitle);
  const standard =
    options.find((o) => normTitle(o.title) === want) ??
    options.find((o) => normTitle(o.title).includes(want) || want.includes(normTitle(o.title)));
  const express = options.find((o) => /express/i.test(o.title));
  const message = opts.message ?? CHECKOUT_DISCOUNT_MESSAGE;
  const text = [...scraped.discounts, scraped.bodyText].join("\n");
  return {
    standardFree: standard?.free ?? false,
    standardAmountMinor: standard?.amountMinor ?? null,
    messageShown: text.includes(message) || /mergeship/i.test(text),
    expressAmountMinor: express?.amountMinor ?? null,
  };
}

export type ScenarioName = "S1-baseline" | "S2-granted" | "S3-diff-street" | "S4-kill-switch";

export interface ScenarioResult {
  scenario: ScenarioName;
  pass: boolean;
  detail: Record<string, unknown>;
}

/** Expected outcome per scenario. `expressBaselineMinor` guards the
 *  anti-side-effect check (the Function must only touch the matching
 *  method). */
export function verdictFor(scenario: ScenarioName, o: ScenarioObserved, expressBaselineMinor: number): boolean {
  const baseline = !o.standardFree && o.standardAmountMinor !== 0;
  switch (scenario) {
    case "S1-baseline":
      return baseline && !o.messageShown;
    case "S2-granted":
      return o.standardFree && o.messageShown && o.expressAmountMinor === expressBaselineMinor;
    case "S3-diff-street":
      return baseline && !o.messageShown;
    case "S4-kill-switch":
      return baseline && !o.messageShown;
  }
}

// ── Admin-side state (seed / clear / config / activate / restore) ────────

interface AdminLike {
  graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<unknown>;
}

const Q_DISCOUNT = `query Discount($id: ID!) {
  automaticDiscountNode(id: $id) {
    id
    automaticDiscount {
      __typename
      ... on DiscountAutomaticApp {
        title status startsAt endsAt
        combinesWith { orderDiscounts productDiscounts shippingDiscounts }
        appDiscountType { functionId app { id } }
      }
    }
    metafield(namespace: "$app", key: "config") { jsonValue }
  }
  currentAppInstallation { app { id } }
}`;

const M_UPDATE = `mutation DUpdate($id: ID!, $input: DiscountAutomaticAppInput!) {
  discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $input) {
    automaticAppDiscount { discountId status }
    userErrors { field message }
  }
}`;

const M_ACTIVATE = `mutation DActivate($id: ID!) {
  discountAutomaticActivate(id: $id) { automaticDiscountNode { id } userErrors { field message } }
}`;

const M_DEACTIVATE = `mutation DDeactivate($id: ID!) {
  discountAutomaticDeactivate(id: $id) { automaticDiscountNode { id } userErrors { field message } }
}`;

const Q_STATUS = `query DS($id: ID!) {
  automaticDiscountNode(id: $id) { automaticDiscount { __typename ... on DiscountAutomaticApp { status } } }
}`;

const dataOf = (res: unknown): Record<string, unknown> => {
  if (typeof res === "object" && res !== null && "data" in (res as object)) {
    return (res as { data: Record<string, unknown> }).data ?? {};
  }
  return (res as Record<string, unknown>) ?? {};
};

export interface DiscountSnapshot {
  status: string;
  typename: string;
  title: string;
  combinesWith: { orderDiscounts: boolean; productDiscounts: boolean; shippingDiscounts: boolean };
  config: Record<string, unknown>;
  ownedByThisApp: boolean;
}

export async function readDiscount(admin: AdminLike, discountId: string): Promise<DiscountSnapshot | null> {
  const d = dataOf(await admin.graphql(Q_DISCOUNT, { variables: { id: discountId } }));
  const node = d.automaticDiscountNode as
    | { automaticDiscount?: Record<string, any>; metafield?: { jsonValue?: Record<string, unknown> } }
    | null
    | undefined;
  const disc = node?.automaticDiscount;
  if (!disc) return null;
  const mine = (d.currentAppInstallation as { app?: { id?: string } })?.app?.id ?? null;
  const appId = disc.appDiscountType?.app?.id ?? null;
  return {
    status: disc.status ?? "UNKNOWN",
    typename: disc.__typename ?? "UNKNOWN",
    title: disc.title ?? "",
    combinesWith: {
      orderDiscounts: disc.combinesWith?.orderDiscounts ?? false,
      productDiscounts: disc.combinesWith?.productDiscounts ?? false,
      shippingDiscounts: disc.combinesWith?.shippingDiscounts ?? false,
    },
    config: node?.metafield?.jsonValue ?? {},
    ownedByThisApp: appId !== null && appId === mine,
  };
}

async function updateConfig(admin: AdminLike, discountId: string, snap: DiscountSnapshot, config: Record<string, unknown>) {
  const res = dataOf(
    await admin.graphql(M_UPDATE, {
      variables: {
        id: discountId,
        input: {
          title: snap.title,
          combinesWith: snap.combinesWith,
          metafields: [{ namespace: "$app", key: "config", type: "json", value: JSON.stringify(config) }],
        },
      },
    }),
  );
  const errs = (res.discountAutomaticAppUpdate as { userErrors?: { message?: string }[] })?.userErrors ?? [];
  if (errs.length) throw new Error(`discount update refused: ${JSON.stringify(errs)}`);
}

export async function activateDiscount(admin: AdminLike, discountId: string) {
  const res = dataOf(await admin.graphql(M_ACTIVATE, { variables: { id: discountId } }));
  const errs = (res.discountAutomaticActivate as { userErrors?: { message?: string }[] })?.userErrors ?? [];
  if (errs.length) throw new Error(`activate refused: ${JSON.stringify(errs)}`);
}

/** Deactivate then verify EXPIRED via the status-only read — same
 *  fail-closed shape as shutdownCheckoutDiscount. */
export async function deactivateVerified(admin: AdminLike, discountId: string): Promise<string> {
  const res = dataOf(await admin.graphql(M_DEACTIVATE, { variables: { id: discountId } }));
  const errs = (res.discountAutomaticDeactivate as { userErrors?: { message?: string }[] })?.userErrors ?? [];
  if (errs.length) throw new Error(`deactivate refused: ${JSON.stringify(errs)}`);
  const rb = dataOf(await admin.graphql(Q_STATUS, { variables: { id: discountId } }));
  const status =
    ((rb.automaticDiscountNode as { automaticDiscount?: { status?: string } })?.automaticDiscount?.status) ??
    "UNKNOWN";
  if (status !== "EXPIRED" && status !== "UNKNOWN_DELETED") {
    throw new Error(`deactivation not verified: status=${status}`);
  }
  return status;
}

const Q_FIND_CUSTOMER = `query F($q: String!) { customers(first: 1, query: $q) { nodes { id } } }`;

export async function findCustomerId(admin: AdminLike, idOrEmail: string): Promise<string | null> {
  const q = idOrEmail.startsWith("gid://")
    ? `id:${idOrEmail.split("/").pop()}`
    : /^\d+$/.test(idOrEmail)
      ? `id:${idOrEmail}`
      : `email:${idOrEmail}`;
  const res = dataOf(await admin.graphql(Q_FIND_CUSTOMER, { variables: { q } }));
  return ((res.customers as { nodes?: { id?: string }[] })?.nodes?.[0]?.id as string) ?? null;
}

export async function seedEligibility(
  admin: AdminLike,
  customerId: string,
  opts: { windowId: string; methodTitle: string; address: TestAddress; todayDate: string; expiresOn: string; currencyCode?: string; shippingMinor?: number },
): Promise<{ recordId: string }> {
  const minor = opts.shippingMinor ?? 800;
  const built = buildRecord(
    {
      orderId: `gid://shopify/Order/9${String(Date.now()).slice(-9)}`,
      customerId,
      currencyCode: opts.currencyCode ?? "USD",
      shippingAddress: { ...opts.address },
      shippingLines: [{ title: opts.methodTitle, originalMinor: minor, discountedMinor: minor }],
      cancelledAt: null,
      financialStatus: "PAID",
    },
    { windowId: opts.windowId, expiresOn: opts.expiresOn },
  );
  if (!built.ok) throw new Error(`buildRecord refused: ${built.reason}`);
  await writeProjection(
    admin,
    customerId,
    (cur) => ({ serialized: mergeRecords(cur, [built.record], { todayDate: opts.todayDate }).serialized }),
    { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  );
  return { recordId: built.record.id };
}

export async function clearEligibility(admin: AdminLike, customerId: string): Promise<void> {
  await writeProjection(admin, customerId, () => ({ serialized: JSON.stringify({ recs: [], v: 1 }) }), {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
}

// ── driver ────────────────────────────────────────────────────────────────

export interface SmokeDriverDeps {
  admin: AdminLike;
  adminGraphql: (q: string, v?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  envApiKey: string;
  /** When true the driver stops after the read-only guards: no writes, no browser. */
  dryRun?: boolean;
  browser: { connect(): Promise<{ newPage(): Promise<BrowserPage>; close(): Promise<void> }> };
  args: SmokeArgs;
  shot?: (page: BrowserPage, name: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  shopTimezone?: string;
  log?: (s: string) => void;
}

const plusDays = (yyyymmdd: string, n: number) =>
  new Date(new Date(yyyymmdd + "T00:00:00Z").getTime() + n * 86400e3).toISOString().slice(0, 10);

const shopLocalDate = (d: Date, tz: string) => d.toLocaleDateString("en-CA", { timeZone: tz });
const shopLocalDateTime = (d: Date, tz: string) =>
  d
    .toLocaleString("sv-SE", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .replace(" ", "T");

export interface SmokeOutcome {
  results: ScenarioResult[];
  loginRequired: boolean;
  pass: boolean;
  guardFailures: GuardFailure[];
}

export async function runSmoke(deps: SmokeDriverDeps): Promise<SmokeOutcome> {
  const { args, admin } = deps;
  const log = deps.log ?? (() => {});
  const tz = deps.shopTimezone ?? "America/New_York";
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const results: ScenarioResult[] = [];
  const out: SmokeOutcome = { results, loginRequired: false, pass: false, guardFailures: [] };

  // ── read-only guards (also run in dry-run mode) ────────────────────────
  const shopRes = await deps.adminGraphql(
    `query { shop { ianaTimezone currencyCode plan { partnerDevelopment shopifyPlus displayName } } }`,
  );
  const shop = shopRes.shop as { ianaTimezone?: string; currencyCode?: string; plan?: { partnerDevelopment?: boolean } };
  const snap = await readDiscount(admin, args.discountId);
  const guardFailures = evaluateGuards({
    store: args.store,
    clientId: args.clientId,
    envApiKey: deps.envApiKey,
    planPartnerDevelopment: shop?.plan?.partnerDevelopment ?? null,
    discountOwnedByThisApp: snap?.ownedByThisApp ?? null,
    discountTypename: snap?.typename ?? null,
  });
  out.guardFailures = guardFailures;
  if (guardFailures.length) return out;
  if (!snap) {
    out.guardFailures = ["DISCOUNT_WRONG_TYPE"];
    return out;
  }
  validateCheckoutConfig(snap.config); // throws on malformed config — fail closed

  if (deps.dryRun) return out;

  const customerId = args.customer ? await findCustomerId(admin, args.customer) : null;
  if (!customerId) {
    out.guardFailures = [];
    throw new Error("customer not found: pass --customer <gid-or-numeric-id> of the signed-in customer");
  }

  const methodTitle = args.methodTitle;
  const expressBaselineMinor = 1500;
  const windowId = `w-smoke-${now().getTime()}`;
  const today = shopLocalDate(now(), shop?.ianaTimezone ?? tz);
  const originalSnap = snap;

  const trial = async (name: ScenarioName, address: TestAddress): Promise<ScenarioResult> => {
    const ctx = await deps.browser.connect();
    try {
      const page = await ctx.newPage();
      const {
        buildCartAndCheckout,
        fillAddress,
        scrapeCheckout,
        ensureShippingOptionsExpanded,
        selectShippingOption,
      } = await import("./browser");
      for (let attempt = 0; attempt < 2; attempt++) {
        await buildCartAndCheckout(page, `https://${args.store}`, args.variantNumeric);
        await page.waitForTimeout(3000);
        const text = await scrapeCheckout(page);
        if (/shipping method|order summary|contact/i.test(text.bodyText)) break;
        await page.waitForTimeout(2500); // cart permalink may not have landed yet — retry once
      }
      if (/accounts|login/i.test(page.url())) {
        out.loginRequired = true;
        throw new LoginRequiredError();
      }
      await fillAddress(page, address);
      await page.waitForTimeout(4000);
      // Saved-address checkout renders the options collapsed — expand the
      // Shipping row once, then select the --method option (the discount row
      // only renders for the selected option, in EVERY scenario).
      await ensureShippingOptionsExpanded(page);
      await selectShippingOption(page, methodTitle);
      const scraped = await scrapeCheckout(page);
      if (deps.shot) await deps.shot(page, name);
      // Guest checkout = the persisted profile is not signed in. The Function
      // only grants for authenticated buyers, so further trials are pointless:
      // the operator must sign in once, then re-run.
      if (/\bsign in\b/i.test(scraped.bodyText.slice(0, 1500))) {
        out.loginRequired = true;
        throw new LoginRequiredError();
      }
      let lastLines = scraped.optionLines;
      let observed = observeScrape(scraped, { methodTitle, expressBaselineMinor });
      // S2 can race the Function's propagation to the delivery UI — rescore
      // a few times before failing (the scrape is read-only).
      if (name === "S2-granted") {
        for (
          let r = 0;
          r < 4 && !verdictFor(name, observed, expressBaselineMinor);
          r++
        ) {
          await sleep(4000);
          const re = await scrapeCheckout(page);
          lastLines = re.optionLines;
          observed = observeScrape(re, { methodTitle, expressBaselineMinor });
        }
      }
      return {
        scenario: name,
        pass: verdictFor(name, observed, expressBaselineMinor),
        detail: {
          standardAmountMinor: observed.standardAmountMinor,
          standardFree: observed.standardFree,
          expressAmountMinor: observed.expressAmountMinor,
          messageShown: observed.messageShown,
          // S2 diagnostics: the raw shipping-block lines (titles/prices only)
          // so a failed verdict shows exactly what innerText yielded.
          ...(name === "S2-granted"
            ? { optionLines: lastLines.filter((l) => typeof l === "string").slice(0, 30) }
            : {}),
        },
      };
    } finally {
      await ctx.close();
    }
  };

  try {
    // S1 — baseline, no record
    await clearEligibility(admin, customerId);
    await deactivateVerified(admin, args.discountId);
    results.push(await trial("S1-baseline", TEST_ADDRESS));

    // S2 — matching record + ACTIVE discount with our windowId
    await updateConfig(admin, args.discountId, originalSnap, {
      v: 1,
      windowId,
      percentage: "100.0",
      message: CHECKOUT_DISCOUNT_MESSAGE,
      windowStart: shopLocalDateTime(new Date(now().getTime() - 86400e3), shop?.ianaTimezone ?? tz),
      windowEnd: shopLocalDateTime(new Date(now().getTime() + 30 * 86400e3), shop?.ianaTimezone ?? tz),
    });
    await seedEligibility(admin, customerId, {
      windowId,
      methodTitle,
      address: TEST_ADDRESS,
      todayDate: today,
      expiresOn: plusDays(today, 3),
      currencyCode: shop?.currencyCode ?? "USD",
    });
    await activateDiscount(admin, args.discountId);
    results.push(await trial("S2-granted", TEST_ADDRESS));

    // S3 — record for a different street (same ACTIVE discount)
    await clearEligibility(admin, customerId);
    await seedEligibility(admin, customerId, {
      windowId,
      methodTitle,
      address: { ...TEST_ADDRESS, address1: "999 Other Avenue" },
      todayDate: today,
      expiresOn: plusDays(today, 3),
      currencyCode: shop?.currencyCode ?? "USD",
    });
    results.push(await trial("S3-diff-street", TEST_ADDRESS));

    // S4 — matching record but discount deactivated (kill-switch proof)
    await clearEligibility(admin, customerId);
    await seedEligibility(admin, customerId, {
      windowId,
      methodTitle,
      address: TEST_ADDRESS,
      todayDate: today,
      expiresOn: plusDays(today, 3),
      currencyCode: shop?.currencyCode ?? "USD",
    });
    await deactivateVerified(admin, args.discountId);
    results.push(await trial("S4-kill-switch", TEST_ADDRESS));
  } catch (e) {
    if (e instanceof LoginRequiredError) {
      out.loginRequired = true;
    } else {
      throw e;
    }
  } finally {
    // ── restore ALWAYS: discount off + verified, config + eligibility back ──
    try {
      await deactivateVerified(admin, args.discountId);
    } catch (e) {
      log(`restore: deactivate failed: ${(e as Error).message}`);
    }
    try {
      await updateConfig(admin, args.discountId, originalSnap, originalSnap.config);
    } catch (e) {
      log(`restore: config restore failed: ${(e as Error).message}`);
    }
    try {
      await clearEligibility(admin, customerId);
    } catch (e) {
      log(`restore: eligibility clear failed: ${(e as Error).message}`);
    }
  }

  await sleep(0);
  out.pass = !out.loginRequired && results.length === 4 && results.every((r) => r.pass);
  return out;
}

export class LoginRequiredError extends Error {
  constructor() {
    super("LOGIN_REQUIRED: the persistent browser profile is not signed in");
    this.name = "LoginRequiredError";
  }
}
