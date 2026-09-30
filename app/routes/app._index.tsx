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
      customerName: (r.customerId && customerNames.get(r.customerId)) || "Unknown",
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
    // Only merges MergeShip could not confirm (NEEDS_REVIEW operations) —
    // ordinary skipped or ineligible orders are never listed here.
    needsReview: needsReview.map((op) => ({
      id: op.id,
      primary: { id: op.primaryOrderId, name: op.primaryOrderName },
      secondaries: ((op.secondaries as { id: string; name: string }[]) ?? []).map((s) => ({ id: s.id, name: s.name })),
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
          tone={!autoMergeEnabled ? "neutral" : locationBlocked ? "caution" : "success"}
          label={
            !autoMergeEnabled
              ? "Automatic merging paused"
              : locationBlocked
                ? "Automatic merging stopped"
                : "Automatic merging on"
          }
        />
      }
      secondaryActions={[{ content: "Settings", url: "/app/settings" }]}
    >
      <TitleBar title="MergeShip" />
      <BlockStack gap="500">
        {/* Shown only when a merge genuinely needs the merchant; absent otherwise. */}
        {needsReview.length > 0 && (
          <Banner
            tone="warning"
            title={
              needsReview.length === 1
                ? "1 combine needs your review before fulfillment"
                : `${needsReview.length} combines need your review before fulfillment`
            }
          >
            <BlockStack gap="300">
              <p>
                MergeShip couldn't confirm these finished, so it marked the
                orders for review in Shopify. Open each one and check whether the
                items are already on the first order before fulfilling or
                cancelling.
              </p>
              <BlockStack gap="100">
                {needsReview.map((op) => (
                  <InlineStack key={op.id} gap="150" blockAlign="center">
                    <Link url={orderAdminUrl(op.primary.id)} target="_blank">
                      {op.primary.name}
                    </Link>
                    {op.secondaries.length > 0 && (
                      <>
                        <Text as="span" tone="subdued">
                          ← combined from
                        </Text>
                        {op.secondaries.map((s) => (
                          <Link key={s.id} url={orderAdminUrl(s.id)} target="_blank">
                            {s.name}
                          </Link>
                        ))}
                      </>
                    )}
                  </InlineStack>
                ))}
              </BlockStack>
            </BlockStack>
          </Banner>
        )}

        {/* Onboarding guarantees setup is complete here, so this is a genuine
            interruption (e.g. a location was added or access revoked). */}
        {autoMergeEnabled && locationBlocked && (
          <Banner
            tone="warning"
            title="MergeShip can't combine orders right now"
            action={{ content: "Allow location access", loading: requesting, onAction: requestLocationAccess }}
          >
            <p>
              Your fulfillment setup changed. Your store now has{" "}
              {activeLocationCount} active locations. Allow location access to
              continue automatic combining.
            </p>
          </Banner>
        )}

        {/* Paused is the merchant's choice, not a problem: keep it quiet. */}
        {!autoMergeEnabled && (
          <Card>
            <InlineStack align="space-between" blockAlign="center" gap="400">
              <Text as="p" tone="subdued">
                Automatic merging is paused. MergeShip won't change any orders
                until you turn it back on.
              </Text>
              <Link url="/app/settings">Turn on in Settings</Link>
            </InlineStack>
          </Card>
        )}

        {rows.length === 0 ? (
          <Card>
            <EmptyState heading="Repeat orders shouldn't mean more manual work." image={EMPTY_STATE_IMAGE}>
              <p>
                {working
                  ? "MergeShip is watching for eligible repeat orders and will combine them automatically when they pass the safety checks."
                  : "Combined orders will appear here once automatic merging is running."}
              </p>
            </EmptyState>
          </Card>
        ) : (
          <>
            <Card>
              <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
                <Stat label="Repeat orders combined" value={combinedCount} />
                <Stat label="Last 30 days" value={recentCount} />
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
                          {row.items ?? "Unknown"}
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
