// Disposable-database bootstrap for the Shipping v0 shadow evaluator.
//
// This is the ROOT OF TRUST for the shadow write guard: it creates the
// `mergeship-shadow-disposable:<token>` database marker that
// makeShippingShadowStore requires before persisting anything. Because a
// production DATABASE_URL copied into a local shell carries no RAILWAY_*
// marker, the checks below are layered so that marking a real database
// requires the operator to get several independent things wrong at once:
//
//   1. No production environment markers (RAILWAY_* / NODE_ENV=production).
//   2. MERGESHIP_SHADOW_DISPOSABLE=yes — an explicit, separate assertion
//      that the connected database is a disposable local test database.
//   3. --confirm-db must equal the LIVE fingerprint <db>@<addr>:<port>
//      printed by a dry run — localhost is not proof of safety because a
//      tunnel to production also appears as localhost.
//   4. The database must contain NO application rows: a populated database
//      is real data, not a disposable sandbox.
//
// Only after all four does COMMENT ON DATABASE run. There is no bypass.
// The marker token is never returned, printed or included in errors.

import { Prisma, type PrismaClient } from "@prisma/client";
import { SHADOW_DB_MARKER_PREFIX } from "./shipping-shadow.server";

export class BootstrapNotAllowedError extends Error {
  name = "BootstrapNotAllowedError";
}

/** Application tables that must all be empty before a database may be
 *  marked disposable. `_prisma_migrations` is deliberately not listed —
 *  a freshly migrated disposable database still qualifies. */
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

/** `<database>@<server-addr>:<port>` — the identity of the connected
 *  database, safe to log (contains no credentials). */
export async function databaseFingerprint(db: PrismaClient): Promise<string> {
  const [row] = await db.$queryRaw<{ fp: string | null }[]>`
    SELECT current_database() || '@' ||
           COALESCE(host(inet_server_addr()), 'unix') || ':' ||
           COALESCE(inet_server_port()::text, '?') AS fp`;
  return row?.fp ?? "unknown";
}

/**
 * Mark the connected database disposable. Throws BootstrapNotAllowedError
 * unless every layer passes. Returns only the fingerprint — never the token.
 */
export async function bootstrapDisposableDatabase(
  db: PrismaClient,
  opts: {
    token: string | undefined;
    /** Must equal the live fingerprint — printed by the eval script's dry run. */
    confirmDb: string | undefined;
    /** True only when the operator set MERGESHIP_SHADOW_DISPOSABLE=yes. */
    disposableConfirmed: boolean;
  },
): Promise<{ fingerprint: string }> {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_ENVIRONMENT_NAME ||
    process.env.RAILWAY_PROJECT_ID
  ) {
    throw new BootstrapNotAllowedError(
      "production environment marker detected — refusing to mark a database.",
    );
  }
  if (opts.disposableConfirmed !== true) {
    throw new BootstrapNotAllowedError(
      "refusing: set MERGESHIP_SHADOW_DISPOSABLE=yes to assert this is a disposable local test database. There is no bypass — marking is permanent until the marker is removed by hand.",
    );
  }
  const token = opts.token;
  if (!token || !/^[A-Za-z0-9_-]{8,128}$/.test(token)) {
    throw new BootstrapNotAllowedError(
      "set MERGESHIP_SHADOW_TOKEN to a random token (8-128 of [A-Za-z0-9_-]) before bootstrapping.",
    );
  }
  const fingerprint = await databaseFingerprint(db);
  if (!opts.confirmDb || opts.confirmDb !== fingerprint) {
    throw new BootstrapNotAllowedError(
      `--confirm-db must equal the connected database fingerprint "${fingerprint}". ` +
        "Run the shipping-shadow-eval dry run to print it, and confirm it names the disposable database.",
    );
  }

  // A database that already contains application rows is not disposable.
  for (const table of APPLICATION_TABLES) {
    // Existence and emptiness in one read: to_regclass is NULL when the
    // table does not exist (a pre-migration database is fine). The name
    // must be quoted inside the literal — unquoted it folds to lowercase
    // and a mixed-case "Session" resolves to NULL, silently passing.
    const [row] = await db.$queryRaw<{ n: bigint | number | null }[]>`
      SELECT CASE WHEN to_regclass(${`public."${table}"`}) IS NULL THEN NULL
        ELSE (SELECT count(*) FROM ${Prisma.raw(`"${table}"`)}) END AS n`;
    if (row?.n != null && BigInt(row.n) > 0n) {
      throw new BootstrapNotAllowedError(
        `database contains application data (table "${table}" has ${row.n} rows) — refusing to mark it disposable.`,
      );
    }
  }

  const [dbRow] = await db.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
  if (!dbRow?.db || !/^[A-Za-z0-9_]+$/.test(dbRow.db)) {
    throw new BootstrapNotAllowedError(
      `unexpected database name '${dbRow?.db}' — refusing.`,
    );
  }
  // The token charset is restricted above, so this interpolation is safe;
  // the identifier is validated to a safe charset for the same reason.
  await db.$executeRawUnsafe(
    `COMMENT ON DATABASE "${dbRow.db}" IS '${SHADOW_DB_MARKER_PREFIX}${token}'`,
  );
  const [check] = await db.$queryRaw<{ marker: string | null }[]>`
    SELECT shobj_description(
      (SELECT oid FROM pg_database WHERE datname = current_database()),
      'pg_database') AS marker`;
  if (check?.marker !== `${SHADOW_DB_MARKER_PREFIX}${token}`) {
    throw new BootstrapNotAllowedError(
      "marker write did not verify — the database was NOT marked.",
    );
  }
  return { fingerprint };
}
