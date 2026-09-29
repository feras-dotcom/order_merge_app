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
    expect(view).not.toMatch(/can't combine|Saved|Consolidat|Boxes|Allow location access/);
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
          needsReview: [{ id: "x", primaryOrderName: "#1003", secondaryNames: ["#1004"] }],
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
    expect(view).toContain("1 combined order needs review");
    expect(view).toContain("#1002");
    expect(view).toContain("Sep 29, 4:12 PM UTC");
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
    expect(view).toContain("Set up MergeShip");
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
