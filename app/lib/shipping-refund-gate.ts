// ── Shipping v0 Phase 2: execution gate and epoch snapshot ───────────────
// docs/SHIPPING-PHASE2-DESIGN.md Revision 3.3, sections 4.1-4.5, 4.10, 7.5
// and 8.3 — the pure admission/dispatch gate a future locked claim
// transaction consults before any ShippingRefund row may be written.
//
// Pure module: no I/O, no database, no Shopify, no timers, no global
// mutable state. Every function is deterministic over its arguments and
// never mutates them. Decisions are data, not writes: nothing here writes a
// row, sets a status or authorizes a refund — the snapshot records WHICH
// gate configuration an admission depended on so a later recheck can prove
// the configuration is unchanged.
//
// The Phase 1 activation prerequisites are delegated ENTIRELY to the
// accepted shippingActivationCutoff predicate (3.2 rule 2); this module
// adds the Phase 2 prerequisites around it: the admission control, the
// approval, the acknowledgement version and the REFUND_ALL policy.

import { shippingActivationCutoff } from "./shipping-activation";

/** The input shape of the accepted activation predicate, derived from its
 *  signature. 3.2 rule 2 permits importing only `shippingActivationCutoff`
 *  from shipping-activation.ts; the type is derived, never re-declared. */
export type ActivationInput = Parameters<typeof shippingActivationCutoff>[0];

/**
 * `REQUIRED_ACK_VERSION` (spec 4.4, 16, I20): the merchant-disclosure
 * version an approval's `ackVersion` must equal.
 *
 * Authority: the specification declares this a code constant but assigns it
 * no literal. The acknowledgement text it versions is a G-MERCHANT
 * deliverable (stage 14, "acknowledgement copy and version"), and where it
 * is stored is PD3 — until then it is operator-recorded (4.3). The S1-A
 * schema suite's literal "v1" is raw-SQL fixture data exercising format and
 * constraint checks; nothing in accepted code or the specification makes it
 * the merchant-disclosure version. "v1" is retained here as a PROVISIONAL
 * internal development value only: it is technically safe because no
 * approval setter exists, an empty approval table means no shops, and
 * matching is exact. Before any production-facing approval setter or
 * disclosure flow is implemented, an approved disclosure artifact — its
 * text, a version identifier, a content hash and an approval record — must
 * exist; version identifiers must never be reused (reverting the constant
 * would re-validate approvals recorded under it), and the setter must
 * stamp the version from this constant, never an operator-entered string.
 * Bumping this constant invalidates every approval by design (4.4).
 */
export const REQUIRED_ACK_VERSION = "v1";

// ── Input types ──────────────────────────────────────────────────────────

/** Timestamp-carrying fields accept a Date or a strict ISO-8601 instant
 *  (what the JSON operation payload and a Prisma TIMESTAMP(3) both yield).
 *  Anything else — numbers, null, malformed text — fails closed.
 *  `revokedAt` deliberately admits ONLY `null` for "not revoked" because
 *  the gate cannot prove a missing or undefined value means SQL NULL. */
export type InstantInput = Date | string | null | undefined;

export interface ShippingApprovalInput {
  readonly approvedAt: InstantInput;
  /** Must be exactly `null` for the approval to be valid; missing,
   *  undefined and every other value fail closed. */
  readonly revokedAt: Date | string | null;
  readonly merchantOptInEpoch: InstantInput;
  readonly ackVersion: unknown;
}

export interface ShippingGateLiveState {
  /** The Phase 1 activation inputs, evaluated by the canonical
   *  shippingActivationCutoff — never reinterpreted here. */
  readonly activation: ActivationInput;
  /** ShippingExecuteControl.admissionEnabled / .admissionEnabledAt. */
  readonly admissionEnabled: boolean;
  readonly admissionEnabledAt: InstantInput;
  /** ShippingExecuteControl.dispatchEnabled / .dispatchEnabledAt. The 4.2
   *  invariant is enforced both ways: true needs a valid instant, false
   *  needs an explicitly null epoch, anything else fails closed. */
  readonly dispatchEnabled: boolean;
  readonly dispatchEnabledAt: InstantInput;
  /** The shop's ShippingExecuteApproval row, or null when none exists. */
  readonly approval: ShippingApprovalInput | null | undefined;
  /** Settings.shippingPolicy; admission requires exactly 'REFUND_ALL'. */
  readonly shippingPolicy: unknown;
}

// ── The section 4.4 gate snapshot ────────────────────────────────────────

export type SnapshotField =
  | "merchantEpochAt"
  | "rolloutEpochAt"
  | "switchEpochAt"
  | "activationCutoffAt"
  | "admissionEpochAt"
  | "admissionCutoffAt"
  | "dispatchEpochAtAdmission"
  | "approvalApprovedAt"
  | "approvalOptInEpoch"
  | "approvalAckVersion";

export interface ShippingGateSnapshot {
  /** Settings.shippingAdjustmentEnabledAt (merchant opt-in epoch). */
  readonly merchantEpochAt: Date;
  /** Settings.shippingRolloutAt (rollout-membership epoch). */
  readonly rolloutEpochAt: Date;
  /** AppControl.shippingEnabledAt (global shipping switch epoch). */
  readonly switchEpochAt: Date;
  /** Derived: max(merchantEpochAt, rolloutEpochAt, switchEpochAt). */
  readonly activationCutoffAt: Date;
  /** ShippingExecuteControl.admissionEnabledAt. */
  readonly admissionEpochAt: Date;
  /** Derived: max(activationCutoffAt, admissionEpochAt, approvalApprovedAt). */
  readonly admissionCutoffAt: Date;
  /** Live dispatchEnabledAt at admission: non-null for EXECUTE, NULL for
   *  OBSERVE (4.5). Immutable with the lane. */
  readonly dispatchEpochAtAdmission: Date | null;
  /** ShippingExecuteApproval.approvedAt. */
  readonly approvalApprovedAt: Date;
  /** ShippingExecuteApproval.merchantOptInEpoch. */
  readonly approvalOptInEpoch: Date;
  /** ShippingExecuteApproval.ackVersion. */
  readonly approvalAckVersion: string;
}

// ── Decisions ────────────────────────────────────────────────────────────

export type GateField = SnapshotField | "activationGate" | "admissionControl"
  | "dispatchControl" | "approval" | "shippingPolicy" | "operationCreatedAt"
  | "lane" | "snapshot";

export type GateClosureCode =
  | "ACTIVATION_GATE_CLOSED"          // any Phase 1 prerequisite inactive
  | "ADMISSION_DISABLED"              // admissionEnabled is not true
  | "ADMISSION_EPOCH_INVALID"         // enabled but epoch missing/invalid
  | "DISPATCH_EPOCH_INVALID"          // enabled but epoch missing/invalid
  | "DISPATCH_CONTROL_INVALID"        // switch not boolean, or epoch not NULL while off
  | "APPROVAL_MISSING"                // no approval row for the shop
  | "APPROVAL_REVOKED"                // revokedAt is not proven NULL
  | "APPROVAL_APPROVED_AT_INVALID"    // approvedAt missing or malformed
  | "APPROVAL_OPT_IN_EPOCH_INVALID"   // merchantOptInEpoch malformed
  | "APPROVAL_OPT_IN_EPOCH_MISMATCH"  // approval predates live opt-in epoch
  | "APPROVAL_ACK_VERSION_MISMATCH"   // ackVersion !== REQUIRED_ACK_VERSION
  | "POLICY_NOT_REFUND_ALL"           // shop policy is not REFUND_ALL
  | "OPERATION_CREATED_AT_INVALID"    // malformed combine timestamp
  | "OPERATION_PREDATES_ADMISSION_CUTOFF"; // combine precedes the cutoff

export interface GateClosure {
  readonly open: false;
  readonly code: GateClosureCode;
  readonly field: GateField;
  readonly detail: string;
}

export interface GateOpen {
  readonly open: true;
  /** Every individual epoch, normalized — never collapsed to a maximum. */
  readonly merchantEpochAt: Date;
  readonly rolloutEpochAt: Date;
  readonly switchEpochAt: Date;
  readonly activationCutoffAt: Date;
  readonly admissionEpochAt: Date;
  readonly approvalApprovedAt: Date;
  readonly approvalOptInEpoch: Date;
  readonly approvalAckVersion: string;
  /** The derived cutoffs; equality of these is never sufficient on its own. */
  readonly admissionCutoffAt: Date;
  /** The live dispatch epoch when the dispatch switch is on with a valid
   *  epoch, else null. Whether it belongs to a row's snapshot depends on
   *  the row's lane (4.4 lane exception). */
  readonly dispatchEnabledAt: Date | null;
}

export type ShippingGateEvaluation = GateOpen | GateClosure;

export type ShippingLane = "EXECUTE" | "OBSERVE";

export type ShippingAdmission =
  | {
      readonly admitted: true;
      readonly lane: ShippingLane;
      readonly snapshot: ShippingGateSnapshot;
    }
  | {
      readonly admitted: false;
      readonly code: GateClosureCode;
      readonly field: GateField;
      readonly detail: string;
    };

export type ShippingGateRecheck =
  | { readonly equal: true }
  | {
      readonly equal: false;
      /** GATE_CLOSED: a prerequisite is now closed. GATE_CHANGED: an
       *  individual epoch or snapshot field differs. SNAPSHOT_INVALID: the
       *  stored snapshot itself is malformed or internally inconsistent. */
      readonly code: "GATE_CLOSED" | "GATE_CHANGED" | "SNAPSHOT_INVALID";
      readonly field: GateField;
      readonly detail: string;
      readonly storedMs?: number | null;
      readonly liveMs?: number | null;
    };

// ── Instant normalization (exact millisecond semantics) ──────────────────

const INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

/** Days in a 1-based month of a proleptic Gregorian year. */
const daysInMonth = (year: number, month: number): number =>
  month === 2
    ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
      ? 29
      : 28
    : [4, 6, 9, 11].includes(month)
      ? 30
      : 31;

/** Normalize an instant to a fresh Date, or null when it is not a valid
 *  Date or a strict ISO-8601 instant. A string must name a REAL calendar
 *  date: component ranges and leap years are checked on the string's own
 *  local fields before the zone offset is applied — Date.parse alone would
 *  silently roll a nonexistent day (2030-02-30) into a valid instant.
 *  At most three fractional digits (TIMESTAMP(3) granularity); more is
 *  rejected rather than truncated. Never returns an alias of the caller's
 *  object. */
const normInstant = (value: unknown): Date | null => {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? new Date(ms) : null;
  }
  if (typeof value !== "string") return null;
  const m = INSTANT_RE.exec(value);
  if (m === null) return null;
  const [, yS, moS, dS, hS, miS, sS, fracS, zoneS, offSignS, offHS, offMS] = m;
  const year = Number(yS);
  const month = Number(moS);
  const day = Number(dS);
  const hour = Number(hS);
  const minute = Number(miS);
  const second = Number(sS);
  const offH = Number(offHS ?? 0);
  const offM = Number(offMS ?? 0);
  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59 ||
    offH > 23 || offM > 59
  ) {
    return null;
  }
  // Year 0000 is refused: it cannot be stored in a TIMESTAMP(3) column
  // (PostgreSQL writes 1 BC as `0001-…BC`, not `0000-…`), so no string in
  // this module's grammar can ever be a stored epoch of year zero.
  if (year < 1) return null;
  // Date.UTC(year, …) silently maps years 0–99 onto 1900–1999. Build the
  // day-of-epoch with a safe reference year instead, then set the real
  // year — setUTCFullYear uses the full year verbatim and preserves the
  // time fields already baked in.
  const civil = new Date(
    Date.UTC(
      2000, 0, 1,
      hour, minute, second,
      fracS === undefined ? 0 : Number(fracS.padEnd(3, "0")),
    ),
  );
  civil.setUTCFullYear(year, month - 1, day);
  let ms = civil.getTime();
  if (zoneS !== "Z") {
    const off = (offSignS === "-" ? -1 : 1) * (offH * 3600_000 + offM * 60_000);
    ms -= off;
  }
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  // An offset can push a year-0001 input's UTC instant into year 0000
  // (or a year-9999 input into year 10000). Both results serialize to a
  // form this grammar and TIMESTAMP(3) cannot store (`0000-…`/`+010000-…`),
  // so they refuse like a literal year-0000 source.
  if (d.getUTCFullYear() < 1 || d.getUTCFullYear() > 9999) return null;
  return d;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const maxInstant = (a: Date, b: Date, c?: Date): Date =>
  new Date(c === undefined ? Math.max(a.getTime(), b.getTime()) : Math.max(a.getTime(), b.getTime(), c.getTime()));

const closed = (code: GateClosureCode, field: GateField, detail: string): GateClosure => ({
  open: false,
  code,
  field,
  detail,
});

// ── Live gate evaluation (4.4 prerequisites) ─────────────────────────────

/**
 * Evaluate the live admission gate. Every prerequisite must be open; any
 * missing or invalid required value closes it (fail closed). The Phase 1
 * activation decision is delegated wholesale to shippingActivationCutoff —
 * this module only enumerates the unmet input conditions for the detail.
 */
export function computeShippingGate(live: ShippingGateLiveState): ShippingGateEvaluation {
  if (!isObject(live)) {
    return closed("ACTIVATION_GATE_CLOSED", "activationGate", "live gate input is not an object");
  }

  // ── Phase 1 activation (canonical predicate, 4.1) ──
  // The epoch values are passed through UNCHANGED so the accepted predicate
  // decides on the original types — it accepts only Date-valued epochs, and
  // pre-normalizing a string here would open a gate Phase 1 keeps closed.
  const act = isObject(live.activation) ? live.activation : ({} as ActivationInput);
  const activation: ActivationInput = {
    shippingAdjustmentsEnabled: act.shippingAdjustmentsEnabled as boolean,
    shippingEnabledAt: act.shippingEnabledAt,
    shippingAllowShops: act.shippingAllowShops as string[],
    shop: act.shop as string,
    shippingRolloutAt: act.shippingRolloutAt,
    shopEnabled: act.shopEnabled as boolean,
    enabledAt: act.enabledAt,
  };
  const activationCutoff = shippingActivationCutoff(activation);
  if (activationCutoff === null) {
    // Diagnostic enumeration of the input conditions only — the DECISION
    // above came from the canonical predicate, not from this list.
    const misses: string[] = [];
    if (act.shippingAdjustmentsEnabled !== true) misses.push("shipping switch off");
    if (!(act.shippingEnabledAt instanceof Date && Number.isFinite(act.shippingEnabledAt.getTime())))
      misses.push("switch epoch missing or invalid");
    if (!Array.isArray(act.shippingAllowShops) || !act.shippingAllowShops.includes(act.shop as string))
      misses.push("shop not in rollout allowlist");
    if (!(act.shippingRolloutAt instanceof Date && Number.isFinite(act.shippingRolloutAt.getTime())))
      misses.push("rollout epoch missing or invalid");
    if (act.shopEnabled !== true) misses.push("merchant opt-in off");
    if (!(act.enabledAt instanceof Date && Number.isFinite(act.enabledAt.getTime())))
      misses.push("merchant opt-in epoch missing or invalid");
    return closed(
      "ACTIVATION_GATE_CLOSED",
      "activationGate",
      `Phase 1 activation prerequisites unmet: ${misses.join("; ") || "unknown"}`,
    );
  }

  // ── Admission control with a valid epoch (4.2) ──
  if (live.admissionEnabled !== true) {
    return closed("ADMISSION_DISABLED", "admissionControl", "execution admission is not enabled");
  }
  const admissionEpoch = normInstant(live.admissionEnabledAt);
  if (admissionEpoch === null) {
    return closed(
      "ADMISSION_EPOCH_INVALID",
      "admissionEpochAt",
      "admission is enabled but admissionEnabledAt is missing or invalid",
    );
  }

  // ── Dispatch control consistency (4.2), both directions of the CHECK:
  //    the epoch is a valid instant exactly while the switch is on. A
  //    non-boolean switch or an epoch that is not explicitly null while the
  //    switch is off is a contradictory state the control CHECK forbids; it
  //    closes admission rather than silently degrading to OBSERVE. ──
  const dispatchEpoch = normInstant(live.dispatchEnabledAt);
  if (live.dispatchEnabled === true) {
    if (dispatchEpoch === null) {
      return closed(
        "DISPATCH_EPOCH_INVALID",
        "dispatchControl",
        "dispatch is enabled but dispatchEnabledAt is missing or invalid",
      );
    }
  } else if (
    live.dispatchEnabled !== false ||
    live.dispatchEnabledAt !== null ||
    dispatchEpoch !== null
  ) {
    return closed(
      "DISPATCH_CONTROL_INVALID",
      "dispatchControl",
      `dispatch switch is ${JSON.stringify(live.dispatchEnabled)} with dispatchEnabledAt ${live.dispatchEnabledAt === null ? "NULL" : "non-null"} — the epoch must be a valid instant exactly while the switch is on`,
    );
  }

  // ── Approval validity (4.3, 4.4) ──
  const approval = isObject(live.approval) ? live.approval : null;
  if (approval === null) {
    return closed("APPROVAL_MISSING", "approval", "no execution approval exists for the shop");
  }
  // `revokedAt IS NULL` (4.4): only an explicitly null revocation field
  // proves the approval is live. A missing or undefined property — e.g. a
  // raw-query row that omitted the column — is unproven, not revoked-proof.
  if (approval.revokedAt !== null) {
    return closed(
      "APPROVAL_REVOKED",
      "approval",
      `the shop's approval revocation is not proven null (revokedAt is ${approval.revokedAt === undefined ? "missing or undefined" : "set"})`,
    );
  }
  const approvedAt = normInstant(approval.approvedAt);
  if (approvedAt === null) {
    return closed(
      "APPROVAL_APPROVED_AT_INVALID",
      "approvalApprovedAt",
      "approval approvedAt is missing or invalid",
    );
  }
  const optInEpoch = normInstant(approval.merchantOptInEpoch);
  if (optInEpoch === null) {
    return closed(
      "APPROVAL_OPT_IN_EPOCH_INVALID",
      "approvalOptInEpoch",
      "approval merchantOptInEpoch is missing or invalid",
    );
  }
  const merchantEpoch = act.enabledAt as Date;
  if (optInEpoch.getTime() !== merchantEpoch.getTime()) {
    return closed(
      "APPROVAL_OPT_IN_EPOCH_MISMATCH",
      "approvalOptInEpoch",
      `approval's recorded opt-in epoch ${optInEpoch.toISOString()} differs from the live merchant epoch ${merchantEpoch.toISOString()} — a re-opt-in stamps a new epoch and invalidates the approval`,
    );
  }
  if (approval.ackVersion !== REQUIRED_ACK_VERSION) {
    return closed(
      "APPROVAL_ACK_VERSION_MISMATCH",
      "approvalAckVersion",
      `approval ackVersion ${JSON.stringify(approval.ackVersion)} does not equal REQUIRED_ACK_VERSION ${JSON.stringify(REQUIRED_ACK_VERSION)}`,
    );
  }

  // ── Shop policy (4.4) ──
  if (live.shippingPolicy !== "REFUND_ALL") {
    return closed(
      "POLICY_NOT_REFUND_ALL",
      "shippingPolicy",
      `shippingPolicy is ${JSON.stringify(live.shippingPolicy)}, not REFUND_ALL`,
    );
  }

  const admissionCutoff = maxInstant(activationCutoff, admissionEpoch, approvedAt);
  return {
    open: true,
    merchantEpochAt: new Date(merchantEpoch.getTime()),
    rolloutEpochAt: new Date((act.shippingRolloutAt as Date).getTime()),
    switchEpochAt: new Date((act.shippingEnabledAt as Date).getTime()),
    activationCutoffAt: new Date(activationCutoff.getTime()),
    admissionEpochAt: new Date(admissionEpoch.getTime()),
    approvalApprovedAt: new Date(approvedAt.getTime()),
    approvalOptInEpoch: new Date(optInEpoch.getTime()),
    approvalAckVersion: approval.ackVersion as string,
    admissionCutoffAt: admissionCutoff,
    dispatchEnabledAt: dispatchEpoch,
  };
}

// ── Admission and lane selection (4.5) ───────────────────────────────────

/**
 * Decide whether a combine may be admitted and in which immutable lane.
 *
 * A combine created before the admission cutoff is not admitted at all —
 * no retroactive eligibility (E3, I8). EXECUTE requires a valid live
 * dispatch gate and operationCreatedAt on or after the dispatch cutoff
 * (max of the admission cutoff and the live dispatch epoch); every other
 * eligible admission is OBSERVE with a NULL dispatch epoch. The snapshot is
 * a record of the gate configuration the admission depended on — it is not
 * an authorization to refund.
 */
export function admitShippingRefund(
  live: ShippingGateLiveState,
  operationCreatedAt: unknown,
): ShippingAdmission {
  const gate = computeShippingGate(live);
  if (!gate.open) {
    return { admitted: false, code: gate.code, field: gate.field, detail: gate.detail };
  }
  const createdAt = normInstant(operationCreatedAt);
  if (createdAt === null) {
    return {
      admitted: false,
      code: "OPERATION_CREATED_AT_INVALID",
      field: "operationCreatedAt",
      detail: "the combine's creation timestamp is missing or invalid",
    };
  }
  if (createdAt.getTime() < gate.admissionCutoffAt.getTime()) {
    return {
      admitted: false,
      code: "OPERATION_PREDATES_ADMISSION_CUTOFF",
      field: "operationCreatedAt",
      detail: `combine created at ${createdAt.toISOString()} predates the admission cutoff ${gate.admissionCutoffAt.toISOString()} — no retroactive eligibility`,
    };
  }
  const dispatchCutoff =
    gate.dispatchEnabledAt === null
      ? null
      : maxInstant(gate.admissionCutoffAt, gate.dispatchEnabledAt);
  const lane: ShippingLane =
    dispatchCutoff !== null && createdAt.getTime() >= dispatchCutoff.getTime()
      ? "EXECUTE"
      : "OBSERVE";
  return {
    admitted: true,
    lane,
    snapshot: {
      merchantEpochAt: gate.merchantEpochAt,
      rolloutEpochAt: gate.rolloutEpochAt,
      switchEpochAt: gate.switchEpochAt,
      activationCutoffAt: gate.activationCutoffAt,
      admissionEpochAt: gate.admissionEpochAt,
      admissionCutoffAt: gate.admissionCutoffAt,
      dispatchEpochAtAdmission: lane === "EXECUTE" ? gate.dispatchEnabledAt : null,
      approvalApprovedAt: gate.approvalApprovedAt,
      approvalOptInEpoch: gate.approvalOptInEpoch,
      approvalAckVersion: gate.approvalAckVersion,
    },
  };
}

// ── Full epoch equality at recheck (4.4 live gate check, E9) ─────────────

interface NormalizedSnapshot {
  merchantEpochAt: Date;
  rolloutEpochAt: Date;
  switchEpochAt: Date;
  activationCutoffAt: Date;
  admissionEpochAt: Date;
  admissionCutoffAt: Date;
  dispatchEpochAtAdmission: Date | null;
  approvalApprovedAt: Date;
  approvalOptInEpoch: Date;
  approvalAckVersion: string;
}

const invalidSnapshot = (field: GateField, detail: string): ShippingGateRecheck => ({
  equal: false,
  code: "SNAPSHOT_INVALID",
  field,
  detail,
});

/**
 * Compare a stored gate snapshot against the freshly recomputed live gate.
 *
 * Equality is required of EVERY applicable individual epoch — never only
 * the derived cutoffs — because equality of a maximum can hide a change
 * (a clock regression after a restore, or two different epoch vectors that
 * share a maximum, including at TIMESTAMP(3) millisecond granularity).
 * For lane 'EXECUTE' the dispatch epoch is compared like the others; for
 * lane 'OBSERVE' it is excluded as section 4.4 requires (a live dispatch
 * epoch may legitimately be non-null for a pre-dispatch combine), while
 * every other field is still compared exactly.
 *
 * A changed or closed gate refuses; a stored snapshot is never refreshed or
 * re-stamped here — the decision is pure for a future transaction to apply.
 */
export function recheckShippingGate(
  stored: unknown,
  live: ShippingGateLiveState,
  lane: unknown,
): ShippingGateRecheck {
  if (lane !== "EXECUTE" && lane !== "OBSERVE") {
    return invalidSnapshot("lane", `lane ${JSON.stringify(lane)} is not EXECUTE or OBSERVE`);
  }
  if (!isObject(stored)) return invalidSnapshot("snapshot", "stored snapshot is not an object");

  const s: Partial<NormalizedSnapshot> = {};
  const dateFields = [
    "merchantEpochAt",
    "rolloutEpochAt",
    "switchEpochAt",
    "activationCutoffAt",
    "admissionEpochAt",
    "admissionCutoffAt",
    "approvalApprovedAt",
    "approvalOptInEpoch",
  ] as const;
  for (const f of dateFields) {
    const v = normInstant(stored[f]);
    if (v === null) {
      return invalidSnapshot(f, `stored ${f} is missing or invalid`);
    }
    s[f] = v;
  }
  const ack = stored.approvalAckVersion;
  if (typeof ack !== "string") {
    return invalidSnapshot("approvalAckVersion", "stored approvalAckVersion is missing or not a string");
  }
  s.approvalAckVersion = ack;
  const dispatch = stored.dispatchEpochAtAdmission;
  if (dispatch === undefined) {
    return invalidSnapshot(
      "dispatchEpochAtAdmission",
      "stored dispatchEpochAtAdmission is missing — an OBSERVE row must carry an explicit NULL",
    );
  }
  if (dispatch === null) {
    s.dispatchEpochAtAdmission = null;
  } else {
    const v = normInstant(dispatch);
    if (v === null) {
      return invalidSnapshot("dispatchEpochAtAdmission", "stored dispatchEpochAtAdmission is invalid");
    }
    s.dispatchEpochAtAdmission = v;
  }
  const snap = s as NormalizedSnapshot;

  // Internal consistency: the stored derived cutoffs must equal the maxima
  // of the stored parts (5.3 CHECKs), and the dispatch epoch must be NULL
  // exactly for OBSERVE (lane is immutable with the snapshot).
  const expectActivation = maxInstant(snap.merchantEpochAt, snap.rolloutEpochAt, snap.switchEpochAt);
  if (snap.activationCutoffAt.getTime() !== expectActivation.getTime()) {
    return invalidSnapshot(
      "activationCutoffAt",
      "stored activationCutoffAt is not the maximum of the stored activation epochs",
    );
  }
  const expectAdmission = maxInstant(snap.activationCutoffAt, snap.admissionEpochAt, snap.approvalApprovedAt);
  if (snap.admissionCutoffAt.getTime() !== expectAdmission.getTime()) {
    return invalidSnapshot(
      "admissionCutoffAt",
      "stored admissionCutoffAt is not max(activationCutoffAt, admissionEpochAt, approvalApprovedAt)",
    );
  }
  if (lane === "OBSERVE" && snap.dispatchEpochAtAdmission !== null) {
    return invalidSnapshot("dispatchEpochAtAdmission", "an OBSERVE lane row must carry a NULL dispatch epoch");
  }
  if (lane === "EXECUTE" && snap.dispatchEpochAtAdmission === null) {
    return invalidSnapshot("dispatchEpochAtAdmission", "an EXECUTE lane row must carry a non-NULL dispatch epoch");
  }

  const gate = computeShippingGate(live);
  if (!gate.open) {
    return {
      equal: false,
      code: "GATE_CLOSED",
      field: gate.field,
      detail: `live gate is closed (${gate.code}): ${gate.detail}`,
    };
  }

  // Per-field comparison, in the section 4.4 snapshot order; the first
  // difference identifies the changed field. Instant equality is exact
  // millisecond equality.
  const liveFields: Record<SnapshotField, Date | string | null> = {
    merchantEpochAt: gate.merchantEpochAt,
    rolloutEpochAt: gate.rolloutEpochAt,
    switchEpochAt: gate.switchEpochAt,
    activationCutoffAt: gate.activationCutoffAt,
    admissionEpochAt: gate.admissionEpochAt,
    admissionCutoffAt: gate.admissionCutoffAt,
    dispatchEpochAtAdmission: gate.dispatchEnabledAt,
    approvalApprovedAt: gate.approvalApprovedAt,
    approvalOptInEpoch: gate.approvalOptInEpoch,
    approvalAckVersion: gate.approvalAckVersion,
  };
  const compareOrder: SnapshotField[] = [
    "merchantEpochAt",
    "rolloutEpochAt",
    "switchEpochAt",
    "activationCutoffAt",
    "admissionEpochAt",
    "admissionCutoffAt",
    "dispatchEpochAtAdmission",
    "approvalApprovedAt",
    "approvalOptInEpoch",
    "approvalAckVersion",
  ];
  for (const f of compareOrder) {
    // The 4.4 lane exception: the dispatch epoch is not part of an OBSERVE
    // row's comparison.
    if (f === "dispatchEpochAtAdmission" && lane === "OBSERVE") continue;
    const sVal = snap[f];
    const lVal = liveFields[f];
    const differ =
      f === "approvalAckVersion"
        ? sVal !== lVal
        : (sVal === null) !== (lVal === null) ||
          (sVal !== null && lVal !== null && (sVal as Date).getTime() !== (lVal as Date).getTime());
    if (differ) {
      return {
        equal: false,
        code: "GATE_CHANGED",
        field: f,
        detail:
          f === "approvalAckVersion"
            ? `ackVersion changed: stored ${JSON.stringify(sVal)} vs live ${JSON.stringify(lVal)}`
            : `${f} changed: stored ${sVal === null ? "NULL" : (sVal as Date).toISOString()} vs live ${lVal === null ? "NULL" : (lVal as Date).toISOString()}`,
        storedMs: sVal instanceof Date ? sVal.getTime() : null,
        liveMs: lVal instanceof Date ? lVal.getTime() : null,
      };
    }
  }
  return { equal: true };
}
