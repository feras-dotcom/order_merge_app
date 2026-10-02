// Side-effect module: scripts import this BEFORE app/db.server so the
// process exits with a clear message instead of a Prisma env error when the
// operator has not exported DATABASE_URL.
if (!process.env.DATABASE_URL) {
  console.error(
    "error: DATABASE_URL is not set — export it (or run inside a Railway shell) before running this script.",
  );
  process.exit(2);
}
