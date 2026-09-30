import { useState } from "react";
import { BlockStack, InlineStack, Select, TextField } from "@shopify/polaris";
import {
  customWindowToHours,
  DEFAULT_MERGE_WINDOW_HOURS,
  describeMergeWindow,
  MAX_MERGE_WINDOW_HOURS,
  MERGE_WINDOW_PRESETS,
  type MergeWindowUnit,
} from "../lib/onboarding";

const presetLabel = (h: number) =>
  h === 1 ? "1 hour" : h === DEFAULT_MERGE_WINDOW_HOURS ? `${h} hours (default)` : `${h} hours`;

const OPTIONS = [
  ...MERGE_WINDOW_PRESETS.map((h) => ({ label: presetLabel(h), value: String(h) })),
  { label: "Custom", value: "custom" },
];

const UNIT_OPTIONS = [
  { label: "Hours", value: "hours" },
  { label: "Days", value: "days" },
];

/**
 * Merge-window picker shared by onboarding and Settings. Reports the window in
 * hours, or null while a custom entry is invalid. Remount (via `key`) to reset
 * it to a new saved value.
 */
export function MergeWindowField({
  initialHours,
  onChange,
  label = "Combine orders placed within",
}: {
  initialHours: number;
  onChange: (hours: number | null) => void;
  label?: string;
}) {
  const initial = describeMergeWindow(initialHours);
  const [choice, setChoice] = useState(initial.preset ? String(initial.hours) : "custom");
  const [customValue, setCustomValue] = useState(initial.preset ? "" : String(initial.value));
  const [unit, setUnit] = useState<MergeWindowUnit>(initial.preset ? "days" : initial.unit);

  const customHours = customWindowToHours(customValue, unit);
  const maxLabel = unit === "days" ? `${MAX_MERGE_WINDOW_HOURS / 24} days` : `${MAX_MERGE_WINDOW_HOURS} hours`;
  const customError =
    choice === "custom" && customValue !== "" && customHours === null
      ? `Enter a whole number from 1 up to ${maxLabel}.`
      : undefined;

  const report = (nextChoice: string, nextValue: string, nextUnit: MergeWindowUnit) =>
    onChange(nextChoice === "custom" ? customWindowToHours(nextValue, nextUnit) : Number(nextChoice));

  return (
    <BlockStack gap="300">
      <Select
        label={label}
        options={OPTIONS}
        value={choice}
        onChange={(value) => {
          setChoice(value);
          report(value, customValue, unit);
        }}
      />
      {choice === "custom" && (
        <InlineStack gap="200" blockAlign="start" wrap={false}>
          <div style={{ flex: 1 }}>
            <TextField
              label="Custom window"
              labelHidden
              type="number"
              min={1}
              max={unit === "days" ? MAX_MERGE_WINDOW_HOURS / 24 : MAX_MERGE_WINDOW_HOURS}
              value={customValue}
              onChange={(value) => {
                setCustomValue(value);
                report(choice, value, unit);
              }}
              error={customError}
              helpText={customError ? undefined : `Up to ${MAX_MERGE_WINDOW_HOURS / 24} days (${MAX_MERGE_WINDOW_HOURS} hours).`}
              autoComplete="off"
              placeholder={unit === "days" ? "e.g. 3" : "e.g. 12"}
            />
          </div>
          <div style={{ width: 120 }}>
            <Select
              label="Unit"
              labelHidden
              options={UNIT_OPTIONS}
              value={unit}
              onChange={(value) => {
                setUnit(value as MergeWindowUnit);
                report(choice, customValue, value as MergeWindowUnit);
              }}
            />
          </div>
        </InlineStack>
      )}
    </BlockStack>
  );
}
