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
  const { admin, session, redirect } = await authenticate.admin(request);

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
    throw redirect(planSelectionUrl(session.shop), { target: "_top" });
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
