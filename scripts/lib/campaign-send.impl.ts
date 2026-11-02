// G-E7 campaign send/init implementation (scripts/campaign-send.ts is the
// thin CLI entry; this module is importable so the behavior is testable
// with mocked child processes — no Shopify calls in tests).
//
// Concurrency contract: every child is spawned BEFORE any completion is
// awaited — the first-execution pair is genuinely simultaneous, unlike a
// spawnSync loop which serializes the children. There is no retry of any
// kind: a failed, timed-out or ambiguous send is recorded, never re-sent.
//
// Safety: store and API version are hard-pinned; the request is validated
// against the exact approved G-E7 documents and the persisted key before
// any child is spawned; a verified, manifest-covered baseline must exist;
// existing output files are never overwritten.
import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { MANIFEST_NAME } from "./evidence-manifest";

export const CAMPAIGN_STORE = "ordermergetest2.myshopify.com";
export const CAMPAIGN_VERSION = "2026-04";
export const CAMPAIGN_DIR = "docs/evidence/shipping-v0-e7";
export const CAMPAIGN_ORDER_GID = "gid://shopify/Order/8078037057783";
export const CAMPAIGN_PARENT_GID = "gid://shopify/OrderTransaction/10162809569527";
export const CAMPAIGN_ORDER_SHORT = CAMPAIGN_ORDER_GID.split("/").pop()!;
const KEY_PLACEHOLDER = "__IDEMPOTENCY_KEY__";
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sha256File = (abs: string) => createHash("sha256").update(readFileSync(abs)).digest("hex");
const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export const campaignVarsFor = (key: string, amount: string) => ({
  input: {
    orderId: CAMPAIGN_ORDER_GID,
    note: `MS-SHIPREFUND-E7-${key}`,
    notify: false,
    currency: "USD",
    shipping: { fullRefund: false, amount },
    transactions: [
      {
        orderId: CAMPAIGN_ORDER_GID,
        parentId: CAMPAIGN_PARENT_GID,
        gateway: "bogus",
        kind: "REFUND",
        amount,
      },
    ],
  },
  idempotencyKey: key,
});

// ── init: persisted key + request files ──────────────────────────────────

export function initCampaign(dir: string): { key: string; reused: boolean } {
  mkdirSync(dir, { recursive: true });
  const keyFile = join(dir, "e7-idempotency-key.txt");
  let key: string;
  let reused = false;
  if (existsSync(keyFile)) {
    key = readFileSync(keyFile, "utf8").trim();
    reused = true;
  } else {
    key = randomUUID();
    writeFileSync(keyFile, key + "\n");
  }
  if (!KEY_RE.test(key)) throw new Error(`persisted key file ${keyFile} is malformed`);
  const writeOnce = (file: string, content: string) => {
    const p = join(dir, file);
    if (!existsSync(p)) writeFileSync(p, content);
  };
  writeOnce("e7-vars-1.00.json", JSON.stringify(campaignVarsFor(key, "1.00")) + "\n");
  writeOnce("e7-vars-changed-0.50.json", JSON.stringify(campaignVarsFor(key, "0.50")) + "\n");
  const templatePath = join(dir, "e7-refund-literal-template.graphql");
  if (existsSync(templatePath)) {
    const tpl = readFileSync(templatePath, "utf8");
    const occurrences = tpl.split(KEY_PLACEHOLDER).length - 1;
    if (occurrences !== 1) {
      throw new Error(`literal template must contain exactly one ${KEY_PLACEHOLDER} (found ${occurrences})`);
    }
    writeOnce("e7-refund-literal.graphql", tpl.split(KEY_PLACEHOLDER).join(key));
  }
  return { key, reused };
}

// ── pre-send authorization ───────────────────────────────────────────────

export type SendDocKind = "variable" | "literal";

/** The request must be exactly one of the approved campaign documents and
 *  one of the two approved variable sets built from the persisted key.
 *  Anything else — another order, amount, parent, gateway, document or key —
 *  refuses. */
export function validateCampaignRequest(opts: {
  dir: string;
  docPath: string;
  varsPath: string;
}): { ok: true; kind: SendDocKind; amount: string } | { ok: false; reason: string } {
  const { dir, docPath, varsPath } = opts;
  const keyFile = join(dir, "e7-idempotency-key.txt");
  if (!existsSync(keyFile)) return { ok: false, reason: `no persisted idempotency key at ${keyFile} — run --init first` };
  const key = readFileSync(keyFile, "utf8").trim();
  if (!KEY_RE.test(key)) return { ok: false, reason: `persisted key in ${keyFile} is malformed` };
  if (!existsSync(docPath)) return { ok: false, reason: `missing document ${docPath}` };
  if (!existsSync(varsPath)) return { ok: false, reason: `missing variables ${varsPath}` };

  const docText = readFileSync(docPath, "utf8");
  const varDoc = join(dir, "e7-refund.graphql");
  const litDoc = join(dir, "e7-refund-literal.graphql");
  const tplPath = join(dir, "e7-refund-literal-template.graphql");
  let kind: SendDocKind;
  if (existsSync(varDoc) && docText === readFileSync(varDoc, "utf8")) {
    kind = "variable";
  } else if (existsSync(litDoc) && existsSync(tplPath) && docText === readFileSync(litDoc, "utf8")) {
    // The literal fallback must be the checked-in template rendered with
    // the persisted key — not just any file on disk.
    const tpl = readFileSync(tplPath, "utf8");
    const rendered = tpl.split(KEY_PLACEHOLDER).join(key);
    if (docText !== rendered) {
      return { ok: false, reason: "literal document does not equal the template rendered with the persisted key" };
    }
    kind = "literal";
  } else {
    return { ok: false, reason: "document is not an approved G-E7 document (variable or rendered literal)" };
  }

  let vars: unknown;
  try { vars = JSON.parse(readFileSync(varsPath, "utf8")); } catch (e) {
    return { ok: false, reason: `variables file does not parse: ${(e as Error).message}` };
  }
  for (const amount of ["1.00", "0.50"] as const) {
    if (deepEqual(vars, campaignVarsFor(key, amount))) return { ok: true, kind, amount };
  }
  return {
    ok: false,
    reason: "variables are not an approved G-E7 payload — order, parent, gateway, amounts, currency, notify and key are all fixed",
  };
}

/** A baseline is verified when it exists, parses to the expected shape for
 *  this order, and its bytes are covered by the dir's manifest (proving it
 *  was produced by a verified read-back run and unchanged since). */
export function verifiedBaseline(dir: string, orderId: string): { ok: true; file: string } | { ok: false; reason: string } {
  const name = `baseline-${orderId.split("/").pop()}.json`;
  const p = join(dir, name);
  if (!existsSync(p)) {
    return { ok: false, reason: `no baseline at ${p} — run the read-back with --save-baseline first` };
  }
  let b: { orderId?: string; refundIds?: unknown; totalRefundedMinor?: unknown; totalRefundedShippingMinor?: unknown };
  try { b = JSON.parse(readFileSync(p, "utf8")); } catch (e) {
    return { ok: false, reason: `baseline does not parse: ${(e as Error).message}` };
  }
  if (b.orderId !== orderId) return { ok: false, reason: `baseline orderId ${b.orderId} != ${orderId}` };
  if (!Array.isArray(b.refundIds) || b.refundIds.some((x) => typeof x !== "string")) {
    return { ok: false, reason: "baseline refundIds is not a string array" };
  }
  if (typeof b.totalRefundedMinor !== "string" || typeof b.totalRefundedShippingMinor !== "string") {
    return { ok: false, reason: "baseline totals are missing or malformed" };
  }
  const mp = join(dir, MANIFEST_NAME);
  if (!existsSync(mp)) return { ok: false, reason: `no ${MANIFEST_NAME} in ${dir} — the baseline's provenance is unverified` };
  const hash = sha256File(p);
  const covered = readFileSync(mp, "utf8").split("\n").some((l) => {
    const [h, f] = l.trim().split(/\s+/);
    return h === hash && f === name;
  });
  if (!covered) {
    return { ok: false, reason: `${name} is not covered by the manifest (changed since the read-back run?)` };
  }
  return { ok: true, file: p };
}

/** Outputs must live inside the evidence dir and must not already exist —
 *  mutation responses are never overwritten. */
export function resolveSendOuts(dir: string, outs: readonly string[]): { ok: true; resolved: string[] } | { ok: false; reason: string } {
  const root = resolve(dir);
  const norm = (p: string) => (p.endsWith(sep) ? p : p + sep);
  const resolved: string[] = [];
  for (const out of outs) {
    const r = resolve(out);
    if (!r.startsWith(norm(root))) {
      return { ok: false, reason: `output ${r} is outside the evidence dir ${root}` };
    }
    if (existsSync(r)) {
      return { ok: false, reason: `output ${r} already exists — mutation responses are never overwritten` };
    }
    resolved.push(r);
  }
  return { ok: true, resolved };
}

/** The whole gate a send must pass: verified baseline, approved request,
 *  writable outputs. Anything failing refuses before any child spawns. */
export function authorizeSend(opts: { dir: string; docPath: string; varsPath: string; outs: string[] }):
  { ok: true; kind: SendDocKind; amount: string; outs: string[] } | { ok: false; reason: string } {
  const b = verifiedBaseline(opts.dir, CAMPAIGN_ORDER_GID);
  if (!b.ok) return b;
  const v = validateCampaignRequest(opts);
  if (!v.ok) return v;
  const o = resolveSendOuts(opts.dir, opts.outs);
  if (!o.ok) return o;
  return { ok: true, kind: v.kind, amount: v.amount, outs: o.resolved };
}

// ── concurrent send ──────────────────────────────────────────────────────

export interface SendResult {
  readonly out: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly error: string | null;
  readonly timedOut: boolean;
  readonly raw: string;
}

type SpawnFn = (command: string, args: readonly string[], options: Record<string, unknown>) => ChildProcess;

/** Spawn every child first, then await all completions — never serial. */
export async function runSendBatch(opts: {
  docPath: string;
  varsPath: string;
  outs: string[];
  spawnFn?: SpawnFn;
  timeoutMs?: number;
  cwd?: string;
}): Promise<{ results: SendResult[] }> {
  const spawnFn = opts.spawnFn ?? realSpawn;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const cwd = opts.cwd ?? process.cwd();
  const argv = ["shopify", "app", "execute", "--store", CAMPAIGN_STORE,
    "--version", CAMPAIGN_VERSION, "--query-file", resolve(opts.docPath),
    "--variable-file", resolve(opts.varsPath)];

  const pending = opts.outs.map((out) => {
    const startedAt = new Date().toISOString();
    const chunks: { out: Buffer[]; err: Buffer[] } = { out: [], err: [] };
    let child: ChildProcess;
    try {
      child = spawnFn("npx", argv, { cwd, shell: true, maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      const raw = `spawn failed: ${(e as Error).message}`;
      writeFileSync(out, raw);
      return Promise.resolve<SendResult>({
        out, startedAt, endedAt: new Date().toISOString(), exitCode: null,
        signal: null, error: (e as Error).message, timedOut: false, raw,
      });
    }
    child.stdout?.on("data", (d: Buffer) => chunks.out.push(d));
    child.stderr?.on("data", (d: Buffer) => chunks.err.push(d));
    return new Promise<SendResult>((res) => {
      let done = false;
      const finish = (r: Omit<SendResult, "out" | "startedAt" | "raw">) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const raw = `${Buffer.concat(chunks.out).toString("utf8")}\n${Buffer.concat(chunks.err).toString("utf8")}`;
        writeFileSync(out, raw);
        res({ out, startedAt, raw, ...r });
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish({
          endedAt: new Date().toISOString(), exitCode: null, signal: null,
          error: `timeout after ${timeoutMs}ms`, timedOut: true,
        });
      }, timeoutMs);
      child.on("error", (e: Error) => finish({
        endedAt: new Date().toISOString(), exitCode: null, signal: null,
        error: e.message, timedOut: false,
      }));
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => finish({
        endedAt: new Date().toISOString(), exitCode: code, signal,
        error: code === 0 ? null : `exit code ${code}${signal ? `, signal ${signal}` : ""}`,
        timedOut: false,
      }));
    });
  });

  const results = await Promise.all(pending);
  return { results };
}
