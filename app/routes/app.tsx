import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import { authenticate } from "../shopify.server";
import { getActiveSubscription, planSelectionUrl } from "../lib/billing.server";
import db from "../db.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // BYPASS_BILLING=true is a local-development escape hatch only — never set it
  // in production. Shopify App Pricing is the source of truth: if the Partner
  // API reports no active subscription for this shop (fresh install, or
  // reinstall after uninstall), send the merchant to Shopify's hosted plan
  // selection page instead of granting access.
  const subscription =
    process.env.BYPASS_BILLING === "true"
      ? { subscribed: true, planHandle: "dev-bypass", shopGid: null }
      : await getActiveSubscription(admin, session.shop);

  // Persist the resolved shop GID so the app/uninstalled webhook can still
  // reference the shop after its Admin API token is revoked.
  if (subscription.shopGid) {
    await db.settings.updateMany({
      where: { shop: session.shop, NOT: { shopifyShopGid: subscription.shopGid } },
      data: { shopifyShopGid: subscription.shopGid },
    });
  }

  if (!subscription.subscribed) {
    // Navigate the top frame to Shopify's hosted plan-selection page. The
    // library's redirect helper briefly flashes a bare "200" bounce page, so
    // we emit our own interstitial instead — same mechanism (top-frame
    // navigation), with a proper message while it happens.
    const planUrl = planSelectionUrl(session.shop);
    throw new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>MergeShip</title>` +
        `<meta http-equiv="refresh" content="1;url=${planUrl}"></head>` +
        `<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">` +
        `<p>Redirecting to plan selection&hellip;</p>` +
        `<script>window.top.location.href=${JSON.stringify(planUrl)};</script>` +
        `</body></html>`,
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  }

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    planHandle: subscription.planHandle,
  };
};

export default function App() {
  const { apiKey, planHandle } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          MergeShip
        </Link>
        <Link to="/app/settings">Settings</Link>
      </NavMenu>
      <Outlet context={{ planHandle }} />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
