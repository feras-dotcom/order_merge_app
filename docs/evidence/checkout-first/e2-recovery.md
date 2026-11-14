# E2 recovery (valid re-run) — isolated spike app/store only

Supersedes the INVALID original E2 campaign (`INVALID-original-e2-e3/`). Cart: variant `68100323508591` ($24.95;
Standard $8.00, Express $15.00 natively). Eligibility record method: `Standard`. Success = strict signal
(`signal.ts`): exact message `MERGESHIP SPIKE: SHIPPING DISCOUNT` AND Standard `$8.00 -> FREE` AND Express `$15.00` AND summary shipping zero.
Generic FREE / struck price / single text match never counts. Function version 8 (active) throughout.

## Name access
`access-check.ts` (read-only, booleans only) on order #1037: firstName, lastName, address1, city, provinceCode, zip, countryCode all readable; 0 auth errors
(`name-access-check.json`). Before the Name scope was enabled, firstName/lastName returned ACCESS_DENIED.

## Direct propagation (no orders), 2 runs x 5 trials = 10 trials
Files: `e2-direct-run1.json`, `e2-direct.json`, `e2-direct-summary.json`. Baseline confirmed (Standard $8, Express $15, spike discount active, record cleared + Admin readback 0) at attempt 1 in all 10 trials.
- Admin write p50 619 ms (max 854); immediate readback p50 254 ms (max 276); readback always showed the record.
- Appearance: all 40 path observations reached the strict discounted state. Existing-checkout reload: upper bound p50 4.7 s, max 6.7 s.
  Fresh checkout: p50 2.9 s, max 11.9 s. Fresh values of 10-12 s occur when the first in-flight load straddled the write and evaluated pre-write; the next fresh load (started <=5.3 s after the write) showed the discount. No post-write load ever showed baseline.
- Disappearance after revocation: all reached baseline. Existing reload upper bound p50 4.8 s, max 5.7 s; fresh p50 11.0 s (page-load dominated), first post-revoke fresh load started <=5.4 s after the clear. No load that started after the revoke completed still showed the discount (0 stale observations).
- Resolution: every number is an UPPER bound dominated by page-load duration (about 2.5 s reload, 6-7 s fresh). A true lower bound was never observed, so propagation is "within the first page load after the write" (<= ~5.4 s), not a measured ~0 s.
- The earlier ~72 s figure is therefore a cart artifact (native free shipping), not Function/metafield caching.

## Real order pipeline (3 trials, real paid bogus-gateway orders #1038-#1040)
File: `e2-real.json`. Each: pre-pay checkout confirmed $8.00 baseline; signed-in customer pays; real `orders/paid` webhook (HMAC verified, Cloudflare quick tunnel) -> real order fetched from Admin API -> `buildRecord` -> merge -> `writeProjection` -> Admin readback -> strict signal in a fresh checkout and a reloaded existing checkout. Order shipping line Standard 8.0 -> 8.0. No synthetic records.
| Stage | #1038 | #1039 | #1040 |
|---|---|---|---|
| order createdAt -> webhook received | 4066 ms | 3408 ms | 4000 ms |
| order fetch (Admin) | 348 | 297 | 309 |
| metafield write | 586 | 564 | 545 |
| readback | 245 | 266 | 248 |
| write end -> discount visible, fresh (upper) | 5436 | 6132 | 5689 |
| write end -> discount visible, reload (upper) | 7465 | 7349 | 7442 |
Harness artifact: the worker started ~4.6 s after webhook receipt because it was launched after the existing checkout finished loading. Measured webhook->write end (5.5 s) includes that wait; unavoidable handler time is about fetch + write + readback = ~1.2 s.
Estimated order-confirmation -> discount visible: ~4 s (webhook) + ~1.2 s (handler) + <=~5.4 s (checkout) ~= <=11 s; as actually measured with the harness delay <=~15 s.
Record was cleared (readback 0) before and after every trial. Only 3 trials: not a latency distribution.

## Not measured
Staleness of an already-rendered checkout page that is submitted for payment (without reload) after revocation; concurrent checkouts (stateless Function cannot atomically consume `left`); first-order race below ~4 s; wallets; plan/distribution eligibility.
