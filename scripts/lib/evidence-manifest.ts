// Evidence manifest helpers for docs/evidence/** archives (design §17).
// Pure functions over a directory: the manifest covers every intended file,
// is generated only after all artifacts are finalized, and verification
// detects stale or tampered files.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST_NAME = "MANIFEST.sha256";

export function sha256FileHex(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

/**
 * Build manifest lines ("<sha256>  <name>") over `files` — the caller passes
 * the exact intended file list (never derived from a prior manifest).
 */
export function buildManifestLines(dir: string, files: readonly string[]): string[] {
  return [...files].sort().map((f) => `${sha256FileHex(join(dir, f))}  ${f}`);
}

/**
 * Verify a directory against its MANIFEST.sha256: every listed file must
 * hash-match, and every file present (except the manifest itself) must be
 * listed — a stale or unlisted artifact fails verification.
 */
export function verifyManifest(dir: string): { ok: true } | { ok: false; reason: string } {
  const manifestPath = join(dir, MANIFEST_NAME);
  let lines: string[];
  try {
    lines = readFileSync(manifestPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return { ok: false, reason: "MANIFEST.sha256 missing or unreadable" };
  }
  const listed = new Map<string, string>();
  for (const line of lines) {
    const m = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (!m) return { ok: false, reason: `malformed manifest line: ${line.slice(0, 80)}` };
    if (listed.has(m[2])) return { ok: false, reason: `duplicate manifest entry: ${m[2]}` };
    listed.set(m[2], m[1]);
  }
  for (const [file, hash] of listed) {
    let actual: string;
    try {
      actual = sha256FileHex(join(dir, file));
    } catch {
      return { ok: false, reason: `listed file missing: ${file}` };
    }
    if (actual !== hash) return { ok: false, reason: `hash mismatch: ${file}` };
  }
  const onDisk = readdirSync(dir).filter((f) => f !== MANIFEST_NAME);
  for (const f of onDisk) {
    if (!listed.has(f)) return { ok: false, reason: `unlisted file present: ${f}` };
  }
  return { ok: true };
}
