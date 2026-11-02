// G-E7 campaign send/init helper (docs/G-E7-ANEG-CAMPAIGN-RUNBOOK.md).
// Cross-platform (no shell needed): two commands cover the whole send side.
//
//   npx vite-node --script scripts/campaign-send.ts --init [--dir <dir>]
//       One-time setup: generates a fresh UUIDv4 idempotency key and
//       persists it to <dir>/e7-idempotency-key.txt (NEVER regenerated —
//       if the file exists the existing key is reused), writes the two
//       request variable files (1.00 create payload, 0.50 mismatch
//       payload) and renders the literal-key fallback document from the
//       checked-in template with the persisted key. Existing request files
//       are never overwritten.
//
//   npx vite-node --script scripts/campaign-send.ts --send \
//       --doc <file> --vars <file> --out <file> [--out <file> ...]
//       Sends the same document+variables through one `shopify app execute`
//       per --out, ALL CONCURRENTLY (one child process per out file), and
//       writes each child's raw output to its file. With two --out flags
//       this is the first-execution concurrent pair: both requests leave
//       before either refund exists. Prints a compact per-sender summary
//       (refund id / userErrors / top-level errors) for the transcript.
//
// Safety: the store and API version are hard-pinned to the approved
// development store — there is no flag that could point a send elsewhere.
// This tool reads request content from files only; it embeds no document
// text (the mutation document lives exactly once, in the contract module,
// and the checked-in copies under docs/evidence/shipping-v0-e7/ are
// byte-verified against it by tests/campaign-checks.test.ts).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const STORE = "ordermergetest2.myshopify.com";
const VERSION = "2026-04";
const DEFAULT_DIR = "docs/evidence/shipping-v0-e7";

const ORDER_GID = "gid://shopify/Order/8078037057783";
const PARENT_GID = "gid://shopify/OrderTransaction/10162809569527";

const args = process.argv.slice(2);
const collect = (flag: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && args[i + 1]) { out.push(args[i + 1]); i += 1; }
  }
  return out;
};
const single = (flag: string) => collect(flag).pop();
const has = (flag: string) => args.includes(flag);

const varsFor = (key: string, amount: string) => ({
  input: {
    orderId: ORDER_GID,
    note: `MS-SHIPREFUND-E7-${key}`,
    notify: false,
    currency: "USD",
    shipping: { fullRefund: false, amount },
    transactions: [
      {
        orderId: ORDER_GID,
        parentId: PARENT_GID,
        gateway: "bogus",
        kind: "REFUND",
        amount,
      },
    ],
  },
  idempotencyKey: key,
});

function init(dir: string) {
  mkdirSync(dir, { recursive: true });
  const keyFile = join(dir, "e7-idempotency-key.txt");
  let key: string;
  if (existsSync(keyFile)) {
    key = readFileSync(keyFile, "utf8").trim();
    console.log(`reusing persisted key (never regenerated): ${key}`);
  } else {
    key = randomUUID();
    writeFileSync(keyFile, key + "\n");
    console.log(`persisted new key: ${key}`);
  }
  const writeOnce = (file: string, content: string) => {
    const p = join(dir, file);
    if (existsSync(p)) { console.log(`kept existing ${file} (persisted request — not rewritten)`); return; }
    writeFileSync(p, content);
    console.log(`wrote ${file}`);
  };
  writeOnce("e7-vars-1.00.json", JSON.stringify(varsFor(key, "1.00")) + "\n");
  writeOnce("e7-vars-changed-0.50.json", JSON.stringify(varsFor(key, "0.50")) + "\n");
  const templatePath = join(dir, "e7-refund-literal-template.graphql");
  if (existsSync(templatePath)) {
    const tpl = readFileSync(templatePath, "utf8");
    const occurrences = tpl.split("__IDEMPOTENCY_KEY__").length - 1;
    if (occurrences !== 1) {
      throw new Error(`literal template must contain exactly one __IDEMPOTENCY_KEY__ (found ${occurrences})`);
    }
    writeOnce("e7-refund-literal.graphql", tpl.split("__IDEMPOTENCY_KEY__").join(key));
  } else {
    console.log("no literal-key template found — skipping fallback render (variable form is primary)");
  }
}

function send() {
  const doc = single("--doc");
  const vars = single("--vars");
  const outs = collect("--out");
  if (!doc || !vars || outs.length === 0) {
    console.error(
      "usage: npx vite-node --script scripts/campaign-send.ts --send " +
      "--doc <file> --vars <file> --out <file> [--out <file> ...]\n" +
      "   or: npx vite-node --script scripts/campaign-send.ts --init [--dir <dir>]",
    );
    process.exit(2);
  }
  if (!existsSync(doc)) throw new Error(`missing doc file ${doc}`);
  if (!vars || !existsSync(vars)) throw new Error(`missing vars file ${vars}`);
  // One child per out file, all spawned before any wait — this is what makes
  // the pair genuinely concurrent (the first-execution race under one key).
  const children = outs.map((out) => {
    const p = spawnSync(
      "npx",
      ["shopify", "app", "execute", "--store", STORE, "--version", VERSION,
        "--query-file", resolve(doc), "--variable-file", resolve(vars)],
      { cwd: process.cwd(), encoding: "utf8", shell: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const raw = `${p.stdout ?? ""}\n${p.stderr ?? ""}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    writeFileSync(out, raw);
    return { out, raw, status: p.status, signal: p.signal, error: p.error };
  });
  for (const c of children) {
    const i = c.raw.indexOf("{"), j = c.raw.lastIndexOf("}");
    let summary = "unparsed output";
    if (i >= 0 && j > i) {
      try {
        const b = JSON.parse(c.raw.slice(i, j + 1));
        // Generic operation parse — the response's first data field carries
        // refund + userErrors for this campaign's documents.
        const rc = b?.data ? Object.values(b.data as Record<string, unknown>)[0] as { refund?: { id?: string } | null; userErrors?: unknown[] } | null : null;
        const top = Array.isArray(b?.errors) && b.errors.length ? `top-level errors: ${JSON.stringify(b.errors).slice(0, 160)}` : null;
        summary = rc
          ? `refund=${rc.refund?.id ?? "null"} userErrors=${JSON.stringify(rc.userErrors ?? [])}`
          : top ?? `data keys: ${Object.keys(b?.data ?? b ?? {}).join(",")}`;
      } catch { /* keep unparsed */ }
    }
    console.log(`${c.out}: exit=${c.status}${c.error ? ` error=${c.error.message}` : ""} ${summary}`);
    if (c.error || c.status !== 0) {
      console.log(`  (output preserved verbatim in ${c.out} — reconcile read-only before any further send)`);
    }
  }
}

if (has("--init")) {
  init(single("--dir") ?? DEFAULT_DIR);
} else if (has("--send")) {
  send();
} else {
  console.error(
    "usage: npx vite-node --script scripts/campaign-send.ts --init [--dir <dir>]\n" +
    "   or: npx vite-node --script scripts/campaign-send.ts --send --doc <f> --vars <f> --out <f> [--out <f> ...]",
  );
  process.exit(2);
}
