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
// Scratch databases (`withScratchDatabase`) may only be created on a server
// that has passed preflight — they are empty by construction, so bootstrap
// and marker-absence tests never need to un-mark or truncate a real target.
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
} from "../../app/lib/shadow-db-bootstrap.server";
import { SHADOW_DB_MARKER_PREFIX } from "../../app/lib/shipping-shadow.server";

export class DisposablePreflightError extends Error {
  name = "DisposablePreflightError";
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

/** Read-only live verification. Returns the server-side fingerprint. */
export async function verifyDisposableConnection(
  db: PrismaClient,
  expectedDbName: string,
): Promise<{ fingerprint: string }> {
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
  const token = process.env.MERGESHIP_SHADOW_TOKEN;
  if (!token || !/^[A-Za-z0-9_-]{8,128}$/.test(token)) {
    throw new DisposablePreflightError(
      "set MERGESHIP_SHADOW_TOKEN to the operator token the disposable marker was bootstrapped with. " +
        "Provision a test database via scripts/test-db-provision.ts.",
    );
  }
  const [row] = await db.$queryRaw<{ marker: string | null }[]>`
    SELECT shobj_description(
      (SELECT oid FROM pg_database WHERE datname = current_database()),
      'pg_database') AS marker`;
  if (row?.marker !== `${SHADOW_DB_MARKER_PREFIX}${token}`) {
    throw new DisposablePreflightError(
      `database '${expectedDbName}' carries no disposable marker matching MERGESHIP_SHADOW_TOKEN — ` +
        "test suites never create the marker; provision the database first (scripts/test-db-provision.ts).",
    );
  }
  return { fingerprint: `${ident.db}@${ident.addr ?? "unix"}:${ident.port ?? "?"}` };
}

/**
 * The ONE gate every destructive suite runs first. Throws — never returns
 * a falsy verdict — so a forgotten await is the only failure mode.
 */
export async function preflightDisposableDatabase(url: string): Promise<{ fingerprint: string }> {
  assertNoProductionEnvironment(process.env);
  const { dbName } = assertSafeTestDatabaseUrl(url);
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    return await verifyDisposableConnection(db, dbName);
  } finally {
    await db.$disconnect();
  }
}

/**
 * Create a uniquely named scratch database on the ALREADY-VERIFIED server,
 * run `fn` with its URL, then drop it — guaranteed empty by construction,
 * so bootstrap and marker-absence tests never mutate the suite's database.
 * Only callable after preflightDisposableDatabase(url) has passed.
 */
export async function withScratchDatabase<T>(
  baseUrl: string,
  fn: (scratchUrl: string, scratchName: string) => Promise<T>,
): Promise<T> {
  const { dbName } = assertSafeTestDatabaseUrl(baseUrl); // server already verified
  const name = `mergeship_test_scratch_${crypto.randomBytes(5).toString("hex")}`;
  const maintenance = new PrismaClient({
    datasources: { db: { url: baseUrl.replace(`/${dbName}`, "/postgres") } },
  });
  try {
    await maintenance.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const scratchUrl = baseUrl.replace(`/${dbName}`, `/${name}`);
    try {
      return await fn(scratchUrl, name);
    } finally {
      await maintenance.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    }
  } finally {
    await maintenance.$disconnect();
  }
}
