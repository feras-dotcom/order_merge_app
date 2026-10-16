// Implementation of the disposable test-database provisioner.
//
// This module is IMPORTABLE ONLY — it contains no argument parsing and never
// runs on import. The CLI entry point is scripts/test-db-provision.ts:
//
//   npx vite-node --script scripts/test-db-provision.ts \
//     --server <maintenance-url> --name <mergeship_test_*> [--confirm-db <fingerprint>]
//
// Safety (see scripts/test-db-provision.ts header for the full procedure):
//   - refuses production environment markers and non-loopback server URLs,
//     using the SAME strict policy as the suite preflight (no query strings —
//     ?host= style connection overrides can redirect a connection past the
//     hostname check);
//   - the host must be an IP LITERAL (127/8 or [::1]): `localhost` and every
//     other DNS name are refused. A hostname can resolve to a different
//     address — or fall back between ::1 and 127.0.0.1 — on each independent
//     connection, including the migration subprocess's own; a literal IP
//     removes that name-resolution ambiguity;
//   - the database name must match the test pattern;
//   - the exact migration target URL is validated BEFORE any connection is
//     opened or any write is issued, and every connection, the migration
//     subprocess and the marker write use the NORMALIZED validated URL;
//   - an EXISTING database is REFUSED before CREATE, migrate deploy or any
//     other write — provisioning only ever creates fresh databases;
//   - after CREATE, a dedicated connection must prove it landed on the very
//     database just created (same database oid, server address and port) or
//     migrate deploy never runs;
//   - `prisma migrate deploy` still runs as a SEPARATE subprocess whose own
//     connection is NOT independently verified — the literal-IP rule is what
//     pins it to the same endpoint. What remains outside this threat model
//     is a local process actively rebinding the port between steps. Database
//     oids are cluster-local, not globally unique, so the proofs here bind
//     (name, oid, address, port) — not the cluster itself;
//   - the marker write re-verifies that same identity INSIDE one interactive
//     transaction on the marking connection immediately before the COMMENT —
//     a marker can only commit on the database its own connection verified;
//   - no database URL (or the password inside it) is ever printed or put in
//     an error message; migration subprocess output is captured, scrubbed
//     of credentials and run with a minimal environment before display.

import { execSync } from "node:child_process";
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
  assertLoopbackServerUrl,
  assertSafeTestDatabaseUrl,
  DisposablePreflightError,
  serverAndDatabaseIdentity,
  urlWithDatabase,
  type DatabaseOidIdentity,
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
 *
 * The raw form is scrubbed unconditionally: a malformed percent sequence in
 * the stored password (e.g. `ab%zzcd`) makes decodeURIComponent throw, and a
 * decoding failure must never prevent the raw form from being redacted.
 */
export function scrubCredentials(text: string, urls: (string | undefined)[]): string {
  let out = text;
  for (const raw of urls) {
    if (!raw) continue;
    try {
      const password = new URL(raw).password;
      if (!password) continue;
      // Scrub every form the password could be printed in: the raw form
      // unconditionally, the strict percent-decoded form, and a lenient
      // per-sequence decode — a lone malformed %XX must not keep the
      // decodable rest (e.g. `ab%zz%40cd` → `ab%zz@cd`) from being redacted.
      const forms = new Set<string>([password]);
      try {
        forms.add(decodeURIComponent(password));
      } catch {
        /* malformed percent-encoding — lenient form below still applies */
      }
      forms.add(
        password.replace(/%([0-9A-Fa-f]{2})/g, (_m, h: string) =>
          String.fromCharCode(parseInt(h, 16)),
        ),
      );
      for (const p of forms) {
        if (p) out = out.split(p).join("<redacted>");
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

/** What a migration subprocess may report back — already-captured output. */
export interface CommandResult {
  stdout?: string;
  stderr?: string;
}
export type MigrateRunner = (env: NodeJS.ProcessEnv) => CommandResult | void;

/**
 * The migration child gets ONLY what it needs — never the operator's whole
 * environment, so no other credential-bearing variable can appear in its
 * output or be inherited by tooling it spawns. Windows entries cover
 * cmd.exe/npx resolution and process startup; POSIX needs PATH and HOME.
 */
const MIGRATE_ENV_KEYS = [
  "PATH", "Path", "path",
  "SYSTEMROOT", "SystemRoot", "WINDIR", "SystemDrive",
  "PATHEXT", "COMSPEC",
  "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE",
];

function minimalMigrateEnv(databaseUrl: string): NodeJS.ProcessEnv {
  // ProcessEnv declares NODE_ENV required in this codebase; a fresh minimal
  // env deliberately starts empty.
  const env = {} as NodeJS.ProcessEnv;
  for (const k of MIGRATE_ENV_KEYS) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  env.DATABASE_URL = databaseUrl;
  return env;
}

const execMigrateDeploy: MigrateRunner = (env) => {
  const stdout = execSync("npx prisma migrate deploy", { env, stdio: "pipe" });
  return { stdout: stdout?.toString() ?? "" };
};

/**
 * Run `prisma migrate deploy` against `databaseUrl` with its output captured
 * and credential-scrubbed before display — the child never inherits our
 * stdio, so its stdout/stderr (and any exception carrying them) always pass
 * through scrubCredentials. On failure the thrown message is the sanitized
 * union of the subprocess message, stdout and stderr; the environment and
 * the raw connection string are never printed.
 */
export function migrateDeploySanitized(
  databaseUrl: string,
  run: MigrateRunner = execMigrateDeploy,
  log: (line: string) => void = console.log,
): void {
  const env = minimalMigrateEnv(databaseUrl);
  try {
    const res = run(env) ?? {};
    const out = scrubCredentials(
      [res.stdout, res.stderr].filter(Boolean).join("\n").trim(),
      [databaseUrl],
    );
    if (out) log(out);
  } catch (err) {
    const e = err as { message?: unknown; stdout?: unknown; stderr?: unknown };
    const blob = [e?.message, e?.stdout, e?.stderr]
      .filter((s) => s !== null && s !== undefined)
      .map(String)
      .join("\n");
    throw new Error(
      `prisma migrate deploy failed:\n${scrubCredentials(blob, [databaseUrl])}`,
    );
  }
}

export interface ProvisionArgs {
  serverUrl: string;
  dbName: string;
  token?: string;
  confirmDb?: string;
}

export interface ProvisionDeps {
  connectMaintenance?: DbConnector;
  /** Opens the connection that runs the post-CREATE identity proof (L-4). */
  connectTarget?: DbConnector;
  /** Opens the marker-writing client used by the default markDisposable. */
  openClient?: DbConnector;
  /** Runs `prisma migrate deploy` against the freshly created target. */
  runMigrations?: (databaseUrl: string) => void;
  /**
   * Stamps the disposable marker through the bootstrap's own checks.
   * `opts.expected` is the live identity captured right after CREATE
   * DATABASE — an implementation MUST verify it on the marker-writing
   * connection (the default does, inside the marking transaction) and
   * refuse if the connection reached anything else.
   */
  markDisposable?: (
    databaseUrl: string,
    opts: { token: string; confirmDb: string; expected: DatabaseOidIdentity },
  ) => Promise<{ fingerprint: string }>;
  log?: (line: string) => void;
}

/**
 * Create, migrate and mark a NEW disposable database. Every refusal happens
 * before CREATE DATABASE, `migrate deploy` and the marker write: an unsafe
 * URL aborts before any connection is opened, and an existing database
 * aborts immediately after the existence check (LOW-1) — an existing
 * database is never migrated by this workflow.
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
  const connectTarget = deps.connectTarget ?? connect;
  const runMigrations =
    deps.runMigrations ?? ((databaseUrl: string) => migrateDeploySanitized(databaseUrl, undefined, log));
  const markDisposable =
    deps.markDisposable ??
    (async (
      databaseUrl: string,
      opts: { token: string; confirmDb: string; expected: DatabaseOidIdentity },
    ) => {
      const open = deps.openClient ?? ((url: string) => new PrismaClient({ datasources: { db: { url } } }));
      const client = open(databaseUrl);
      try {
        // bootstrapDisposableDatabase verifies opts.expected on THIS
        // connection inside the same interactive transaction as the
        // COMMENT write — the marker can only commit on the database
        // whose creation this run proved.
        return await bootstrapDisposableDatabase(client, {
          token: opts.token,
          confirmDb: opts.confirmDb,
          disposableConfirmed: true,
          expected: opts.expected,
        });
      } finally {
        await client.$disconnect();
      }
    });

  assertNoProductionEnvironment(process.env);

  // Validate the maintenance endpoint BEFORE connecting — the same strict
  // loopback policy the suite preflight uses (no query/fragment overrides,
  // strict IPv4 loopback, canonical [::1]; DNS names including localhost
  // are refused). The NORMALIZED URL is what every connection sees.
  let serverUrl: string;
  try {
    serverUrl = assertLoopbackServerUrl(args.serverUrl).toString();
  } catch (err) {
    // Never echo the URL itself — it may carry credentials.
    throw new BootstrapNotAllowedError(
      `refusing: --server failed validation (${(err as Error).message}).`,
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

  // M-1: the exact migration/marker target URL is validated BEFORE any
  // connection is opened or any write is issued. An input like
  // 127.0.0.1.attacker.example is refused here — zero writes.
  const dbUrl = checkedDatabaseUrl(serverUrl, args.dbName);

  const maintenance = connect(serverUrl);
  let created: DatabaseOidIdentity;
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
    // CREATE DATABASE itself is atomic: if a race slips a same-named
    // database in after this check, CREATE fails and migrate deploy never
    // runs.
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

    // Capture the new database's identity — its pg_database oid plus the
    // server address and port — on the maintenance connection, so the
    // migration target can be proven to be this very database.
    created = await serverAndDatabaseIdentity(maintenance, args.dbName);
  } finally {
    await maintenance.$disconnect();
  }

  // L-4: prove on a NEW connection that the migration target resolved to
  // the database just created — same oid, address and port on a
  // local/private server — before prisma migrate deploy is allowed to run.
  // The migration itself is a SEPARATE subprocess connection this check
  // cannot cover: the 127/8-or-[::1]-literal rule is what pins it to the
  // same endpoint (a hostname could re-resolve differently per process).
  // A local process actively rebinding the port mid-run is outside this
  // threat model, and oids are cluster-local — not a cluster identifier.
  const target = connectTarget(dbUrl);
  try {
    let t: DatabaseOidIdentity;
    try {
      t = await serverAndDatabaseIdentity(target, args.dbName);
    } catch (err) {
      // A failed identity proof is a refusal (exit 2), not an opaque crash:
      // e.g. the database does not exist on the server this connection
      // reached. Transport errors still propagate as ordinary failures.
      if (err instanceof DisposablePreflightError || err instanceof BootstrapNotAllowedError) {
        throw new BootstrapNotAllowedError(
          `refusing: migration target identity check failed (${err.message}).`,
        );
      }
      throw err;
    }
    if (
      t.db !== args.dbName ||
      String(t.oid) !== String(created.oid) ||
      t.addr !== created.addr ||
      t.port !== created.port ||
      !isLocalOrPrivateAddress(t.addr)
    ) {
      throw new BootstrapNotAllowedError(
        `refusing: the migration target resolved to '${t.db}@${t.addr ?? "unix"}:${t.port ?? "?"}' ` +
          `(oid ${t.oid}) instead of the database just created ` +
          `('${args.dbName}@${created.addr ?? "unix"}:${created.port ?? "?"}', oid ${created.oid}) — ` +
          "migrate deploy runs only against a proven fresh target.",
      );
    }
  } finally {
    await target.$disconnect();
  }

  runMigrations(dbUrl);

  // The marker is bound to the database just created: the default
  // markDisposable opens the marking connection and verifies `expected`
  // inside the same transaction as the COMMENT write. (`created.db` is the
  // MAINTENANCE connection's current_database() — pin the target's name.)
  const res = await markDisposable(dbUrl, {
    token: args.token,
    confirmDb: args.confirmDb!,
    expected: { db: args.dbName, addr: created.addr, port: created.port, oid: created.oid },
  });
  log(`marked disposable: ${res.fingerprint}`);
  log(
    `Suites: MERGESHIP_TEST_DATABASE_URL='${redactUrlPassword(dbUrl)}' ` +
      "(credentials redacted — re-add yours) MERGESHIP_SHADOW_TOKEN='<token>' " +
      "npx vitest run tests/...",
  );
  return { created: true, fingerprint: res.fingerprint };
}
