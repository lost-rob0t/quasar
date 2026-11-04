import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "journey.spec.ts",
  workers: 1,
  timeout: 60000,
  outputDir: "../../../../artifacts/actor-workflow-browser",
  use: {
    baseURL: "http://127.0.0.1:5190",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.QUASAR_CHROMIUM_PATH
      ? { executablePath: process.env.QUASAR_CHROMIUM_PATH }
      : {}
  },
  webServer: {
    command: "npx vite --config tests/browser/actor-workflow/vite.config.ts",
    url: "http://127.0.0.1:5190/tests/browser/actor-workflow/",
    reuseExistingServer: false
  }
});
