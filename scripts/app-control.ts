// Prints and updates the AppControl kill-switch row (spec §11).
//
//   npx vite-node scripts/app-control.ts
//   npx vite-node scripts/app-control.ts --new-merges on --completion off
//   npx vite-node scripts/app-control.ts --new-merges on --allow a.myshopify.com,b.myshopify.com
//
// MERGESHIP_MUTATIONS=enabled is ALSO required for any dispatch — these
// switches alone do not enable mutations.

import "./require-database-url";
import { prismaOperationStore } from "../app/lib/operation-store.server";
import { isTransientDbError } from "../app/lib/ownership.server";

const usage = () => {
  console.error(
    "usage: npx vite-node scripts/app-control.ts [--new-merges on|off] [--completion on|off] [--allow shop,...] [--allow-all-shops]",
  );
  process.exit(2);
};

const argv = process.argv.slice(2);
// Boolean opt-out for the empty-allowlist guard — filtered out before the
// flag/value pairs are read.
const allowAllShops = argv.includes("--allow-all-shops");
const rest = argv.filter((a) => a !== "--allow-all-shops");
const flags = new Map<string, string>();
for (let i = 0; i < rest.length; i += 2) {
  if (!rest[i]?.startsWith("--") || rest[i + 1] === undefined) usage();
  flags.set(rest[i], rest[i + 1]);
}

const onOff = (flag: string): boolean | undefined => {
  const v = flags.get(flag);
  if (v === undefined) return undefined;
  if (v === "on") return true;
  if (v === "off") return false;
  usage();
};

const show = (c: any) =>
  console.log(
    `newMergesEnabled=${c?.newMergesEnabled}  completionEnabled=${c?.completionEnabled}  ` +
      `allowShops=[${(c?.allowShops ?? []).join(", ")}]  note=${c?.note ?? ""}  updatedAt=${c?.updatedAt}`,
  );

const before = await prismaOperationStore.getControl();
console.log("before: " + (before ? "" : "(no control row — all mutations off) "));
if (before) show(before);

const patch: Record<string, unknown> = {};
const newMerges = onOff("--new-merges");
const completion = onOff("--completion");
if (newMerges !== undefined) patch.newMergesEnabled = newMerges;
if (completion !== undefined) patch.completionEnabled = completion;
if (flags.has("--allow")) {
  patch.allowShops = flags.get("--allow")!.split(",").map((s) => s.trim()).filter(Boolean);
}

// An empty allowlist means the switches apply to EVERY shop — clearing a
// dev-only allowlist while either switch stays on is a full-enable, so it
// must be explicit.
if (Array.isArray(patch.allowShops) && patch.allowShops.length === 0 && !allowAllShops) {
  const mergesAfter = (patch.newMergesEnabled ?? before?.newMergesEnabled) === true;
  const completionAfter = (patch.completionEnabled ?? before?.completionEnabled) === true;
  if (mergesAfter || completionAfter) {
    console.error(
      "error: empty allowlist means ALL shops — pass --allow-all-shops to confirm.",
    );
    process.exit(2);
  }
}

if (Object.keys(patch).length) {
  // setControl takes the control row FOR UPDATE with a 2s lock_timeout — an
  // in-flight dispatch gate can hold its FOR SHARE that long. The emergency
  // stop must never fail silently: retry briefly, then say so loudly.
  for (let i = 0; ; i++) {
    try {
      await prismaOperationStore.setControl(patch);
      break;
    } catch (err) {
      if (!isTransientDbError(err) || i >= 4) {
        console.error(
          `error: could not flip the switch — retry (${err instanceof Error ? err.message : err})`,
        );
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  console.log("after:  ");
  show(await prismaOperationStore.getControl());
} else if (argv.length) {
  usage();
}

console.log(`MERGESHIP_MUTATIONS env: ${process.env.MERGESHIP_MUTATIONS === "enabled" ? "enabled" : "NOT enabled"}`);
