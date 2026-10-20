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
 * and no lease is granted.
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

    // Seven-day horizon at lease (8.4), strictly greater-than on DB_WALL —
    // checked before the lease predicates: a row past its horizon aborts
    // even while a live lease is held.
    const [horizon] = await tx.$queryRaw<{ expired: boolean }[]>`
      SELECT ("sourceCancelledAt" IS NULL
              OR ${DB_WALL} > "sourceCancelledAt" + interval '7 days') AS "expired"
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

    const [wall] = await tx.$queryRaw<{ wall: Date }[]>`
      SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "wall"`;
    if (row.leasedUntil !== null && row.leasedUntil.getTime() > wall.wall.getTime()) {
      return { leased: false, reason: "LEASE_HELD" };
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
        AND ${DB_WALL} <= "sourceCancelledAt" + interval '7 days'`;
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
