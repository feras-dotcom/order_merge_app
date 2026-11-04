// Unit tests for the S3-only CLI transport (scripts/lib/s3-cli-admin.ts).
// No network and no real spawn: every test injects the `run` seam. Covers
// the store pin, the three mode policies, the single-send refund budget,
// zero-retry transport semantics, abort kill, output parsing, the JSONL
// transport log, the CLI session-proof loader and the pure S3 dispatch
// preflight verdict.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { shippingRefundMutationDocument } from "../app/lib/shipping-refund-contract";
import {
  EDIT_ADD_VARIANT_MUTATION,
  EDIT_BEGIN_MUTATION,
  EDIT_LINE_DISCOUNT_MUTATION,
} from "../app/lib/merge.server";
import {
  CANCEL_MUTATION,
  CLOSE_MUTATION,
  COMMIT_MUTATION,
  NOTE_MUTATION,
  TAGS_ADD_MUTATION,
} from "../app/lib/operation-protocol.server";
import {
  createS3CliAdmin,
  createS3CliSessionLoader,
  evaluateS3DispatchPreflight,
  evaluateS3SweepScope,
  runS3IdentityProbe,
  S3_APP_ID,
  S3_STORE,
  type CliRunRequest,
  type CliRunResult,
  type CliRunner,
  type S3CliMode,
  type S3DispatchPreflightFacts,
} from "../scripts/lib/s3-cli-admin";

const IDENTITY_BODY = {
  data: {
    shop: { myshopifyDomain: S3_STORE },
    currentAppInstallation: { app: { id: S3_APP_ID } },
  },
};

interface Recorder {
  calls: CliRunRequest[];
  kills: number;
}

const recorder = (): Recorder => ({ calls: [], kills: 0 });

const result = (body: unknown, exitCode = 0): CliRunResult => ({
  exitCode,
  stdout: typeof body === "string" ? body : JSON.stringify(body),
  stderr: "",
});

const runnerReturning = (res: CliRunResult, rec: Recorder): CliRunner => (req) => {
  rec.calls.push(req);
  return { done: Promise.resolve(res), kill: () => { rec.kills += 1; } };
};

const runnerStderr = (stderr: string, rec: Recorder): CliRunner => (req) => {
  rec.calls.push(req);
  return {
    done: Promise.resolve({ exitCode: 1, stdout: "", stderr }),
    kill: () => { rec.kills += 1; },
  };
};

const runnerThrowing = (err: unknown, rec: Recorder): CliRunner => (req) => {
  rec.calls.push(req);
  return { done: Promise.reject(err), kill: () => { rec.kills += 1; } };
};

const runnerHanging = (rec: Recorder): CliRunner => (req) => {
  rec.calls.push(req);
  return {
    done: new Promise<CliRunResult>(() => {}),
    kill: () => { rec.kills += 1; },
  };
};

const logPath = () => join(mkdtempSync(join(tmpdir(), "s3-cli-test-")), "transport.jsonl");

const admin = (
  mode: S3CliMode,
  rec: Recorder,
  run: CliRunner,
) => createS3CliAdmin({ store: S3_STORE, mode, transportLog: logPath(), run });

const json = async (res: Response) => (await res.json()) as { data?: unknown; errors?: unknown };

describe("store pin", () => {
  it("refuses any store other than the pinned dev store at construction", () => {
    for (const store of ["other.myshopify.com", "", "ordermergetest3.myshopify.com"]) {
      expect(() =>
        createS3CliAdmin({ store, mode: "read-only", transportLog: logPath() }),
      ).toThrow(/pinned/);
    }
    expect(() =>
      createS3CliAdmin({ store: S3_STORE, mode: "read-only", transportLog: logPath() }),
    ).not.toThrow();
  });
});

describe("read-only mode", () => {
  it("rejects a mutation without spawning", async () => {
    const rec = recorder();
    const a = admin("read-only", rec, runnerReturning(result({ data: {} }), rec));
    await expect(
      a.graphql("mutation Evil { orderCancel(orderId: \"gid://shopify/Order/1\") { job { id } } }"),
    ).rejects.toThrow(/forbidden in read-only/);
    expect(rec.calls).toHaveLength(0);
  });

  it("allows a query with exactly one spawn", async () => {
    const rec = recorder();
    const a = admin("read-only", rec, runnerReturning(result({ data: { shop: { id: "s" } } }), rec));
    const res = await a.graphql("query Probe { shop { id } }");
    expect((await json(res)).data).toEqual({ shop: { id: "s" } });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].args).toContain("app");
    expect(rec.calls[0].args).toContain(S3_STORE);
    expect(rec.calls[0].args).toContain("2026-04");
  });
});

describe("merge mode", () => {
  // The real merge documents, imported from the modules that send them —
  // the policy is exact string equality, not an operation-name list.
  const PINNED_DOCS = [
    ["MergeEditBegin", EDIT_BEGIN_MUTATION],
    ["MergeEditAddVariant", EDIT_ADD_VARIANT_MUTATION],
    ["MergeEditDiscount", EDIT_LINE_DISCOUNT_MUTATION],
    ["MergeEditCommit", COMMIT_MUTATION],
    ["MergeCancelSecondary", CANCEL_MUTATION],
    ["MergeTagsAdd", TAGS_ADD_MUTATION],
    ["MergeAnnotateNote", NOTE_MUTATION],
    ["MergeOrderClose", CLOSE_MUTATION],
  ] as const;

  it.each(PINNED_DOCS)("permits the real %s document", async (_name, doc) => {
    const rec = recorder();
    const a = admin("merge", rec, runnerReturning(result({ data: { f: 1 } }), rec));
    await a.graphql(doc);
    expect(rec.calls).toHaveLength(1);
  });

  it("rejects a document that reuses an approved operation name for another mutation", async () => {
    const rec = recorder();
    const a = admin("merge", rec, runnerReturning(result({ data: {} }), rec));
    await expect(a.graphql("mutation MergeEditBegin { f }")).rejects.toThrow(/pinned merge/);
    await expect(
      a.graphql("mutation MergeEditCommit($id: ID!) { orderEditCommit(id: $id, notifyCustomer: true) { order { id } } }"),
    ).rejects.toThrow(/pinned merge/);
    expect(rec.calls).toHaveLength(0);
  });

  it("rejects the real document with safety-critical arguments changed or fields added", async () => {
    const rec = recorder();
    const a = admin("merge", rec, runnerReturning(result({ data: {} }), rec));
    // notifyCustomer flipped on the real commit document.
    const badCommit = COMMIT_MUTATION.replace("notifyCustomer: false", "notifyCustomer: true");
    expect(badCommit).not.toBe(COMMIT_MUTATION);
    await expect(a.graphql(badCommit)).rejects.toThrow(/pinned merge/);
    // refundMethod flipped on the real cancel document (the merge must
    // never refund).
    const badCancel = CANCEL_MUTATION.replace(
      "refundMethod: { originalPaymentMethodsRefund: false }",
      "refundMethod: { originalPaymentMethodsRefund: true }",
    );
    await expect(a.graphql(badCancel)).rejects.toThrow(/pinned merge/);
    // An added root field on the real begin document.
    const added = EDIT_BEGIN_MUTATION.replace(
      "orderEditBegin(id: $id) {",
      "orderEditBegin(id: $id) {",
    ).replace("userErrors { field message }", "order { id } userErrors { field message }");
    await expect(a.graphql(added)).rejects.toThrow(/pinned merge/);
    expect(rec.calls).toHaveLength(0);
  });

  it("rejects the pinned refund document, unknown mutations and multi-operation docs", async () => {
    const rec = recorder();
    const a = admin("merge", rec, runnerReturning(result({ data: {} }), rec));
    await expect(a.graphql(shippingRefundMutationDocument())).rejects.toThrow(/pinned merge/);
    await expect(a.graphql("mutation SomethingElse { f }")).rejects.toThrow(/pinned merge/);
    await expect(
      a.graphql("query A { a } mutation MergeEditBegin { f }"),
    ).rejects.toThrow(/exactly one operation/);
    await expect(a.graphql("subscription S { f }")).rejects.toThrow();
    expect(rec.calls).toHaveLength(0);
  });

  it("still allows queries", async () => {
    const rec = recorder();
    const a = admin("merge", rec, runnerReturning(result({ data: { ok: true } }), rec));
    await a.graphql("query { shop { id } }");
    expect(rec.calls).toHaveLength(1);
  });
});

describe("refund mode", () => {
  it("permits the exact pinned dispatch document exactly once", async () => {
    const rec = recorder();
    const a = admin("refund", rec, runnerReturning(result({ data: { r: 1 } }), rec));
    await a.graphql(shippingRefundMutationDocument());
    expect(rec.calls).toHaveLength(1);
    // The single-send budget is consumed at admission: a second dispatch
    // document throws without spawning, whatever the first call returned.
    await expect(a.graphql(shippingRefundMutationDocument())).rejects.toThrow(/already sent/);
    expect(rec.calls).toHaveLength(1);
  });

  it("rejects a document differing from the pinned one by a single character", async () => {
    const rec = recorder();
    const a = admin("refund", rec, runnerReturning(result({ data: {} }), rec));
    const doc = shippingRefundMutationDocument();
    const altered = `${doc.slice(0, 10)}X${doc.slice(11)}`;
    expect(altered).not.toBe(doc);
    await expect(a.graphql(altered)).rejects.toThrow(/exact pinned dispatch document/);
    expect(rec.calls).toHaveLength(0);
  });

  it("rejects every other mutation but still allows queries", async () => {
    const rec = recorder();
    const a = admin("refund", rec, runnerReturning(result({ data: { ok: 1 } }), rec));
    await expect(a.graphql("mutation MergeEditBegin { f }")).rejects.toThrow();
    expect(rec.calls).toHaveLength(0);
    await a.graphql("query Recheck { nodes(ids: []) { id } }");
    expect(rec.calls).toHaveLength(1);
  });
});

describe("zero retries", () => {
  it("throws after exactly one spawn on unparseable output", async () => {
    const rec = recorder();
    const a = admin("read-only", rec, runnerReturning(result("NOT JSON AT ALL"), rec));
    await expect(a.graphql("query { shop { id } }")).rejects.toThrow(/unparseable/);
    expect(rec.calls).toHaveLength(1);
  });

  it("throws after exactly one spawn when the runner fails", async () => {
    const rec = recorder();
    const a = admin("read-only", rec, runnerThrowing(new Error("spawn ENOENT"), rec));
    await expect(a.graphql("query { shop { id } }")).rejects.toThrow(/ENOENT/);
    expect(rec.calls).toHaveLength(1);
  });
});

describe("abort", () => {
  it("a pre-aborted signal rejects with AbortError and never spawns", async () => {
    const rec = recorder();
    const a = admin("read-only", rec, runnerHanging(rec));
    const c = new AbortController();
    c.abort();
    await expect(a.graphql("query { shop { id } }", { signal: c.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(rec.calls).toHaveLength(0);
    expect(rec.kills).toBe(0);
  });

  it("a mid-flight abort kills the runner and rejects with AbortError", async () => {
    const rec = recorder();
    const a = admin("read-only", rec, runnerHanging(rec));
    const c = new AbortController();
    const pending = a.graphql("query { shop { id } }", { signal: c.signal });
    // Let the adapter reach the spawn before aborting.
    await new Promise((r) => setTimeout(r, 0));
    c.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(rec.calls).toHaveLength(1);
    expect(rec.kills).toBe(1);
  });
});

describe("output parsing", () => {
  it("maps a data-only body to { data }", async () => {
    const rec = recorder();
    const a = admin("read-only", rec, runnerReturning(result({ data: { a: 1 } }), rec));
    expect(await json(await a.graphql("query { a }"))).toEqual({ data: { a: 1 } });
  });

  it("maps an errors body to { data: null, errors }", async () => {
    const rec = recorder();
    const body = { errors: [{ message: "Access denied" }], data: null };
    const a = admin("read-only", rec, runnerReturning(result(body), rec));
    expect(await json(await a.graphql("query { a }"))).toEqual({
      data: null,
      errors: [{ message: "Access denied" }],
    });
  });

  it("reads the error box off stderr and treats a bare object as data", async () => {
    const rec = recorder();
    const boxed = "╭──────╮\n│ {\"errors\":[{\"message\":\"boom\"}]} │\n╰──────╯";
    const a = admin("read-only", rec, runnerStderr(boxed, rec));
    expect((await json(await a.graphql("query { a }"))).errors).toEqual([{ message: "boom" }]);

    const rec2 = recorder();
    const bare = admin("read-only", rec2, runnerReturning(result({ a: 2 }), rec2));
    expect(await json(await bare.graphql("query { a }"))).toEqual({ data: { a: 2 } });
  });
});

describe("CLI session-proof loader", () => {
  const loaderWith = (res: CliRunResult | Error) => {
    const rec = recorder();
    const a =
      res instanceof Error
        ? admin("read-only", rec, runnerThrowing(res, rec))
        : admin("read-only", rec, runnerReturning(res, rec));
    return { rec, loader: createS3CliSessionLoader(a) };
  };

  it("returns null for any other shop without spawning", async () => {
    const { rec, loader } = loaderWith(result(IDENTITY_BODY));
    expect(await loader("other.myshopify.com")).toBeNull();
    expect(rec.calls).toHaveLength(0);
  });

  it("returns { expires: null } only on an exact domain + app match", async () => {
    const { loader } = loaderWith(result(IDENTITY_BODY));
    await expect(loader(S3_STORE)).resolves.toEqual({ expires: null });
  });

  it("fails closed on a domain mismatch, an app mismatch and a transport error", async () => {
    const wrongDomain = loaderWith(
      result({
        data: {
          shop: { myshopifyDomain: "attacker.myshopify.com" },
          currentAppInstallation: { app: { id: S3_APP_ID } },
        },
      }),
    );
    expect(await wrongDomain.loader(S3_STORE)).toBeNull();

    const wrongApp = loaderWith(
      result({
        data: {
          shop: { myshopifyDomain: S3_STORE },
          currentAppInstallation: { app: { id: "gid://shopify/App/999" } },
        },
      }),
    );
    expect(await wrongApp.loader(S3_STORE)).toBeNull();

    const broken = loaderWith(new Error("transport down"));
    expect(await broken.loader(S3_STORE)).toBeNull();
    expect(broken.rec.calls).toHaveLength(1);
  });

  it("probes on every invocation — no caching", async () => {
    const { rec, loader } = loaderWith(result(IDENTITY_BODY));
    expect(await loader(S3_STORE)).toEqual({ expires: null });
    expect(await loader(S3_STORE)).toEqual({ expires: null });
    expect(rec.calls).toHaveLength(2);
  });
});

describe("identity probe", () => {
  it("reports match only on the exact store + app", async () => {
    const rec = recorder();
    const a = admin("read-only", rec, runnerReturning(result(IDENTITY_BODY), rec));
    const probe = await runS3IdentityProbe(a);
    expect(probe).toEqual({
      shopDomain: S3_STORE,
      appId: S3_APP_ID,
      apiVersion: "2026-04",
      match: true,
    });
  });

  it("reports no match when the app id differs or the call fails", async () => {
    const rec = recorder();
    const a = admin("read-only", rec, runnerThrowing(new Error("down"), rec));
    const probe = await runS3IdentityProbe(a);
    expect(probe.match).toBe(false);
    expect(probe.apiVersion).toBe("2026-04");
  });
});

describe("transport log", () => {
  it("writes one JSONL line per call and never logs variables", async () => {
    const rec = recorder();
    const dir = mkdtempSync(join(tmpdir(), "s3-cli-test-"));
    const log = join(dir, "transport.jsonl");
    const a = createS3CliAdmin({
      store: S3_STORE,
      mode: "read-only",
      transportLog: log,
      run: runnerReturning(result({ data: { ok: 1 } }), rec),
    });
    await a.graphql("query Probe { shop { id } }", {
      variables: { secret: "TOP-SECRET-TOKEN-123" },
    });
    await expect(a.graphql("mutation M { f }")).rejects.toThrow();

    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      mode: "read-only",
      opType: "query",
      opName: "Probe",
      outcome: "ok",
      exitCode: 0,
    });
    expect(lines[0].rootFields).toEqual(["shop"]);
    expect(typeof lines[0].at).toBe("string");
    expect(typeof lines[0].durationMs).toBe("number");
    expect(lines[1]).toMatchObject({
      mode: "read-only",
      opType: "mutation",
      opName: "M",
      outcome: "rejected-by-policy",
      exitCode: null,
    });
    const raw = readFileSync(log, "utf8");
    expect(raw).not.toContain("TOP-SECRET-TOKEN-123");
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("variables");
  });
});

describe("evaluateS3DispatchPreflight", () => {
  const base: S3DispatchPreflightFacts = {
    databaseName: "mergeship_test_s3",
    expectedDatabaseName: "mergeship_test_s3",
    duePreparedRows: [{ id: "row1" }],
    row: {
      status: "PREPARED",
      shop: S3_STORE,
      sourceOrderId: "gid://shopify/Order/1",
      primaryOrderId: "gid://shopify/Order/2",
      approvedWireHash: "a".repeat(64),
      plannedShippingMinor: "400",
    },
    expectedRowId: "row1",
    expectedShop: S3_STORE,
    expectedSourceOrderId: "gid://shopify/Order/1",
    expectedPrimaryOrderId: "gid://shopify/Order/2",
  };
  const over = (patch: Partial<S3DispatchPreflightFacts>) => ({ ...base, ...patch });
  const overRow = (patch: Partial<NonNullable<S3DispatchPreflightFacts["row"]>>) => ({
    ...base,
    row: { ...base.row!, ...patch },
  });

  it("passes when every fact checks out", () => {
    const v = evaluateS3DispatchPreflight(base);
    expect(v.ok).toBe(true);
    expect(v.failed).toEqual([]);
  });

  it.each([
    ["wrong db", over({ databaseName: "mergeship_test_other" }), "disposableDb"],
    ["not PREPARED", overRow({ status: "QUEUED" }), "rowExists"],
    ["wrong shop", overRow({ shop: "other.myshopify.com" }), "shopIsDevStore"],
    [
      "extra due row",
      over({ duePreparedRows: [{ id: "row1" }, { id: "row2" }] }),
      "onlyDueRow",
    ],
    ["order mismatch", overRow({ sourceOrderId: "gid://shopify/Order/9" }), "ordersMatch"],
    ["missing hash", overRow({ approvedWireHash: null }), "wireApproved"],
    ["short hash", overRow({ approvedWireHash: "a".repeat(20) }), "wireApproved"],
    ["amount 401", overRow({ plannedShippingMinor: "401" }), "amountWithinLimit"],
    ["non-integer amount", overRow({ plannedShippingMinor: "40.5" }), "amountWithinLimit"],
  ])("fails exactly %s", (_label, facts, check) => {
    const v = evaluateS3DispatchPreflight(facts);
    expect(v.ok).toBe(false);
    expect(v.failed).toEqual([check]);
  });
});

describe("evaluateS3SweepScope", () => {
  const A = "gid://shopify/Order/101";
  const B = "gid://shopify/Order/102";
  const base = {
    expectedOrderIds: [A, B] as [string, string],
    workItems: [{ orderId: A }, { orderId: B }],
    operations: [] as { id: string; involvedOrderIds: string[] }[],
  };
  const over = (p: Partial<typeof base>) => ({ ...base, ...p });

  it("passes with exactly the two expected work items and no operations", () => {
    const v = evaluateS3SweepScope(base);
    expect(v.ok).toBe(true);
    expect(v.failed).toEqual([]);
  });

  it("passes with the single expected operation involving the two orders", () => {
    const v = evaluateS3SweepScope(
      over({ operations: [{ id: "op1", involvedOrderIds: [B, A] }] }),
    );
    expect(v.ok).toBe(true);
  });

  it.each([
    ["missing work item", over({ workItems: [{ orderId: A }] }), "exactlyTwoWorkItems"],
    [
      "extra work item",
      over({ workItems: [{ orderId: A }, { orderId: B }, { orderId: "gid://shopify/Order/103" }] }),
      "exactlyTwoWorkItems",
    ],
    [
      "foreign work item",
      over({ workItems: [{ orderId: A }, { orderId: "gid://shopify/Order/103" }] }),
      "exactlyTwoWorkItems",
    ],
    [
      "two operations",
      over({
        operations: [
          { id: "op1", involvedOrderIds: [A, B] },
          { id: "op2", involvedOrderIds: [A, B] },
        ],
      }),
      "atMostOneOperation",
    ],
    [
      "operation touching a foreign order",
      over({ operations: [{ id: "op1", involvedOrderIds: [A, "gid://shopify/Order/103"] }] }),
      "noForeignOperationOrders",
    ],
  ])("fails on %s", (_label, facts, check) => {
    const v = evaluateS3SweepScope(facts);
    expect(v.ok).toBe(false);
    expect(v.failed).toContain(check);
  });
});
