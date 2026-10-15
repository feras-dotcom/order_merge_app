// Phase 1.3 — destructive-test-database safety. These tests run entirely on
// FAKE clients (no Postgres connection, no writes): they prove the preflight
// and bootstrap refuse every unsafe target BEFORE a destructive statement
// could execute, and that the refusal paths never manufacture the marker.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  assertNoProductionEnvironment,
  bootstrapDisposableDatabase,
  DISPOSABLE_DB_NAME_PATTERN,
  isLocalOrPrivateAddress,
} from "../app/lib/shadow-db-bootstrap.server";
import {
  assertSafeTestDatabaseUrl,
  DisposablePreflightError,
  verifyDisposableConnection,
} from "./helpers/disposable-db";

const APP_TABLES = [
  "Session", "Settings", "AppControl", "ProcessedWebhook", "MergeClaim",
  "MergeRecord", "MergeOperation", "MergeOrderLock", "MergeMutationAttempt",
  "WorkerInstance", "ShippingAdjustment",
];

interface FakeCfg {
  db?: string;
  addr?: string | null;
  port?: number | null;
  marker?: string | null;
  schema?: string | null;
  appObjects?: { relname: string; nspname: string }[];
  userTables?: { nspname: string; relname: string }[];
  counts?: Record<string, number>;
  appControlRows?: any[];
}

/** Fake PrismaClient driven by fixtures; records every executed write. */
function fakeDb(cfg: FakeCfg) {
  const writes: string[] = [];
  const db: any = {
    $queryRaw: async (a: any, ..._vals: any[]) => {
      const sql: string =
        typeof a === "string" ? a : Array.isArray(a) ? a.join("?") : (a.sql ?? "");
      if (/current_database\(\) AS db/.test(sql)) {
        return [{ db: cfg.db ?? "mergeship_test_x", addr: cfg.addr ?? "127.0.0.1", port: cfg.port ?? 5432 }];
      }
      if (/shobj_description/.test(sql)) {
        // cfg.marker undefined → derive from a prior COMMENT write (the real
        // behavior); an explicit null means "no marker even after writes".
        const written = writes.find((w) => /COMMENT ON DATABASE/.test(w));
        const m =
          cfg.marker !== undefined
            ? cfg.marker
            : written
              ? (/IS '(.*)'/.exec(written)?.[1] ?? null)
              : null;
        return [{ marker: m, m }];
      }
      if (/current_schema/.test(sql)) return [{ s: cfg.schema ?? "public" }];
      if (/c\.relname, n\.nspname/.test(sql) && /ANY/.test(sql)) return cfg.appObjects ?? [];
      if (/WHERE c\.relkind = 'r'/.test(sql)) return cfg.userTables ?? [];
      if (/count\(\*\) AS n/.test(sql)) {
        const m = /FROM "([^"]+)"\."([^"]+)"/.exec(sql);
        return [{ n: BigInt(cfg.counts?.[`${m?.[1]}.${m?.[2]}`] ?? 0) }];
      }
      if (/FROM "([^"]+)"\."AppControl"/.test(sql)) {
        return cfg.appControlRows ?? [SEED_CONTROL_ROW];
      }
      throw new Error(`unmocked query: ${sql}`);
    },
    $queryRawUnsafe: async (sql: string) => {
      const m = /FROM "([^"]+)"\."([^"]+)"/.exec(sql);
      if (m && /count/.test(sql)) {
        return [{ n: BigInt(cfg.counts?.[`${m[1]}.${m[2]}`] ?? 0) }];
      }
      throw new Error(`unmocked unsafe: ${sql}`);
    },
    $executeRawUnsafe: async (sql: string) => {
      writes.push(sql);
      return 0;
    },
    $disconnect: async () => {},
  };
  return { db, writes };
}

const SEED_CONTROL_ROW = {
  id: "control",
  newMergesEnabled: false,
  completionEnabled: false,
  allowShops: [],
  shippingAdjustmentsEnabled: false,
  shippingAllowShops: [],
  shippingEnabledAt: null,
};

/** A healthy disposable database: all app tables in public, everything empty. */
const cleanDb = (): FakeCfg => ({
  appObjects: APP_TABLES.map((relname) => ({ relname, nspname: "public" })),
  userTables: [
    ...APP_TABLES.map((relname) => ({ nspname: "public", relname })),
    { nspname: "public", relname: "_prisma_migrations" },
  ],
  counts: { "public._prisma_migrations": 12 },
});

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of [
    "NODE_ENV",
    "RAILWAY_ENVIRONMENT",
    "RAILWAY_PROJECT_ID",
    "RAILWAY_SERVICE_NAME",
    "MERGESHIP_SHADOW_TOKEN",
  ]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("assertSafeTestDatabaseUrl", () => {
  it("accepts a strictly-named local test database", () => {
    expect(assertSafeTestDatabaseUrl("postgresql://u@localhost:5432/mergeship_test_x").dbName).toBe(
      "mergeship_test_x",
    );
    expect(assertSafeTestDatabaseUrl("postgres://u@127.0.0.1/mergeship_shadow_test").dbName).toBe(
      "mergeship_shadow_test",
    );
  });

  it("rejects Railway proxies, internal hosts and remote servers", () => {
    for (const host of ["abc.proxy.rlwy.net", "postgres.railway.internal", "10.0.0.5", "db.example.com"]) {
      expect(() => assertSafeTestDatabaseUrl(`postgresql://u@${host}/mergeship_test_x`)).toThrow(
        DisposablePreflightError,
      );
    }
  });

  it("rejects non-test database names (a Railway db is named 'railway')", () => {
    for (const name of ["railway", "production", "postgres", "test"]) {
      expect(() => assertSafeTestDatabaseUrl(`postgresql://u@localhost/${name}`)).toThrow(/database name/);
    }
    expect(DISPOSABLE_DB_NAME_PATTERN.test("mergeship_test_scratch_ab12")).toBe(true);
  });

  it("rejects non-postgres schemes and invalid URLs", () => {
    expect(() => assertSafeTestDatabaseUrl("mysql://localhost/mergeship_test")).toThrow(/scheme/);
    expect(() => assertSafeTestDatabaseUrl("not a url")).toThrow(DisposablePreflightError);
  });
});

describe("assertNoProductionEnvironment", () => {
  it("refuses NODE_ENV=production and Railway markers — tests may not clear them", () => {
    process.env.NODE_ENV = "production";
    expect(() => assertNoProductionEnvironment(process.env)).toThrow(/production/);
    process.env.NODE_ENV = "test";
    process.env.RAILWAY_PROJECT_ID = "x";
    expect(() => assertNoProductionEnvironment(process.env)).toThrow(/Railway/);
    delete process.env.RAILWAY_PROJECT_ID;
    process.env.RAILWAY_ENVIRONMENT = "production";
    expect(() => assertNoProductionEnvironment(process.env)).toThrow(/Railway/);
    delete process.env.RAILWAY_ENVIRONMENT;
    process.env.RAILWAY_SERVICE_NAME = "api"; // any RAILWAY_* key counts
    expect(() => assertNoProductionEnvironment(process.env)).toThrow(/Railway/);
  });
});

describe("isLocalOrPrivateAddress", () => {
  it("accepts loopback, unix and RFC1918; rejects public addresses", () => {
    for (const ok of [null, "127.0.0.1", "::1", "10.1.2.3", "172.17.0.2", "192.168.1.5", "fd00::1"]) {
      expect(isLocalOrPrivateAddress(ok)).toBe(true);
    }
    for (const bad of ["35.10.20.30", "8.8.8.8", "172.32.0.1", "169.254.1.1"]) {
      expect(isLocalOrPrivateAddress(bad)).toBe(false);
    }
  });
});

describe("verifyDisposableConnection", () => {
  const tokenEnv = () => {
    process.env.MERGESHIP_SHADOW_TOKEN = "operator-token-xyz";
    return "mergeship-shadow-disposable:operator-token-xyz";
  };

  it("accepts a marked database and returns the fingerprint", async () => {
    const marker = tokenEnv();
    const { db } = fakeDb({ marker });
    const res = await verifyDisposableConnection(db, "mergeship_test_x");
    expect(res.fingerprint).toBe("mergeship_test_x@127.0.0.1:5432");
  });

  it("refuses when the connected database differs from the URL", async () => {
    tokenEnv();
    const { db } = fakeDb({ db: "other_db", marker: "mergeship-shadow-disposable:operator-token-xyz" });
    await expect(verifyDisposableConnection(db, "mergeship_test_x")).rejects.toThrow(/does not match/);
  });

  it("refuses a publicly addressed server", async () => {
    tokenEnv();
    const { db } = fakeDb({ addr: "35.10.20.30", marker: "x" });
    await expect(verifyDisposableConnection(db, "mergeship_test_x")).rejects.toThrow(/not local or private/);
  });

  it("refuses without an operator token — a suite can never self-certify", async () => {
    const { db } = fakeDb({ marker: "mergeship-shadow-disposable:whatever" });
    await expect(verifyDisposableConnection(db, "mergeship_test_x")).rejects.toThrow(
      /MERGESHIP_SHADOW_TOKEN/,
    );
  });

  it("refuses a missing or mismatched marker", async () => {
    tokenEnv();
    const { db: unmarked } = fakeDb({ marker: null });
    await expect(verifyDisposableConnection(unmarked, "mergeship_test_x")).rejects.toThrow(/no disposable marker/);
    const { db: wrong } = fakeDb({ marker: "mergeship-shadow-disposable:other-token" });
    await expect(verifyDisposableConnection(wrong, "mergeship_test_x")).rejects.toThrow(/no disposable marker/);
  });
});

describe("bootstrapDisposableDatabase", () => {
  const opts = (over = {}) => ({
    token: "bootstrap-token-1",
    confirmDb: "mergeship_test_x@127.0.0.1:5432",
    disposableConfirmed: true,
    ...over,
  });

  it("marks a fully verified empty database and records exactly one write", async () => {
    const { db, writes } = fakeDb(cleanDb());
    const res = await bootstrapDisposableDatabase(db, opts());
    expect(res.fingerprint).toBe("mergeship_test_x@127.0.0.1:5432");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('COMMENT ON DATABASE "mergeship_test_x"');
  });

  it("refuses a wrong-name database before any confirmation", async () => {
    const { db, writes } = fakeDb({ db: "railway", ...cleanDb() });
    await expect(bootstrapDisposableDatabase(db, opts())).rejects.toThrow(/not a MergeShip test/);
    expect(writes).toHaveLength(0);
  });

  it("refuses a non-local server address", async () => {
    const { db, writes } = fakeDb({ addr: "35.10.20.30", ...cleanDb() });
    await expect(bootstrapDisposableDatabase(db, opts())).rejects.toThrow(/not local or private/);
    expect(writes).toHaveLength(0);
  });

  it("refuses a wrong fingerprint", async () => {
    const { db } = fakeDb(cleanDb());
    await expect(
      bootstrapDisposableDatabase(db, opts({ confirmDb: "prod@10.0.0.5:5432" })),
    ).rejects.toThrow(/confirm-db/);
  });

  it("refuses when expected app tables are missing — missing is never empty", async () => {
    const { db } = fakeDb({ ...cleanDb(), appObjects: [] });
    await expect(bootstrapDisposableDatabase(db, opts())).rejects.toThrow(/missing from schema/);
  });

  it("refuses when app tables live outside the connection schema", async () => {
    // app tables exist — but in a schema the unqualified queries do not use
    const { db } = fakeDb({
      ...cleanDb(),
      appObjects: APP_TABLES.map((relname) => ({ relname, nspname: "app" })),
    });
    await expect(bootstrapDisposableDatabase(db, opts())).rejects.toThrow(/missing from schema|outside schema/);
  });

  it("refuses a populated application table", async () => {
    const { db } = fakeDb({ ...cleanDb(), counts: { "public.Settings": 3 } });
    await expect(bootstrapDisposableDatabase(db, opts())).rejects.toThrow(/populated/);
  });

  it("refuses a populated table in a non-application schema", async () => {
    const { db } = fakeDb({
      ...cleanDb(),
      userTables: [
        ...APP_TABLES.map((relname) => ({ nspname: "public", relname })),
        { nspname: "otherapp", relname: "orders" },
      ],
      counts: { "otherapp.orders": 7 },
    });
    await expect(bootstrapDisposableDatabase(db, opts())).rejects.toThrow(/otherapp\.orders/);
  });

  it("refuses an AppControl row that is not exactly the migration seed", async () => {
    // an enabled kill switch is real operator state, not seed data
    const { db: enabled } = fakeDb({
      ...cleanDb(),
      appControlRows: [{ ...SEED_CONTROL_ROW, newMergesEnabled: true }],
    });
    await expect(bootstrapDisposableDatabase(enabled, opts())).rejects.toThrow(/AppControl/);
    // an extra row beside the seed is also real data
    const { db: extra } = fakeDb({
      ...cleanDb(),
      appControlRows: [SEED_CONTROL_ROW, { ...SEED_CONTROL_ROW, id: "other" }],
    });
    await expect(bootstrapDisposableDatabase(extra, opts())).rejects.toThrow(/AppControl/);
  });

  it("refuses an unnameable object instead of silently skipping it", async () => {
    const { db } = fakeDb({
      ...cleanDb(),
      userTables: [
        ...APP_TABLES.map((relname) => ({ nspname: "public", relname })),
        { nspname: "weird-name!", relname: "t" },
      ],
    });
    await expect(bootstrapDisposableDatabase(db, opts())).rejects.toThrow(/cannot verify emptiness/);
  });
});
