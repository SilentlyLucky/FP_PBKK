import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PROMPTLAB_ACCEPTANCE_BASE_URL;

if (!baseURL) {
  throw new Error("PROMPTLAB_ACCEPTANCE_BASE_URL must point to the isolated production build.");
}

export default defineConfig({
  testDir: "./apps/web/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "test-results/browser-acceptance",
  use: {
    baseURL,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
});
