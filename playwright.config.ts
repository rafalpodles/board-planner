import { defineConfig, devices } from "@playwright/test";
import { E2E_MONGODB_URI } from "./e2e/seed";

// 3987, not the usual 3456: a developer's own dev server and other agents share this machine
const PORT = Number(process.env.E2E_PORT ?? 3987);
export const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Seeding is per test (see run-conflict.spec.ts) so a retry or --repeat-each starts from the
  // same board; teardown only clears what the last run left behind.
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  // Kept next to the tests, where e2e/.gitignore covers it — the repo root does not ignore
  // Playwright's default test-results/
  outputDir: "./e2e/.artifacts",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // Turbopack compiles /login and the board on first navigation
    navigationTimeout: 90_000,
    actionTimeout: 30_000,
    // Seven columns at their 200px floor do not fit a 1280px board without horizontal scrolling
    viewport: { width: 1600, height: 1000 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    // Turbopack compiles the board on first request
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // Wins over .env.local, which points at the development database. The test asserts this
      // before it writes anything — see the guard at the top of run-conflict.spec.ts.
      MONGODB_URI: E2E_MONGODB_URI,
      NEXT_PUBLIC_APP_URL: BASE_URL,
    },
  },
});
