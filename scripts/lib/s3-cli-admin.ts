// ── S3-only Shopify CLI transport for the staged dev-store run ────────────────
//
// The S3 local run cannot use `unauthenticated.admin(shop)`: no offline
// Session row can be obtained without changing the production app config.
// This module adapts the proven `shopify app execute` channel (the same one
// tests/live-protocol.test.ts drives, attributed by Shopify to app
// gid://shopify/App/426185785345, which may mutate ONLY on development
// stores) into an AdminClient with hard per-mode document policy, a
// write-once refund budget, zero retries and a JSONL transport log.
//
//   - read-only : queries only; every mutation is refused before spawn.
//   - merge     : mutations string-equal to one of the eight pinned merge
//                 documents (the exact templates merge.server.ts /
//                 operation-protocol.server.ts send — the ONLY mutations
//                 the engine ever sends); anything else refuses.
//   - refund    : the ONLY mutation permitted is a document string-equal to
//                 the pinned contract document sendRefund passes — and only
//                 once per adapter instance; a second dispatch document
//                 throws without spawning (the single-send rule).
//
// The store, app id and API version are literals — never env overrides — so
// the experiment cannot be redirected to another store or app. Every call
// appends one JSONL line to the operator-supplied transport log; variables,
// tokens and environment are never logged.
//
// Nothing here imports app/shopify.server, touches a Session row or retries
// a call: a killed or failed send surfaces as a transport error and the
// existing T4/IN_DOUBT machinery decides — never a resend.

import { execFile, spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AdminClient } from "../../app/lib/graphql.server";
import {
  EDIT_ADD_VARIANT_MUTATION,
  EDIT_BEGIN_MUTATION,
  EDIT_LINE_DISCOUNT_MUTATION,
} from "../../app/lib/merge.server";
import {
  CANCEL_MUTATION,
  CLOSE_MUTATION,
  COMMIT_MUTATION,
  NOTE_MUTATION,
  TAGS_ADD_MUTATION,
} from "../../app/lib/operation-protocol.server";
import { shippingRefundMutationDocument } from "../../app/lib/shipping-refund-contract";

// ── Hard pins (literals, no env override) ─────────────────────────────────────

export const S3_STORE = "ordermergetest2.myshopify.com";
export const S3_APP_ID = "gid://shopify/App/426185785345";
export const S3_API_VERSION = "2026-04";

/** The identity read the CLI session proof and the `identity` stage share. */
export const S3_IDENTITY_QUERY =
  "query S3Identity { shop { myshopifyDomain } currentAppInstallation { app { id } } }";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── CLI runner seam ───────────────────────────────────────────────────────────

export interface CliRunRequest {
  /** Arguments after `npx` (the runner prepends npx / npx-via-shell). */
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface CliRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A spawned CLI call. `done` settles on process exit (or a spawn error);
 *  `kill` must terminate the whole child tree, not just the wrapper. */
export interface CliRunHandle {
  readonly done: Promise<CliRunResult>;
  kill(): void;
}

export type CliRunner = (request: CliRunRequest) => CliRunHandle;

/** Real runner: `npx shopify app execute ...` with stdin closed. Windows
 *  spawns through cmd.exe (npx is a .cmd shim and cannot be spawned
 *  directly) and kills with `taskkill /pid <pid> /T /F`; elsewhere the
 *  child is detached so the abort can kill the whole process group. */
const realCliRunner: CliRunner = (req) => {
  const isWin = process.platform === "win32";
  const child = spawn("npx", [...req.args], {
    cwd: req.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWin,
    detached: !isWin,
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => {
    stdout += d;
  });
  child.stderr?.on("data", (d) => {
    stderr += d;
  });
  const done = new Promise<CliRunResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code, stdout, stderr }));
  });
  return {
    done,
    kill: () => {
      const pid = child.pid;
      if (pid === undefined) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* best effort */
        }
        return;
      }
      if (isWin) {
        try {
          execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {});
        } catch {
          /* best effort */
        }
      } else {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* best effort */
          }
        }
      }
    },
  };
};

// ── Output parsing (copied from tests/live-protocol.test.ts — do not edit the
//    test file; keep the two implementations in step) ─────────────────────────

/** `shopify app execute` prints result JSON on stdout on success and wraps an
 *  error JSON in a drawn box on stderr (exit code still 0). Strip ANSI escapes
 *  and `│` borders, then parse the outermost JSON object. */
const parseCliBody = (text: string): any => {
  // eslint-disable-next-line no-control-regex -- strips ANSI escapes from CLI output
  const clean = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const stripped = clean
    .split("\n")
    .map((line) => {
      const m = line.match(/^\s*│\s?(.*?)\s*│?\s*$/);
      return m ? m[1] : line;
    })
    .join("\n");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
};

// ── GraphQL document classification ──────────────────────────────────────────

type Token = { kind: "name" | "punct" | "string"; value: string };

/** Minimal lexer: names, punctuators and string/block-string atoms (contents
 *  discarded — they only need correct skipping so a `{` inside a description
 *  can never look like a selection set). Comments and commas are whitespace. */
function tokenizeGraphql(doc: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = doc.length;
  while (i < n) {
    const c = doc[i];
    if (c === "#") {
      while (i < n && doc[i] !== "\n") i++;
      continue;
    }
    if (/[\s,]/.test(c)) {
      i++;
      continue;
    }
    if (c === '"') {
      if (doc.startsWith('"""', i)) {
        let j = i + 3;
        while (j < n && !doc.startsWith('"""', j)) j += doc[j] === "\\" ? 2 : 1;
        if (j >= n) throw new Error("unterminated GraphQL block string");
        tokens.push({ kind: "string", value: "" });
        i = j + 3;
        continue;
      }
      let j = i + 1;
      while (j < n && doc[j] !== '"' && doc[j] !== "\n") {
        j += doc[j] === "\\" ? 2 : 1;
      }
      if (j >= n || doc[j] === "\n") {
        throw new Error("unterminated GraphQL string");
      }
      tokens.push({ kind: "string", value: "" });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(doc[j])) j++;
      tokens.push({ kind: "name", value: doc.slice(i, j) });
      i = j;
      continue;
    }
    if (doc.startsWith("...", i)) {
      tokens.push({ kind: "punct", value: "..." });
      i += 3;
      continue;
    }
    if ("{}():=@$!&|[]".includes(c)) {
      tokens.push({ kind: "punct", value: c });
      i++;
      continue;
    }
    if (/[0-9+\-.]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_+\-.eE]/.test(doc[j])) j++;
      tokens.push({ kind: "punct", value: doc.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

interface ClassifiedDocument {
  readonly opType: "query" | "mutation" | "subscription";
  readonly opName: string | null;
  readonly rootFields: readonly string[];
}

const OPERATION_KEYWORDS = new Set(["query", "mutation", "subscription"]);
const DEFINITION_KEYWORDS = new Set([
  "fragment",
  "schema",
  "scalar",
  "type",
  "interface",
  "union",
  "enum",
  "input",
  "extend",
  "directive",
]);

/** Consume a balanced `(` ... `)` group starting at index i; returns the
 *  index AFTER the close paren. */
function skipParens(toks: Token[], i: number): number {
  if (toks[i]?.value !== "(") return i;
  let depth = 0;
  while (i < toks.length) {
    if (toks[i].value === "(") depth++;
    else if (toks[i].value === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  throw new Error("unterminated variable/directive list");
}

/** Read the top-level selection set opened at toks[openIdx] === '{' and
 *  collect the root field names (aliases resolve to the real name, spreads
 *  record as `...Name`). Returns fields plus the index after `}`. */
function readSelectionSet(
  toks: Token[],
  openIdx: number,
): { fields: string[]; next: number } {
  const fields: string[] = [];
  let brace = 1;
  let paren = 0;
  let afterAt = false;
  let i = openIdx + 1;
  while (i < toks.length) {
    const t = toks[i];
    if (t.kind === "punct") {
      if (t.value === "{") {
        brace++;
      } else if (t.value === "}") {
        brace--;
        if (brace === 0) return { fields, next: i + 1 };
      } else if (t.value === "(") {
        paren++;
      } else if (t.value === ")") {
        paren--;
      } else if (t.value === "@") {
        afterAt = true;
      } else if (t.value === "...") {
        if (brace === 1 && paren === 0) {
          const nx = toks[i + 1];
          fields.push(nx?.kind === "name" ? `...${nx.value}` : "...");
          i += nx?.kind === "name" ? 2 : 1;
          continue;
        }
      }
      i++;
      continue;
    }
    if (t.kind === "name" && brace === 1 && paren === 0) {
      if (afterAt) {
        afterAt = false;
        i++;
        continue;
      }
      const nx1 = toks[i + 1];
      const nx2 = toks[i + 2];
      if (nx1?.kind === "punct" && nx1.value === ":" && nx2?.kind === "name") {
        fields.push(nx2.value); // alias: realField
        i += 3;
        continue;
      }
      fields.push(t.value);
    }
    i++;
  }
  throw new Error("unterminated selection set");
}

/** Parse `query|mutation|subscription` at index i. Returns the classified op
 *  and the index after its selection set. */
function parseOperation(
  toks: Token[],
  i: number,
): { cls: ClassifiedDocument; next: number } {
  const opType = toks[i].value as ClassifiedDocument["opType"];
  let j = i + 1;
  let opName: string | null = null;
  if (toks[j]?.kind === "name") {
    opName = toks[j].value;
    j++;
  }
  j = skipParens(toks, j); // variable definitions
  while (toks[j]?.value === "@") {
    j++;
    if (toks[j]?.kind !== "name") throw new Error("malformed directive");
    j++;
    j = skipParens(toks, j);
  }
  if (toks[j]?.value !== "{") {
    throw new Error(`operation ${opName ?? "<anonymous>"} has no selection set`);
  }
  const sel = readSelectionSet(toks, j);
  return { cls: { opType, opName, rootFields: sel.fields }, next: sel.next };
}

/** Skip a non-operation definition (fragment or type-system definition):
 *  consume tokens until its selection/fields block is balanced, or until the
 *  next definition keyword when it carries no braces. */
function skipDefinition(toks: Token[], i: number): number {
  let j = i + 1;
  while (j < toks.length) {
    const t = toks[j];
    if (t.kind === "punct" && t.value === "{") {
      let brace = 1;
      j++;
      while (j < toks.length && brace > 0) {
        if (toks[j].value === "{") brace++;
        else if (toks[j].value === "}") brace--;
        j++;
      }
      if (brace !== 0) throw new Error("unterminated definition body");
      return j;
    }
    if (t.kind === "string") return j;
    if (t.kind === "name" && (OPERATION_KEYWORDS.has(t.value) || DEFINITION_KEYWORDS.has(t.value))) {
      return j;
    }
    j++;
  }
  return j;
}

/** Classify a GraphQL document for policy enforcement. Exactly ONE operation
 *  definition is permitted (fragments and other definitions may accompany
 *  it); anything else throws before any process is spawned. */
export function classifyS3Document(doc: string): ClassifiedDocument {
  const toks = tokenizeGraphql(doc);
  const ops: ClassifiedDocument[] = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.kind === "string") {
      i++;
      continue;
    }
    if (t.kind === "punct" && t.value === "{") {
      const sel = readSelectionSet(toks, i);
      ops.push({ opType: "query", opName: null, rootFields: sel.fields });
      i = sel.next;
      continue;
    }
    if (t.kind === "name" && OPERATION_KEYWORDS.has(t.value)) {
      const op = parseOperation(toks, i);
      ops.push(op.cls);
      i = op.next;
      continue;
    }
    if (t.kind === "name" && DEFINITION_KEYWORDS.has(t.value)) {
      i = skipDefinition(toks, i);
      continue;
    }
    throw new Error(
      `unrecognized GraphQL definition near token ${JSON.stringify(t.value)}`,
    );
  }
  if (ops.length !== 1) {
    throw new Error(
      `document must contain exactly one operation definition (found ${ops.length})`,
    );
  }
  return ops[0];
}

// ── Mode policy ───────────────────────────────────────────────────────────────

export type S3CliMode = "read-only" | "merge" | "refund";

/** The complete set of merge-path mutation documents — the exact eight
 *  `#graphql` template strings the engine sends, imported verbatim from
 *  app/lib/merge.server.ts and app/lib/operation-protocol.server.ts. Merge
 *  mode requires string equality with one of these documents, so a
 *  modified document, an added field, a changed argument (notifyCustomer,
 *  allowDuplicates, refundMethod, restock) or a different mutation that
 *  merely reuses an approved operation name is refused before spawn. */
const S3_MERGE_MUTATION_DOCUMENTS: ReadonlySet<string> = new Set([
  EDIT_BEGIN_MUTATION,
  EDIT_ADD_VARIANT_MUTATION,
  EDIT_LINE_DISCOUNT_MUTATION,
  COMMIT_MUTATION,
  CANCEL_MUTATION,
  TAGS_ADD_MUTATION,
  NOTE_MUTATION,
  CLOSE_MUTATION,
]);
if (S3_MERGE_MUTATION_DOCUMENTS.size !== 8) {
  throw new Error("merge mutation allowlist must contain the eight distinct pinned documents");
}

export class S3CliPolicyError extends Error {
  name = "S3CliPolicyError";
}

export class S3CliTransportError extends Error {
  name = "S3CliTransportError";
}

const abortError = () => new DOMException("The operation was aborted.", "AbortError");
const isAbortError = (e: unknown): boolean =>
  e instanceof DOMException && e.name === "AbortError";

type TransportOutcome = "ok" | "errors" | "transport" | "aborted" | "rejected-by-policy";

// ── The adapter ───────────────────────────────────────────────────────────────

export interface S3CliAdminOptions {
  readonly store: string;
  readonly mode: S3CliMode;
  /** JSONL audit log path — one line per graphql() call. */
  readonly transportLog: string;
  /** Test seam: replace the real `npx shopify app execute` spawn. */
  readonly run?: CliRunner;
}

/** Create the S3-only AdminClient over `shopify app execute`. The store is
 *  pinned at construction; the mode policy and the abort check run BEFORE
 *  anything is spawned, and no call is ever retried. */
export function createS3CliAdmin(opts: S3CliAdminOptions): AdminClient {
  if (opts.store !== S3_STORE) {
    throw new S3CliPolicyError(
      `S3 CLI transport is pinned to ${S3_STORE} (got ${JSON.stringify(opts.store)})`,
    );
  }
  const mode = opts.mode;
  const runner = opts.run ?? realCliRunner;
  const transportLog = opts.transportLog;
  let logDirReady = false;
  /** refund mode: the single permitted dispatch, consumed at admission. */
  let refundDispatched = 0;

  const logLine = (line: {
    opType: string | null;
    opName: string | null;
    rootFields: readonly string[] | null;
    durationMs: number;
    exitCode: number | null;
    outcome: TransportOutcome;
  }) => {
    if (!logDirReady) {
      mkdirSync(dirname(transportLog), { recursive: true });
      logDirReady = true;
    }
    // Never log variables, the document text, tokens or environment.
    appendFileSync(
      transportLog,
      JSON.stringify({ at: new Date().toISOString(), mode, ...line }) + "\n",
    );
  };

  const graphql = async (
    query: string,
    options?: { variables?: Record<string, unknown>; signal?: AbortSignal },
  ): Promise<Response> => {
    const started = Date.now();
    const signal = options?.signal;

    // ── Classification + policy + pre-abort: all BEFORE any spawn. ──
    let cls: ClassifiedDocument | null = null;
    try {
      cls = classifyS3Document(query);
      if (cls.opType === "subscription") {
        throw new S3CliPolicyError("subscription documents are not permitted");
      }
      if (cls.opType === "mutation") {
        if (mode === "read-only") {
          throw new S3CliPolicyError(
            `mutation ${cls.opName ?? "<anonymous>"} is forbidden in read-only mode`,
          );
        }
        if (mode === "merge") {
          if (!S3_MERGE_MUTATION_DOCUMENTS.has(query)) {
            throw new S3CliPolicyError(
              `mutation ${cls.opName ?? "<anonymous>"} is not one of the eight pinned merge documents`,
            );
          }
        }
        if (mode === "refund") {
          // The one authorized dispatch: string-equal to the pinned contract
          // document sendRefund passes, and at most once per adapter.
          if (query !== shippingRefundMutationDocument()) {
            throw new S3CliPolicyError(
              "refund mode permits only the exact pinned dispatch document",
            );
          }
          if (refundDispatched > 0) {
            throw new S3CliPolicyError(
              "the dispatch document was already sent once — a second send is never issued",
            );
          }
          refundDispatched += 1; // consumed at admission, before spawn
        }
      }
      if (signal?.aborted) throw abortError();
    } catch (err) {
      logLine({
        opType: cls?.opType ?? null,
        opName: cls?.opName ?? null,
        rootFields: cls?.rootFields ?? null,
        durationMs: Date.now() - started,
        exitCode: null,
        outcome: isAbortError(err) ? "aborted" : "rejected-by-policy",
      });
      throw err;
    }

    // ── Spawn (exactly once — this transport never retries). ──
    const dir = mkdtempSync(join(tmpdir(), "mergeship-s3-"));
    try {
      const queryFile = join(dir, "query.graphql");
      writeFileSync(queryFile, query);
      const args = [
        "shopify",
        "app",
        "execute",
        "--store",
        S3_STORE,
        "--version",
        S3_API_VERSION,
        "--query-file",
        queryFile,
      ];
      if (options?.variables !== undefined) {
        const variablesFile = join(dir, "variables.json");
        writeFileSync(variablesFile, JSON.stringify(options.variables));
        args.push("--variable-file", variablesFile);
      }
      args.push("--no-color");

      const handle = runner({ args, cwd: REPO_ROOT });
      const result = await new Promise<CliRunResult>((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          try {
            handle.kill();
          } catch {
            /* best effort */
          }
          reject(abortError());
        };
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        handle.done.then(
          (r) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            resolve(r);
          },
          (e) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            reject(e);
          },
        );
      });

      const parsed = parseCliBody(result.stdout) ?? parseCliBody(result.stderr);
      if (parsed === null || typeof parsed !== "object") {
        logLine({
          opType: cls.opType,
          opName: cls.opName,
          rootFields: cls.rootFields,
          durationMs: Date.now() - started,
          exitCode: result.exitCode,
          outcome: "transport",
        });
        throw new S3CliTransportError(
          `shopify CLI returned unparseable output (exit ${result.exitCode ?? "?"})`,
        );
      }
      const hasErrors = Array.isArray(parsed.errors);
      const body = hasErrors
        ? { data: parsed.data ?? null, errors: parsed.errors }
        : "data" in parsed
          ? { data: parsed.data }
          : { data: parsed };
      logLine({
        opType: cls.opType,
        opName: cls.opName,
        rootFields: cls.rootFields,
        durationMs: Date.now() - started,
        exitCode: result.exitCode,
        outcome: hasErrors ? "errors" : "ok",
      });
      return { json: async () => body } as unknown as Response;
    } catch (err) {
      if (!isAbortError(err) && !(err instanceof S3CliTransportError)) {
        logLine({
          opType: cls.opType,
          opName: cls.opName,
          rootFields: cls.rootFields,
          durationMs: Date.now() - started,
          exitCode: null,
          outcome: "transport",
        });
        throw new S3CliTransportError(
          `shopify CLI call failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (isAbortError(err)) {
        logLine({
          opType: cls.opType,
          opName: cls.opName,
          rootFields: cls.rootFields,
          durationMs: Date.now() - started,
          exitCode: null,
          outcome: "aborted",
        });
      }
      throw err;
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  };

  return { graphql };
}

// ── CLI session proof (the N12 substitute for this operator process) ──────────

/**
 * CLI auth has no stored offline Session row: this loader substitutes a live
 * credential + identity proof for the S3 operator process only — the identity
 * query must succeed through the CLI transport AND return exactly the pinned
 * dev-store domain and app gid, or the loader reports null (fails closed).
 * It is NEVER wired into app/ or the server, and no Session row is created.
 * The proof runs on every invocation — no caching — so the guard is
 * evaluated immediately before the Shopify calls it gates, mirroring N12.
 */
export function createS3CliSessionLoader(
  admin: AdminClient,
): (shop: string) => Promise<{ expires: Date | null } | null> {
  return async (shop: string) => {
    if (shop !== S3_STORE) return null;
    try {
      const res = await admin.graphql(S3_IDENTITY_QUERY, {});
      const body = (await res.json()) as {
        data?: {
          shop?: { myshopifyDomain?: string };
          currentAppInstallation?: { app?: { id?: string } };
        };
        errors?: unknown;
      };
      if (Array.isArray(body?.errors) && body.errors.length > 0) return null;
      const domain = body?.data?.shop?.myshopifyDomain;
      const appId = body?.data?.currentAppInstallation?.app?.id;
      if (domain === S3_STORE && appId === S3_APP_ID) return { expires: null };
      return null;
    } catch {
      return null;
    }
  };
}

/** The `identity` stage: one proof read through the adapter. `match` is true
 *  only when the CLI credential resolves to exactly the pinned store and app
 *  on the pinned API version. */
export async function runS3IdentityProbe(admin: AdminClient): Promise<{
  shopDomain: string | null;
  appId: string | null;
  apiVersion: string;
  match: boolean;
}> {
  let shopDomain: string | null = null;
  let appId: string | null = null;
  try {
    const res = await admin.graphql(S3_IDENTITY_QUERY, {});
    const body = (await res.json()) as {
      data?: {
        shop?: { myshopifyDomain?: string };
        currentAppInstallation?: { app?: { id?: string } };
      };
    };
    shopDomain = body?.data?.shop?.myshopifyDomain ?? null;
    appId = body?.data?.currentAppInstallation?.app?.id ?? null;
  } catch {
    /* match stays false */
  }
  return {
    shopDomain,
    appId,
    apiVersion: S3_API_VERSION,
    match: shopDomain === S3_STORE && appId === S3_APP_ID,
  };
}

// ── S3 dispatch preflight (pure — unit-tested, mirrors the staged gate) ───────

export interface S3DispatchPreflightFacts {
  /** current_database() on the connected disposable database. */
  readonly databaseName: string | null;
  /** --expect-db (already validated as mergeship_test_*). */
  readonly expectedDatabaseName: string;
  /** Every due PREPARED ShippingRefund row anywhere in the database. */
  readonly duePreparedRows: readonly { readonly id: string }[];
  /** The --row record, or null when absent. */
  readonly row: {
    readonly status: string;
    readonly shop: string;
    readonly sourceOrderId: string;
    readonly primaryOrderId: string;
    readonly approvedWireHash: string | null;
    readonly plannedShippingMinor: string | null;
  } | null;
  readonly expectedRowId: string;
  /** The pinned dev store the row must belong to. */
  readonly expectedShop: string;
  readonly expectedSourceOrderId: string;
  readonly expectedPrimaryOrderId: string;
}

export interface S3DispatchPreflightVerdict {
  readonly checks: Record<string, boolean>;
  readonly failed: string[];
  readonly ok: boolean;
}

/** The fail-closed S3 dispatch gate: the database is the expected disposable
 *  database, --row is the single due PREPARED row anywhere, it belongs to the
 *  dev store, carries the expected order ids, an approved wire hash and a
 *  planned amount within the staged cap. Pure — the script supplies facts. */
export function evaluateS3DispatchPreflight(
  facts: S3DispatchPreflightFacts,
): S3DispatchPreflightVerdict {
  const r = facts.row;
  const checks: Record<string, boolean> = {
    disposableDb: facts.databaseName === facts.expectedDatabaseName,
    rowExists: r?.status === "PREPARED",
    shopIsDevStore: r?.shop === facts.expectedShop,
    onlyDueRow:
      facts.duePreparedRows.length === 1 &&
      facts.duePreparedRows[0]?.id === facts.expectedRowId,
    ordersMatch:
      r?.sourceOrderId === facts.expectedSourceOrderId &&
      r?.primaryOrderId === facts.expectedPrimaryOrderId,
    wireApproved:
      typeof r?.approvedWireHash === "string" && r.approvedWireHash.length === 64,
    amountWithinLimit:
      typeof r?.plannedShippingMinor === "string" &&
      /^\d+$/.test(r.plannedShippingMinor) &&
      BigInt(r.plannedShippingMinor) <= 400n,
  };
  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([k]) => k);
  return { checks, failed, ok: failed.length === 0 };
}

// ── S3 sweep scope (pure — unit-tested; restricts the sweep to the two
//    approved orders) ─────────────────────────────────────────────────────

export interface S3SweepScopeFacts {
  /** The two approved test-order gids (--orders, sorted for comparison). */
  readonly expectedOrderIds: readonly [string, string];
  /** Every ProcessedWebhook row for the dev store. */
  readonly workItems: readonly { readonly orderId: string }[];
  /** Every MergeOperation for the dev store (any phase). */
  readonly operations: readonly {
    readonly id: string;
    readonly involvedOrderIds: readonly string[];
  }[];
}

export interface S3SweepScopeVerdict {
  readonly checks: Record<string, boolean>;
  readonly failed: string[];
  readonly ok: boolean;
}

/** The sweep may only ever act on the two approved test orders. Before
 *  every mutating sweep invocation the disposable database must contain
 *  exactly the two expected work items for the dev store and at most one
 *  MergeOperation whose involved orders are a subset of the approved
 *  pair — an extra or mismatched order, an extra item, or more than one
 *  operation fails closed. */
export function evaluateS3SweepScope(
  facts: S3SweepScopeFacts,
): S3SweepScopeVerdict {
  const expected = new Set(facts.expectedOrderIds);
  const workIds = new Set(facts.workItems.map((w) => w.orderId));
  const extraWork = facts.workItems.filter((w) => !expected.has(w.orderId));
  const missing = [...expected].filter((id) => !workIds.has(id));
  const foreignOps = facts.operations.filter(
    (o) => !o.involvedOrderIds.every((id) => expected.has(id)),
  );
  const checks: Record<string, boolean> = {
    exactlyTwoWorkItems: facts.workItems.length === 2 && missing.length === 0,
    noExtraWorkItems: extraWork.length === 0,
    atMostOneOperation: facts.operations.length <= 1,
    noForeignOperationOrders: foreignOps.length === 0,
  };
  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([k]) => k);
  return { checks, failed, ok: failed.length === 0 };
}
