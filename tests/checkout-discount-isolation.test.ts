// Isolation guarantees for the checkout-discount subsystem:
//  1. Static import-graph: nothing in the existing engine may import
//     checkout-discount/ except the explicit allow-list (the sweep, which
//     only consumes it through the guarded step).
//  2. A throwing or absent checkoutWork must not stop any existing sweep
//     step.
//  3. With the gate off the sweep makes ZERO checkout Admin calls.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runSweepOnce, type SweepContext } from "../app/lib/background-worker.server";

const LIB = join(__dirname, "..", "app", "lib");
const ALLOWED_IMPORTERS = new Set(["background-worker.server.ts"]);

describe("import-graph isolation", () => {
  it("no existing engine module imports checkout-discount/ outside the allow-list", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "checkout-discount") walk(p);
        } else if (/\.(ts|tsx)$/.test(e.name)) {
          files.push(p);
        }
      }
    };
    walk(LIB);
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      if (ALLOWED_IMPORTERS.has(f.split(/[\\/]/).pop()!)) continue;
      const src = readFileSync(f, "utf8");
      const imports = src.match(/from\s+["'][^"']+["']|import\([^)]+\)|require\([^)]+\)/g) ?? [];
      for (const imp of imports) {
        expect(imp, `${f} must not import checkout-discount`).not.toMatch(/checkout-discount/);
      }
    }
  });

  it("the Function directory contains no app/server imports", () => {
    const dir = join(__dirname, "..", "functions", "checkout-shipping-discount", "src");
    for (const e of readdirSync(dir)) {
      if (!e.endsWith(".ts")) continue;
      const src = readFileSync(join(dir, e), "utf8");
      const imports = src.match(/from\s+["'][^"']+["']|import\s*\([^)]+\)|require\([^)]+\)/g) ?? [];
      for (const imp of imports) {
        expect(imp).not.toMatch(/app\/lib|\.server|shopify\.server/);
      }
    }
  });
});

// ── Sweep isolation ─────────────────────────────────────────────────────

const baseContext = (): { ctx: SweepContext; calls: string[] } => {
  const calls: string[] = [];
  const track = <T extends (...a: any[]) => any>(name: string, ret: any): T =>
    ((...a: any[]) => {
      calls.push(name);
      return typeof ret === "function" ? ret(...a) : ret;
    }) as T;
  const ctx: SweepContext = {
    claims: { reapExpired: track("claims.reapExpired", 0) } as any,
    journal: {} as any,
    ops: {
      heartbeat: track("ops.heartbeat", undefined),
      acquireOperationLease: track("ops.acquireOperationLease", null),
      purgeOldInstances: track("ops.purgeOldInstances", 0),
    } as any,
    work: {
      exhaustDue: track("work.exhaustDue", 0),
      claimDue: track("work.claimDue", []),
      purgeDone: track("work.purgeDone", 0),
    } as any,
    deps: { leaseTtlMs: 90_000 } as any,
    adminFactory: track("adminFactory", null),
    settings: async () => ({}) as any,
    now: () => new Date(),
  };
  return { ctx, calls };
};

describe("sweep isolation", () => {
  it("an ABSENT checkoutWork leaves every existing step running", async () => {
    const { ctx, calls } = baseContext();
    await runSweepOnce(ctx);
    for (const step of [
      "claims.reapExpired",
      "ops.heartbeat",
      "ops.acquireOperationLease",
      "work.exhaustDue",
      "work.claimDue",
      "work.purgeDone",
      "ops.purgeOldInstances",
    ]) {
      expect(calls, `missing ${step}`).toContain(step);
    }
  });

  it("a THROWING checkoutWork cannot stop the existing steps", async () => {
    const { ctx, calls } = baseContext();
    ctx.checkoutWork = {
      exhaustDue: async () => {
        throw new Error("checkout store exploded");
      },
      claimDue: async () => {
        throw new Error("checkout store exploded");
      },
      purgeDone: async () => {
        throw new Error("checkout store exploded");
      },
    } as any;
    await runSweepOnce(ctx);
    for (const step of ["work.exhaustDue", "work.claimDue", "work.purgeDone", "ops.purgeOldInstances"]) {
      expect(calls, `missing ${step}`).toContain(step);
    }
  });

  it("gate off: a due checkout item completes FEATURE_OFF with ZERO checkout Admin calls", async () => {
    const { ctx, calls } = baseContext();
    const completed: { outcome: unknown }[] = [];
    const item = {
      id: "cw1",
      shop: "s.myshopify.com",
      orderId: "gid://shopify/Order/1",
      gen: 1,
      status: "PENDING",
      attempts: 1,
      retryAfter: new Date(),
      leaseToken: "tok",
      leasedUntil: new Date(Date.now() + 60_000),
      outcome: null,
      lastReason: null,
      deadlineAt: null,
      doneAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    let claims = 0;
    ctx.checkoutWork = {
      exhaustDue: async () => 0,
      claimDue: async () => (claims++ === 0 ? [item] : []),
      renew: async () => {},
      scheduleRetry: async () => true,
      complete: async (id: string, token: string, gen: number, outcome: string) => {
        completed.push({ outcome });
        return "DONE";
      },
      purgeDone: async () => 0,
      find: async () => item,
    } as any;
    // Default gate deps hit the real DB — force the gate off explicitly by
    // stubbing the settings/control reads to refuse.
    process.env.MERGESHIP_CHECKOUT_DISCOUNT = "not-enabled";
    try {
      await runSweepOnce(ctx);
    } finally {
      delete process.env.MERGESHIP_CHECKOUT_DISCOUNT;
    }
    expect(completed.map((c) => c.outcome)).toEqual(["FEATURE_OFF"]);
    // adminFactory is never consulted for checkout work when gated off.
    expect(calls).not.toContain("adminFactory");
  });
});
