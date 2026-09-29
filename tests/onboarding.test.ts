import { describe, expect, it } from "vitest";
import {
  isOnboardingComplete,
  isValidMergeWindow,
  locationRequirement,
  missingOnboardingRequirements,
} from "../app/lib/onboarding";

describe("locationRequirement", () => {
  it.each([
    [{ activeLocationCount: 1, granted: false }, "not-needed"],
    [{ activeLocationCount: 0, granted: false }, "not-needed"],
    [{ activeLocationCount: 3, granted: false }, "needs-access"],
    [{ activeLocationCount: 3, granted: true }, "granted"],
    [{ activeLocationCount: null, granted: true }, "unknown"],
  ] as const)("%o → %s", (state, expected) => {
    expect(locationRequirement(state)).toBe(expected);
  });
});

describe("missingOnboardingRequirements", () => {
  const ok = { mergeWindowHours: 24, location: { activeLocationCount: 1, granted: false }, acknowledged: true };

  it("is empty when everything is in place", () => {
    expect(missingOnboardingRequirements(ok)).toEqual([]);
  });

  it.each([0, 2, 48, "24", null, undefined, NaN])("rejects merge window %o", (mergeWindowHours) => {
    expect(missingOnboardingRequirements({ ...ok, mergeWindowHours })).toContain("merge-window");
  });

  it("requires location access in a multi-location store", () => {
    expect(missingOnboardingRequirements({ ...ok, location: { activeLocationCount: 2, granted: false } })).toEqual([
      "location",
    ]);
  });

  it("does not ask a single-location store for location access", () => {
    expect(missingOnboardingRequirements({ ...ok, location: { activeLocationCount: 1, granted: false } })).toEqual([]);
  });

  it("blocks completion when locations can't be verified", () => {
    expect(missingOnboardingRequirements({ ...ok, location: { activeLocationCount: null, granted: true } })).toEqual([
      "location",
    ]);
  });

  it("requires the acknowledgement", () => {
    expect(missingOnboardingRequirements({ ...ok, acknowledged: false })).toEqual(["acknowledgement"]);
  });

  it("reports every missing requirement at once", () => {
    expect(
      missingOnboardingRequirements({
        mergeWindowHours: 5,
        location: { activeLocationCount: 4, granted: false },
        acknowledged: false,
      }),
    ).toEqual(["merge-window", "location", "acknowledgement"]);
  });
});

describe("helpers", () => {
  it("validates merge windows", () => {
    expect([1, 12, 24].every(isValidMergeWindow)).toBe(true);
    expect(isValidMergeWindow(6)).toBe(false);
  });
  it("treats only a completion timestamp as complete", () => {
    expect(isOnboardingComplete({ onboardingCompletedAt: null })).toBe(false);
    expect(isOnboardingComplete({ onboardingCompletedAt: new Date() })).toBe(true);
  });
});
