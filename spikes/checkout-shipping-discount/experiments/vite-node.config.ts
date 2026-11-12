// fs.allow for vite-node so experiment scripts under spikes/ can load —
// the repo vite.config.ts allowlist only covers app/scripts/tests.
import { defineConfig } from "vite";
export default defineConfig({
  server: { fs: { allow: ["spikes", "app", "scripts", "tests", "node_modules"] } },
});
