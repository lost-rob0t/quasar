import { defineConfig, devices } from "@playwright/test";

const host = "127.0.0.1";
const port = 5173;
const webServerCommand = "node ../scripts/dev.mjs";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [
        ["github"],
        ["html", { outputFolder: "playwright-report", open: "never" }],
      ]
    : "list",
  use: {
    baseURL: `http://${host}:${port}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: webServerCommand,
    env: { VITE_BASE_PATH: "/" },
    // CLOG starts after the WebSocket listener, so this readiness probe means
    // both the React server and the durable control plane are available.
    url: `http://${host}:8080/`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    reuseExistingServer: !process.env.CI,
  },
});
