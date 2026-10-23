import { describe, it, expect, vi } from "vitest";
import {
  createSessionMigrationDeps,
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
    persist: vi.fn(async (_t: MigrationTarget, _r: unknown) => {}),
    verify: vi.fn(async (_t: MigrationTarget) => {}),
    sleep: vi.fn(async (_ms: number) => {}),
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

// ── Production wiring (createSessionMigrationDeps) ───────────────────────────

function makeStore() {
  return {
    session: {
      findMany: vi.fn(async () => [] as MigrationTarget[]),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => ({ accessToken: "stored-at" })),
    },
  };
}

const COMPLETE_REFRESH = {
  access_token: "at-new",
  refresh_token: "rt-new",
  expires_in: 3600,
  refresh_token_expires_in: 7200,
  scope: "read_orders,write_orders",
};

function fetchReturning(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("createSessionMigrationDeps", () => {
  it("issues the OAuth refresh_token grant with the new secret", async () => {
    const fetchImpl = fetchReturning(COMPLETE_REFRESH);
    const deps = createSessionMigrationDeps({
      prisma: makeStore(),
      apiKey: "KEY",
      apiSecret: "NEW-SECRET",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const target = t("shop1", "rt-old");

    await deps.refresh(target);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://shop1.myshopify.com/admin/oauth/access_token");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeDefined();
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({
      client_id: "KEY",
      client_secret: "NEW-SECRET",
      refresh_token: "rt-old",
      grant_type: "refresh_token",
    });
  });

  it.each([
    ["missing refresh_token", { ...COMPLETE_REFRESH, refresh_token: undefined }],
    [
      "missing refresh_token_expires_in",
      { ...COMPLETE_REFRESH, refresh_token_expires_in: undefined },
    ],
    ["missing expires_in", { ...COMPLETE_REFRESH, expires_in: undefined }],
    ["missing access_token", { ...COMPLETE_REFRESH, access_token: undefined }],
  ])("rejects an incomplete refresh response (%s)", async (_label, body) => {
    const deps = createSessionMigrationDeps({
      prisma: makeStore(),
      apiKey: "K",
      apiSecret: "S",
      fetchImpl: fetchReturning(body) as unknown as typeof fetch,
    });

    await expect(deps.refresh(t("s"))).rejects.toThrow(
      "incomplete refresh response",
    );
  });

  it("does not persist anything for an incomplete response", async () => {
    const store = makeStore();
    const deps = createSessionMigrationDeps({
      prisma: store,
      apiKey: "K",
      apiSecret: "S",
      fetchImpl: fetchReturning({
        ...COMPLETE_REFRESH,
        refresh_token_expires_in: undefined,
      }) as unknown as typeof fetch,
    });

    await expect(deps.refresh(t("s"))).rejects.toThrow("incomplete");
    expect(store.session.updateMany).not.toHaveBeenCalled();
  });

  it("persists only while the observed refresh token is unchanged", async () => {
    const store = makeStore();
    const deps = createSessionMigrationDeps({
      prisma: store,
      apiKey: "K",
      apiSecret: "S",
      fetchImpl: fetchReturning(COMPLETE_REFRESH) as unknown as typeof fetch,
    });
    const target = t("shop1", "rt-observed");
    const material = await deps.refresh(target);

    await deps.persist(target, material);

    const [args] = store.session.updateMany.mock.calls[0] as unknown as [
      { where: { id: string; refreshToken: string }; data: object },
    ];
    // Compare-and-swap: the update only applies if the row still holds the
    // refresh token observed when targets were listed.
    expect(args.where).toEqual({
      id: "offline_shop1",
      refreshToken: "rt-observed",
    });
    expect(args.data).toMatchObject({
      accessToken: "at-new",
      refreshToken: "rt-new",
      scope: "read_orders,write_orders",
    });
    expect((args.data as { expires: Date }).expires).toBeInstanceOf(Date);
    expect(
      (args.data as { refreshTokenExpires: Date }).refreshTokenExpires,
    ).toBeInstanceOf(Date);
  });

  it("fails closed when the row was concurrently updated — no stale overwrite", async () => {
    const store = makeStore();
    // Simulate a concurrent SDK refresh/token-exchange: the row's stored
    // refreshToken has rotated, so the conditional update matches nothing.
    store.session.updateMany.mockResolvedValue({ count: 0 });
    const deps = createSessionMigrationDeps({
      prisma: store,
      apiKey: "K",
      apiSecret: "S",
      fetchImpl: fetchReturning(COMPLETE_REFRESH) as unknown as typeof fetch,
    });
    const target = t("shop1", "rt-observed");
    const material = await deps.refresh(target);

    await expect(deps.persist(target, material)).rejects.toThrow(
      "changed concurrently",
    );
    // The only write attempted was the conditional one — no unconditional
    // update path exists that could clobber the newer stored credentials.
    expect(store.session.updateMany).toHaveBeenCalledTimes(1);
  });

  it("reports a concurrent persist conflict as failed[persist] through migrateSessions", async () => {
    const store = makeStore();
    store.session.updateMany.mockResolvedValue({ count: 0 });
    const fetchImpl = fetchReturning(COMPLETE_REFRESH);
    const deps = createSessionMigrationDeps({
      prisma: {
        session: {
          ...store.session,
          findMany: vi.fn(async () => [t("shop1", "rt-observed")]),
        },
      },
      apiKey: "K",
      apiSecret: "S",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const results = await migrateSessions(deps, { delayMs: 0 });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("failed");
    expect(results[0].stage).toBe("persist");
    expect(results[0].error).toContain("changed concurrently");
  });
});
