// Phase 1.3 / G-P0 — destructive-test-database safety. These tests run
// entirely on FAKE clients (no Postgres connection, no writes): they prove
// the preflight, the scratch-database gate and the provisioner refuse every
// unsafe target BEFORE a destructive statement could execute, that the
// refusal paths never manufacture the marker, and that credentials never
// reach logs or errors.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  PreflightedDatabase,
  preflightDisposableDatabase,
  urlWithDatabase,
  verifyDisposableConnection,
  withScratchDatabase,
} from "./helpers/disposable-db";
import {
  checkedDatabaseUrl,
  provisionDisposableTestDatabase,
  redactUrlPassword,
  scrubCredentials,
} from "../scripts/test-db-provision";

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
  exists?: boolean;
  schema?: string | null;
  appObjects?: { relname: string; nspname: string }[];
  userTables?: { nspname: string; relname: string }[];
  counts?: Record<string, number>;
  appControlRows?: any[];
}

/** Fake PrismaClient driven by fixtures; records every read and write. */
function fakeDb(cfg: FakeCfg, seq?: string[]) {
  const writes: string[] = [];
  const reads: string[] = [];
  const tag = (t: string) => seq?.push(t);
  const db: any = {
    $queryRaw: async (a: any, ..._vals: any[]) => {
      const sql: string =
        typeof a === "string" ? a : Array.isArray(a) ? a.join("?") : (a.sql ?? "");
      reads.push(sql);
      if (/current_database\(\) AS db/.test(sql)) {
        tag("q:identity");
        return [{ db: cfg.db ?? "mergeship_test_x", addr: cfg.addr ?? "127.0.0.1", port: cfg.port ?? 5432 }];
      }
      if (/EXISTS \(SELECT 1 FROM pg_database/.test(sql)) {
        tag("q:exists");
        return [{ e: cfg.exists ?? false }];
      }
      if (/shobj_description/.test(sql)) {
        tag("q:marker");
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
      if (/current_schema/.test(sql)) {
        tag("q:schema");
        return [{ s: cfg.schema ?? "public" }];
      }
      if (/c\.relname, n\.nspname/.test(sql) && /ANY/.test(sql)) {
        tag("q:appobjects");
        return cfg.appObjects ?? [];
      }
      if (/WHERE c\.relkind = 'r'/.test(sql)) {
        tag("q:usertables");
        return cfg.userTables ?? [];
      }
      if (/count\(\*\) AS n/.test(sql)) {
        tag("q:count");
        const m = /FROM "([^"]+)"\."([^"]+)"/.exec(sql);
        return [{ n: BigInt(cfg.counts?.[`${m?.[1]}.${m?.[2]}`] ?? 0) }];
      }
      if (/FROM "([^"]+)"\."AppControl"/.test(sql)) {
        tag("q:appcontrol");
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
      tag(`x:${sql.split(" ").slice(0, 2).join(" ")}`);
      return 0;
    },
    $disconnect: async () => {},
  };
  return { db, writes, reads };
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

  it("accepts a marked database, returns the fingerprint, and writes nothing", async () => {
    const marker = tokenEnv();
    const { db, writes } = fakeDb({ marker });
    const res = await verifyDisposableConnection(db, "mergeship_test_x");
    expect(res.fingerprint).toBe("mergeship_test_x@127.0.0.1:5432");
    expect(writes).toHaveLength(0);
  });

  it("refuses when the connected database differs from the URL", async () => {
    tokenEnv();
    const { db, writes } = fakeDb({ db: "other_db", marker: "mergeship-shadow-disposable:operator-token-xyz" });
    await expect(verifyDisposableConnection(db, "mergeship_test_x")).rejects.toThrow(/does not match/);
    expect(writes).toHaveLength(0);
  });

  it("refuses a publicly addressed server", async () => {
    tokenEnv();
    const { db, writes } = fakeDb({ addr: "35.10.20.30", marker: "x" });
    await expect(verifyDisposableConnection(db, "mergeship_test_x")).rejects.toThrow(/not local or private/);
    expect(writes).toHaveLength(0);
  });

  it("refuses without an operator token — a suite can never self-certify", async () => {
    const { db, writes } = fakeDb({ marker: "mergeship-shadow-disposable:whatever" });
    await expect(verifyDisposableConnection(db, "mergeship_test_x")).rejects.toThrow(
      /MERGESHIP_SHADOW_TOKEN/,
    );
    expect(writes).toHaveLength(0);
  });

  it("refuses a missing or mismatched marker and never stamps one itself", async () => {
    tokenEnv();
    const { db: unmarked, writes: w1 } = fakeDb({ marker: null });
    await expect(verifyDisposableConnection(unmarked, "mergeship_test_x")).rejects.toThrow(/no disposable marker/);
    expect(w1).toHaveLength(0);
    const { db: wrong, writes: w2 } = fakeDb({ marker: "mergeship-shadow-disposable:other-token" });
    await expect(verifyDisposableConnection(wrong, "mergeship_test_x")).rejects.toThrow(/no disposable marker/);
    expect(w2).toHaveLength(0);
  });

  it("cannot be tricked into self-marking: a fake that would echo a COMMENT write is still refused", async () => {
    // cfg.marker is deliberately undefined, so the fake reports whatever a
    // preceding COMMENT write created. If the verifier tried to stamp the
    // marker itself, the marker read would succeed — it must fail instead,
    // with zero writes.
    tokenEnv();
    const { db, writes } = fakeDb({});
    await expect(verifyDisposableConnection(db, "mergeship_test_x")).rejects.toThrow(
      /no disposable marker/,
    );
    expect(writes).toHaveLength(0);
  });
});

describe("preflightDisposableDatabase (branded result)", () => {
  const URL_OK = "postgresql://postgres:pw@localhost:55432/mergeship_test_x";

  const issue = (cfg: FakeCfg = {}, url = URL_OK) =>
    preflightDisposableDatabase(url, () => fakeDb(cfg).db);

  it("issues a brand only through the real preflight path", async () => {
    process.env.MERGESHIP_SHADOW_TOKEN = "operator-token-xyz";
    const brand = await issue({ marker: "mergeship-shadow-disposable:operator-token-xyz" });
    expect(brand).toBeInstanceOf(PreflightedDatabase);
    expect(brand.url).toBe(URL_OK);
    expect(brand.dbName).toBe("mergeship_test_x");
    expect(brand.addr).toBe("127.0.0.1");
    expect(brand.port).toBe(5432);
    expect(brand.fingerprint).toBe("mergeship_test_x@127.0.0.1:5432");
  });

  it("is read-only: a passing preflight performs zero writes", async () => {
    process.env.MERGESHIP_SHADOW_TOKEN = "operator-token-xyz";
    const { db, writes } = fakeDb({ marker: "mergeship-shadow-disposable:operator-token-xyz" });
    await preflightDisposableDatabase(URL_OK, () => db);
    expect(writes).toHaveLength(0);
  });

  it("a hand-built brand object and a bare URL are not proof of preflight", async () => {
    const connects: string[] = [];
    const connect = (u: string) => {
      connects.push(u);
      return fakeDb({}).db;
    };
    for (const fake of [
      "postgresql://postgres@localhost/mergeship_test_x", // bare URL
      { url: URL_OK, dbName: "mergeship_test_x" }, // plain object
      Object.create(PreflightedDatabase.prototype), // forged instance shape
    ]) {
      await expect(
        withScratchDatabase(fake as any, async () => "never", connect),
      ).rejects.toThrow(DisposablePreflightError);
    }
    expect(connects).toHaveLength(0); // refused before opening a connection
  });

  it("the brand constructor cannot be invoked outside the module", () => {
    expect(
      () => new PreflightedDatabase(Symbol("forged"), URL_OK, "mergeship_test_x", "127.0.0.1", 5432),
    ).toThrow(DisposablePreflightError);
  });
});

describe("withScratchDatabase (LOW-4)", () => {
  const URL_OK = "postgresql://postgres:pw@localhost:55432/mergeship_test_x";
  const MARKER_OK = "mergeship-shadow-disposable:operator-token-xyz";

  const issueBrand = () =>
    preflightDisposableDatabase(URL_OK, () => fakeDb({ marker: MARKER_OK }).db);

  const scratch = async (
    brand: unknown,
    maintCfg: FakeCfg = {},
    fn: (url: string, name: string) => Promise<unknown> = async () => "ok",
  ) => {
    const seq: string[] = [];
    const connects: string[] = [];
    const maintenance = fakeDb({ db: "postgres", marker: MARKER_OK, ...maintCfg }, seq);
    const connect = (u: string) => {
      connects.push(u);
      seq.push("connect");
      return maintenance.db;
    };
    const result = await withScratchDatabase(brand as PreflightedDatabase, fn, connect);
    return { result, seq, connects, writes: maintenance.writes };
  };

  it("creates a scratch database on the verified server and drops it, in order", async () => {
    process.env.MERGESHIP_SHADOW_TOKEN = "operator-token-xyz";
    const brand = await issueBrand();
    let seen: { url: string; name: string } | null = null;
    const { seq, connects, writes } = await scratch(brand, {}, async (url, name) => {
      seen = { url, name };
      // The constructed target URL is itself a validated test-database URL.
      expect(() => assertSafeTestDatabaseUrl(url)).not.toThrow();
      expect(new URL(url).hostname).toBe("localhost");
      return "done";
    });
    expect(seen!.name).toMatch(/^mergeship_test_scratch_[0-9a-f]{10}$/);
    expect(connects).toEqual(["postgresql://postgres:pw@localhost:55432/postgres"]);
    // identity → marker recheck → CREATE → fn → DROP
    expect(seq).toEqual([
      "connect",
      "q:identity",
      "q:marker",
      'x:CREATE DATABASE',
      'x:DROP DATABASE',
    ]);
    expect(writes).toEqual([
      'CREATE DATABASE "' + seen!.name + '"',
      'DROP DATABASE "' + seen!.name + '" WITH (FORCE)',
    ]);
  });

  it("refuses a maintenance connection on a different database, address or port", async () => {
    process.env.MERGESHIP_SHADOW_TOKEN = "operator-token-xyz";
    const brand = await issueBrand();
    for (const cfg of [
      { db: "mergeship_test_x" }, // right server, wrong database
      { addr: "10.0.0.9" }, // private but NOT the verified server address
      { port: 5433 }, // different port — a different endpoint
      { addr: "35.10.20.30" }, // public address
    ]) {
      const seq: string[] = [];
      const maintenance = fakeDb({ db: "postgres", marker: MARKER_OK, ...cfg }, seq);
      const connects: string[] = [];
      await expect(
        withScratchDatabase(brand, async () => "never", (u) => {
          connects.push(u);
          return maintenance.db;
        }),
      ).rejects.toThrow(DisposablePreflightError);
      expect(maintenance.writes).toHaveLength(0); // refused before CREATE
      expect(seq.filter((t) => t.startsWith("x:"))).toHaveLength(0);
    }
  });

  it("re-verifies the base database marker and refuses a missing or forged one", async () => {
    process.env.MERGESHIP_SHADOW_TOKEN = "operator-token-xyz";
    const brand = await issueBrand();
    for (const marker of [null, "mergeship-shadow-disposable:forged-token", "some-other-comment"]) {
      const seq: string[] = [];
      const maintenance = fakeDb({ db: "postgres", marker }, seq);
      await expect(
        withScratchDatabase(brand, async () => "never", () => maintenance.db),
      ).rejects.toThrow(/no disposable marker/);
      expect(maintenance.writes).toHaveLength(0);
    }
  });

  it("still drops the scratch database when the callback throws", async () => {
    process.env.MERGESHIP_SHADOW_TOKEN = "operator-token-xyz";
    const brand = await issueBrand();
    const seq: string[] = [];
    const maintenance = fakeDb({ db: "postgres", marker: MARKER_OK }, seq);
    await expect(
      withScratchDatabase(
        brand,
        async () => {
          throw new Error("boom");
        },
        () => maintenance.db,
      ),
    ).rejects.toThrow("boom");
    expect(maintenance.writes).toHaveLength(2);
    expect(maintenance.writes[1]).toMatch(/^DROP DATABASE/);
  });

  it("refuses under production environment markers before connecting", async () => {
    process.env.MERGESHIP_SHADOW_TOKEN = "operator-token-xyz";
    const brand = await issueBrand();
    process.env.RAILWAY_PROJECT_ID = "proj";
    const connects: string[] = [];
    await expect(
      withScratchDatabase(brand, async () => "never", (u) => {
        connects.push(u);
        return fakeDb({}).db;
      }),
    ).rejects.toThrow(/Railway/);
    expect(connects).toHaveLength(0);
  });
});

describe("urlWithDatabase / checkedDatabaseUrl (LOW-3)", () => {
  it("retargets a URL by pathname, preserving userinfo, port and query", () => {
    const built = urlWithDatabase(
      "postgresql://postgres:pw@localhost:55432/postgres?connect_timeout=5",
      "mergeship_test_x",
    );
    expect(built).toBe(
      "postgresql://postgres:pw@localhost:55432/mergeship_test_x?connect_timeout=5",
    );
    const u = new URL(built);
    expect(u.password).toBe("pw");
    expect(u.port).toBe("55432");
  });

  it("every constructed target URL is revalidated by assertSafeTestDatabaseUrl", () => {
    const base = "postgresql://postgres:pw@localhost:55432/postgres";
    expect(() =>
      assertSafeTestDatabaseUrl(urlWithDatabase(base, "mergeship_test_x")),
    ).not.toThrow();
    // a maintenance or production name must never pass as a test target
    expect(() =>
      assertSafeTestDatabaseUrl(urlWithDatabase(base, "postgres")),
    ).toThrow(DisposablePreflightError);
    expect(() =>
      assertSafeTestDatabaseUrl(urlWithDatabase(base, "railway")),
    ).toThrow(DisposablePreflightError);
  });

  it("checkedDatabaseUrl revalidates and refuses non-test targets", () => {
    const base = "postgresql://postgres:pw@localhost:55432/postgres";
    expect(checkedDatabaseUrl(base, "mergeship_test_x")).toBe(
      "postgresql://postgres:pw@localhost:55432/mergeship_test_x",
    );
    expect(() => checkedDatabaseUrl(base, "postgres")).toThrow(/revalidation|database name/);
    expect(() => checkedDatabaseUrl(base, 'evil"name')).toThrow(/identifier/);
  });
});

describe("provisionDisposableTestDatabase (LOW-1, LOW-2)", () => {
  const SERVER = "postgresql://postgres:s3cret-pw@localhost:55432/postgres";
  const FP = "mergeship_test_x@127.0.0.1:5432";
  const ARGS = {
    serverUrl: SERVER,
    dbName: "mergeship_test_x",
    token: "operator-token-xyz",
    confirmDb: FP,
  };

  function harness(cfg: FakeCfg = {}) {
    const seq: string[] = [];
    const logs: string[] = [];
    const maintenance = fakeDb({ db: "postgres", ...cfg }, seq);
    const calls: { migrate?: string; mark?: string; connects: string[] } = { connects: [] };
    const deps = {
      connectMaintenance: (u: string) => {
        calls.connects.push(u);
        seq.push("connect");
        return maintenance.db;
      },
      runMigrations: (dbUrl: string) => {
        calls.migrate = dbUrl;
        seq.push("migrate");
      },
      markDisposable: async (dbUrl: string) => {
        calls.mark = dbUrl;
        seq.push("mark");
        return { fingerprint: FP };
      },
      log: (line: string) => logs.push(line),
    };
    return { seq, logs, calls, maintenance, deps };
  }

  it("refuses an EXISTING database before CREATE, migrate deploy or the marker write", async () => {
    const { seq, calls, maintenance, deps } = harness({ exists: true });
    await expect(provisionDisposableTestDatabase({ ...ARGS }, deps)).rejects.toThrow(
      /already exists/,
    );
    // The existence check ran, then nothing else: no CREATE, no migration,
    // no marker — an existing database is never migrated by this workflow.
    expect(seq).toEqual(["connect", "q:identity", "q:exists"]);
    expect(maintenance.writes).toHaveLength(0);
    expect(calls.migrate).toBeUndefined();
    expect(calls.mark).toBeUndefined();
  });

  it("creates → migrates → marks, in that order, on a fresh database", async () => {
    const { seq, calls, maintenance, deps } = harness({ exists: false });
    const res = await provisionDisposableTestDatabase({ ...ARGS }, deps);
    expect(res).toEqual({ created: true, fingerprint: FP });
    expect(seq).toEqual([
      "connect",
      "q:identity",
      "q:exists",
      'x:CREATE DATABASE',
      "migrate",
      "mark",
    ]);
    expect(maintenance.writes).toEqual(['CREATE DATABASE "mergeship_test_x"']);
    const expectedUrl = "postgresql://postgres:s3cret-pw@localhost:55432/mergeship_test_x";
    expect(calls.migrate).toBe(expectedUrl);
    expect(calls.mark).toBe(expectedUrl);
  });

  it("prints only the fingerprint without --confirm-db and writes nothing", async () => {
    const { seq, logs, calls, maintenance, deps } = harness();
    const res = await provisionDisposableTestDatabase(
      { serverUrl: ARGS.serverUrl, dbName: ARGS.dbName, token: ARGS.token },
      deps,
    );
    expect(res).toEqual({ created: false, fingerprint: FP });
    expect(logs.join("\n")).toContain(FP);
    expect(seq).toEqual(["connect", "q:identity"]);
    expect(maintenance.writes).toHaveLength(0);
    expect(calls.migrate).toBeUndefined();
  });

  it("refuses a mismatched --confirm-db before the existence check", async () => {
    const { seq, calls, maintenance, deps } = harness({ exists: true });
    await expect(
      provisionDisposableTestDatabase({ ...ARGS, confirmDb: "prod@10.0.0.5:5432" }, deps),
    ).rejects.toThrow(/confirm-db/);
    expect(seq).toEqual(["connect", "q:identity"]); // exists check never ran
    expect(maintenance.writes).toHaveLength(0);
    expect(calls.migrate).toBeUndefined();
  });

  it("refuses a non-loopback server, a bad scheme, a non-test name and a missing token before connecting", async () => {
    for (const badArgs of [
      { ...ARGS, serverUrl: "postgresql://u:p@db.example.com/postgres" },
      { ...ARGS, serverUrl: "mysql://localhost/postgres" },
      { ...ARGS, dbName: "railway" },
      { ...ARGS, token: undefined },
      { ...ARGS, token: "short" },
    ]) {
      const { calls, maintenance, deps } = harness();
      await expect(provisionDisposableTestDatabase(badArgs as any, deps)).rejects.toThrow();
      expect(calls.connects).toHaveLength(0);
      expect(maintenance.writes).toHaveLength(0);
      expect(calls.migrate).toBeUndefined();
    }
  });

  it("refuses under production environment markers before connecting", async () => {
    process.env.NODE_ENV = "production";
    const { calls, deps } = harness();
    await expect(provisionDisposableTestDatabase({ ...ARGS }, deps)).rejects.toThrow(/production/);
    expect(calls.connects).toHaveLength(0);
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
    process.env.RAILWAY_ENVIRONMENT = "production";
    await expect(provisionDisposableTestDatabase({ ...ARGS }, deps)).rejects.toThrow(/Railway/);
    expect(calls.connects).toHaveLength(0);
  });

  it("refuses a publicly addressed live server", async () => {
    const { calls, maintenance, deps } = harness({ addr: "35.10.20.30" });
    await expect(provisionDisposableTestDatabase({ ...ARGS }, deps)).rejects.toThrow(
      /not local or private/,
    );
    expect(maintenance.writes).toHaveLength(0);
    expect(calls.migrate).toBeUndefined();
  });

  it("never prints or errors the URL password (LOW-2)", async () => {
    const { logs, deps } = harness({ exists: false });
    await provisionDisposableTestDatabase({ ...ARGS }, deps);
    const out = logs.join("\n");
    expect(out).not.toContain("s3cret-pw");
    expect(out).toContain("postgresql://postgres@localhost:55432/mergeship_test_x");
    // A refusal path errors without credentials too.
    const { deps: deps2, maintenance } = harness({ exists: true });
    const refusal: unknown = await provisionDisposableTestDatabase(
      { ...ARGS },
      deps2,
    ).catch((e) => e);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).not.toContain("s3cret-pw");
    expect(maintenance.writes).toHaveLength(0);
  });

  it("redactUrlPassword clears only the password, scrubCredentials strips raw and encoded forms", () => {
    expect(redactUrlPassword(SERVER)).toBe("postgresql://postgres@localhost:55432/postgres");
    expect(
      scrubCredentials(
        "connect failed postgresql://postgres:s3cret-pw@localhost:55432/postgres s3cret-pw",
        [SERVER],
      ),
    ).toBe(
      "connect failed postgresql://postgres:<redacted>@localhost:55432/postgres <redacted>",
    );
    const encoded = "postgresql://u:p%40ssw%3Ard@localhost/db";
    expect(scrubCredentials("boom p@ssw:rd here", [encoded])).toBe("boom <redacted> here");
  });
});

describe("suite-level safety regressions", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const suites = [
    "tests/postgres-stores.test.ts",
    "tests/shipping-shadow-pg.test.ts",
    "tests/two-process.test.ts",
  ];

  it("every destructive suite runs preflightDisposableDatabase BEFORE its first migration, TRUNCATE or write", () => {
    for (const file of suites) {
      const src = fs.readFileSync(path.join(root, file), "utf8");
      const preflight = src.indexOf("preflightDisposableDatabase(");
      expect(preflight, `${file} must call the preflight`).toBeGreaterThan(-1);
      // The first destructive *call* — not comment mentions of migrations —
      // must come after the preflight call.
      for (const destructive of ["execSync(", "$executeRawUnsafe"]) {
        const at = src.indexOf(destructive);
        if (at === -1) continue;
        expect(
          preflight,
          `${file}: preflight must precede the first ${destructive} call`,
        ).toBeLessThan(at);
      }
    }
  });

  it("no test suite can stamp the disposable marker — the SQL exists only in the app bootstrap", () => {
    // The marker write is COMMENT ON DATABASE ... 'mergeship-shadow-disposable:'.
    // If a suite could run it, the marker would stop being proof.
    const dir = path.join(root, "tests");
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") && e.name !== "disposable-db.test.ts") {
          if (/COMMENT ON DATABASE/.test(fs.readFileSync(p, "utf8"))) offenders.push(p);
        }
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
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

  it("refuses a wrong fingerprint before writing", async () => {
    const { db, writes } = fakeDb(cleanDb());
    await expect(
      bootstrapDisposableDatabase(db, opts({ confirmDb: "prod@10.0.0.5:5432" })),
    ).rejects.toThrow(/confirm-db/);
    expect(writes).toHaveLength(0);
  });

  it("refuses when expected app tables are missing — missing is never empty", async () => {
    const { db, writes } = fakeDb({ ...cleanDb(), appObjects: [] });
    await expect(bootstrapDisposableDatabase(db, opts())).rejects.toThrow(/missing from schema/);
    expect(writes).toHaveLength(0);
  });

  it("refuses when every app table is outside the connection schema (missing branch)", async () => {
    // app tables exist — but in a schema the unqualified queries do not use
    const { db, writes } = fakeDb({
      ...cleanDb(),
      appObjects: APP_TABLES.map((relname) => ({ relname, nspname: "app" })),
    });
    await expect(bootstrapDisposableDatabase(db, opts())).rejects.toThrow(/missing from schema/);
    expect(writes).toHaveLength(0);
  });

  it("refuses when app tables are duplicated outside the connection schema (misplaced branch)", async () => {
    // All app tables are present in the resolved schema AND a same-named
    // table also lives in another schema — the misplaced-tables refusal.
    const { db, writes } = fakeDb({
      ...cleanDb(),
      appObjects: [
        ...APP_TABLES.map((relname) => ({ relname, nspname: "public" })),
        { relname: "Settings", nspname: "shadow" },
        { relname: "MergeOperation", nspname: "shadow" },
      ],
    });
    await expect(bootstrapDisposableDatabase(db, opts())).rejects.toThrow(
      /outside schema 'public'.*shadow\.(Settings|MergeOperation)/,
    );
    expect(writes).toHaveLength(0);
  });

  it("refuses a populated application table", async () => {
    const { db, writes } = fakeDb({ ...cleanDb(), counts: { "public.Settings": 3 } });
    await expect(bootstrapDisposableDatabase(db, opts())).rejects.toThrow(/populated/);
    expect(writes).toHaveLength(0);
  });

  it("refuses a populated table in a non-application schema", async () => {
    const { db, writes } = fakeDb({
      ...cleanDb(),
      userTables: [
        ...APP_TABLES.map((relname) => ({ nspname: "public", relname })),
        { nspname: "otherapp", relname: "orders" },
      ],
      counts: { "otherapp.orders": 7 },
    });
    await expect(bootstrapDisposableDatabase(db, opts())).rejects.toThrow(/otherapp\.orders/);
    expect(writes).toHaveLength(0);
  });

  it("refuses an AppControl row that is not exactly the migration seed", async () => {
    // an enabled kill switch is real operator state, not seed data
    const { db: enabled, writes: w1 } = fakeDb({
      ...cleanDb(),
      appControlRows: [{ ...SEED_CONTROL_ROW, newMergesEnabled: true }],
    });
    await expect(bootstrapDisposableDatabase(enabled, opts())).rejects.toThrow(/AppControl/);
    expect(w1).toHaveLength(0);
    // an extra row beside the seed is also real data
    const { db: extra, writes: w2 } = fakeDb({
      ...cleanDb(),
      appControlRows: [SEED_CONTROL_ROW, { ...SEED_CONTROL_ROW, id: "other" }],
    });
    await expect(bootstrapDisposableDatabase(extra, opts())).rejects.toThrow(/AppControl/);
    expect(w2).toHaveLength(0);
  });

  it("refuses an unnameable object instead of silently skipping it", async () => {
    const { db, writes } = fakeDb({
      ...cleanDb(),
      userTables: [
        ...APP_TABLES.map((relname) => ({ nspname: "public", relname })),
        { nspname: "weird-name!", relname: "t" },
      ],
    });
    await expect(bootstrapDisposableDatabase(db, opts())).rejects.toThrow(/cannot verify emptiness/);
    expect(writes).toHaveLength(0);
  });
});
