// ── Shared lease/ownership primitives ─────────────────────────────────────────
// Every ownership period (merge claim, work item, operation) has a unique
// token. Ownership-sensitive writes are conditional UPDATEs on
// (token, unexpired) and check the affected-row count; 0 rows means ownership
// was lost and the caller must stop without writing anything else.
//
// Protocol v2: leases give liveness and stale-write protection ONLY — they are
// never the reason a Shopify mutation is safe (see operation-store.server.ts).
//
// All "now" comparisons in raw SQL use the database WALL clock in UTC:
// (clock_timestamp() AT TIME ZONE 'UTC') — statement-time now() would freeze
// mid-transaction and is forbidden. Prisma stores TIMESTAMP(3) (without time
// zone) in UTC, and the session TimeZone is not guaranteed to be UTC — never
// compare lease columns with a JS Date or bare now()/CURRENT_TIMESTAMP.

import { Prisma, type PrismaClient } from "@prisma/client";

export class OwnershipLostError extends Error {
  name = "OwnershipLostError";
}

/** Thrown when a conflicting lock/operation blocks an operation create; the
 *  caller maps it to a contention outcome, never a failure. */
export class ClaimContentionError extends Error {
  name = "ClaimContentionError";
}

export const newLeaseToken = () => crypto.randomUUID();

/** 8-char Crockford base32 op token from 5 random bytes (e.g. 7K2Q9XHD). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const newOpToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out = CROCKFORD[Number(bits & 0x1fn)] + out;
    bits >>= 5n;
  }
  return out;
};

export const LEASE_TTL_MS = 90_000;

/** The current wall-clock time according to the database, in UTC. Never
 *  now() — statement-time timestamps freeze mid-transaction. */
export const DB_WALL = Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC')`;

/** The database wall clock `ms` milliseconds from now. */
export const dbWallPlus = (ms: number) =>
  Prisma.sql`(${DB_WALL} + ${ms} * interval '1 millisecond')`;

/** Interactive transaction for ownership-sensitive multi-statement work:
 *  bounded waits so a contending lock surfaces as an error (never a silent
 *  hang) and no statement can run away. Errors are transient — see
 *  isTransientDbError. */
export const withOwnershipTx = <T>(
  db: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> =>
  db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '2s'`);
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '5s'`);
      return fn(tx);
    },
    { timeout: 10_000, maxWait: 5_000 },
  );

const TRANSIENT_SQLSTATES = ["55P03", "57014", "40001", "40P01"];

/** True for lock_timeout (55P03), statement_timeout/ cancelled queries
 *  (57014), serialization failures (40001) and deadlocks (40P01) — including
 *  Prisma's P2010/P2034 wrappers. A transient error means the transaction did
 *  NOT commit: never interpret it as success or as a state change. */
export const isTransientDbError = (err: unknown): boolean => {
  const e = err as any;
  if (!e) return false;
  if (e.code === "P2034") return true; // interactive-transaction conflict/timeout
  return [e.meta?.code, e.code].some((c) => TRANSIENT_SQLSTATES.includes(c));
};
