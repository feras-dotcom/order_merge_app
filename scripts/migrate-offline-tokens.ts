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

import "./require-database-url";
import prisma from "../app/db.server";
import {
  migrateSessions,
  type MigrationResult,
  type MigrationTarget,
} from "../app/lib/session-migration.server";

const apiKey = process.env.SHOPIFY_API_KEY;
const apiSecret = process.env.SHOPIFY_API_SECRET;
if (!apiKey || !apiSecret) {
  console.error("SHOPIFY_API_KEY and SHOPIFY_API_SECRET are required.");
  process.exit(2);
}

const apply = process.argv.includes("--apply");

interface RefreshResponse {
  access_token?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

const secondsFromNow = (s: number) => new Date(Date.now() + s * 1000);

const deps = {
  listTargets: () =>
    prisma.session.findMany({
      select: { id: true, shop: true, refreshToken: true },
      orderBy: { id: "asc" },
    }),

  refresh: async (target: MigrationTarget) => {
    const res = await fetch(
      `https://${target.shop}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: apiKey,
          client_secret: apiSecret,
          refresh_token: target.refreshToken,
          grant_type: "refresh_token",
        }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as RefreshResponse;
    if (!res.ok || !body.access_token) {
      throw new Error(
        `HTTP ${res.status}${body.error ? ` ${body.error}` : ""}`,
      );
    }
    return body;
  },

  persist: async (target: MigrationTarget, refreshed: unknown) => {
    const body = refreshed as RefreshResponse;
    await prisma.session.update({
      where: { id: target.id },
      data: {
        accessToken: body.access_token,
        ...(body.scope !== undefined ? { scope: body.scope } : {}),
        ...(body.expires_in !== undefined
          ? { expires: secondsFromNow(body.expires_in) }
          : {}),
        ...(body.refresh_token && body.refresh_token_expires_in
          ? {
              refreshToken: body.refresh_token,
              refreshTokenExpires: secondsFromNow(
                body.refresh_token_expires_in,
              ),
            }
          : body.refresh_token
            ? { refreshToken: body.refresh_token }
            : {}),
      },
    });
  },

  verify: async (target: MigrationTarget) => {
    const stored = await prisma.session.findUnique({ where: { id: target.id } });
    if (!stored?.accessToken) throw new Error("no stored access token");
    const res = await fetch(
      `https://${target.shop}/admin/api/2026-04/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": stored.accessToken,
        },
        body: JSON.stringify({ query: "{ shop { name } }" }),
      },
    );
    if (!res.ok) throw new Error(`verification query HTTP ${res.status}`);
    const body = (await res.json()) as { errors?: unknown };
    if (body.errors) throw new Error("verification query returned errors");
  },

  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
};

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
