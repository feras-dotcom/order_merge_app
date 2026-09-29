import { Box, InlineStack, Text } from "@shopify/polaris";

/** Small, quiet status indicator: a dot and a short label. */
export function StatusDot({ on, label }: { on: boolean; label: string }) {
  return (
    <InlineStack gap="150" blockAlign="center" wrap={false}>
      <Box
        as="span"
        background={on ? "bg-fill-success" : "bg-fill-disabled"}
        borderRadius="full"
        minWidth="8px"
        minHeight="8px"
      />
      <Text as="span" variant="bodySm" tone="subdued">
        {label}
      </Text>
    </InlineStack>
  );
}
