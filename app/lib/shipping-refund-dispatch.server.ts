// S2 dispatch path (design sections 9, 10.5, 11, 19.5). This is the ONLY
// module that may enter DISPATCHING, hold a DispatchPermit, send the pinned
// mutation or write its response — and none of it runs unless
// MERGESHIP_SHIPPING_REFUNDS=enabled and every §9.2 gate rechecks equal.
//
// I19/I23: a send happens only from a DispatchPermit minted by THIS module
// after an observed T3 commit in the same process; a DISPATCHING row read
// from the database never causes a send; an unknown T3 result means no
// send. I7: nothing here or anywhere resends — one wire request per row,
// ever (10.5, I1).
import { performance } from "node:perf_hooks";
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
  recheckShippingGate,
  REQUIRED_ACK_VERSION,
  type ShippingGateLiveState,
} from "./shipping-refund-gate";
import {
  checkTriggerIntegrity,
  TRIGGER_CATALOG_SQL,
  type TriggerIntegrityReason,
  type ShippingRefundTriggerCatalogRow,
} from "./shipping-refund-trigger-manifest";
import {
  computeWireHash,
  REFUND_DOCUMENT_SHA256,
  REFUND_GID_PATTERN,
  REFUND_MUTATION_VERSION,
  shippingRefundMutationDocument,
  type ShippingRefundWireVariables,
} from "./shipping-refund-contract";
import { HORIZON_EXPIRED_PREDICATE, SHIPPING_REFUND_LEASE_TTL_MS } from "./shipping-refund-store.server";
import { GQL_TIMEOUT_MS, type AdminClient } from "./graphql.server";

export const DISPATCH_WORKER_ENV = "MERGESHIP_SHIPPING_REFUNDS";
export const CAPACITY_WAIT_BACKOFF_MS = 15 * 60 * 1000;
export const DISPATCH_PERMIT_TTL_MS = 10_000;
const DISPATCH_ACTOR = "shipping-refund-dispatch";
const T4_WRITE_ATTEMPTS = 3;
const T4_RETRY_DELAY_MS = 200;

export const shippingRefundsDispatchEnabled = (): boolean =>
  process.env[DISPATCH_WORKER_ENV] === "enabled";

const setActor = async (tx: Prisma.TransactionClient): Promise<void> => {
  await tx.$queryRaw`SELECT set_config('mergeship.actor', ${DISPATCH_ACTOR}, true)`;
};

const txCatalog = (tx: Prisma.TransactionClient) => () =>
  tx.$queryRawUnsafe(TRIGGER_CATALOG_SQL) as Promise<readonly ShippingRefundTriggerCatalogRow[]>;

// ── Due-row selection and lease (9.1 T1 for PREPARED rows) ────────────────

export interface DuePreparedRow {
  readonly id: string;
  readonly shop: string;
  readonly sourceOrderId: string;
  readonly primaryOrderId: string;
}

/** Due PREPARED rows by scheduled check on the database clock. The lease
 *  owns exclusivity; this list is advisory ordering only. */
export function listDuePreparedShippingRefunds(
  limit = 25,
  db: PrismaClient = defaultDb,
): Promise<DuePreparedRow[]> {
  return db.$queryRaw<DuePreparedRow[]>`
    SELECT "id", "shop", "sourceOrderId", "primaryOrderId"
    FROM "ShippingRefund"
    WHERE "status" = 'PREPARED'
      AND ("nextCheckAt" IS NULL OR "nextCheckAt" <= ${DB_WALL})
    ORDER BY "nextCheckAt" ASC NULLS FIRST, "id" ASC
    LIMIT ${limit}`;
}

export type PreparedLeaseResult =
  | { readonly leased: true; readonly rowId: string; readonly leaseToken: string }
  | {
      readonly leased: false;
      readonly reason:
        | "NOT_FOUND"
        | "NOT_PREPARED"
        | "LEASE_HELD"
        | "NOT_DUE"
        | "HORIZON_EXPIRED";
    };

/** The PREPARED-row counterpart of leaseQueuedShippingRefund (9.1 T1): the
 *  180-second lease on the database clock, FOR UPDATE first, conditional on
 *  status, expired/absent lease and due nextCheckAt. An expired seven-day
 *  horizon aborts the row HORIZON_EXPIRED in the same transaction (8.4 —
 *  S2 checks the horizon at lease too, mirroring the QUEUED rule). */
export function leasePreparedShippingRefund(
  rowId: string,
  opts: { actor?: string | null } = {},
  db: PrismaClient = defaultDb,
): Promise<PreparedLeaseResult> {
  return withOwnershipTx(db, async (tx) => {
    await setActor(tx);
    const rows = await tx.$queryRaw<
      { id: string; status: string; leasedUntil: Date | null; nextCheckAt: Date | null }[]
    >`SELECT "id", "status", "leasedUntil", "nextCheckAt"
      FROM "ShippingRefund" WHERE "id" = ${rowId} FOR UPDATE`;
    const row = rows[0];
    if (!row) return { leased: false, reason: "NOT_FOUND" };
    if (row.status !== "PREPARED") return { leased: false, reason: "NOT_PREPARED" };
    const [wall] = await tx.$queryRaw<{ wall: Date }[]>`
      SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "wall"`;
    if (row.leasedUntil !== null && row.leasedUntil.getTime() > wall.wall.getTime()) {
      return { leased: false, reason: "LEASE_HELD" };
    }
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
        WHERE "id" = ${rowId} AND "status" = 'PREPARED' AND "dispatchedAt" IS NULL`;
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
        AND "status" = 'PREPARED'
        AND "dispatchedAt" IS NULL
        AND ("leasedUntil" IS NULL OR "leasedUntil" <= ${DB_WALL})`;
    if (updated !== 1) return { leased: false, reason: "NOT_PREPARED" };
    return { leased: true, rowId, leaseToken };
  });
}

/** Renew the lease of a PREPARED row held with `token` (9.1 T1: renewed
 *  between Shopify reads). A lost lease throws OwnershipLostError. */
export function renewPreparedShippingRefundLease(
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
        AND "status" = 'PREPARED'
        AND "dispatchedAt" IS NULL
        AND "leaseToken" = ${leaseToken}
        AND "leasedUntil" > ${DB_WALL}`;
    if (updated !== 1) {
      throw new OwnershipLostError(`shipping-refund lease lost for row ${rowId}`);
    }
  });
}

/** N5 wait: leave the row where it is, reschedule at most backoffMs ahead
 *  (never more than the 15-minute bound), release the lease and DO NOT
 *  touch attempts (4.7). Applies to QUEUED and PREPARED waits. */
export function releaseLeaseWithBackoff(
  rowId: string,
  leaseToken: string,
  backoffMs = CAPACITY_WAIT_BACKOFF_MS,
  db: PrismaClient = defaultDb,
): Promise<void> {
  const ms = Math.min(Math.max(0, Math.floor(backoffMs)), CAPACITY_WAIT_BACKOFF_MS);
  return withOwnershipTx(db, async (tx) => {
    await setActor(tx);
    await tx.$queryRaw`
      SELECT "id" FROM "ShippingRefund" WHERE "id" = ${rowId} FOR UPDATE`;
    const updated = await tx.$executeRaw`
      UPDATE "ShippingRefund" SET
        "nextCheckAt" = ${dbWallPlus(ms)},
        "leaseToken" = NULL, "leasedUntil" = NULL,
        "updatedAt" = ${DB_WALL}
      WHERE "id" = ${rowId}
        AND "status" IN ('QUEUED','PREPARED')
        AND "dispatchedAt" IS NULL
        AND "leaseToken" = ${leaseToken}
        AND "leasedUntil" > ${DB_WALL}`;
    if (updated !== 1) {
      throw new OwnershipLostError(`shipping-refund lease lost for row ${rowId}`);
    }
  });
}

// ── Capacity prechecks (DB reads only; no Shopify, no attempts) ───────────

export type CapacityWait =
  | "BREAKER_TRIPPED"
  | "SHOP_CAP_REACHED"
  | "GLOBAL_CAP_REACHED"
  | "PER_REFUND_CAP"
  | "CURRENCY_MISMATCH"
  | "HASH_APPROVAL_MISSING"
  | "APPROVAL_MALFORMED_CAP"
  | "HORIZON_EXPIRED";

export type CapacityPrecheckResult =
  | { readonly proceed: true }
  | { readonly wait: true; readonly reason: CapacityWait }
  | { readonly abort: true; readonly reason: "HORIZON_EXPIRED" };

/** Trailing-24h dispatch count (a dispatch is a row whose dispatchedAt is
 *  set — the write-ahead record, not a completed refund). */
const countDispatches24h = async (
  tx: Prisma.TransactionClient,
  shop: string | null,
): Promise<number> => {
  const rows = shop === null
    ? await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS "n" FROM "ShippingRefund"
        WHERE "dispatchedAt" IS NOT NULL
          AND "dispatchedAt" > (${DB_WALL} - INTERVAL '24 hours')`
    : await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS "n" FROM "ShippingRefund"
        WHERE "dispatchedAt" IS NOT NULL
          AND "dispatchedAt" > (${DB_WALL} - INTERVAL '24 hours')
          AND "shop" = ${shop}`;
  return Number(rows[0]?.n ?? 0n);
};

/** Breaker (4.7): any unresolved dispatched row trips it — money may be in
 *  flight. Pre-dispatch terminal rows carry no dispatchedAt and never trip. */
const breakerTripped = async (tx: Prisma.TransactionClient): Promise<boolean> => {
  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS "n" FROM "ShippingRefund"
    WHERE "dispatchedAt" IS NOT NULL
      AND "status" NOT IN ('VERIFIED','RESOLVED')`;
  return Number(rows[0]?.n ?? 0n) > 0;
};

/** The pre-freeze precheck (8.4): an EXECUTE-lane QUEUED row may wait on
 *  ONLY the breaker and the per-shop and global daily caps — never the
 *  hash approval and never the per-refund cap (they cannot exist yet). */
export async function prefreezeCapacityPrecheck(
  shop: string,
  db: PrismaClient = defaultDb,
): Promise<CapacityPrecheckResult> {
  return db.$transaction(async (tx) => {
    const [ctl] = await tx.$queryRaw<{ globalDailyCap: number }[]>`
      SELECT "globalDailyCap" FROM "ShippingExecuteControl" WHERE "id" = 'control'`;
    const [ap] = await tx.$queryRaw<{ dailyCap: number }[]>`
      SELECT "dailyCap" FROM "ShippingExecuteApproval" WHERE "shop" = ${shop}`;
    if (await breakerTripped(tx)) return { wait: true, reason: "BREAKER_TRIPPED" };
    if ((await countDispatches24h(tx, shop)) >= (ap?.dailyCap ?? 0)) {
      return { wait: true, reason: "SHOP_CAP_REACHED" };
    }
    if ((await countDispatches24h(tx, null)) >= (ctl?.globalDailyCap ?? 0)) {
      return { wait: true, reason: "GLOBAL_CAP_REACHED" };
    }
    return { proceed: true };
  });
}

interface PreparedHead {
  readonly id: string;
  readonly shop: string;
  readonly status: string;
  readonly lane: string;
  readonly wireHash: string | null;
  readonly wireVariables: unknown;
  readonly documentSha256: string | null;
  readonly mutationVersion: string | null;
  readonly currencyCode: string | null;
  readonly plannedShippingMinor: string | null;
  readonly approvedWireHash: string | null;
  readonly sourceCancelledAt: Date | null;
  readonly operationCreatedAt: Date;
  readonly leaseToken: string | null;
  readonly leasedUntil: Date | null;
  readonly dispatchedAt: Date | null;
  readonly dispatchToken: string | null;
  readonly refundId: string | null;
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

const PREPARED_HEAD_SQL = `
  SELECT "id", "shop", "status", "lane", "wireHash", "wireVariables",
         "documentSha256", "mutationVersion", "currencyCode", "plannedShippingMinor",
         "approvedWireHash", "sourceCancelledAt", "operationCreatedAt",
         "leaseToken", "leasedUntil", "dispatchedAt", "dispatchToken", "refundId",
         "merchantEpochAt", "rolloutEpochAt", "switchEpochAt",
         "activationCutoffAt", "admissionEpochAt", "admissionCutoffAt",
         "dispatchEpochAtAdmission", "approvalApprovedAt",
         "approvalOptInEpoch", "approvalAckVersion"
  FROM "ShippingRefund"`;

export function loadPreparedHead(rowId: string, db: PrismaClient = defaultDb) {
  return db
    .$queryRawUnsafe<PreparedHead[]>(`${PREPARED_HEAD_SQL} WHERE "id" = $1`, rowId)
    .then((r) => r[0] ?? null);
}

const MINOR_FORMAT = /^[1-9][0-9]{0,39}$/;
const CAP_FORMAT = /^(0|[1-9][0-9]{0,39})$/;

/** The post-freeze capacity precheck (9.1): DB reads only — horizon,
 *  breaker, shop and global caps, per-refund cap, currency pin and the
 *  recorded hash approval. Returns WAIT for every capacity condition (the
 *  row waits, never aborts, never consumes attempts) and ABORT only for
 *  the seven-day horizon. Approval-row validity itself is a gate matter
 *  re-checked inside T3; a missing row or missing hash waits. */
export async function preparedCapacityPrecheck(
  rowId: string,
  db: PrismaClient = defaultDb,
): Promise<CapacityPrecheckResult> {
  return db.$transaction(async (tx) => {
    const [h] = await tx.$queryRawUnsafe<PreparedHead[]>(
      `${PREPARED_HEAD_SQL} WHERE "id" = $1 FOR UPDATE`, rowId);
    if (!h) return { proceed: true }; // gone — the lease path owns it
    const [hz] = await tx.$queryRaw<{ expired: boolean }[]>`
      SELECT ("sourceCancelledAt" IS NULL
              OR ${HORIZON_EXPIRED_PREDICATE(DB_WALL)}) AS "expired"
      FROM "ShippingRefund" WHERE "id" = ${rowId}`;
    if (hz.expired) return { abort: true, reason: "HORIZON_EXPIRED" };
    const [ctl] = await tx.$queryRaw<{ globalDailyCap: number }[]>`
      SELECT "globalDailyCap" FROM "ShippingExecuteControl" WHERE "id" = 'control'`;
    const [ap] = await tx.$queryRaw<
      { dailyCap: number; currencyCode: string; maxRefundMinor: string; autoApprove: boolean }[]
    >`SELECT "dailyCap", "currencyCode", "maxRefundMinor", "autoApprove"
      FROM "ShippingExecuteApproval" WHERE "shop" = ${h.shop}`;
    if (await breakerTripped(tx)) return { wait: true, reason: "BREAKER_TRIPPED" };
    if ((await countDispatches24h(tx, h.shop)) >= (ap?.dailyCap ?? 0)) {
      return { wait: true, reason: "SHOP_CAP_REACHED" };
    }
    if ((await countDispatches24h(tx, null)) >= (ctl?.globalDailyCap ?? 0)) {
      return { wait: true, reason: "GLOBAL_CAP_REACHED" };
    }
    if (!ap) return { wait: true, reason: "HASH_APPROVAL_MISSING" };
    if (!ap.autoApprove && h.approvedWireHash !== h.wireHash) {
      return { wait: true, reason: "HASH_APPROVAL_MISSING" };
    }
    if (h.currencyCode !== ap.currencyCode) {
      return { wait: true, reason: "CURRENCY_MISMATCH" };
    }
    // Numeric per-refund cap (4.6.1): format first, then BigInt; a value
    // failing its format refuses the dispatch (Wait — capacity class).
    if (
      typeof h.plannedShippingMinor !== "string" ||
      !MINOR_FORMAT.test(h.plannedShippingMinor) ||
      !CAP_FORMAT.test(ap.maxRefundMinor)
    ) {
      return { wait: true, reason: "APPROVAL_MALFORMED_CAP" };
    }
    if (BigInt(h.plannedShippingMinor) > BigInt(ap.maxRefundMinor)) {
      return { wait: true, reason: "PER_REFUND_CAP" };
    }
    return { proceed: true };
  });
}

// ── T3: gate and write-ahead (9.2), and the DispatchPermit (9.3) ──────────

export type T3Outcome =
  | { readonly kind: "PERMIT"; readonly permit: DispatchPermit }
  | { readonly kind: "WAIT"; readonly reason: CapacityWait }
  | { readonly kind: "ABORTED"; readonly reasonCode: string };

interface LockedGateState extends ShippingGateLiveState {
  readonly approvalCaps: {
    readonly dailyCap: number;
    readonly currencyCode: string;
    readonly maxRefundMinor: string;
    readonly autoApprove: boolean;
  } | null;
  readonly globalDailyCap: number;
  readonly dispatchCutoff: Date | null;
}

/** The mint authority (9.3, I19): a module-private capability that never
 *  leaves this file. Construction requires presenting it, so no other
 *  module and no test can produce a permit — not by calling issue with the
 *  old signature, not by invoking the constructor directly. The only call
 *  site that possesses the authority is openDispatchGate, and it reaches it
 *  only after the T3 transaction promise has resolved. */
const T3_COMMIT_AUTHORITY: unique symbol = Symbol("shipping-refund-t3-commit");

const assertT3Authority: (authority: unknown) => asserts authority is typeof T3_COMMIT_AUTHORITY = (authority) => {
  if (authority !== T3_COMMIT_AUTHORITY) {
    throw new Error(
      "DispatchPermit can only be minted from a resolved T3 commit inside the dispatch module",
    );
  }
};

/** Minted only inside this module, only after an observed T3 commit (9.3,
 *  I19, I23). Single-use and max-10-seconds old at send. */
export class DispatchPermit {
  private consumed = false;
  readonly rowId: string;
  readonly dispatchToken: string;
  readonly wireVariables: unknown;
  private readonly issuedAtMono: number;
  private readonly monotonicNow: () => number;
  private constructor(
    authority: typeof T3_COMMIT_AUTHORITY,
    rowId: string, dispatchToken: string, wireVariables: unknown,
    issuedAtMono: number, monotonicNow: () => number,
  ) {
    assertT3Authority(authority);
    this.rowId = rowId;
    this.dispatchToken = dispatchToken;
    this.wireVariables = wireVariables;
    this.issuedAtMono = issuedAtMono;
    this.monotonicNow = monotonicNow;
  }
  /** The single construction site (9.3): called only by openDispatchGate
   *  with the module-private authority, after its transaction resolves. */
  static issue(
    authority: typeof T3_COMMIT_AUTHORITY,
    rowId: string,
    dispatchToken: string,
    wireVariables: unknown,
    monotonicNow: () => number,
  ): DispatchPermit {
    assertT3Authority(authority);
    return new DispatchPermit(authority, rowId, dispatchToken, wireVariables, monotonicNow(), monotonicNow);
  }
  consume(): void {
    if (this.consumed) throw new Error("DispatchPermit is single-use: already consumed");
    if (this.monotonicNow() - this.issuedAtMono > DISPATCH_PERMIT_TTL_MS) {
      throw new Error("DispatchPermit expired (>10s): the row stays DISPATCHING");
    }
    this.consumed = true;
  }
}

/** Recompute the live gate under the §4.10 locks (row FOR UPDATE →
 *  AppControl FOR SHARE → Settings FOR SHARE → control FOR UPDATE →
 *  approval FOR SHARE). Each statement re-reads under READ COMMITTED, so
 *  values seen are as-of the lock hold (4.10 requirement). */
async function readGateStateLocked(
  tx: Prisma.TransactionClient,
  shop: string,
): Promise<LockedGateState> {
  const [app] = await tx.$queryRaw<
    { shippingAdjustmentsEnabled: boolean; shippingEnabledAt: Date | null; shippingAllowShops: string[] }[]
  >`SELECT "shippingAdjustmentsEnabled", "shippingEnabledAt", "shippingAllowShops"
    FROM "AppControl" WHERE "id" = 'control' FOR SHARE`;
  const [st] = await tx.$queryRaw<
    { shippingAdjustmentEnabled: boolean; shippingAdjustmentEnabledAt: Date | null;
      shippingRolloutAt: Date | null; shippingPolicy: string }[]
  >`SELECT "shippingAdjustmentEnabled", "shippingAdjustmentEnabledAt",
           "shippingRolloutAt", "shippingPolicy"
    FROM "Settings" WHERE "shop" = ${shop} FOR SHARE`;
  const [ctl] = await tx.$queryRaw<
    { admissionEnabled: boolean; admissionEnabledAt: Date | null;
      dispatchEnabled: boolean; dispatchEnabledAt: Date | null; globalDailyCap: number }[]
  >`SELECT "admissionEnabled", "admissionEnabledAt", "dispatchEnabled",
           "dispatchEnabledAt", "globalDailyCap"
    FROM "ShippingExecuteControl" WHERE "id" = 'control' FOR UPDATE`;
  const [ap] = await tx.$queryRaw<
    { approvedAt: Date; revokedAt: Date | null; merchantOptInEpoch: Date; ackVersion: string;
      dailyCap: number; currencyCode: string; maxRefundMinor: string; autoApprove: boolean }[]
  >`SELECT "approvedAt", "revokedAt", "merchantOptInEpoch", "ackVersion",
           "dailyCap", "currencyCode", "maxRefundMinor", "autoApprove"
    FROM "ShippingExecuteApproval" WHERE "shop" = ${shop} FOR SHARE`;

  const approval = ap ?? null;
  const approvalValid =
    approval !== null &&
    approval.revokedAt === null &&
    st?.shippingAdjustmentEnabledAt instanceof Date &&
    approval.merchantOptInEpoch.getTime() === st.shippingAdjustmentEnabledAt.getTime() &&
    approval.ackVersion === REQUIRED_ACK_VERSION;
  const activation =
    app?.shippingAdjustmentsEnabled === true &&
    app.shippingEnabledAt instanceof Date &&
    st?.shippingAdjustmentEnabled === true &&
    st.shippingAdjustmentEnabledAt instanceof Date &&
    st.shippingRolloutAt instanceof Date
      ? new Date(
          Math.max(
            app.shippingEnabledAt.getTime(),
            st.shippingAdjustmentEnabledAt.getTime(),
            st.shippingRolloutAt.getTime(),
          ),
        )
      : null;
  const admissionCutoff =
    ctl?.admissionEnabled === true &&
    ctl.admissionEnabledAt instanceof Date &&
    approvalValid &&
    activation !== null &&
    st?.shippingPolicy === "REFUND_ALL"
      ? new Date(
          Math.max(
            activation.getTime(),
            ctl.admissionEnabledAt.getTime(),
            approval.approvedAt.getTime(),
          ),
        )
      : null;
  const dispatchCutoff =
    ctl?.dispatchEnabled === true &&
    ctl.dispatchEnabledAt instanceof Date &&
    admissionCutoff !== null
      ? new Date(Math.max(admissionCutoff.getTime(), ctl.dispatchEnabledAt.getTime()))
      : null;

  return {
    activation: {
      shippingAdjustmentsEnabled: app?.shippingAdjustmentsEnabled === true,
      shippingEnabledAt: app?.shippingEnabledAt ?? null,
      shippingAllowShops: Array.isArray(app?.shippingAllowShops) ? app.shippingAllowShops : [],
      shop,
      shippingRolloutAt: st?.shippingRolloutAt ?? null,
      shopEnabled: st?.shippingAdjustmentEnabled === true,
      enabledAt: st?.shippingAdjustmentEnabledAt ?? null,
    },
    admissionEnabled: ctl?.admissionEnabled === true,
    admissionEnabledAt: ctl?.admissionEnabledAt ?? null,
    dispatchEnabled: ctl?.dispatchEnabled === true,
    dispatchEnabledAt: ctl?.dispatchEnabledAt ?? null,
    approval: approval
      ? {
          approvedAt: approval.approvedAt,
          revokedAt: approval.revokedAt,
          merchantOptInEpoch: approval.merchantOptInEpoch,
          ackVersion: approval.ackVersion,
        }
      : null,
    shippingPolicy: st?.shippingPolicy ?? null,
    approvalCaps: approval
      ? {
          dailyCap: approval.dailyCap,
          currencyCode: approval.currencyCode,
          maxRefundMinor: approval.maxRefundMinor,
          autoApprove: approval.autoApprove,
        }
      : null,
    globalDailyCap: ctl?.globalDailyCap ?? 0,
    dispatchCutoff,
  };
}

const abortInTx = async (
  tx: Prisma.TransactionClient,
  rowId: string,
  leaseToken: string,
  reasonCode: string,
  detail: string | null,
): Promise<void> => {
  await tx.$executeRaw`
    UPDATE "ShippingRefund" SET
      "status" = 'ABORTED', "reasonCode" = ${reasonCode},
      "reviewReason" = ${detail},
      "leaseToken" = NULL, "leasedUntil" = NULL, "nextCheckAt" = NULL,
      "updatedAt" = ${DB_WALL}
    WHERE "id" = ${rowId}
      AND "status" = 'PREPARED'
      AND "dispatchedAt" IS NULL
      AND "leaseToken" = ${leaseToken}
      AND "leasedUntil" > ${DB_WALL}`;
};

/** The gate's in-transaction verdict: the ready-to-mint payload stays data
 *  only — the DispatchPermit object exists solely after the T3 transaction
 *  promise resolves (9.3). */
type T3GateVerdict =
  | {
      readonly kind: "PERMIT_READY";
      readonly dispatchToken: string;
      readonly wireVariables: unknown;
    }
  | { readonly kind: "WAIT"; readonly reason: CapacityWait }
  | { readonly kind: "ABORTED"; readonly reasonCode: string };

/** T3 (9.2): the write-ahead gate in ONE transaction (lock_timeout 2 s via
 *  withOwnershipTx). Any thrown error — lock timeout, serialization, an
 *  unknown commit outcome — is a NO-DECISION: the caller MUST NOT send.
 *  The DispatchPermit is minted only after the transaction promise
 *  resolves: an unacknowledged commit can never produce one. */
export async function openDispatchGate(
  rowId: string,
  leaseToken: string,
  opts: { monotonicNow?: () => number } = {},
  db: PrismaClient = defaultDb,
): Promise<T3Outcome> {
  // The permit's 10-second validity is measured on a monotonic clock, never
  // the wall clock: an NTP step or a manual clock change cannot stretch or
  // forge it. The injected seam keeps tests deterministic.
  const mono = opts.monotonicNow ?? (() => performance.now());
  const verdict = await withOwnershipTx(db, async (tx): Promise<T3GateVerdict> => {
    await setActor(tx);
    const [h] = await tx.$queryRawUnsafe<PreparedHead[]>(
      `${PREPARED_HEAD_SQL} WHERE "id" = $1 FOR UPDATE`, rowId);
    if (!h || h.status !== "PREPARED") {
      return { kind: "ABORTED", reasonCode: "NOT_PREPARED" };
    }

    // 3.2 rule 11: the catalog must still be the manifest inside this
    // transaction, or no transition can be trusted.
    const integrity = await checkTriggerIntegrity(txCatalog(tx));
    if (!integrity.intact) {
      throw new Error(
        `shipping-refund T3 refused: trigger catalog not intact ` +
          `(${integrity.reasons.map((r: TriggerIntegrityReason) => r.code).join(",")})`,
      );
    }

    const abort = (reasonCode: string, detail: string) =>
      abortInTx(tx, rowId, leaseToken, reasonCode, detail.slice(0, 2000));

    const live = await readGateStateLocked(tx, h.shop);

    // §9.2.2: deep equality of every individual epoch with the snapshot,
    // dispatchEnabled, lane EXECUTE, policy, env flag, horizon, cutoff.
    const rc = recheckShippingGate(
      {
        merchantEpochAt: h.merchantEpochAt,
        rolloutEpochAt: h.rolloutEpochAt,
        switchEpochAt: h.switchEpochAt,
        activationCutoffAt: h.activationCutoffAt,
        admissionEpochAt: h.admissionEpochAt,
        admissionCutoffAt: h.admissionCutoffAt,
        dispatchEpochAtAdmission: h.dispatchEpochAtAdmission,
        approvalApprovedAt: h.approvalApprovedAt,
        approvalOptInEpoch: h.approvalOptInEpoch,
        approvalAckVersion: h.approvalAckVersion,
      },
      live,
      "EXECUTE",
    );
    if (h.lane !== "EXECUTE") {
      await abort("GATE_CHANGED", `lane is ${h.lane}`);
      return { kind: "ABORTED", reasonCode: "GATE_CHANGED" };
    }
    if (!rc.equal) {
      await abort("GATE_CHANGED", `gate recheck: ${rc.code} on ${rc.field}`);
      return { kind: "ABORTED", reasonCode: "GATE_CHANGED" };
    }
    if (!shippingRefundsDispatchEnabled()) {
      await abort("GATE_CHANGED", `${DISPATCH_WORKER_ENV} is not enabled`);
      return { kind: "ABORTED", reasonCode: "GATE_CHANGED" };
    }
    if (live.shippingPolicy !== "REFUND_ALL") {
      await abort("POLICY_CHANGED", `policy is ${live.shippingPolicy}`);
      return { kind: "ABORTED", reasonCode: "POLICY_CHANGED" };
    }
    const [hz] = await tx.$queryRaw<{ expired: boolean }[]>`
      SELECT ("sourceCancelledAt" IS NULL
              OR ${HORIZON_EXPIRED_PREDICATE(DB_WALL)}) AS "expired"
      FROM "ShippingRefund" WHERE "id" = ${rowId}`;
    if (hz.expired) {
      await abort("HORIZON_EXPIRED", "seven-day horizon passed");
      return { kind: "ABORTED", reasonCode: "HORIZON_EXPIRED" };
    }
    if (live.dispatchCutoff === null || h.operationCreatedAt.getTime() < live.dispatchCutoff.getTime()) {
      await abort("GATE_CHANGED", "operation predates the live dispatch cutoff");
      return { kind: "ABORTED", reasonCode: "GATE_CHANGED" };
    }

    // §9.2.3: the frozen contract must still be this build's contract.
    if (h.documentSha256 !== REFUND_DOCUMENT_SHA256) {
      await abort("DOCUMENT_CHANGED", `documentSha256 ${h.documentSha256} != this build's pin`);
      return { kind: "ABORTED", reasonCode: "DOCUMENT_CHANGED" };
    }
    if (h.mutationVersion !== REFUND_MUTATION_VERSION) {
      await abort(
        "DOCUMENT_CHANGED",
        `mutationVersion ${JSON.stringify(h.mutationVersion)} != this build's contract version`,
      );
      return { kind: "ABORTED", reasonCode: "DOCUMENT_CHANGED" };
    }
    let recomputed: string;
    try {
      recomputed = computeWireHash(REFUND_DOCUMENT_SHA256, h.wireVariables as ShippingRefundWireVariables);
    } catch (e) {
      await abort("WIRE_HASH_MISMATCH", `wireVariables invalid: ${(e as Error).message}`);
      return { kind: "ABORTED", reasonCode: "WIRE_HASH_MISMATCH" };
    }
    if (recomputed !== h.wireHash) {
      await abort("WIRE_HASH_MISMATCH", "recomputed wireHash != stored wireHash");
      return { kind: "ABORTED", reasonCode: "WIRE_HASH_MISMATCH" };
    }

    // §9.2.4 + caps (capacity class: WAIT — row unchanged, no attempts).
    const ap = live.approvalCaps;
    if (await breakerTripped(tx)) return { kind: "WAIT", reason: "BREAKER_TRIPPED" };
    if ((await countDispatches24h(tx, h.shop)) >= (ap?.dailyCap ?? 0)) {
      return { kind: "WAIT", reason: "SHOP_CAP_REACHED" };
    }
    if ((await countDispatches24h(tx, null)) >= live.globalDailyCap) {
      return { kind: "WAIT", reason: "GLOBAL_CAP_REACHED" };
    }
    if (!ap || (!ap.autoApprove && h.approvedWireHash !== h.wireHash)) {
      return { kind: "WAIT", reason: "HASH_APPROVAL_MISSING" };
    }
    if (h.currencyCode !== ap.currencyCode) {
      return { kind: "WAIT", reason: "CURRENCY_MISMATCH" };
    }
    if (
      typeof h.plannedShippingMinor !== "string" ||
      !MINOR_FORMAT.test(h.plannedShippingMinor) ||
      !CAP_FORMAT.test(ap.maxRefundMinor)
    ) {
      return { kind: "WAIT", reason: "APPROVAL_MALFORMED_CAP" };
    }
    if (BigInt(h.plannedShippingMinor) > BigInt(ap.maxRefundMinor)) {
      return { kind: "WAIT", reason: "PER_REFUND_CAP" };
    }

    // §9.2.7: the write-ahead update itself — conditional on everything the
    // gate just proved, stamped in the same update the evidence-integrity
    // trigger requires.
    const dispatchToken = newLeaseToken();
    const updated = await tx.$executeRaw`
      UPDATE "ShippingRefund" SET
        "status" = 'DISPATCHING',
        "dispatchToken" = ${dispatchToken},
        "dispatchedAt" = ${DB_WALL},
        "updatedAt" = ${DB_WALL}
      WHERE "id" = ${rowId}
        AND "status" = 'PREPARED'
        AND "dispatchedAt" IS NULL
        AND "leaseToken" = ${leaseToken}
        AND "leasedUntil" > ${DB_WALL}`;
    if (updated !== 1) {
      throw new OwnershipLostError(`shipping-refund T3 row lost for ${rowId}`);
    }
    return {
      kind: "PERMIT_READY",
      dispatchToken,
      wireVariables: h.wireVariables,
    };
  });
  // 9.3: the single mint site — reached only when the T3 transaction
  // promise resolved. Any thrown outcome (unknown commit acknowledgement,
  // lock loss, any error) skips this line, so no permit can exist for an
  // unacknowledged T3 or for a DISPATCHING row merely read from the
  // database.
  if (verdict.kind !== "PERMIT_READY") return verdict;
  return {
    kind: "PERMIT",
    permit: DispatchPermit.issue(
      T3_COMMIT_AUTHORITY,
      rowId,
      verdict.dispatchToken,
      verdict.wireVariables,
      mono,
    ),
  };
}

// ── The single send (9.3, 10.5) ──────────────────────────────────────────

/** The ONE wire request of I1. Marks the permit consumed BEFORE the
 *  network call, so no exception path can reuse it; refuses a consumed or
 *  >10 s permit (the row simply stays DISPATCHING then). Sends exactly the
 *  frozen wireVariables with the pinned document — raw admin.graphql with
 *  the 45 s abort and NO retry option (10.5). */
export async function sendRefund(
  permit: DispatchPermit,
  admin: AdminClient,
): Promise<unknown> {
  permit.consume();
  const res = await admin.graphql(shippingRefundMutationDocument(), {
    variables: permit.wireVariables as Record<string, unknown>,
    signal: AbortSignal.timeout(GQL_TIMEOUT_MS),
  });
  return (await res.json()) as unknown;
}

// ── Response classification (section 11) ─────────────────────────────────

export type DispatchOutcomeKind = "ACCEPTED" | "USER_ERRORS" | "TOP_LEVEL_ERRORS" | "TRANSPORT";

export interface DispatchOutcome {
  readonly kind: DispatchOutcomeKind;
  readonly refundId: string | null;
  readonly refundCreatedAt: string | null;
  readonly userErrors: readonly { field: unknown; message: unknown }[];
  readonly anomaly: boolean;
  readonly summary: string;
}

const REFUND_GID_RE = new RegExp(REFUND_GID_PATTERN);
const IDEMPOTENCY_MSG_RE = /idempotency key/i;

/** Section 11: classify the raw response body. A malformed or absent body
 *  is TRANSPORT; top-level errors are TOP_LEVEL_ERRORS; non-empty
 *  userErrors (alone or beside a refund) are USER_ERRORS; only a clean
 *  refund.id is ACCEPTED. Idempotency-anomaly messages raise the anomaly
 *  flag — a single send cannot produce them, so an invariant was violated. */
export function classifyDispatchResponse(body: unknown): DispatchOutcome {
  const done = (o: Omit<DispatchOutcome, "userErrors" | "anomaly"> & Partial<DispatchOutcome>): DispatchOutcome => ({
    userErrors: [],
    anomaly: false,
    ...o,
  });
  if (typeof body !== "object" || body === null) {
    return done({ kind: "TRANSPORT", refundId: null, refundCreatedAt: null, summary: "non-JSON or empty response body" });
  }
  const b = body as Record<string, unknown>;
  const topErrors = b.errors;
  if (Array.isArray(topErrors) && topErrors.length > 0) {
    const text = JSON.stringify(topErrors).slice(0, 1800);
    return done({
      kind: "TOP_LEVEL_ERRORS", refundId: null, refundCreatedAt: null,
      anomaly: IDEMPOTENCY_MSG_RE.test(text), summary: `top-level errors: ${text.slice(0, 300)}`,
    });
  }
  const data = b.data as Record<string, unknown> | null | undefined;
  if (typeof data !== "object" || data === null) {
    return done({ kind: "TRANSPORT", refundId: null, refundCreatedAt: null, summary: "response has no data object" });
  }
  const op = Object.values(data)[0] as Record<string, unknown> | null | undefined;
  if (typeof op !== "object" || op === null) {
    return done({ kind: "TRANSPORT", refundId: null, refundCreatedAt: null, summary: "response has no operation payload" });
  }
  const userErrors = Array.isArray(op.userErrors)
    ? (op.userErrors as { field: unknown; message: unknown }[])
    : [];
  const refund = op.refund as Record<string, unknown> | null | undefined;
  const anomaly = userErrors.some((e) => typeof e?.message === "string" && IDEMPOTENCY_MSG_RE.test(e.message));
  if (userErrors.length > 0) {
    return done({
      kind: "USER_ERRORS",
      refundId: typeof refund?.id === "string" ? refund.id : null,
      refundCreatedAt: null,
      userErrors, anomaly,
      summary: `userErrors: ${JSON.stringify(userErrors).slice(0, 300)}`,
    });
  }
  const refundId = refund?.id;
  if (typeof refundId === "string" && REFUND_GID_RE.test(refundId)) {
    return done({
      kind: "ACCEPTED", refundId,
      refundCreatedAt: typeof refund?.createdAt === "string" ? refund.createdAt : null,
      summary: `refund ${refundId} accepted`,
    });
  }
  return done({ kind: "TRANSPORT", refundId: null, refundCreatedAt: null, summary: "no refund payload in response" });
}

// ── T4: token-fenced outcome write (9.4) ─────────────────────────────────

export type T4Result =
  | { readonly wrote: true; readonly status: "REFUND_RECORDED" | "IN_DOUBT" | "REVIEW_REQUIRED" }
  | { readonly wrote: false; readonly reason: "FENCED_OUT" | "DUPLICATE_ECHO" | "WRITE_FAILED" };

const writeOutcomeOnce = async (
  rowId: string,
  dispatchToken: string,
  outcome: DispatchOutcome,
  db: PrismaClient,
): Promise<T4Result> => {
  return db.$transaction(async (tx) => {
    await setActor(tx);
    if (outcome.kind === "ACCEPTED" && outcome.refundId !== null) {
      // Shopify's instant must be stored as a naive UTC timestamp, regardless
      // of the PostgreSQL session timezone. Keep the absent-timestamp case NULL.
      const refundCreatedAt = outcome.refundCreatedAt === null
        ? Prisma.sql`NULL`
        : Prisma.sql`(${new Date(outcome.refundCreatedAt)}::timestamptz AT TIME ZONE 'UTC')`;
      const updated = await tx.$executeRaw`
        UPDATE "ShippingRefund" SET
          "status" = 'REFUND_RECORDED',
          "refundId" = ${outcome.refundId},
          "refundCreatedAt" = ${refundCreatedAt},
          "respondedAt" = ${DB_WALL},
          "responseKind" = 'ACCEPTED',
          "responseSummary" = ${outcome.summary.slice(0, 1900)},
          "leaseToken" = NULL, "leasedUntil" = NULL, "nextCheckAt" = NULL,
          "updatedAt" = ${DB_WALL}
        WHERE "id" = ${rowId}
          AND "dispatchToken" = ${dispatchToken}
          AND "status" IN ('DISPATCHING','IN_DOUBT')`;
      if (updated === 1) return { wrote: true, status: "REFUND_RECORDED" } as T4Result;
      // Fenced out: either a later transition won, or the echo case —
      // distinguish them exactly, never silently.
      const [now] = await tx.$queryRaw<{ status: string; refundId: string | null }[]>`
        SELECT "status", "refundId" FROM "ShippingRefund" WHERE "id" = ${rowId}`;
      if (now?.status === "REFUND_RECORDED" && now.refundId === outcome.refundId) {
        return { wrote: false, reason: "DUPLICATE_ECHO" } as T4Result;
      }
      if (now?.status === "REFUND_RECORDED" && now.refundId !== outcome.refundId) {
        const parked = await tx.$executeRaw`
          UPDATE "ShippingRefund" SET
            "status" = 'REVIEW_REQUIRED', "reasonCode" = 'DUPLICATE_SUSPECTED',
            "reviewReason" = ${`recorded refundId ${now.refundId} != response ${outcome.refundId}`},
            "updatedAt" = ${DB_WALL}
          WHERE "id" = ${rowId} AND "status" = 'REFUND_RECORDED'`;
        return parked === 1
          ? ({ wrote: true, status: "REVIEW_REQUIRED" } as T4Result)
          : ({ wrote: false, reason: "FENCED_OUT" } as T4Result);
      }
      return { wrote: false, reason: "FENCED_OUT" } as T4Result;
    }
    // IN_DOUBT: a response that was not a clean accept, or no response at
    // all (TRANSPORT). responseKind names the class; respondedAt is set
    // only when a response actually arrived (errors/userErrors), not on a
    // dead wire.
    const responded = outcome.kind !== "TRANSPORT";
    const updated = await tx.$executeRaw`
      UPDATE "ShippingRefund" SET
        "status" = 'IN_DOUBT',
        "respondedAt" = ${responded ? DB_WALL : null},
        "responseKind" = ${outcome.kind},
        "responseSummary" = ${outcome.summary.slice(0, 1900)},
        "leaseToken" = NULL, "leasedUntil" = NULL, "nextCheckAt" = NULL,
        "updatedAt" = ${DB_WALL}
      WHERE "id" = ${rowId}
        AND "dispatchToken" = ${dispatchToken}
        AND "status" IN ('DISPATCHING','IN_DOUBT')`;
    if (updated === 1) return { wrote: true, status: "IN_DOUBT" } as T4Result;
    return { wrote: false, reason: "FENCED_OUT" } as T4Result;
  });
};

/** T4 (9.4): the outcome write fenced by dispatchToken, never by the lease.
 *  Three in-process retries holding the response in memory; if the database
 *  stays unavailable the row is left DISPATCHING — the IN_DOUBT sweep and
 *  human review recover it, and no send is ever repeated. The refund id is
 *  logged before the first write attempt. */
export async function recordDispatchOutcome(
  rowId: string,
  dispatchToken: string,
  outcome: DispatchOutcome,
  opts: { log?: (line: string) => void; sleep?: (ms: number) => Promise<void> } = {},
  db: PrismaClient = defaultDb,
): Promise<T4Result> {
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  if (outcome.refundId !== null) {
    log(`[shipping-refund] dispatched row=${rowId} refund=${outcome.refundId}`);
  }
  for (let attempt = 1; attempt <= T4_WRITE_ATTEMPTS; attempt += 1) {
    try {
      return await writeOutcomeOnce(rowId, dispatchToken, outcome, db);
    } catch (e) {
      log(`[shipping-refund] T4 write attempt ${attempt}/${T4_WRITE_ATTEMPTS} failed for row ${rowId}: ${String(e).slice(0, 200)}`);
      if (attempt < T4_WRITE_ATTEMPTS) await sleep(T4_RETRY_DELAY_MS * attempt);
    }
  }
  return { wrote: false, reason: "WRITE_FAILED" };
}
