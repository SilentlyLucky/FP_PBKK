import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    settings: {
      next: { rootDir: "apps/web/" },
      react: { version: "19.3" },
    },
  },
  globalIgnores([
    ".local/**",
    "**/.next/**",
    "**/node_modules/**",
    "**/coverage/**",
    "packages/providers/src/codex/protocol/generated/**",
    "UI_UX_Reference_Pack/**",
    "*.jpg",
    "*.webp",
    "*.png",
  ]),
]);
