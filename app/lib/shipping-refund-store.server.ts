// ── Shipping v0 Phase 2, S1-D: the store for the four refund tables ──────────
// docs/SHIPPING-PHASE2-DESIGN.md Revision 3.3: the admission claim transaction
// (7.5), its terminal-claim variants (7.2.1, 7.2.2, 7.4) and the minimal
// conditional lease operations for QUEUED rows (9.1 T1, 8.4).
//
// Scope boundary (19.5): this module contains NO scanner, no Shopify call, no
// freeze, no evaluation, no financial settlement and nothing that can create
// or advance a row into a dispatch-path status. The transition graph has no
// edge into it; the insert guard admits only QUEUED, SKIPPED, INELIGIBLE and
// REVIEW_REQUIRED.
//
// Discipline carried from the accepted modules:
//   - Every timestamp comparison uses the database UTC wall clock
//     (clock_timestamp() AT TIME ZONE 'UTC'); JS Dates bound to TIMESTAMP(3)
//     columns go through (?::timestamptz AT TIME ZONE 'UTC'), so a session in
//     a non-UTC time zone cannot shift anything.
//   - Every admission write is preceded, inside the same transaction, by the
//     canonical trigger-integrity check (3.2 rule 11, 5.4.7): the actual
//     non-internal trigger set must equal SHIPPING_REFUND_TRIGGER_MANIFEST
//     exactly, with full definitions and tgenabled='O'.
//   - Locks follow the section 4.10 order exactly: AppControl FOR SHARE,
//     Settings FOR SHARE, ShippingExecuteControl FOR SHARE, approval FOR
//     SHARE, then the insert. The event trigger (5.4.5) records insertion —
//     this module never writes ShippingRefundEvent rows itself.

import { Prisma, type PrismaClient } from "@prisma/client";
import defaultDb from "../db.server";
import {
  DB_WALL,
  OwnershipLostError,
  dbWallPlus,
  newLeaseToken,
  withOwnershipTx,
} from "./ownership.server";
import {
  admitShippingRefund,
  recheckShippingGate,
  validateOperationForClaim,
  type OperationClaimValidation,
  type ShippingAdmission,
  type ShippingGateLiveState,
  type ShippingLane,
} from "./shipping-refund-gate";
import {
  checkTriggerIntegrity,
  TRIGGER_CATALOG_SQL,
  type ShippingRefundTriggerCatalogRow,
  type TriggerIntegrityReason,
} from "./shipping-refund-trigger-manifest";
import { generateIdempotencyKey, generateMarker } from "./shipping-refund-contract";

/** The lease lifetime of section 9.1 T1: 180 seconds on the database clock. */
export const SHIPPING_REFUND_LEASE_TTL_MS = 180_000;

/** Initial statuses the claim may write (5.4.1 insert guard, 7.5). */
export type ClaimInsertStatus = "QUEUED" | "SKIPPED" | "INELIGIBLE" | "REVIEW_REQUIRED";

/** Actor recorded by the event trigger (5.4.5). */
const CLAIM_ACTOR = "shipping-refund-claim";
const TERMINAL_CLAIM_ACTOR = "shipping-refund-claim-terminal";
const LEASE_ACTOR = "shipping-refund-lease";

/** Session-local actor for the event writer. `null` records 'unknown'. */
const setActor = async (tx: Prisma.TransactionClient, actor: string | null): Promise<void> => {
  if (actor === null) return;
  if (!/^[\x20-\x7E]{1,128}$/.test(actor)) {
    throw new Error("actor must be at most 128 printable ASCII characters");
  }
  await tx.$queryRaw`SELECT set_config('mergeship.actor', ${actor}, true)`;
};

/** The 7.5 catalog preface: canonical integrity check, read-only (3.2 rule 11). */
const triggersIntact = async (tx: Prisma.TransactionClient) =>
  checkTriggerIntegrity(
    () => tx.$queryRawUnsafe<ShippingRefundTriggerCatalogRow[]>(TRIGGER_CATALOG_SQL),
  );

const readDbWall = async (tx: Prisma.TransactionClient): Promise<Date> => {
  const [row] = await tx.$queryRaw<{ wall: Date }[]>`
    SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "wall"`;
  return row.wall;
};

// ── The locked live-gate read (4.10 admission-claim order) ───────────────────

interface LockedLiveState {
  readonly live: ShippingGateLiveState;
}

/** Acquire the four FOR SHARE locks in section 4.10 order and read every
 *  live activation, control, policy and approval field needed by the gate.
 *  `revokedAt` is selected explicitly — a missing approval row maps to null
 *  (APPROVAL_MISSING), never an inferred value. Missing Settings/AppControl
 *  rows map to all-off values so the gate fails closed. */
const lockAndReadLiveState = async (
  tx: Prisma.TransactionClient,
  shop: string,
): Promise<LockedLiveState> => {
  const [app] = await tx.$queryRaw<
    {
      shippingAdjustmentsEnabled: boolean;
      shippingEnabledAt: Date | null;
      shippingAllowShops: string[];
    }[]
  >`
    SELECT "shippingAdjustmentsEnabled", "shippingEnabledAt", "shippingAllowShops"
    FROM "AppControl" WHERE "id" = 'control'
    FOR SHARE`;
  const [settings] = await tx.$queryRaw<
    {
      shippingAdjustmentEnabled: boolean;
      shippingAdjustmentEnabledAt: Date | null;
      shippingRolloutAt: Date | null;
      shippingPolicy: string;
    }[]
  >`
    SELECT "shippingAdjustmentEnabled", "shippingAdjustmentEnabledAt",
           "shippingRolloutAt", "shippingPolicy"
    FROM "Settings" WHERE "shop" = ${shop}
    FOR SHARE`;
  const [control] = await tx.$queryRaw<
    {
      admissionEnabled: boolean;
      admissionEnabledAt: Date | null;
      dispatchEnabled: boolean;
      dispatchEnabledAt: Date | null;
    }[]
  >`
    SELECT "admissionEnabled", "admissionEnabledAt", "dispatchEnabled", "dispatchEnabledAt"
    FROM "ShippingExecuteControl" WHERE "id" = 'control'
    FOR SHARE`;
  const [approval] = await tx.$queryRaw<
    {
      approvedAt: Date;
      revokedAt: Date | null;
      merchantOptInEpoch: Date;
      ackVersion: string;
    }[]
  >`
    SELECT "approvedAt", "revokedAt", "merchantOptInEpoch", "ackVersion"
    FROM "ShippingExecuteApproval" WHERE "shop" = ${shop}
    FOR SHARE`;

  return {
    live: {
      activation: {
        shippingAdjustmentsEnabled: app?.shippingAdjustmentsEnabled === true,
        shippingEnabledAt: app?.shippingEnabledAt ?? null,
        shippingAllowShops: Array.isArray(app?.shippingAllowShops)
          ? app.shippingAllowShops
          : [],
        shop,
        shippingRolloutAt: settings?.shippingRolloutAt ?? null,
        shopEnabled: settings?.shippingAdjustmentEnabled === true,
        enabledAt: settings?.shippingAdjustmentEnabledAt ?? null,
      },
      admissionEnabled: control?.admissionEnabled === true,
      admissionEnabledAt: control?.admissionEnabledAt ?? null,
      dispatchEnabled: control?.dispatchEnabled === true,
      dispatchEnabledAt: control?.dispatchEnabledAt ?? null,
      approval: approval
        ? {
            approvedAt: approval.approvedAt,
            revokedAt: approval.revokedAt,
            merchantOptInEpoch: approval.merchantOptInEpoch,
            ackVersion: approval.ackVersion,
          }
        : null,
      shippingPolicy: settings?.shippingPolicy ?? null,
    },
  };
};

// ── Claim outcomes ─────────────────────────────────────────────────────────

export type ShippingRefundClaim =
  | {
      readonly claimed: true;
      readonly rowId: string;
      readonly lane: ShippingLane;
      readonly status: ClaimInsertStatus;
      /** The 180-second claim lease token (QUEUED rows only; NULL lease on
       *  terminal rows). */
      readonly leaseToken: string | null;
    }
  | {
      /** The trigger set is not the manifest: refuse the cycle, write nothing. */
      readonly claimed: false;
      readonly code: "TRIGGERS_NOT_INTACT";
      readonly reasons: readonly TriggerIntegrityReason[];
    }
  | {
      /** 7.2.1 refusal: no valid key exists to write; nothing is inserted. */
      readonly claimed: false;
      readonly code: "UNCLAIMABLE";
      readonly validation: Extract<OperationClaimValidation, { outcome: "UNCLAIMABLE" }>;
    }
  | {
      /** The live gate is closed under the locks — no row is written (7.5). */
      readonly claimed: false;
      readonly code: "GATE_CLOSED";
      readonly gate: Extract<ShippingAdmission, { admitted: false }>;
    }
  | {
      /** ON CONFLICT DO NOTHING: another claimant already owns (shop, source). */
      readonly claimed: false;
      readonly code: "CONFLICT";
    };

export interface ShippingRefundClaimInput {
  /** The completed v2 merge operation as the scanner read it. Validated by
   *  7.2.1 inside the transaction — never trusted. */
  readonly operation: unknown;
  /** The one selected secondary ({ id, cancelledAt }). */
  readonly secondary: unknown;
  /** Optional actor for the event journal; defaults per entry point. */
  readonly actor?: string | null;
  /** Optional session time zone for the transaction (SET LOCAL). Bounded to
   *  a pg timezone-name shape; exists so tests can prove the UTC discipline. */
  readonly sessionTimeZone?: string;
}

export type ShippingRefundClaimLogger = (line: string) => void;
const defaultLog: ShippingRefundClaimLogger = (line) => console.error(line);

/** Bind an ISO instant into a naive-UTC TIMESTAMP(3). */
const naiveUtc = (iso: string | null) =>
  iso === null
    ? Prisma.sql`NULL`
    : Prisma.sql`(${iso}::timestamptz AT TIME ZONE 'UTC')`;

/** The one shared insert: the validated values, the snapshot about to be
 *  written (which IS the just-recomputed live gate under the locks), the
 *  claim-generated idempotency key and marker, attempts = 1 and a 180-second
 *  lease on the database wall clock. Every dispatch, response, refund,
 *  approval and frozen-wire column stays NULL (insert integrity, 5.3/5.4.1). */
const insertClaimRow = async (
  tx: Prisma.TransactionClient,
  args: {
    values: Extract<OperationClaimValidation, { outcome: "VALID" }>["values"];
    sourceCancelledAtIso: string | null;
    lane: ShippingLane;
    status: ClaimInsertStatus;
    reasonCode: string | null;
    reviewReason: string | null;
    admission: Extract<ShippingAdmission, { admitted: true }>;
  },
): Promise<{ rowId: string; leaseToken: string | null } | null> => {
  const { values, admission } = args;
  const s = admission.snapshot;
  const rowId = `sr_${crypto.randomUUID().replace(/-/g, "")}`;
  // Only a QUEUED row carries the 180-second claim lease (9.1 T1); a terminal
  // row must never look claimable — its lease columns stay NULL.
  const leased = args.status === "QUEUED";
  const leaseToken = leased ? newLeaseToken() : null;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "ShippingRefund" (
      "id", "shop", "mergeOperationId", "sourceOrderId", "primaryOrderId",
      "primaryOrderName", "operationCreatedAt", "sourceCancelledAt",
      "lane", "status", "reasonCode", "reviewReason",
      "merchantEpochAt", "rolloutEpochAt", "switchEpochAt",
      "activationCutoffAt", "admissionEpochAt", "admissionCutoffAt",
      "dispatchEpochAtAdmission",
      "approvalApprovedAt", "approvalOptInEpoch", "approvalAckVersion",
      "policyKind", "idempotencyKey", "marker",
      "leaseToken", "leasedUntil", "nextCheckAt", "attempts",
      "createdAt", "updatedAt"
    ) VALUES (
      ${rowId}, ${values.shop}, ${values.mergeOperationId}, ${values.sourceOrderId},
      ${values.primaryOrderId}, ${values.primaryOrderName},
      ${naiveUtc(values.operationCreatedAtIso)},
      ${naiveUtc(args.sourceCancelledAtIso)},
      ${args.lane}, ${args.status}, ${args.reasonCode}, ${args.reviewReason},
      ${naiveUtc(s.merchantEpochAt.toISOString())},
      ${naiveUtc(s.rolloutEpochAt.toISOString())},
      ${naiveUtc(s.switchEpochAt.toISOString())},
      ${naiveUtc(s.activationCutoffAt.toISOString())},
      ${naiveUtc(s.admissionEpochAt.toISOString())},
      ${naiveUtc(s.admissionCutoffAt.toISOString())},
      ${naiveUtc(s.dispatchEpochAtAdmission === null ? null : s.dispatchEpochAtAdmission.toISOString())},
      ${naiveUtc(s.approvalApprovedAt.toISOString())},
      ${naiveUtc(s.approvalOptInEpoch.toISOString())},
      ${s.approvalAckVersion},
      'REFUND_ALL', ${generateIdempotencyKey()}, ${generateMarker()},
      ${leaseToken}, ${leased ? dbWallPlus(SHIPPING_REFUND_LEASE_TTL_MS) : Prisma.sql`NULL`}, NULL, 1,
      ${DB_WALL}, ${DB_WALL}
    )
    ON CONFLICT ("shop", "sourceOrderId") DO NOTHING
    RETURNING "id"`;
  return rows.length === 1 ? { rowId: rows[0].id, leaseToken } : null;
};

/** Shared claim transaction body (7.5): integrity check, locks in order,
 *  validation, live-gate admission, conditional insert. */
const claimTx = async (
  tx: Prisma.TransactionClient,
  input: ShippingRefundClaimInput,
  terminal:
    | { readonly status: "SKIPPED" | "INELIGIBLE" | "REVIEW_REQUIRED"; readonly reasonCode: string; readonly reviewReason: string | null }
    | null,
  log: ShippingRefundClaimLogger,
): Promise<ShippingRefundClaim> => {
  // The canonical trigger-integrity check precedes every admission write
  // (3.2 rule 11). A missing, altered, disabled or unexpected trigger — or
  // a non-origin replication role — refuses the cycle entirely.
  const integrity = await triggersIntact(tx);
  if (!integrity.intact) {
    log("[shipping-refund] triggers-not-intact");
    return { claimed: false, code: "TRIGGERS_NOT_INTACT", reasons: integrity.reasons };
  }

  if (input.sessionTimeZone !== undefined) {
    if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(input.sessionTimeZone)) {
      throw new Error("sessionTimeZone is not a PostgreSQL time zone name");
    }
    await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${input.sessionTimeZone}'`);
  }
  await setActor(tx, input.actor ?? null);

  const dbWall = await readDbWall(tx);
  const validation = validateOperationForClaim(input.operation, input.secondary, dbWall);
  if (validation.outcome === "UNCLAIMABLE") {
    return { claimed: false, code: "UNCLAIMABLE", validation };
  }
  // A terminal claim needs a fully valid record including sourceCancelledAt
  // (7.2.2: the DATA_INVALID parking path is reached only after 7.2.1 passed).
  // The CANCELLED_AT_INVALID terminal row is produced exclusively through the
  // ordinary claim below, never through claimTerminalShippingRefund.
  if (terminal !== null && validation.outcome !== "VALID") {
    return {
      claimed: false,
      code: "UNCLAIMABLE",
      validation: {
        outcome: "UNCLAIMABLE",
        field: "secondary",
        reason: "SECONDARY_INVALID",
        detail:
          "terminal claim requires a fully validated record; cancelledAt was " +
          `${validation.cancelledAtInvalid ?? "invalid"}`,
        cancelledAtInvalid: validation.cancelledAtInvalid,
      },
    };
  }

  const shop = validation.values.shop;
  const { live } = await lockAndReadLiveState(tx, shop);
  const admission = admitShippingRefund(live, validation.values.operationCreatedAt);
  if (!admission.admitted) {
    return { claimed: false, code: "GATE_CLOSED", gate: admission };
  }

  const cancelled =
    validation.outcome === "VALID"
      ? validation.sourceCancelledAtIso
      : null;
  const status: ClaimInsertStatus =
    terminal?.status ??
    (validation.outcome === "CANCELLED_AT_INVALID" ? "REVIEW_REQUIRED" : "QUEUED");
  const reasonCode =
    terminal?.reasonCode ??
    (validation.outcome === "CANCELLED_AT_INVALID" ? "CANCELLED_AT_INVALID" : null);
  // 7.2.1: reviewReason holds only the cancelledAt reason name and the
  // truncated preview — no other operation data.
  const reviewReason =
    terminal?.reviewReason ??
    (validation.outcome === "CANCELLED_AT_INVALID"
      ? `${validation.cancelledAtInvalid}: ${validation.cancelledAtPreview}`
      : null);

  const inserted = await insertClaimRow(tx, {
    values: validation.values,
    sourceCancelledAtIso: cancelled,
    lane: admission.lane,
    status,
    reasonCode,
    reviewReason,
    admission,
  });
  if (inserted === null) return { claimed: false, code: "CONFLICT" };
  return {
    claimed: true,
    rowId: inserted.rowId,
    lane: admission.lane,
    status,
    leaseToken: inserted.leaseToken,
  };
};

/**
 * The §7.5 claim transaction. One transaction: trigger-integrity check;
 * AppControl, Settings, ShippingExecuteControl and approval rows read under
 * FOR SHARE in the section 4.10 order; the live gate recomputed and the
 * snapshot about to be written required to equal it by construction;
 * `validateOperationForClaim` before any insert; and
 * `INSERT ... ON CONFLICT ("shop","sourceOrderId") DO NOTHING`.
 *
 * A secondary whose `cancelledAt` fails 7.2.1 becomes the terminal
 * REVIEW_REQUIRED(CANCELLED_AT_INVALID) row with sourceCancelledAt NULL —
 * only when every other copied field is proven. An UNCLAIMABLE record, a
 * closed gate or a conflicting row writes nothing.
 *
 * No Shopify or network call happens inside (or around) the transaction.
 */
export function claimShippingRefund(
  input: ShippingRefundClaimInput,
  db: PrismaClient = defaultDb,
  log: ShippingRefundClaimLogger = defaultLog,
): Promise<ShippingRefundClaim> {
  const withActor = { ...input, actor: input.actor === undefined ? CLAIM_ACTOR : input.actor };
  return withOwnershipTx(db, (tx) => claimTx(tx, withActor, null, log));
}

/**
 * The §7.5 terminal-claim path (SKIPPED, INELIGIBLE, REVIEW_REQUIRED with an
 * explicit reason such as DATA_INVALID): the same locked transaction, the
 * same live-gate recomputation and the same conditional insert, differing
 * only in the terminal status and reason written. Requires the 7.2.1
 * validation to have fully passed — a terminal claim row carries a real
 * sourceCancelledAt.
 */
export function claimTerminalShippingRefund(
  input: ShippingRefundClaimInput,
  terminal: {
    readonly status: "SKIPPED" | "INELIGIBLE" | "REVIEW_REQUIRED";
    readonly reasonCode: string;
    readonly reviewReason?: string;
  },
  db: PrismaClient = defaultDb,
  log: ShippingRefundClaimLogger = defaultLog,
): Promise<ShippingRefundClaim> {
  const withActor = {
    ...input,
    actor: input.actor === undefined ? TERMINAL_CLAIM_ACTOR : input.actor,
  };
  return withOwnershipTx(db, (tx) =>
    claimTx(tx, withActor, { ...terminal, reviewReason: terminal.reviewReason ?? null }, log),
  );
}

// ── QUEUED-row lease operations (9.1 T1, 8.4) ───────────────────────────────

export type QueuedLeaseResult =
  | { readonly leased: true; readonly rowId: string; readonly leaseToken: string }
  | {
      readonly leased: false;
      readonly reason: "NOT_FOUND" | "NOT_QUEUED" | "LEASE_HELD" | "NOT_DUE";
    }
  | {
      /** The seven-day horizon passed: the row was aborted instead (7.4). */
      readonly leased: false;
      readonly reason: "HORIZON_EXPIRED";
    };

interface QueuedRowHead {
  readonly id: string;
  readonly status: string;
  readonly leaseToken: string | null;
  readonly leasedUntil: Date | null;
  readonly nextCheckAt: Date | null;
}

/**
 * Take the 180-second lease on a QUEUED row (9.1 T1): conditional on the row
 * still being QUEUED, its lease expired or absent and its nextCheckAt due —
 * all on the database UTC wall clock. The row is locked FOR UPDATE first so
 * a racing claimant waits, then loses cleanly.
 *
 * §8.4 horizon at lease: if DB_WALL has passed sourceCancelledAt + 7 days the
 * row is fenced-aborted to ABORTED(HORIZON_EXPIRED) in the same transaction
 * and no lease is granted. The abort is a lease-fenced update (8.4): it runs
 * only when no other owner holds an unexpired lease — a live foreign lease
 * returns LEASE_HELD before the horizon is even considered (S1-E F1).
 */
export function leaseQueuedShippingRefund(
  rowId: string,
  opts: { actor?: string | null; sessionTimeZone?: string } = {},
  db: PrismaClient = defaultDb,
): Promise<QueuedLeaseResult> {
  return withOwnershipTx(db, async (tx) => {
    if (opts.sessionTimeZone !== undefined) {
      if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(opts.sessionTimeZone)) {
        throw new Error("sessionTimeZone is not a PostgreSQL time zone name");
      }
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${opts.sessionTimeZone}'`);
    }
    await setActor(tx, opts.actor === undefined ? LEASE_ACTOR : opts.actor);

    const rows = await tx.$queryRaw<QueuedRowHead[]>`
      SELECT "id", "status", "leaseToken", "leasedUntil", "nextCheckAt"
      FROM "ShippingRefund" WHERE "id" = ${rowId}
      FOR UPDATE`;
    const row = rows[0];
    if (!row) return { leased: false, reason: "NOT_FOUND" };
    if (row.status !== "QUEUED") return { leased: false, reason: "NOT_QUEUED" };

    const [wall] = await tx.$queryRaw<{ wall: Date }[]>`
      SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "wall"`;
    // The ownership fence precedes every other outcome (S1-E F1): while a
    // lease is live the row belongs to its holder — the horizon is handled
    // only once the row can legitimately be acquired.
    if (row.leasedUntil !== null && row.leasedUntil.getTime() > wall.wall.getTime()) {
      return { leased: false, reason: "LEASE_HELD" };
    }

    // Seven-day horizon at lease (8.4), strictly greater-than on DB_WALL,
    // using the one shared predicate fragment (7.6.1).
    const [horizon] = await tx.$queryRaw<{ expired: boolean }[]>`
      SELECT ("sourceCancelledAt" IS NULL
              OR ${HORIZON_EXPIRED_PREDICATE(DB_WALL)}) AS "expired"
      FROM "ShippingRefund" WHERE "id" = ${rowId}`;
    if (horizon.expired) {
      await tx.$executeRaw`
        UPDATE "ShippingRefund" SET
          "status" = 'ABORTED', "reasonCode" = 'HORIZON_EXPIRED',
          "leaseToken" = NULL, "leasedUntil" = NULL, "nextCheckAt" = NULL,
          "updatedAt" = ${DB_WALL}
        WHERE "id" = ${rowId} AND "status" = 'QUEUED'`;
      return { leased: false, reason: "HORIZON_EXPIRED" };
    }

    if (row.nextCheckAt !== null && row.nextCheckAt.getTime() > wall.wall.getTime()) {
      return { leased: false, reason: "NOT_DUE" };
    }

    const leaseToken = newLeaseToken();
    const updated = await tx.$executeRaw`
      UPDATE "ShippingRefund" SET
        "leaseToken" = ${leaseToken},
        "leasedUntil" = ${dbWallPlus(SHIPPING_REFUND_LEASE_TTL_MS)},
        "updatedAt" = ${DB_WALL}
      WHERE "id" = ${rowId}
        AND "status" = 'QUEUED'
        AND ("leasedUntil" IS NULL OR "leasedUntil" <= ${DB_WALL})
        AND "sourceCancelledAt" IS NOT NULL
        AND NOT ${HORIZON_EXPIRED_PREDICATE(DB_WALL)}`;
    if (updated !== 1) return { leased: false, reason: "NOT_QUEUED" };
    return { leased: true, rowId, leaseToken };
  });
}

/**
 * Renew the lease of a QUEUED row held with `token` (9.1 T1). Lock-then-
 * validate: the SELECT ... FOR UPDATE waits first, then the conditional
 * UPDATE re-checks the token and the unexpired lease. A stale token, an
 * expired lease or a row taken over by another claimant throws
 * OwnershipLostError and changes nothing.
 */
export function renewQueuedShippingRefundLease(
  rowId: string,
  leaseToken: string,
  db: PrismaClient = defaultDb,
): Promise<void> {
  return withOwnershipTx(db, async (tx) => {
    await tx.$queryRaw`
      SELECT "id" FROM "ShippingRefund" WHERE "id" = ${rowId} FOR UPDATE`;
    const updated = await tx.$executeRaw`
      UPDATE "ShippingRefund" SET
        "leasedUntil" = ${dbWallPlus(SHIPPING_REFUND_LEASE_TTL_MS)},
        "updatedAt" = ${DB_WALL}
      WHERE "id" = ${rowId}
        AND "status" = 'QUEUED'
        AND "leaseToken" = ${leaseToken}
        AND "leasedUntil" > ${DB_WALL}`;
    if (updated !== 1) {
      throw new OwnershipLostError(`shipping-refund lease lost for row ${rowId}`);
    }
  });
}

/**
 * Release a QUEUED row's lease held with `token` (clears leaseToken and
 * leasedUntil so the row becomes claimable/due again). A stale token simply
 * does not match and returns false — it never throws and never clears
 * another owner's lease.
 */
export function releaseQueuedShippingRefundLease(
  rowId: string,
  leaseToken: string,
  db: PrismaClient = defaultDb,
): Promise<boolean> {
  return withOwnershipTx(db, async (tx) => {
    await tx.$queryRaw`
      SELECT "id" FROM "ShippingRefund" WHERE "id" = ${rowId} FOR UPDATE`;
    const updated = await tx.$executeRaw`
      UPDATE "ShippingRefund" SET
        "leaseToken" = NULL, "leasedUntil" = NULL, "updatedAt" = ${DB_WALL}
      WHERE "id" = ${rowId}
        AND "status" = 'QUEUED'
        AND "leaseToken" = ${leaseToken}`;
    return updated === 1;
  });
}

// ── S1-E: scanner queries, due rows, settle and the §8.3 freeze ────────────
// docs/SHIPPING-PHASE2-DESIGN.md Revision 3.3: the bounded selection queries
// (7.2), the due-row query (7.2 second query), the malformed-operations
// listing (7.2.2), lease-fenced non-money settlements (7.4/7.5), the atomic
// freeze (8.3) and the PREPARED horizon sweep (7.6.1).
//
// Every query here is either a plain unlocked SELECT (3.2 rule 4 — merge
// tables are read-only for this module and only become writes inside the
// S1-D claim transactions above) or a lock-then-validate update inside
// withOwnershipTx. Nothing here calls Shopify, nothing writes a
// dispatch-path status and nothing references ShippingAdjustment.

export const SHIPPING_REFUND_SCAN_PAGE_SIZE = 50;
export const SHIPPING_REFUND_DUE_ROW_LIMIT = 25;
export const SHIPPING_REFUND_MALFORMED_REPORT_LIMIT = 25;
export const SHIPPING_REFUND_EVAL_RETRY_MS = 300_000;
export const SHIPPING_REFUND_MAX_ATTEMPTS = 8;
export const SWEEP_PREPARED_HORIZON_DEFAULT_LIMIT = 100;
export const SWEEP_PREPARED_HORIZON_MAX_LIMIT = 500;

const SETTLE_ACTOR = "shipping-refund-settle";
const FREEZE_ACTOR = "shipping-refund-freeze";
const SCHEDULE_ACTOR = "shipping-refund-scheduler";
const SWEEP_ACTOR = "sweep-prepared-horizon";

/**
 * The one seven-day horizon predicate (7.6.1): the only `<now>` expression
 * ever bound in production is `clock_timestamp() AT TIME ZONE 'UTC'`. The
 * sweep selection, the QUEUED lease check and the freeze re-validation all
 * use this same fragment; deterministic boundary tests execute it as a
 * plain SELECT with literal binds. No clock-override exists anywhere.
 */
export const HORIZON_EXPIRED_PREDICATE = (nowExpr: Prisma.Sql): Prisma.Sql =>
  Prisma.sql`${nowExpr} > "sourceCancelledAt" + INTERVAL '7 days'`;

// ── Scanner selection reads (plain SELECTs, 3.2 rule 4) ────────────────────

export interface ScanOperationRow {
  readonly id: string;
  readonly shop: string;
  readonly protocolVersion: number;
  readonly phase: string | null;
  readonly calculatedOrderId: string | null;
  readonly opToken: string | null;
  readonly primaryOrderId: string;
  readonly primaryOrderName: string;
  readonly createdAt: Date;
  readonly secondaries: unknown;
  readonly expectedTransfer: unknown;
  readonly appliedEvidence: unknown;
  readonly sideEffectsDone: boolean;
}

const SCAN_OP_COLUMNS = Prisma.sql`
  op."id", op."shop", op."protocolVersion", op."phase", op."calculatedOrderId",
  op."opToken", op."primaryOrderId", op."primaryOrderName", op."createdAt",
  op."secondaries", op."expectedTransfer", op."appliedEvidence",
  op."sideEffectsDone"`;

/**
 * The §7.2 selection, verbatim semantics: native-v2 COMPLETED operations
 * with sideEffectsDone, at/after the admission cutoff, a well-formed
 * primary GID, at least one well-formed unclaimed secondary inside the
 * JSON — keyset-paged on (createdAt, id), 50 per page. The inner NOT EXISTS
 * names ShippingRefund only; ShippingAdjustment is never referenced.
 */
export function selectScanOperations(
  shop: string,
  admissionCutoff: Date,
  cursor: { readonly createdAt: Date; readonly id: string },
  limit: number = SHIPPING_REFUND_SCAN_PAGE_SIZE,
  db: PrismaClient = defaultDb,
): Promise<ScanOperationRow[]> {
  return db.$queryRaw<ScanOperationRow[]>`
    SELECT ${SCAN_OP_COLUMNS}
    FROM "MergeOperation" op
    WHERE op."shop" = ${shop}
      AND op."protocolVersion" = 2
      AND op."calculatedOrderId" IS NOT NULL
      AND op."phase" = 'COMPLETED'
      AND op."sideEffectsDone" = true
      AND op."createdAt" >= (${admissionCutoff}::timestamptz AT TIME ZONE 'UTC')
      AND op."primaryOrderId" ~ '^gid://shopify/Order/[0-9]+$'
      AND (op."createdAt", op."id") > (${cursor.createdAt}::timestamptz AT TIME ZONE 'UTC', ${cursor.id})
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(op."secondaries") = 'array'
               THEN op."secondaries" ELSE '[]'::jsonb END) s
        WHERE jsonb_typeof(s) = 'object'
          AND jsonb_typeof(s->'id') = 'string'
          AND (s->>'id') ~ '^gid://shopify/Order/[0-9]+$'
          AND (s->>'id') <> op."primaryOrderId"
          AND NOT EXISTS (
            SELECT 1 FROM "ShippingRefund" sr
            WHERE sr."shop" = op."shop" AND sr."sourceOrderId" = (s->>'id')
          )
      )
    ORDER BY op."createdAt" ASC, op."id" ASC
    LIMIT ${limit}`;
}

export interface MalformedOperationDefect {
  readonly operationId: string;
  readonly secondaryIndex: number | null;
  readonly defect:
    | "primary-order-id-invalid"
    | "secondaries-not-array"
    | "element-not-object"
    | "id-not-a-string"
    | "id-not-a-gid"
    | "id-equals-primary";
}

/**
 * The §7.2.2 malformed-operations listing (bounded 25): v2 COMPLETED
 * operations at/after the cutoff failing a structural guard. Claim-path
 * defects (cancelled-at-invalid, secondary-error,
 * source-claimed-by-other-operation) are reported by the scan's own
 * accounting — SQL cannot see them.
 */
export function findMalformedOperations(
  shop: string,
  admissionCutoff: Date,
  limit: number = SHIPPING_REFUND_MALFORMED_REPORT_LIMIT,
  db: PrismaClient = defaultDb,
): Promise<MalformedOperationDefect[]> {
  return db.$queryRaw<MalformedOperationDefect[]>`
    WITH ops AS (
      SELECT op."id" AS opid, op."primaryOrderId" AS pid,
             op."secondaries" AS secs, op."createdAt" AS created
      FROM "MergeOperation" op
      WHERE op."shop" = ${shop}
        AND op."protocolVersion" = 2
        AND op."calculatedOrderId" IS NOT NULL
        AND op."phase" = 'COMPLETED'
        AND op."sideEffectsDone" = true
        AND op."createdAt" >= (${admissionCutoff}::timestamptz AT TIME ZONE 'UTC')
    )
    SELECT opid AS "operationId", NULL::int AS "secondaryIndex",
           'primary-order-id-invalid' AS "defect", created
    FROM ops WHERE NOT (pid ~ '^gid://shopify/Order/[0-9]+$')
    UNION ALL
    SELECT opid, NULL::int, 'secondaries-not-array', created
    FROM ops WHERE jsonb_typeof(secs) IS DISTINCT FROM 'array'
    UNION ALL
    SELECT ops.opid, (e.ord - 1)::int,
      CASE
        WHEN jsonb_typeof(e.el) <> 'object' THEN 'element-not-object'
        WHEN jsonb_typeof(e.el->'id') IS DISTINCT FROM 'string' THEN 'id-not-a-string'
        WHEN NOT ((e.el->>'id') ~ '^gid://shopify/Order/[0-9]+$') THEN 'id-not-a-gid'
        ELSE 'id-equals-primary'
      END,
      ops.created
    FROM ops,
      LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(ops.secs) = 'array'
             THEN ops.secs ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS e(el, ord)
    WHERE jsonb_typeof(e.el) <> 'object'
       OR jsonb_typeof(e.el->'id') IS DISTINCT FROM 'string'
       OR NOT ((e.el->>'id') ~ '^gid://shopify/Order/[0-9]+$')
       OR (e.el->>'id') = ops.pid
    ORDER BY "created" ASC, "operationId" ASC, "secondaryIndex" ASC NULLS FIRST
    LIMIT ${limit}`;
}

/** The §7.2 second query: due QUEUED rows (nextCheckAt due or NULL,
 *  expired/absent lease), NULLS FIRST, bounded 25. */
export interface DueQueuedRow {
  readonly id: string;
  readonly shop: string;
  readonly mergeOperationId: string;
  readonly sourceOrderId: string;
  readonly primaryOrderId: string;
  readonly primaryOrderName: string;
  readonly lane: string;
  readonly status: string;
  readonly marker: string;
  readonly idempotencyKey: string;
  readonly sourceCancelledAt: Date | null;
  readonly nextCheckAt: Date | null;
  readonly attempts: number;
}

export function listDueQueuedShippingRefunds(
  shop: string,
  limit: number = SHIPPING_REFUND_DUE_ROW_LIMIT,
  db: PrismaClient = defaultDb,
): Promise<DueQueuedRow[]> {
  return db.$queryRaw<DueQueuedRow[]>`
    SELECT "id", "shop", "mergeOperationId", "sourceOrderId", "primaryOrderId",
           "primaryOrderName", "lane", "status", "marker", "idempotencyKey",
           "sourceCancelledAt", "nextCheckAt", "attempts"
    FROM "ShippingRefund"
    WHERE "shop" = ${shop}
      AND "status" = 'QUEUED'
      AND ("nextCheckAt" IS NULL OR "nextCheckAt" <= ${DB_WALL})
      AND ("leasedUntil" IS NULL OR "leasedUntil" < ${DB_WALL})
    ORDER BY "nextCheckAt" ASC NULLS FIRST
    LIMIT ${limit}`;
}

/** A MergeOperation row as the scanner read it — used for the due-row
 *  re-evaluation path, which must rebuild the operation/secondary evidence
 *  for an already-claimed row. */
export function loadScanOperation(
  shop: string,
  operationId: string,
  db: PrismaClient = defaultDb,
): Promise<ScanOperationRow | null> {
  return db
    .$queryRaw<ScanOperationRow[]>`
      SELECT op."id", op."shop", op."protocolVersion", op."phase",
             op."calculatedOrderId", op."opToken", op."primaryOrderId",
             op."primaryOrderName", op."createdAt", op."secondaries",
             op."expectedTransfer", op."appliedEvidence", op."sideEffectsDone"
      FROM "MergeOperation" op
      WHERE op."shop" = ${shop} AND op."id" = ${operationId}`
    .then((rows) => rows[0] ?? null);
}

/** MergeRecord rows for the given secondaries (plain read). */
export function listMergeRecordsForSecondaries(
  shop: string,
  secondaryIds: readonly string[],
  db: PrismaClient = defaultDb,
): Promise<{ mergedOrderId: string; primaryOrderId: string; operationId: string | null }[]> {
  if (secondaryIds.length === 0) return Promise.resolve([]);
  return db.$queryRaw`
    SELECT "mergedOrderId", "primaryOrderId", "operationId"
    FROM "MergeRecord"
    WHERE "shop" = ${shop}
      AND "mergedOrderId" IN (${Prisma.join(secondaryIds)})`;
}

/** MergeMutationAttempt rows for the given operations (plain read). */
export function listMergeAttemptsForOperations(
  operationIds: readonly string[],
  db: PrismaClient = defaultDb,
): Promise<{ operationId: string; kind: string; targetOrderId: string; state: string }[]> {
  if (operationIds.length === 0) return Promise.resolve([]);
  return db.$queryRaw`
    SELECT "operationId", "kind", "targetOrderId", "state"
    FROM "MergeMutationAttempt"
    WHERE "operationId" IN (${Prisma.join(operationIds)})`;
}

/** Existing ShippingRefund rows for the given sources (plain read; the
 *  scan needs sourceOrderId plus the owning mergeOperationId for the
 *  source-claimed-by-other-operation report). */
export function listShippingRefundsForSources(
  shop: string,
  sourceOrderIds: readonly string[],
  db: PrismaClient = defaultDb,
): Promise<{ sourceOrderId: string; mergeOperationId: string; status: string }[]> {
  if (sourceOrderIds.length === 0) return Promise.resolve([]);
  return db.$queryRaw`
    SELECT "sourceOrderId", "mergeOperationId", "status"
    FROM "ShippingRefund"
    WHERE "shop" = ${shop}
      AND "sourceOrderId" IN (${Prisma.join(sourceOrderIds)})`;
}

/** The advisory (unlocked) live-gate read for the scanner's E4 evaluation.
 *  The claim and the freeze re-read everything under the §4.10 locks — this
 *  read only decides whether a scan is worth attempting and which cutoff
 *  the selection SQL binds. */
export async function readAdvisoryGateState(
  shop: string,
  db: PrismaClient = defaultDb,
): Promise<ShippingGateLiveState> {
  const [app] = await db.$queryRaw<
    {
      shippingAdjustmentsEnabled: boolean;
      shippingEnabledAt: Date | null;
      shippingAllowShops: string[];
    }[]
  >`
    SELECT "shippingAdjustmentsEnabled", "shippingEnabledAt", "shippingAllowShops"
    FROM "AppControl" WHERE "id" = 'control'`;
  const [settings] = await db.$queryRaw<
    {
      shippingAdjustmentEnabled: boolean;
      shippingAdjustmentEnabledAt: Date | null;
      shippingRolloutAt: Date | null;
      shippingPolicy: string;
    }[]
  >`
    SELECT "shippingAdjustmentEnabled", "shippingAdjustmentEnabledAt",
           "shippingRolloutAt", "shippingPolicy"
    FROM "Settings" WHERE "shop" = ${shop}`;
  const [control] = await db.$queryRaw<
    {
      admissionEnabled: boolean;
      admissionEnabledAt: Date | null;
      dispatchEnabled: boolean;
      dispatchEnabledAt: Date | null;
    }[]
  >`
    SELECT "admissionEnabled", "admissionEnabledAt", "dispatchEnabled", "dispatchEnabledAt"
    FROM "ShippingExecuteControl" WHERE "id" = 'control'`;
  const [approval] = await db.$queryRaw<
    { approvedAt: Date; revokedAt: Date | null; merchantOptInEpoch: Date; ackVersion: string }[]
  >`
    SELECT "approvedAt", "revokedAt", "merchantOptInEpoch", "ackVersion"
    FROM "ShippingExecuteApproval" WHERE "shop" = ${shop}`;

  return {
    activation: {
      shippingAdjustmentsEnabled: app?.shippingAdjustmentsEnabled === true,
      shippingEnabledAt: app?.shippingEnabledAt ?? null,
      shippingAllowShops: Array.isArray(app?.shippingAllowShops) ? app.shippingAllowShops : [],
      shop,
      shippingRolloutAt: settings?.shippingRolloutAt ?? null,
      shopEnabled: settings?.shippingAdjustmentEnabled === true,
      enabledAt: settings?.shippingAdjustmentEnabledAt ?? null,
    },
    admissionEnabled: control?.admissionEnabled === true,
    admissionEnabledAt: control?.admissionEnabledAt ?? null,
    dispatchEnabled: control?.dispatchEnabled === true,
    dispatchEnabledAt: control?.dispatchEnabledAt ?? null,
    approval: approval
      ? {
          approvedAt: approval.approvedAt,
          revokedAt: approval.revokedAt,
          merchantOptInEpoch: approval.merchantOptInEpoch,
          ackVersion: approval.ackVersion,
        }
      : null,
    shippingPolicy: settings?.shippingPolicy ?? null,
  };
}

// ── Lease-fenced non-money settlements (7.4/7.5) ───────────────────────────

export type NonMoneyStatus = "SKIPPED" | "INELIGIBLE" | "REVIEW_REQUIRED" | "ABORTED";

const NON_MONEY_STATUSES = new Set<NonMoneyStatus>([
  "SKIPPED",
  "INELIGIBLE",
  "REVIEW_REQUIRED",
  "ABORTED",
]);

/**
 * Settle a QUEUED row to a non-money terminal status while holding
 * `leaseToken` (7.5: a lease-fenced update, no new gate check — these
 * states authorize nothing). Lock-then-validate: FOR UPDATE first, then the
 * token-and-live-lease conditional UPDATE on the database clock; a lost
 * lease throws OwnershipLostError.
 */
export function settleQueuedShippingRefund(
  rowId: string,
  leaseToken: string,
  outcome: {
    readonly status: NonMoneyStatus;
    readonly reasonCode: string | null;
    readonly reviewReason?: string | null;
  },
  db: PrismaClient = defaultDb,
): Promise<void> {
  if (!NON_MONEY_STATUSES.has(outcome.status)) {
    throw new Error(`settleQueuedShippingRefund cannot write status ${outcome.status}`);
  }
  return withOwnershipTx(db, async (tx) => {
    await setActor(tx, SETTLE_ACTOR);
    await tx.$queryRaw`
      SELECT "id" FROM "ShippingRefund" WHERE "id" = ${rowId} FOR UPDATE`;
    const updated = await tx.$executeRaw`
      UPDATE "ShippingRefund" SET
        "status" = ${outcome.status},
        "reasonCode" = ${outcome.reasonCode},
        "reviewReason" = ${outcome.reviewReason ?? null},
        "leaseToken" = NULL, "leasedUntil" = NULL, "nextCheckAt" = NULL,
        "updatedAt" = ${DB_WALL}
      WHERE "id" = ${rowId}
        AND "status" = 'QUEUED'
        AND "leaseToken" = ${leaseToken}
        AND "leasedUntil" > ${DB_WALL}`;
    if (updated !== 1) {
      throw new OwnershipLostError(`shipping-refund lease lost for row ${rowId}`);
    }
  });
}

export type EvaluationRetryResult =
  | { readonly rescheduled: true }
  | { readonly rescheduled: false; readonly exhausted: true };

/**
 * Record a transient evaluation failure on a QUEUED row (7.4): reschedule
 * `nextCheckAt` five minutes out on the database clock and increment
 * `attempts`; once the row reaches its 8-attempt budget it settles
 * `INELIGIBLE(EVAL_UNAVAILABLE)` instead. The lease is released either way
 * so the due-row query (or a later scan) owns the next attempt. Lock-then-
 * validate on the held token; a lost lease throws OwnershipLostError.
 */
export function recordEvaluationFailure(
  rowId: string,
  leaseToken: string,
  db: PrismaClient = defaultDb,
  exhaustedReasonCode: string = "EVAL_UNAVAILABLE",
): Promise<EvaluationRetryResult> {
  return withOwnershipTx(db, async (tx) => {
    await setActor(tx, SCHEDULE_ACTOR);
    const [row] = await tx.$queryRaw<{ attempts: number }[]>`
      SELECT "attempts" FROM "ShippingRefund" WHERE "id" = ${rowId} FOR UPDATE`;
    if (!row) throw new OwnershipLostError(`shipping-refund row ${rowId} vanished`);
    if (row.attempts >= SHIPPING_REFUND_MAX_ATTEMPTS) {
      const settled = await tx.$executeRaw`
        UPDATE "ShippingRefund" SET
          "status" = 'INELIGIBLE', "reasonCode" = ${exhaustedReasonCode},
          "leaseToken" = NULL, "leasedUntil" = NULL, "nextCheckAt" = NULL,
          "updatedAt" = ${DB_WALL}
        WHERE "id" = ${rowId}
          AND "status" = 'QUEUED'
          AND "leaseToken" = ${leaseToken}
          AND "leasedUntil" > ${DB_WALL}`;
      if (settled !== 1) {
        throw new OwnershipLostError(`shipping-refund lease lost for row ${rowId}`);
      }
      return { rescheduled: false, exhausted: true };
    }
    const updated = await tx.$executeRaw`
      UPDATE "ShippingRefund" SET
        "attempts" = "attempts" + 1,
        "nextCheckAt" = ${dbWallPlus(SHIPPING_REFUND_EVAL_RETRY_MS)},
        "leaseToken" = NULL, "leasedUntil" = NULL,
        "updatedAt" = ${DB_WALL}
      WHERE "id" = ${rowId}
        AND "status" = 'QUEUED'
        AND "leaseToken" = ${leaseToken}
        AND "leasedUntil" > ${DB_WALL}`;
    if (updated !== 1) {
      throw new OwnershipLostError(`shipping-refund lease lost for row ${rowId}`);
    }
    return { rescheduled: true };
  });
}

// ── The §8.3 atomic freeze ─────────────────────────────────────────────────

export interface ShippingRefundFreezeInput {
  /** The adapter's FrozenWireContract — written verbatim, once. */
  readonly contract: {
    readonly documentSha256: string;
    readonly mutationVersion: string;
    readonly wireVariables: unknown;
    readonly wireHash: string;
  };
  readonly financialColumns: {
    readonly currencyCode: string;
    readonly plannedShippingMinor: string;
    readonly parentTransactionId: string;
    readonly gateway: string;
  };
  /** The §8.2.6 evidence JSON (secondary aggregates, refund count,
   *  transaction ids, capture/authorization ids, the baseline). */
  readonly preEvidence: unknown;
}

export type ShippingRefundFreezeResult =
  | { readonly frozen: true; readonly status: "PREPARED" | "OBSERVED" }
  | {
      readonly frozen: false;
      /** OWNERSHIP_LOST: token mismatch or expired lease — the caller must
       *  treat the row as owned elsewhere and write nothing. NOT_QUEUED:
       *  the row already settled. HORIZON_EXPIRED/GATE_CHANGED: the row was
       *  aborted inside this transaction (7.4/8.3). */
      readonly reason: "OWNERSHIP_LOST" | "NOT_QUEUED" | "HORIZON_EXPIRED" | "GATE_CHANGED";
      readonly detail?: string;
    };

interface FrozenRowHead {
  readonly id: string;
  readonly shop: string;
  readonly status: string;
  readonly lane: string;
  readonly leaseToken: string | null;
  readonly leasedUntil: Date | null;
  readonly sourceCancelledAt: Date | null;
  readonly merchantEpochAt: Date;
  readonly rolloutEpochAt: Date;
  readonly switchEpochAt: Date;
  readonly activationCutoffAt: Date;
  readonly admissionEpochAt: Date;
  readonly admissionCutoffAt: Date;
  readonly dispatchEpochAtAdmission: Date | null;
  readonly approvalApprovedAt: Date;
  readonly approvalOptInEpoch: Date;
  readonly approvalAckVersion: string;
}

/**
 * The §8.3 freeze: the only path to PREPARED and to OBSERVED.
 *
 * One transaction: lock the existing row FOR UPDATE; verify the caller's
 * lease token and its unexpired lease on the database clock; enforce the
 * seven-day horizon (an expired QUEUED row is aborted instead, 8.4); take
 * the §4.10 FOR SHARE locks and recompute the entire live gate, requiring
 * every individual epoch to equal the stored snapshot (a gate that closed
 * or changed mid-evaluation aborts the row GATE_CHANGED); then ONE
 * conditional UPDATE writes all frozen financial and wire columns together
 * with preparedAt and the lane's status — under a WHERE that still requires
 * QUEUED, the token, the live lease and an unexpired horizon.
 *
 * OBSERVED records carry the same frozen columns and never become
 * executable (dispatchEpochAtAdmission stays NULL for the lane); PREPARED
 * records carry no dispatch evidence — every dispatch/response/refund
 * column remains NULL because the UPDATE does not touch them and the
 * evidence-integrity trigger (5.4.4) proves it.
 */
export function freezeShippingRefund(
  rowId: string,
  leaseToken: string,
  frozen: ShippingRefundFreezeInput,
  db: PrismaClient = defaultDb,
): Promise<ShippingRefundFreezeResult> {
  return withOwnershipTx(db, async (tx) => {
    await setActor(tx, FREEZE_ACTOR);

    const rows = await tx.$queryRaw<FrozenRowHead[]>`
      SELECT "id", "shop", "status", "lane", "leaseToken", "leasedUntil",
             "sourceCancelledAt",
             "merchantEpochAt", "rolloutEpochAt", "switchEpochAt",
             "activationCutoffAt", "admissionEpochAt", "admissionCutoffAt",
             "dispatchEpochAtAdmission", "approvalApprovedAt",
             "approvalOptInEpoch", "approvalAckVersion"
      FROM "ShippingRefund" WHERE "id" = ${rowId}
      FOR UPDATE`;
    const row = rows[0];
    if (!row) return { frozen: false, reason: "NOT_QUEUED" };
    if (row.status !== "QUEUED") return { frozen: false, reason: "NOT_QUEUED" };

    // Lease ownership and validity on the database clock — the fence
    // precedes every other decision, exactly as at lease time (F1).
    const [fence] = await tx.$queryRaw<{ owned: boolean; expired: boolean }[]>`
      SELECT ("leaseToken" = ${leaseToken} AND "leasedUntil" > ${DB_WALL}) AS "owned",
             ("sourceCancelledAt" IS NULL
              OR ${HORIZON_EXPIRED_PREDICATE(DB_WALL)}) AS "expired"
      FROM "ShippingRefund" WHERE "id" = ${rowId}`;
    if (!fence.owned) {
      return { frozen: false, reason: "OWNERSHIP_LOST" };
    }

    // Horizon at freeze (8.4): an expired QUEUED row aborts under the same
    // conditional predicates, never freezes.
    const abort = async (reasonCode: string, detail: string | null) => {
      const updated = await tx.$executeRaw`
        UPDATE "ShippingRefund" SET
          "status" = 'ABORTED', "reasonCode" = ${reasonCode},
          "reviewReason" = ${detail},
          "leaseToken" = NULL, "leasedUntil" = NULL, "nextCheckAt" = NULL,
          "updatedAt" = ${DB_WALL}
        WHERE "id" = ${rowId}
          AND "status" = 'QUEUED'
          AND "leaseToken" = ${leaseToken}
          AND "leasedUntil" > ${DB_WALL}`;
      if (updated !== 1) {
        throw new OwnershipLostError(`shipping-refund lease lost for row ${rowId}`);
      }
    };
    if (fence.expired) {
      await abort("HORIZON_EXPIRED", null);
      return { frozen: false, reason: "HORIZON_EXPIRED" };
    }

    // The §4.10 locks and the complete live-gate recomputation (8.3):
    // every individual epoch of the stored snapshot must equal the locked
    // live state — the OBSERVE lane's dispatch epoch is exempt (4.4).
    const { live } = await lockAndReadLiveState(tx, row.shop);
    const recheck = recheckShippingGate(
      {
        merchantEpochAt: row.merchantEpochAt,
        rolloutEpochAt: row.rolloutEpochAt,
        switchEpochAt: row.switchEpochAt,
        activationCutoffAt: row.activationCutoffAt,
        admissionEpochAt: row.admissionEpochAt,
        admissionCutoffAt: row.admissionCutoffAt,
        dispatchEpochAtAdmission: row.dispatchEpochAtAdmission,
        approvalApprovedAt: row.approvalApprovedAt,
        approvalOptInEpoch: row.approvalOptInEpoch,
        approvalAckVersion: row.approvalAckVersion,
      },
      live,
      row.lane,
    );
    if (!recheck.equal) {
      // 7.4: a gate that closed or changed mid-evaluation aborts the row.
      // GATE_CLOSED and SNAPSHOT_INVALID collapse to GATE_CHANGED here —
      // the row is aborted either way and the detail records which.
      await abort("GATE_CHANGED", `${recheck.code}: ${recheck.detail}`);
      return { frozen: false, reason: "GATE_CHANGED", detail: recheck.detail };
    }

    // The one write (8.3): financial columns, the pinned document hash,
    // the wire variables and hash, the preEvidence and preparedAt — under
    // predicates that still require QUEUED, the caller's token, a live
    // lease and an unexpired horizon. Rowcount != 1 means the lease was
    // lost between the checks and the write — throw, write nothing.
    const status = row.lane === "EXECUTE" ? "PREPARED" : "OBSERVED";
    const updated = await tx.$executeRaw`
      UPDATE "ShippingRefund" SET
        "status" = ${status},
        "currencyCode" = ${frozen.financialColumns.currencyCode},
        "plannedShippingMinor" = ${frozen.financialColumns.plannedShippingMinor},
        "parentTransactionId" = ${frozen.financialColumns.parentTransactionId},
        "gateway" = ${frozen.financialColumns.gateway},
        "documentSha256" = ${frozen.contract.documentSha256},
        "wireVariables" = ${JSON.stringify(frozen.contract.wireVariables)}::jsonb,
        "wireHash" = ${frozen.contract.wireHash},
        "mutationVersion" = ${frozen.contract.mutationVersion},
        "preEvidence" = ${JSON.stringify(frozen.preEvidence)}::jsonb,
        "preparedAt" = ${DB_WALL},
        "leaseToken" = NULL, "leasedUntil" = NULL, "nextCheckAt" = NULL,
        "updatedAt" = ${DB_WALL}
      WHERE "id" = ${rowId}
        AND "status" = 'QUEUED'
        AND "leaseToken" = ${leaseToken}
        AND "leasedUntil" > ${DB_WALL}
        AND "sourceCancelledAt" IS NOT NULL
        AND NOT ${HORIZON_EXPIRED_PREDICATE(DB_WALL)}`;
    if (updated !== 1) {
      throw new OwnershipLostError(`shipping-refund lease lost for row ${rowId}`);
    }
    return { frozen: true, status };
  });
}

// ── §7.6.1 The PREPARED horizon sweep ──────────────────────────────────────

export interface PreparedSweepResult {
  /** False when the trigger set was not the manifest — the sweep refused
   *  to touch any row (3.2 rule 11). */
  readonly intact: boolean;
  readonly abortedIds: readonly string[];
  /** Ids whose lease could not be acquired or whose abort was fenced off
   *  (someone else owns the row, or it settled first). */
  readonly skippedIds: readonly string[];
  readonly errors: readonly { readonly id: string; readonly error: string }[];
}

/**
 * The §7.6.1 sweep: `PREPARED -> ABORTED(HORIZON_EXPIRED)` and nothing
 * else. Explicit invocation only — the scanner, the reconciliation cycle
 * and no worker entry point call this; tests and the (future) operator CLI
 * do.
 *
 * It performs no gate recomputation (aborting authorizes nothing), no
 * Shopify call, no Merge-table write and no dispatch-column write. Per
 * row: a conditional 180-second T1 lease on `status = 'PREPARED'` with an
 * expired-or-absent lease, then inside a second ownership transaction the
 * FOR UPDATE lock, re-validation of every predicate (still PREPARED,
 * dispatchedAt NULL, horizon passed on DB_WALL, token + live lease) and
 * the fenced abort update.
 */
export async function sweepPreparedHorizon(
  opts: { readonly shop?: string | null; readonly limit?: number } = {},
  db: PrismaClient = defaultDb,
  log: ShippingRefundClaimLogger = defaultLog,
): Promise<PreparedSweepResult> {
  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? SWEEP_PREPARED_HORIZON_DEFAULT_LIMIT)),
    SWEEP_PREPARED_HORIZON_MAX_LIMIT,
  );
  const shop = opts.shop ?? null;

  // 3.2 rule 11: the canonical trigger-integrity check precedes any write.
  const integrity = await checkTriggerIntegrity(() =>
    db.$queryRawUnsafe<ShippingRefundTriggerCatalogRow[]>(TRIGGER_CATALOG_SQL),
  );
  if (!integrity.intact) {
    log("[shipping-refund] sweep-prepared-horizon triggers-not-intact");
    return { intact: false, abortedIds: [], skippedIds: [], errors: [] };
  }

  const due = await db.$queryRaw<{ id: string }[]>`
    SELECT sr."id"
    FROM "ShippingRefund" sr
    WHERE sr."status" = 'PREPARED'
      AND sr."dispatchedAt" IS NULL
      AND sr."sourceCancelledAt" IS NOT NULL
      AND ${HORIZON_EXPIRED_PREDICATE(DB_WALL)}
      AND (sr."leasedUntil" IS NULL OR sr."leasedUntil" < ${DB_WALL})
      AND (${shop}::text IS NULL OR sr."shop" = ${shop})
    ORDER BY sr."sourceCancelledAt" ASC, sr."id" ASC
    LIMIT ${limit}`;

  const abortedIds: string[] = [];
  const skippedIds: string[] = [];
  const errors: { id: string; error: string }[] = [];

  for (const { id } of due) {
    try {
      // Step 1: the T1 conditional lease on PREPARED — expired or absent
      // lease, a new token, 180 s on the database clock. Rowcount 0: the
      // row belongs to someone else; skip.
      const leaseToken = await withOwnershipTx(db, async (tx) => {
        await setActor(tx, SWEEP_ACTOR);
        await tx.$queryRaw`
          SELECT "id" FROM "ShippingRefund" WHERE "id" = ${id} FOR UPDATE`;
        const token = newLeaseToken();
        const acquired = await tx.$executeRaw`
          UPDATE "ShippingRefund" SET
            "leaseToken" = ${token},
            "leasedUntil" = ${dbWallPlus(SHIPPING_REFUND_LEASE_TTL_MS)},
            "updatedAt" = ${DB_WALL}
          WHERE "id" = ${id}
            AND "status" = 'PREPARED'
            AND "dispatchedAt" IS NULL
            AND "sourceCancelledAt" IS NOT NULL
            AND ${HORIZON_EXPIRED_PREDICATE(DB_WALL)}
            AND ("leasedUntil" IS NULL OR "leasedUntil" < ${DB_WALL})`;
        return acquired === 1 ? token : null;
      });
      if (leaseToken === null) {
        skippedIds.push(id);
        continue;
      }

      // Step 2: lock-then-validate the abort — re-check every predicate
      // under the row lock and the held token before the fenced update.
      const aborted = await withOwnershipTx(db, async (tx) => {
        await setActor(tx, SWEEP_ACTOR);
        const [check] = await tx.$queryRaw<{ ok: boolean }[]>`
          SELECT (
            "status" = 'PREPARED'
            AND "dispatchedAt" IS NULL
            AND "sourceCancelledAt" IS NOT NULL
            AND ${HORIZON_EXPIRED_PREDICATE(DB_WALL)}
          ) AS "ok"
          FROM "ShippingRefund" WHERE "id" = ${id}
          FOR UPDATE`;
        if (!check?.ok) return false;
        const updated = await tx.$executeRaw`
          UPDATE "ShippingRefund" SET
            "status" = 'ABORTED', "reasonCode" = 'HORIZON_EXPIRED',
            "leaseToken" = NULL, "leasedUntil" = NULL, "nextCheckAt" = NULL,
            "updatedAt" = ${DB_WALL}
          WHERE "id" = ${id}
            AND "status" = 'PREPARED'
            AND "dispatchedAt" IS NULL
            AND "leaseToken" = ${leaseToken}
            AND "leasedUntil" > ${DB_WALL}
            AND "sourceCancelledAt" IS NOT NULL
            AND ${HORIZON_EXPIRED_PREDICATE(DB_WALL)}`;
        return updated === 1;
      });
      if (aborted) {
        abortedIds.push(id);
      } else {
        skippedIds.push(id);
      }
    } catch (err) {
      if (err instanceof OwnershipLostError) {
        skippedIds.push(id);
      } else {
        errors.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return { intact: true, abortedIds, skippedIds, errors };
}

// ── §4.6 operator wire-hash approval recording ─────────────────────────────

/**
 * Record the operator's approvedWireHash on a PREPARED EXECUTE row (4.6,
 * 19.3 item 8): the recorded value must equal the row's own wireHash, the
 * row must carry no dispatch evidence and the field is written at most
 * once. Returns false on any mismatch — it is a guarded recording, never
 * an approval setter (there is no real merchant opt-in in S1).
 */
export function recordApprovedWireHash(
  rowId: string,
  wireHash: string,
  approvedBy: string,
  db: PrismaClient = defaultDb,
): Promise<boolean> {
  return withOwnershipTx(db, async (tx) => {
    await setActor(tx, approvedBy);
    await tx.$queryRaw`
      SELECT "id" FROM "ShippingRefund" WHERE "id" = ${rowId} FOR UPDATE`;
    const updated = await tx.$executeRaw`
      UPDATE "ShippingRefund" SET
        "approvedWireHash" = ${wireHash},
        "approvedAt" = ${DB_WALL},
        "approvedBy" = ${approvedBy},
        "updatedAt" = ${DB_WALL}
      WHERE "id" = ${rowId}
        AND "status" = 'PREPARED'
        AND "lane" = 'EXECUTE'
        AND "wireHash" = ${wireHash}
        AND "wireHash" IS NOT NULL
        AND "dispatchedAt" IS NULL
        AND "approvedWireHash" IS NULL`;
    return updated === 1;
  });
}

// ── The contained R2 writer (8.2.5; fixture-tested only in S1) ────────────

/**
 * The store half of the S2 pre-dispatch recheck outcome (8.2.5): a
 * lease-fenced `PREPARED -> ABORTED` or `PREPARED -> REVIEW_REQUIRED`
 * write, invoked in S1 only by controlled-fixture tests — no application
 * path reaches it against a live row (19.5). Lock-then-validate: FOR
 * UPDATE, then the conditional update requiring still-PREPARED, no
 * dispatch evidence, the caller's token and a live lease.
 */
export function writePreparedR2Outcome(
  rowId: string,
  leaseToken: string,
  outcome: {
    readonly toStatus: "ABORTED" | "REVIEW_REQUIRED";
    readonly reasonCode: string;
    readonly reviewReason?: string | null;
  },
  db: PrismaClient = defaultDb,
): Promise<void> {
  return withOwnershipTx(db, async (tx) => {
    await setActor(tx, SETTLE_ACTOR);
    await tx.$queryRaw`
      SELECT "id" FROM "ShippingRefund" WHERE "id" = ${rowId} FOR UPDATE`;
    const updated = await tx.$executeRaw`
      UPDATE "ShippingRefund" SET
        "status" = ${outcome.toStatus},
        "reasonCode" = ${outcome.reasonCode},
        "reviewReason" = ${outcome.reviewReason ?? null},
        "leaseToken" = NULL, "leasedUntil" = NULL, "nextCheckAt" = NULL,
        "updatedAt" = ${DB_WALL}
      WHERE "id" = ${rowId}
        AND "status" = 'PREPARED'
        AND "dispatchedAt" IS NULL
        AND "leaseToken" = ${leaseToken}
        AND "leasedUntil" > ${DB_WALL}`;
    if (updated !== 1) {
      throw new OwnershipLostError(`shipping-refund lease lost for row ${rowId}`);
    }
  });
}
