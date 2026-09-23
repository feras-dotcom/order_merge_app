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
  const { settings, billingStatus } = useLoaderData<typeof loader>();
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
    <Page backAction={{ content: "Orders", onAction: () => navigate("/app") }}>
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
    </Page>
  );
}
