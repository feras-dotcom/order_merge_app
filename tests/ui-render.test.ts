// Server-renders the dashboard and Settings in their key states with Remix and
// App Bridge hooks mocked, so copy regressions and runtime prop errors fail CI.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";

const state: { loader: any; outlet: any } = { loader: null, outlet: { planHandle: "pro" } };

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
  settings: { autoMergeEnabled: false, mergeWindowHours: 24 },
  locationAccess: { activeLocationCount: 1, granted: false, blocked: false },
  shopHandle: "s",
  appHandle: "order-merge-app",
  ...o,
});

describe("dashboard renders", () => {
  it("empty + on", async () => {
    const view = await pageHtml("../app/routes/app._index", dash());
    expect(view).toContain("Repeat orders shouldn");
    expect(view).toContain("Automatic merging on");
    expect(view).not.toMatch(/Saved|Consolidat|Boxes/);
  });
  it("off", async () => {
    const view = await pageHtml("../app/routes/app._index", dash({ autoMergeEnabled: false }));
    expect(view).toContain("Automatic merging is off");
    expect(view).toContain("Go to Settings");
  });
  it("blocked + review + activity", async () => {
    const view = await pageHtml(
      "../app/routes/app._index",
      dash({
        locationBlocked: true,
        activeLocationCount: 3,
        needsReview: [{ id: "x", primaryOrderName: "#1003", secondaryNames: ["#1004"] }],
        combinedCount: 1,
        recentCount: 1,
        recordsShown: 1,
        rows: [row],
      }),
    );
    expect(view).toContain("Allow location access");
    expect(view).toContain("1 combined order needs review");
    expect(view).toContain("Automatic merging paused");
    expect(view).toContain("#1002");
    expect(view).toContain("Sep 29, 4:12 PM UTC");
  });
});

describe("settings renders", () => {
  it("single location", async () => {
    const view = await pageHtml("../app/routes/app.settings", settings());
    expect(view).toContain("Safety rules");
    expect(view).not.toContain("Location access");
    expect(view).not.toMatch(/Savings|Active<\/span>/);
    expect(view).toContain("Pro plan");
  });
  it("multi-location granted / blocked", async () => {
    let view = await pageHtml(
      "../app/routes/app.settings",
      settings({ locationAccess: { activeLocationCount: 3, granted: true, blocked: false } }),
    );
    expect(view).toContain("Allowed · 3 active locations");
    view = await pageHtml(
      "../app/routes/app.settings",
      settings({ locationAccess: { activeLocationCount: 3, granted: false, blocked: true } }),
    );
    expect(view).toContain("can&#x27;t combine orders yet");
  });
});
