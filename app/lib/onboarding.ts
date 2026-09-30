// ── Onboarding requirements ───────────────────────────────────────────────────
// Pure rules shared by the onboarding UI and its server action, so what the
// merchant sees and what the server enforces can never disagree.

// ── Merge window ──────────────────────────────────────────────────────────────
// Stored as whole hours (Settings.mergeWindowHours). Presets cover the common
// cases; Custom accepts any whole number of hours or days up to the maximum.
//
// Maximum: 7 days. The window doesn't change the candidate query (the webhook
// always reads the customer's 50 most recent open, unfulfilled, paid orders),
// but every order inside the window becomes a candidate that executeMerge
// loads and checks individually (~4 Admin API calls each), and an order that
// has sat unfulfilled for over a week is increasingly likely to be held,
// pre-ordered or already being picked — not something to add items to.

export const MERGE_WINDOW_PRESETS = [1, 6, 24, 48] as const;
export const DEFAULT_MERGE_WINDOW_HOURS = 24;
export const MAX_MERGE_WINDOW_HOURS = 7 * 24;

export const isValidMergeWindow = (hours: unknown): hours is number =>
  typeof hours === "number" && Number.isInteger(hours) && hours >= 1 && hours <= MAX_MERGE_WINDOW_HOURS;

export type MergeWindowUnit = "hours" | "days";

/** Converts a custom entry to hours, or null if it isn't a valid window. */
export function customWindowToHours(value: string, unit: MergeWindowUnit): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const hours = Number(value) * (unit === "days" ? 24 : 1);
  return isValidMergeWindow(hours) ? hours : null;
}

/** How a stored window is shown: a preset, or a custom value in days/hours. */
export function describeMergeWindow(hours: number):
  | { preset: true; hours: number }
  | { preset: false; value: number; unit: MergeWindowUnit } {
  if ((MERGE_WINDOW_PRESETS as readonly number[]).includes(hours)) return { preset: true, hours };
  return hours % 24 === 0 ? { preset: false, value: hours / 24, unit: "days" } : { preset: false, value: hours, unit: "hours" };
}

export interface LocationState {
  /** null when Shopify's location count could not be read. */
  activeLocationCount: number | null;
  /** Every optional location scope is granted. */
  granted: boolean;
}

export type LocationRequirement =
  /** Single-location store: nothing to do. */
  | "not-needed"
  /** Multi-location store and access is granted. */
  | "granted"
  /** Multi-location store: the merchant must allow location access. */
  | "needs-access"
  /** The location count could not be read, so the state can't be verified. */
  | "unknown";

export function locationRequirement({ activeLocationCount, granted }: LocationState): LocationRequirement {
  if (activeLocationCount === null) return "unknown";
  if (activeLocationCount <= 1) return "not-needed";
  return granted ? "granted" : "needs-access";
}

export const locationRequirementMet = (state: LocationState) =>
  ["not-needed", "granted"].includes(locationRequirement(state));

export type OnboardingRequirement = "merge-window" | "location" | "acknowledgement";

/** Everything still missing before setup can be completed (empty = ready). */
export function missingOnboardingRequirements(input: {
  mergeWindowHours: unknown;
  location: LocationState;
  acknowledged: boolean;
}): OnboardingRequirement[] {
  const missing: OnboardingRequirement[] = [];
  if (!isValidMergeWindow(input.mergeWindowHours)) missing.push("merge-window");
  if (!locationRequirementMet(input.location)) missing.push("location");
  if (!input.acknowledged) missing.push("acknowledgement");
  return missing;
}

/** Setup is finished; only then may automatic merging run. */
export const isOnboardingComplete = (settings: { onboardingCompletedAt: Date | string | null }) =>
  settings.onboardingCompletedAt !== null;

// ── Merchant-facing copy shared by onboarding and Settings ─────────────────────

export const SAFETY_RULES = [
  "They're from the same customer, going to the same recipient and address, in the same currency.",
  "Each has exactly one shipping method, and it's the same on both.",
  "They're fully paid, have no fulfillment activity yet, and have a low fraud risk.",
  "They contain standard shippable products — no gift cards, subscriptions, bundles or items with custom options.",
  "Every item ships from the same location.",
];

export const WHAT_HAPPENS = [
  "Items from the newer order are moved onto the customer's earlier order at no extra charge.",
  "The newer order is cancelled and its stock is restocked. Customers aren't notified.",
  "Shipping charged on the newer order is not refunded automatically — refund it in Shopify if you choose to.",
];
