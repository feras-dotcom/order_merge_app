import { json } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  Checkbox,
  Divider,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSettings, upsertSettings } from "../lib/settings.server";

// ── Loader ────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);
  return json({ settings });
};

// ── Action ────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  // ── Settings save ─────────────────────────────────────────────────────────
  const autoMergeEnabled = formData.get("autoMergeEnabled") === "true";

  const rawHours = parseInt(formData.get("mergeWindowHours") as string, 10);
  // Validate against the allowed set so arbitrary values can't be stored.
  const mergeWindowHours = [1, 12, 24].includes(rawHours) ? rawHours : 24;

  const rawSavings = parseFloat(formData.get("shippingCostSavings") as string);
  // Clamp to a sensible range; fall back to the default if invalid.
  const shippingCostSavings =
    Number.isFinite(rawSavings) && rawSavings >= 0 && rawSavings <= 9999
      ? Math.round(rawSavings * 100) / 100
      : 8.5;

  await upsertSettings(session.shop, { autoMergeEnabled, mergeWindowHours, shippingCostSavings });
  return json({ success: true });
};

// ── Component ─────────────────────────────────────────────

const SAFETY_RULES = [
  {
    title: "Require identical shipping method",
    description:
      "Orders merge only when their shipping methods match (ignoring letter case and extra spaces), so no customer loses a shipping upgrade they paid for.",
  },
  {
    title: "Require paid status",
    description:
      "Only fully paid, non-cancelled orders are merged, so unpaid items are never absorbed into a paid order.",
  },
];

const WINDOW_OPTIONS = [
  { label: "1 hour", value: "1" },
  { label: "12 hours", value: "12" },
  { label: "24 hours", value: "24" },
];

export default function SettingsPage() {
  const { settings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const handledRef = useRef<object | null>(null);

  const [autoMergeEnabled, setAutoMergeEnabled] = useState(
    settings.autoMergeEnabled,
  );
  const [mergeWindowHours, setMergeWindowHours] = useState(
    String(settings.mergeWindowHours),
  );
  const [shippingCostSavings, setShippingCostSavings] = useState(
    String(settings.shippingCostSavings ?? 8.5),
  );

  // Show a success toast once per completed save — the ref guard prevents
  // re-firing if the component re-renders while fetcher.data is unchanged.
  useEffect(() => {
    if (!fetcher.data || fetcher.data === handledRef.current) return;
    handledRef.current = fetcher.data;
    if (fetcher.data.success) {
      shopify.toast.show("Settings saved");
    }
  }, [fetcher.data, shopify]);

  const handleSave = () => {
    fetcher.submit(
      {
        autoMergeEnabled: String(autoMergeEnabled),
        mergeWindowHours,
        shippingCostSavings,
      },
      { method: "post" },
    );
  };

  return (
    <Page
      title="Settings"
      backAction={{ content: "MergeShip", onAction: () => navigate("/app") }}
    >
      <TitleBar title="Settings" />
      <BlockStack gap="500">
        {/* ── Automation Rules ────────────────────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Automation Rules
            </Text>

            <Checkbox
              label="Enable automatic order merging"
              helpText="When enabled, new paid orders are automatically merged with matching open orders for the same customer."
              checked={autoMergeEnabled}
              onChange={setAutoMergeEnabled}
            />

            <Select
              label="Merge time window"
              helpText="Only orders created within this window of each other are merged automatically."
              options={WINDOW_OPTIONS}
              value={mergeWindowHours}
              onChange={setMergeWindowHours}
            />

            <InlineStack align="end">
              <Button
                variant="primary"
                onClick={handleSave}
                loading={fetcher.state !== "idle"}
              >
                Save
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>

        {/* ── Savings Estimate ────────────────────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">
                Savings Estimate
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Enter your average shipping label cost. MergeShip uses this
                amount to calculate the Total Shipping Saved metric on the
                dashboard.
              </Text>
            </BlockStack>

            <TextField
              label="Estimated shipping label savings"
              helpText="Average cost per label saved when orders are consolidated (USD)."
              type="number"
              prefix="$"
              value={shippingCostSavings}
              onChange={setShippingCostSavings}
              autoComplete="off"
              min="0"
              step={0.01}
            />

            <InlineStack align="end">
              <Button
                variant="primary"
                onClick={handleSave}
                loading={fetcher.state !== "idle"}
              >
                Save
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>

        {/* ── Safety Filters (always enforced) ────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Safety Filters
            </Text>

            {SAFETY_RULES.map((rule, i) => (
              <BlockStack key={rule.title} gap="400">
                {i > 0 && <Divider />}
                <BlockStack gap="100">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h3" variant="headingSm">
                      {rule.title}
                    </Text>
                    <Badge tone="success">Active</Badge>
                  </InlineStack>
                  <Text as="p" variant="bodyMd">
                    {rule.description}
                  </Text>
                </BlockStack>
              </BlockStack>
            ))}

            <Divider />
            <Text as="p" variant="bodyMd">
              These rules protect your shipments and cannot be turned off.
              Orders that fail them are never merged and stay exactly as the
              customer placed them.
            </Text>
          </BlockStack>
        </Card>

        {/* ── Plan and Billing ────────────────────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Plan and Billing
            </Text>

            <BlockStack gap="200">
              <InlineStack gap="200" align="start" blockAlign="center">
                <Text as="span" variant="bodyMd" fontWeight="semibold">
                  Current plan:
                </Text>
                <Text as="span" variant="bodyMd">
                  Pro Plan
                </Text>
                <Badge tone="success">Managed by Shopify</Badge>
              </InlineStack>

              <InlineStack gap="200" align="start">
                <Text as="span" variant="bodyMd" fontWeight="semibold">
                  Price:
                </Text>
                <Text as="span" variant="bodyMd">
                  $19 / month
                </Text>
              </InlineStack>

              <InlineStack gap="200" align="start">
                <Text as="span" variant="bodyMd" fontWeight="semibold">
                  Free trial:
                </Text>
                <Text as="span" variant="bodyMd">
                  14 days
                </Text>
              </InlineStack>

              <Text as="p" variant="bodySm" tone="subdued">
                Billing is managed securely through Shopify. Your payment details
                are never shared with us.
              </Text>
            </BlockStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
