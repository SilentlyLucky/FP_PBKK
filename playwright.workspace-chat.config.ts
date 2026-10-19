import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  testMatch: "workspace-chat-local-folders.spec.ts",
  fullyParallel: true,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:31247",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command:
      "node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 31247",
    cwd: "apps/web",
    url: "http://127.0.0.1:31247/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: "",
      PROMPTLAB_DATABASE_URL: "",
      PROMPTLAB_TEST_MODE: "true",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
