// ── Shopify App Pricing ────────────────────────────────────────────────────────
//
// MergeShip uses Shopify App Pricing (managed pricing). Plans, prices, trials
// and the plan-selection page are owned by Shopify in the Partner Dashboard —
// the app must NEVER create charges via the Billing API.
//
// The only thing the app owns is access gating: on every load we ask Shopify
// (via the Partner API `activeSubscription` query) what this shop is subscribed
// to right now. The gate follows Shopify's canonical semantics: a non-null
// activeSubscription means subscribed; null means unsubscribed.
//
// Shopify App Pricing does NOT terminate the contract on uninstall — it marks
// it cancelAtEndOfCycle and the subscription keeps returning from
// activeSubscription until the cycle ends, which would let a reinstall skip
// plan re-approval. To make uninstall produce the canonical null state, the
// app/uninstalled webhook actively cancels the subscription via the Partner
// API `appSubscriptionCancel` mutation (deferCancellation: false).

interface ActiveSubscription {
  billingPeriod: string | null;
  cancelAtEndOfCycle: boolean;
  trialEndsAt: string | null;
  items: { handle: string; price?: { amount?: string; currency?: string } | null }[];
}

/** Display-only plan price (development stores report $0 while testing). */
export interface PlanPrice {
  amount: string;
  currency: string;
  billingPeriod: string | null;
}

interface ShopSubscriptionInfo {
  subscribed: boolean;
  /** Plan handle from the active subscription (e.g. "pro", "starter"), or null. */
  planHandle: string | null;
  planPrice: PlanPrice | null;
  /** gid://shopify/Shop/<id> resolved via the Admin API — persisted so the
   *  uninstall webhook can act on it after the Admin token is revoked. */
  shopGid: string | null;
}

const PARTNER_API_VERSION = process.env.PARTNER_API_VERSION || "2026-07";

const ACTIVE_SUBSCRIPTION_QUERY = /* GraphQL */ `
  query ActiveSubscription($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      billingPeriod
      cancelAtEndOfCycle
      trialEndsAt
      items {
        handle
        price {
          currency
          ... on FlatRatePrice {
            amount
          }
        }
      }
    }
  }
`;

const CANCEL_SUBSCRIPTION_MUTATION = /* GraphQL */ `
  mutation CancelSubscription($appId: ID!, $shopId: ID!) {
    appSubscriptionCancel(
      appId: $appId
      shopId: $shopId
      prorate: false
      skipFinalUsageCharge: true
      deferCancellation: false
    ) {
      appSubscription {
        cancelledAt
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const SHOP_EVENTS_QUERY = /* GraphQL */ `
  query ShopEvents($appId: ID!) {
    events(filter: { subjectId: $appId, subjectType: APP }, first: 50) {
      edges {
        node {
          shop {
            id
            myshopifyDomain
          }
        }
      }
    }
  }
`;

const SHOP_GID_QUERY = /* GraphQL */ `
  query {
    shop {
      id
    }
  }
`;

function partnerApiConfig(shop: string) {
  const orgId = process.env.PARTNER_ORGANIZATION_ID;
  const accessToken = process.env.PARTNER_API_TOKEN;
  const appId = process.env.SHOPIFY_APP_ID;

  if (!orgId || !accessToken || !appId) {
    console.error(
      `[billing] Partner API env vars missing for ${shop} — denying paid access. ` +
        `Set PARTNER_ORGANIZATION_ID, PARTNER_API_TOKEN and SHOPIFY_APP_ID.`,
    );
    return null;
  }
  return {
    url: `https://partners.shopify.com/${orgId}/api/${PARTNER_API_VERSION}/graphql.json`,
    accessToken,
    appGid: `gid://shopify/App/${appId}`,
  };
}

async function partnerApiRequest(
  shop: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ data?: Record<string, unknown>; errors?: { message: string }[] } | null> {
  const config = partnerApiConfig(shop);
  if (!config) return null;

  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": config.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = (await response.json()) as {
    data?: Record<string, unknown>;
    errors?: { message: string }[];
  };

  if (!response.ok || body.errors?.length) {
    console.error(
      `[billing] Partner API error for ${shop}: HTTP ${response.status} ` +
        (body.errors?.map((e) => e.message).join("; ") || "(no details)"),
    );
    return null;
  }
  return body;
}

/** Resolves gid://shopify/Shop/<id> for the current session's shop. */
export async function resolveShopGid(admin: {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}): Promise<string | null> {
  const response = await admin.graphql(SHOP_GID_QUERY);
  const data = (await response.json()) as { data?: { shop?: { id?: string } } };
  return data.data?.shop?.id ?? null;
}

/**
 * URL of the Shopify-hosted plan selection page for this app.
 * Pattern: https://admin.shopify.com/store/:store_handle/charges/:app_handle/pricing_plans
 */
export function planSelectionUrl(shop: string): string {
  const storeHandle = shop.replace(".myshopify.com", "");
  const appHandle = process.env.SHOPIFY_APP_HANDLE || "";
  return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
}

/**
 * Returns the shop's current Shopify App Pricing subscription per the Partner
 * API, or { subscribed: false } when there is none.
 *
 * Fails closed: if the Partner API cannot be reached or returns errors, this
 * logs the failure and reports the shop as unsubscribed rather than granting
 * access on a guess.
 */
export async function getActiveSubscription(
  admin: {
    graphql: (
      query: string,
      options?: { variables?: Record<string, unknown> },
    ) => Promise<Response>;
  },
  shop: string,
): Promise<ShopSubscriptionInfo> {
  const none: ShopSubscriptionInfo = {
    subscribed: false,
    planHandle: null,
    planPrice: null,
    shopGid: null,
  };

  if (!partnerApiConfig(shop)) return none;

  try {
    const shopGid = await resolveShopGid(admin);
    if (!shopGid) {
      console.error(`[billing] Could not resolve shop GID for ${shop}`);
      return none;
    }
    none.shopGid = shopGid;

    const appGid = `gid://shopify/App/${process.env.SHOPIFY_APP_ID}`;
    const body = await partnerApiRequest(shop, ACTIVE_SUBSCRIPTION_QUERY, {
      appId: appGid,
      shopId: shopGid,
    });
    if (!body) return { ...none };

    const subscription = body.data?.activeSubscription as
      | ActiveSubscription
      | null
      | undefined;
    if (!subscription) return { ...none };

    const item = subscription.items?.[0];
    return {
      subscribed: true,
      planHandle: item?.handle ?? null,
      planPrice:
        item?.price?.amount && item.price.currency
          ? { amount: item.price.amount, currency: item.price.currency, billingPeriod: subscription.billingPeriod }
          : null,
      shopGid,
    };
  } catch (error) {
    console.error(`[billing] Subscription check failed for ${shop}:`, error);
    return none;
  }
}

/**
 * Fallback shop-GID lookup for the uninstall webhook, used when no Settings
 * row exists yet: finds the shop's GID from the app's Partner API event feed
 * by matching the myshopify domain.
 */
export async function resolveShopGidByDomain(shop: string): Promise<string | null> {
  try {
    const result = await partnerApiRequest(shop, SHOP_EVENTS_QUERY, {
      appId: `gid://shopify/App/${process.env.SHOPIFY_APP_ID}`,
    });
    const events = result?.data?.events as
      | {
          edges?: {
            node?: { shop?: { id?: string; myshopifyDomain?: string } | null };
          }[];
        }
      | undefined;
    const edges = events?.edges ?? [];
    for (const edge of edges) {
      const s = edge.node?.shop;
      if (s?.myshopifyDomain === shop && s.id) return s.id;
    }
  } catch (error) {
    console.error(`[billing] events fallback lookup failed for ${shop}:`, error);
  }
  console.error(`[billing] Could not resolve shop GID for ${shop} (no Settings row, no event match)`);
  return null;
}

/**
 * Immediately cancels the shop's Shopify App Pricing subscription.
 * Called from the app/uninstalled webhook so a reinstall produces the
 * canonical `activeSubscription = null` state and forces plan re-selection.
 * Requires the Partner API client to have the "View financials" permission.
 */
export async function cancelSubscription(shopGid: string): Promise<boolean> {
  const result = await partnerApiRequest(shopGid, CANCEL_SUBSCRIPTION_MUTATION, {
    appId: `gid://shopify/App/${process.env.SHOPIFY_APP_ID}`,
    shopId: shopGid,
  });
  if (!result) return false;

  const payload = result.data?.appSubscriptionCancel as
    | { appSubscription?: { cancelledAt?: string } | null; userErrors?: { message: string }[] }
    | undefined;
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length) {
    console.error(
      `[billing] appSubscriptionCancel failed for ${shopGid}: ` +
        userErrors.map((e) => e.message).join("; "),
    );
    return false;
  }

  console.log(
    `[billing] Cancelled subscription for ${shopGid}` +
      (payload?.appSubscription?.cancelledAt
        ? ` at ${payload.appSubscription.cancelledAt}`
        : ""),
  );
  return true;
}
