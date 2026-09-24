import { json } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  IndexTable,
  InlineGrid,
  InlineStack,
  Link,
  Page,
  Text,
} from "@shopify/polaris";
import type { BadgeProps } from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate, PLAN_PRO } from "../shopify.server";
import { evaluateOrders, executeMerge } from "../lib/merge.server";
import type { ConflictReason } from "../lib/merge.server";
import { getSettings } from "../lib/settings.server";

// ── Helpers ──────────────────────────────────────────────

const SHIPPING_SAVINGS_PER_MERGE = 8.5;

const orderAdminUrl = (gid: string) =>
  `shopify:admin/orders/${gid.replace("gid://shopify/Order/", "")}`;

// Returns "YYYY-MM-DD HH:MM UTC" — stable across server and client renders
const formatDate = (iso: string) =>
  `${iso.replace("T", " ").slice(0, 16)} UTC`;

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    amount,
  );

// Programmatically clicks an <a> attached to the DOM so App Bridge intercepts
// it the same way it intercepts a real link click.
function openAdminOrder(gid: string) {
  const a = document.createElement("a");
  a.href = orderAdminUrl(gid);
  a.target = "_blank";
  a.rel = "noreferrer";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

const REASON_BADGES: Record<
  ConflictReason,
  { label: string; tone: BadgeProps["tone"] }
> = {
  SHIPPING_MISMATCH: { label: "Shipping method mismatch", tone: "warning" },
  OUTSIDE_WINDOW: { label: "Time window exceeded", tone: "warning" },
  PAYMENT_PENDING: { label: "Payment pending", tone: "critical" },
  FULFILLMENT_MISMATCH: { label: "Fulfillment status mismatch", tone: "attention" },
  NO_ELIGIBLE_MATCH: { label: "No eligible match", tone: "info" },
};

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

  const { mergeWindowHours } = await getSettings(session.shop);

  // Partially fulfilled and unpaid orders are fetched on purpose so they can
  // be surfaced as conflicts; evaluateOrders never marks them as mergeable.
  const response = await admin.graphql(
    `#graphql
      query OpenOrders {
        orders(
          first: 100
          query: "status:open (fulfillment_status:unfulfilled OR fulfillment_status:partial)"
          sortKey: CREATED_AT
          reverse: true
        ) {
          nodes {
            id
            name
            createdAt
            cancelledAt
            displayFinancialStatus
            displayFulfillmentStatus
            customer {
              id
              displayName
            }
            shippingAddress {
              address1
              address2
              city
              provinceCode
              zip
              countryCodeV2
              formatted
            }
            shippingLine {
              title
            }
          }
        }
      }`,
  );
  const responseJson = await response.json();
  const orders: OrderNode[] = responseJson.data?.orders.nodes ?? [];

  const { evaluatedCount, readyGroups, conflictGroups, singleOrders } =
    evaluateOrders(orders, mergeWindowHours * 60 * 60 * 1000);

  const readyToMerge = readyGroups.reduce((n, g) => n + g.orders.length, 0);
  const mergedAway = readyGroups.reduce((n, g) => n + g.orders.length - 1, 0);

  return {
    mergeWindowHours,
    metrics: {
      evaluated: evaluatedCount,
      readyToMerge,
      estimatedSavings: mergedAway * SHIPPING_SAVINGS_PER_MERGE,
    },
    readyGroups,
    conflictGroups,
    singleOrders,
  };
};

// ── Action (merge orders) ────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const orderIds = JSON.parse(formData.get("orderIds") as string) as string[];

  if (orderIds.length < 2) {
    return json(
      { error: "At least two orders are required to merge." },
      { status: 400 },
    );
  }

  const result = await executeMerge(admin, orderIds);
  if (!result.success) {
    return json({ error: result.error! }, { status: 500 });
  }

  return json({
    success: true,
    primaryOrderId: result.primaryOrderId!,
    primaryName: result.primaryName!,
    mergedCount: result.mergedCount!,
    cancelResults: result.cancelResults!,
  });
};

// ── Types ────────────────────────────────────────────────

interface OrderNode {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  customer: { id: string; displayName: string } | null;
  shippingAddress: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    provinceCode: string | null;
    zip: string | null;
    countryCodeV2: string | null;
    formatted: string[];
  } | null;
  shippingLine: { title: string } | null;
}

type LoaderData = ReturnType<typeof useLoaderData<typeof loader>>;
type ReadyGroup = LoaderData["readyGroups"][number];
type ConflictGroup = LoaderData["conflictGroups"][number];
type SerializedOrder = LoaderData["singleOrders"][number];

const customerName = (o: SerializedOrder) =>
  o.customer?.displayName ?? "Guest customer";
const addressText = (o: SerializedOrder) =>
  o.shippingAddress?.formatted.join(", ") ?? "No shipping address";

// ── Shared pieces ────────────────────────────────────────

function OrderLink({ order }: { order: SerializedOrder }) {
  // stopPropagation so clicking the link doesn't also fire the row onClick
  return (
    <span onClick={(e) => e.stopPropagation()}>
      <Link url={orderAdminUrl(order.id)} target="_blank" removeUnderline>
        {order.name}
      </Link>
    </span>
  );
}

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

function SectionHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <BlockStack gap="100">
      <Text as="h2" variant="headingLg">
        {title}
      </Text>
      <Text as="p" variant="bodyMd" tone="subdued">
        {description}
      </Text>
    </BlockStack>
  );
}

function EmptyCard({ message }: { message: string }) {
  return (
    <Card>
      <Text as="p" variant="bodyMd" tone="subdued" alignment="center">
        {message}
      </Text>
    </Card>
  );
}

// ── Ready to Merge card ──────────────────────────────────

function ReadyGroupCard({
  group,
  loading,
  disabled,
  onMerge,
}: {
  group: ReadyGroup;
  loading: boolean;
  disabled: boolean;
  onMerge: () => void;
}) {
  const [first] = group.orders;
  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" gap="200">
          <Text as="h3" variant="headingMd">
            {customerName(first)}
          </Text>
          <Badge tone="success">Eligible for Merge</Badge>
        </InlineStack>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <BlockStack gap="100">
            <Text as="p" variant="bodySm" tone="subdued">
              Shipping address
            </Text>
            <Text as="p" variant="bodyMd">
              {addressText(first)}
            </Text>
          </BlockStack>
          <BlockStack gap="100">
            <Text as="p" variant="bodySm" tone="subdued">
              Shipping method
            </Text>
            <Text as="p" variant="bodyMd">
              {first.shippingLine?.title ?? "—"}
            </Text>
          </BlockStack>
        </InlineGrid>

        <IndexTable
          resourceName={{ singular: "order", plural: "orders" }}
          itemCount={group.orders.length}
          selectable={false}
          headings={[
            { title: "Order" },
            { title: "Created (UTC)" },
            { title: "Role" },
          ]}
        >
          {group.orders.map((o, i) => (
            <IndexTable.Row
              key={o.id}
              id={o.id}
              position={i}
              onClick={() => openAdminOrder(o.id)}
            >
              <IndexTable.Cell>
                <OrderLink order={o} />
              </IndexTable.Cell>
              <IndexTable.Cell>{formatDate(o.createdAt)}</IndexTable.Cell>
              <IndexTable.Cell>
                {i === 0 ? (
                  <Badge tone="info">Primary</Badge>
                ) : (
                  <Text as="span" variant="bodyMd" tone="subdued">
                    Merges into {first.name}
                  </Text>
                )}
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>

        <InlineStack align="end">
          <Button
            variant="primary"
            onClick={onMerge}
            loading={loading}
            disabled={disabled}
          >
            Merge Orders
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

// ── Conflict card ────────────────────────────────────────

function ConflictGroupCard({ group }: { group: ConflictGroup }) {
  const first = group.orders[0].order;
  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" gap="200">
          <BlockStack gap="100">
            <Text as="h3" variant="headingMd">
              {customerName(first)}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {addressText(first)}
            </Text>
          </BlockStack>
          <Badge tone="warning">Held back</Badge>
        </InlineStack>

        <IndexTable
          resourceName={{ singular: "order", plural: "orders" }}
          itemCount={group.orders.length}
          selectable={false}
          headings={[
            { title: "Order" },
            { title: "Created (UTC)" },
            { title: "Shipping method" },
            { title: "Reason" },
          ]}
        >
          {group.orders.map(({ order, reasons }, i) => (
            <IndexTable.Row
              key={order.id}
              id={order.id}
              position={i}
              onClick={() => openAdminOrder(order.id)}
            >
              <IndexTable.Cell>
                <OrderLink order={order} />
              </IndexTable.Cell>
              <IndexTable.Cell>{formatDate(order.createdAt)}</IndexTable.Cell>
              <IndexTable.Cell>{order.shippingLine?.title ?? "—"}</IndexTable.Cell>
              <IndexTable.Cell>
                <InlineStack gap="100" wrap>
                  {reasons.map((reason) => (
                    <Badge key={reason} tone={REASON_BADGES[reason].tone}>
                      {REASON_BADGES[reason].label}
                    </Badge>
                  ))}
                </InlineStack>
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>
      </BlockStack>
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────

export default function Index() {
  const { mergeWindowHours, metrics, readyGroups, conflictGroups, singleOrders } =
    useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const handledRef = useRef<unknown>(null);
  const merging = fetcher.state !== "idle";

  // One page-level fetcher handles every merge so the toast still fires after
  // Remix revalidates the loader and the merged group's card unmounts.
  useEffect(() => {
    const result = fetcher.data;
    if (fetcher.state !== "idle" || !result || result === handledRef.current) {
      return;
    }
    handledRef.current = result;
    setPendingKey(null);
    if ("success" in result) {
      shopify.toast.show(
        `Merged ${result.mergedCount} order(s) into ${result.primaryName}`,
      );
    } else {
      shopify.toast.show(result.error, { isError: true });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const mergeGroup = (group: ReadyGroup) => {
    setPendingKey(group.key);
    fetcher.submit(
      { orderIds: JSON.stringify(group.orders.map((o) => o.id)) },
      { method: "post" },
    );
  };

  return (
    <Page
      title="MergeShip"
      primaryAction={{
        content: "Scan Orders",
        onAction: () => revalidator.revalidate(),
        loading: revalidator.state === "loading",
        disabled: merging,
      }}
    >
      <TitleBar title="MergeShip" />
      <BlockStack gap="600">
        <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
          <MetricCard
            label="Orders Evaluated"
            value={String(metrics.evaluated)}
            helpText="Open orders awaiting fulfillment (latest 100)"
          />
          <MetricCard
            label="Ready to Merge"
            value={String(metrics.readyToMerge)}
            helpText="Orders meeting every merge rule"
          />
          <MetricCard
            label="Estimated Shipping Saved"
            value={formatCurrency(metrics.estimatedSavings)}
            helpText={`Based on ${formatCurrency(SHIPPING_SAVINGS_PER_MERGE)} per merged order`}
          />
        </InlineGrid>

        <BlockStack gap="300">
          <SectionHeading
            title="Ready to Merge"
            description={`Same customer, address and shipping method, fully paid and unfulfilled, placed within ${mergeWindowHours}h of each other.`}
          />
          {readyGroups.length > 0 ? (
            readyGroups.map((group) => (
              <ReadyGroupCard
                key={group.key}
                group={group}
                loading={merging && pendingKey === group.key}
                disabled={merging && pendingKey !== group.key}
                onMerge={() => mergeGroup(group)}
              />
            ))
          ) : (
            <EmptyCard message="No orders currently meet every merge rule." />
          )}
        </BlockStack>

        <BlockStack gap="300">
          <SectionHeading
            title="Orders with Merge Conflicts"
            description="Duplicate orders for the same customer and address that were held back by a safety rule."
          />
          {conflictGroups.length > 0 ? (
            conflictGroups.map((group) => (
              <ConflictGroupCard key={group.key} group={group} />
            ))
          ) : (
            <EmptyCard message="No duplicate orders are being held back." />
          )}
        </BlockStack>

        <BlockStack gap="300">
          <SectionHeading
            title="Single Orders"
            description="Orders with no matching duplicate from the same customer."
          />
          <Card padding="0">
            {singleOrders.length > 0 ? (
              <IndexTable
                resourceName={{ singular: "order", plural: "orders" }}
                itemCount={singleOrders.length}
                selectable={false}
                headings={[
                  { title: "Order ID" },
                  { title: "Customer" },
                  { title: "Created (UTC)" },
                  { title: "Shipping address" },
                ]}
              >
                {singleOrders.map((o, i) => (
                  <IndexTable.Row
                    key={o.id}
                    id={o.id}
                    position={i}
                    onClick={() => openAdminOrder(o.id)}
                  >
                    <IndexTable.Cell>
                      <OrderLink order={o} />
                    </IndexTable.Cell>
                    <IndexTable.Cell>{customerName(o)}</IndexTable.Cell>
                    <IndexTable.Cell>{formatDate(o.createdAt)}</IndexTable.Cell>
                    <IndexTable.Cell>{addressText(o)}</IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            ) : (
              <Box padding="400">
                <Text as="p" variant="bodyMd" tone="subdued" alignment="center">
                  No single orders.
                </Text>
              </Box>
            )}
          </Card>
        </BlockStack>
      </BlockStack>
    </Page>
  );
}
