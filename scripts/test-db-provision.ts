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
// Safety: refuses production environment markers and non-loopback server
// URLs; the database name must match the test pattern; an EXISTING database
// is never truncated or reset — if it is already populated, the bootstrap's
// emptiness check refuses to mark it.
//
// Usage: npx vite-node scripts/test-db-provision.ts --server <maintenance-url> --name <mergeship_test_*> [--confirm-db <fingerprint>]

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

const args = process.argv.slice(2);
const get = (flag: string) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

const serverUrl = get("--server");
const dbName = get("--name");
const confirmDb = get("--confirm-db");
const token = process.env.MERGESHIP_SHADOW_TOKEN;

if (!serverUrl || !dbName) {
  console.error(
    "usage: npx vite-node scripts/test-db-provision.ts --server <maintenance-url> --name <mergeship_test_*> [--confirm-db <fingerprint>]",
  );
  process.exit(2);
}

async function main() {
  assertNoProductionEnvironment(process.env);

  const u = new URL(serverUrl!);
  const host = u.hostname.toLowerCase();
  if (
    u.protocol !== "postgresql:" && u.protocol !== "postgres:" ||
    !(host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127."))
  ) {
    throw new BootstrapNotAllowedError(
      `refusing: maintenance server '${host}' is not loopback — provisioning only runs against a local disposable server.`,
    );
  }
  if (!DISPOSABLE_DB_NAME_PATTERN.test(dbName!)) {
    throw new BootstrapNotAllowedError(
      `refusing: database name '${dbName}' must match ${DISPOSABLE_DB_NAME_PATTERN}.`,
    );
  }
  if (!token || !/^[A-Za-z0-9_-]{8,128}$/.test(token)) {
    throw new BootstrapNotAllowedError("set MERGESHIP_SHADOW_TOKEN (8-128 chars, [A-Za-z0-9_-]) — never commit it.");
  }

  const maintenance = new PrismaClient({ datasources: { db: { url: serverUrl! } } });
  try {
    const identity = await databaseIdentity(maintenance);
    if (!isLocalOrPrivateAddress(identity.addr)) {
      throw new BootstrapNotAllowedError(
        `refusing: server address '${identity.addr}' is not local or private.`,
      );
    }
    const fingerprint = `${dbName}@${identity.addr ?? "unix"}:${identity.port ?? "?"}`;
    if (!confirmDb) {
      console.log(`Database will be: ${dbName}`);
      console.log(`Live fingerprint:  ${fingerprint}`);
      console.log(`Re-run with --confirm-db '${fingerprint}' to create, migrate and mark it.`);
      return;
    }
    if (confirmDb !== fingerprint) {
      throw new BootstrapNotAllowedError(
        `refusing: --confirm-db '${confirmDb}' does not equal live fingerprint '${fingerprint}'.`,
      );
    }

    const [exists] = await maintenance.$queryRaw<{ e: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${dbName}) AS e`;
    if (!exists.e) {
      await maintenance.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
      console.log(`created database ${dbName}`);
    } else {
      console.log(`database ${dbName} already exists — the emptiness check decides whether it may be marked`);
    }
  } finally {
    await maintenance.$disconnect();
  }

  const dbUrl = serverUrl!.replace(/\/[^/?]+(?=\?|$)/, `/${dbName}`);
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "inherit",
  });

  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  try {
    const res = await bootstrapDisposableDatabase(db, {
      token: token!,
      confirmDb: confirmDb!, // bootstrap recomputes <db>@<addr>:<port> itself
      disposableConfirmed: true,
    });
    console.log(`marked disposable: ${res.fingerprint}`);
    console.log(
      `Suites: MERGESHIP_TEST_DATABASE_URL='${dbUrl}' MERGESHIP_SHADOW_TOKEN='<token>' npx vitest run tests/...`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  if (err instanceof BootstrapNotAllowedError) {
    console.error(err.message);
    process.exit(2);
  }
  throw err;
});
