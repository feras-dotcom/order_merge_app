// ── Onboarding requirements ───────────────────────────────────────────────────
// Pure rules shared by the onboarding UI and its server action, so what the
// merchant sees and what the server enforces can never disagree.

export const MERGE_WINDOW_HOURS = [1, 12, 24] as const;

export const isValidMergeWindow = (hours: unknown): hours is number =>
  typeof hours === "number" && (MERGE_WINDOW_HOURS as readonly number[]).includes(hours);

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
