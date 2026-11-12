# Phase 2 status — checkout-first shipping discount experiments

All timestamps UTC. Store: ms-checkout-spike-1111.myshopify.com. App: MS Checkout Spike App (client_id 09fa5573ee4396c41fd0afa1db6d514b). No orders placed, no checkout completed.

## What works
- **Client-credentials grant**: `POST /admin/oauth/access_token` with grant_type=client_credentials issued a token for our app (`$app` metafields resolve to our app). Token cached in memory only.
- **Function registered**: `shopifyFunctions` → id `01a1cbd9-85fc-78f2-bcc7-1df414e12e40`, handle `checkout-shipping-discount`, apiType `discount`, apiVersion `2026-07`.
- **Discount created + ACTIVE**: `gid://shopify/DiscountAutomaticNode/1796967858543` "MS Spike Shipping Discount", functionId = the above, combinesWith all false, startsAt now-1h, no endsAt. Config metafield `$app:config` jsonValue `{v:1, windowId:"w1", percentage:"100.0", message:"MergeShip spike: shipping discount", windowStart, windowEnd}` — windowStart/windowEnd in shop-local America/New_York `YYYY-MM-DDTHH:mm:ss` (DateTimeWithoutTimezone).
- **App install verified**: `currentAppInstallation.accessScopes` = all 7 granted scopes.
- **Cloudflare quick tunnel**: `bin/cloudflared.exe` (CLI-managed source: github.com/cloudflare/cloudflared/releases/download/2026.10.3/cloudflared-windows-amd64.exe, 55,329,336 bytes) served a local :49321 HTTP server through `https://<random>.trycloudflare.com` and returned 200 JSON. Tunnel + server stopped; tunnel URL now 502.

## Blockers (founder actions needed)
1. **Protected Customer Data access** — `customerCreate` returns ACCESS_DENIED "This app is not approved to access the Customer object" (protected-customer-data). Needed for Admin customer creation AND likely for `$app:ship_elig` metafieldsSet on Customer. Founder: Dev Dashboard → app → Settings/API access → Protected customer data access → enable (dev-store purpose declaration).
2. **`unauthenticated_*` scopes** — `storefrontAccessTokenCreate` ACCESS_DENIED; zero unauthenticated scopes granted. For the Storefront-API signed-in cart path (customerAccessTokenCreate + cartCreate buyerIdentity) the app needs at minimum `unauthenticated_read_product_listings`, `unauthenticated_write_checkouts`, `unauthenticated_read_checkouts`, `unauthenticated_write_customers`. Requires TOML scope change + redeploy + founder re-approval on the store.
3. **Storefront password protection** — `/` → 302 `/password`; AJAX `/cart/add.js` → 401 with a CF "verify your connection" challenge for non-browser clients. Any browser/AJAX cart path needs the password disabled or shared (do NOT guess). The Storefront GraphQL endpoint itself responds (400 without token) — not password-blocked.
4. `read_shipping` (deliveryProfiles) + `read_locations` denied — optional; shipping method titles/prices are discoverable via cart once a cart path exists.

## Store facts
USD, America/New_York, plan "Basic App Development" (partnerDevelopment, not Plus), `customerAccounts: OPTIONAL`, `paymentSettings.supportedDigitalWallets: []` (no accelerated wallets). `/account/login` → 302 to hosted `shopify.com/<shop-id>/account` (hosted customer-accounts sign-in; returning-customer login would be the hosted flow — email one-time code style, inbox required). Cheapest shippable variant: `gid://shopify/ProductVariant/68100323574127` "Sample Selling Plans Ski Wax" $9.95 (requiresShipping true).

## Security notes
- `shopify app env pull` printed the .env contents INCLUDING SHOPIFY_API_SECRET to the terminal (unexpected — file was also written). Recommend rotating the client secret in Dev Dashboard.
- `shopify app logs` was removed in CLI 5.0 — function run logs are only in the Dev Dashboard UI.
- `shopify app function list` does not exist in CLI 5.0.1; function id discovered via Admin `shopifyFunctions`.
- Extension `uid` and handle are NOT accepted as `functionId` by `discountAutomaticAppCreate`; only the `ShopifyFunction.id` UUID works.
