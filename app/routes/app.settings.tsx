import { json } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate, useOutletContext } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import {
  Banner,
  BlockStack,
  Box,
  Card,
  Checkbox,
  InlineStack,
  Link,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSettings, upsertSettings } from "../lib/settings.server";
import { getLocationAccess } from "../lib/location-access.server";
import { REVIEW_TAG } from "../lib/eligibility";
import {
  isOnboardingComplete,
  isValidMergeWindow,
  SAFETY_RULES,
  WHAT_HAPPENS,
} from "../lib/onboarding";
import type { PlanPrice } from "../lib/billing.server";
import { MergeWindowField } from "../components/MergeWindowField";
import { StatusDot } from "../components/StatusDot";
import { SettingsSection } from "../components/SettingsSection";
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
      acknowledged: settings.autoMergeAcknowledgedAt !== null,
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
  const turningOn = autoMergeEnabled && !current.autoMergeEnabled;

  // Automation is first turned on at the end of onboarding; Settings can only
  // resume it afterwards. Both rules are enforced here, not only in the UI.
  if (turningOn && !isOnboardingComplete(current)) {
    return json({ success: false, error: "Finish setting up MergeShip before turning on automatic merging." }, { status: 400 });
  }
  const acknowledgedNow = formData.get("acknowledged") === "true";
  if (turningOn && !current.autoMergeAcknowledgedAt && !acknowledgedNow) {
    return json(
      { success: false, error: "Confirm you understand how automatic merging works before turning it on." },
      { status: 400 },
    );
  }

  const mergeWindowHours = Number(formData.get("mergeWindowHours"));
  if (!isValidMergeWindow(mergeWindowHours)) {
    return json({ success: false, error: "Choose a valid merge window." }, { status: 400 });
  }

  await upsertSettings(session.shop, {
    autoMergeEnabled,
    mergeWindowHours,
    ...(turningOn && !current.autoMergeAcknowledgedAt && { autoMergeAcknowledgedAt: new Date() }),
  });
  return json({ success: true, error: null });
};

// ── Component ─────────────────────────────────────────────

function formatPlan(planHandle: string | null, price: PlanPrice | null) {
  if (!planHandle) return "No active plan";
  const name = planHandle.charAt(0).toUpperCase() + planHandle.slice(1);
  if (!price) return name;
  const value = Number(price.amount);
  const amount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: price.currency,
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
  const period = price.billingPeriod === "ANNUAL" ? "year" : "month";
  return `${name} — ${amount}/${period}`;
}

export default function SettingsPage() {
  const { settings, locationAccess, shopHandle, appHandle } = useLoaderData<typeof loader>();
  const { planHandle, planPrice } = useOutletContext<{ planHandle: string | null; planPrice: PlanPrice | null }>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const handledRef = useRef<object | null>(null);
  const { request: requestLocationAccess, requesting } = useLocationAccessRequest();

  const [autoMergeEnabled, setAutoMergeEnabled] = useState(settings.autoMergeEnabled);
  const [acknowledged, setAcknowledged] = useState(false);
  const [mergeWindowHours, setMergeWindowHours] = useState<number | null>(settings.mergeWindowHours);

  // Re-sync local state after a save reloads the loader data.
  useEffect(() => {
    setAutoMergeEnabled(settings.autoMergeEnabled);
    setMergeWindowHours(settings.mergeWindowHours);
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

  // Only a merchant who has never acknowledged (e.g. migrated from an early
  // version) is asked again when resuming automation.
  const needsAcknowledgement = autoMergeEnabled && !settings.autoMergeEnabled && !settings.acknowledged;
  const dirty =
    autoMergeEnabled !== settings.autoMergeEnabled || mergeWindowHours !== settings.mergeWindowHours;
  const blocked = locationAccess.requirement === "needs-access";

  const handleSave = () => {
    fetcher.submit(
      {
        autoMergeEnabled: String(autoMergeEnabled),
        acknowledged: String(acknowledged),
        mergeWindowHours: String(mergeWindowHours),
      },
      { method: "post" },
    );
  };

  const statusLabel = !settings.autoMergeEnabled
    ? "Automatic merging is paused"
    : blocked
      ? "Automatic merging is stopped · needs location access"
      : "Automatic merging is on";

  return (
    <Page
      title="Settings"
      backAction={{ content: "MergeShip", onAction: () => navigate("/app") }}
      primaryAction={{
        content: "Save",
        onAction: handleSave,
        loading: fetcher.state !== "idle",
        disabled: !dirty || mergeWindowHours === null || (needsAcknowledgement && !acknowledged),
      }}
    >
      <TitleBar title="Settings" />
      <BlockStack>
        <SettingsSection
          title="Automation"
          description="When this is on, MergeShip combines eligible repeat orders from the same customer before you fulfill them."
        >
          <Card>
            <BlockStack gap="300">
              <StatusDot
                tone={!settings.autoMergeEnabled ? "neutral" : blocked ? "caution" : "success"}
                label={statusLabel}
              />
              <Checkbox
                label="Combine eligible repeat orders automatically"
                checked={autoMergeEnabled}
                onChange={(value) => {
                  setAutoMergeEnabled(value);
                  if (!value) setAcknowledged(false);
                }}
              />
              {needsAcknowledgement && (
                <Banner tone="warning" title="Before you turn this on">
                  <BlockStack gap="300">
                    <List type="bullet">
                      {WHAT_HAPPENS.map((line) => (
                        <List.Item key={line}>{line}</List.Item>
                      ))}
                    </List>
                    <Checkbox
                      label="I understand MergeShip will move items onto the earlier order, cancel the newer order, and won't refund its shipping."
                      checked={acknowledged}
                      onChange={setAcknowledged}
                    />
                  </BlockStack>
                </Banner>
              )}
            </BlockStack>
          </Card>
        </SettingsSection>

        <SettingsSection
          title="Merge window"
          description="Repeat orders are only combined when they're placed within this time of each other."
        >
          <Card>
            {/* Remounts after a save so it reflects the stored value. */}
            <MergeWindowField
              key={settings.mergeWindowHours}
              initialHours={settings.mergeWindowHours}
              onChange={setMergeWindowHours}
            />
          </Card>
        </SettingsSection>

        {locationAccess.requirement !== "not-needed" && (
          <SettingsSection
            title="Location access"
            description="Needed in stores with more than one location, so MergeShip can confirm both orders ship from the same place."
          >
            {locationAccess.requirement === "needs-access" ? (
              <Banner
                tone="warning"
                title="MergeShip can't combine orders right now"
                action={{ content: "Allow location access", loading: requesting, onAction: requestLocationAccess }}
              >
                <p>
                  Your store now has {locationAccess.activeLocationCount} active
                  locations. Allow read-only location access to continue
                  automatic combining.
                </p>
              </Banner>
            ) : (
              <Card>
                {locationAccess.requirement === "granted" ? (
                  <StatusDot on label={`Allowed · ${locationAccess.activeLocationCount} active locations`} />
                ) : (
                  <Text as="p" tone="subdued">
                    MergeShip couldn't check your store's locations just now.
                  </Text>
                )}
              </Card>
            )}
          </SettingsSection>
        )}

        <SettingsSection
          title="Safety rules"
          align="start"
          description="Always enforced. MergeShip only combines orders when it can verify they're safe to combine. Orders that don't qualify are left untouched."
        >
          <Card>
            <BlockStack gap="200">
              <Text as="p">MergeShip only combines orders when:</Text>
              <List type="bullet">
                {SAFETY_RULES.map((rule) => (
                  <List.Item key={rule}>{rule}</List.Item>
                ))}
              </List>
              <Box paddingBlockStart="100">
                <Text as="p" variant="bodySm" tone="subdued">
                  If MergeShip can't confirm a combine finished, it tags the
                  orders “{REVIEW_TAG}” and flags them on the dashboard.
                </Text>
              </Box>
            </BlockStack>
          </Card>
        </SettingsSection>

        <SettingsSection title="Plan & billing" description="Managed through Shopify.">
          <Card>
            <InlineStack align="space-between" blockAlign="center" gap="300">
              <Text as="p" tone="subdued">
                {formatPlan(planHandle, planPrice)}
              </Text>
              {appHandle && (
                <Link url={`https://admin.shopify.com/store/${shopHandle}/charges/${appHandle}/pricing_plans`} target="_top" removeUnderline>
                  Manage plan →
                </Link>
              )}
            </InlineStack>
          </Card>
        </SettingsSection>
      </BlockStack>
    </Page>
  );
}
