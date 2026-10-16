// Provision a fresh, independently verified disposable test database.
//
// This is the documented procedure for creating a database the destructive
// test suites (tests/*-pg, postgres-stores, two-process) are allowed to
// migrate and truncate. Test suites never create the marker themselves —
// they only verify one stamped by this script exists.
//
//   1. Start a dedicated local Postgres (any local instance works; Docker
//      is the cleanest disposable option):
//        docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
//   2. Pick a random operator token (never committed):
//        e.g. node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
//   3. Provision:
//        MERGESHIP_SHADOW_TOKEN=<token> npx vite-node scripts/test-db-provision.ts \
//          --server postgresql://postgres:postgres@localhost:55432/postgres \
//          --name mergeship_test_x
//      The script prints the live fingerprint; re-run with
//      --confirm-db <fingerprint> to proceed.
//   4. Run the suites:
//        MERGESHIP_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/mergeship_test_x \
//        MERGESHIP_SHADOW_TOKEN=<token> npx vitest run tests/...
//
// Safety:
//   - refuses production environment markers and non-loopback server URLs;
//   - the database name must match the test pattern;
//   - an EXISTING database is REFUSED before CREATE, migrate deploy or any
//     other write — provisioning only ever creates fresh databases; an
//     existing database can be marked only through
//     scripts/shadow-db-bootstrap.ts after its own verification (it is
//     therefore impossible for `prisma migrate deploy` to run against a
//     database this workflow did not just create);
//   - no database URL (or the password inside it) is ever printed or put in
//     an error message; output is scrubbed of URL credentials;
//   - every constructed target URL is built with URL.pathname and
//     re-validated by assertSafeTestDatabaseUrl before use.
//
// Usage: npx vite-node scripts/test-db-provision.ts --server <maintenance-url> --name <mergeship_test_*> [--confirm-db <fingerprint>]

import { execSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  DISPOSABLE_DB_NAME_PATTERN,
  BootstrapNotAllowedError,
  assertNoProductionEnvironment,
  bootstrapDisposableDatabase,
  databaseIdentity,
  isLocalOrPrivateAddress,
} from "../app/lib/shadow-db-bootstrap.server";
import {
  assertSafeTestDatabaseUrl,
  urlWithDatabase,
  type DbConnector,
} from "../tests/helpers/disposable-db";

/** A URL with the password cleared — safe to print for the operator. */
export function redactUrlPassword(url: string): string {
  const u = new URL(url);
  u.password = "";
  return u.toString();
}

/**
 * Remove the password of any of the given URLs from arbitrary text (raw and
 * percent-decoded forms), so neither log output nor error messages can
 * disclose credentials accidentally embedded by a lower layer.
 */
export function scrubCredentials(text: string, urls: (string | undefined)[]): string {
  let out = text;
  for (const raw of urls) {
    if (!raw) continue;
    try {
      const password = new URL(raw).password;
      if (!password) continue;
      for (const form of new Set([password, decodeURIComponent(password)])) {
        out = out.split(form).join("<redacted>");
      }
    } catch {
      /* not a parseable URL — nothing to scrub */
    }
  }
  return out;
}

/**
 * Retarget the maintenance URL at `dbName` via URL.pathname (never string
 * replacement) and re-validate the result before any connection or
 * statement: the target must remain a loopback, strictly-named test
 * database. The database name itself is additionally checked to be a safe
 * SQL identifier (the name pattern already guarantees this).
 */
export function checkedDatabaseUrl(serverUrl: string, dbName: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
    throw new BootstrapNotAllowedError(
      `refusing: database name '${dbName}' is not a safe SQL identifier.`,
    );
  }
  const target = urlWithDatabase(serverUrl, dbName);
  try {
    assertSafeTestDatabaseUrl(target);
  } catch (err) {
    throw new BootstrapNotAllowedError(
      `refusing: the constructed target URL failed revalidation (${(err as Error).message}).`,
    );
  }
  return target;
}

export interface ProvisionArgs {
  serverUrl: string;
  dbName: string;
  token?: string;
  confirmDb?: string;
}

export interface ProvisionDeps {
  connectMaintenance?: DbConnector;
  /** Runs `prisma migrate deploy` against the freshly created target. */
  runMigrations?: (databaseUrl: string) => void;
  /** Stamps the disposable marker through the bootstrap's own checks. */
  markDisposable?: (
    databaseUrl: string,
    opts: { token: string; confirmDb: string },
  ) => Promise<{ fingerprint: string }>;
  log?: (line: string) => void;
}

/**
 * Create, migrate and mark a NEW disposable database. Every refusal happens
 * before CREATE DATABASE, `migrate deploy` and the marker write: an
 * existing database aborts immediately (LOW-1) and is never migrated.
 * Throws BootstrapNotAllowedError on every unsafe condition; returns
 * `{created:false}` when only the fingerprint was requested.
 */
export async function provisionDisposableTestDatabase(
  args: ProvisionArgs,
  deps: ProvisionDeps = {},
): Promise<{ created: boolean; fingerprint: string }> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const connect =
    deps.connectMaintenance ??
    ((url: string) => new PrismaClient({ datasources: { db: { url } } }));
  const runMigrations =
    deps.runMigrations ??
    ((databaseUrl: string) =>
      execSync("npx prisma migrate deploy", {
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "inherit",
      }));
  const markDisposable =
    deps.markDisposable ??
    (async (databaseUrl: string, opts: { token: string; confirmDb: string }) => {
      const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      try {
        return await bootstrapDisposableDatabase(client, {
          token: opts.token,
          confirmDb: opts.confirmDb,
          disposableConfirmed: true,
        });
      } finally {
        await client.$disconnect();
      }
    });

  assertNoProductionEnvironment(process.env);

  let u: URL;
  try {
    u = new URL(args.serverUrl);
  } catch {
    // Never echo the URL itself — it may carry credentials.
    throw new BootstrapNotAllowedError("refusing: --server is not a valid URL.");
  }
  const host = u.hostname.toLowerCase();
  if (
    (u.protocol !== "postgresql:" && u.protocol !== "postgres:") ||
    !(host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127."))
  ) {
    throw new BootstrapNotAllowedError(
      `refusing: maintenance server '${host}' is not loopback — provisioning only runs against a local disposable server.`,
    );
  }
  if (!DISPOSABLE_DB_NAME_PATTERN.test(args.dbName)) {
    throw new BootstrapNotAllowedError(
      `refusing: database name '${args.dbName}' must match ${DISPOSABLE_DB_NAME_PATTERN}.`,
    );
  }
  if (!args.token || !/^[A-Za-z0-9_-]{8,128}$/.test(args.token)) {
    throw new BootstrapNotAllowedError(
      "set MERGESHIP_SHADOW_TOKEN (8-128 chars, [A-Za-z0-9_-]) — never commit it.",
    );
  }

  const maintenance = connect(args.serverUrl);
  try {
    const identity = await databaseIdentity(maintenance);
    if (!isLocalOrPrivateAddress(identity.addr)) {
      throw new BootstrapNotAllowedError(
        `refusing: server address '${identity.addr}' is not local or private.`,
      );
    }
    const fingerprint = `${args.dbName}@${identity.addr ?? "unix"}:${identity.port ?? "?"}`;
    if (!args.confirmDb) {
      log(`Database will be: ${args.dbName}`);
      log(`Live fingerprint:  ${fingerprint}`);
      log(`Re-run with --confirm-db '${fingerprint}' to create, migrate and mark it.`);
      return { created: false, fingerprint };
    }
    if (args.confirmDb !== fingerprint) {
      throw new BootstrapNotAllowedError(
        `refusing: --confirm-db '${args.confirmDb}' does not equal live fingerprint '${fingerprint}'.`,
      );
    }

    // LOW-1: refuse BEFORE creating, migrating or marking — an existing
    // database is never migrated by this workflow. An operator who means
    // to mark a verified existing database uses shadow-db-bootstrap.ts.
    const [exists] = await maintenance.$queryRaw<{ e: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${args.dbName}) AS e`;
    if (exists.e) {
      throw new BootstrapNotAllowedError(
        `refusing: database '${args.dbName}' already exists — provisioning only creates fresh ` +
          "databases. To mark an existing, independently verified database, use " +
          "scripts/shadow-db-bootstrap.ts (it applies its own emptiness and schema checks).",
      );
    }
    await maintenance.$executeRawUnsafe(`CREATE DATABASE "${args.dbName}"`);
    log(`created database ${args.dbName}`);
  } finally {
    await maintenance.$disconnect();
  }

  const dbUrl = checkedDatabaseUrl(args.serverUrl, args.dbName);
  runMigrations(dbUrl);

  const res = await markDisposable(dbUrl, {
    token: args.token,
    confirmDb: args.confirmDb!,
  });
  log(`marked disposable: ${res.fingerprint}`);
  log(
    `Suites: MERGESHIP_TEST_DATABASE_URL='${redactUrlPassword(dbUrl)}' ` +
      "(credentials redacted — re-add yours) MERGESHIP_SHADOW_TOKEN='<token>' " +
      "npx vitest run tests/...",
  );
  return { created: true, fingerprint: res.fingerprint };
}

const args = process.argv.slice(2);
const get = (flag: string) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

const serverUrl = get("--server");
const dbName = get("--name");
const confirmDb = get("--confirm-db");
const token = process.env.MERGESHIP_SHADOW_TOKEN;

async function main() {
  if (!serverUrl || !dbName) {
    console.error(
      "usage: npx vite-node scripts/test-db-provision.ts --server <maintenance-url> --name <mergeship_test_*> [--confirm-db <fingerprint>]",
    );
    process.exit(2);
  }
  await provisionDisposableTestDatabase({ serverUrl, dbName, confirmDb, token });
}

// Execute only when run as a script — importing this module (e.g. from the
// provisioning safety tests) must never trigger provisioning.
const invokedAsScript = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return pathToFileURL(path.resolve(argv1)).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main().catch((err) => {
    // Scrub every message — a lower layer's error could embed the URL.
    const scrub = (s: string) => scrubCredentials(s, [serverUrl]);
    if (err instanceof BootstrapNotAllowedError) {
      console.error(scrub(err.message));
      process.exit(2);
    }
    console.error(scrub(String((err as Error)?.stack ?? err?.message ?? err)));
    process.exit(1);
  });
}
