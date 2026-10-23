import { describe, it, expect, vi } from "vitest";
import {
  migrateSessions,
  type MigrationTarget,
} from "../app/lib/session-migration.server";

const t = (id: string, refreshToken: string | null = "rtok"): MigrationTarget => ({
  id: `offline_${id}`,
  shop: `${id}.myshopify.com`,
  refreshToken,
});

function makeDeps(targets: MigrationTarget[]) {
  return {
    listTargets: vi.fn(async () => targets),
    refresh: vi.fn(async (target: MigrationTarget) => ({
      accessToken: `at-${target.shop}`,
    })),
    persist: vi.fn(async () => {}),
    verify: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
  };
}

describe("migrateSessions", () => {
  it("migrates every target through refresh → persist → verify", async () => {
    const targets = [t("a"), t("b"), t("c")];
    const deps = makeDeps(targets);
    const order: string[] = [];
    deps.refresh.mockImplementation(async (x: MigrationTarget) => {
      order.push(`refresh:${x.shop}`);
      return { accessToken: `at-${x.shop}` };
    });
    deps.persist.mockImplementation(async (x: MigrationTarget) => {
      order.push(`persist:${x.shop}`);
    });
    deps.verify.mockImplementation(async (x: MigrationTarget) => {
      order.push(`verify:${x.shop}`);
    });

    const results = await migrateSessions(deps, { delayMs: 10 });

    expect(results.map((r) => r.status)).toEqual([
      "migrated",
      "migrated",
      "migrated",
    ]);
    expect(order).toEqual([
      "refresh:a.myshopify.com",
      "persist:a.myshopify.com",
      "verify:a.myshopify.com",
      "refresh:b.myshopify.com",
      "persist:b.myshopify.com",
      "verify:b.myshopify.com",
      "refresh:c.myshopify.com",
      "persist:c.myshopify.com",
      "verify:c.myshopify.com",
    ]);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
  });

  it("skips sessions without a refresh token without touching Shopify", async () => {
    const targets = [t("a", null), t("b")];
    const deps = makeDeps(targets);

    const results = await migrateSessions(deps);

    expect(results[0]).toMatchObject({
      shop: "a.myshopify.com",
      status: "skipped",
    });
    expect(results[1].status).toBe("migrated");
    expect(deps.refresh).toHaveBeenCalledTimes(1);
  });

  it("isolates a refresh failure and continues the batch", async () => {
    const targets = [t("a"), t("b"), t("c")];
    const deps = makeDeps(targets);
    deps.refresh.mockImplementation(async (x: MigrationTarget) => {
      if (x.shop.startsWith("b")) throw new Error("invalid_grant");
      return { accessToken: `at-${x.shop}` };
    });

    const results = await migrateSessions(deps);

    expect(results.map((r) => r.status)).toEqual([
      "migrated",
      "failed",
      "migrated",
    ]);
    expect(results[1]).toMatchObject({ stage: "refresh" });
    expect(results[1].error).toContain("invalid_grant");
    expect(deps.refresh).toHaveBeenCalledTimes(3);
  });

  it("labels persist and verify failures with their stage", async () => {
    const targets = [t("a"), t("b")];
    const deps = makeDeps(targets);
    deps.persist.mockRejectedValueOnce(new Error("db down"));
    deps.verify.mockRejectedValueOnce(new Error("401 from admin"));

    const results = await migrateSessions(deps);

    expect(results[0]).toMatchObject({ status: "failed", stage: "persist" });
    expect(results[1]).toMatchObject({ status: "failed", stage: "verify" });
  });

  it("does not persist or verify when refresh fails", async () => {
    const targets = [t("a")];
    const deps = makeDeps(targets);
    deps.refresh.mockRejectedValue(new Error("boom"));

    const results = await migrateSessions(deps);

    expect(results[0].status).toBe("failed");
    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.verify).not.toHaveBeenCalled();
  });

  it("never includes token material in results", async () => {
    const targets = [t("a", "SECRET-REFRESH-TOKEN")];
    const deps = makeDeps(targets);
    deps.refresh.mockRejectedValue(new Error("failed for SECRET-REFRESH-TOKEN"));

    const results = await migrateSessions(deps);

    // The refresh error may legitimately embed upstream context, but the
    // structured fields (id/shop/status/stage) carry no token material.
    expect(results[0].id).not.toContain("SECRET");
    expect(results[0].shop).not.toContain("SECRET");
  });
});
