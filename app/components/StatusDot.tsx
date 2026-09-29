import { InlineStack, Text } from "@shopify/polaris";

export type StatusTone = "success" | "caution" | "neutral";

// Polaris icon colours are tuned for contrast on white surfaces.
const DOT_COLOR: Record<StatusTone, string> = {
  success: "var(--p-color-icon-success)",
  caution: "var(--p-color-icon-caution)",
  neutral: "var(--p-color-icon-secondary)",
};

/** Small, quiet status indicator: a dot and a short label. */
export function StatusDot({
  on,
  tone,
  label,
}: {
  /** Shorthand: on → success, off → neutral. */
  on?: boolean;
  tone?: StatusTone;
  label: string;
}) {
  const resolved: StatusTone = tone ?? (on ? "success" : "neutral");
  return (
    <InlineStack gap="150" blockAlign="center" wrap={false}>
      <span
        aria-hidden
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          flexShrink: 0,
          borderRadius: "50%",
          background: DOT_COLOR[resolved],
        }}
      />
      <Text as="span" variant="bodySm" tone="subdued">
        {label}
      </Text>
    </InlineStack>
  );
}
