// ── Shopify App Pricing ────────────────────────────────────────────────────────
//
// MergeShip uses Shopify App Pricing (managed pricing). Plans, prices, trials
// and the plan-selection page are owned by Shopify in the Partner Dashboard —
// the app must NEVER create charges via the Billing API.
//
// The only thing the app owns is access gating: on every load we ask Shopify
// (via the Partner API `activeSubscription` query) what this shop is subscribed
// to right now. No subscription state is stored locally, so an old plan can
// never "survive" an uninstall/reinstall in our own data.

interface ActiveSubscription {
  billingPeriod: string | null;
  cancelAtEndOfCycle: boolean;
  trialEndsAt: string | null;
  items: { handle: string }[];
}

interface ShopSubscriptionInfo {
  subscribed: boolean;
  /** Plan handle from the active subscription (e.g. "pro", "starter"), or null. */
  planHandle: string | null;
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
  const orgId = process.env.PARTNER_ORGANIZATION_ID;
  const accessToken = process.env.PARTNER_API_TOKEN;
  const appId = process.env.SHOPIFY_APP_ID;

  if (!orgId || !accessToken || !appId) {
    console.error(
      `[billing] Partner API env vars missing for ${shop} — denying paid access. ` +
        `Set PARTNER_ORGANIZATION_ID, PARTNER_API_TOKEN and SHOPIFY_APP_ID.`,
    );
    return { subscribed: false, planHandle: null };
  }

  try {
    const shopResponse = await admin.graphql(SHOP_GID_QUERY);
    const shopData = (await shopResponse.json()) as {
      data?: { shop?: { id?: string } };
    };
    const shopId = shopData.data?.shop?.id;
    if (!shopId) {
      console.error(`[billing] Could not resolve shop GID for ${shop}`);
      return { subscribed: false, planHandle: null };
    }

    const response = await fetch(
      `https://partners.shopify.com/${orgId}/api/${PARTNER_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: ACTIVE_SUBSCRIPTION_QUERY,
          variables: {
            appId: `gid://shopify/App/${appId}`,
            shopId,
          },
        }),
      },
    );

    const body = (await response.json()) as {
      data?: { activeSubscription?: ActiveSubscription | null };
      errors?: { message: string }[];
    };

    if (!response.ok || body.errors?.length) {
      console.error(
        `[billing] Partner API error for ${shop}: HTTP ${response.status} ` +
          (body.errors?.map((e) => e.message).join("; ") || "(no details)"),
      );
      return { subscribed: false, planHandle: null };
    }

    const subscription = body.data?.activeSubscription;

    // Shopify does NOT terminate a Shopify App Pricing contract on uninstall —
    // it marks it cancelAtEndOfCycle and leaves it "active" until the billing
    // cycle ends. If we treated that as subscribed, a reinstall would silently
    // resume the old plan without re-approval. A subscription that is pending
    // cancellation is therefore treated as no subscription: the merchant is
    // sent to the hosted plan page and must approve a plan again.
    if (!subscription || subscription.cancelAtEndOfCycle) {
      return { subscribed: false, planHandle: null };
    }

    return { subscribed: true, planHandle: subscription.items?.[0]?.handle ?? null };
  } catch (error) {
    console.error(`[billing] Subscription check failed for ${shop}:`, error);
    return { subscribed: false, planHandle: null };
  }
}
