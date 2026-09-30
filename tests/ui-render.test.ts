// Server-renders the dashboard, Settings and onboarding in their key states
// with Remix and App Bridge hooks mocked, so copy regressions and runtime prop
// errors fail CI.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";

const state: { loader: any; outlet: any } = {
  loader: null,
  outlet: { planHandle: "starter", planPrice: { amount: "19.0", currency: "USD", billingPeriod: "EVERY_30_DAYS" } },
};

vi.mock("@remix-run/react", () => ({
  useLoaderData: () => state.loader,
  useOutletContext: () => state.outlet,
  useFetcher: () => ({ state: "idle", data: undefined, submit: () => {} }),
  useNavigate: () => () => {},
  useRevalidator: () => ({ revalidate: () => {} }),
}));
vi.mock("@shopify/app-bridge-react", () => ({
  TitleBar: () => null,
  useAppBridge: () => ({ toast: { show: () => {} }, scopes: { request: async () => ({}) } }),
}));
vi.mock("../app/shopify.server", () => ({ authenticate: {} }));
vi.mock("../app/db.server", () => ({ default: {} }));

const pageHtml = async (path: string, loader: any) => {
  state.loader = loader;
  const mod = await import(path);
  return renderToString(createElement(AppProvider, { i18n: en }, createElement(mod.default)));
};
const text = (view: string) => view.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

const access = (activeLocationCount: number | null, granted: boolean) => {
  const requirement =
    activeLocationCount === null ? "unknown" : activeLocationCount <= 1 ? "not-needed" : granted ? "granted" : "needs-access";
  return { activeLocationCount, granted, requirement, blocked: requirement === "needs-access" };
};

const row = {
  orderId: "gid://shopify/Order/1",
  orderName: "#1001",
  customerName: "Karine Ruby",
  items: 2,
  latestAt: "2026-09-29T16:12:00.000Z",
  combined: [{ id: "r1", orderId: "gid://shopify/Order/2", orderName: "#1002" }],
};
const dash = (o: any = {}) => ({
  autoMergeEnabled: true,
  locationBlocked: false,
  activeLocationCount: 1,
  needsReview: [],
  combinedCount: 0,
  recentCount: 0,
  historyLimit: 100,
  recordsShown: 0,
  rows: [],
  ...o,
});
const settings = (o: any = {}) => ({
  settings: { autoMergeEnabled: true, mergeWindowHours: 24, acknowledged: true },
  locationAccess: access(1, false),
  shopHandle: "s",
  appHandle: "order-merge-app",
  ...o,
});
const onboarding = (o: any = {}) => ({
  done: false,
  started: false,
  mergeWindowHours: 24,
  locationAccess: access(1, false),
  ...o,
});

describe("dashboard", () => {
  it("running with no merges yet: product message, no alarms", async () => {
    const view = text(await pageHtml("../app/routes/app._index", dash()));
    expect(view).toContain("Repeat orders shouldn't mean more manual work.");
    expect(view).toContain("MergeShip is watching for eligible repeat orders");
    expect(view).toContain("Automatic merging on");
    expect(view).not.toMatch(/can't combine|Saved|Consolidat|Boxes|Allow location access|review/i);
  });

  it("paused by the merchant: quiet, no warning", async () => {
    const view = text(await pageHtml("../app/routes/app._index", dash({ autoMergeEnabled: false })));
    expect(view).toContain("Automatic merging paused");
    expect(view).toContain("Turn on in Settings");
    expect(view).not.toContain("can't combine");
  });

  it("interrupted by a location change: warning with the fix", async () => {
    const view = text(
      await pageHtml(
        "../app/routes/app._index",
        dash({
          locationBlocked: true,
          activeLocationCount: 2,
          needsReview: [{ id: "x", primary: { id: "gid://shopify/Order/3", name: "#1003" }, secondaries: [{ id: "gid://shopify/Order/4", name: "#1004" }] }],
          combinedCount: 1,
          recentCount: 1,
          recordsShown: 1,
          rows: [row],
        }),
      ),
    );
    expect(view).toContain("MergeShip can't combine orders right now");
    expect(view).toContain("Your fulfillment setup changed");
    expect(view).toContain("Allow location access");
    expect(view).toContain("Automatic merging stopped");
    expect(view).toContain("1 combine needs your review before fulfillment");
    expect(view).toContain("#1003");
    expect(view).toContain("combined from");
    expect(view).toMatch(/Last 30 days/);
    expect(view).not.toContain("Needs review");
    expect(view).toContain("#1002");
    expect(view).toContain("Sep 29, 4:12 PM UTC");
  });
});

describe("dashboard review state", () => {
  it("with activity and nothing to review: no review metric or banner at all", async () => {
    const view = text(
      await pageHtml("../app/routes/app._index", dash({ combinedCount: 1, recentCount: 1, recordsShown: 1, rows: [row] })),
    );
    expect(view).toContain("Repeat orders combined");
    expect(view).toContain("Recent activity");
    expect(view).not.toMatch(/review/i);
  });

  it("with operations needing review: count, explanation and links to each affected order", async () => {
    const view = await pageHtml(
      "../app/routes/app._index",
      dash({
        needsReview: [
          { id: "a", primary: { id: "gid://shopify/Order/31", name: "#1031" }, secondaries: [{ id: "gid://shopify/Order/32", name: "#1032" }] },
          { id: "b", primary: { id: "gid://shopify/Order/41", name: "#1041" }, secondaries: [] },
        ],
      }),
    );
    expect(text(view)).toContain("2 combines need your review before fulfillment");
    expect(text(view)).toContain("MergeShip-Review");
    for (const id of ["31", "32", "41"]) expect(view).toContain(`shopify:admin/orders/${id}`);
  });
});

describe("settings", () => {
  it("single-location store: no location section, quiet plan line", async () => {
    const view = text(await pageHtml("../app/routes/app.settings", settings()));
    expect(view).toContain("Always enforced.");
    expect(view).toContain("MergeShip only combines orders when:");
    expect(view).not.toContain("Location access");
    expect(view).not.toMatch(/Savings|Active\b/);
    expect(view).toContain("Starter — $19/month");
    expect(view).toContain("Manage plan");
  });

  it("merge window: presets, and a stored custom value shown as Custom in days", async () => {
    let view = await pageHtml("../app/routes/app.settings", settings());
    for (const label of ["1 hour", "6 hours", "24 hours (default)", "48 hours", "Custom"]) expect(view).toContain(label);
    view = await pageHtml(
      "../app/routes/app.settings",
      settings({ settings: { autoMergeEnabled: true, mergeWindowHours: 72, acknowledged: true } }),
    );
    // Server-rendered <select>s mark the chosen option with `selected`.
    expect(view).toMatch(/<option value="custom" selected/);
    expect(view).toMatch(/<option value="days" selected/);
    expect(view).toContain('value="3"');
  });

  it("multi-location with access: one quiet status line", async () => {
    const view = text(await pageHtml("../app/routes/app.settings", settings({ locationAccess: access(3, true) })));
    expect(view).toContain("Allowed · 3 active locations");
    expect(view).not.toContain("can't combine");
  });

  it("multi-location without access after setup: obvious action", async () => {
    const view = text(await pageHtml("../app/routes/app.settings", settings({ locationAccess: access(3, false) })));
    expect(view).toContain("MergeShip can't combine orders right now");
    expect(view).toContain("Allow location access");
  });

  it("does not show the acknowledgement to a merchant who already acknowledged", async () => {
    const view = text(
      await pageHtml(
        "../app/routes/app.settings",
        settings({ settings: { autoMergeEnabled: false, mergeWindowHours: 24, acknowledged: true } }),
      ),
    );
    expect(view).toContain("Automatic merging is paused");
    expect(view).not.toContain("Before you turn this on");
  });
});

describe("onboarding", () => {
  it("first visit: welcome screen, no warnings or technical detail", async () => {
    const view = text(await pageHtml("../app/routes/app.onboarding", onboarding({ locationAccess: access(3, false) })));
    expect(view).toContain("Welcome to MergeShip");
    expect(view).toContain("Set up MergeShip in about a minute.");
    expect(view).toContain("You'll:");
    expect(view).toContain("choose how long MergeShip should look for repeat orders");
    expect(view).toContain("confirm fulfillment-location access if your store requires it");
    expect(view).toContain("review the safety protections before enabling automation");
    expect(view).not.toMatch(/can't combine|fraud|Allow location access/);
  });

  it("returning part-way through setup: resumes at the first step", async () => {
    const view = text(await pageHtml("../app/routes/app.onboarding", onboarding({ started: true, mergeWindowHours: 12 })));
    expect(view).toContain("Step 1 of 3");
    expect(view).toContain("Choose a merge window");
  });

  it("multi-location stores get an extra, required location step", async () => {
    const view = text(
      await pageHtml("../app/routes/app.onboarding", onboarding({ started: true, locationAccess: access(3, false) })),
    );
    expect(view).toContain("Step 1 of 4");
  });

  it("done: confirms and hands off to the dashboard", async () => {
    const view = text(await pageHtml("../app/routes/app.onboarding", onboarding({ done: true })));
    expect(view).toContain("You're ready.");
    expect(view).toContain("MergeShip is now watching for eligible repeat orders.");
    expect(view).toContain("Go to dashboard");
  });
});
