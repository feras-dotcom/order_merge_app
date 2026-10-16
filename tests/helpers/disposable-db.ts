// Shared disposable-database preflight for every destructive Postgres suite.
//
// Every suite that runs `prisma migrate deploy`, writes markers, TRUNCATEs
// or otherwise mutates a database MUST call `preflightDisposableDatabase`
// FIRST and abort if it throws. The preflight is strictly read-only — it
// never mutates the target:
//
//   1. Environment: refuses when NODE_ENV=production or ANY RAILWAY_*
//      variable is set. Suites never delete these to pass.
//   2. URL shape: postgres(s):// on a loopback host only — `localhost`,
//      127/8 or [::1]. Any other host (including *.rlwy.net, railway.internal
//      or a remote IP) is refused. A production tunnel still LOOKS like
//      localhost, which is why the next layers exist.
//   3. Database name must match DISPOSABLE_DB_NAME_PATTERN — a Railway
//      production database is named `railway` and can never qualify.
//   4. Live identity: current_database() must equal the URL's database name
//      and inet_server_addr() must be loopback, unix (NULL) or RFC1918 — a
//      publicly addressed server is refused.
//   5. The database must ALREADY carry the marker
//      `mergeship-shadow-disposable:<MERGESHIP_SHADOW_TOKEN>` — created only
//      by scripts/shadow-db-bootstrap.ts (or scripts/test-db-provision.ts),
//      which itself refuses populated databases. Test suites never create
//      or invent the marker; the token comes from the operator's shell, never
//      from a committed constant.
//
// The result is a PreflightedDatabase brand: a value only this module can
// issue, carrying the verified URL, database name and live server identity.
// `withScratchDatabase` accepts ONLY that brand — a bare URL string or a
// hand-built object cannot authorize a scratch database — and it re-verifies,
// on the real maintenance connection, that it is talking to the very server
// the brand was issued for, and that the base database still carries the
// operator's marker, before it runs any DDL. Scratch databases are therefore
// only ever created on a server whose preflight passed — they are empty by
// construction, so bootstrap and marker-absence tests never need to un-mark
// or truncate a real target.
//
// Provisioning a fresh disposable database:
//   docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
//   MERGESHIP_SHADOW_TOKEN=<random> npx vite-node scripts/test-db-provision.ts \
//     --server postgresql://postgres:postgres@localhost:55432/postgres \
//     --name mergeship_test_x --confirm-db <printed fingerprint>
// then run suites with:
//   MERGESHIP_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/mergeship_test_x \
//   MERGESHIP_SHADOW_TOKEN=<same token> npx vitest run tests/...

import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  DISPOSABLE_DB_NAME_PATTERN,
  assertNoProductionEnvironment,
  databaseIdentity,
  isLocalOrPrivateAddress,
  type DatabaseIdentity,
} from "../../app/lib/shadow-db-bootstrap.server";
import { SHADOW_DB_MARKER_PREFIX } from "../../app/lib/shipping-shadow.server";

export class DisposablePreflightError extends Error {
  name = "DisposablePreflightError";
}

/** A way to open a database client — injectable so tests never connect. */
export type DbConnector = (url: string) => PrismaClient;

const realConnector: DbConnector = (url) =>
  new PrismaClient({ datasources: { db: { url } } });

// Module-private issue key: it is never exported, so only code inside this
// module can mint a PreflightedDatabase. A hand-built object literal is not
// an instance, and an instance forged via Object.create() lacks the hidden
// symbol property — both are rejected by assertPreflighted below.
const PREFLIGHT_ISSUE: unique symbol = Symbol("mergeship.disposable-preflighted");

/**
 * Branded result of a successful disposable-database preflight. The
 * constructor takes the module-private key, so a hand-built instance is
 * impossible and `new PreflightedDatabase(...)` outside this module throws.
 * It carries the verified URL, the verified database name and the server
 * identity observed live during preflight — `withScratchDatabase` checks the
 * maintenance connection against exactly these values.
 */
export class PreflightedDatabase {
  readonly url: string;
  readonly dbName: string;
  readonly addr: string | null;
  readonly port: number | null;
  readonly fingerprint: string;

  constructor(
    issueKey: symbol,
    url: string,
    dbName: string,
    addr: string | null,
    port: number | null,
  ) {
    if (issueKey !== PREFLIGHT_ISSUE) {
      throw new DisposablePreflightError(
        "PreflightedDatabase is issued only by preflightDisposableDatabase — " +
          "a hand-constructed object is not proof that the preflight ran.",
      );
    }
    this.url = url;
    this.dbName = dbName;
    this.addr = addr;
    this.port = port;
    this.fingerprint = `${dbName}@${addr ?? "unix"}:${port ?? "?"}`;
    Object.defineProperty(this, PREFLIGHT_ISSUE, {
      value: true,
      enumerable: false,
      writable: false,
    });
  }
}

function assertPreflighted(candidate: unknown): asserts candidate is PreflightedDatabase {
  if (
    !(candidate instanceof PreflightedDatabase) ||
    (candidate as unknown as Record<symbol, unknown>)[PREFLIGHT_ISSUE] !== true
  ) {
    throw new DisposablePreflightError(
      "a PreflightedDatabase from preflightDisposableDatabase is required — " +
        "a bare URL string or hand-built object cannot authorize a scratch database.",
    );
  }
}

/** Parse and validate the test-database URL. Pure — no connection. */
export function assertSafeTestDatabaseUrl(url: string): { dbName: string; host: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new DisposablePreflightError(`MERGESHIP_TEST_DATABASE_URL is not a valid URL.`);
  }
  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") {
    throw new DisposablePreflightError(`test database URL scheme '${u.protocol}' is not postgresql://.`);
  }
  const host = u.hostname.toLowerCase();
  const loopback =
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!loopback) {
    throw new DisposablePreflightError(
      `test database host '${host}' is not loopback — external endpoints, Railway proxies and remote servers are never disposable.`,
    );
  }
  const dbName = decodeURIComponent(u.pathname.replace(/^\//, "").split("?")[0] ?? "");
  if (!DISPOSABLE_DB_NAME_PATTERN.test(dbName)) {
    throw new DisposablePreflightError(
      `database name '${dbName}' is not a MergeShip test database (expected ${DISPOSABLE_DB_NAME_PATTERN}).`,
    );
  }
  return { dbName, host };
}

/**
 * Retarget a verified URL at a different database name by setting
 * `URL.pathname` — never by string replacement, so credentials, userinfo,
 * port, query parameters and fragments cannot be mangled or smuggled.
 * The caller MUST re-validate the result (assertSafeTestDatabaseUrl for a
 * test-named database) before connecting or executing statements.
 */
export function urlWithDatabase(baseUrl: string, dbName: string): string {
  const u = new URL(baseUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/** The operator's marker token — never committed, never inventable by a suite. */
function operatorToken(): string {
  const token = process.env.MERGESHIP_SHADOW_TOKEN;
  if (!token || !/^[A-Za-z0-9_-]{8,128}$/.test(token)) {
    throw new DisposablePreflightError(
      "set MERGESHIP_SHADOW_TOKEN to the operator token the disposable marker was bootstrapped with. " +
        "Provision a test database via scripts/test-db-provision.ts.",
    );
  }
  return token;
}

function assertDisposableMarker(marker: string | null | undefined, dbName: string): void {
  if (marker !== `${SHADOW_DB_MARKER_PREFIX}${operatorToken()}`) {
    throw new DisposablePreflightError(
      `database '${dbName}' carries no disposable marker matching MERGESHIP_SHADOW_TOKEN — ` +
        "test suites never create the marker; provision the database first (scripts/test-db-provision.ts).",
    );
  }
}

/** Read-only live verification. Returns the fingerprint and live identity. */
export async function verifyDisposableConnection(
  db: PrismaClient,
  expectedDbName: string,
): Promise<{ fingerprint: string; identity: DatabaseIdentity }> {
  const ident = await databaseIdentity(db);
  if (ident.db !== expectedDbName) {
    throw new DisposablePreflightError(
      `connected database '${ident.db}' does not match the URL database '${expectedDbName}' — refusing.`,
    );
  }
  if (!isLocalOrPrivateAddress(ident.addr)) {
    throw new DisposablePreflightError(
      `database server address '${ident.addr}' is not local or private — refusing.`,
    );
  }
  const [row] = await db.$queryRaw<{ marker: string | null }[]>`
    SELECT shobj_description(
      (SELECT oid FROM pg_database WHERE datname = current_database()),
      'pg_database') AS marker`;
  assertDisposableMarker(row?.marker, expectedDbName);
  return {
    fingerprint: `${ident.db}@${ident.addr ?? "unix"}:${ident.port ?? "?"}`,
    identity: ident,
  };
}

/**
 * The ONE gate every destructive suite runs first. Throws — never returns
 * a falsy verdict — so a forgotten await is the only failure mode. On
 * success it issues the PreflightedDatabase brand that withScratchDatabase
 * requires as proof. Strictly read-only: it performs no writes.
 */
export async function preflightDisposableDatabase(
  url: string,
  connect: DbConnector = realConnector,
): Promise<PreflightedDatabase> {
  assertNoProductionEnvironment(process.env);
  const { dbName } = assertSafeTestDatabaseUrl(url);
  const db = connect(url);
  try {
    const { identity } = await verifyDisposableConnection(db, dbName);
    return new PreflightedDatabase(
      PREFLIGHT_ISSUE,
      url,
      dbName,
      identity.addr,
      identity.port,
    );
  } finally {
    await db.$disconnect();
  }
}

/** The database on the disposable server used for DDL. Not a test target. */
const MAINTENANCE_DATABASE = "postgres";

/**
 * Create a uniquely named scratch database on the ALREADY-VERIFIED server,
 * run `fn` with its URL, then drop it — guaranteed empty by construction,
 * so bootstrap and marker-absence tests never mutate the suite's database.
 *
 * `brand` MUST be the PreflightedDatabase returned by
 * preflightDisposableDatabase — anything else (a bare URL, a hand-built
 * object, a forged instance) throws before any connection is opened. Before
 * issuing DDL this re-verifies on the live maintenance connection that:
 *   - the connection targets the `postgres` maintenance database, and the
 *     server address and port equal the values the brand was issued for
 *     (a URL cannot redirect this onto an unverified server), and
 *   - the base database still carries the operator's disposable marker.
 * Only then is CREATE DATABASE issued, and only on that verified server.
 */
export async function withScratchDatabase<T>(
  brand: PreflightedDatabase,
  fn: (scratchUrl: string, scratchName: string) => Promise<T>,
  connect: DbConnector = realConnector,
): Promise<T> {
  assertNoProductionEnvironment(process.env);
  assertPreflighted(brand);
  // The carried URL was validated at preflight; re-validate so a mutated
  // brand object can never smuggle in a different endpoint.
  assertSafeTestDatabaseUrl(brand.url);

  const maintenanceUrl = urlWithDatabase(brand.url, MAINTENANCE_DATABASE);
  const maintenance = connect(maintenanceUrl);
  try {
    // Live re-verification: the maintenance connection must really be the
    // server the brand was issued for — same address and port — targeting
    // the maintenance database, not some other database on that server.
    const ident = await databaseIdentity(maintenance);
    if (ident.db !== MAINTENANCE_DATABASE || !isLocalOrPrivateAddress(ident.addr)) {
      throw new DisposablePreflightError(
        `maintenance connection reached database '${ident.db}' on '${ident.addr}' — expected '${MAINTENANCE_DATABASE}' on a local or private server.`,
      );
    }
    if (ident.addr !== brand.addr || ident.port !== brand.port) {
      throw new DisposablePreflightError(
        `maintenance connection identity '${ident.addr ?? "unix"}:${ident.port ?? "?"}' does not match ` +
          `the preflighted server '${brand.addr ?? "unix"}:${brand.port ?? "?"}' — refusing to create a ` +
          "database on an unverified server.",
      );
    }
    // The marker lives in the shared catalog and is readable from the
    // maintenance connection: re-verify it now so a brand can never
    // outlive — or fake — the operator's stamp on the base database.
    const [row] = await maintenance.$queryRaw<{ marker: string | null }[]>`
      SELECT shobj_description(
        (SELECT oid FROM pg_database WHERE datname = ${brand.dbName}),
        'pg_database') AS marker`;
    assertDisposableMarker(row?.marker, brand.dbName);

    const name = `mergeship_test_scratch_${crypto.randomBytes(5).toString("hex")}`;
    // Re-validate the constructed target URL BEFORE connecting to it or
    // executing statements (URL.pathname construction, never string
    // replacement).
    const scratchUrl = urlWithDatabase(brand.url, name);
    assertSafeTestDatabaseUrl(scratchUrl);
    await maintenance.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    try {
      return await fn(scratchUrl, name);
    } finally {
      await maintenance.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    }
  } finally {
    await maintenance.$disconnect();
  }
}
