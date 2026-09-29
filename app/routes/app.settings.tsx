import { json } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate, useOutletContext } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  InlineStack,
  Layout,
  List,
  Page,
  Select,
  Text,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSettings, upsertSettings } from "../lib/settings.server";
import { getLocationAccess } from "../lib/location-access.server";
import { REVIEW_TAG } from "../lib/eligibility";
import { StatusDot } from "../components/StatusDot";
import { useLocationAccessRequest } from "../components/useLocationAccessRequest";

// ── Loader ────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, scopes } = await authenticate.admin(request);
  const [settings, locationAccess] = await Promise.all([
    getSettings(session.shop),
    getLocationAccess(admin, scopes, session.shop),
  ]);

  return json({
    settings: {
      autoMergeEnabled: settings.autoMergeEnabled,
      mergeWindowHours: settings.mergeWindowHours,
    },
    locationAccess,
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
      { success: false, error: "Confirm you understand how automatic merging works before turning it on." },
      { status: 400 },
    );
  }

  const rawHours = parseInt(formData.get("mergeWindowHours") as string, 10);
  // Validate against the allowed set so arbitrary values can't be stored.
  const mergeWindowHours = [1, 12, 24].includes(rawHours) ? rawHours : 24;

  await upsertSettings(session.shop, {
    autoMergeEnabled,
    mergeWindowHours,
    ...(turningOn && { autoMergeAcknowledgedAt: new Date() }),
  });
  return json({ success: true, error: null });
};

// ── Component ─────────────────────────────────────────────

const WHAT_HAPPENS = [
  "MergeShip moves the newer order's items onto the customer's earlier order at no extra charge, then cancels the newer order and restocks it.",
  "The cancelled order is not refunded. Any shipping the customer paid on it is not refunded automatically — refund it in Shopify if you choose to.",
  "Customers aren't notified of the change.",
];

const SAFETY_RULES = [
  "Same customer, recipient, shipping address and currency.",
  "Exactly one shipping method on each order, and the same one on both.",
  "Fully paid, not yet fulfilled in any way, and low fraud risk.",
  "Standard shippable products only — no gift cards, subscriptions, bundles or items with custom options.",
  "Every item ships from the same location.",
];

const WINDOW_OPTIONS = [
  { label: "1 hour", value: "1" },
  { label: "12 hours", value: "12" },
  { label: "24 hours", value: "24" },
];

export default function SettingsPage() {
  const { settings, locationAccess, shopHandle, appHandle } = useLoaderData<typeof loader>();
  const { planHandle } = useOutletContext<{ planHandle: string | null }>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const handledRef = useRef<object | null>(null);
  const { request: requestLocationAccess, requesting } = useLocationAccessRequest();

  const [autoMergeEnabled, setAutoMergeEnabled] = useState(settings.autoMergeEnabled);
  const [acknowledged, setAcknowledged] = useState(false);
  const [mergeWindowHours, setMergeWindowHours] = useState(String(settings.mergeWindowHours));

  // Re-sync local state after a save reloads the loader data.
  useEffect(() => {
    setAutoMergeEnabled(settings.autoMergeEnabled);
    setMergeWindowHours(String(settings.mergeWindowHours));
    setAcknowledged(false);
  }, [settings.autoMergeEnabled, settings.mergeWindowHours]);

  // Show a toast once per completed save — the ref guard prevents re-firing
  // if the component re-renders while fetcher.data is unchanged.
  useEffect(() => {
    if (!fetcher.data || fetcher.data === handledRef.current) return;
    handledRef.current = fetcher.data;
    if (fetcher.data.success) shopify.toast.show("Settings saved");
    else if (fetcher.data.error) shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);

  const turningOn = autoMergeEnabled && !settings.autoMergeEnabled;
  const dirty =
    autoMergeEnabled !== settings.autoMergeEnabled ||
    mergeWindowHours !== String(settings.mergeWindowHours);
  const multiLocation =
    locationAccess.activeLocationCount !== null && locationAccess.activeLocationCount > 1;
  const planName = planHandle ? planHandle.charAt(0).toUpperCase() + planHandle.slice(1) : null;

  const handleSave = () => {
    fetcher.submit(
      {
        autoMergeEnabled: String(autoMergeEnabled),
        acknowledged: String(acknowledged),
        mergeWindowHours,
      },
      { method: "post" },
    );
  };

  return (
    <Page
      title="Settings"
      backAction={{ content: "MergeShip", onAction: () => navigate("/app") }}
      primaryAction={{
        content: "Save",
        onAction: handleSave,
        loading: fetcher.state !== "idle",
        disabled: !dirty || (turningOn && !acknowledged),
      }}
    >
      <TitleBar title="Settings" />
      <Layout>
        {locationAccess.blocked && (
          <Layout.Section>
            <Banner
              tone="warning"
              title="MergeShip can't combine orders yet"
              action={{ content: "Allow location access", loading: requesting, onAction: requestLocationAccess }}
            >
              <p>
                Your store has {locationAccess.activeLocationCount} active
                locations. Allow read-only location access so MergeShip can
                confirm repeat orders ship from the same place.
              </p>
            </Banner>
          </Layout.Section>
        )}

        <Layout.AnnotatedSection
          title="Automation"
          description="When this is on, MergeShip combines eligible repeat orders from the same customer before you fulfill them."
        >
          <Card>
            <BlockStack gap="400">
              <StatusDot
                on={settings.autoMergeEnabled}
                label={settings.autoMergeEnabled ? "Automatic merging is on" : "Automatic merging is off"}
              />
              <Checkbox
                label="Combine eligible repeat orders automatically"
                checked={autoMergeEnabled}
                onChange={(value) => {
                  setAutoMergeEnabled(value);
                  if (!value) setAcknowledged(false);
                }}
              />
              {turningOn && (
                <Banner tone="warning" title="Before you turn this on">
                  <BlockStack gap="300">
                    <List type="bullet">
                      {WHAT_HAPPENS.map((line) => (
                        <List.Item key={line}>{line}</List.Item>
                      ))}
                    </List>
                    <Checkbox
                      label="I understand MergeShip will edit and cancel eligible orders, and won't refund shipping."
                      checked={acknowledged}
                      onChange={setAcknowledged}
                    />
                  </BlockStack>
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection
          title="Merge window"
          description="Repeat orders are only combined when they're placed within this time of each other."
        >
          <Card>
            <Select
              label="Combine orders placed within"
              options={WINDOW_OPTIONS}
              value={mergeWindowHours}
              onChange={setMergeWindowHours}
            />
          </Card>
        </Layout.AnnotatedSection>

        {multiLocation && (
          <Layout.AnnotatedSection
            title="Location access"
            description="Needed in stores with more than one location, so MergeShip can confirm both orders ship from the same place."
          >
            <Card>
              {locationAccess.granted ? (
                <StatusDot on label={`Allowed · ${locationAccess.activeLocationCount} active locations`} />
              ) : (
                <InlineStack align="space-between" blockAlign="center" gap="300">
                  <StatusDot on={false} label="Not allowed — no orders will be combined" />
                  <Button onClick={requestLocationAccess} loading={requesting}>
                    Allow location access
                  </Button>
                </InlineStack>
              )}
            </Card>
          </Layout.AnnotatedSection>
        )}

        <Layout.AnnotatedSection
          title="Safety rules"
          description="Always enforced. MergeShip only combines orders when it can verify they're safe to combine. Orders that don't qualify are left untouched."
        >
          <Card>
            <BlockStack gap="300">
              <Text as="p">Orders are combined only when they have:</Text>
              <List type="bullet">
                {SAFETY_RULES.map((rule) => (
                  <List.Item key={rule}>{rule}</List.Item>
                ))}
              </List>
              <Text as="p" tone="subdued">
                If MergeShip can't confirm a combine finished, it tags the
                orders “{REVIEW_TAG}” and flags them on the dashboard.
              </Text>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection
          title="Plan & billing"
          description="Billing is handled by Shopify and appears on your Shopify invoice."
        >
          <Card>
            <InlineStack align="space-between" blockAlign="center" gap="300">
              <Text as="p">{planName ? `${planName} plan` : "No active plan"}</Text>
              {appHandle && (
                <Button
                  variant="plain"
                  url={`https://admin.shopify.com/store/${shopHandle}/charges/${appHandle}/pricing_plans`}
                  target="_top"
                >
                  Manage plan
                </Button>
              )}
            </InlineStack>
          </Card>
        </Layout.AnnotatedSection>
      </Layout>
    </Page>
  );
}
