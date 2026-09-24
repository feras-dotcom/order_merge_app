import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useRevalidator } from "@remix-run/react";
import { useState } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Card,
  EmptyState,
  IndexFilters,
  IndexTable,
  InlineGrid,
  InlineStack,
  Link,
  Page,
  Text,
  useSetIndexFiltersMode,
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

  return {
    autoMergeEnabled: settings.autoMergeEnabled,
    historyLimit: HISTORY_LIMIT,
    consolidatedCount,
    history: records.map((r) => ({
      id: r.id,
      primaryOrderId: r.primaryOrderId,
      primaryOrderName: r.primaryOrderName,
      mergedOrderId: r.mergedOrderId,
      mergedOrderName: r.mergedOrderName,
      customerName: (r.customerId && customerNames.get(r.customerId)) || "—",
      itemsCombined: r.itemsCombined,
      mergedAt: r.createdAt.toISOString(),
    })),
  };
};

// ── Components ───────────────────────────────────────────

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

export default function Index() {
  const { autoMergeEnabled, historyLimit, consolidatedCount, history } =
    useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const { mode, setMode } = useSetIndexFiltersMode();
  const [query, setQuery] = useState("");

  const needle = query.trim().toLowerCase();
  const rows = needle
    ? history.filter((r) =>
        [r.primaryOrderName, r.mergedOrderName, r.customerName].some((value) =>
          value.toLowerCase().includes(needle),
        ),
      )
    : history;

  return (
    <Page
      title="MergeShip"
      subtitle="Automated order consolidation"
      titleMetadata={
        autoMergeEnabled ? (
          <Badge tone="success">Auto Merge Active</Badge>
        ) : (
          <Badge tone="attention">Auto Merge Paused</Badge>
        )
      }
      primaryAction={{
        content: "Scan Orders",
        onAction: () => revalidator.revalidate(),
        loading: revalidator.state === "loading",
      }}
    >
      <TitleBar title="MergeShip" />
      <BlockStack gap="500">
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

        {history.length === 0 ? (
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
          <Card padding="0">
            <Box padding="400" paddingBlockEnd="200">
              <Text as="h2" variant="headingMd">
                Consolidation History
              </Text>
            </Box>
            <IndexFilters
              tabs={[{ id: "all-consolidations", content: "All" }]}
              selected={0}
              queryValue={query}
              queryPlaceholder="Search by order number or customer"
              onQueryChange={setQuery}
              onQueryClear={() => setQuery("")}
              cancelAction={{ onAction: () => setQuery("") }}
              filters={[]}
              appliedFilters={[]}
              onClearAll={() => setQuery("")}
              hideFilters
              canCreateNewView={false}
              mode={mode}
              setMode={setMode}
            />
            <IndexTable
              resourceName={{ singular: "consolidation", plural: "consolidations" }}
              itemCount={rows.length}
              selectable={false}
              headings={[
                { title: "Primary Order" },
                { title: "Merged Order" },
                { title: "Customer Name" },
                { title: "Total Items Combined", alignment: "end" },
                { title: "Date" },
                { title: "Shipping Saved", alignment: "end" },
              ]}
            >
              {rows.map((r, i) => (
                <IndexTable.Row key={r.id} id={r.id} position={i}>
                  <IndexTable.Cell>
                    <Link url={orderAdminUrl(r.primaryOrderId)} target="_blank" removeUnderline>
                      {r.primaryOrderName}
                    </Link>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <InlineStack gap="200" blockAlign="center" wrap={false}>
                      <Link url={orderAdminUrl(r.mergedOrderId)} target="_blank" removeUnderline>
                        {r.mergedOrderName}
                      </Link>
                      <Badge>Cancelled</Badge>
                    </InlineStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{r.customerName}</IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" alignment="end" numeric>
                      {r.itemsCombined}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{formatDate(r.mergedAt)}</IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" alignment="end" tone="success" numeric>
                      +{formatCurrency(SHIPPING_SAVINGS_PER_MERGE)}
                    </Text>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
            {history.length === historyLimit && (
              <Box padding="400">
                <Text as="p" variant="bodySm" tone="subdued" alignment="center">
                  Showing the latest {historyLimit} consolidations.
                </Text>
              </Box>
            )}
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
