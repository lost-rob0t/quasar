import { defineConfig, devices } from "@playwright/test";

const host = "127.0.0.1";
const port = 4173;
const webServerCommand = process.env.CI
  ? `npm run preview -- --host ${host} --port ${port}`
  : `npm run dev -- --host ${host} --port ${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://${host}:${port}`,
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: {
    command: webServerCommand,
    env: { VITE_BASE_PATH: "/" },
    url: `http://${host}:${port}/`,
    reuseExistingServer: !process.env.CI
  }
});
