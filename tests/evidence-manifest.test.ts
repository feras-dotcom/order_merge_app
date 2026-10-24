// Deterministic tests for the evidence-manifest helpers used by
// scripts/shipping-refund-readback.ts (design §17): a manifest must cover the
// exact intended file list (including README/register), reproduce identical
// hashes on regeneration, and fail verification on stale/missing/extra files.
import { mkdtempSync, rmSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MANIFEST_NAME, buildManifestLines, sha256FileHex, verifyManifest,
} from "../scripts/lib/evidence-manifest";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "evid-manifest-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const seed = () => {
  writeFileSync(join(dir, "run-1.json"), JSON.stringify({ a: 1 }));
  writeFileSync(join(dir, "run-2.json"), JSON.stringify({ b: "x" }));
  writeFileSync(join(dir, "validation-register.json"), JSON.stringify({ records: [] }));
  writeFileSync(join(dir, "README.md"), "# evidence\n");
  const files = ["run-1.json", "run-2.json", "validation-register.json", "README.md"];
  writeFileSync(join(dir, MANIFEST_NAME), buildManifestLines(dir, files).join("\n") + "\n");
};

describe("evidence manifest", () => {
  it("produces correct sha256 entries for every intended file including README and register", () => {
    seed();
    const lines = readFileSync(join(dir, MANIFEST_NAME), "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
    for (const f of ["run-1.json", "run-2.json", "validation-register.json", "README.md"]) {
      expect(lines).toContain(`${sha256FileHex(join(dir, f))}  ${f}`);
    }
  });

  it("verifies a freshly generated manifest", () => {
    seed();
    expect(verifyManifest(dir)).toEqual({ ok: true });
  });

  it("regenerating over the same finalized artifacts yields identical hashes", () => {
    seed();
    const first = readFileSync(join(dir, MANIFEST_NAME), "utf8");
    const files = ["run-1.json", "run-2.json", "validation-register.json", "README.md"];
    writeFileSync(join(dir, MANIFEST_NAME), buildManifestLines(dir, files).join("\n") + "\n");
    expect(readFileSync(join(dir, MANIFEST_NAME), "utf8")).toBe(first);
    expect(verifyManifest(dir)).toEqual({ ok: true });
  });

  it("detects a stale artifact not covered by the manifest", () => {
    seed();
    writeFileSync(join(dir, "stale.json"), "{}");
    const r = verifyManifest(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("stale.json");
  });

  it("detects a tampered artifact and a missing listed file", () => {
    seed();
    writeFileSync(join(dir, "run-1.json"), JSON.stringify({ a: 2 }));
    expect(verifyManifest(dir).ok).toBe(false);
    seed(); // restore
    renameSync(join(dir, "run-2.json"), join(dir, "run-2.json.bak"));
    const r = verifyManifest(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("run-2.json");
  });
});

describe("committed shipping-v0 archive", () => {
  it("MANIFEST.sha256 verifies the committed evidence directory", () => {
    expect(verifyManifest(join(__dirname, "../docs/evidence/shipping-v0"))).toEqual({ ok: true });
  });
});
