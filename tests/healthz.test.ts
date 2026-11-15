// /healthz: the deploy healthcheck must answer 200 only when the DB pool
// answers SELECT 1 inside the bounded time, and 503 (never throwing) when
// it errors or hangs. It must not depend on Shopify auth or the worker.
import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loader } from "../app/routes/healthz";

const db = { mode: "ok" as "ok" | "reject" | "hang" };
vi.mock("../app/db.server", () => ({
  default: {
    $queryRaw: () => {
      if (db.mode === "reject") return Promise.reject(new Error("connection refused"));
      if (db.mode === "hang") return new Promise(() => {});
      return Promise.resolve([{ "?column?": 1 }]);
    },
  },
}));

const req = () => new Request("https://healthcheck.railway.app/healthz");

beforeEach(() => {
  db.mode = "ok";
  delete process.env.RAILWAY_GIT_COMMIT_SHA;
});
afterEach(() => vi.useRealTimers());

describe("healthz loader", () => {
  it("db ok -> 200 {ok:true,commit:<7-char sha or null>}", async () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "abcdef1234567890";
    const res = await loader({ request: req() } as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, commit: "abcdef1" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("db ok without the env sha -> commit null", async () => {
    const res = await loader({ request: req() } as any);
    expect(await res.json()).toEqual({ ok: true, commit: null });
  });

  it("db rejects -> 503 {ok:false}", async () => {
    db.mode = "reject";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await loader({ request: req() } as any);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[healthz] db check failed: connection refused"),
    );
    spy.mockRestore();
  });

  it("db hangs -> 503 inside ~3.5s (raced 3s timeout)", async () => {
    db.mode = "hang";
    vi.useFakeTimers();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const p = loader({ request: req() } as any);
    await vi.advanceTimersByTimeAsync(3_100);
    const res = await p;
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[healthz] db check failed: db check timed out"),
    );
    spy.mockRestore();
  });

  it("the route file carries no Shopify auth dependency", () => {
    const src = readFileSync(join(__dirname, "../app/routes/healthz.tsx"), "utf8");
    expect(src).not.toMatch(/import.*authenticate/);
    expect(src).not.toMatch(/shopify\.server/);
  });
});
