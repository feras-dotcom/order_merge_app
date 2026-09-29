import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { useState } from "react";
import {
  Banner,
  BlockStack,
  Box,
  Card,
  EmptyState,
  IndexTable,
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
import { defaultMergeDeps, resumeIncompleteMerges } from "../lib/merge.server";
import { REVIEW_TAG } from "../lib/eligibility";
import { listOperationsNeedingReview } from "../lib/merge-journal.server";
import { getLocationAccess } from "../lib/location-access.server";
import { StatusDot } from "../components/StatusDot";
import { useLocationAccessRequest } from "../components/useLocationAccessRequest";

// ── Helpers ──────────────────────────────────────────────

const HISTORY_LIMIT = 100;
const EMPTY_STATE_IMAGE =
  "https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const orderAdminUrl = (gid: string) =>
  `shopify:admin/orders/${gid.replace("gid://shopify/Order/", "")}`;

// Fixed time zone so server and client render identical text.
const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});
const formatDate = (iso: string) => `${dateFormat.format(new Date(iso))} UTC`;

// ── Loader ───────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, scopes } = await authenticate.admin(request);
  const shop = session.shop;

  // Finish any merge that was interrupted (e.g. a secondary whose cancellation
  // was not yet confirmed) even if no new order webhook arrives.
  try {
    // Single confirmation read: never hold the page for the full polling loop.
    await resumeIncompleteMerges(admin, shop, { ...defaultMergeDeps(), cancelPollAttempts: 1 });
  } catch (err: any) {
    console.error(`[dashboard] Resuming unfinished merges failed: ${err?.message}`);
  }

  const [settings, needsReview, combinedCount, recentCount, records, locationAccess] = await Promise.all([
    getSettings(shop),
    listOperationsNeedingReview(shop),
    db.mergeRecord.count({ where: { shop } }),
    db.mergeRecord.count({ where: { shop, createdAt: { gte: new Date(Date.now() - THIRTY_DAYS_MS) } } }),
    db.mergeRecord.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: HISTORY_LIMIT,
    }),
    getLocationAccess(admin, scopes, shop),
  ]);

  // Customer names and each fulfilled order's current item count are looked
  // up live in one request, so no personal data is stored locally.
  const lookupIds = [
    ...new Set([
      ...records.map((r) => r.primaryOrderId),
      ...records.map((r) => r.customerId).filter((id): id is string => !!id),
    ]),
  ];
  const customerNames = new Map<string, string>();
  const itemCounts = new Map<string, number>();
  if (lookupIds.length) {
    try {
      const res = await admin.graphql(
        `#graphql
          query CombinedOrderLookups($ids: [ID!]!) {
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
          itemCounts.set(node.id, node.currentSubtotalLineItemsQuantity);
        }
        if (node.displayName) customerNames.set(node.id, node.displayName);
      }
    } catch (err) {
      console.error("Could not load combined order details:", err);
    }
  }

  // One row per order to fulfill, listing every repeat order combined into
  // it. Records arrive newest first, so rows stay ordered by latest activity.
  const rows = new Map<string, ActivityRow>();
  for (const r of records) {
    const row = rows.get(r.primaryOrderId) ?? {
      orderId: r.primaryOrderId,
      orderName: r.primaryOrderName,
      customerName: (r.customerId && customerNames.get(r.customerId)) || "—",
      items: itemCounts.get(r.primaryOrderId) ?? null,
      latestAt: r.createdAt.toISOString(),
      combined: [],
    };
    row.combined.push({ id: r.id, orderId: r.mergedOrderId, orderName: r.mergedOrderName });
    rows.set(r.primaryOrderId, row);
  }

  return {
    autoMergeEnabled: settings.autoMergeEnabled,
    locationBlocked: locationAccess.blocked,
    activeLocationCount: locationAccess.activeLocationCount,
    needsReview: needsReview.map((op) => ({
      id: op.id,
      primaryOrderName: op.primaryOrderName,
      secondaryNames: ((op.secondaries as { name: string }[]) ?? []).map((s) => s.name),
    })),
    combinedCount,
    recentCount,
    historyLimit: HISTORY_LIMIT,
    recordsShown: records.length,
    rows: [...rows.values()],
  };
};

interface ActivityRow {
  orderId: string;
  orderName: string;
  customerName: string;
  items: number | null;
  latestAt: string;
  combined: { id: string; orderId: string; orderName: string }[];
}

// ── Components ───────────────────────────────────────────

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <BlockStack gap="100">
      <Text as="p" variant="bodySm" tone="subdued">
        {label}
      </Text>
      <Text as="p" variant="headingLg">
        {value.toLocaleString("en-US")}
      </Text>
    </BlockStack>
  );
}

export default function Index() {
  const {
    autoMergeEnabled,
    locationBlocked,
    activeLocationCount,
    needsReview,
    combinedCount,
    recentCount,
    historyLimit,
    recordsShown,
    rows,
  } = useLoaderData<typeof loader>();
  const { request: requestLocationAccess, requesting } = useLocationAccessRequest();
  const [query, setQuery] = useState("");

  const needle = query.trim().toLowerCase();
  const visibleRows = needle
    ? rows.filter((row) =>
        [row.orderName, row.customerName, ...row.combined.map((c) => c.orderName)].some((value) =>
          value.toLowerCase().includes(needle),
        ),
      )
    : rows;

  const working = autoMergeEnabled && !locationBlocked;

  return (
    <Page
      title="MergeShip"
      subtitle="Repeat orders shouldn't mean more manual work."
      titleMetadata={
        <StatusDot
          on={working}
          label={
            !autoMergeEnabled
              ? "Automatic merging off"
              : locationBlocked
                ? "Automatic merging paused"
                : "Automatic merging on"
          }
        />
      }
      secondaryActions={[{ content: "Settings", url: "/app/settings" }]}
    >
      <TitleBar title="MergeShip" />
      <BlockStack gap="500">
        {needsReview.length > 0 && (
          <Banner
            tone="critical"
            title={
              needsReview.length === 1
                ? "1 combined order needs review before you fulfill it"
                : `${needsReview.length} combined orders need review before you fulfill them`
            }
          >
            <BlockStack gap="200">
              <p>
                MergeShip couldn't confirm these finished. Check the orders
                tagged “{REVIEW_TAG}” in Shopify — the items may already be on
                the first order.
              </p>
              <BlockStack gap="100">
                {needsReview.map((op) => (
                  <Text as="p" key={op.id}>
                    {op.primaryOrderName}
                    {op.secondaryNames.length > 0 && ` · combined from ${op.secondaryNames.join(", ")}`}
                  </Text>
                ))}
              </BlockStack>
            </BlockStack>
          </Banner>
        )}

        {autoMergeEnabled && locationBlocked && (
          <Banner
            tone="warning"
            title="MergeShip can't combine orders yet"
            action={{ content: "Allow location access", loading: requesting, onAction: requestLocationAccess }}
          >
            <p>
              Your store has {activeLocationCount} active locations. Allow
              read-only location access so MergeShip can confirm repeat orders
              ship from the same place.
            </p>
          </Banner>
        )}

        {!autoMergeEnabled && (
          <Card>
            <InlineStack align="space-between" blockAlign="center" gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingSm">
                  Automatic merging is off
                </Text>
                <Text as="p" tone="subdued">
                  MergeShip won't change any orders until you turn it on.
                </Text>
              </BlockStack>
              <Link url="/app/settings">Review and turn on</Link>
            </InlineStack>
          </Card>
        )}

        {rows.length === 0 ? (
          <Card>
            <EmptyState
              heading="Repeat orders shouldn't mean more manual work."
              image={EMPTY_STATE_IMAGE}
              action={autoMergeEnabled ? undefined : { content: "Go to Settings", url: "/app/settings" }}
            >
              <p>
                {working
                  ? "MergeShip is watching for eligible repeat orders and will combine them automatically when they pass the safety checks."
                  : "Once automatic merging is on, MergeShip combines eligible repeat orders before fulfillment and leaves anything uncertain untouched."}
              </p>
            </EmptyState>
          </Card>
        ) : (
          <>
            <Card>
              <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
                <Stat label="Repeat orders combined" value={combinedCount} />
                <Stat label="Last 30 days" value={recentCount} />
                <Stat label="Needs review" value={needsReview.length} />
              </InlineGrid>
            </Card>

            <Card padding="0">
              <Box padding="400">
                <BlockStack gap="300">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">
                      Recent activity
                    </Text>
                    <Text as="p" tone="subdued">
                      Fulfill the order in the first column. The repeat orders
                      were cancelled and their items moved onto it.
                    </Text>
                  </BlockStack>
                  {rows.length > 10 && (
                    <TextField
                      label="Search activity"
                      labelHidden
                      placeholder="Search by order number or customer"
                      value={query}
                      onChange={setQuery}
                      clearButton
                      onClearButtonClick={() => setQuery("")}
                      autoComplete="off"
                    />
                  )}
                </BlockStack>
              </Box>
              <IndexTable
                  resourceName={{ singular: "combined order", plural: "combined orders" }}
                  itemCount={visibleRows.length}
                  selectable={false}
                  emptyState={
                    <Box padding="400">
                      <Text as="p" tone="subdued" alignment="center">
                        No orders match “{query.trim()}”.
                      </Text>
                    </Box>
                  }
                  headings={[
                    { title: "Order to fulfill" },
                    { title: "Combined from" },
                    { title: "Customer" },
                    { title: "Items", alignment: "end" },
                    { title: "Combined" },
                  ]}
                >
                  {visibleRows.map((row, index) => (
                    <IndexTable.Row id={row.orderId} key={row.orderId} position={index}>
                      <IndexTable.Cell>
                        <Link url={orderAdminUrl(row.orderId)} target="_blank" removeUnderline>
                          <Text as="span" fontWeight="semibold">
                            {row.orderName}
                          </Text>
                        </Link>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack gap="200">
                          {row.combined.map((c) => (
                            <Link key={c.id} url={orderAdminUrl(c.orderId)} target="_blank" removeUnderline monochrome>
                              {c.orderName}
                            </Link>
                          ))}
                        </InlineStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>{row.customerName}</IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" alignment="end" numeric>
                          {row.items ?? "—"}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" tone="subdued">
                          {formatDate(row.latestAt)}
                        </Text>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
            </Card>

            {recordsShown === historyLimit && (
              <Text as="p" variant="bodySm" tone="subdued" alignment="center">
                Showing the latest {historyLimit} combined orders.
              </Text>
            )}
          </>
        )}
      </BlockStack>
    </Page>
  );
}
