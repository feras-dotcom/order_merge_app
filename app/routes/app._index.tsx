import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useRevalidator } from "@remix-run/react";
import { useState } from "react";
import type { ReactNode } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Card,
  Divider,
  EmptyState,
  InlineGrid,
  InlineStack,
  Link,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate, PLAN_PRO } from "../shopify.server";
import db from "../db.server";
import { getSettings } from "../lib/settings.server";

// ── Helpers ──────────────────────────────────────────────

const SHIPPING_SAVINGS_PER_MERGE = 8.5;
const HISTORY_LIMIT = 100;
const EMPTY_STATE_IMAGE =
  "https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png";

const orderAdminUrl = (gid: string) =>
  `shopify:admin/orders/${gid.replace("gid://shopify/Order/", "")}`;

// Returns "YYYY-MM-DD HH:MM UTC" — stable across server and client renders
const formatDate = (iso: string) =>
  `${iso.replace("T", " ").slice(0, 16)} UTC`;

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    amount,
  );

// ── Loader ───────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, billing } = await authenticate.admin(request);

  // BYPASS_BILLING=true in .env skips the billing gate entirely so local
  // development can continue without hitting Shopify billing API limits.
  if (process.env.BYPASS_BILLING !== "true") {
    // isTest:true on both require (to find test subscriptions in the check)
    // and request (to create a test charge on dev stores).
    // returnUrl points to the Shopify admin embedded URL so the merchant
    // lands back inside the admin after approving rather than hitting a bare
    // tunnel URL and re-triggering the OAuth flow.
    const shopName = session.shop.replace(".myshopify.com", "");
    const returnUrl = `https://admin.shopify.com/store/${shopName}/apps/${process.env.SHOPIFY_API_KEY}`;
    await billing.require({
      plans: [PLAN_PRO],
      isTest: true,
      onFailure: async () =>
        billing.request({ plan: PLAN_PRO, isTest: true, returnUrl }),
    });
  }

  const shop = session.shop;
  const [settings, consolidatedCount, records] = await Promise.all([
    getSettings(shop),
    db.mergeRecord.count({ where: { shop } }),
    db.mergeRecord.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: HISTORY_LIMIT,
    }),
  ]);

  // Customer names are looked up live so no personal data is stored locally.
  const customerIds = [
    ...new Set(records.map((r) => r.customerId).filter((id): id is string => !!id)),
  ];
  const customerNames = new Map<string, string>();
  if (customerIds.length) {
    try {
      const res = await admin.graphql(
        `#graphql
          query CustomerNames($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Customer {
                id
                displayName
              }
            }
          }`,
        { variables: { ids: customerIds } },
      );
      for (const node of (await res.json()).data?.nodes ?? []) {
        if (node?.id) customerNames.set(node.id, node.displayName);
      }
    } catch (err) {
      console.error("Could not load customer names for consolidation history:", err);
    }
  }

  // Rows written by one merge share the primary order and timestamp (a single
  // createMany INSERT), so group them into one consolidation event each.
  const events = new Map<string, ConsolidationEvent>();
  for (const r of records) {
    const mergedAt = r.createdAt.toISOString();
    const key = `${r.primaryOrderId}|${mergedAt}`;
    const event = events.get(key) ?? {
      id: key,
      primaryOrderId: r.primaryOrderId,
      primaryOrderName: r.primaryOrderName,
      customerName: (r.customerId && customerNames.get(r.customerId)) || "—",
      mergedAt,
      absorbed: [],
    };
    event.absorbed.push({
      id: r.id,
      orderId: r.mergedOrderId,
      orderName: r.mergedOrderName,
      itemsCombined: r.itemsCombined,
    });
    events.set(key, event);
  }

  return {
    autoMergeEnabled: settings.autoMergeEnabled,
    historyLimit: HISTORY_LIMIT,
    recordsShown: records.length,
    consolidatedCount,
    events: [...events.values()],
  };
};

interface ConsolidationEvent {
  id: string;
  primaryOrderId: string;
  primaryOrderName: string;
  customerName: string;
  mergedAt: string;
  absorbed: {
    id: string;
    orderId: string;
    orderName: string;
    itemsCombined: number;
  }[];
}

// ── Components ───────────────────────────────────────────

type SerializedEvent = ReturnType<
  typeof useLoaderData<typeof loader>
>["events"][number];

function MetricCard({
  label,
  value,
  helpText,
}: {
  label: string;
  value: string;
  helpText: string;
}) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="h3" variant="headingSm" tone="subdued">
          {label}
        </Text>
        <Text as="p" variant="heading2xl">
          {value}
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          {helpText}
        </Text>
      </BlockStack>
    </Card>
  );
}

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <BlockStack gap="100">
      <Text as="span" variant="bodySm" tone="subdued">
        {label}
      </Text>
      <Text as="span" variant="bodyMd" fontWeight="medium">
        {children}
      </Text>
    </BlockStack>
  );
}

function ConsolidationCard({ event }: { event: SerializedEvent }) {
  const items = event.absorbed.reduce((n, a) => n + a.itemsCombined, 0);
  const saved = event.absorbed.length * SHIPPING_SAVINGS_PER_MERGE;

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" gap="300">
          <InlineStack gap="300" blockAlign="center">
            <Link
              url={orderAdminUrl(event.primaryOrderId)}
              target="_blank"
              removeUnderline
            >
              <Text as="span" variant="headingMd" fontWeight="bold">
                {event.primaryOrderName}
              </Text>
            </Link>
            <Badge tone="success">Primary (Fulfill this)</Badge>
          </InlineStack>
          <Text as="p" variant="headingMd" tone="success">
            +{formatCurrency(saved)} Saved
          </Text>
        </InlineStack>

        <BlockStack gap="200">
          {event.absorbed.map((a) => (
            <Box key={a.id} paddingInlineStart="400">
              <InlineStack gap="300" blockAlign="center">
                <Text as="span" variant="bodyLg" tone="subdued">
                  ↳
                </Text>
                <Text as="span" variant="bodyMd" textDecorationLine="line-through">
                  <Link url={orderAdminUrl(a.orderId)} target="_blank" removeUnderline>
                    {a.orderName}
                  </Link>
                </Text>
                <Badge>{"Merged & Cancelled"}</Badge>
              </InlineStack>
            </Box>
          ))}
        </BlockStack>

        <Divider />

        <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
          <MetaItem label="Customer">{event.customerName}</MetaItem>
          <MetaItem label="Items combined">
            {items} {items === 1 ? "item" : "items"}
          </MetaItem>
          <MetaItem label="Merged">{formatDate(event.mergedAt)}</MetaItem>
        </InlineGrid>
      </BlockStack>
    </Card>
  );
}

export default function Index() {
  const { autoMergeEnabled, historyLimit, recordsShown, consolidatedCount, events } =
    useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [query, setQuery] = useState("");

  const needle = query.trim().toLowerCase();
  const visibleEvents = needle
    ? events.filter((e) =>
        [e.primaryOrderName, e.customerName, ...e.absorbed.map((a) => a.orderName)].some(
          (value) => value.toLowerCase().includes(needle),
        ),
      )
    : events;

  return (
    <Page
      title="MergeShip"
      subtitle="Automated order consolidation"
      titleMetadata={
        autoMergeEnabled ? (
          <Badge tone="success" progress="complete">
            Auto Merge Active
          </Badge>
        ) : (
          <Badge tone="attention" progress="incomplete">
            Auto Merge Paused
          </Badge>
        )
      }
      primaryAction={{
        content: "Sync Orders",
        onAction: () => revalidator.revalidate(),
        loading: revalidator.state === "loading",
      }}
    >
      <TitleBar title="MergeShip" />
      <BlockStack gap="600">
        <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
          <MetricCard
            label="Orders Consolidated"
            value={consolidatedCount.toLocaleString("en-US")}
            helpText="Duplicate orders absorbed automatically"
          />
          <MetricCard
            label="Total Shipping Saved"
            value={formatCurrency(consolidatedCount * SHIPPING_SAVINGS_PER_MERGE)}
            helpText={`Based on ${formatCurrency(SHIPPING_SAVINGS_PER_MERGE)} per consolidation`}
          />
          <MetricCard
            label="Boxes Saved"
            value={consolidatedCount.toLocaleString("en-US")}
            helpText="One fewer package per consolidated order"
          />
        </InlineGrid>

        {events.length === 0 ? (
          <Card>
            <EmptyState heading="No orders merged yet" image={EMPTY_STATE_IMAGE}>
              <p>
                MergeShip is actively monitoring new orders. When a customer
                places duplicate orders matching your rules within the time
                window, they will automatically consolidate here.
              </p>
            </EmptyState>
          </Card>
        ) : (
          <BlockStack gap="400">
            <BlockStack gap="100">
              <Text as="h2" variant="headingLg">
                Consolidation History
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Each card is one automatic merge. Fulfill the primary order;
                absorbed orders were cancelled and their items moved over.
              </Text>
            </BlockStack>

            <TextField
              label="Search consolidations"
              labelHidden
              placeholder="Search by order number or customer"
              value={query}
              onChange={setQuery}
              clearButton
              onClearButtonClick={() => setQuery("")}
              autoComplete="off"
            />

            {visibleEvents.length > 0 ? (
              visibleEvents.map((event) => (
                <ConsolidationCard key={event.id} event={event} />
              ))
            ) : (
              <Card>
                <Text as="p" variant="bodyMd" tone="subdued" alignment="center">
                  No consolidations match “{query.trim()}”.
                </Text>
              </Card>
            )}

            {recordsShown === historyLimit && (
              <Text as="p" variant="bodySm" tone="subdued" alignment="center">
                Showing the latest {historyLimit} consolidated orders.
              </Text>
            )}
          </BlockStack>
        )}
      </BlockStack>
    </Page>
  );
}
