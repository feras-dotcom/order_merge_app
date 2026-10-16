// Provision a fresh, independently verified disposable test database.
//
// This is the documented procedure for creating a database the destructive
// test suites (tests/*-pg, postgres-stores, two-process) are allowed to
// migrate and truncate. Test suites never create the marker themselves —
// they only verify one stamped by this script exists.
//
//   1. Start a NEW, dedicated disposable Postgres, published on loopback
//      ONLY (never on all interfaces), on a random unused host port, with
//      a random throwaway password (any local instance works; Docker is
//      the cleanest disposable option):
//        docker run -d -p 127.0.0.1:<port>:5432 \
//          -e POSTGRES_PASSWORD=<random> postgres:16
//   2. Pick a random operator token (never committed):
//        e.g. node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
//   3. Provision — use a literal 127.0.0.1 (or [::1]) host: DNS names,
//      including `localhost`, are refused because they can resolve to a
//      different address on each independent connection:
//        MERGESHIP_SHADOW_TOKEN=<token> npx vite-node --script scripts/test-db-provision.ts \
//          --server postgresql://postgres:<random>@127.0.0.1:<port>/postgres \
//          --name mergeship_test_x
//      The script prints the live fingerprint; re-run with
//      --confirm-db <fingerprint> to proceed.
//
//      The --script flag is REQUIRED: without it vite-node drops this
//      script's argv, and the script would print usage and exit nonzero
//      (it never silently no-ops).
//   4. Run the suites:
//        MERGESHIP_TEST_DATABASE_URL=postgresql://postgres:<random>@127.0.0.1:<port>/mergeship_test_x \
//        MERGESHIP_SHADOW_TOKEN=<token> npx vitest run tests/...
//
// This file is the CLI entry point only — it always runs main() when loaded,
// which is why the implementation lives in scripts/test-db-provision.impl.ts
// (importable without side effects). The full safety contract is documented
// there.
//
// Usage: npx vite-node --script scripts/test-db-provision.ts --server <maintenance-url> --name <mergeship_test_*> [--confirm-db <fingerprint>]

import {
  provisionDisposableTestDatabase,
  scrubCredentials,
} from "./test-db-provision.impl";
import { BootstrapNotAllowedError } from "../app/lib/shadow-db-bootstrap.server";

const args = process.argv.slice(2);
const get = (flag: string) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

const serverUrl = get("--server");
const dbName = get("--name");
const confirmDb = get("--confirm-db");
const token = process.env.MERGESHIP_SHADOW_TOKEN;

const usage =
  "usage: npx vite-node --script scripts/test-db-provision.ts " +
  "--server <maintenance-url> --name <mergeship_test_*> [--confirm-db <fingerprint>]";

async function main() {
  if (!serverUrl || !dbName) {
    console.error(usage);
    process.exit(2);
  }
  await provisionDisposableTestDatabase({ serverUrl, dbName, confirmDb, token });
}

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
