// Phase 1.3 / G-P0 — destructive-test-database safety. These tests run
// entirely on FAKE clients (no Postgres connection, no writes): they prove
// the preflight, the scratch-database gate and the provisioner refuse every
// unsafe target BEFORE a destructive statement could execute, that the
// refusal paths never manufacture the marker, and that credentials never
// reach logs or errors.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  assertNoProductionEnvironment,
  BootstrapNotAllowedError,
  bootstrapDisposableDatabase,
  DISPOSABLE_DB_NAME_PATTERN,
  isLocalOrPrivateAddress,
} from "../app/lib/shadow-db-bootstrap.server";
import {
  assertLoopbackServerUrl,
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
  migrateDeploySanitized,
  provisionDisposableTestDatabase,
  redactUrlPassword,
  scrubCredentials,
} from "../scripts/test-db-provision.impl";

const APP_TABLES = [
  "Session", "Settings", "AppControl", "ProcessedWebhook", "MergeClaim",
  "MergeRecord", "MergeOperation", "MergeOrderLock", "MergeMutationAttempt",
  "WorkerInstance", "ShippingAdjustment",
];

interface FakeCfg {
  db?: string;
  addr?: string | null;
  port?: number | null;
  /** oid reported for the queried database; `null` simulates "not found". */
  oid?: bigint | null;
  marker?: string | null;
  exists?: boolean;
  /** When set, $executeRawUnsafe throws this after recording the write. */
  failWrite?: RegExp;
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
      if (/oid::bigint FROM pg_database/.test(sql)) {
        tag("q:oidident");
        return [
          {
            db: cfg.db ?? "mergeship_test_x",
            addr: cfg.addr ?? "127.0.0.1",
            port: cfg.port ?? 5432,
            oid: cfg.oid === undefined ? BigInt(4242) : cfg.oid,
          },
        ];
      }
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
      if (cfg.failWrite && cfg.failWrite.test(sql)) {
        throw new Error(`write failed: ${sql.split(" ").slice(0, 3).join(" ")}`);
      }
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

  it("strict IPv4: out-of-range octets, short forms and 127.* DNS names are refused", () => {
    // Invalid IPv4 must not fall through to DNS resolution.
    for (const host of [
      "127.999.0.1",
      "127.256.0.1",
      "127.0.0.256",
      "127.1", // short form — not a dotted quad
      "127.0.0.1.attacker.example", // DNS name that merely begins with 127.
      "128.0.0.1",
      "localhost.evil.com",
      "localhost.", // trailing dot resolves anywhere
      "localhost%2eevil.com", // encoded dot in an opaque host
      "[::ffff:7f00:1]", // IPv4-mapped IPv6 is not [::1]
      "[::2]",
    ]) {
      expect(() => assertSafeTestDatabaseUrl(`postgresql://u@${host}/mergeship_test_x`)).toThrow(
        DisposablePreflightError,
      );
    }
    for (const host of ["127.0.0.1", "127.0.0.0", "127.255.255.255", "[::1]", "[0:0:0:0:0:0:0:1]", "LOCALHOST"]) {
      expect(assertSafeTestDatabaseUrl(`postgresql://u@${host}/mergeship_test_x`).dbName).toBe(
        "mergeship_test_x",
      );
    }
  });

  it("refuses query strings and fragments — connection overrides can redirect the endpoint", () => {
    for (const tail of [
      "?host=prod.example.com",
      "?host=/var/run/postgresql/",
      "?host=10.0.0.5&port=6543",
      "?schema=public",
      "?connect_timeout=5",
      "?sslmode=disable",
      "#frag",
      "?host=prod.example.com#frag",
    ]) {
      expect(() =>
        assertSafeTestDatabaseUrl(`postgresql://u@localhost:5432/mergeship_test_x${tail}`),
      ).toThrow(DisposablePreflightError);
      // the same policy applies to any URL, including a maintenance URL
      expect(() =>
        assertLoopbackServerUrl(`postgresql://u@localhost:5432/postgres${tail}`),
      ).toThrow(DisposablePreflightError);
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

  it("a hand-built, self-constructed or forged brand and a bare URL are not proof of preflight", async () => {
    const connects: string[] = [];
    const connect = (u: string) => {
      connects.push(u);
      return fakeDb({}).db;
    };
    for (const fake of [
      "postgresql://postgres@localhost/mergeship_test_x", // bare URL
      { url: URL_OK, dbName: "mergeship_test_x" }, // plain object
      Object.create(PreflightedDatabase.prototype), // forged instance shape
      // a real instance, constructed outside the module: correct class, no
      // registry entry — membership, not shape, is the credential
      new PreflightedDatabase(URL_OK, "mergeship_test_x", "127.0.0.1", 5432),
    ]) {
      await expect(
        withScratchDatabase(fake as any, async () => "never", connect),
      ).rejects.toThrow(DisposablePreflightError);
    }
    expect(connects).toHaveLength(0); // refused before opening a connection
  });

  it("the brand exposes no forgery credential and cannot be mutated", async () => {
    process.env.MERGESHIP_SHADOW_TOKEN = "operator-token-xyz";
    const brand = await issue({ marker: "mergeship-shadow-disposable:operator-token-xyz" });
    // No hidden symbol property exists to steal — nothing enumerates.
    expect(Object.getOwnPropertySymbols(brand)).toEqual([]);
    expect(Object.isFrozen(brand)).toBe(true);
    // Mutation attempts cannot take: the object is frozen AND authorization
    // reads only the private registry entry.
    expect(Reflect.set(brand, "url", "postgresql://u@localhost:6001/mergeship_test_z")).toBe(false);
    expect(Reflect.set(brand, "dbName", "mergeship_test_z")).toBe(false);
    expect(Reflect.set(brand, "port", 6001)).toBe(false);
    expect(Reflect.defineProperty(brand, "evil", { value: true })).toBe(false);
    expect(brand.url).toBe(URL_OK);
    // The legitimate brand still authorizes — against the ORIGINAL endpoint.
    const seq: string[] = [];
    const connects: string[] = [];
    const maintenance = fakeDb({ db: "postgres", marker: "mergeship-shadow-disposable:operator-token-xyz" }, seq);
    const out = await withScratchDatabase(brand, async (_u, name) => name, (u) => {
      connects.push(u);
      return maintenance.db;
    });
    expect(out).toMatch(/^mergeship_test_scratch_[0-9a-f]{10}$/);
    expect(connects).toEqual(["postgresql://postgres:pw@localhost:55432/postgres"]);
    expect(maintenance.writes[0]).toMatch(/^CREATE DATABASE/);
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

  it("a failed CREATE never issues DROP — an existing database is never destroyed", async () => {
    process.env.MERGESHIP_SHADOW_TOKEN = "operator-token-xyz";
    const brand = await issueBrand();
    const maintenance = fakeDb({
      db: "postgres",
      marker: MARKER_OK,
      failWrite: /^CREATE DATABASE/,
    });
    await expect(
      withScratchDatabase(brand, async () => "never", () => maintenance.db),
    ).rejects.toThrow(/write failed/);
    // The only write attempted is the failed CREATE — no DROP may follow.
    expect(maintenance.writes).toHaveLength(1);
    expect(maintenance.writes[0]).toMatch(/^CREATE DATABASE/);
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
  it("retargets a URL by pathname, preserving userinfo and port", () => {
    const built = urlWithDatabase(
      "postgresql://postgres:pw@localhost:55432/postgres",
      "mergeship_test_x",
    );
    expect(built).toBe("postgresql://postgres:pw@localhost:55432/mergeship_test_x");
    const u = new URL(built);
    expect(u.password).toBe("pw");
    expect(u.port).toBe("55432");
  });

  it("a query-bearing base produces a URL that fails revalidation", () => {
    // urlWithDatabase faithfully preserves the tail — which is exactly why
    // every constructed URL must be revalidated before use: query strings
    // (connection overrides) are never allowed.
    const built = urlWithDatabase(
      "postgresql://postgres:pw@localhost:55432/postgres?host=evil.example",
      "mergeship_test_x",
    );
    expect(() => assertSafeTestDatabaseUrl(built)).toThrow(DisposablePreflightError);
    expect(() => checkedDatabaseUrl(
      "postgresql://postgres:pw@localhost:55432/postgres?host=evil.example",
      "mergeship_test_x",
    )).toThrow(/revalidation/);
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

  function harness(cfg: FakeCfg = {}, targetCfg: FakeCfg = {}) {
    const seq: string[] = [];
    const logs: string[] = [];
    const maintenance = fakeDb({ db: "postgres", ...cfg }, seq);
    // The migration-target connection: same server identity and oid as the
    // maintenance connection reports for the freshly created database.
    const target = fakeDb(
      {
        db: "mergeship_test_x",
        addr: cfg.addr ?? "127.0.0.1",
        port: cfg.port ?? 5432,
        oid: cfg.oid === undefined ? BigInt(4242) : cfg.oid,
        ...targetCfg,
      },
      seq,
    );
    const calls: { migrate?: string; mark?: string; connects: string[]; targetConnects: string[] } = {
      connects: [],
      targetConnects: [],
    };
    const deps = {
      connectMaintenance: (u: string) => {
        calls.connects.push(u);
        seq.push("connect");
        return maintenance.db;
      },
      connectTarget: (u: string) => {
        calls.targetConnects.push(u);
        seq.push("connect-target");
        return target.db;
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
    return { seq, logs, calls, maintenance, target, deps };
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

  it("creates → proves target identity → migrates → marks, in that order", async () => {
    const { seq, calls, maintenance, deps } = harness({ exists: false });
    const res = await provisionDisposableTestDatabase({ ...ARGS }, deps);
    expect(res).toEqual({ created: true, fingerprint: FP });
    expect(seq).toEqual([
      "connect",
      "q:identity",
      "q:exists",
      'x:CREATE DATABASE',
      "q:oidident",
      "connect-target",
      "q:oidident",
      "migrate",
      "mark",
    ]);
    expect(maintenance.writes).toEqual(['CREATE DATABASE "mergeship_test_x"']);
    const expectedUrl = "postgresql://postgres:s3cret-pw@localhost:55432/mergeship_test_x";
    expect(calls.targetConnects).toEqual([expectedUrl]);
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

  it("refuses loopback-lookalike hosts and query overrides BEFORE any connection — zero writes (M-1/M-2)", async () => {
    for (const serverUrl of [
      "postgresql://u@127.0.0.1.attacker.example:5432/postgres", // 127.* DNS name
      "postgresql://u@127.999.0.1:5432/postgres", // invalid octets → DNS
      "postgresql://u@127.1:5432/postgres", // short-form loopback
      "postgresql://u@localhost:5432/postgres?host=prod.example.com", // connection override
      "postgresql://u@localhost:5432/postgres?connect_timeout=5", // even benign params
      "postgresql://u@localhost:5432/postgres#frag",
    ]) {
      const { calls, maintenance, deps } = harness();
      await expect(
        provisionDisposableTestDatabase({ ...ARGS, serverUrl }, deps),
      ).rejects.toThrow(BootstrapNotAllowedError);
      // Refused before opening ANY connection — no CREATE can have happened.
      expect(calls.connects).toHaveLength(0);
      expect(calls.targetConnects).toHaveLength(0);
      expect(maintenance.writes).toHaveLength(0);
      expect(calls.migrate).toBeUndefined();
      expect(calls.mark).toBeUndefined();
    }
  });

  it("fails closed when the migration target is not the database just created (L-4)", async () => {
    // oid differs → a different cluster answered the second connection
    for (const targetCfg of [
      { oid: BigInt(9999) },
      { addr: "10.0.0.9" },
      { port: 5433 },
      { db: "postgres" }, // connected to the wrong database
      { db: "mergeship_test_x", oid: null }, // database absent on this server
      { addr: "35.10.20.30" }, // public address
    ]) {
      const { calls, maintenance, deps } = harness({ exists: false }, targetCfg);
      await expect(provisionDisposableTestDatabase({ ...ARGS }, deps)).rejects.toThrow(
        BootstrapNotAllowedError,
      );
      // CREATE ran; migration and marker must never follow a failed proof.
      expect(maintenance.writes).toEqual(['CREATE DATABASE "mergeship_test_x"']);
      expect(calls.migrate).toBeUndefined();
      expect(calls.mark).toBeUndefined();
    }
  });

  it("a CREATE DATABASE failure (concurrent creation race) aborts before migrate and mark", async () => {
    const { calls, deps } = harness({ exists: false, failWrite: /^CREATE DATABASE/ });
    await expect(provisionDisposableTestDatabase({ ...ARGS }, deps)).rejects.toThrow(
      /write failed/,
    );
    expect(calls.migrate).toBeUndefined();
    expect(calls.mark).toBeUndefined();
  });

  it("a migrate deploy failure never writes the disposable marker", async () => {
    const { calls, deps } = harness({ exists: false });
    deps.runMigrations = () => {
      calls.migrate = "x";
      throw new Error("P1001 connection refused");
    };
    await expect(provisionDisposableTestDatabase({ ...ARGS }, deps)).rejects.toThrow(/P1001/);
    expect(calls.mark).toBeUndefined();
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

  it("a malformed percent sequence in the password cannot defeat scrubbing", () => {
    // decodeURIComponent("ab%zzcd") throws — the raw form must still be
    // scrubbed, and so must the URL it is embedded in.
    const url = "postgresql://postgres:ab%zzcd@localhost:5432/postgres";
    expect(scrubCredentials("fail ab%zzcd here", [url])).toBe("fail <redacted> here");
    expect(scrubCredentials(`conn ${url} refused`, [url])).toBe(
      "conn postgresql://postgres:<redacted>@localhost:5432/postgres refused",
    );
  });

  it("migrateDeploySanitized never lets the subprocess emit credentials", () => {
    const url = "postgresql://postgres:s3cret-pw@localhost:55432/mergeship_test_x";
    const lines: string[] = [];
    let seenEnv: NodeJS.ProcessEnv | undefined;
    migrateDeploySanitized(
      url,
      (env) => {
        seenEnv = env;
        return {
          stdout: `Applying migrations to postgresql://postgres:s3cret-pw@localhost:55432/mergeship_test_x`,
          stderr: "warn: s3cret-pw leaked to stderr",
        };
      },
      (l) => lines.push(l),
    );
    // the URL reaches the child only through the environment
    expect(seenEnv?.DATABASE_URL).toBe(url);
    const out = lines.join("\n");
    expect(out).not.toContain("s3cret-pw");
    expect(out).toContain("<redacted>");
  });

  it("a failed migrate deploy is rethrown with stdout, stderr and the message scrubbed", () => {
    const url = "postgresql://postgres:s3cret-pw@localhost:55432/mergeship_test_x";
    const lines: string[] = [];
    const boom = Object.assign(
      new Error(`Command failed: postgresql://postgres:s3cret-pw@localhost:55432/db`),
      { stdout: "out s3cret-pw", stderr: "err postgresql://postgres:s3cret-pw@localhost/db" },
    );
    let thrown: unknown;
    try {
      migrateDeploySanitized(
        url,
        () => {
          throw boom;
        },
        (l) => lines.push(l),
      );
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).message).toContain("migrate deploy failed");
    expect((thrown as Error).message).not.toContain("s3cret-pw");
    expect((thrown as Error).message).toContain("<redacted>");
    // a failed subprocess logs nothing on the success path
    expect(lines).toHaveLength(0);
  });

  it("scrubs debug-style messages carrying encoded or malformed passwords", () => {
    const url = "postgresql://postgres:ab%zzcd@localhost/db";
    const boom = new Error(`DEBUG prisma:engines url=postgresql://postgres:ab%zzcd@localhost/db`);
    let thrown: unknown;
    try {
      migrateDeploySanitized(url, () => {
        throw boom;
      });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).message).not.toContain("ab%zzcd");
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

describe("CLI entry point (M-3)", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const viteNodeCli = path.join(root, "node_modules", "vite-node", "vite-node.mjs");
  const T = 120_000;

  const cleanEnv = (extra: Record<string, string> = {}) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
    for (const k of Object.keys(env)) {
      if (k.startsWith("RAILWAY_") || k === "NODE_ENV") delete env[k];
    }
    delete env.DATABASE_URL;
    delete env.MERGESHIP_TEST_DATABASE_URL;
    return env;
  };
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [viteNodeCli, ...args], {
      cwd: root,
      env: cleanEnv(extra),
      encoding: "utf8",
      timeout: T - 10_000,
    });

  it("the documented invocation enters main: missing args exit nonzero with usage", () => {
    const r = run(["--script", "scripts/test-db-provision.ts"]);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("usage:");
  }, T);

  it("enters main and refuses an unsafe server — failure is never silent success", () => {
    const r = run(
      [
        "--script",
        "scripts/test-db-provision.ts",
        "--server",
        "mysql://localhost/postgres",
        "--name",
        "mergeship_test_x",
      ],
      { MERGESHIP_SHADOW_TOKEN: "operator-token-xyz" },
    );
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toContain("refusing:");
  }, T);

  it("fully validated args reach the connection stage (refused port fails nonzero)", () => {
    const r = run(
      [
        "--script",
        "scripts/test-db-provision.ts",
        "--server",
        "postgresql://u@127.0.0.1:1/postgres",
        "--name",
        "mergeship_test_x",
      ],
      { MERGESHIP_SHADOW_TOKEN: "operator-token-xyz" },
    );
    expect(r.status).not.toBe(0);
    const out = `${r.stdout}${r.stderr}`;
    expect(out).not.toContain("usage:");
    expect(out.length).toBeGreaterThan(0);
  }, T);

  it("without --script the script still fails loudly instead of silently no-op", () => {
    // vite-node drops the script argv without --script — main() must still
    // run and fail with usage (exit 2), never exit 0.
    const r = run(["scripts/test-db-provision.ts"]);
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toContain("usage:");
  }, T);

  it("the implementation module is importable and contains no CLI entry", () => {
    const impl = fs.readFileSync(path.join(root, "scripts/test-db-provision.impl.ts"), "utf8");
    expect(impl).not.toContain("process.argv");
    expect(impl).toContain("export async function provisionDisposableTestDatabase");
    // And it already proved itself: this very test file imported it at the
    // top of the module graph without any provisioning side effects.
  });
});
