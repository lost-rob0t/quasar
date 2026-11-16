import { defineConfig, devices } from "@playwright/test";

const host = "127.0.0.1";
const port = Number(process.env.QUASAR_VITE_PORT || 5173);
const httpPort = Number(process.env.QUASAR_HTTP_PORT || 8080);
const wsPort = Number(process.env.QUASAR_WS_PORT || 8081);
const webServerCommand = "node ../scripts/dev.mjs";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  // The Forgejo runner box is heavily CPU-throttled (~10x slower than GitHub
  // runners): page loads under parallel chromium can exceed the 30s default
  // even for teardown. These ceilings only matter under contention; fast
  // runners finish far sooner and genuine hangs still fail.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: `http://${host}:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: {
    command: webServerCommand,
    env: { VITE_BASE_PATH: "/", VITE_CONTROL_PLANE_URL: `ws://${host}:${wsPort}` },
    // CLOG starts after the WebSocket listener, so this readiness probe means
    // both the React server and the durable control plane are available.
    url: `http://${host}:${httpPort}/`,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    reuseExistingServer: !process.env.CI
  }
});
