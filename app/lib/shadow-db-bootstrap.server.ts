// Operator helper: mark a DISPOSABLE database so the shadow-eval write
// guard allows durable outcomes on it.
//
// This is the ONLY function allowed to write the disposable marker, and it
// proves the target is safe BEFORE writing:
//   - refuses when NODE_ENV=production or any RAILWAY_* marker is present;
//   - requires the caller to pass --disposable / MERGESHIP_SHADOW_DISPOSABLE=yes;
//   - requires the database name to be a strictly-named MergeShip test
//     database (a Railway production database is named `railway`);
//   - requires the live fingerprint <db>@<server-addr>:<port> to be retyped
//     via --confirm-db and the server address to be local/private;
//   - requires every expected application table to exist in exactly the
//     schema the app's unqualified queries resolve (current_schema()), and
//     every user table in every non-system schema to be empty — a wrong
//     search_path cannot hide rows, a missing table never reads as empty;
//   - prints no credentials and never returns the marker token.
//
// There is deliberately no --force. A populated production database cannot
// be marked disposable through this path.

import { Prisma, type PrismaClient } from "@prisma/client";
import db from "../db.server";

// Any RAILWAY_* variable means the shell came from `railway run` or a
// Railway session — the whole prefix is refused, not just the known trio.
const railwayKeys = (env: NodeJS.ProcessEnv) =>
  Object.keys(env).filter((k) => k.startsWith("RAILWAY_"));

/** Database names tests may destroy. `railway`/`production` can never match. */
export const DISPOSABLE_DB_NAME_PATTERN = /^mergeship_[a-z0-9_]*test[a-z0-9_]*$/;

const IDENT = /^[A-Za-z0-9_]+$/;

// Every application table must exist and be empty. `_prisma_migrations` is
// the only harmless non-application table (handled in the schema scan).
const APPLICATION_TABLES = [
  "Session",
  "Settings",
  "AppControl",
  "ProcessedWebhook",
  "MergeClaim",
  "MergeRecord",
  "MergeOperation",
  "MergeOrderLock",
  "MergeMutationAttempt",
  "WorkerInstance",
  "ShippingAdjustment",
];

export class BootstrapNotAllowedError extends Error {
  name = "BootstrapNotAllowedError";
}

export interface DatabaseIdentity {
  db: string;
  addr: string | null;
  port: number | null;
}

/** Live identity of the connected database, for operator confirmation. */
export async function databaseIdentity(db: PrismaClient): Promise<DatabaseIdentity> {
  const [row] = await db.$queryRaw<{ db: string; addr: string | null; port: number | null }[]>`
    SELECT current_database() AS db,
           host(inet_server_addr()) AS addr,
           inet_server_port() AS port`;
  if (!row?.db) throw new Error("could not resolve database identity");
  return row;
}

export async function databaseFingerprint(db: PrismaClient): Promise<string> {
  const i = await databaseIdentity(db);
  return `${i.db}@${i.addr ?? "unix"}:${i.port ?? "?"}`;
}

/** Loopback, unix-socket (NULL) or RFC1918/ULA server address. */
export function isLocalOrPrivateAddress(addr: string | null): boolean {
  if (addr === null) return true; // unix socket
  if (addr === "::1" || addr.startsWith("127.")) return true;
  if (addr.startsWith("10.") || addr.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return true;
  if (/^(fd|fe80)/i.test(addr)) return true;
  return false;
}

/** Refuse to run under any production-like environment markers. */
export function assertNoProductionEnvironment(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === "production") {
    throw new BootstrapNotAllowedError(
      "refusing: NODE_ENV=production — this operation only runs in disposable test environments.",
    );
  }
  const railway = railwayKeys(env);
  if (railway.length) {
    throw new BootstrapNotAllowedError(
      `refusing: Railway environment detected (${railway.join(", ")}) — never mark a Railway database disposable.`,
    );
  }
}

/**
 * Mark the connected database disposable. Throws BootstrapNotAllowedError
 * unless every check passes; on success returns the fingerprint only.
 */
export async function bootstrapDisposableDatabase(
  client: PrismaClient = db,
  opts: {
    token?: string; // the marker secret — never logged or returned
    confirmDb?: string; // must equal the live fingerprint
    disposableConfirmed?: boolean; // --disposable / MERGESHIP_SHADOW_DISPOSABLE=yes
  },
): Promise<{ fingerprint: string }> {
  assertNoProductionEnvironment(process.env);
  if (opts.disposableConfirmed !== true) {
    throw new BootstrapNotAllowedError(
      "refusing: pass --disposable (MERGESHIP_SHADOW_DISPOSABLE=yes) to confirm this is a disposable test database.",
    );
  }
  if (!opts.token || !/^[A-Za-z0-9_-]{8,128}$/.test(opts.token)) {
    throw new BootstrapNotAllowedError("refusing: marker token missing or invalid (8-128 chars, [A-Za-z0-9_-]).");
  }
  const identity = await databaseIdentity(client);
  const fingerprint = `${identity.db}@${identity.addr ?? "unix"}:${identity.port ?? "?"}`;
  if (!DISPOSABLE_DB_NAME_PATTERN.test(identity.db)) {
    throw new BootstrapNotAllowedError(
      `refusing: database name '${identity.db}' is not a MergeShip test database (${DISPOSABLE_DB_NAME_PATTERN}).`,
    );
  }
  if (!isLocalOrPrivateAddress(identity.addr)) {
    throw new BootstrapNotAllowedError(
      `refusing: database server address '${identity.addr}' is not local or private.`,
    );
  }
  if (!opts.confirmDb || opts.confirmDb !== fingerprint) {
    throw new BootstrapNotAllowedError(
      `refusing: --confirm-db must equal the live database fingerprint '${fingerprint}'.`,
    );
  }

  // The app issues unqualified table names, so the authoritative schema is
  // current_schema() — NOT a hardcoded 'public'. If Prisma is configured
  // with ?schema=, the tables live there and nowhere else.
  const [schemaRow] = await client.$queryRaw<{ s: string | null }[]>`SELECT current_schema() AS s`;
  const appSchema = schemaRow?.s;
  if (!appSchema || !IDENT.test(appSchema)) {
    throw new BootstrapNotAllowedError(
      `refusing: could not resolve a sane application schema (got '${appSchema}').`,
    );
  }
  const found = await client.$queryRaw<{ relname: string; nspname: string }[]>`
    SELECT c.relname, n.nspname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p') AND c.relname = ANY(${APPLICATION_TABLES})`;
  const missing = APPLICATION_TABLES.filter(
    (t) => !found.some((o) => o.relname === t && o.nspname === appSchema),
  );
  if (missing.length) {
    throw new BootstrapNotAllowedError(
      `refusing: application tables missing from schema '${appSchema}': ${missing.join(", ")}. ` +
        "Provision a fresh test database (scripts/test-db-provision.ts) rather than marking a non-app database.",
    );
  }
  const misplaced = found.filter((o) => o.nspname !== appSchema);
  if (misplaced.length) {
    throw new BootstrapNotAllowedError(
      `refusing: application table names also exist outside schema '${appSchema}' ` +
        `(${misplaced.map((o) => `${o.nspname}.${o.relname}`).join(", ")}) — inconsistent database.`,
    );
  }

  // Every user table in every non-system schema must be empty — the app
  // tables (already enumerated) plus anything else that exists. A populated
  // table of ANY name means this is not a disposable database.
  const userTables = await client.$queryRaw<{ nspname: string; relname: string }[]>`
    SELECT n.nspname, c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`;
  for (const t of userTables) {
    if (t.relname === "_prisma_migrations") continue;
    const isAppTable = t.nspname === appSchema && APPLICATION_TABLES.includes(t.relname);
    if (!isAppTable && (!IDENT.test(t.nspname) || !IDENT.test(t.relname))) {
      throw new BootstrapNotAllowedError(
        `refusing: non-identifier object ${t.nspname}.${t.relname} — cannot verify emptiness.`,
      );
    }
    const qualified = Prisma.raw(`"${t.nspname}"."${t.relname}"`);
    // Migrations legitimately seed ONE row: the AppControl 'control'
    // singleton with every switch off and empty allowlists. Whitelist
    // exactly that state — any other row, or an enabled switch or stamped
    // epoch, is real operator state. Never truncate to satisfy this check.
    if (t.nspname === appSchema && t.relname === "AppControl") {
      const rows = await client.$queryRaw<
        {
          id: string;
          newMergesEnabled: boolean;
          completionEnabled: boolean;
          allowShops: string[];
          shippingAdjustmentsEnabled: boolean;
          shippingAllowShops: string[];
          shippingEnabledAt: unknown;
        }[]
      >(
        Prisma.sql`SELECT "id", "newMergesEnabled", "completionEnabled", "allowShops",
                   "shippingAdjustmentsEnabled", "shippingAllowShops", "shippingEnabledAt"
                   FROM ${qualified}`,
      );
      const seed =
        rows.length === 1 &&
        rows[0].id === "control" &&
        !rows[0].newMergesEnabled &&
        !rows[0].completionEnabled &&
        !rows[0].shippingAdjustmentsEnabled &&
        (rows[0].allowShops?.length ?? 0) === 0 &&
        (rows[0].shippingAllowShops?.length ?? 0) === 0 &&
        rows[0].shippingEnabledAt == null;
      if (!seed) {
        throw new BootstrapNotAllowedError(
          "refusing: AppControl does not hold exactly the fresh migration seed row " +
            "(id='control', all switches off, empty allowlists) — real operator state present.",
        );
      }
      continue;
    }
    const [row] = await client.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS n FROM ${qualified}`);
    if (row.n > 0n) {
      throw new BootstrapNotAllowedError(
        `refusing: database is populated — '${t.nspname}.${t.relname}' contains ${row.n} row(s). ` +
          "Never mark a database containing application or foreign data.",
      );
    }
  }

  if (!IDENT.test(identity.db)) {
    throw new BootstrapNotAllowedError(`refusing: database name '${identity.db}' is not a safe SQL identifier.`);
  }
  await client.$executeRawUnsafe(
    `COMMENT ON DATABASE "${identity.db}" IS 'mergeship-shadow-disposable:${opts.token}'`,
  );
  const [marker] = await client.$queryRaw<{ m: string | null }[]>`
    SELECT shobj_description(
      (SELECT oid FROM pg_database WHERE datname = current_database()),
      'pg_database') AS m`;
  if (marker?.m !== `mergeship-shadow-disposable:${opts.token}`) {
    throw new Error("marker write did not take effect — refusing to report success.");
  }
  return { fingerprint };
}
