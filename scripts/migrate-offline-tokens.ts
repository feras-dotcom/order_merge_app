// Re-pins every stored Shopify offline session onto the current client secret.
//
//   dry run (default):
//     npx vite-node scripts/migrate-offline-tokens.ts
//   apply:
//     npx vite-node scripts/migrate-offline-tokens.ts --apply
//
// Required env (operator shell):
//   DATABASE_URL        — session storage database
//   SHOPIFY_API_KEY     — app client id
//   SHOPIFY_API_SECRET  — the NEW client secret (set it before running --apply)
//
// For each stored session carrying a refresh token the script exchanges it via
// Shopify's OAuth refresh_token grant using the NEW secret — the same request
// the SDK's api.auth.refreshToken performs — persists the re-issued fields on
// the same row, then proves the new access token with a read-only shop query.
// Sessions without a refresh token are reported as skipped — they need
// merchant re-authorization. Token values are never printed.
//
// Run --apply only AFTER every deployed instance runs the new secret (see
// docs/RUNBOOK.md "Shopify client-secret rotation"): a stale instance still
// holding the old secret can overwrite a migrated row after it was verified.

import "./require-database-url";
import prisma from "../app/db.server";
import {
  createSessionMigrationDeps,
  migrateSessions,
  type MigrationResult,
} from "../app/lib/session-migration.server";

const apiKey = process.env.SHOPIFY_API_KEY;
const apiSecret = process.env.SHOPIFY_API_SECRET;
if (!apiKey || !apiSecret) {
  console.error("SHOPIFY_API_KEY and SHOPIFY_API_SECRET are required.");
  process.exit(2);
}

const apply = process.argv.includes("--apply");

const deps = createSessionMigrationDeps({ prisma, apiKey, apiSecret });

if (!apply) {
  const targets = await deps.listTargets();
  console.log(`dry run — ${targets.length} stored session(s):`);
  for (const t of targets) {
    console.log(
      `  ${t.id}  shop=${t.shop}  refreshToken=${t.refreshToken ? "present" : "ABSENT"}`,
    );
  }
  console.log("re-run with --apply to migrate.");
  process.exit(0);
}

const results: MigrationResult[] = await migrateSessions(deps, {
  delayMs: 250,
});
for (const r of results) {
  const detail = r.status === "failed" ? ` [${r.stage}] ${r.error}` : "";
  console.log(`${r.status.padEnd(8)} ${r.shop} (${r.id})${detail}`);
}
const counts = {
  migrated: results.filter((r) => r.status === "migrated").length,
  skipped: results.filter((r) => r.status === "skipped").length,
  failed: results.filter((r) => r.status === "failed").length,
};
console.log(
  `done: ${counts.migrated} migrated, ${counts.skipped} skipped, ${counts.failed} failed`,
);
process.exit(counts.failed > 0 ? 1 : 0);
