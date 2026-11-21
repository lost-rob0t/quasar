import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 30000,
  outputDir: "../../../test-results/flow-editor",
  use: {
    baseURL: "http://127.0.0.1:5197",
    headless: true,
    launchOptions: {
      executablePath: process.env.QUASAR_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium"
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: "npx vite --config tests/browser/flow-editor/vite.config.ts",
    url: "http://127.0.0.1:5197",
    reuseExistingServer: false
  }
});
