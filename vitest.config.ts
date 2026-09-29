import { defineConfig } from "vitest/config";

// Separate from vite.config.ts: the Remix Vite plugin must not load in tests.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
