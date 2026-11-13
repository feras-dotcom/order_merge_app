// cookie-names.ts — prints ONLY cookie names/domains/flags (never values) for the CDP Chrome on PORT.
import { createRequire } from "node:module";
import { join } from "node:path";
import { appDir } from "./lib";

async function main() {
  const port = process.env.PORT ?? "9223";
  const req = createRequire(join(appDir, "..", "..", "noop.cjs"));
  const { chromium } = req("playwright-core") as { chromium: { connectOverCDP(u: string): Promise<any> } };
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const ctx = b.contexts()[0];
  const cs = (await ctx.cookies()) as { name: string; domain: string; httpOnly: boolean; expires: number }[];
  console.log(JSON.stringify(cs.map((c) => ({ n: c.name, d: c.domain, h: c.httpOnly, session: c.expires === -1 })), null, 0));
  console.log("pages:", ctx.pages().map((p: { url(): string }) => p.url().replace(/\?.*$/, "").replace(/checkouts\/.*/, "checkouts/[TOKEN]")));
  await b.close();
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
