import { defineConfig, devices } from "@playwright/test";
import { E2E_MONGODB_URI } from "./e2e/seed";

// 3987, not the usual 3456: a developer's own dev server and other agents share this machine
const PORT = Number(process.env.E2E_PORT ?? 3987);
export const BASE_URL = `http://localhost:${PORT}`;

// The PM agent's model, replaced by a local script. Its own port so the dev server's is free.
const PM_STUB_PORT = Number(process.env.PM_STUB_PORT ?? 3988);
const PM_STUB_URL = `http://localhost:${PM_STUB_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Seeding is per test (see run-conflict.spec.ts) so a retry or --repeat-each starts from the
  // same board; teardown only clears what the last run left behind.
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  // Only for transport-level flakiness on a shared runner — a connection reset mid-request has
  // nothing to say about the code. Assertions stay strict, so a real failure still fails twice.
  retries: process.env.CI ? 1 : 0,
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
  webServer: [
    {
      // Stands in for OpenRouter so a PM turn runs for free and offline; everything the app does
      // with the answer is the production path
      command: `node e2e/openrouter-stub.mjs`,
      url: `${PM_STUB_URL}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
      env: { PM_STUB_PORT: String(PM_STUB_PORT) },
    },
    {
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
        // /api/mcp answers 500 without it and will not take NEXT_PUBLIC_APP_URL, which is a
        // build-time literal. Setting it here is not a test convenience: this run is what proved
        // a real deployment needs it too, by 500ing three MCP specs when it was missing (BP-316).
        PUBLIC_ORIGIN: BASE_URL,
        // The premise the session and throttle specs are written against, pinned rather than
        // assumed: at 0 the app ignores X-Forwarded-For, so callers have no address and share the
        // anonymous throttle bucket. A machine that happened to export this variable would
        // otherwise move those tests onto the per-address counter (BP-395).
        TRUSTED_PROXY_HOPS: "0",
        // Presence alone is what isPmAvailable checks; the stub never looks at it
        OPENROUTER_API_KEY: "e2e-stub-key",
        OPENROUTER_BASE_URL: `${PM_STUB_URL}/v1`,
      },
    },
  ],
});
