import { describe, expect, it } from "vitest";
import {
  customWindowToHours,
  DEFAULT_MERGE_WINDOW_HOURS,
  describeMergeWindow,
  MAX_MERGE_WINDOW_HOURS,
  MERGE_WINDOW_PRESETS,
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

  it.each([0, -1, 169, 2.5, "24", null, undefined, NaN])("rejects merge window %o", (mergeWindowHours) => {
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
        mergeWindowHours: 500,
        location: { activeLocationCount: 4, granted: false },
        acknowledged: false,
      }),
    ).toEqual(["merge-window", "location", "acknowledgement"]);
  });
});

describe("helpers", () => {
  it("validates merge windows", () => {
    // Presets, the old 12-hour preset (still stored by existing shops) and the 7-day maximum.
    expect([1, 6, 12, 24, 48, 72, 168].every(isValidMergeWindow)).toBe(true);
    expect(isValidMergeWindow(169)).toBe(false);
  });
  it("treats only a completion timestamp as complete", () => {
    expect(isOnboardingComplete({ onboardingCompletedAt: null })).toBe(false);
    expect(isOnboardingComplete({ onboardingCompletedAt: new Date() })).toBe(true);
  });
});

describe("merge window custom entry", () => {
  it.each([
    ["12", "hours", 12],
    ["3", "days", 72],
    ["7", "days", 168],
    ["168", "hours", 168],
    ["1", "hours", 1],
  ] as const)("%s %s → %d hours", (value, unit, hours) => {
    expect(customWindowToHours(value, unit)).toBe(hours);
  });

  it.each([
    ["8", "days"],
    ["169", "hours"],
    ["0", "hours"],
    ["", "hours"],
    ["1.5", "days"],
    ["-2", "hours"],
    ["abc", "days"],
  ] as const)("rejects %j %s", (value, unit) => {
    expect(customWindowToHours(value, unit)).toBeNull();
  });

  it("shows presets as presets and other stored values as custom, in days when whole", () => {
    expect(describeMergeWindow(24)).toEqual({ preset: true, hours: 24 });
    expect(describeMergeWindow(12)).toEqual({ preset: false, value: 12, unit: "hours" });
    expect(describeMergeWindow(72)).toEqual({ preset: false, value: 3, unit: "days" });
  });

  it("offers the requested presets with 24 hours as the default", () => {
    expect([...MERGE_WINDOW_PRESETS]).toEqual([1, 6, 24, 48]);
    expect(DEFAULT_MERGE_WINDOW_HOURS).toBe(24);
    expect(MAX_MERGE_WINDOW_HOURS).toBe(168);
  });
});
