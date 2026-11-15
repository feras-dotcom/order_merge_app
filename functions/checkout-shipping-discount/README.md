# checkout-shipping-discount (Function source — intentionally inert)

This directory holds the validated Shopify Discount Function that reads the
customer eligibility metafield and discounts the matching shipping option at
checkout.

**It is not an extension of the production app version.** It lives outside
`extensions/` so the DEFAULT config (`shopify.app.toml`, deliberately
byte-identical to `origin/main`) does not discover, build or deploy it — no
scopes (`write_customers`, `write_discounts`), no webhook topics, no Function
are registered there. The named config `shopify.app.checkout-first.toml`
carries `extension_directories = ["functions/*"]`, which makes this directory
buildable/deployable by the CLI as a deliberate, separate act (below).

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
  checkout discounting — flipping the app's own gate/settings never does
  (turning merging off or lowering the merge window below 24 h instead
  triggers an automatic deactivation of this discount). The operator
  shutdown path never reads this config — a missing or malformed config
  cannot block deactivation.

## Building / deploying (the now-working in-repo procedure)

1. `cd functions/checkout-shipping-discount && npm ci` — installs the
   extension's own toolchain (`@shopify/shopify_function` + codegen
   packages) from `package-lock.json`. The repo root install is unaffected;
   `functions/*/node_modules` and `functions/*/dist` are gitignored.
2. `npx shopify app deploy --config checkout-first --no-release` from the
   repo root — creates a version that is NOT released to merchants.
   **Warning: config `checkout-first` targets the PRODUCTION client id
   (`04b77142ce8ad421f49735b05c7d0a86`) — founder-authorized only, never run
   casually.** Without `--no-release` the version would go live.
3. The toml's `build.command` is intentionally empty: the CLI drives
   codegen + esbuild + javy itself from `package.json` and emits
   `dist/function.wasm` exporting
   `cart-delivery-options-discounts-generate-run` (the toml `export`).
   `npx shopify app build --config checkout-first` (repo root, no auth) is
   the local build check — bit-reproducible between clean builds run from
   the repo root.
4. Create the `$app:config` metafield above
   (`scripts/checkout-discount-control.ts create`/`prepare-enable`) and
   verify the webhook topics are present in the deployed version (they are
   declared in `shopify.app.checkout-first.toml`).

A fresh extension MUST be given its own `uid` (Shopify-generated — deploy
once and the CLI writes it into the toml) and the `handle` must be unique
within the host app.

The same API version note applies: this source is the spike-validated copy
(API 2026-07 input query, identical to the deployed spike extension and to
`94b6166:spikes/checkout-shipping-discount/extension/`); the app's pinned
Admin version is 2026-04 and the inert copy intentionally keeps the
validated input query unchanged.

### Verified (2026-11)

- `src/*` byte-identical to the deployed spike extension (after a CRLF
  normalization check — the bytes matched exactly) and to the spike commit.
- `shopify.extension.toml` identical field-for-field.
- Rebuilt IN this repo via `npm ci` in the extension dir +
  `npx shopify app build --config checkout-first` → `dist/function.wasm`
  (12,804 bytes, exports `_start` and
  `cart-delivery-options-discounts-generate-run`). Two clean builds from the
  repo root produce the identical sha256; the artifact hash differs from the
  deployed spike wasm (toolchain versions differ — same sources).
- Wasm-vs-source parity on THIS repo-built wasm (function-runner 9.2.3):
  **55/55** fixture cases equal between the Node implementation and the
  built wasm, every emitted result schema-valid (`selectionStrategy: "ALL"`
  — the only value the published output schema allows).
- Percentage type proof through the runner: `"100.0"` (string) →
  `deliveryDiscountsAdd` with `selectionStrategy: "ALL"`; `100` (number) →
  zero operations.
- `DateTimeWithoutTimezone` query variables cannot be validated by the local
  runner (Shopify resolves them); the `windowStart`/`windowEnd` no-timezone
  format above is live-validated spike evidence.
