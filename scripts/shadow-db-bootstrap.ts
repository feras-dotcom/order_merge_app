/**
 * Disposable-database bootstrap for the Shipping v0 shadow evaluator.
 *
 *   MERGESHIP_SHADOW_TOKEN=<random> DATABASE_URL=postgresql://... \
 *     npx vite-node scripts/shadow-db-bootstrap.ts
 *
 * Stamps a database-level marker comment
 *   mergeship-shadow-disposable:<MERGESHIP_SHADOW_TOKEN>
 * that the shadow store requires before it will persist anything. The marker
 * lives on the database itself (not in the schema), is created ONLY here and
 * in the disposable-test bootstrap — never by migrations — and must be
 * matched by the operator's MERGESHIP_SHADOW_TOKEN environment variable.
 *
 * This is intentionally a separate, explicit step: neither a matching
 * database name, a localhost address nor an existing comment is ever treated
 * as proof that a database is disposable.
 */
import "./require-database-url";

const token = process.env.MERGESHIP_SHADOW_TOKEN;
if (!token || !/^[A-Za-z0-9_-]{8,128}$/.test(token)) {
  console.error(
    "error: set MERGESHIP_SHADOW_TOKEN to a random token (8-128 of [A-Za-z0-9_-]) before bootstrapping.",
  );
  process.exit(2);
}
if (
  process.env.NODE_ENV === "production" ||
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.RAILWAY_ENVIRONMENT_NAME ||
  process.env.RAILWAY_PROJECT_ID
) {
  console.error("error: production environment marker detected — refusing to mark a database.");
  process.exit(2);
}

const { default: db } = await import("../app/db.server");

const [row] = await db.$queryRaw<{ db: string; fp: string }[]>`
  SELECT current_database() AS db,
         COALESCE(host(inet_server_addr()), 'unix') || ':' ||
         COALESCE(inet_server_port()::text, '?') AS addr`;
if (!row?.db || !/^[A-Za-z0-9_]+$/.test(row.db)) {
  console.error(`error: unexpected database name '${row?.db}' — refusing.`);
  process.exit(1);
}
// Identifier cannot be parameterized; validated above to a safe charset.
await db.$executeRawUnsafe(
  `COMMENT ON DATABASE "${row.db}" IS 'mergeship-shadow-disposable:${token}'`,
);
const [check] = await db.$queryRaw<{ marker: string | null }[]>`
  SELECT shobj_description(
    (SELECT oid FROM pg_database WHERE datname = current_database()),
    'pg_database') AS marker`;
console.log(
  JSON.stringify(
    {
      marked: check?.marker === `mergeship-shadow-disposable:${token}`,
      database: row.db,
      fingerprint: `${row.db}@${row.fp}`,
      marker: check?.marker,
      note: "Apply is enabled only while MERGESHIP_SHADOW_DATABASE=" +
        `${row.db} and MERGESHIP_SHADOW_TOKEN match this marker.`,
    },
    null,
    2,
  ),
);
await db.$disconnect();
