/**
 * Shipping v0 shadow evaluator (Phase 1.1) — READ-ONLY on Shopify.
 *
 * Usage:
 *   npx vite-node scripts/shipping-shadow-eval.ts [--shop <shop>] [--limit N] [--apply --confirm-db <fingerprint>]
 *
 * Default is a DRY RUN: outcomes are computed with fresh Shopify reads and
 * printed, and NOTHING is written — the database connection itself is forced
 * read-only (`default_transaction_read_only=on`), which also fences any
 * hidden write such as an offline-session token refresh.
 *
 * --apply persists intents/verdicts to ShippingAdjustment. It is refused
 * unless ALL of these hold:
 *   - no production environment marker (RAILWAY_* / NODE_ENV=production),
 *   - MERGESHIP_SHADOW_DATABASE === current_database(),
 *   - the database carries the disposable marker
 *     `mergeship-shadow-disposable:<MERGESHIP_SHADOW_TOKEN>` (created only by
 *     the explicit local test-database bootstrap — see tests or
 *     scripts/shadow-db-bootstrap.ts; never by migrations),
 *   - --confirm-db matches the live fingerprint printed by a dry run:
 *     `<database>@<server-addr>:<port>` — a name, a localhost address or a
 *     comment alone never proves a database is disposable.
 *
 * The evaluator never sends a Shopify mutation: access goes through
 * readOnlyAdmin, and no ShippingAdjustment dispatch path exists. Every row
 * is mode='SHADOW' — evidence only, never executable.
 */
import "./require-database-url";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const shop = opt("--shop");
const limit = opt("--limit") ? Number(opt("--limit")) : undefined;
const confirmDb = opt("--confirm-db");
const apply = args.includes("--apply");
if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
  console.error("error: --limit must be a positive integer");
  process.exit(2);
}
if (confirmDb !== undefined && !apply) {
  console.error("error: --confirm-db only makes sense together with --apply");
  process.exit(2);
}

// Dry run: force the whole process's database access read-only BEFORE any
// module that creates a PrismaClient is imported. Shopify offline-session
// refresh writes through the same DATABASE_URL — a needed refresh then fails
// closed with an actionable error instead of writing to a shared database.
if (!apply) {
  const u = new globalThis.URL(process.env.DATABASE_URL!);
  const existing = u.searchParams.get("options");
  const ro = "-c default_transaction_read_only=on";
  u.searchParams.set("options", existing ? `${existing} ${ro}` : ro);
  process.env.DATABASE_URL = u.toString();
}

const dbModule = await import("../app/db.server");
const db = dbModule.default;
const { prismaOperationStore } = await import("../app/lib/operation-store.server");
const {
  makeShippingShadowStore,
  runShadowScan,
  ShadowDatabaseNotAllowedError,
} = await import("../app/lib/shipping-shadow.server");
const { getSettings } = await import("../app/lib/settings.server");

// Verify the read-only session option actually took effect — a driver that
// silently ignores it must not turn a "dry" run into a writable one.
if (!apply) {
  const [ro] = await db.$queryRaw<{ ro: string }[]>`SHOW transaction_read_only`;
  if (ro?.ro !== "on") {
    console.error(
      "error: dry-run database connection is not read-only — refusing to continue.",
    );
    process.exit(2);
  }
}

// Fingerprint: `<db>@<server-addr>:<port>` — what --apply requires the
// operator to copy back deliberately. Always printed so a mistaken --apply
// can never succeed without seeing which database it is about to touch.
const [fp] = await db.$queryRaw<{ fp: string | null }[]>`
  SELECT current_database() || '@' ||
         COALESCE(host(inet_server_addr()), 'unix') || ':' ||
         COALESCE(inet_server_port()::text, '?') AS fp`;
const fingerprint = fp?.fp ?? "unknown";
if (apply && confirmDb !== fingerprint) {
  console.error(`error: --apply requires --confirm-db "${fingerprint}"`);
  console.error(
    "That fingerprint identifies the database this script is connected to. Confirm it is the disposable test database before re-running.",
  );
  process.exit(2);
}

/**
 * Offline session via unauthenticated.admin; a missing session is null. In
 * dry-run mode the session row is pre-checked: if Shopify would need a token
 * refresh (a database write), we fail closed with an actionable error BEFORE
 * the library attempts it on the read-only connection.
 */
async function sessionAdminFactory(shop: string) {
  const OFFLINE_REFRESH_WINDOW_MS = 5 * 60 * 1000;
  const session = await db.session.findFirst({ where: { shop, isOnline: false } });
  if (!session) return null;
  if (
    !apply &&
    session.refreshToken &&
    session.expires instanceof Date &&
    session.expires.getTime() - Date.now() <= OFFLINE_REFRESH_WINDOW_MS
  ) {
    throw new Error(
      `Offline session for ${shop} needs a token refresh, which writes to the database — refused in dry-run. Refresh the app's session first (open the app), or accept that this intent cannot be evaluated dry.`,
    );
  }
  const { unauthenticated } = await import("../app/shopify.server");
  const { admin } = await unauthenticated.admin(shop);
  return admin;
}

const deps = {
  store: makeShippingShadowStore(db),
  ops: prismaOperationStore,
  settings: getSettings,
  adminFactory: sessionAdminFactory,
};

try {
  const report = await runShadowScan(deps, { shop, limit, apply });
  console.log(JSON.stringify({
    mode: apply ? "APPLY" : "DRY_RUN",
    databaseFingerprint: fingerprint,
    subsystemEnabled: report.subsystemEnabled,
    entries: report.entries,
    counts: report.entries.reduce<Record<string, number>>((acc, e) => {
      acc[e.outcome] = (acc[e.outcome] ?? 0) + 1;
      return acc;
    }, {}),
    warnings: [
      "This evaluator never sends Shopify mutations.",
      apply
        ? "Outcomes were persisted to ShippingAdjustment (mode=SHADOW — evidence only, never executable)."
        : "Nothing was written; the database connection was forced read-only.",
      "READY describes what a future refund worker WOULD send; no dispatch path exists.",
    ],
  }, null, 2));
} catch (err) {
  if (err instanceof ShadowDatabaseNotAllowedError) {
    console.error(`error: ${err.message}`);
    console.error(
      "Mark the disposable test database with the bootstrap marker and export MERGESHIP_SHADOW_DATABASE + MERGESHIP_SHADOW_TOKEN before using --apply.",
    );
    process.exit(1);
  }
  throw err;
} finally {
  await db.$disconnect();
}
