import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "pro-integration.spec.ts",
  use: {
    baseURL: "http://127.0.0.1:5173",
    launchOptions: { executablePath: process.env.QUASAR_CHROMIUM_EXECUTABLE_PATH }
  },
  webServer: {
    command: "npx vite --host 127.0.0.1",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI
  }
});
