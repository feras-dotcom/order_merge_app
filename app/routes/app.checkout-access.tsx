// Pilot-only scope-request page for the checkout shipping discount —
// deliberately NOT linked from navigation. The checkout feature needs the
// optional scopes write_customers (the customer metafield the Function
// reads) and write_discounts (the automatic discount itself), and nothing
// else in the app requests them (the existing flow only covers the
// location scopes). The page 404s unless ALL global levers are already on:
// MERGESHIP_CHECKOUT_DISCOUNT=enabled, AppControl.checkoutDiscountEnabled
// and the shop in checkoutDiscountAllowShops — so with defaults it is a
// 404 for everybody.
//
// NOTE for the operator (also shown on the page): after the merchant
// approves, the stored OFFLINE session token only carries the new scopes
// once Shopify re-issues it — tokens expire hourly, so re-open the app or
// wait for the token refresh before relying on the new scopes; the
// `preflight` scopes check is the proof they landed.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { prismaOperationStore } from "../lib/operation-store.server";
import { CHECKOUT_SCOPES, useCheckoutAccessRequest } from "../components/useCheckoutAccessRequest";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, scopes } = await authenticate.admin(request);

  // Global levers only — the shop-level flag is deliberately NOT required:
  // scopes are granted BEFORE the operator enables the shop for checkout
  // discounts (preflight reports the flag separately). Defaults => 404
  // for everybody.
  if (process.env.MERGESHIP_CHECKOUT_DISCOUNT !== "enabled") {
    return new Response(null, { status: 404 });
  }
  const control = await prismaOperationStore.getControl();
  if (control?.checkoutDiscountEnabled !== true) {
    return new Response(null, { status: 404 });
  }
  // INVERTED allowlist semantics: empty list = NO shops.
  if (!(control.checkoutDiscountAllowShops ?? []).includes(session.shop)) {
    return new Response(null, { status: 404 });
  }

  let granted: string[] = [];
  let scopesReadable = true;
  try {
    granted = (await scopes.query()).granted;
  } catch {
    scopesReadable = false;
  }

  return json({
    scopes: CHECKOUT_SCOPES.map((scope) => ({
      scope,
      granted: scopesReadable ? granted.includes(scope) : null,
    })),
    scopesReadable,
  });
};

export default function CheckoutAccessPage() {
  const { scopes, scopesReadable } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const { request, requesting } = useCheckoutAccessRequest();
  const allGranted = scopes.every((s: { granted: boolean | null }) => s.granted === true);

  return (
    <Page
      title="Checkout discount access"
      backAction={{ content: "MergeShip", onAction: () => navigate("/app") }}
    >
      <TitleBar title="Checkout discount access" />
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <Text as="p">
              The checkout shipping discount pilot needs two additional permissions:
            </Text>
            <List type="bullet">
              {scopes.map((s: { scope: string; granted: boolean | null }) => (
                <List.Item key={s.scope}>
                  <InlineStack gap="200">
                    <Text as="span" fontWeight="semibold">
                      {s.scope}
                    </Text>
                    <Text as="span" tone={s.granted === true ? "success" : "critical"}>
                      {s.granted === null ? "unknown" : s.granted ? "granted" : "not granted"}
                    </Text>
                  </InlineStack>
                </List.Item>
              ))}
            </List>
            {!scopesReadable && (
              <Banner tone="warning">
                <p>Could not read the current permissions. Try reloading the page.</p>
              </Banner>
            )}
            {!allGranted && (
              <InlineStack>
                <Button variant="primary" onClick={request} loading={requesting}>
                  Allow access
                </Button>
              </InlineStack>
            )}
          </BlockStack>
        </Card>
        {allGranted && (
          <Banner tone="success" title="Access granted">
            <p>
              The new permissions apply to this browser session now. The stored offline token the
              background worker uses only carries them once Shopify re-issues it — tokens expire
              hourly, so re-open the app or wait for the refresh. Run{" "}
              <code>checkout-discount-control.ts preflight --shop {"<store>"}</code> — its{" "}
              <code>scopes</code> check is the proof the permissions landed.
            </p>
          </Banner>
        )}
        {allGranted === false && scopesReadable && (
          <Banner tone="info" title="After you allow access">
            <p>
              Re-open the app or wait up to an hour for the offline token to refresh, then confirm
              with <code>preflight</code> before enabling the discount.
            </p>
          </Banner>
        )}
      </BlockStack>
    </Page>
  );
}
