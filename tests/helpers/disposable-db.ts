// Shared disposable-database preflight for every destructive Postgres suite.
//
// Every suite that runs `prisma migrate deploy`, writes markers, TRUNCATEs
// or otherwise mutates a database MUST call `preflightDisposableDatabase`
// FIRST and abort if it throws. The preflight is strictly read-only — it
// never mutates the target:
//
//   1. Environment: refuses when NODE_ENV=production or ANY RAILWAY_*
//      variable is set. Suites never delete these to pass.
//   2. URL shape: postgres(s):// on a loopback IP LITERAL only — 127/8 or
//      [::1]. DNS names, including `localhost`, are refused: a hostname can
//      resolve to a different address (or a different loopback family) on
//      each independent connection, and the migration subprocess resolves
//      it again by itself. Any other host (including *.rlwy.net,
//      railway.internal or a remote IP) is refused. A production tunnel
//      still LOOKS like a local endpoint, which is why the next layers
//      exist.
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
// Provisioning a fresh disposable database (never reuse a container that
// has held anything else; bind the port to loopback ONLY and pick a random
// unused host port and a random password):
//   docker run -d -p 127.0.0.1:<port>:5432 -e POSTGRES_PASSWORD=<random> postgres:16
//   MERGESHIP_SHADOW_TOKEN=<random> npx vite-node --script scripts/test-db-provision.ts \
//     --server postgresql://postgres:<random>@127.0.0.1:<port>/postgres \
//     --name mergeship_test_x --confirm-db <printed fingerprint>
// (the --script flag is required — without it vite-node drops the script's
// argv and main never runs; the CLI fails loudly rather than silently no-op.)
// then run suites with:
//   MERGESHIP_TEST_DATABASE_URL=postgresql://postgres:<random>@127.0.0.1:<port>/mergeship_test_x \
//   MERGESHIP_SHADOW_TOKEN=<same token> npx vitest run tests/...

import crypto from "node:crypto";
import net from "node:net";
import { PrismaClient } from "@prisma/client";
import {
  DISPOSABLE_DB_NAME_PATTERN,
  assertNoProductionEnvironment,
  databaseIdentity,
  isLocalOrPrivateAddress,
  type DatabaseIdentity,
} from "../../app/lib/shadow-db-bootstrap.server";
import { SHADOW_DB_MARKER_PREFIX } from "../../app/lib/shipping-shadow.server";
// The oid-bearing identity read lives with the bootstrap's other safety
// checks; re-exported so provisioning code keeps a single import surface.
export {
  serverAndDatabaseIdentity,
  type DatabaseOidIdentity,
} from "../../app/lib/shadow-db-bootstrap.server";

export class DisposablePreflightError extends Error {
  name = "DisposablePreflightError";
}

/** A way to open a database client — injectable so tests never connect. */
export type DbConnector = (url: string) => PrismaClient;

const realConnector: DbConnector = (url) =>
  new PrismaClient({ datasources: { db: { url } } });

/**
 * The verified connection identity captured by a successful preflight. It is
 * stored ONLY in the module-private registry below — never on the branded
 * object — so neither a copied Symbol property nor a mutated field can alter
 * what withScratchDatabase authorizes.
 */
interface VerifiedServerIdentity {
  readonly url: string;
  readonly dbName: string;
  readonly addr: string | null;
  readonly port: number | null;
}

// Module-private issuance registry: membership — not object shape — is the
// credential. A hand-built object literal is not an instance; an instance
// forged via Object.create(), a stolen Symbol, Reflect.construct or a direct
// constructor call is simply absent from this map, and mutating a real
// brand's fields cannot change the stored identity withScratchDatabase uses.
const PREFLIGHTED = new WeakMap<PreflightedDatabase, VerifiedServerIdentity>();

/**
 * Branded result of a successful disposable-database preflight. The public
 * fields are informational only (frozen, and never consulted for
 * authorization): the authoritative URL, database name and live server
 * identity are the frozen private registry entry, and `withScratchDatabase`
 * checks the maintenance connection against exactly those stored values.
 *
 * The brand deliberately carries NO URL: a connection string embeds
 * credentials, and a brand printed in a log or a test-failure diff must
 * never disclose one. Only the module-private registry holds the URL.
 */
export class PreflightedDatabase {
  readonly dbName: string;
  readonly addr: string | null;
  readonly port: number | null;
  readonly fingerprint: string;

  constructor(dbName: string, addr: string | null, port: number | null) {
    this.dbName = dbName;
    this.addr = addr;
    this.port = port;
    this.fingerprint = `${dbName}@${addr ?? "unix"}:${port ?? "?"}`;
    // A frozen instance can neither be mutated nor carry a forged property.
    // (Construction alone is NOT authorization — only registry membership is.)
    Object.freeze(this);
  }
}

/**
 * Resolve the verified identity backing `candidate`, or throw. Membership in
 * the module-private WeakMap is the only credential — it cannot be observed
 * via Object.getOwnPropertySymbols/Reflect.ownKeys and cannot be granted by
 * constructing or mutating objects from outside this module.
 */
function verifiedIdentity(candidate: unknown): VerifiedServerIdentity {
  const v = candidate instanceof PreflightedDatabase ? PREFLIGHTED.get(candidate) : undefined;
  if (!v) {
    throw new DisposablePreflightError(
      "a PreflightedDatabase from preflightDisposableDatabase is required — " +
        "a bare URL string, a hand-built object or a self-constructed instance " +
        "cannot authorize a scratch database.",
    );
  }
  return v;
}

/**
 * Shared loopback-server policy for every disposable-database connection —
 * the provisioning script and the suites' preflight use the same rules:
 *
 *   - scheme must be postgresql:// or postgres://;
 *   - NO query string and NO fragment: Prisma honours connection-override
 *     parameters (e.g. `?host=`, socket-directory overrides) that can redirect
 *     a connection away from the endpoint whose hostname was checked, so the
 *     whole URL tail is refused rather than parsed. No parameter has a
 *     documented justification for the disposable workflow;
 *   - host must be a loopback IP LITERAL: a strict 127.0.0.0/8 IPv4 literal
 *     or canonical `[::1]` (every equivalent spelling — `[0::1]`,
 *     `[0:0:0:0:0:0:0:1]` — normalizes to it). DNS names, INCLUDING
 *     `localhost`, are refused: a hostname can resolve to a different
 *     address — or fall back between ::1 and 127.0.0.1 — on each
 *     independent connection, and `prisma migrate deploy` resolves it
 *     again in its own subprocess. A literal IP names exactly one
 *     endpoint. `net.isIPv4` rejects short forms (127.1), out-of-range
 *     octets (127.999.0.1) and octal tricks that looser regexes accept;
 *     DNS names merely beginning with `127.` (127.0.0.1.attacker.example)
 *     are refused.
 *
 * Pure — opens no connection. The returned URL object is the caller's
 * normalized parse; consumers should use `u.toString()` so validation and
 * connection see the same literal endpoint.
 */
export function assertLoopbackServerUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new DisposablePreflightError(`database URL is not a valid URL.`);
  }
  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") {
    throw new DisposablePreflightError(`database URL scheme '${u.protocol}' is not postgresql://.`);
  }
  if (u.search || u.hash) {
    throw new DisposablePreflightError(
      "database URL carries a query string or fragment — connection-override " +
        "parameters (e.g. ?host=) could redirect the connection past the host " +
        "check and are never allowed for disposable databases.",
    );
  }
  const host = u.hostname.toLowerCase();
  const loopback = host === "[::1]" || host === "::1" || (net.isIPv4(host) && host.startsWith("127."));
  if (!loopback) {
    throw new DisposablePreflightError(
      `database host '${host}' is not a loopback IP literal — DNS names ` +
        "(including 'localhost'), Railway proxies, remote servers, DNS names " +
        "starting with '127.' and malformed IPv4 octets are never disposable.",
    );
  }
  return u;
}

/** Parse and validate the test-database URL. Pure — no connection. */
export function assertSafeTestDatabaseUrl(url: string): { dbName: string; host: string; url: string } {
  const u = assertLoopbackServerUrl(url);
  const host = u.hostname.toLowerCase();
  let dbName: string;
  try {
    dbName = decodeURIComponent(u.pathname.replace(/^\//, ""));
  } catch {
    throw new DisposablePreflightError(
      `database name in test URL is not valid percent-encoding — refusing.`,
    );
  }
  if (!DISPOSABLE_DB_NAME_PATTERN.test(dbName)) {
    throw new DisposablePreflightError(
      `database name '${dbName}' is not a MergeShip test database (expected ${DISPOSABLE_DB_NAME_PATTERN}).`,
    );
  }
  return { dbName, host, url: u.toString() };
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
  // Connect with the NORMALIZED, validated URL — never the raw input — so
  // every downstream connection sees exactly the endpoint that was checked.
  const { dbName, url: safeUrl } = assertSafeTestDatabaseUrl(url);
  const db = connect(safeUrl);
  try {
    const { identity } = await verifyDisposableConnection(db, dbName);
    const brand = new PreflightedDatabase(dbName, identity.addr, identity.port);
    // Registry membership is the credential. Store the verified values
    // frozen — even if a caller mutates the public fields (impossible after
    // Object.freeze, but defense in depth), authorization uses this entry.
    PREFLIGHTED.set(
      brand,
      Object.freeze({ url: safeUrl, dbName, addr: identity.addr, port: identity.port }),
    );
    return brand;
  } finally {
    await db.$disconnect();
  }
}

// serverAndDatabaseIdentity / DatabaseOidIdentity live in
// app/lib/shadow-db-bootstrap.server.ts and are re-exported above.

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
  // Authorization uses ONLY the privately stored identity — mutated public
  // fields on the brand cannot change the URL, database, address or port
  // that get authorized.
  const verified = verifiedIdentity(brand);
  // The carried URL was validated at preflight; re-validate so nothing can
  // smuggle in a different endpoint.
  assertSafeTestDatabaseUrl(verified.url);

  const maintenanceUrl = urlWithDatabase(verified.url, MAINTENANCE_DATABASE);
  assertLoopbackServerUrl(maintenanceUrl);
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
    if (ident.addr !== verified.addr || ident.port !== verified.port) {
      throw new DisposablePreflightError(
        `maintenance connection identity '${ident.addr ?? "unix"}:${ident.port ?? "?"}' does not match ` +
          `the preflighted server '${verified.addr ?? "unix"}:${verified.port ?? "?"}' — refusing to create a ` +
          "database on an unverified server.",
      );
    }
    // The marker lives in the shared catalog and is readable from the
    // maintenance connection: re-verify it now so a brand can never
    // outlive — or fake — the operator's stamp on the base database.
    const [row] = await maintenance.$queryRaw<{ marker: string | null }[]>`
      SELECT shobj_description(
        (SELECT oid FROM pg_database WHERE datname = ${verified.dbName}),
        'pg_database') AS marker`;
    assertDisposableMarker(row?.marker, verified.dbName);

    const name = `mergeship_test_scratch_${crypto.randomBytes(5).toString("hex")}`;
    // Re-validate the constructed target URL BEFORE connecting to it or
    // executing statements (URL.pathname construction, never string
    // replacement).
    const scratchUrl = urlWithDatabase(verified.url, name);
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
