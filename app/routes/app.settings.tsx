import { json } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Form, useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
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
import { authenticate, PLAN_PRO } from "../shopify.server";
import { getSettings, upsertSettings } from "../lib/settings.server";

// ── Loader ────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);

  if (process.env.BYPASS_BILLING !== "true") {
    const shopName = session.shop.replace(".myshopify.com", "");
    const returnUrl = `https://admin.shopify.com/store/${shopName}/apps/${process.env.SHOPIFY_API_KEY}`;
    await billing.require({
      plans: [PLAN_PRO],
      isTest: true,
      onFailure: async () =>
        billing.request({ plan: PLAN_PRO, isTest: true, returnUrl }),
    });
  }

  const settings = await getSettings(session.shop);

  // Retrieve live subscription status for the billing card.
  // billing.require above already guarantees an active subscription exists;
  // check is best-effort and falls back gracefully if the API is unavailable.
  let billingStatus: "active" | "trial" | "unknown" = "active";
  try {
    const check = await billing.check({ plans: [PLAN_PRO], isTest: true });
    const sub = (check.appSubscriptions as any[]).find(
      (s) => s.name === PLAN_PRO,
    );
    if (sub?.status === "ACTIVE" && sub?.trialDays && sub.trialDays > 0) {
      billingStatus = "trial";
    }
  } catch {
    // non-fatal — status stays "active" since billing.require already passed
  }

  return json({ settings, billingStatus });
};

// ── Action ────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  // ── Billing management: redirect to Shopify's subscription confirmation ───
  if (intent === "manage-billing") {
    const shopName = session.shop.replace(".myshopify.com", "");
    const returnUrl = `https://admin.shopify.com/store/${shopName}/apps/${process.env.SHOPIFY_API_KEY}/settings`;
    // billing.request throws a Remix redirect Response that App Bridge intercepts
    // and handles correctly inside the embedded admin iframe.
    await billing.request({ plan: PLAN_PRO, isTest: true, returnUrl });
    // The line below is never reached; billing.request always throws.
    return json({ success: false });
  }

  // ── Settings save ─────────────────────────────────────────────────────────
  const autoMergeEnabled = formData.get("autoMergeEnabled") === "true";
  const locationMatchEnabled = formData.get("locationMatchEnabled") === "true";

  const rawHours = parseInt(formData.get("mergeWindowHours") as string, 10);
  // Validate against the allowed set so arbitrary values can't be stored.
  const mergeWindowHours = [1, 12, 24].includes(rawHours) ? rawHours : 24;

  const rawSavings = parseFloat(formData.get("shippingCostSavings") as string);
  // Clamp to a sensible range; fall back to the default if invalid.
  const shippingCostSavings =
    Number.isFinite(rawSavings) && rawSavings >= 0 && rawSavings <= 9999
      ? Math.round(rawSavings * 100) / 100
      : 8.5;

  await upsertSettings(session.shop, {
    autoMergeEnabled,
    mergeWindowHours,
    shippingCostSavings,
    locationMatchEnabled,
  });
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
  const { settings, billingStatus } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const handledRef = useRef<object | null>(null);

  const [autoMergeEnabled, setAutoMergeEnabled] = useState(
    settings.autoMergeEnabled,
  );
  const [locationMatchEnabled, setLocationMatchEnabled] = useState(
    settings.locationMatchEnabled ?? true,
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
        locationMatchEnabled: String(locationMatchEnabled),
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

            <Checkbox
              label="Only merge orders from the same warehouse location"
              helpText="When enabled, orders whose items are assigned to different fulfillment locations are never merged. This prevents split shipments and keeps savings accurate."
              checked={locationMatchEnabled}
              onChange={setLocationMatchEnabled}
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
                <Badge tone={billingStatus === "trial" ? "attention" : "success"}>
                  {billingStatus === "trial" ? "Trial" : "Active"}
                </Badge>
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

            <InlineStack align="end">
              {/* Use a plain Form so the billing.request redirect navigates
                  correctly rather than being swallowed by a fetcher. */}
              <Form method="post">
                <input type="hidden" name="intent" value="manage-billing" />
                <Button submit variant="secondary">
                  Manage subscription
                </Button>
              </Form>
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
