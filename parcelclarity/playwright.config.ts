import { defineConfig, devices } from "@playwright/test";

// End-to-end tests drive the production build against the local Supabase-compatible stack
// (npm run stack:up). Set PC_CHROMIUM_PATH to use a pre-installed Chromium.
const executablePath = process.env.PC_CHROMIUM_PATH || undefined;
const { defaultBrowserType: _ignored, ...iPhone } = devices["iPhone 14"];

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    launchOptions: { executablePath },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testMatch: /(flows|a11y|confirm|pricing|modeling|fees)\.spec\.ts/ },
    // iPhone 14 viewport, touch and user agent on Chromium. Real iOS Safari still needs a device check.
    { name: "iphone", use: { ...iPhone }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: "npm run build && npm run start -- -p 3000",
    url: "http://localhost:3000/login",
    reuseExistingServer: true,
    timeout: 240_000,
  },
});
