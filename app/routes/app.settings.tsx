import { json } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import {
  BlockStack,
  Button,
  Card,
  Checkbox,
  InlineStack,
  Page,
  Select,
  Text,
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
  return json({ settings });
};

// ── Action ────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const autoMergeEnabled = formData.get("autoMergeEnabled") === "true";

  const rawHours = parseInt(formData.get("mergeWindowHours") as string, 10);
  // Validate against the allowed set so arbitrary values can't be stored.
  const mergeWindowHours = [1, 12, 24].includes(rawHours) ? rawHours : 24;

  await upsertSettings(session.shop, { autoMergeEnabled, mergeWindowHours });
  return json({ success: true });
};

// ── Component ─────────────────────────────────────────────

const WINDOW_OPTIONS = [
  { label: "1 hour", value: "1" },
  { label: "12 hours", value: "12" },
  { label: "24 hours", value: "24" },
];

export default function SettingsPage() {
  const { settings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const handledRef = useRef<object | null>(null);

  const [autoMergeEnabled, setAutoMergeEnabled] = useState(
    settings.autoMergeEnabled,
  );
  const [mergeWindowHours, setMergeWindowHours] = useState(
    String(settings.mergeWindowHours),
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
      },
      { method: "post" },
    );
  };

  return (
    <Page>
      <TitleBar title="Settings" />
      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingMd">
            Auto-merge preferences
          </Text>

          <Checkbox
            label="Enable automatic order merging"
            helpText="When enabled, new paid orders are automatically merged with matching open orders for the same customer."
            checked={autoMergeEnabled}
            onChange={setAutoMergeEnabled}
          />

          <Select
            label="Merge window"
            helpText="Only orders created within this window of each other will be considered merge candidates."
            options={WINDOW_OPTIONS}
            value={mergeWindowHours}
            onChange={setMergeWindowHours}
            disabled={!autoMergeEnabled}
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
    </Page>
  );
}
