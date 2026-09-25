import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
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
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getSettings } from "../lib/settings.server";

// ── Helpers ──────────────────────────────────────────────

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
  const { admin, session } = await authenticate.admin(request);
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

  // Look up customer names and each primary order's current item count live
  // in one request, so no personal data is stored locally and the item total
  // reflects the consolidated package (original + transferred items).
  const lookupIds = [
    ...new Set([
      ...records.map((r) => r.primaryOrderId),
      ...records.map((r) => r.customerId).filter((id): id is string => !!id),
    ]),
  ];
  const customerNames = new Map<string, string>();
  const itemsToFulfill = new Map<string, number>();
  if (lookupIds.length) {
    try {
      const res = await admin.graphql(
        `#graphql
          query ConsolidationLookups($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Order {
                id
                currentSubtotalLineItemsQuantity
              }
              ... on Customer {
                id
                displayName
              }
            }
          }`,
        { variables: { ids: lookupIds } },
      );
      for (const node of (await res.json()).data?.nodes ?? []) {
        if (!node?.id) continue;
        if (typeof node.currentSubtotalLineItemsQuantity === "number") {
          itemsToFulfill.set(node.id, node.currentSubtotalLineItemsQuantity);
        }
        if (node.displayName) customerNames.set(node.id, node.displayName);
      }
    } catch (err) {
      console.error("Could not load consolidation history details:", err);
    }
  }

  // One card per primary order, combining every order it has absorbed.
  // Records arrive newest first, so the first row seen is the latest merge
  // and cards stay ordered by most recent activity.
  const groups = new Map<string, ConsolidationGroup>();
  for (const r of records) {
    const group = groups.get(r.primaryOrderId) ?? {
      primaryOrderId: r.primaryOrderId,
      primaryOrderName: r.primaryOrderName,
      customerName: (r.customerId && customerNames.get(r.customerId)) || "—",
      itemsToFulfill: itemsToFulfill.get(r.primaryOrderId) ?? null,
      latestMergeAt: r.createdAt.toISOString(),
      absorbed: [],
    };
    group.absorbed.push({ id: r.id, orderId: r.mergedOrderId, orderName: r.mergedOrderName });
    groups.set(r.primaryOrderId, group);
  }

  return {
    autoMergeEnabled: settings.autoMergeEnabled,
    shippingCostSavings: settings.shippingCostSavings ?? 8.5,
    historyLimit: HISTORY_LIMIT,
    recordsShown: records.length,
    consolidatedCount,
    groups: [...groups.values()],
  };
};

interface ConsolidationGroup {
  primaryOrderId: string;
  primaryOrderName: string;
  customerName: string;
  itemsToFulfill: number | null;
  latestMergeAt: string;
  absorbed: { id: string; orderId: string; orderName: string }[];
}

// ── Components ───────────────────────────────────────────

type SerializedGroup = ReturnType<
  typeof useLoaderData<typeof loader>
>["groups"][number];

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

function ConsolidationCard({
  group,
  savingsPerMerge,
}: {
  group: SerializedGroup;
  savingsPerMerge: number;
}) {
  const saved = group.absorbed.length * savingsPerMerge;
  const items = group.itemsToFulfill;

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" gap="300">
          <InlineStack gap="300" blockAlign="center">
            <Link
              url={orderAdminUrl(group.primaryOrderId)}
              target="_blank"
              removeUnderline
            >
              <Text as="span" variant="headingMd" fontWeight="bold">
                {group.primaryOrderName}
              </Text>
            </Link>
            <Badge tone="success">Primary (Fulfill this)</Badge>
          </InlineStack>
          <Text as="p" variant="headingMd" tone="success">
            +{formatCurrency(saved)} Saved
          </Text>
        </InlineStack>

        <BlockStack gap="200">
          {group.absorbed.map((a) => (
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
                <Badge>Merged into Primary</Badge>
              </InlineStack>
            </Box>
          ))}
        </BlockStack>

        <Divider />

        <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
          <MetaItem label="Customer">{group.customerName}</MetaItem>
          <MetaItem label="Total items to fulfill">
            {items === null ? "—" : `${items} ${items === 1 ? "item" : "items"}`}
          </MetaItem>
          <MetaItem label="Latest merge">{formatDate(group.latestMergeAt)}</MetaItem>
        </InlineGrid>
      </BlockStack>
    </Card>
  );
}

export default function Index() {
  const { autoMergeEnabled, shippingCostSavings, historyLimit, recordsShown, consolidatedCount, groups } =
    useLoaderData<typeof loader>();
  const [query, setQuery] = useState("");

  const needle = query.trim().toLowerCase();
  const visibleGroups = needle
    ? groups.filter((g) =>
        [g.primaryOrderName, g.customerName, ...g.absorbed.map((a) => a.orderName)].some(
          (value) => value.toLowerCase().includes(needle),
        ),
      )
    : groups;

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
            value={formatCurrency(consolidatedCount * shippingCostSavings)}
            helpText={`Based on ${formatCurrency(shippingCostSavings)} per consolidation`}
          />
          <MetricCard
            label="Boxes Saved"
            value={consolidatedCount.toLocaleString("en-US")}
            helpText="One fewer package per consolidated order"
          />
        </InlineGrid>

        {groups.length === 0 ? (
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
                Each card is one primary order and every order merged into it.
                Fulfill the primary order; merged orders were cancelled and
                their items moved over.
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

            {visibleGroups.length > 0 ? (
              visibleGroups.map((group) => (
                <ConsolidationCard key={group.primaryOrderId} group={group} savingsPerMerge={shippingCostSavings} />
              ))
            ) : (
              <Card>
                <Text as="p" variant="bodyMd" tone="subdued" alignment="center">
                  No consolidations match "{query.trim()}".
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
