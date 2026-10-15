/**
 * Disposable-database bootstrap for the Shipping v0 shadow evaluator.
 *
 *   MERGESHIP_SHADOW_TOKEN=<random> MERGESHIP_SHADOW_DISPOSABLE=yes \
 *     DATABASE_URL=postgresql://... \
 *     npx vite-node scripts/shadow-db-bootstrap.ts --confirm-db <db>@<addr>:<port>
 *
 * Stamps the database-level marker `mergeship-shadow-disposable:<token>`
 * that the shadow store requires before it will persist anything.
 *
 * This script is the ROOT OF TRUST for that marker, so it refuses unless
 * ALL of these hold (all checked in app/lib/shadow-db-bootstrap.server.ts):
 *   - no production environment markers (RAILWAY_* / NODE_ENV=production),
 *   - MERGESHIP_SHADOW_DISPOSABLE=yes explicitly asserts the connected
 *     database is a disposable local test database,
 *   - --confirm-db equals the live fingerprint printed by a dry run —
 *     localhost is not proof of safety because a tunnel to production also
 *     appears as localhost,
 *   - the database contains NO application rows (a populated database is
 *     real data, not a sandbox).
 *
 * There is no bypass. The token and the marker are never printed.
 */
import "./require-database-url";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const confirmDb = opt("--confirm-db");

const { default: db } = await import("../app/db.server");
const { bootstrapDisposableDatabase, BootstrapNotAllowedError } = await import(
  "../app/lib/shadow-db-bootstrap.server"
);

try {
  const { fingerprint } = await bootstrapDisposableDatabase(db, {
    token: process.env.MERGESHIP_SHADOW_TOKEN,
    confirmDb,
    disposableConfirmed: process.env.MERGESHIP_SHADOW_DISPOSABLE === "yes",
  });
  console.log(
    JSON.stringify(
      {
        marked: true,
        databaseFingerprint: fingerprint,
        note:
          "Apply is enabled only while MERGESHIP_SHADOW_DATABASE=<db> and " +
          "MERGESHIP_SHADOW_TOKEN match the marker just written.",
      },
      null,
      2,
    ),
  );
} catch (err) {
  if (err instanceof BootstrapNotAllowedError) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
  throw err;
} finally {
  await db.$disconnect();
}
