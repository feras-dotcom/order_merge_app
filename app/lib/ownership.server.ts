// ── Shared lease/ownership primitives ─────────────────────────────────────────
// Every ownership period (merge claim, work item, journal operation) has a
// unique token. Ownership-sensitive writes are conditional UPDATEs on
// (token, unexpired) and check the affected-row count; 0 rows means ownership
// was lost and the caller must stop without writing anything else.
//
// All "now" comparisons in raw SQL use the database clock in UTC: Prisma
// stores TIMESTAMP(3) (without time zone) in UTC, and the session TimeZone of
// the database is not guaranteed to be UTC — never compare lease columns with
// a JS Date or bare now()/CURRENT_TIMESTAMP.

import { Prisma } from "@prisma/client";

export class OwnershipLostError extends Error {
  name = "OwnershipLostError";
}

export const newLeaseToken = () => crypto.randomUUID();

export const LEASE_TTL_MS = 90_000;

/** The current time according to the database, in UTC. */
export const DB_NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

/** The database clock `ms` milliseconds from now. */
export const dbNowPlus = (ms: number) =>
  Prisma.sql`(${DB_NOW} + ${ms} * interval '1 millisecond')`;
