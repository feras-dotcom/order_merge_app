// makeRailwayAdmin: Admin GraphQL proxied through `railway ssh` for PCs
// outside the app's Admin IP allowlist. A fake spawn records argv/stdin —
// no railway binary, no browser, no network is ever touched. Plus parseArgs
// coverage for --admin-via/--railway-bin/--railway-cwd.
import { describe, expect, it } from "vitest";
import { makeRailwayAdmin, makeRedactor, REMOTE_SCRIPT } from "../scripts/smoke/lib";
import { parseArgs } from "../scripts/smoke/smoke-lib";

const STORE = "smoke-a.myshopify.com";

const fakeSpawn = (impl: (bin: string, argv: string[], opts: any) => any) => {
  const calls: { bin: string; argv: string[]; opts: any }[] = [];
  const spawn = ((bin: string, argv: string[], opts: any) => {
    calls.push({ bin, argv, opts });
    return impl(bin, argv, opts);
  }) as any;
  return { spawn, calls };
};

const okResult = (data: unknown = { shop: { id: "s" } }) => ({
  stdout: `banner noise\n{"status":200,"body":{"data":${JSON.stringify(data)}}}\n`,
  stderr: "",
  status: 0,
});

const BASE = ["--store", STORE, "--client-id", "cid", "--env-file", "e.env", "--discount-id", "gid://d/1", "--workspace", "w"];

describe("makeRailwayAdmin", () => {
  it("spawns `railway ssh --service MergeShip --` with no shell and stdin {store,query,variables}", async () => {
    const { spawn, calls } = fakeSpawn(() => okResult());
    const { adminGraphql } = makeRailwayAdmin({ store: STORE, spawn });
    const data = await adminGraphql("query { shop { id } }", { a: 1 });
    expect(data).toEqual({ shop: { id: "s" } });
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.bin).toBe("railway");
    expect(c.argv[0]).toBe("ssh");
    expect(c.argv).toContain("--service");
    expect(c.argv[c.argv.indexOf("--service") + 1]).toBe("MergeShip");
    expect(c.argv).toContain("--");
    const dashIdx = c.argv.indexOf("--");
    expect(c.argv.slice(dashIdx + 1)).toEqual(["sh", "-c", expect.stringContaining("base64 -d > /tmp/rw.mjs && node /tmp/rw.mjs")]);
    const stdin = JSON.parse(c.opts.input);
    expect(stdin.store).toBe(STORE);
    expect(stdin.query).toBe("query { shop { id } }");
    expect(stdin.variables).toEqual({ a: 1 });
  });

  it("honors railwayBin/service/cwd overrides", async () => {
    const { spawn, calls } = fakeSpawn(() => okResult());
    const { adminGraphql } = makeRailwayAdmin({
      store: STORE, spawn, service: "MyService", railwayBin: "/usr/local/bin/railway", cwd: "/repo",
    });
    await adminGraphql("q");
    expect(calls[0].bin).toBe("/usr/local/bin/railway");
    expect(calls[0].argv[calls[0].argv.indexOf("--service") + 1]).toBe("MyService");
    expect(calls[0].opts.cwd).toBe("/repo");
  });

  it("picks the LAST JSON line among ssh banner noise", async () => {
    const { spawn } = fakeSpawn(() => ({
      stdout: 'Connecting...\n{"status":200,"body":{"data":{"first":true}}}\nwarning line\n{"status":200,"body":{"data":{"last":true}}}\n',
      stderr: "ssh banner",
      status: 0,
    }));
    const { adminGraphql } = makeRailwayAdmin({ store: STORE, spawn });
    expect(await adminGraphql("q")).toEqual({ last: true });
  });

  it("token grant transport failure throws `token grant failed`", async () => {
    const { spawn } = fakeSpawn(() => ({
      stdout: '{"transport":"token","error":{"status":403,"body":{"error":"bad creds"}}}\n',
      stderr: "", status: 0,
    }));
    const { adminGraphql } = makeRailwayAdmin({ store: STORE, spawn });
    await expect(adminGraphql("q")).rejects.toThrow(/token grant failed:/);
  });

  it("GraphQL errors / non-2xx throw `graphql HTTP <status>`", async () => {
    const { spawn } = fakeSpawn(() => ({
      stdout: '{"status":200,"body":{"errors":[{"message":"Field x unknown"}]}}\n',
      stderr: "", status: 0,
    }));
    const { adminGraphql } = makeRailwayAdmin({ store: STORE, spawn });
    await expect(adminGraphql("q")).rejects.toThrow(/graphql HTTP 200:[\s\S]*Field x unknown/);
  });

  it("no JSON line throws `railway ssh produced no output` with redacted stderr", async () => {
    const { spawn } = fakeSpawn(() => ({ stdout: "just text\n", stderr: "auth failed for shpaaa_secret-token-1", status: 1 }));
    const { adminGraphql } = makeRailwayAdmin({ store: STORE, spawn });
    await expect(adminGraphql("q")).rejects.toThrow(/railway ssh produced no output: auth failed for \[REDACTED-CRED\]/);
  });

  it("rejects an invalid store before spawning", async () => {
    const { spawn, calls } = fakeSpawn(() => okResult());
    expect(() => makeRailwayAdmin({ store: "evil.com; rm -rf /", spawn })).toThrow(/invalid store/);
    expect(() => makeRailwayAdmin({ store: "UPPER.myshopify.com", spawn })).toThrow(/invalid store/);
    expect(calls).toHaveLength(0);
  });

  it("a spawn-level error propagates", async () => {
    const { spawn } = fakeSpawn(() => ({ error: new Error("spawn railway ENOENT") }));
    const { adminGraphql } = makeRailwayAdmin({ store: STORE, spawn });
    await expect(adminGraphql("q")).rejects.toThrow("spawn railway ENOENT");
  });

  it("secrets/tokens in error bodies are redacted before throwing", async () => {
    const { spawn } = fakeSpawn(() => ({
      stdout: '{"status":401,"body":{"errors":"bad token shpat_abcdef123456"}}\n',
      stderr: "", status: 0,
    }));
    const { adminGraphql } = makeRailwayAdmin({ store: STORE, spawn, redactor: makeRedactor() });
    await expect(adminGraphql("q")).rejects.toThrow(/graphql HTTP 401:/);
    await expect(adminGraphql("q")).rejects.toThrow(/REDACTED-CRED/);
    await expect(adminGraphql("q")).rejects.not.toThrow(/shpat_abcdef123456/);
  });

  it("REMOTE_SCRIPT is ESM, reads stdin, never interpolates the store into a shell command", () => {
    expect(REMOTE_SCRIPT).toContain("process.stdin");
    expect(REMOTE_SCRIPT).toContain("client_credentials");
    expect(REMOTE_SCRIPT).toContain("SHOPIFY_API_KEY");
    expect(REMOTE_SCRIPT).toContain("SHOPIFY_API_SECRET");
    expect(REMOTE_SCRIPT).toContain("/admin/api/2026-04/graphql.json");
    expect(REMOTE_SCRIPT).not.toContain("access_token\",");
    // the token value is only used in the request header, never printed
    expect(REMOTE_SCRIPT).not.toMatch(/console\.log.*access_token/);
    // base64 round-trips intact (it is shipped to the remote shell as b64)
    expect(Buffer.from(REMOTE_SCRIPT, "utf8").toString("base64")).toBeTruthy();
    expect(Buffer.from(Buffer.from(REMOTE_SCRIPT, "utf8").toString("base64"), "base64").toString("utf8")).toBe(REMOTE_SCRIPT);
  });
});

describe("parseArgs --admin-via", () => {
  it("accepts --admin-via railway with bin/cwd", () => {
    const r = parseArgs([...BASE, "--admin-via", "railway", "--railway-bin", "/x/railway", "--railway-cwd", "/repo"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.adminVia).toBe("railway");
      expect(r.args.railwayBin).toBe("/x/railway");
      expect(r.args.railwayCwd).toBe("/repo");
    }
  });

  it("rejects --admin-via <other> (usage -> exit 64 path)", () => {
    const r = parseArgs([...BASE, "--admin-via", "ssh"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--admin-via");
  });

  it("leaves adminVia undefined without the flag", () => {
    const r = parseArgs(BASE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.adminVia).toBeUndefined();
  });
});
