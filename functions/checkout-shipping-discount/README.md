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
`config`, type `json`, owner the automaticDiscountNode). Set it as a
`metafields` entry ON the discount — at creation via
`discountAutomaticAppCreate` (`automaticAppDiscount.metafields`), or later
via `discountAutomaticAppUpdate` — carrying exactly this shape:

```json
{
  "v": 1,
  "windowId": "w1759276800000",
  "message": "MergeShip: free shipping on your next order",
  "percentage": "100.0",
  "windowStart": "2026-11-01T00:00:00",
  "windowEnd": "2026-12-01T00:00:00"
}
```

(`app/lib/checkout-discount/discount-control.server.ts` performs these
mutations; `scripts/checkout-discount-control.ts` is the operator CLI.)

- `message` MUST equal `CHECKOUT_DISCOUNT_MESSAGE`
  (`"MergeShip: free shipping on your next order"`,
  `app/lib/checkout-discount/config.ts`) — it is the
  `AutomaticDiscountApplication.title` the `orders/paid` processor matches
  when consuming records. A different message means granted discounts are
  detected as ambiguous and records are never consumed.
- `windowId` is `"w" + enabledAt.getTime()` — the value printed by
  `scripts/checkout-discount-control.ts prepare-enable`. Only records
  written for this window apply; rotating it on re-enable stops every
  stale record from a previous enable epoch.
- `percentage` is the shipping discount as a STRING decimal (e.g.
  `"100.0"` = free shipping). A numeric `100` is silently rejected — the
  Function emits zero operations.
- `windowStart`/`windowEnd` are shop-local DateTimeWithoutTimezone values
  (`YYYY-MM-DDTHH:MM:SS`, NO timezone suffix) bounding when ANY record
  applies; the Function also requires `exp >= today` per record. Once
  `windowEnd` passes, ALL discounts silently stop — it must be maintained.
- A deactivated discount (status `EXPIRED`) is the ONLY thing that stops
  checkout discounting — flipping the app's own gate/settings never does.

## Building / deploying in a dev workspace

The Function is deployed only from a disposable dev app — never from this
repository's app directory:

1. Copy this directory into a scratch Shopify app's `extensions/` (or keep it
   standalone and point the CLI at it — it only needs to be inside the app
   that is being deployed).
2. Ensure that scratch app's `shopify.app.toml` requests `write_customers`
   and `write_discounts` (customer metafield write + discount management).
3. Build (verified commands — the toml's `build.command` is intentionally
   empty, the CLI drives codegen + bundling + javy itself):
   - `npm install` in the scratch extension dir (needs
     `@shopify/shopify_function` and the codegen packages
     `@graphql-codegen/cli`, `@graphql-codegen/typescript`,
     `@graphql-codegen/typescript-operations`, `graphql`), then
   - `npm run build` — i.e. `shopify app function build` run from the
     extension directory.
   - Artifact: `dist/function.wasm`; exported entrypoint:
     `cart-delivery-options-discounts-generate-run` (the toml `export`).
   - `shopify app deploy` against the **dev store only**.
4. Create the `$app:config` metafield above (spike reference:
   `spikes/checkout-shipping-discount/experiments/setup-discount.ts` on the
   spike branch — do NOT copy it into this repo).
5. Register the webhook topics (`orders/paid`, `orders/cancelled`,
   `orders/fulfilled`, `orders/partially_fulfilled`, `orders/updated`,
   `refunds/create`, `orders/risk_assessment_changed`) only when the feature
   is actually being enabled — they are intentionally absent from this
   branch.

A fresh extension MUST be given its own `uid` (Shopify-generated — deploy
once and the CLI writes it into the toml) and the `handle` must be unique
within the host app; the `uid` recorded in this toml belongs to the spike
app's extension and cannot be reused by a different app.

The same API version note applies: this source is the spike-validated copy
(API 2026-07 input query, identical to the deployed spike extension and to
`94b6166:spikes/checkout-shipping-discount/extension/`); the app's pinned
Admin version is 2026-04 and the inert copy intentionally keeps the
validated input query unchanged.

### Verified (2026-11)

- `src/*` byte-identical to the deployed spike extension (after a CRLF
  normalization check — the bytes matched exactly) and to the spike commit.
- `shopify.extension.toml` identical field-for-field.
- Rebuilt in an OS-temp scratch copy via `shopify app function build` →
  `dist/function.wasm`. The artifact hash differs from the deployed wasm
  (build-time toolchain nondeterminism — same CLI, same sources); exports:
  `_start`, `cart-delivery-options-discounts-generate-run`.
- `shopify app function run` parity: **55/55** fixture cases equal between
  the Node implementation and the built wasm.
- Percentage type proof through the runner: `"100.0"` (string) →
  `deliveryDiscountsAdd` with `selectionStrategy: "ALL"`; `100` (number) →
  zero operations.
- `DateTimeWithoutTimezone` query variables cannot be validated by the local
  runner (Shopify resolves them); the `windowStart`/`windowEnd` no-timezone
  format above is live-validated spike evidence.
