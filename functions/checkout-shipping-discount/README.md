# checkout-shipping-discount (Function source — intentionally inert)

This directory holds the validated Shopify Discount Function that reads the
customer eligibility metafield and discounts the matching shipping option at
checkout.

**It is NOT an extension of this app.** It lives outside `extensions/` so the
Shopify CLI does not discover, build or deploy it, and `shopify.app.toml` is
deliberately unchanged on this branch — no scopes (`write_customers`,
`write_discounts`), no webhook topics, no Function are registered here.
Deploying it is a separate, deliberate act done in a dev workspace (below).

## What it does

Target `cart.delivery-options.discounts.generate.run`. For a signed-in buyer
(`buyerIdentity.isAuthenticated`), it reads the customer's `$app:ship_elig`
metafield (written by `app/lib/checkout-discount/`), the shop's
`$app:config` discount metafield, and — when window id, shop-local date,
exact destination key, normalized shipping method and currency all match a
record with `left > 0` — emits `deliveryDiscountsAdd` with
`selectionStrategy: "ALL"` targeting the matching delivery-option handles.
Guests, mismatched destinations/methods, expired records and malformed input
fail closed with zero operations.

The destination key is byte-identical to
`app/lib/checkout-discount/dest-key.ts` (a test asserts this): the merge
engine's `buildAddressKey` field set and normalization minus the customer
slot.

## Discount configuration (required)

The Function reads the shop metafield `$app:config` (namespace `$app`, key
`config`, type `json`, owner the shop). Create/update it with
`discountAutomaticAppUpdate` on an automatic app discount whose
`functionId` is this Function, carrying a metafield of exactly this shape:

```json
{
  "v": 1,
  "windowId": "w1",
  "message": "MergeShip: free shipping on your next order",
  "percentage": 100,
  "windowStart": "2026-01-01",
  "windowEnd": "2026-12-31"
}
```

- `message` MUST equal `CHECKOUT_DISCOUNT_MESSAGE`
  (`"MergeShip: free shipping on your next order"`,
  `app/lib/checkout-discount/config.ts`) — it is the
  `AutomaticDiscountApplication.title` the `orders/paid` processor matches
  when consuming records. A different message means granted discounts are
  detected as ambiguous and records are never consumed.
- `windowId` must equal `MERGESHIP_CHECKOUT_DISCOUNT_WINDOW` (default `w1`):
  only records written for this window apply.
- `percentage` is the shipping discount (100 = free shipping).
- `windowStart`/`windowEnd` are shop-local dates bounding when ANY record
  applies; the Function also requires `exp >= today` per record.

## Building / deploying in a dev workspace

The Function is deployed only from a disposable dev app — never from this
repository's app directory:

1. Copy this directory into a scratch Shopify app's `extensions/` (or keep it
   standalone and point the CLI at it — it only needs to be inside the app
   that is being deployed).
2. Ensure that scratch app's `shopify.app.toml` requests `write_customers`
   and `write_discounts` (customer metafield write + discount management).
3. `npm install` in the scratch app, then `npm run build` (or
   `shopify app function build`) to produce the wasm from `src/`.
4. `shopify app deploy` against the **dev store only**.
5. Create the `$app:config` metafield above (spike reference:
   `spikes/checkout-shipping-discount/experiments/setup-discount.ts` on the
   spike branch — do NOT copy it into this repo).
6. Register the webhook topics (`orders/paid`, `orders/cancelled`,
   `orders/fulfilled`, `orders/partially_fulfilled`) only when the feature is
   actually being enabled — they are intentionally absent from this branch.

The same API version note applies: this source is the spike-validated copy
(API 2026-07 input query); the app's pinned Admin version is 2026-04 and the
inert copy intentionally keeps the validated input query unchanged.
