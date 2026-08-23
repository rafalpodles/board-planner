import { defineConfig, devices } from "@playwright/test";
import { E2E_MONGODB_URI } from "./e2e/seed";

// 3987, not the usual 3456: a developer's own dev server and other agents share this machine
const PORT = Number(process.env.E2E_PORT ?? 3987);
export const BASE_URL = `http://localhost:${PORT}`;

// The PM agent's model, replaced by a local script. Its own port so the dev server's is free.
const PM_STUB_PORT = Number(process.env.PM_STUB_PORT ?? 3988);
const PM_STUB_URL = `http://localhost:${PM_STUB_PORT}`;

// The model behind AI task generation, replaced the same way. Derived from the PM stub's port
// rather than given a default of its own, so isolating a run — machines here are shared — stays
// two environment variables rather than three.
const AI_STUB_PORT = Number(process.env.AI_STUB_PORT ?? PM_STUB_PORT + 1);
export const AI_STUB_URL = `http://localhost:${AI_STUB_PORT}`;

// A secret is set for the same reason PUBLIC_ORIGIN is: signatureHeaders() sends nothing at all
// without one, so a run that never set it would assert the absence of a header and call it a pass.
export const WEBHOOK_SECRET = "e2e-webhook-signing-secret";

// A webhook endpoint on this machine, in its own process. A receiver hosted inside the Playwright
// worker is reachable from the browser and not from the dev server, so a test that opened one
// would read an empty delivery log whatever the app did.
const WEBHOOK_RECEIVER_PORT = Number(process.env.WEBHOOK_RECEIVER_PORT ?? AI_STUB_PORT + 1);
export const WEBHOOK_RECEIVER_URL = `http://127.0.0.1:${WEBHOOK_RECEIVER_PORT}`;

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
      // Stands in for OpenAI, so a generated task is produced by the production client, route and
      // form rather than by a fixture
      command: `node e2e/openai-stub.mjs`,
      url: `${AI_STUB_URL}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
      env: { AI_STUB_PORT: String(AI_STUB_PORT) },
    },
    {
      command: `node e2e/webhook-receiver.mjs`,
      url: `${WEBHOOK_RECEIVER_URL}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
      env: { WEBHOOK_RECEIVER_PORT: String(WEBHOOK_RECEIVER_PORT) },
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
        // Presence alone is what isPmAvailable checks; the stub never looks at it
        OPENROUTER_API_KEY: "e2e-stub-key",
        OPENROUTER_BASE_URL: `${PM_STUB_URL}/v1`,
        // isAIEnabled() checks the key's presence and the form hides AI Assist without it; the
        // base URL is what keeps the SDK off api.openai.com
        OPENAI_API_KEY: "e2e-stub-key",
        OPENAI_BASE_URL: `${AI_STUB_URL}/v1`,
        WEBHOOK_SIGNING_SECRET: WEBHOOK_SECRET,
      },
    },
  ],
});
