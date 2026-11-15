// runMonitor: every finding fires alone with canned inputs and none fire
// when clean; the thin script's exit mapping (CRITICAL->2, WARN->1) is
// derived from severities tested here. SQL paths are covered by the -pg
// suite.
import { describe, expect, it, vi } from "vitest";
import { runMonitor, type MonitorDeps, type MonitorFinding } from "../app/lib/checkout-discount/monitor.server";
import { CHECKOUT_DISCOUNT_MESSAGE } from "../app/lib/checkout-discount/config";
import { DEFAULT_SETTINGS, type MergeSettings } from "../app/lib/settings.server";

vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/shopify.server", () => ({ unauthenticated: { admin: async () => ({ admin: null }) } }));

const SHOP = "s.myshopify.com";
const DID = "gid://shopify/DiscountAutomaticNode/99";
const NOW = new Date("2026-11-20T12:00:00Z");
const EPOCH1 = new Date("2026-11-01T00:00:00Z");

const onSettings = (over: Partial<MergeSettings> = {}): MergeSettings => ({
  ...DEFAULT_SETTINGS,
  autoMergeEnabled: true,
  onboardingStartedAt: EPOCH1,
  onboardingCompletedAt: EPOCH1,
  mergeWindowHours: 24,
  checkoutDiscountEnabled: true,
  checkoutDiscountEnabledAt: EPOCH1,
  checkoutDiscountNodeId: DID,
  checkoutDiscountWindowHours: 24,
  checkoutDiscountMethod: "standard shipping",
  checkoutDiscountMaxShippingMinor: 800,
  checkoutDiscountCurrency: "USD",
  ...over,
});

const liveState = (over: Record<string, unknown> = {}) => ({
  status: "EXPIRED",
  typename: "DiscountAutomaticApp",
  appId: "gid://shopify/App/1",
  ownsThisApp: true,
  title: "t",
  functionId: "fn",
  startsAt: null,
  endsAt: null,
  combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
  windowId: "w1",
  percentage: "100.0",
  message: CHECKOUT_DISCOUNT_MESSAGE,
  windowStart: "2026-11-01T00:00:00",
  windowEnd: "2027-11-20T12:00:00", // shop-local, ~1y out
  config: {},
  ...over,
});

/** Fake db: WorkerInstance liveness, the CheckoutEligibilityWork counts,
 *  and the reportShops Settings selection. */
const makeDb = (facts: {
  shops?: string[];
  liveWorkers?: number;
  overdraw?: number;
  stuck?: number;
}) => {
  const flat = (x: any): string => {
    if (x == null) return "";
    if (typeof x === "object" && "strings" in x && "values" in x) {
      return x.strings.reduce(
        (s: string, p: string, i: number) => s + p + (i < x.values.length ? flat(x.values[i]) : " ?"),
        "",
      );
    }
    return ` ${String(x)}`;
  };
  const textOf = (first: any, rest: any[]) =>
    (Array.isArray(first) ? first : [String(first)]).reduce((s: string, p: string) => s + p, "") +
    rest.map(flat).join("");
  return {
    $queryRaw: (first: any, ...rest: any[]) => {
      const text = textOf(first, rest);
      if (text.includes('FROM "WorkerInstance"')) {
        return Promise.resolve([{ n: BigInt(facts.liveWorkers ?? 1) }]);
      }
      if (text.includes('FROM "Settings"')) {
        return Promise.resolve((facts.shops ?? [SHOP]).map((shop) => ({ shop })));
      }
      if (text.includes("CONSUMED_NO_RECORD")) {
        return Promise.resolve([{ n: BigInt(facts.overdraw ?? 0) }]);
      }
      if (text.includes('FROM "CheckoutEligibilityWork"')) {
        return Promise.resolve([{ n: BigInt(facts.stuck ?? 0) }]);
      }
      return Promise.resolve([{ n: 0n }]);
    },
  };
};

const deps = (over: Partial<MonitorDeps> = {}, dbFacts: Parameters<typeof makeDb>[0] = {}): MonitorDeps => ({
  db: makeDb(dbFacts) as any,
  shop: SHOP,
  env: (n) => (n === "MERGESHIP_CHECKOUT_DISCOUNT" ? "enabled" : undefined),
  settings: async () => onSettings(),
  control: async () => ({ checkoutDiscountEnabled: true, checkoutDiscountAllowShops: [SHOP] }),
  adminFactory: async () => ({ graphql: async () => ({}) } as any),
  discountReader: async () => liveState() as any,
  timezoneReader: async () => "UTC",
  now: () => NOW,
  ...over,
});

const codes = (fs: MonitorFinding[]) => fs.map((f) => f.code).sort();

describe("runMonitor", () => {
  it("clean state fires nothing", async () => {
    expect(await runMonitor(deps())).toEqual([]);
  });

  it("PENDING_SHUTDOWN: shop flag on + a failing per-shop lever (enforcer predicate)", async () => {
    const fs = await runMonitor(
      deps({ settings: async () => onSettings({ autoMergeEnabled: false }) }),
    );
    expect(codes(fs)).toEqual(["PENDING_SHUTDOWN"]);
    expect(fs[0].severity).toBe("CRITICAL");
  });

  it("no PENDING_SHUTDOWN when the flag is off even if a lever fails", async () => {
    const fs = await runMonitor(
      deps({
        settings: async () => onSettings({ checkoutDiscountEnabled: false, autoMergeEnabled: false }),
      }),
    );
    expect(fs.some((f) => f.code === "PENDING_SHUTDOWN")).toBe(false);
  });

  it("DISCOUNT_ACTIVE_WHILE_OFF: Admin ACTIVE while the gate is off", async () => {
    const fs = await runMonitor(
      deps({ discountReader: async () => liveState({ status: "ACTIVE" }) as any }),
    );
    // gate is off: shop flag is on but nothing else is missing? gate is
    // on here — DISCOUNT_ACTIVE_WHILE_OFF must NOT fire; make a lever fail:
    expect(fs.some((f) => f.code === "DISCOUNT_ACTIVE_WHILE_OFF")).toBe(false);

    const fs2 = await runMonitor(
      deps({
        env: () => undefined, // env lever off
        discountReader: async () => liveState({ status: "ACTIVE" }) as any,
      }),
    );
    expect(codes(fs2)).toEqual(["DISCOUNT_ACTIVE_WHILE_OFF"]);
    expect(fs2[0].severity).toBe("CRITICAL");
  });

  it("OVERDRAW_24H: overdraw rows in the window", async () => {
    const fs = await runMonitor(deps({}, { overdraw: 2 }));
    expect(codes(fs)).toEqual(["OVERDRAW_24H"]);
    expect(fs[0].severity).toBe("CRITICAL");
  });

  it("DISCOUNT_WINDOW_ENDED: ACTIVE with a past shop-local windowEnd", async () => {
    const fs = await runMonitor(
      deps({
        discountReader: async () =>
          liveState({ status: "ACTIVE", windowEnd: "2026-11-01T00:00:00" }) as any,
      }),
    );
    expect(codes(fs)).toEqual(["DISCOUNT_WINDOW_ENDED"]);
    expect(fs[0].severity).toBe("CRITICAL");
  });

  it("DISCOUNT_WINDOW_ENDS_SOON: ACTIVE ending inside 72h", async () => {
    const fs = await runMonitor(
      deps({
        discountReader: async () =>
          liveState({ status: "ACTIVE", windowEnd: "2026-11-22T12:00:00" }) as any, // +48h
      }),
    );
    expect(codes(fs)).toEqual(["DISCOUNT_WINDOW_ENDS_SOON"]);
    expect(fs[0].severity).toBe("WARN");
  });

  it("WORK_STUCK: REVIEW/EXHAUSTED rows present (even with the gate on)", async () => {
    const fs = await runMonitor(deps({}, { stuck: 1 }));
    expect(codes(fs)).toEqual(["WORK_STUCK"]);
    expect(fs[0].severity).toBe("WARN");
  });

  it("SWEEPER_STALE: no fresh WorkerInstance heartbeat", async () => {
    const fs = await runMonitor(deps({}, { liveWorkers: 0 }));
    expect(codes(fs)).toEqual(["SWEEPER_STALE"]);
    expect(fs[0].severity).toBe("WARN");
  });

  it("--no-admin skips the Admin findings entirely", async () => {
    const reader = vi.fn(async () => liveState({ status: "ACTIVE" }) as any);
    const fs = await runMonitor(
      deps({ noAdmin: true, discountReader: reader, env: () => undefined }),
    );
    expect(reader).not.toHaveBeenCalled();
    expect(fs.some((f) => f.code.startsWith("DISCOUNT_"))).toBe(false);
  });

  it("an unrecorded discount id skips Admin reads", async () => {
    const reader = vi.fn(async () => liveState() as any);
    const fs = await runMonitor(
      deps({
        settings: async () => onSettings({ checkoutDiscountNodeId: null }),
        discountReader: reader,
      }),
    );
    expect(reader).not.toHaveBeenCalled();
    expect(fs).toEqual([]);
  });
});
