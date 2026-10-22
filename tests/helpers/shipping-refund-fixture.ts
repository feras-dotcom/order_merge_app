// §19.2.1 — the ONE test-only mechanism allowed to create a synthetic
// DISPATCHING row. It exists because the S1 transition graph deliberately
// lacks PREPARED -> DISPATCHING (I27): reconciliation tests need
// post-dispatch rows the runtime cannot make.
//
// Discipline (read this before touching anything):
//   - It accepts only a PreflightedDatabase brand — a bare URL, a hand-built
//     object or a self-constructed instance is rejected before any DDL.
//   - Before ANY write (the claim and freeze are writes), it verifies the
//     supplied client itself with read-only queries: the connected database
//     is the brand's database and server, still carries the operator's
//     disposable marker, and the role owns "ShippingRefund". A client
//     pointing anywhere else is refused with zero rows written (B-1).
//   - Inside the fixture transaction, on the very connection running the
//     DDL, it re-verifies: current_database() equals the brand's database
//     name and matches the disposable-name pattern; inet_server_addr() is
//     loopback/private and matches the brand's verified server identity;
//     the database still carries `mergeship-shadow-disposable:<token>` for
//     the operator's MERGESHIP_SHADOW_TOKEN; NODE_ENV is not production and
//     no RAILWAY_* variable is set; and the connected role is a member of
//     the table owner. Any failure aborts before any DDL.
//   - The row itself is created through the REAL store: claim to QUEUED,
//     then the real freeze to PREPARED. Only the one transition is
//     synthetic.
//   - The synthetic step suspends ONE named trigger — the transition guard,
//     spelled LITERALLY in the ALTER statements after a full structural
//     match on SHIPPING_REFUND_TRIGGER_MANIFEST entry 2 (index 1). The
//     architecture scan permits DISABLE/ENABLE TRIGGER only here and only
//     for that literal name; an interpolated name could never be proven to
//     target the same trigger and would fail the scan. Every other trigger
//     stays live and runs on the update — the evidence-integrity guard
//     permits the write only because it is exactly PREPARED -> DISPATCHING
//     with both dispatchToken and dispatchedAt set.
//   - Verification inside the same transaction: checkTriggerIntegrity over
//     TRIGGER_CATALOG_SQL must be intact (that query's read-only
//     current_setting('session_replication_role') is the helper's one
//     permitted reference to the setting — rule 10), the row must be
//     DISPATCHING with the intended evidence, and exactly one
//     PREPARED -> DISPATCHING event row must exist with actor
//     'test-fixture'. Any mismatch throws and rolls back EVERYTHING —
//     including the disable and the update.
//   - No other bypass exists here: no session_replication_role mutation,
//     no DISABLE ALL / ENABLE REPLICA / ENABLE ALWAYS, no TRUNCATE, no
//     DELETE, no second DISABLE/ENABLE.
//
// This module is imported by tests only — never by app/ or scripts/.

import crypto from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  DISPOSABLE_DB_NAME_PATTERN,
  assertNoProductionEnvironment,
  isLocalOrPrivateAddress,
} from "../../app/lib/shadow-db-bootstrap.server";
import { SHADOW_DB_MARKER_PREFIX } from "../../app/lib/shipping-shadow.server";
import {
  claimShippingRefund,
  freezeShippingRefund,
  type ShippingRefundFreezeInput,
} from "../../app/lib/shipping-refund-store.server";
import {
  SHIPPING_REFUND_TRIGGER_MANIFEST,
  TRIGGER_CATALOG_SQL,
  checkTriggerIntegrity,
  type ShippingRefundTriggerCatalogRow,
} from "../../app/lib/shipping-refund-trigger-manifest";
import {
  DisposablePreflightError,
  preflightedIdentity,
  type PreflightedDatabase,
} from "./disposable-db";

export class FixtureError extends Error {
  name = "FixtureError";
}

type Identity = ReturnType<typeof preflightedIdentity>;

/**
 * The read-only target verification of §19.2.1 step 2 — run on `query`,
 * which is bound either to the supplied client (BEFORE the real claim, so
 * a wrong-target client is refused with zero writes) or to the fixture
 * transaction's own connection (the spec's same-connection re-check ahead
 * of the DDL). A failure always throws DisposablePreflightError — never a
 * falsy verdict — and every check is a SELECT: calling it mutates nothing.
 */
async function verifyFixtureTarget(
  query: <T>(sql: string) => Promise<T>,
  identity: Identity,
  markerToken: string,
): Promise<void> {
  const [ident] = await query<
    { db: string; addr: string | null; port: number | null }[]
  >(
    `SELECT current_database() AS "db",
            host(inet_server_addr()) AS "addr",
            inet_server_port() AS "port"`,
  );
  if (
    !ident ||
    ident.db !== identity.dbName ||
    !DISPOSABLE_DB_NAME_PATTERN.test(ident.db)
  ) {
    throw new DisposablePreflightError(
      `fixture client is connected to '${ident?.db}' — expected the ` +
        `preflighted disposable database '${identity.dbName}'.`,
    );
  }
  if (ident.addr !== null && !isLocalOrPrivateAddress(ident.addr)) {
    throw new DisposablePreflightError(
      `fixture connection reached '${ident.addr}' — not a local or private server.`,
    );
  }
  if (ident.addr !== identity.addr || ident.port !== identity.port) {
    throw new DisposablePreflightError(
      `fixture connection identity '${ident.addr ?? "unix"}:${ident.port ?? "?"}' ` +
        `does not match the brand's '${identity.addr ?? "unix"}:${identity.port ?? "?"}' — refusing.`,
    );
  }
  const [marker] = await query<{ marker: string | null }[]>(
    `SELECT shobj_description(
       (SELECT oid FROM pg_database WHERE datname = current_database()),
       'pg_database') AS "marker"`,
  );
  if (marker?.marker !== `${SHADOW_DB_MARKER_PREFIX}${markerToken}`) {
    throw new DisposablePreflightError(
      "the database the fixture client is connected to does not carry the " +
        "operator's disposable marker — refusing.",
    );
  }
  const [privilege] = await query<
    { rel: string | null; member: boolean | null }[]
  >(
    `SELECT to_regclass('public."ShippingRefund"')::text AS "rel",
            pg_has_role(current_user,
              (SELECT relowner FROM pg_class
               WHERE oid = to_regclass('public."ShippingRefund"')),
              'MEMBER') AS "member"`,
  );
  if (privilege?.rel === null || privilege?.rel === undefined) {
    throw new DisposablePreflightError(
      'the connected database has no public."ShippingRefund" table — the ' +
        "fixture refuses a target without the S1 schema.",
    );
  }
  if (privilege.member !== true) {
    throw new DisposablePreflightError(
      "insufficient_privilege: the connected role does not own " +
        '"ShippingRefund" — the fixture fails before writing anything.',
    );
  }
}

/** Steps of the one synthetic transaction, for the injection hooks the
 *  required failure tests use. A hook that throws (or kills the
 *  connection) rolls the whole transaction back — that is the test. */
export type FixtureStep = "lock" | "disable" | "update" | "enable" | "verify";

export interface FixtureHooks {
  /** Runs inside the transaction immediately after the named step. Throw
   *  here to prove rollback; terminate the backend here to prove nothing
   *  leaks past a lost connection. */
  afterStep?: (
    step: FixtureStep,
    tx: Prisma.TransactionClient,
  ) => Promise<void> | void;
  /** Test seam replacing the helper's own statement executor for the two
   *  ALTER TABLE statements (e.g. a double that makes ENABLE a no-op so
   *  the verification step must catch the still-disabled trigger). */
  executeAlter?: (
    tx: Prisma.TransactionClient,
    sql: string,
    real: () => Promise<number>,
  ) => Promise<number>;
}

export interface DispatchedFixtureResult {
  readonly rowId: string;
  readonly dispatchToken: string;
  /** The instant stamped on dispatchedAt (ISO). */
  readonly dispatchedAt: string;
  /** Every SQL statement issued inside the synthetic transaction, in
   *  order — the test asserts the exact allowlist of §19.2.1 step 6. */
  readonly statements: readonly string[];
}

export interface DispatchedFixtureArgs {
  /** The MergeOperation row and secondary element the real claim consumes. */
  readonly operation: unknown;
  readonly secondary: unknown;
  /** The freeze input — or a builder given the claimed row's identifiers
   *  (the wire contract binds marker/idempotencyKey at freeze time). */
  readonly freeze:
    | ShippingRefundFreezeInput
    | ((ctx: {
        rowId: string;
        leaseToken: string;
        marker: string;
        idempotencyKey: string;
        sourceOrderId: string;
      }) => ShippingRefundFreezeInput | Promise<ShippingRefundFreezeInput>);
  /** The dispatchedAt instant (ISO). Defaults to the transaction's
   *  database wall clock. May precede preparedAt — a fixture row is
   *  synthetic and an aged dispatchedAt is exactly how the 120-second
   *  unanswered-dispatch sweep and the 12.5 absent windows are exercised
   *  without wall-clock waiting. It must not be in the future. */
  readonly dispatchedAt?: string;
  readonly hooks?: FixtureHooks;
  readonly log?: (line: string) => void;
}



export async function createDispatchedFixture(
  brand: PreflightedDatabase,
  db: PrismaClient,
  args: DispatchedFixtureArgs,
): Promise<DispatchedFixtureResult> {
  // ── Step 1: branded input — registry membership is the credential. ──
  const identity = preflightedIdentity(brand);
  assertNoProductionEnvironment(process.env);
  const markerToken = process.env.MERGESHIP_SHADOW_TOKEN;
  if (!markerToken || !/^[A-Za-z0-9_-]{8,128}$/.test(markerToken)) {
    throw new DisposablePreflightError(
      "MERGESHIP_SHADOW_TOKEN is absent or malformed — the fixture cannot " +
        "verify the disposable marker without it.",
    );
  }

  // ── Step 2a: target verification BEFORE any write (B-1). The supplied
  // client must be the very database the brand was issued for — the
  // claim and freeze below are writes, so identity, marker and privilege
  // are proven here with read-only queries first. A client connected to
  // any other database (marked or not) is refused with zero rows written.
  // Step 2b below re-runs the identical checks inside the fixture
  // transaction on the connection that executes the DDL. ──
  await verifyFixtureTarget(
    (sql) => db.$queryRawUnsafe(sql),
    identity,
    markerToken,
  );

  // ── Step 3: legal creation through the real store (insert guard and
  // freeze path both live). ──
  const log = args.log ?? (() => {});
  const claim = await claimShippingRefund(
    {
      operation: args.operation as never,
      secondary: args.secondary as never,
    },
    db,
    log,
  );
  if (!claim.claimed) {
    throw new FixtureError(`fixture claim refused (${claim.code})`);
  }
  const rowId = claim.rowId;
  const leaseToken = claim.leaseToken;
  if (leaseToken === null) {
    throw new FixtureError("fixture claim did not produce a lease");
  }
  const [claimed] = await db.$queryRaw<
    { marker: string; idempotencyKey: string; sourceOrderId: string }[]
  >`
    SELECT "marker", "idempotencyKey", "sourceOrderId"
    FROM "ShippingRefund" WHERE "id" = ${rowId}`;
  const freezeInput =
    typeof args.freeze === "function"
      ? await args.freeze({
          rowId,
          leaseToken,
          marker: claimed.marker,
          idempotencyKey: claimed.idempotencyKey,
          sourceOrderId: claimed.sourceOrderId,
        })
      : args.freeze;
  const frozen = await freezeShippingRefund(rowId, leaseToken, freezeInput, db);
  if (!frozen.frozen) {
    throw new FixtureError(`fixture freeze refused (${frozen.reason})`);
  }

  // ── Step 4: the one synthetic transition — one transaction, the named
  // trigger only, every safeguard but that one still live. ──
  // §19.2.1: the trigger name is manifest entry 2 (index 1), verified as
  // the exact transition-guard definition — the helper refuses any other
  // entry. The ALTER statements below must spell that one name literally:
  // the architecture scan permits DISABLE/ENABLE TRIGGER only here and only
  // for that name; an interpolated name would fail the scan and could never
  // be proven to target the same trigger.
  const entry = SHIPPING_REFUND_TRIGGER_MANIFEST[1];
  if (
    !entry ||
    entry.name !== "shippingrefund_transition_guard" ||
    entry.schema !== "public" ||
    entry.table !== "ShippingRefund" ||
    entry.timing !== "BEFORE" ||
    entry.level !== "ROW" ||
    entry.events.length !== 1 ||
    entry.events[0] !== "UPDATE" ||
    entry.functionName !== "shipping_refund_fn_transition_guard"
  ) {
    throw new FixtureError(
      "manifest entry 2 is not the expected transition-guard definition — " +
        "the fixture refuses to name any other trigger.",
    );
  }
  const statements: string[] = [];

  const result = await db.$transaction(
    async (tx) => {
      const run = async (sql: string) => {
        statements.push(sql);
        return tx.$executeRawUnsafe(sql);
      };
      const runAlter = async (sql: string) => {
        statements.push(sql);
        const real = () => tx.$executeRawUnsafe(sql);
        return args.hooks?.executeAlter
          ? args.hooks.executeAlter(tx, sql, real)
          : real();
      };
      const query = async <T>(sql: string): Promise<T> => {
        statements.push(sql);
        return tx.$queryRawUnsafe<T>(sql);
      };

      await run(`SET LOCAL lock_timeout = '2s'`);
      await run(`SET LOCAL statement_timeout = '10s'`);

      // ── Step 2b: same-connection verification (19.2.1 step 2) — the
      // identical read-only checks as step 2a, now on the very connection
      // that runs the DDL. ──
      await verifyFixtureTarget(query, identity, markerToken);

      await run(
        `SELECT set_config('mergeship.actor', 'test-fixture', true)`,
      );

      // ── Step 4.1: the table lock no other session can write past. ──
      await run(`LOCK TABLE "ShippingRefund" IN SHARE ROW EXCLUSIVE MODE`);
      await args.hooks?.afterStep?.("lock", tx);

      // ── Step 4.2: suspend the one named trigger. ──
      await runAlter(
        `ALTER TABLE "ShippingRefund" DISABLE TRIGGER "shippingrefund_transition_guard"`,
      );
      await args.hooks?.afterStep?.("disable", tx);

      // ── Step 4.3: exactly one PREPARED -> DISPATCHING update. ──
      const [head] = await query<
        { status: string; preparedAt: Date | null; wall: Date }[]
      >(
        `SELECT "status", "preparedAt",
                clock_timestamp() AT TIME ZONE 'UTC' AS "wall"
         FROM "ShippingRefund" WHERE "id" = '${rowId}'`,
      );
      if (!head || head.status !== "PREPARED" || !head.preparedAt) {
        throw new FixtureError(
          `fixture row ${rowId} is not PREPARED (status ${head?.status ?? "missing"})`,
        );
      }
      const dispatchedAt =
        args.dispatchedAt !== undefined
          ? new Date(args.dispatchedAt)
          : head.wall;
      if (!Number.isFinite(dispatchedAt.getTime())) {
        throw new FixtureError("dispatchedAt is not a finite instant");
      }
      if (dispatchedAt.getTime() > head.wall.getTime() + 1) {
        throw new FixtureError(
          "dispatchedAt is in the future — a dispatch cannot postdate now",
        );
      }
      const dispatchToken = crypto.randomUUID();
      statements.push(
        `UPDATE "ShippingRefund" SET status = 'DISPATCHING', dispatchedAt, dispatchToken WHERE id (bound)`,
      );
      const updated = await tx.$executeRaw`
        UPDATE "ShippingRefund" SET
          "status" = 'DISPATCHING',
          "dispatchedAt" = (${dispatchedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
          "dispatchToken" = ${dispatchToken},
          "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
        WHERE "id" = ${rowId}
          AND "status" = 'PREPARED'`;
      if (updated !== 1) {
        throw new FixtureError(
          `the fixture update touched ${updated} rows — exactly 1 required`,
        );
      }
      await args.hooks?.afterStep?.("update", tx);

      // ── Step 4.4: restore the named trigger. ──
      await runAlter(
        `ALTER TABLE "ShippingRefund" ENABLE TRIGGER "shippingrefund_transition_guard"`,
      );
      await args.hooks?.afterStep?.("enable", tx);

      // ── Step 4.5: verification (the read-only catalog query is the
      // helper's one permitted reference to session_replication_role). ──
      const integrity = await checkTriggerIntegrity(() =>
        query<readonly ShippingRefundTriggerCatalogRow[]>(
          TRIGGER_CATALOG_SQL,
        ),
      );
      if (!integrity.intact) {
        throw new FixtureError(
          `post-fixture catalog not intact: ${integrity.reasons
            .map((r) => `${r.code}${r.trigger ? `(${r.trigger})` : ""}`)
            .join(" ")}`,
        );
      }
      const [row] = await query<
        { status: string; dispatchToken: string | null; dispatchedAt: Date | null }[]
      >(
        `SELECT "status", "dispatchToken", "dispatchedAt" FROM "ShippingRefund" WHERE "id" = '${rowId}'`,
      );
      if (
        !row ||
        row.status !== "DISPATCHING" ||
        row.dispatchToken !== dispatchToken ||
        row.dispatchedAt === null
      ) {
        throw new FixtureError("post-fixture row is not DISPATCHING with its evidence");
      }
      const events = await query<
        { fromStatus: string | null; toStatus: string; actor: string }[]
      >(
        `SELECT "fromStatus", "toStatus", "actor"
         FROM "ShippingRefundEvent"
         WHERE "shippingRefundId" = '${rowId}' AND "toStatus" = 'DISPATCHING'`,
      );
      if (events.length !== 1 || events[0].fromStatus !== "PREPARED") {
        throw new FixtureError(
          "expected exactly one PREPARED -> DISPATCHING event row",
        );
      }
      if (events[0].actor !== "test-fixture") {
        throw new FixtureError(
          `the synthetic transition's actor is '${events[0].actor}', expected 'test-fixture'`,
        );
      }
      await args.hooks?.afterStep?.("verify", tx);

      return { dispatchToken, dispatchedAt: dispatchedAt.toISOString() };
    },
    { timeout: 30_000, maxWait: 15_000 },
  );

  return {
    rowId,
    dispatchToken: result.dispatchToken,
    dispatchedAt: result.dispatchedAt,
    statements,
  };
}
