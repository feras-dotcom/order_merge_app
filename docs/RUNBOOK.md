# MergeShip operator runbook — protocol v2 cutover

Procedures for the v1→v2 cutover and for operating the kill switches. All
scripts are read-only without `--apply` and run with
`npx vite-node scripts/<name>.ts`; they read `DATABASE_URL` and the Shopify
environment from the operator's shell.

## Kill switches (`scripts/app-control.ts`)

The `AppControl` row `id='control'` carries `newMergesEnabled`,
`completionEnabled` and `allowShops`.

- **An empty `allowShops` means ALL shops** — there is no "allow none" state.
  Passing `--allow` with an empty list while either switch stays on is a
  full enablement; the script refuses unless `--allow-all-shops` is passed.
- **Never clear a dev-only allowlist while both switches are on.** Scope
  first (`--allow shop.myshopify.com`), flip switches second; widen the
  allowlist only deliberately.
- `MERGESHIP_MUTATIONS=enabled` in the environment is ALSO required for any
  dispatch — the switches alone do not enable mutations.
- **The migration seeds the control row OFF only on first creation — a deploy
  does NOT reset an existing row.** After every deploy, run
  `scripts/app-control.ts` (no flags) and confirm both switches read `false`
  before trusting that nothing can dispatch.
- The reconciliation/cutover tools refuse `--apply` while either switch is on
  (`ControlsNotFrozenError`, exit 2). `requeue-cutover-work`, the
  `backfill-recent-orders` apply loop, and `legacy-reconcile --apply` all
  check.

```
npx vite-node scripts/app-control.ts
npx vite-node scripts/app-control.ts --new-merges on --completion off --allow dev.myshopify.com
npx vite-node scripts/app-control.ts --new-merges off --completion off --allow ""   # all off → allowlist may clear
```

`setControl` is serialized against the dispatch gate (FOR UPDATE vs FOR
SHARE): a disable committed while a gate waits on the op lock is always
observed. The documented linearization boundary: **a request can only leave
the process if its gate committed before the disable did.**

## Cutover procedure

1. **Freeze both switches** —
   `npx vite-node scripts/app-control.ts --new-merges off --completion off`.
   The linearization boundary above is what makes this safe: anything already
   gated is either dispatched and recorded write-ahead, or never dispatched.
2. **Verify OFF** — run `scripts/app-control.ts` with no flags; both switches
   must read `false`. The cutover tools check this themselves and exit 2
   otherwise.
3. **Stop the old (v1) workers.** No v1 writer may survive into step 5.
4. **Deploy + migrate.** The control row keeps its OFF state — migrations do
   not reset it.
5. **`legacy-reconcile`** — dry run first, then `--apply`:
   ```
   npx vite-node scripts/legacy-reconcile.ts
   npx vite-node scripts/legacy-reconcile.ts --apply
   ```
   Each blocking v1 op converts in ONE transaction (locks, conversion,
   MergeRecords, synthetic attempts) — but only while the row still matches
   the plan's snapshot; a stale plan prints `skipped (stale plan — rerun)`.
   Re-run until the table is clean. Converted ops never dispatch a fresh
   `orderCancel`. **v1 `ABANDONED` rows are reconciled too**: v1 could abandon
   on an ambiguous commit answer or an unchanged line count — neither proves
   the edit never applied. An `ABANDONED` row converts to a terminal v2
   `ABANDONED` only when a complete scan shows no MergeShip edit agreement
   and no transferred lines on the primary after the 15-minute quiet period;
   anything else is quarantined in `REVIEW_REQUIRED` with locks. Steps 6–7
   refuse orders involved in any unreconciled v1 row (`excludedLegacy`), so
   this step must be clean before requeue or backfill can reach them.
6. **`requeue-cutover-work`** — dry run, then `--apply`:
   ```
   npx vite-node scripts/requeue-cutover-work.ts --cutover-at <iso>
   npx vite-node scripts/requeue-cutover-work.ts --cutover-at <iso> \
     [--older-legacy requeue|review|exclude] --apply
   ```
   `--cutover-at` is when the v1 engine stopped (step 3). The safe lookback
   is derived: `safeSince = cutoverAt − MAX(Settings.mergeWindowHours)`
   (24h fallback) — any order whose v1-era work finished inside the window
   could still belong to an in-flight merge, so an explicit `--since` newer
   than `safeSince` is refused (`CutoverWindowError`). DONE/LEGACY rows older
   than the window are provably stranded and require a disposition:
   - `requeue` — back to PENDING for the v2 engine;
   - `review` — `status='REVIEW'` with an operator reason (surfaces in the
     dashboard review count);
   - `exclude` — left DONE/LEGACY but stamped `CUTOVER_EXCLUDED_BY_OPERATOR`.
   **`exclude` is the recommended default**: rows older than `safeSince`
   were already processed by the v1 engine at the time — only work in
   flight at the stop is unproven, and that sits inside the window and gets
   requeued. Use `review` when a human should look at the stranded set.
   Reserve `requeue` for a known v1 outage period — it re-feeds every
   pre-cutover row to the engine and can flood the work queue.
   Orders a live op locks or a `MergeRecord` already merged are never
   touched; every disposition is idempotent.
7. **`backfill-recent-orders`** — covers orders that arrived while merges
   were off:
   ```
   npx vite-node scripts/backfill-recent-orders.ts --since <iso>
   npx vite-node scripts/backfill-recent-orders.ts --since <iso> --apply
   ```
   Inserts unleased PENDING rows; reopens only DONE/NULL-or-LEGACY rows;
   never touches v2 outcomes, REVIEW rows, locked orders, or merged orders.
   A failed or incomplete order listing throws — it is never treated as an
   empty result.
8. **Re-enable gradually** — `--allow` a small shop list first, then widen.
   Keep `MERGESHIP_MUTATIONS` unset until the switches should actually take
   effect.
9. **Watch** `REVIEW_REQUIRED` ops and `REVIEW` work items on the dashboard —
   the banner counts both. `REVIEW` rows mean a human must decide; the v2
   engine will not act on them.

## The lookback derivation, summarized

`mergeWindowHours` bounds how long a v1 merge could have been in flight when
it was stopped. Rows younger than `cutoverAt − maxWindow` might belong to a
merge still resolving — they are requeued for v2 reconsideration, never
touched directly. Rows older than that are provably abandoned work and
require an explicit operator disposition because "silently forgotten" and
"automatically retried" are both wrong answers for different shops.
