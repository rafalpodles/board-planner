import { defineConfig, devices } from "@playwright/test";
import { BOOTSTRAP_TOKEN, E2E_ENCRYPTION_KEY, E2E_MONGODB_URI } from "./e2e/seed";
import { GROUPS } from "./e2e/groups";

// 3987, not the usual 3456: a developer's own dev server and other agents share this machine
const PORT = Number(process.env.E2E_PORT ?? 3987);
export const BASE_URL = `http://localhost:${PORT}`;

// The PM agent's model, replaced by a local script. Its own port so the dev server's is free.
const PM_STUB_PORT = Number(process.env.PM_STUB_PORT ?? PORT + 1);
export const PM_STUB_URL = `http://localhost:${PM_STUB_PORT}`;

// The model behind AI task generation, replaced the same way.
//
// A run owns E2E_PORT through E2E_PORT+9, and every stub derives from that one number so setting
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

// A mail server on this machine, in its own process for the same reason as the webhook receiver:
// the notification mail is handed over after the request that caused it has already answered. Two
// ports — SMTP for nodemailer, HTTP for the spec that reads what arrived. They end a run's block
// at E2E_PORT+8, and the GitHub stub below takes +9 — so a run now uses the whole block the
// `30000 + N * 10` spacing allows, with nothing spare. Ten apart is still correct and is now exact.
const SMTP_STUB_PORT = Number(process.env.SMTP_STUB_PORT ?? PORT + 7);
const SMTP_STUB_CONTROL_PORT = Number(process.env.SMTP_STUB_CONTROL_PORT ?? PORT + 8);
export const SMTP_STUB_CONTROL_URL = `http://127.0.0.1:${SMTP_STUB_CONTROL_PORT}`;
// What the app is told its mail server is. Exported so a spec can assert the configured branch of
// the mail screen against it, rather than reading an env var the runner process does not have —
// these are set on the dev server below, not on this one. The dev server's environment is built
// from this object rather than from literals beside it, so a spec asserting "Server 127.0.0.1:3994"
// cannot go on passing against a server told something else.
export const SMTP_STUB_HOST = "127.0.0.1";
export const MAIL_SERVER = {
  host: SMTP_STUB_HOST,
  port: SMTP_STUB_PORT,
  user: "e2e",
  from: "Board Planner <noreply@board-planner.test>",
};

// GitHub's REST API, replaced the same way the two model stubs are, so a pull-request sync runs
// end to end for the first time (BP-443). One port: the spec steers it through the same one it
// serves on, since nothing here is fire-and-forget — the sync answers when it is done.
const GITHUB_STUB_PORT = Number(process.env.GITHUB_STUB_PORT ?? PORT + 9);
export const GITHUB_STUB_URL = `http://127.0.0.1:${GITHUB_STUB_PORT}`;

// MongoDB, through a proxy the suite can cut (e2e/mongo-proxy.mjs). The dev server is pointed at
// the proxy rather than at the database, so a test can take the database away and give it back
// without stopping a mongod other sessions share; seed() keeps talking to the database directly.
const MONGO_PROXY_PORT = Number(process.env.MONGO_PROXY_PORT ?? PORT + 4);
const MONGO_PROXY_CONTROL_PORT = Number(process.env.MONGO_PROXY_CONTROL_PORT ?? PORT + 5);
export const MONGO_PROXY_CONTROL_URL = `http://127.0.0.1:${MONGO_PROXY_CONTROL_PORT}`;

// An external MCP server the PM connects out to, so a spec can drive a real catalogue of tools
// rather than a fixture of one (BP-569).
const MCP_SERVER_STUB_PORT = Number(process.env.MCP_SERVER_STUB_PORT ?? PORT + 6);
export const MCP_SERVER_STUB_URL = `http://127.0.0.1:${MCP_SERVER_STUB_PORT}`;

// A second full app server, `TRUSTED_PROXY_HOPS` nonzero instead of pinned at 0, so
// proxied-login-throttle.spec.ts can exercise the branch the suite-wide pin otherwise makes
// unreachable (BP-409) without weakening that pin for anything else. The `PORT + 0..9` block above
// is full (see the note at PORT+7), so this deliberately does not live in it — +10000 puts it far
// outside any neighbouring task's own `30000 + N * 10` block instead of trying to fit one more
// port into an already-exact spacing. `E2E_PROXIED_PORT` overrides it if that were ever to collide.
const PROXIED_PORT = Number(process.env.E2E_PROXIED_PORT ?? PORT + 10000);
export const PROXIED_BASE_URL = `http://localhost:${PROXIED_PORT}`;
// Opt-in rather than on for every run: a second Turbopack cold start is real minutes, paid only by
// the job that needs it. CI sets this for the `people` job; running the spec file alone without it
// is what the file's own test.skip() at the top is for.
export const RUN_PROXIED_SERVER = process.env.E2E_PROXIED_SERVER === "1";

// A stand-in for the Coda API. `codaHost` is a per-project settings field, not a global env var
// like GITHUB_API_BASE_URL, so this needs no on/off switch of its own — a spec that never types
// this URL into a project's Host field never reaches it. Out-of-band for the same reason the
// proxied server above is: the `PORT + 0..9` block is exactly full (see the note at PORT+7).
const CODA_STUB_PORT = Number(process.env.CODA_STUB_PORT ?? PORT + 10001);
export const CODA_STUB_URL = `http://127.0.0.1:${CODA_STUB_PORT}`;

// GitLab's API, the same way: `gitlabHost` is per-project, so only a project pointed here reaches it.
const GITLAB_STUB_PORT = Number(process.env.GITLAB_STUB_PORT ?? PORT + 10002);
export const GITLAB_STUB_URL = `http://127.0.0.1:${GITLAB_STUB_PORT}`;

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

/** Everything the app server needs, parameterised only by the origin it is told it runs at. */
function devServerEnv(origin: string) {
  return {
    // Wins over .env.local, which points at the development database. The test asserts this
    // before it writes anything — see the guard at the top of run-conflict.spec.ts. Through the
    // proxy above, which is what lets mcp-tools.spec.ts take the database away mid-run.
    MONGODB_URI: throughMongoProxy(E2E_MONGODB_URI),
    NEXT_PUBLIC_APP_URL: origin,
    // /api/mcp answers 500 without it and will not take NEXT_PUBLIC_APP_URL, which is a
    // build-time literal. Setting it here is not a test convenience: this run is what proved
    // a real deployment needs it too, by 500ing three MCP specs when it was missing (BP-316).
    PUBLIC_ORIGIN: origin,
    // The premise the session and throttle specs are written against, pinned rather than
    // assumed: at 0 the app ignores X-Forwarded-For, so callers have no address and share the
    // anonymous throttle bucket. A machine that happened to export this variable would
    // otherwise move those tests onto the per-address counter (BP-395). The proxied server below
    // overrides this one line — see BP-409 — and touches nothing else here.
    TRUSTED_PROXY_HOPS: "0",
    // Known to day-zero.spec.ts, which claims an empty instance the way an operator does (BP-325)
    BOOTSTRAP_TOKEN,
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
    // The stub above. Without it the sync reaches the real api.github.com, which is why no
    // spec drove one before BP-443.
    GITHUB_API_BASE_URL: GITHUB_STUB_URL,
    // Off, so a tick cannot re-sync a project mid-spec and overwrite what the spec set up.
    // The specs drive the sync themselves, which is the half a person can see.
    GITHUB_SYNC_TICK_MS: "0",
    // The mail server above. `isEmailConfigured()` wants all three, and without them the whole
    // e-mail column of the notification grid is unreachable from a browser (BP-465).
    SMTP_HOST: MAIL_SERVER.host,
    SMTP_PORT: String(MAIL_SERVER.port),
    SMTP_USER: MAIL_SERVER.user,
    SMTP_PASS: "e2e",
    SMTP_FROM: MAIL_SERVER.from,
    // Effectively never, for the reason PM_SCHEDULER_TICK_MS is. The digest scheduler starts
    // with the app whenever mail is configured, which it has been for every run since BP-465,
    // and at the 5-minute default it has been ticking all run long ever since — reaching the
    // query on any run after 07:00 Europe/Warsaw, and stopping at `dueDigestDay` before it —
    // unnoticed, because the message it sends carries each row's own title ("TP-7 assigned to
    // you") and not the task title every mail assertion in the suite matches on. Measured at a
    // 3-second tick: `notification-grid-delivery.spec.ts` stays green.
    //
    // `daily-digest.spec.ts` is the file that cannot live with it, and that too is measured:
    // at a 3-second tick both its tests fail, because a background tick claims the day in
    // `lastDigestDay` before the spec asks for one and the trigger then answers "sent 0".
    // Pinned rather than worked around, so the suite has one digest and the spec asked for it.
    DIGEST_TICK_MS: String(24 * 60 * 60 * 1000),
    // Midnight, so a tick that is asked for is due whatever hour CI runs at. The default is
    // 07:00 Europe/Warsaw and `dueDigestDay` answers null before it, which would make the
    // digest spec pass or fail by the clock on the wall.
    DIGEST_HOUR: "0",
    // For the stub's throwaway certificate, and for nothing else: `email.ts` sets `requireTLS`
    // on every port but 465, so the stub has to offer STARTTLS and this run has to accept a
    // certificate no authority signed.
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    // Storing a project's chat webhook URL needs it (BP-372), and so does the personal one the
    // notification grid offers. Without it those routes answer 503 and the specs that drive
    // them assert a refusal instead of the encryption they exist to prove.
    ENCRYPTION_KEY: E2E_ENCRYPTION_KEY,
    // Two things now, and the second is not cosmetic. It turns off Next's dev indicator, which
    // paints over the bottom-left of every page and takes a real click meant for a bottom
    // sheet's action row (BP-589) — and it mounts `POST /api/e2e/digest`, which runs a digest
    // tick with nothing authenticating it (`src/lib/e2e-only.ts`, BP-605). So this is not a
    // variable to set on a deployment to quieten the indicator: outside a production build it
    // opens that route too. Only here; a developer running `next dev` by hand keeps both.
    E2E: "1",
  };
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
  // `stub-crash-reporter` fails a run whose stubs reported a crash; on its own, `list` would
  // leave the line in the log for whoever scrolls back (BP-581)
  reporter: [["list"], ["./e2e/stub-crash-reporter.ts"]],
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
      command: `node e2e/smtp-stub.mjs`,
      url: `${SMTP_STUB_CONTROL_URL}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        SMTP_STUB_PORT: String(SMTP_STUB_PORT),
        SMTP_STUB_CONTROL_PORT: String(SMTP_STUB_CONTROL_PORT),
      },
    },
    {
      command: `node e2e/github-stub.mjs`,
      url: `${GITHUB_STUB_URL}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
      env: { GITHUB_STUB_PORT: String(GITHUB_STUB_PORT) },
    },
    {
      command: `node e2e/coda-stub.mjs`,
      url: `${CODA_STUB_URL}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
      env: { CODA_STUB_PORT: String(CODA_STUB_PORT) },
    },
    {
      command: `node e2e/gitlab-stub.mjs`,
      url: `${GITLAB_STUB_URL}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
      env: { GITLAB_STUB_PORT: String(GITLAB_STUB_PORT) },
    },
    {
      command: `npm run dev -- --port ${PORT}`,
      url: BASE_URL,
      reuseExistingServer: false,
      // Turbopack compiles the board on first request
      timeout: 240_000,
      stdout: "pipe",
      stderr: "pipe",
      env: devServerEnv(BASE_URL),
    },
    // Opt-in (RUN_PROXIED_SERVER): see the constant above. Same app, same seeded database, only
    // TRUSTED_PROXY_HOPS, its own origin and its own `.next` output differ — a second `next dev`
    // sharing the first one's build directory corrupts both (BP-409).
    ...(RUN_PROXIED_SERVER
      ? [
          {
            command: `npm run dev -- --port ${PROXIED_PORT}`,
            url: PROXIED_BASE_URL,
            reuseExistingServer: false,
            timeout: 240_000,
            stdout: "pipe" as const,
            stderr: "pipe" as const,
            env: {
              ...devServerEnv(PROXIED_BASE_URL),
              TRUSTED_PROXY_HOPS: "1",
              NEXT_DIST_DIR: ".next-proxied",
            },
          },
        ]
      : []),
  ],
});
