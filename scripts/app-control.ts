// Prints and updates the AppControl kill-switch row (spec §11).
//
//   npx vite-node scripts/app-control.ts
//   npx vite-node scripts/app-control.ts --new-merges on --completion off
//   npx vite-node scripts/app-control.ts --new-merges on --allow a.myshopify.com,b.myshopify.com
//
// MERGESHIP_MUTATIONS=enabled is ALSO required for any dispatch — these
// switches alone do not enable mutations.

import "dotenv/config";
import { prismaOperationStore } from "../app/lib/operation-store.server";

const usage = () => {
  console.error(
    "usage: npx vite-node scripts/app-control.ts [--new-merges on|off] [--completion on|off] [--allow shop,...]",
  );
  process.exit(2);
};

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined) usage();
  flags.set(argv[i], argv[i + 1]);
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

if (Object.keys(patch).length) {
  await prismaOperationStore.setControl(patch);
  console.log("after:  ");
  show(await prismaOperationStore.getControl());
} else if (argv.length) {
  usage();
}

console.log(`MERGESHIP_MUTATIONS env: ${process.env.MERGESHIP_MUTATIONS === "enabled" ? "enabled" : "NOT enabled"}`);
