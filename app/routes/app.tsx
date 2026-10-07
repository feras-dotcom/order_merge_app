import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import {
  isRouteErrorResponse,
  Link,
  Outlet,
  useLoaderData,
  useRouteError,
} from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import { authenticate } from "../shopify.server";
import { getActiveSubscription, planSelectionUrl } from "../lib/billing.server";
import db from "../db.server";
import { getSettings } from "../lib/settings.server";
import { isOnboardingComplete } from "../lib/onboarding";
import { MergeShipLogo } from "../components/MergeShipLogo";

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
      ? { subscribed: true, planHandle: "dev-bypass", planPrice: null, shopGid: null }
      : await getActiveSubscription(admin, session.shop);

  // Persist the resolved shop GID so the app/uninstalled webhook can still
  // reference the shop after its Admin API token is revoked.
  // Upserted so the row exists even before the merchant saves settings; a new
  // row takes the schema defaults (automatic merging off, setup not started).
  if (subscription.shopGid) {
    await db.settings.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop, shopifyShopGid: subscription.shopGid },
      update: { shopifyShopGid: subscription.shopGid },
    });
  }

  if (!subscription.subscribed) {
    throw redirect(planSelectionUrl(session.shop), { target: "_top" });
  }

  // Setup gate: until onboarding is complete every app page leads to it; once
  // complete, onboarding is only reachable for its final "You're ready" step.
  const url = new URL(request.url);
  const onOnboarding = url.pathname === ONBOARDING_PATH;
  const setupComplete = isOnboardingComplete(await getSettings(session.shop));
  if (!setupComplete && !onOnboarding) throw redirect(ONBOARDING_PATH);
  if (setupComplete && onOnboarding && url.searchParams.get("step") !== "done") throw redirect("/app");

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    planHandle: subscription.planHandle,
    planPrice: subscription.planPrice,
    setupComplete,
  };
};

const ONBOARDING_PATH = "/app/onboarding";

export default function App() {
  const { apiKey, planHandle, planPrice, setupComplete } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <div style={{ maxWidth: 998, margin: "0 auto", padding: "16px 24px 0" }}>
        <MergeShipLogo />
      </div>
      {/* Navigation appears once setup is complete, so setup has one path. */}
      {setupComplete && (
        <NavMenu>
          <Link to="/app" rel="home">
            MergeShip
          </Link>
          <Link to="/app/settings">Settings</Link>
        </NavMenu>
      )}
      <Outlet context={{ planHandle, planPrice }} />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  const error = useRouteError();
  // boundary.error() detects the App Bridge response thrown by redirect() via
  // error.constructor.name, which the client minifier renames — so on
  // hydration it rethrows and Remix's default boundary flashes "200" before
  // the top-frame navigation completes. isRouteErrorResponse is Remix's
  // minification-safe check; render the same App Bridge markup for it.
  if (isRouteErrorResponse(error)) {
    return (
      <div dangerouslySetInnerHTML={{ __html: error.data || "Handling response" }} />
    );
  }
  return boundary.error(error);
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
