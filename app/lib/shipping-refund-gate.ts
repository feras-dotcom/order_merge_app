// ── Shipping v0 Phase 2: execution gate and epoch snapshot ───────────────
// docs/SHIPPING-PHASE2-DESIGN.md Revision 3.3, sections 4.1-4.5, 4.10, 7.2,
// 7.2.1, 7.5 and 8.3 — the pure admission/dispatch gate a future locked
// claim transaction consults before any ShippingRefund row may be written.
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

// ── Pre-claim validation (7.2.1): cancelledAt and copied claim columns ────
//
// Before any ShippingRefund row may be inserted, the values copied from the
// operation are validated (7.2). Two failure classes are kept distinct:
// an absent or invalid `cancelledAt` is representable later as the terminal
// REVIEW_REQUIRED(CANCELLED_AT_INVALID) row with `sourceCancelledAt = NULL`
// — but only when every identity, text and instant field is valid, because
// that terminal row carries the same NOT NULL and CHECK columns. Any other
// defect means no row can be formed at all (UNCLAIMABLE): required evidence
// is never substituted, and no claimable result is returned with malformed
// order identifiers or missing non-null fields.

/** The §5.3 order-GID grammar, verbatim. The canonical JS definition is
 *  `ORDER_GID_PATTERN` in shipping-refund-contract.ts; it cannot be imported
 *  here because that module transitively imports the database and Shopify
 *  layers and this module must stay pure (no I/O, no database, no Shopify).
 *  A test asserts this value equals the contract constant, the §5.3 literal
 *  and every S1-A CHECK occurrence; the future scanner consumes the same
 *  literal in its SQL predicates. */
export const ORDER_GID_PATTERN = "^gid://shopify/Order/[0-9]+$";
const ORDER_GID_CLAIM_RE = new RegExp(ORDER_GID_PATTERN);

// ── parseCancelledAt (7.2.1) ─────────────────────────────────────────────

/** The §7.2.1 reason vocabulary for an invalid `cancelledAt` value. */
export type CancelledAtReason =
  | "ABSENT"           // the key is absent or its value is undefined
  | "NOT_A_STRING"     // a non-string JSON value (number, boolean, null, array, object)
  | "UNPARSEABLE"      // a string outside the strict instant grammar (whitespace, missing zone, wrong shape)
  | "CALENDAR_INVALID" // grammar-correct but not a real calendar date, clock field or offset
  | "OUT_OF_RANGE";    // a real instant outside [2000-01-01T00:00:00Z, dbWall + 5 minutes]

/** `dbWall` is caller-supplied control input, not operation data: its
 *  failure is reported under this out-of-vocabulary marker so it can never
 *  be represented as the terminal CANCELLED_AT_INVALID row (7.2.1). */
export const DB_WALL_INVALID = "DB_WALL_INVALID";
export type CancelledAtInvalid = CancelledAtReason | typeof DB_WALL_INVALID;

/** A validated instant (a fresh Date truncated to milliseconds), or a
 *  structured invalid result. */
export type CancelledAtResult = Date | { readonly invalid: CancelledAtInvalid };

/** §7.2.1 rule 2: full ISO-8601 instant with seconds and an explicit zone;
 *  1-9 fractional digits; no trimming is attempted. */
const CANCELLED_AT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

const CANCELLED_AT_FLOOR_MS = Date.UTC(2000, 0, 1);
const CANCELLED_AT_SKEW_MS = 5 * 60_000;

/**
 * Validate a secondary's `cancelledAt` from the operation's JSON record
 * (7.2.1). Pure and deterministic: it never reads the process clock —
 * `dbWall` must be the explicitly supplied database-clock instant.
 *
 * Reason precedence for overlapping defects is the specification's check
 * order: DB_WALL_INVALID (the range bound is undefined without a wall
 * clock), then ABSENT, NOT_A_STRING, UNPARSEABLE, CALENDAR_INVALID and
 * OUT_OF_RANGE — at most one reason is ever reported.
 */
export function parseCancelledAt(
  value: unknown,
  dbWall: unknown,
): CancelledAtResult {
  const wall = normInstant(dbWall);
  if (wall === null) return { invalid: DB_WALL_INVALID };
  if (value === undefined) return { invalid: "ABSENT" };
  if (typeof value !== "string") return { invalid: "NOT_A_STRING" };
  const m = CANCELLED_AT_RE.exec(value);
  if (m === null) return { invalid: "UNPARSEABLE" };
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
    return { invalid: "CALENDAR_INVALID" };
  }
  // Fractional seconds allow 1-9 digits and are TRUNCATED to milliseconds —
  // unlike the gate-epoch grammar above, which refuses more than three.
  const fracMs = fracS === undefined ? 0 : Number((fracS + "000").slice(0, 3));
  // Build the day-of-epoch on a safe reference year, then set the real year:
  // Date.UTC(year, …) maps years 0-99 onto 1900-1999 while setUTCFullYear
  // uses the full year verbatim (the S1-C1 defect).
  const civil = new Date(Date.UTC(2000, 0, 1, hour, minute, second, fracMs));
  civil.setUTCFullYear(year, month - 1, day);
  let ms = civil.getTime();
  if (zoneS !== "Z") {
    const off = (offSignS === "-" ? -1 : 1) * (offH * 3600_000 + offM * 60_000);
    ms -= off;
  }
  if (
    !Number.isFinite(ms) ||
    ms < CANCELLED_AT_FLOOR_MS ||
    ms > wall.getTime() + CANCELLED_AT_SKEW_MS
  ) {
    return { invalid: "OUT_OF_RANGE" };
  }
  return new Date(ms);
}

// ── validateOperationForClaim (7.2.1) ────────────────────────────────────

/** The constraint-sensitive fields a claim copies onto the ShippingRefund
 *  row (`dbWall` is the clock input, not a copied column). */
export type ClaimField =
  | "dbWall"
  | "operation"
  | "secondary"
  | "shop"
  | "mergeOperationId"
  | "primaryOrderId"
  | "primaryOrderName"
  | "operationCreatedAt"
  | "sourceOrderId";

export type ClaimFieldReason =
  | "DB_WALL_INVALID"              // the database-clock input itself is missing/invalid
  | "OPERATION_INVALID"            // the operation record is not an object
  | "SECONDARY_INVALID"            // the selected secondary is not an object
  | "SHOP_INVALID"                 // shop is missing or not a non-empty string
  | "MERGE_OPERATION_ID_INVALID"   // the operation id is missing or not a non-empty string
  | "PRIMARY_ORDER_ID_INVALID"     // primaryOrderId is not a well-formed order GID
  | "PRIMARY_ORDER_NAME_INVALID"   // primaryOrderName is missing or not a non-empty string
  | "OPERATION_CREATED_AT_INVALID" // the operation's created instant is missing/invalid
  | "SOURCE_ORDER_ID_INVALID"      // the secondary's id is not a well-formed order GID
  | "SOURCE_EQUALS_PRIMARY";       // the secondary's id equals primaryOrderId

/** The validated values a claim may copy onto the row — all proven
 *  representable in their NOT NULL/CHECK columns. */
export interface ClaimOperationValues {
  readonly shop: string;
  readonly mergeOperationId: string;
  readonly sourceOrderId: string;
  readonly primaryOrderId: string;
  readonly primaryOrderName: string;
  readonly operationCreatedAt: Date;
  /** `operationCreatedAt` as an ISO string — the value the claim binds
   *  through the repository's naive-UTC discipline (7.2.1). */
  readonly operationCreatedAtIso: string;
}

export type OperationClaimValidation =
  | {
      readonly outcome: "VALID";
      readonly values: ClaimOperationValues;
      /** The validated secondary cancellation instant (ms precision). */
      readonly sourceCancelledAt: Date;
      /** Its ISO form for the claim's naive-UTC bind. */
      readonly sourceCancelledAtIso: string;
    }
  | {
      /** `cancelledAt` alone is invalid: every other copied value is proven,
       *  so the future caller may form the terminal
       *  REVIEW_REQUIRED(CANCELLED_AT_INVALID) row with sourceCancelledAt
       *  NULL (7.2.1). */
      readonly outcome: "CANCELLED_AT_INVALID";
      readonly reasonCode: "CANCELLED_AT_INVALID";
      readonly cancelledAtInvalid: CancelledAtReason;
      /** The raw value, truncated to 64 printable characters — the only
       *  operation data 7.2.1 permits inside `reviewReason`. */
      readonly cancelledAtPreview: string;
      readonly values: ClaimOperationValues;
    }
  | {
      /** No ShippingRefund row can be formed — not even a terminal one. */
      readonly outcome: "UNCLAIMABLE";
      readonly field: ClaimField;
      readonly reason: ClaimFieldReason;
      readonly detail: string;
      /** The `cancelledAt` classification, retained for diagnostics even
       *  though it cannot produce the terminal row while another field
       *  blocks every insert. */
      readonly cancelledAtInvalid?: CancelledAtInvalid;
    };

/** ≤64 printable characters of the raw `cancelledAt` value (7.2.1). Any
 *  failure to represent the value — a BigInt, a circular structure, a
 *  throwing toJSON or Proxy trap, or JSON too deep for the recursive
 *  stringifier — produces the deterministic placeholder `"<" + typeof + ">"`
 *  instead of throwing: malformed cancellation evidence must always yield a
 *  terminal-safe CANCELLED_AT_INVALID classification, never an exception
 *  escaping the pure validator (7.2.2). `String(value)` is deliberately not
 *  used: it invokes caller-controlled toString code, which can throw. */
const cancelledAtPreview = (value: unknown): string => {
  let base: string;
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    base = typeof s === "string" ? s : `<${typeof value}>`;
  } catch {
    base = `<${typeof value}>`;
  }
  return base.slice(0, 64).replace(/[^\x20-\x7E]/g, "?");
};

const nonemptyText = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

/**
 * Validate one operation and its one selected secondary before any
 * ShippingRefund insert (7.2.1). Pure, deterministic and total — it throws
 * for no argument: `dbWall` is the explicitly supplied database-clock
 * instant (the process clock is never consulted), no argument is mutated,
 * and every caller-owned property is read AT MOST ONCE into a local inside
 * a guarded access. Only the captured locals are validated, compared and
 * returned — a getter or Proxy can never substitute a different value into
 * `values` after validation, and a throwing read refuses safely under that
 * field's existing UNCLAIMABLE classification rather than escaping.
 *
 * Evaluation order is fixed: `parseCancelledAt` runs FIRST (its
 * classification is retained on every outcome), then the copied fields in
 * the order operation shape, `shop`, `mergeOperationId`, `primaryOrderId`,
 * `primaryOrderName`, `operationCreatedAt`, secondary shape (including an
 * unreadable `cancelledAt`), `sourceOrderId` and secondary≠primary. A field
 * failure yields `UNCLAIMABLE` even when `cancelledAt` was invalid, because
 * the terminal CANCELLED_AT_INVALID row carries the same NOT NULL and CHECK
 * columns; the cancelledAt reason is still reported for diagnostics. Only
 * when every copied field is valid does a cancelledAt defect yield
 * `CANCELLED_AT_INVALID`.
 */
export function validateOperationForClaim(
  operation: unknown,
  secondary: unknown,
  dbWall: unknown,
): OperationClaimValidation {
  // Capture `secondary.cancelledAt` once, first (its classification is
  // retained on every outcome below). A read that throws — a getter or a
  // Proxy trap — is remembered and reported at the secondary-shape step;
  // the parse still runs with `undefined` so an invalid `dbWall` is still
  // detected as control-input failure rather than operation evidence.
  let secondaryObj: Record<string, unknown> | null;
  try {
    secondaryObj = isObject(secondary) ? secondary : null;
  } catch {
    secondaryObj = null;
  }
  let cancelledAtSource: unknown;
  let cancelledAtUnreadable = false;
  if (secondaryObj !== null) {
    try {
      cancelledAtSource = secondaryObj.cancelledAt;
    } catch {
      cancelledAtUnreadable = true;
    }
  }
  let cancelled: CancelledAtResult;
  try {
    cancelled = parseCancelledAt(cancelledAtUnreadable ? undefined : cancelledAtSource, dbWall);
  } catch {
    // A `dbWall` the module cannot even read (e.g. a Proxy around a Date)
    // is invalid control input, never a merchant-evidence defect.
    cancelled = { invalid: DB_WALL_INVALID };
  }
  const cancelledAtInvalid =
    cancelled instanceof Date
      ? undefined
      : cancelledAtUnreadable && cancelled.invalid !== DB_WALL_INVALID
        ? undefined
        : cancelled.invalid;

  const fail = (
    field: ClaimField,
    reason: ClaimFieldReason,
    detail: string,
  ): OperationClaimValidation =>
    ({ outcome: "UNCLAIMABLE", field, reason, detail, cancelledAtInvalid });

  let operationObj: Record<string, unknown> | null;
  try {
    operationObj = isObject(operation) ? operation : null;
  } catch {
    operationObj = null;
  }
  if (operationObj === null) {
    return fail("operation", "OPERATION_INVALID", "the operation record is not an object");
  }
  let shop: unknown;
  try {
    shop = operationObj.shop;
  } catch {
    return fail("shop", "SHOP_INVALID", "operation.shop could not be read");
  }
  if (!nonemptyText(shop)) {
    return fail("shop", "SHOP_INVALID", "operation.shop is missing or not a non-empty string");
  }
  let mergeOperationId: unknown;
  try {
    mergeOperationId = operationObj.id;
  } catch {
    return fail("mergeOperationId", "MERGE_OPERATION_ID_INVALID", "operation.id could not be read");
  }
  if (!nonemptyText(mergeOperationId)) {
    return fail("mergeOperationId", "MERGE_OPERATION_ID_INVALID", "operation.id is missing or not a non-empty string");
  }
  let primaryOrderId: unknown;
  try {
    primaryOrderId = operationObj.primaryOrderId;
  } catch {
    return fail("primaryOrderId", "PRIMARY_ORDER_ID_INVALID", "operation.primaryOrderId could not be read");
  }
  if (typeof primaryOrderId !== "string" || !ORDER_GID_CLAIM_RE.test(primaryOrderId)) {
    return fail("primaryOrderId", "PRIMARY_ORDER_ID_INVALID", "operation.primaryOrderId is not a well-formed order GID");
  }
  let primaryOrderName: unknown;
  try {
    primaryOrderName = operationObj.primaryOrderName;
  } catch {
    return fail("primaryOrderName", "PRIMARY_ORDER_NAME_INVALID", "operation.primaryOrderName could not be read");
  }
  if (!nonemptyText(primaryOrderName)) {
    return fail("primaryOrderName", "PRIMARY_ORDER_NAME_INVALID", "operation.primaryOrderName is missing or not a non-empty string");
  }
  let createdAtSource: unknown;
  try {
    createdAtSource = operationObj.createdAt;
  } catch {
    return fail("operationCreatedAt", "OPERATION_CREATED_AT_INVALID", "operation.createdAt could not be read");
  }
  let createdAt: Date | null;
  try {
    createdAt = normInstant(createdAtSource);
  } catch {
    createdAt = null;
  }
  if (createdAt === null) {
    return fail("operationCreatedAt", "OPERATION_CREATED_AT_INVALID", "operation.createdAt is missing or invalid");
  }
  if (secondaryObj === null) {
    return fail("secondary", "SECONDARY_INVALID", "the selected secondary is not an object");
  }
  if (cancelledAtUnreadable) {
    return fail("secondary", "SECONDARY_INVALID", "secondary.cancelledAt could not be read");
  }
  let sourceOrderId: unknown;
  try {
    sourceOrderId = secondaryObj.id;
  } catch {
    return fail("sourceOrderId", "SOURCE_ORDER_ID_INVALID", "secondary.id could not be read");
  }
  if (typeof sourceOrderId !== "string" || !ORDER_GID_CLAIM_RE.test(sourceOrderId)) {
    return fail("sourceOrderId", "SOURCE_ORDER_ID_INVALID", "secondary.id is not a well-formed order GID");
  }
  if (sourceOrderId === primaryOrderId) {
    return fail("sourceOrderId", "SOURCE_EQUALS_PRIMARY", "secondary.id equals primaryOrderId");
  }

  const values: ClaimOperationValues = {
    shop,
    mergeOperationId,
    sourceOrderId,
    primaryOrderId,
    primaryOrderName,
    operationCreatedAt: createdAt,
    operationCreatedAtIso: createdAt.toISOString(),
  };
  if (cancelled instanceof Date) {
    return {
      outcome: "VALID",
      values,
      sourceCancelledAt: cancelled,
      sourceCancelledAtIso: cancelled.toISOString(),
    };
  }
  if (cancelledAtInvalid === DB_WALL_INVALID) {
    return fail("dbWall", "DB_WALL_INVALID", "the database wall-clock instant is missing or invalid");
  }
  return {
    outcome: "CANCELLED_AT_INVALID",
    reasonCode: "CANCELLED_AT_INVALID",
    cancelledAtInvalid: cancelledAtInvalid as CancelledAtReason,
    cancelledAtPreview: cancelledAtPreview(cancelledAtSource),
    values,
  };
}

// ── S1-F: read-only reconciliation classifiers (12.2–12.5, 12.3.1, 12.8) ────
// Pure section: decisions over normalized evidence, no I/O. The reconcile
// server module supplies the extracted read-backs; these functions classify.
//
// ATTRIBUTION_STATUS (12.3.1): the only value in S1 is UNVERIFIED. It is a
// parameter of the classifiers below — never read from any environment
// variable, database row, request or setter; production wiring passes this
// pinned constant and tests exercise the other union member on fixtures.
// Moving the constant requires the reviewed change of 12.3.1 (archived
// G-AGREEMENT CONFIRMED evidence cited by experiment id and manifest hash).
// The single declaration carries the 'CONFIRMED' literal (19.3 item 3):
// the `as` widens the value's type while the narrowed runtime value stays
// "UNVERIFIED" — no runtime-mutable source can ever reach it.
export const ATTRIBUTION_STATUS = "UNVERIFIED" as "UNVERIFIED" | "CONFIRMED";
export type AttributionStatus = typeof ATTRIBUTION_STATUS;

/** The status literal for an unanswered post-dispatch row. It lives here as
 *  a bound constant — never a literal — because the architecture scan
 *  (19.3 item 3) forbids the token within 200 characters of `ShippingRefund`
 *  in app/ sources: every store SQL comparison binds this value instead. */
export const POST_DISPATCH_ENTRY_STATUS = "DISPATCHING";

// Windows and cadences (12.2, 12.4, 12.5, 9.5). All measured on the
// database UTC wall clock against the row's dispatchedAt/respondedAt.
export const DISPATCH_UNANSWERED_MS = 120_000;
export const RECONCILE_TIMING_SKEW_MS = 5 * 60_000;
export const IN_DOUBT_ABSENT_WINDOW_MS = 24 * 3_600_000;
export const IN_DOUBT_READBACK_BACKSTOP_MS = 7 * 24 * 3_600_000;
export const REFUND_RECORDED_VISIBILITY_MS = 15 * 60_000;
export const SETTLEMENT_HORIZON_MS = 72 * 3_600_000;
export const IN_DOUBT_FIRST_HOUR_MS = 3_600_000;
export const IN_DOUBT_POLL_FIRST_HOUR_MS = 5 * 60_000;
export const IN_DOUBT_POLL_AFTER_MS = 15 * 60_000;
export const READ_FAILURE_RETRY_MS = 5 * 60_000;
export const SETTLEMENT_POLL_MARKS_MS = [
  5 * 60_000,
  3_600_000,
  6 * 3_600_000,
] as const;
export const SETTLEMENT_POLL_CADENCE_MS = 6 * 3_600_000;

export interface ReconcileMoneyBag {
  readonly minorUnits: bigint;
  readonly currencyCode: string;
}

export interface ReconcileRefundListEntry {
  readonly id: string;
  readonly note: string | null;
  readonly createdAt: string | null;
  readonly processedAt: string | null;
  readonly totalRefunded: ReconcileMoneyBag | null;
}

export interface ReconcileDetailTransaction {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly gateway: string | null;
  readonly amountMinor: bigint | null;
  readonly currencyCode: string | null;
  readonly parentTransactionId: string | null;
}

export interface ReconcileRefundDetail {
  readonly id: string;
  readonly note: string | null;
  readonly createdAt: string | null;
  readonly processedAt: string | null;
  readonly totalRefunded: ReconcileMoneyBag | null;
  readonly dutiesCount: number;
  readonly shippingLines: readonly {
    readonly subtotal: ReconcileMoneyBag | null;
    readonly taxMinor: bigint | null;
  }[];
  readonly refundLineItemCount: number;
  readonly orderAdjustmentCount: number;
  readonly transactions: readonly ReconcileDetailTransaction[];
}

export interface ReconcileAgreement {
  readonly id: string;
  readonly typename: string;
  readonly reason: string | null;
  readonly appId: string | null;
  readonly refundId: string | null;
  readonly happenedAt: string | null;
}

export type ReconcileListRead =
  | {
      readonly ok: true;
      readonly refunds: readonly ReconcileRefundListEntry[];
      readonly transactions: readonly ReconcileDetailTransaction[];
      readonly totalRefunded: ReconcileMoneyBag | null;
      readonly totalRefundedShipping: ReconcileMoneyBag | null;
    }
  | {
      readonly ok: false;
      readonly completenessUnproven: boolean;
      readonly detail: string;
    };

export interface ReconcileReads {
  readonly list: ReconcileListRead;
  readonly detail:
    | { readonly ok: true; readonly refund: ReconcileRefundDetail }
    | { readonly ok: false; readonly detail: string }
    | null;
  readonly agreements:
    | { readonly ok: true; readonly agreements: readonly ReconcileAgreement[] }
    | { readonly ok: false; readonly detail: string }
    | null;
  readonly appId:
    | { readonly ok: true; readonly id: string }
    | { readonly ok: false; readonly detail: string }
    | null;
  readonly baselineFingerprintChanged?: boolean;
}

export interface ReconcileRowFacts {
  readonly marker: string;
  readonly dispatchedAt: Date;
  readonly respondedAt: Date | null;
  readonly refundId: string | null;
  readonly plannedShippingMinor: string;
  readonly currencyCode: string;
  readonly parentTransactionId: string;
  readonly gateway: string;
  readonly baselineRefundIds: readonly string[];
}

export type ReconcileReviewCode =
  | "ABSENT_AFTER_WINDOW"
  | "EXTERNAL_REFUND"
  | "DUPLICATE_SUSPECTED"
  | "ANOMALY"
  | "ATTRIBUTION_UNAVAILABLE"
  | "ATTRIBUTION_MISMATCH"
  | "ATTRIBUTION_UNVERIFIED"
  | "SETTLEMENT_FAILED"
  | "SETTLEMENT_TIMEOUT"
  | "UNSUPPORTED_TXN_STATUS"
  | "NOT_VISIBLE_AFTER_WINDOW"
  | "READBACK_INCOMPLETE"
  | "INCOMPLETE_AFTER_WINDOW"
  | "BASELINE_UNVERIFIED";

export type ReconcileLagKind =
  | "reads"
  | "visibility"
  | "evidence"
  | "attribution"
  | "settlement"
  | "not-visible";

export type ReconcileDecision =
  | { readonly action: "WAIT"; readonly lag: ReconcileLagKind; readonly detail: string }
  | {
      readonly action: "REVIEW";
      readonly reasonCode: ReconcileReviewCode;
      readonly detail: string;
    }
  | {
      readonly action: "ADOPT";
      readonly refundId: string;
      readonly refundCreatedAt: string | null;
      readonly settlementState: string;
    }
  | {
      readonly action: "VERIFY";
      readonly evidence: Record<string, unknown>;
    };

const wait = (lag: ReconcileLagKind, detail: string): ReconcileDecision => ({
  action: "WAIT",
  lag,
  detail,
});
const review = (
  reasonCode: ReconcileReviewCode,
  detail: string,
): ReconcileDecision => ({ action: "REVIEW", reasonCode, detail });

export type TransactionStatusClass =
  | "SUCCESS"
  | "PENDING_CLASS"
  | "FAILED_CLASS"
  | "UNSUPPORTED";

export function classifyTransactionStatus(
  status: string,
): TransactionStatusClass {
  if (status === "SUCCESS") return "SUCCESS";
  if (status === "PENDING" || status === "AWAITING_RESPONSE") {
    return "PENDING_CLASS";
  }
  if (status === "FAILURE" || status === "ERROR") return "FAILED_CLASS";
  return "UNSUPPORTED";
}

export type AttributionVerdict =
  | { readonly kind: "ATTRIBUTED"; readonly agreementId: string }
  | { readonly kind: "LAG"; readonly detail: string }
  | { readonly kind: "MISMATCH"; readonly detail: string };

/**
 * 12.3 condition 3 over a complete, bounded agreement list: exactly one
 * `RefundAgreement` with `reason = 'REFUND'` may link the refund, with
 * `app.id` equal to the verified current app id and `happenedAt` inside
 * `[dispatchedAt − 5 min, now]`. Any other RefundAgreement on the order
 * whose `refund.id` is non-null and different is contradictory; a null
 * refund link is lag (the link may not be visible yet).
 */
export function evaluateRefundAttribution(args: {
  readonly refundId: string;
  readonly agreements: ReconcileReads["agreements"];
  readonly appId: ReconcileReads["appId"];
  readonly windowStartMs: number;
  readonly nowMs: number;
}): AttributionVerdict {
  if (args.appId === null || !args.appId.ok) {
    return {
      kind: "LAG",
      detail: "Q-APPID unavailable — the verified current app id could not be read",
    };
  }
  if (args.agreements === null || !args.agreements.ok) {
    return {
      kind: "LAG",
      detail: "Q-AGREEMENTS incomplete or unavailable — attribution unproven",
    };
  }
  const refundAgreements = args.agreements.agreements.filter(
    (a) => a.typename === "RefundAgreement" && a.reason === "REFUND",
  );
  const linking = refundAgreements.filter((a) => a.refundId === args.refundId);
  const other = refundAgreements.filter(
    (a) => a.refundId !== null && a.refundId !== args.refundId,
  );
  if (other.length > 0) {
    return {
      kind: "MISMATCH",
      detail:
        `a RefundAgreement links a different refund ` +
        `(${other.map((a) => a.refundId).join(", ")})`,
    };
  }
  if (linking.length > 1) {
    return {
      kind: "MISMATCH",
      detail: `${linking.length} RefundAgreements link refund ${args.refundId}`,
    };
  }
  if (linking.length === 0) {
    const dangling = refundAgreements.filter((a) => a.refundId === null);
    return {
      kind: "LAG",
      detail:
        dangling.length > 0
          ? "a RefundAgreement with a missing refund link exists; attribution not yet proven"
          : "no RefundAgreement links the refund yet",
    };
  }
  const agreement = linking[0];
  if (agreement.appId === null) {
    return { kind: "MISMATCH", detail: "the linked RefundAgreement carries a null app" };
  }
  if (agreement.appId !== args.appId.id) {
    return {
      kind: "MISMATCH",
      detail: `the linked RefundAgreement is attributed to ${agreement.appId}, not ${args.appId.id}`,
    };
  }
  if (agreement.happenedAt === null) {
    return { kind: "MISMATCH", detail: "the linked RefundAgreement has no happenedAt" };
  }
  const happened = Date.parse(agreement.happenedAt);
  if (!Number.isFinite(happened)) {
    return { kind: "MISMATCH", detail: "the linked RefundAgreement happenedAt is unparseable" };
  }
  if (happened < args.windowStartMs || happened > args.nowMs) {
    return {
      kind: "MISMATCH",
      detail: "the linked RefundAgreement happenedAt falls outside the timing window",
    };
  }
  return { kind: "ATTRIBUTED", agreementId: agreement.id };
}

/**
 * Map an attribution verdict onto the outcome for the current
 * ATTRIBUTION_STATUS (12.3.1): under UNVERIFIED even an exactly matching
 * agreement is "not satisfied"; under CONFIRMED a missing agreement is
 * UNAVAILABLE and a contradictory one is MISMATCH. `pastWindow` is the
 * row's attribution window (dispatchedAt + 24 h for IN_DOUBT;
 * respondedAt ?? dispatchedAt + 15 min for REFUND_RECORDED).
 */
export function attributionOutcome(
  verdict: AttributionVerdict,
  attributionStatus: AttributionStatus,
  pastWindow: boolean,
):
  | { readonly satisfied: true }
  | { readonly satisfied: false; readonly decision: ReconcileDecision } {
  if (verdict.kind === "ATTRIBUTED") {
    if (attributionStatus === "CONFIRMED") {
      return { satisfied: true };
    }
    if (!pastWindow) {
      return {
        satisfied: false,
        decision: wait(
          "attribution",
          "attributing agreement found but the attribution status is UNVERIFIED",
        ),
      };
    }
    return {
      satisfied: false,
      decision: review(
        "ATTRIBUTION_UNVERIFIED",
        `agreement ${verdict.agreementId} matches but the attribution status ` +
          "is UNVERIFIED — automatic adoption is prohibited",
      ),
    };
  }
  // A contradiction is never a wait: under CONFIRMED it is the named
  // mismatch review; under UNVERIFIED the same contradiction surfaces as
  // unverified attribution (adoption is prohibited either way).
  if (verdict.kind === "MISMATCH") {
    return {
      satisfied: false,
      decision:
        attributionStatus === "CONFIRMED"
          ? review("ATTRIBUTION_MISMATCH", verdict.detail)
          : review(
              "ATTRIBUTION_UNVERIFIED",
              `${verdict.detail} — attribution status is UNVERIFIED`,
            ),
    };
  }
  if (!pastWindow) {
    return { satisfied: false, decision: wait("attribution", verdict.detail) };
  }
  if (attributionStatus === "CONFIRMED") {
    return {
      satisfied: false,
      decision: review("ATTRIBUTION_UNAVAILABLE", verdict.detail),
    };
  }
  return {
    satisfied: false,
    decision: review(
      "ATTRIBUTION_UNVERIFIED",
      `${verdict.detail} — attribution status is UNVERIFIED`,
    ),
  };
}

type EvidenceVerdict =
  | { readonly ok: true; readonly transaction: ReconcileDetailTransaction }
  | { readonly ok: false; readonly lag: boolean; readonly detail: string };

function financialEvidence(
  refund: ReconcileRefundDetail,
  row: ReconcileRowFacts,
): EvidenceVerdict {
  const planned = BigInt(row.plannedShippingMinor);
  if (refund.totalRefunded === null) {
    return { ok: false, lag: true, detail: "refund totalRefundedSet not yet visible" };
  }
  if (
    refund.totalRefunded.minorUnits !== planned ||
    refund.totalRefunded.currencyCode !== row.currencyCode
  ) {
    return {
      ok: false,
      lag: false,
      detail:
        `refund total ${refund.totalRefunded.minorUnits} ` +
        `${refund.totalRefunded.currencyCode} does not equal the planned ` +
        `${planned} ${row.currencyCode}`,
    };
  }
  if (refund.shippingLines.length === 0) {
    return refund.totalRefunded.minorUnits === 0n
      ? { ok: false, lag: true, detail: "refund shipping lines not yet listed" }
      : { ok: false, lag: false, detail: "marker refund carries no shipping line" };
  }
  if (refund.shippingLines.length !== 1) {
    return {
      ok: false,
      lag: false,
      detail: `marker refund carries ${refund.shippingLines.length} shipping lines`,
    };
  }
  const line = refund.shippingLines[0];
  if (
    line.subtotal === null ||
    line.subtotal.minorUnits !== planned ||
    line.subtotal.currencyCode !== row.currencyCode
  ) {
    return {
      ok: false,
      lag: false,
      detail: "the marker refund's shipping line does not match the planned amount/currency",
    };
  }
  if (line.taxMinor === null || line.taxMinor !== 0n) {
    return { ok: false, lag: false, detail: "the marker refund's shipping line is taxed" };
  }
  if (refund.refundLineItemCount > 0) {
    return { ok: false, lag: false, detail: "the marker refund carries refund line items" };
  }
  if (refund.orderAdjustmentCount > 0) {
    return { ok: false, lag: false, detail: "the marker refund carries order adjustments" };
  }
  if (refund.dutiesCount > 0) {
    return { ok: false, lag: false, detail: "the marker refund carries duties" };
  }
  if (refund.transactions.length === 0) {
    return { ok: false, lag: true, detail: "the marker refund's transactions are not yet listed" };
  }
  if (refund.transactions.length !== 1) {
    return {
      ok: false,
      lag: false,
      detail: `the marker refund carries ${refund.transactions.length} transactions`,
    };
  }
  const txn = refund.transactions[0];
  if (txn.kind !== "REFUND") {
    return { ok: false, lag: false, detail: `refund transaction kind is ${txn.kind}, not REFUND` };
  }
  if (txn.parentTransactionId !== row.parentTransactionId) {
    return {
      ok: false,
      lag: false,
      detail: "refund transaction's parent does not match the frozen parentTransactionId",
    };
  }
  if (txn.gateway === null || txn.gateway !== row.gateway) {
    return { ok: false, lag: false, detail: "refund transaction gateway does not match" };
  }
  if (
    txn.amountMinor === null ||
    txn.amountMinor !== planned ||
    txn.currencyCode === null ||
    txn.currencyCode !== row.currencyCode
  ) {
    return {
      ok: false,
      lag: false,
      detail: "refund transaction amount or currency does not match the planned value",
    };
  }
  return { ok: true, transaction: txn };
}

function timingVerdict(
  refund: { readonly createdAt: string | null; readonly processedAt: string | null },
  row: ReconcileRowFacts,
  nowMs: number,
): { readonly ok: true } | { readonly ok: false; readonly lag: boolean; readonly detail: string } {
  const windowStart = row.dispatchedAt.getTime() - RECONCILE_TIMING_SKEW_MS;
  if (refund.processedAt === null) {
    return { ok: false, lag: true, detail: "refund processedAt not yet visible" };
  }
  const processed = Date.parse(refund.processedAt);
  if (!Number.isFinite(processed)) {
    return { ok: false, lag: false, detail: "refund processedAt is unparseable" };
  }
  if (processed < windowStart || processed > nowMs) {
    return { ok: false, lag: false, detail: "refund processedAt falls outside the timing window" };
  }
  if (refund.createdAt !== null) {
    const created = Date.parse(refund.createdAt);
    if (!Number.isFinite(created)) {
      return { ok: false, lag: false, detail: "refund createdAt is unparseable" };
    }
    if (created < windowStart || created > nowMs) {
      return { ok: false, lag: false, detail: "refund createdAt falls outside the timing window" };
    }
  }
  return { ok: true };
}

/**
 * IN_DOUBT read-back (12.5): adopt only the unique marker refund that
 * satisfies every 12.3 condition including typed app attribution; a missing
 * refund is never proof and every contradiction is an immediate review.
 */
export function classifyInDoubtReadback(
  row: ReconcileRowFacts,
  reads: ReconcileReads,
  ctx: { readonly now: Date; readonly attributionStatus: AttributionStatus },
): ReconcileDecision {
  const nowMs = ctx.now.getTime();
  const pastAbsent =
    nowMs > row.dispatchedAt.getTime() + IN_DOUBT_ABSENT_WINDOW_MS;
  const pastBackstop =
    nowMs > row.dispatchedAt.getTime() + IN_DOUBT_READBACK_BACKSTOP_MS;

  if (!reads.list.ok) {
    if (reads.list.completenessUnproven || pastBackstop) {
      return review("READBACK_INCOMPLETE", reads.list.detail);
    }
    return wait("reads", reads.list.detail);
  }
  const baseline = new Set(row.baselineRefundIds);
  const markerRefunds = reads.list.refunds.filter(
    (r) => typeof r.note === "string" && r.note.includes(row.marker),
  );
  if (markerRefunds.length > 1) {
    return review(
      "DUPLICATE_SUSPECTED",
      `${markerRefunds.length} refunds carry marker ${row.marker}`,
    );
  }
  if (markerRefunds.length === 0) {
    const external = reads.list.refunds.filter((r) => !baseline.has(r.id));
    if (external.length > 0 || reads.baselineFingerprintChanged === true) {
      return review(
        "EXTERNAL_REFUND",
        `refund(s) outside the freeze baseline appeared: ` +
          `${external.map((r) => r.id).join(", ") || "a baseline record's fingerprint changed"}`,
      );
    }
    if (pastAbsent) {
      return review(
        "ABSENT_AFTER_WINDOW",
        `no marker refund on the source order after dispatchedAt + 24 h — ` +
          `the absence of a marker refund is not proof that no money moved`,
      );
    }
    return wait("visibility", "no refund carries the marker yet");
  }

  const marker = markerRefunds[0];
  if (baseline.has(marker.id)) {
    return review("ANOMALY", "the marker refund predates the freeze baseline");
  }
  if (reads.detail === null || !reads.detail.ok) {
    const detail =
      reads.detail === null
        ? "the marker refund's detail was not read"
        : reads.detail.detail;
    return pastAbsent
      ? review("INCOMPLETE_AFTER_WINDOW", detail)
      : wait("evidence", detail);
  }
  const refund = reads.detail.refund;
  if (refund.id !== marker.id) {
    return review("ANOMALY", "the detail read returned a different refund id");
  }
  if (typeof refund.note !== "string" || !refund.note.includes(row.marker)) {
    return review("ANOMALY", "the marker refund's detail no longer carries the marker");
  }

  const fin = financialEvidence(refund, row);
  if (!fin.ok) {
    if (!fin.lag) return review("ANOMALY", fin.detail);
    return pastAbsent
      ? review("INCOMPLETE_AFTER_WINDOW", fin.detail)
      : wait("evidence", fin.detail);
  }
  const txnClass = classifyTransactionStatus(fin.transaction.status);
  if (txnClass === "FAILED_CLASS") {
    return review(
      "SETTLEMENT_FAILED",
      `refund transaction ${fin.transaction.id} is ${fin.transaction.status}`,
    );
  }
  if (txnClass === "UNSUPPORTED") {
    return review(
      "UNSUPPORTED_TXN_STATUS",
      `refund transaction status ${fin.transaction.status}`,
    );
  }
  if (txnClass === "PENDING_CLASS") {
    return pastAbsent
      ? review("INCOMPLETE_AFTER_WINDOW", `refund transaction still ${fin.transaction.status}`)
      : wait("evidence", `refund transaction ${fin.transaction.status} — evidence not yet settled`);
  }

  const timing = timingVerdict(refund, row, nowMs);
  if (!timing.ok) {
    if (!timing.lag) return review("ANOMALY", timing.detail);
    return pastAbsent
      ? review("INCOMPLETE_AFTER_WINDOW", timing.detail)
      : wait("evidence", timing.detail);
  }

  const attribution = evaluateRefundAttribution({
    refundId: marker.id,
    agreements: reads.agreements,
    appId: reads.appId,
    windowStartMs: row.dispatchedAt.getTime() - RECONCILE_TIMING_SKEW_MS,
    nowMs,
  });
  const attr = attributionOutcome(attribution, ctx.attributionStatus, pastAbsent);
  if (!attr.satisfied) return attr.decision;

  return {
    action: "ADOPT",
    refundId: marker.id,
    refundCreatedAt: marker.createdAt,
    settlementState: fin.transaction.status,
  };
}

/**
 * REFUND_RECORDED verification (12.4): the recorded refund must survive a
 * full independent read-back — 12.3 conditions (1)-(6) for the recorded id
 * plus a SUCCESS refund transaction and the aggregate consistency check —
 * before the row may become VERIFIED.
 */
export function classifyRefundVerification(
  row: ReconcileRowFacts,
  reads: ReconcileReads,
  ctx: { readonly now: Date; readonly attributionStatus: AttributionStatus },
): ReconcileDecision {
  const nowMs = ctx.now.getTime();
  const anchor = row.respondedAt ?? row.dispatchedAt;
  const pastVisible = nowMs > anchor.getTime() + REFUND_RECORDED_VISIBILITY_MS;
  const pastSettlement =
    nowMs > row.dispatchedAt.getTime() + SETTLEMENT_HORIZON_MS;

  if (row.refundId === null) {
    return review("ANOMALY", "REFUND_RECORDED row carries no refundId");
  }
  if (!reads.list.ok) {
    if (reads.list.completenessUnproven) {
      return review("READBACK_INCOMPLETE", reads.list.detail);
    }
    return pastSettlement
      ? review(
          "READBACK_INCOMPLETE",
          `reads never completed within the settlement horizon: ${reads.list.detail}`,
        )
      : wait("reads", reads.list.detail);
  }
  const markerRefunds = reads.list.refunds.filter(
    (r) => typeof r.note === "string" && r.note.includes(row.marker),
  );
  if (markerRefunds.length > 1) {
    return review(
      "DUPLICATE_SUSPECTED",
      `${markerRefunds.length} refunds carry marker ${row.marker}`,
    );
  }
  if (markerRefunds.length === 1 && markerRefunds[0].id !== row.refundId) {
    return review(
      "ANOMALY",
      `the marker refund ${markerRefunds[0].id} differs from the recorded ${row.refundId}`,
    );
  }
  const recorded = reads.list.refunds.find((r) => r.id === row.refundId);
  if (recorded === undefined) {
    return pastVisible
      ? review(
          "NOT_VISIBLE_AFTER_WINDOW",
          "the recorded refund is not visible 15 minutes after the response",
        )
      : wait("not-visible", "the recorded refund is not yet visible");
  }
  // 12.4 must satisfy 12.3 condition (1): the recorded refund must still be
  // the unique marker refund. A visible recorded refund that no longer
  // carries the marker is a contradiction — the note was written when the
  // refund was created, so its absence is not lag (C-1).
  if (markerRefunds.length === 0) {
    return review(
      "ANOMALY",
      `the recorded refund ${row.refundId} is visible but no refund carries ` +
        `marker ${row.marker}`,
    );
  }
  if (reads.detail === null || !reads.detail.ok) {
    const detail =
      reads.detail === null
        ? "the recorded refund's detail was not read"
        : reads.detail.detail;
    return pastVisible
      ? review("NOT_VISIBLE_AFTER_WINDOW", detail)
      : wait("not-visible", detail);
  }
  const refund = reads.detail.refund;
  if (refund.id !== row.refundId) {
    return review("ANOMALY", "the detail read returned a different refund id");
  }
  if (typeof refund.note !== "string" || !refund.note.includes(row.marker)) {
    return review(
      "ANOMALY",
      "the recorded refund's detail no longer carries the marker",
    );
  }

  const fin = financialEvidence(refund, row);
  if (!fin.ok) {
    if (!fin.lag) return review("ANOMALY", fin.detail);
    return pastVisible
      ? review("NOT_VISIBLE_AFTER_WINDOW", fin.detail)
      : wait("not-visible", fin.detail);
  }
  const txnClass = classifyTransactionStatus(fin.transaction.status);
  if (txnClass === "FAILED_CLASS") {
    return review(
      "SETTLEMENT_FAILED",
      `refund transaction ${fin.transaction.id} is ${fin.transaction.status}`,
    );
  }
  if (txnClass === "UNSUPPORTED") {
    return review(
      "UNSUPPORTED_TXN_STATUS",
      `refund transaction status ${fin.transaction.status}`,
    );
  }
  if (txnClass === "PENDING_CLASS") {
    return pastSettlement
      ? review(
          "SETTLEMENT_TIMEOUT",
          `refund transaction still ${fin.transaction.status} after the 72-hour horizon`,
        )
      : wait("settlement", `refund transaction ${fin.transaction.status}`);
  }

  const timing = timingVerdict(refund, row, nowMs);
  if (!timing.ok) {
    if (!timing.lag) return review("ANOMALY", timing.detail);
    return pastVisible
      ? review("NOT_VISIBLE_AFTER_WINDOW", timing.detail)
      : wait("not-visible", timing.detail);
  }

  const attribution = evaluateRefundAttribution({
    refundId: row.refundId,
    agreements: reads.agreements,
    appId: reads.appId,
    windowStartMs: row.dispatchedAt.getTime() - RECONCILE_TIMING_SKEW_MS,
    nowMs,
  });
  const attr = attributionOutcome(attribution, ctx.attributionStatus, pastVisible);
  if (!attr.satisfied) return attr.decision;

  const baseline = new Set(row.baselineRefundIds);
  const nonBaseline = reads.list.refunds.filter((r) => !baseline.has(r.id));
  let aggregateCheck: "verified" | "skipped-other-refunds";
  if (nonBaseline.length === 1 && nonBaseline[0].id === row.refundId) {
    const planned = BigInt(row.plannedShippingMinor);
    const agg = reads.list.totalRefunded;
    const ship = reads.list.totalRefundedShipping;
    if (agg === null || ship === null) {
      return wait("evidence", "order refunded aggregates are not yet visible");
    }
    if (
      agg.minorUnits !== planned ||
      agg.currencyCode !== row.currencyCode ||
      ship.minorUnits !== planned ||
      ship.currencyCode !== row.currencyCode
    ) {
      return review(
        "ANOMALY",
        `order aggregates ${ship.minorUnits}/${agg.minorUnits} ` +
          `${agg.currencyCode} do not equal the planned ${planned} ` +
          `${row.currencyCode}`,
      );
    }
    aggregateCheck = "verified";
  } else {
    aggregateCheck = "skipped-other-refunds";
  }

  const verdict = attribution as Extract<
    AttributionVerdict,
    { kind: "ATTRIBUTED" }
  >;
  const verifiedAppId =
    reads.appId !== null && reads.appId.ok ? reads.appId.id : null;
  return {
    action: "VERIFY",
    evidence: {
      refundId: row.refundId,
      agreementId: verdict.agreementId,
      appId: verifiedAppId,
      refundTransactionId: fin.transaction.id,
      amountMinor: row.plannedShippingMinor,
      currencyCode: row.currencyCode,
      aggregateCheck,
      checkedAt: ctx.now.toISOString(),
    },
  };
}

export function inDoubtPollDelayMs(dispatchedAt: Date, now: Date): number {
  return now.getTime() - dispatchedAt.getTime() < IN_DOUBT_FIRST_HOUR_MS
    ? IN_DOUBT_POLL_FIRST_HOUR_MS
    : IN_DOUBT_POLL_AFTER_MS;
}

export function settlementPollDelayMs(dispatchedAt: Date, now: Date): number {
  const elapsed = now.getTime() - dispatchedAt.getTime();
  for (const mark of SETTLEMENT_POLL_MARKS_MS) {
    if (elapsed < mark) return mark - elapsed;
  }
  return SETTLEMENT_POLL_CADENCE_MS;
}

export function reconcileRetryDelayMs(
  lag: ReconcileLagKind,
  row: {
    readonly dispatchedAt: Date;
    readonly status: "IN_DOUBT" | "REFUND_RECORDED";
  },
  now: Date,
): number {
  if (lag === "settlement") return settlementPollDelayMs(row.dispatchedAt, now);
  if (lag === "reads") return READ_FAILURE_RETRY_MS;
  if (row.status === "IN_DOUBT") return inDoubtPollDelayMs(row.dispatchedAt, now);
  return IN_DOUBT_POLL_FIRST_HOUR_MS;
}

export interface GAgreementObservation {
  readonly refundId: string;
  readonly processedAt: string | null;
  readonly agreements: readonly ReconcileAgreement[] | null;
  readonly verifiedAppId: string | null;
  readonly readAtMs: number;
}

export type GAgreementOutcome = "CONFIRMED" | "NEGATIVE" | "INCONCLUSIVE";

/**
 * 12.8.2: classify the recorded BASE/POS/NEG evidence set. A positive match
 * alone is never CONFIRMED — the discriminating negative control (a
 * comparable staff-created refund whose linked RefundAgreement shows a null
 * or different app.id, read after the visibility window) is mandatory.
 */
export function classifyGAgreementEvidence(args: {
  readonly baseRecorded: boolean;
  readonly pos: GAgreementObservation | null;
  readonly negComparable: boolean;
  readonly neg: GAgreementObservation | null;
}): { readonly outcome: GAgreementOutcome; readonly detail: string } {
  const inconclusive = (detail: string) => ({
    outcome: "INCONCLUSIVE" as const,
    detail,
  });
  const negative = (detail: string) => ({
    outcome: "NEGATIVE" as const,
    detail,
  });
  const insideWindow = (obs: GAgreementObservation) =>
    obs.processedAt !== null &&
    obs.readAtMs < Date.parse(obs.processedAt) + REFUND_RECORDED_VISIBILITY_MS;
  const linkedTo = (
    obs: GAgreementObservation,
    typename: string,
    reason: string,
  ) =>
    (obs.agreements ?? []).filter(
      (a) =>
        a.typename === typename &&
        a.reason === reason &&
        a.refundId === obs.refundId,
    );
  const anyLinked = (obs: GAgreementObservation) =>
    (obs.agreements ?? []).filter((a) => a.refundId === obs.refundId);

  if (!args.baseRecorded) return inconclusive("BASE is not recorded");
  if (args.pos === null) return inconclusive("no POS observation");
  if (args.neg === null) return inconclusive("no NEG observation");
  const { pos, neg } = args;

  if (pos.agreements === null || neg.agreements === null) {
    return inconclusive("an agreement list is incomplete");
  }
  if (insideWindow(pos) || insideWindow(neg)) {
    return inconclusive("a read was taken inside the visibility window");
  }

  const posTyped = linkedTo(pos, "RefundAgreement", "REFUND");
  const posAny = anyLinked(pos);
  if (
    posAny.some((a) => a.typename !== "RefundAgreement" || a.reason !== "REFUND")
  ) {
    return negative(
      "POS refund is linked by an agreement of another typename or reason",
    );
  }
  if (posTyped.length === 0) {
    return negative("POS refund has no linked RefundAgreement after the window");
  }
  if (posTyped.length > 1) {
    return negative("two agreements link the POS refund");
  }
  if (pos.verifiedAppId === null || posTyped[0].appId !== pos.verifiedAppId) {
    return negative(
      "the POS agreement's app.id is null or differs from the verified app id",
    );
  }

  if (!args.negComparable) {
    return inconclusive("the NEG control is not a comparable shape");
  }
  const negTyped = linkedTo(neg, "RefundAgreement", "REFUND");
  if (negTyped.length === 0) {
    return inconclusive(
      "the NEG refund has no linked RefundAgreement — possibly lag",
    );
  }
  if (negTyped.length > 1) {
    return negative("two agreements link the NEG refund");
  }
  if (neg.verifiedAppId !== null && negTyped[0].appId === neg.verifiedAppId) {
    return negative(
      "the NEG agreement carries this app's id — the rule cannot distinguish",
    );
  }
  return {
    outcome: "CONFIRMED",
    detail: "POS attributed to this app; NEG attributed to null/different app",
  };
}
