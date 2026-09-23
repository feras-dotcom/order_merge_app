import { json } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BlockStack,
  Button,
  Card,
  IndexTable,
  InlineStack,
  Link,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate, PLAN_PRO } from "../shopify.server";
import { buildGroupKey, executeMerge } from "../lib/merge.server";
import { getSettings } from "../lib/settings.server";

// ── Helpers ──────────────────────────────────────────────

const orderAdminUrl = (gid: string) =>
  `shopify:admin/orders/${gid.replace("gid://shopify/Order/", "")}`;

// Returns "YYYY-MM-DD HH:MM UTC" — stable across server and client renders
const formatDate = (iso: string) =>
  `${iso.replace("T", " ").slice(0, 16)} UTC`;

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
  const mergeWindowMs = mergeWindowHours * 60 * 60 * 1000;
  const response = await admin.graphql(
    `#graphql
      query UnfulfilledOrders {
        orders(first: 50, query: "fulfillment_status:unfulfilled status:open", sortKey: CREATED_AT, reverse: true) {
          nodes {
            id
            name
            createdAt
            customer {
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
  const orders = responseJson.data?.orders.nodes ?? [];
  const ordersByKey = new Map<string, typeof orders>();
  const unmatchedOrders: typeof orders = [];

  for (const order of orders) {
    const groupKey = buildGroupKey(
      order.shippingAddress,
      order.shippingLine?.title,
    );
    if (!groupKey) {
      unmatchedOrders.push(order);
      continue;
    }
    const bucket = ordersByKey.get(groupKey) ?? [];
    bucket.push(order);
    ordersByKey.set(groupKey, bucket);
  }

  // For each address+shipping bucket, sort by createdAt and greedily build
  // temporal sub-clusters where the span from the anchor (oldest order) to
  // every other order in the cluster is ≤ mergeWindowMs.
  // A single stale open order from days ago therefore only makes itself
  // unmatched; it cannot disqualify a recent pair that is well within the
  // window.
  const mergeCandidates = [];
  for (const [groupKey, rawOrders] of ordersByKey) {
    const sorted = [...rawOrders].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    let start = 0;
    while (start < sorted.length) {
      const anchorTime = new Date(sorted[start].createdAt).getTime();
      let end = start;
      while (
        end + 1 < sorted.length &&
        new Date(sorted[end + 1].createdAt).getTime() - anchorTime <=
          mergeWindowMs
      ) {
        end++;
      }
      const cluster = sorted.slice(start, end + 1);
      if (cluster.length >= 2) {
        // Append the anchor timestamp to make the key unique per sub-cluster
        // so mergedKeys state in the client can track each cluster independently.
        mergeCandidates.push({
          normalizedAddress: `${groupKey}\0${sorted[start].createdAt}`,
          orders: cluster,
        });
      } else {
        unmatchedOrders.push(...cluster);
      }
      start = end + 1;
    }
  }

  return { mergeCandidates, unmatchedOrders };
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

// ── Merge-candidate card (one per address group) ─────────

type OrderNode = ReturnType<
  typeof useLoaderData<typeof loader>
>["unmatchedOrders"][number];

type MergeGroup = ReturnType<
  typeof useLoaderData<typeof loader>
>["mergeCandidates"][number];

function MergeGroupCard({
  group,
  onMerged,
}: {
  group: MergeGroup;
  onMerged: (primaryOrder: OrderNode) => void;
}) {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const handledRef = useRef<typeof result>(null);

  useEffect(() => {
    if (!result || result === handledRef.current) return;
    handledRef.current = result;

    if ("success" in result && result.success) {
      shopify.toast.show(
        `Merged ${result.mergedCount} order(s) into ${result.primaryName}`,
      );
      const primary = group.orders.find(
        (o) => o.id === result.primaryOrderId,
      );
      if (primary) onMerged(primary);
    } else if ("error" in result) {
      shopify.toast.show(result.error, { isError: true });
    }
  });

  // Hide after merge -- parent handles showing the primary in unmatched
  if (result && "success" in result && result.success) {
    return null;
  }

  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h3" variant="headingMd">
          {group.orders[0]?.shippingAddress?.formatted.join(", ") ??
            "Unknown address"}
        </Text>
        <IndexTable
          resourceName={{ singular: "order", plural: "orders" }}
          itemCount={group.orders.length}
          selectable={false}
          headings={[
            { title: "Order ID" },
            { title: "Customer" },
            { title: "Created (UTC)" },
            { title: "Shipping method" },
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
                {/* stopPropagation so clicking the link doesn't also fire the row onClick */}
                <span onClick={(e) => e.stopPropagation()}>
                  <Link
                    url={orderAdminUrl(o.id)}
                    target="_blank"
                    removeUnderline
                  >
                    {o.name || o.id.replace("gid://shopify/Order/", "")}
                  </Link>
                </span>
              </IndexTable.Cell>
              <IndexTable.Cell>
                {o.customer?.displayName ?? "Guest customer"}
              </IndexTable.Cell>
              <IndexTable.Cell>{formatDate(o.createdAt)}</IndexTable.Cell>
              <IndexTable.Cell>
                {o.shippingLine?.title ?? "—"}
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>
        <InlineStack align="end">
          <fetcher.Form method="post">
            <input
              type="hidden"
              name="orderIds"
              value={JSON.stringify(group.orders.map((o) => o.id))}
            />
            <Button variant="primary" submit loading={busy}>
              Merge Orders
            </Button>
          </fetcher.Form>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────

export default function Index() {
  const { mergeCandidates, unmatchedOrders } = useLoaderData<typeof loader>();

  // Client-side state: track which groups were merged and their primary orders
  const [promotedOrders, setPromotedOrders] = useState<OrderNode[]>([]);
  const [mergedKeys, setMergedKeys] = useState<Set<string>>(new Set());

  const handleMerged = useCallback(
    (key: string, primaryOrder: OrderNode) => {
      setMergedKeys((prev) => new Set(prev).add(key));
      setPromotedOrders((prev) => [...prev, primaryOrder]);
    },
    [],
  );

  // Hide merged groups from candidates
  const visibleCandidates = mergeCandidates.filter(
    (g) => !mergedKeys.has(g.normalizedAddress),
  );

  // Combine loader unmatched + promoted primaries, deduplicated by ID
  const loaderIds = new Set(unmatchedOrders.map((o) => o.id));
  const uniquePromoted = promotedOrders.filter((o) => !loaderIds.has(o.id));
  const allUnmatched = [...unmatchedOrders, ...uniquePromoted];

  return (
    <Page>
      <TitleBar title="Unfulfilled orders" />
      <BlockStack gap="500">
        <Text as="p" variant="bodyMd">
          The 50 most recent orders awaiting fulfillment, grouped by shipping
          address.
        </Text>

        {visibleCandidates.length > 0 && (
          <BlockStack gap="300">
            <Text as="h2" variant="headingLg">
              Merge Candidates
            </Text>
            {visibleCandidates.map((group) => (
              <MergeGroupCard
                key={group.normalizedAddress}
                group={group}
                onMerged={(primary) =>
                  handleMerged(group.normalizedAddress, primary)
                }
              />
            ))}
          </BlockStack>
        )}

        <BlockStack gap="300">
          <Text as="h2" variant="headingLg">
            Unmatched Orders
          </Text>
          <Card padding="0">
            {allUnmatched.length > 0 ? (
              <IndexTable
                resourceName={{ singular: "order", plural: "orders" }}
                itemCount={allUnmatched.length}
                selectable={false}
                headings={[
                  { title: "Order ID" },
                  { title: "Customer" },
                  { title: "Shipping address" },
                ]}
              >
                {allUnmatched.map((o, i) => (
                  <IndexTable.Row
                    key={o.id}
                    id={o.id}
                    position={i}
                    onClick={() => openAdminOrder(o.id)}
                  >
                    <IndexTable.Cell>
                      <span onClick={(e) => e.stopPropagation()}>
                        <Link
                          url={orderAdminUrl(o.id)}
                          target="_blank"
                          removeUnderline
                        >
                          {o.name || o.id.replace("gid://shopify/Order/", "")}
                        </Link>
                      </span>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {o.customer?.displayName ?? "Guest customer"}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {o.shippingAddress?.formatted.join(", ") ??
                        "No shipping address"}
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            ) : (
              <Text as="p" alignment="center">
                No unmatched unfulfilled orders.
              </Text>
            )}
          </Card>
        </BlockStack>
      </BlockStack>
    </Page>
  );
}
