import type { ReactNode } from "react";
import { BlockStack, Box, InlineGrid, Text } from "@shopify/polaris";

/**
 * One Settings row: title + short explanation on the left, the control on the
 * right. Short controls are vertically centred against their explanation;
 * long content (align="start") lines up with the title instead.
 */
export function SettingsSection({
  title,
  description,
  align = "center",
  children,
}: {
  title: string;
  description: ReactNode;
  align?: "center" | "start";
  children: ReactNode;
}) {
  return (
    <Box paddingBlock="400">
      <InlineGrid columns={{ xs: "1fr", md: "2fr 3fr" }} gap={{ xs: "300", md: "800" }} alignItems={align}>
        <BlockStack gap="100">
          <Text as="h2" variant="headingSm">
            {title}
          </Text>
          <Text as="p" tone="subdued">
            {description}
          </Text>
        </BlockStack>
        <Box>{children}</Box>
      </InlineGrid>
    </Box>
  );
}
