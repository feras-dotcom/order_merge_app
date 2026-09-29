import { json } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useOutletContext,
  useRevalidator,
} from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  Divider,
  InlineStack,
  List,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSettings, upsertSettings } from "../lib/settings.server";
import { gql } from "../lib/graphql.server";
import { LOCATION_SCOPES } from "../lib/eligibility";

// ── Loader ────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, scopes } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);

  // Multi-location shops need every optional location scope so MergeShip can
  // verify both orders ship from the same location.
  let locationScopeGranted = false;
  try {
    const granted = (await scopes.query()).granted;
    locationScopeGranted = LOCATION_SCOPES.every((scope) => granted.includes(scope));
  } catch (err: any) {
    console.warn(`[settings] Could not query scopes for ${session.shop}: ${err?.message}`);
  }

  let activeLocationCount: number | null = null;
  try {
    const result = await gql<{ count: number }>(
      admin,
      "Count locations",
      `#graphql
        query SettingsLocationCount {
          locationsCount(query: "active:true") { count }
        }`,
      {},
      "locationsCount",
      null,
    );
    activeLocationCount = result.count;
  } catch (err: any) {
    console.warn(`[settings] Could not count locations for ${session.shop}: ${err?.message}`);
  }

  return json({
    settings: {
      autoMergeEnabled: settings.autoMergeEnabled,
      mergeWindowHours: settings.mergeWindowHours,
      shippingCostSavings: settings.shippingCostSavings,
    },
    activeLocationCount,
    locationScopeGranted,
    shopHandle: session.shop.replace(".myshopify.com", ""),
    appHandle: process.env.SHOPIFY_APP_HANDLE || "",
  });
};

// ── Action ────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const current = await getSettings(session.shop);

  const autoMergeEnabled = formData.get("autoMergeEnabled") === "true";
  const acknowledged = formData.get("acknowledged") === "true";

  // Turning auto-merge on requires explicit acknowledgement of what it does.
  // Enforced here, not only in the UI.
  const turningOn = autoMergeEnabled && !current.autoMergeEnabled;
  if (turningOn && !acknowledged) {
    return json(
      { success: false, error: "Please confirm you understand how automatic merging works before enabling it." },
      { status: 400 },
    );
  }

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
    ...(turningOn && { autoMergeAcknowledgedAt: new Date() }),
  });
  return json({ success: true, error: null });
};

// ── Component ─────────────────────────────────────────────

const WHAT_IT_DOES = [
  "When a new order qualifies, MergeShip adds its items to the customer's oldest matching open order at no extra charge, then cancels the newer order and restocks its inventory.",
  "Cancelled orders are not refunded. Duplicate shipping the customer paid on the newer order is NOT refunded automatically — refund it yourself in Shopify if you choose to.",
  "Customers are not notified of the edit or the cancellation.",
  "If MergeShip cannot confirm a merge finished, the orders are tagged “MergeShip-Review”. Check those orders before fulfilling them.",
];

const SAFETY_RULES = [
  {
    title: "Same customer, recipient and address",
    description:
      "Orders merge only when the customer, the recipient's name and company, and every line of the shipping address match.",
  },
  {
    title: "One identical shipping method",
    description:
      "Each order must have exactly one shipping method, and they must match (ignoring letter case and extra spaces), so no customer loses a shipping upgrade they paid for.",
  },
  {
    title: "Fully paid, completely unfulfilled, low risk",
    description:
      "Only fully paid, open orders with no fulfillment activity at all and a LOW Shopify fraud risk are merged. Partially fulfilled, on-hold or in-progress orders never qualify.",
  },
  {
    title: "Only simple, shippable items",
    description:
      "Orders containing gift cards, subscriptions, bundles, items with custom properties, custom or deleted products, or items that don't need shipping are left untouched.",
  },
  {
    title: "Same fulfillment location",
    description:
      "Orders merge only when every item in every order is assigned to the same fulfillment location and none of it is on hold, scheduled or sent to a fulfillment service. If MergeShip can't confirm this, the orders are left untouched.",
  },
];

const WINDOW_OPTIONS = [
  { label: "1 hour", value: "1" },
  { label: "12 hours", value: "12" },
  { label: "24 hours", value: "24" },
];

export default function SettingsPage() {
  const { settings, activeLocationCount, locationScopeGranted, shopHandle, appHandle } =
    useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const { planHandle } = useOutletContext<{ planHandle: string | null }>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const handledRef = useRef<object | null>(null);

  const [autoMergeEnabled, setAutoMergeEnabled] = useState(settings.autoMergeEnabled);
  const [acknowledged, setAcknowledged] = useState(false);
  const [mergeWindowHours, setMergeWindowHours] = useState(String(settings.mergeWindowHours));
  const [shippingCostSavings, setShippingCostSavings] = useState(
    String(settings.shippingCostSavings ?? 8.5),
  );

  const turningOn = autoMergeEnabled && !settings.autoMergeEnabled;
  const multiLocation = activeLocationCount !== null && activeLocationCount > 1;

  // Opens Shopify's permission modal for the optional scopes, then reloads the
  // loader data so the banner reflects the merchant's choice.
  const [requestingScope, setRequestingScope] = useState(false);
  const requestLocationScope = async () => {
    setRequestingScope(true);
    try {
      const response = await shopify.scopes.request(LOCATION_SCOPES);
      if (response.result === "granted-all") shopify.toast.show("Location access allowed");
      revalidator.revalidate();
    } catch {
      shopify.toast.show("Could not request location access", { isError: true });
    } finally {
      setRequestingScope(false);
    }
  };

  // Show a toast once per completed save — the ref guard prevents re-firing
  // if the component re-renders while fetcher.data is unchanged.
  useEffect(() => {
    if (!fetcher.data || fetcher.data === handledRef.current) return;
    handledRef.current = fetcher.data;
    if (fetcher.data.success) shopify.toast.show("Settings saved");
    else if (fetcher.data.error) shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);

  const handleSave = () => {
    fetcher.submit(
      {
        autoMergeEnabled: String(autoMergeEnabled),
        acknowledged: String(acknowledged),
        mergeWindowHours,
        shippingCostSavings,
      },
      { method: "post" },
    );
  };

  const saveDisabled = turningOn && !acknowledged;
  const planName = planHandle ? planHandle.charAt(0).toUpperCase() + planHandle.slice(1) : null;

  return (
    <Page
      title="Settings"
      backAction={{ content: "MergeShip", onAction: () => navigate("/app") }}
    >
      <TitleBar title="Settings" />
      <BlockStack gap="500">
        {multiLocation && !locationScopeGranted && (
          <Banner
            tone="warning"
            title="Allow MergeShip to check fulfillment locations"
            action={{
              content: "Allow location access",
              loading: requestingScope,
              onAction: requestLocationScope,
            }}
          >
            <p>
              Your store has {activeLocationCount} active locations. To merge
              orders safely, MergeShip needs read-only access to fulfillment
              orders and locations so it can confirm both orders ship from the
              same location.
              Until you allow this, no orders will be merged in this store.
            </p>
          </Banner>
        )}

        {multiLocation && locationScopeGranted && (
          <Banner tone="info" title="Multi-location merging is on">
            <p>
              MergeShip merges orders only when all of their items are assigned
              to the same fulfillment location. Orders split across locations,
              or handled by a fulfillment service, are left untouched.
            </p>
          </Banner>
        )}

        {/* ── Automation Rules ────────────────────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Automation Rules
              </Text>
              {settings.autoMergeEnabled ? (
                <Badge tone="success">Automatic merging on</Badge>
              ) : (
                <Badge>Automatic merging off</Badge>
              )}
            </InlineStack>

            <Checkbox
              label="Enable automatic order merging"
              helpText="New orders that pass every safety rule below are automatically combined with the same customer's matching open order."
              checked={autoMergeEnabled}
              onChange={(value) => {
                setAutoMergeEnabled(value);
                if (!value) setAcknowledged(false);
              }}
            />

            {turningOn && (
              <Banner tone="warning" title="Before you turn on automatic merging">
                <BlockStack gap="300">
                  <List type="bullet">
                    {WHAT_IT_DOES.map((line) => (
                      <List.Item key={line}>{line}</List.Item>
                    ))}
                  </List>
                  <Checkbox
                    label="I understand MergeShip will edit and cancel qualifying orders, and will not refund duplicate shipping charges."
                    checked={acknowledged}
                    onChange={setAcknowledged}
                  />
                </BlockStack>
              </Banner>
            )}

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
                disabled={saveDisabled}
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
                disabled={saveDisabled}
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
            <InlineStack gap="200" align="start" blockAlign="center">
              <Text as="span" variant="bodyMd" fontWeight="semibold">
                Current plan:
              </Text>
              <Text as="span" variant="bodyMd">
                {planName ?? "—"}
              </Text>
              <Badge tone="success">Managed by Shopify</Badge>
            </InlineStack>
            {appHandle && (
              <InlineStack>
                <Button
                  url={`https://admin.shopify.com/store/${shopHandle}/charges/${appHandle}/pricing_plans`}
                  target="_top"
                >
                  View or change plan
                </Button>
              </InlineStack>
            )}
            <Text as="p" variant="bodySm" tone="subdued">
              Billing is managed securely through Shopify. Your payment details
              are never shared with us.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
