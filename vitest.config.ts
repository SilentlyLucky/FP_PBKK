import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "evals/**/*.test.ts",
      "tools/**/*.test.mts",
    ],
    exclude: ["backups/**", "**/node_modules/**", "**/.next/**", "**/e2e/**"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
