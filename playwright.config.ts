import { defineConfig, devices } from "@playwright/test";
import { E2E_MONGODB_URI } from "./e2e/seed";
import { GROUPS } from "./e2e/groups";

const PORT = Number(process.env.E2E_PORT ?? 3987);
export const BASE_URL = `http://localhost:${PORT}`;

const PM_STUB_PORT = Number(process.env.PM_STUB_PORT ?? PORT + 1);
export const PM_STUB_URL = `http://localhost:${PM_STUB_PORT}`;

const AI_STUB_PORT = Number(process.env.AI_STUB_PORT ?? PORT + 2);
export const AI_STUB_URL = `http://localhost:${AI_STUB_PORT}`;

export const WEBHOOK_SECRET = "e2e-webhook-signing-secret";

const WEBHOOK_RECEIVER_PORT = Number(process.env.WEBHOOK_RECEIVER_PORT ?? PORT + 3);
export const WEBHOOK_RECEIVER_URL = `http://127.0.0.1:${WEBHOOK_RECEIVER_PORT}`;

const MONGO_PROXY_PORT = Number(process.env.MONGO_PROXY_PORT ?? PORT + 4);
const MONGO_PROXY_CONTROL_PORT = Number(process.env.MONGO_PROXY_CONTROL_PORT ?? PORT + 5);
export const MONGO_PROXY_CONTROL_URL = `http://127.0.0.1:${MONGO_PROXY_CONTROL_PORT}`;

const MCP_SERVER_STUB_PORT = Number(process.env.MCP_SERVER_STUB_PORT ?? PORT + 6);
export const MCP_SERVER_STUB_URL = `http://127.0.0.1:${MCP_SERVER_STUB_PORT}`;

function throughMongoProxy(uri: string): string {
  if (!/^mongodb:\/\/[^,/]+\/[^?]+/.test(uri)) {
    throw new Error(
      "E2E_MONGODB_URI must be a single-host mongodb:// URI naming a database; mongodb+srv and host lists cannot be proxied"
    );
  }
  const url = new URL(uri.replace(/^mongodb:\/\//, "http://"));
  url.hostname = "127.0.0.1";
  url.port = String(MONGO_PROXY_PORT);
  url.searchParams.set("directConnection", "true");
  return url.toString().replace(/^http:\/\//, "mongodb://");
}

export default defineConfig({
  testDir: "./e2e",
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  outputDir: "./e2e/.artifacts",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    navigationTimeout: 90_000,
    actionTimeout: 30_000,
  },
  projects: Object.entries(GROUPS).map(([name, files]) => ({
    name,
    use: { ...devices["Desktop Chrome"] },
    testMatch: files.map((file) => `${__dirname}/e2e/${file}`),
  })),
  webServer: [
    {
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
      command: `node e2e/openrouter-stub.mjs`,
      url: `${PM_STUB_URL}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
      env: { PM_STUB_PORT: String(PM_STUB_PORT) },
    },
    {
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
      timeout: 240_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        MONGODB_URI: throughMongoProxy(E2E_MONGODB_URI),
        NEXT_PUBLIC_APP_URL: BASE_URL,
        PUBLIC_ORIGIN: BASE_URL,
        TRUSTED_PROXY_HOPS: "0",
        OPENROUTER_API_KEY: "e2e-stub-key",
        OPENROUTER_BASE_URL: `${PM_STUB_URL}/v1`,
        PM_SCHEDULER_TICK_MS: String(24 * 60 * 60 * 1000),
        OPENAI_API_KEY: "e2e-stub-key",
        OPENAI_BASE_URL: `${AI_STUB_URL}/v1`,
        WEBHOOK_SIGNING_SECRET: WEBHOOK_SECRET,
      },
    },
  ],
});
