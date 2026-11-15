// scripts/smoke/checkout-discount-smoke.ts — LIVE smoke of the checkout
// shipping-discount Function on an ISOLATED dev store. Dry-run by default:
// without --apply it prints the plan and runs only read-only guards (no
// browser, no metafield/discount writes). With --apply it drives a signed-in
// persistent-profile browser through checkout — it NEVER submits payment.
//
//   npx vite-node scripts/smoke/checkout-discount-smoke.ts \
//     --store <x.myshopify.com> --client-id <id> --env-file <path> \
//     --discount-id <gid> --workspace <dir> [--customer <gid>] \
//     [--out <dir>] [--apply]
//
// Guards (exit 2): store must end .myshopify.com, the env file's
// SHOPIFY_API_KEY must equal --client-id, shop plan must be
// partnerDevelopment, and the discount node must be an app-owned
// DiscountAutomaticApp. Exit: 0 pass, 1 fail, 2 LOGIN_REQUIRED/guard
// refusal, 64 usage. Output: one JSON result per scenario — amounts,
// titles, booleans only (no emails/names/checkout URLs).
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { loadEnvFile, makeAdmin, makeRedactor } from "./lib";
import { makeBrowserFactory } from "./browser";
import { LoginRequiredError, evaluateGuards, parseArgs, runSmoke } from "./smoke-lib";

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    return 64;
  }
  const { args } = parsed;
  const red = makeRedactor();
  const emit = (obj: unknown) => console.log(red.redact(obj));

  const creds = loadEnvFile(args.envFile);

  // Cheap guards first — no network needed for the first two.
  const early = evaluateGuards({
    store: args.store,
    clientId: args.clientId,
    envApiKey: creds.apiKey,
  });
  if (early.length) {
    emit({ severity: "REFUSED", codes: early });
    return 2;
  }

  const { admin, adminGraphql } = makeAdmin({ store: args.store, credentials: creds, redactor: red });
  const factory = makeBrowserFactory(args.workspace);
  // Prefer CDP attach to a running operator Chrome; fall back to launching
  // the persistent signed-in profile when no CDP endpoint is up.
  const browser = { connect: () => factory.connect().catch(() => factory.launch()) };
  const outDir = args.out;
  if (outDir) mkdirSync(outDir, { recursive: true });

  if (!args.apply) {
    // Dry run: plan + read-only guards only (no writes, no browser).
    emit({
      mode: "dry-run",
      plan: ["S1-baseline", "S2-granted", "S3-diff-street", "S4-kill-switch"],
      note: "run with --apply to execute; no orders are ever placed (harness stops at the shipping step)",
    });
    try {
      const outcome = await runSmoke({
        admin,
        adminGraphql,
        envApiKey: creds.apiKey,
        args,
        browser,
        dryRun: true,
      });
      if (outcome.guardFailures.length) {
        emit({ severity: "REFUSED", codes: outcome.guardFailures });
        return 2;
      }
      emit({ guards: "ok" });
      return 0;
    } catch (e) {
      emit({ severity: "ERROR", message: (e as Error).message });
      return 1;
    }
  }

  try {
    const outcome = await runSmoke({
      admin,
      adminGraphql,
      envApiKey: creds.apiKey,
      args,
      browser,
      shot: outDir
        ? async (page, name) => {
            await page.screenshot({ path: join(outDir, `smoke-${name}.png`), fullPage: true });
          }
        : undefined,
      log: (s) => emit({ log: s }),
    });
    for (const r of outcome.results) emit(r);
    if (outcome.loginRequired) {
      emit({
        severity: "LOGIN_REQUIRED",
        note: "persistent profile is not signed in — the operator must sign in to the store's customer account once, then re-run",
      });
      return 2;
    }
    emit({ overall: outcome.pass ? "PASS" : "FAIL" });
    return outcome.pass ? 0 : 1;
  } catch (e) {
    if (e instanceof LoginRequiredError) {
      emit({ severity: "LOGIN_REQUIRED" });
      return 2;
    }
    emit({ severity: "ERROR", message: (e as Error).message });
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
