// G-E7 campaign send/init — CLI entry only; the implementation is
// scripts/lib/campaign-send.impl.ts (importable for mocked-process tests).
//
//   npx vite-node --script scripts/campaign-send.ts --init [--dir <dir>]
//       Persist the idempotency key once and write the two approved
//       request variable files + the rendered literal-key document.
//
//   npx vite-node --script scripts/campaign-send.ts --send \
//       --doc <file> --vars <file> --out <file> [--out <file> ...]
//       Pre-send gate (all required): a manifest-verified baseline exists
//       for #1133, the document is an approved G-E7 document (the
//       checked-in variable document or the literal template rendered
//       with the persisted key), the variables are exactly an approved
//       payload for order #1133 / parent CAPTURE / bogus / $1.00 (or the
//       $0.50 mismatch set), and every --out is inside the evidence dir
//       and does not exist. Then all children spawn together — the pair
//       is genuinely concurrent — and no result is ever retried.
import {
  authorizeSend, CAMPAIGN_DIR, initCampaign, runSendBatch,
} from "./lib/campaign-send.impl";

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

const usage =
  "usage: npx vite-node --script scripts/campaign-send.ts --init [--dir <dir>]\n" +
  "   or: npx vite-node --script scripts/campaign-send.ts --send " +
  "--doc <f> --vars <f> --out <f> [--out <f> ...] [--dir <dir>]";

async function main() {
  if (has("--init")) {
    const dir = single("--dir") ?? CAMPAIGN_DIR;
    const { key, reused } = initCampaign(dir);
    console.log(reused ? `reusing persisted key (never regenerated): ${key}` : `persisted new key: ${key}`);
    console.log("request files ready (existing files are never rewritten)");
    return;
  }
  if (!has("--send")) { console.error(usage); process.exit(2); }

  const dir = single("--dir") ?? CAMPAIGN_DIR;
  const doc = single("--doc"), vars = single("--vars"), outs = collect("--out");
  if (!doc || !vars || outs.length === 0) { console.error(usage); process.exit(2); }

  const gate = authorizeSend({ dir, docPath: doc, varsPath: vars, outs });
  if (!gate.ok) {
    console.error(`REFUSING SEND: ${gate.reason}`);
    process.exit(4);
  }
  console.log(`authorized ${gate.kind} send (${gate.amount}) -> ${gate.outs.length} concurrent request(s)`);
  const { results } = await runSendBatch({ docPath: doc, varsPath: vars, outs: gate.outs });
  for (const r of results) {
    const i = r.raw.indexOf("{"), j = r.raw.lastIndexOf("}");
    let summary = "unparsed output";
    if (i >= 0 && j > i) {
      try {
        const b = JSON.parse(r.raw.slice(i, j + 1));
        const rc = b?.data ? Object.values(b.data as Record<string, unknown>)[0] as
          { refund?: { id?: string } | null; userErrors?: unknown[] } | null : null;
        const top = Array.isArray(b?.errors) && b.errors.length
          ? `top-level errors: ${JSON.stringify(b.errors).slice(0, 160)}` : null;
        summary = rc
          ? `refund=${rc.refund?.id ?? "null"} userErrors=${JSON.stringify(rc.userErrors ?? [])}`
          : top ?? `data keys: ${Object.keys(b?.data ?? b ?? {}).join(",")}`;
      } catch { /* keep unparsed */ }
    }
    console.log(`${r.out}\n  start=${r.startedAt} end=${r.endedAt} exit=${r.exitCode}` +
      `${r.timedOut ? " TIMED-OUT" : ""}${r.error ? ` error=${r.error}` : ""}\n  ${summary}`);
    if (r.error || r.timedOut || r.exitCode !== 0) {
      console.log("  (ambiguous outcome — output preserved verbatim; reconcile read-only, NO retry)");
    }
  }
  if (results.some((r) => r.timedOut || r.exitCode !== 0)) process.exitCode = 1;
}

await main();
