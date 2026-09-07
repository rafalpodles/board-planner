import { defineConfig, devices } from "@playwright/test";
import { E2E_MONGODB_URI } from "./e2e/seed";
import { GROUPS } from "./e2e/groups";

// 3987, not the usual 3456: a developer's own dev server and other agents share this machine
const PORT = Number(process.env.E2E_PORT ?? 3987);
export const BASE_URL = `http://localhost:${PORT}`;

// The PM agent's model, replaced by a local script. Its own port so the dev server's is free.
const PM_STUB_PORT = Number(process.env.PM_STUB_PORT ?? PORT + 1);
export const PM_STUB_URL = `http://localhost:${PM_STUB_PORT}`;

// The model behind AI task generation, replaced the same way.
//
// A run owns E2E_PORT through E2E_PORT+5, and every stub derives from that one number so setting
// it reserves the whole block. Giving each stub a default of its own is what makes two operators
// following the same "pick two adjacent numbers" habit collide on a port neither of them typed.
const AI_STUB_PORT = Number(process.env.AI_STUB_PORT ?? PORT + 2);
export const AI_STUB_URL = `http://localhost:${AI_STUB_PORT}`;

// No test asserts a signature: no delivery can be received here, so there is no header to read
// (see the note at the top of external-integrations.spec.ts, and BP-408). It is set because
// signatureHeaders() sends nothing at all without one — so the day a delivery can be received, the
// first run would otherwise read an unsigned one and call that the behaviour.
export const WEBHOOK_SECRET = "e2e-webhook-signing-secret";

// A webhook endpoint on this machine, in its own process. A receiver hosted inside the Playwright
// worker is reachable from the browser and not from the dev server, so a test that opened one
// would read an empty delivery log whatever the app did.
const WEBHOOK_RECEIVER_PORT = Number(process.env.WEBHOOK_RECEIVER_PORT ?? PORT + 3);
export const WEBHOOK_RECEIVER_URL = `http://127.0.0.1:${WEBHOOK_RECEIVER_PORT}`;

// MongoDB, through a proxy the suite can cut (e2e/mongo-proxy.mjs). The dev server is pointed at
// the proxy rather than at the database, so a test can take the database away and give it back
// without stopping a mongod other sessions share; seed() keeps talking to the database directly.
const MONGO_PROXY_PORT = Number(process.env.MONGO_PROXY_PORT ?? PORT + 4);
const MONGO_PROXY_CONTROL_PORT = Number(process.env.MONGO_PROXY_CONTROL_PORT ?? PORT + 5);
export const MONGO_PROXY_CONTROL_URL = `http://127.0.0.1:${MONGO_PROXY_CONTROL_PORT}`;

// An external MCP server the PM connects out to, so a spec can drive a real catalogue of tools
// rather than a fixture of one (BP-569). This widens a run's block to E2E_PORT+6; the "keep
// concurrent runs ten apart" rule already covers it.
const MCP_SERVER_STUB_PORT = Number(process.env.MCP_SERVER_STUB_PORT ?? PORT + 6);
export const MCP_SERVER_STUB_URL = `http://127.0.0.1:${MCP_SERVER_STUB_PORT}`;

/** The seeded database's URI with its host swapped for the proxy's; credentials and options ride along. */
function throughMongoProxy(uri: string): string {
  // One host, plain scheme: the proxy is a single TCP pipe, so a host list or an SRV record has
  // no meaning behind it — refused here rather than as 503s from the first test
  if (!/^mongodb:\/\/[^,/]+\/[^?]+/.test(uri)) {
    throw new Error(
      "E2E_MONGODB_URI must be a single-host mongodb:// URI naming a database; mongodb+srv and host lists cannot be proxied"
    );
  }
  const url = new URL(uri.replace(/^mongodb:\/\//, "http://"));
  url.hostname = "127.0.0.1";
  url.port = String(MONGO_PROXY_PORT);
  // Pinned to the address it was given. Against a replica set the driver would otherwise follow
  // the hello's host list straight past the proxy, and the outage test would read 200.
  url.searchParams.set("directConnection", "true");
  return url.toString().replace(/^http:\/\//, "mongodb://");
}

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
    // No viewport here. Every project below spreads `devices["Desktop Chrome"]`, whose own
    // viewport wins over anything set at this level — so a width written here is dead, and the
    // 1600x1000 that used to sit in this spot was never what ran (BP-449).
    //
    // The suite runs at Desktop Chrome's 1280x720. Measured at that width, the board's seven
    // columns come to 1496px against a 988px scrollport, so the column strip scrolls
    // horizontally. Nothing is red because Playwright scrolls to whatever it clicks — but a spec
    // that measures geometry is measuring a scrolled board, and should say so.
    //
    // Raising it would not change that: at 1600 the strip is still 1496 against 1308. Seven
    // columns first fit at about 1920, where they also grow past their 200px floor to 217. Any
    // future move to a wider board is a behavioural change to every spec, not a config tidy.
  },
  // One project per group so CI can run them as separate jobs (`--project=board`). A run with no
  // --project runs every group, which is the whole suite and what a local run wants.
  projects: Object.entries(GROUPS).map(([name, files]) => ({
    name,
    use: { ...devices["Desktop Chrome"] },
    testMatch: files.map((file) => `${__dirname}/e2e/${file}`),
  })),
  webServer: [
    {
      // First, so the dev server below never starts against a database it cannot reach
      command: `node e2e/mongo-proxy.mjs`,
      url: `${MONGO_PROXY_CONTROL_URL}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        MONGO_PROXY_PORT: String(MONGO_PROXY_PORT),
        MONGO_PROXY_CONTROL_PORT: String(MONGO_PROXY_CONTROL_PORT),
        E2E_MONGODB_URI,
      },
    },
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
      command: `node e2e/mcp-server-stub.mjs`,
      url: `${MCP_SERVER_STUB_URL}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
      env: { MCP_SERVER_STUB_PORT: String(MCP_SERVER_STUB_PORT) },
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
        // before it writes anything — see the guard at the top of run-conflict.spec.ts. Through the
        // proxy above, which is what lets mcp-tools.spec.ts take the database away mid-run.
        MONGODB_URI: throughMongoProxy(E2E_MONGODB_URI),
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
        // Effectively never. The scheduler starts with the app (src/instrumentation.ts), and a
        // spec that switches a project's daily review on leaves it on until the next seed() — so
        // at the 5-minute default a tick can land mid-run and spend a real turn against the cap
        // the turn-cap specs are counting.
        PM_SCHEDULER_TICK_MS: String(24 * 60 * 60 * 1000),
        // isAIEnabled() checks the key's presence and the form hides AI Assist without it; the
        // base URL is what keeps the SDK off api.openai.com
        OPENAI_API_KEY: "e2e-stub-key",
        OPENAI_BASE_URL: `${AI_STUB_URL}/v1`,
        WEBHOOK_SIGNING_SECRET: WEBHOOK_SECRET,
        // Turns off Next's dev indicator, which paints over the bottom-left of every page and
        // takes a real click meant for a bottom sheet's action row (BP-589). Only here: a
        // developer running `next dev` by hand keeps it.
        E2E: "1",
      },
    },
  ],
});
