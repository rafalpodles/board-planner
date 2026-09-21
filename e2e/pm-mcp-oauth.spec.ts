import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH } from "./api";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";
import { BASE_URL, MCP_SERVER_STUB_URL, PM_STUB_URL } from "../playwright.config";

/**
 * BP-707. An MCP server behind OAuth: Connect, the authorization server's consent page, the
 * callback, and what the connection does afterwards. The authorization server is the MCP stub's
 * `/oauth/<tenant>` space (e2e/mcp-oauth-stub.mjs), a fresh tenant per test, reached by the
 * browser the way a real provider is — the app is never told where it is beyond the MCP url.
 */

const SETTINGS_URL = `/projects/${PROJECT_KEY}/settings?section=pm`;
const PM_URL = `/projects/${PROJECT_KEY}/pm`;
const CALLBACK = `${BASE_URL}/api/pm/oauth/callback`;
const ROW = "oauthy";

interface TokenLogEntry {
  type: "token";
  grantType: string;
  authMethod: string;
  clientId: string;
  secret: string;
  outcome: string;
  pkce?: string;
  accessToken?: string;
  refreshToken?: string;
}
type LogEntry = TokenLogEntry | { type: "register" | "authorize"; clientId: string };

function newTenant(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const serverUrl = (tenant: string) => `${MCP_SERVER_STUB_URL}/oauth/${tenant}/mcp`;

async function stubLog(request: APIRequestContext, tenant: string): Promise<LogEntry[]> {
  return (await request.get(`${MCP_SERVER_STUB_URL}/_control/oauth/${tenant}/log`)).json();
}

const tokenRequests = (log: LogEntry[]) => log.filter((e): e is TokenLogEntry => e.type === "token");

async function withProjects<T>(fn: (projects: mongoose.mongo.Collection) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await fn(mongoose.connection.db!.collection("projects"));
  } finally {
    await mongoose.disconnect();
  }
}

async function storedOauth(): Promise<Record<string, unknown>> {
  return withProjects(async (projects) => {
    const project = await projects.findOne({ _id: PROJECT_ID });
    const server = (project?.pm?.mcpServers ?? []).find((s: { name: string }) => s.name === ROW);
    return server?.oauth ?? {};
  });
}

async function expireStoredToken() {
  await withProjects((projects) =>
    projects.updateOne(
      { _id: PROJECT_ID, "pm.mcpServers.name": ROW },
      { $set: { "pm.mcpServers.$.oauth.expiresAt": new Date(Date.now() - 60_000) } }
    )
  );
}

async function openSettings(page: Page) {
  await page.goto(SETTINGS_URL);
  await expect(page.getByRole("heading", { name: "MCP connections" })).toBeVisible();
}

async function addOauthServer(page: Page, tenant: string, client?: { id: string; secret: string }) {
  await page.getByRole("button", { name: "Add MCP server" }).click();
  await page.getByLabel("Name for Server 1").fill(ROW);
  await page.getByLabel(`URL for ${ROW}`).fill(serverUrl(tenant));
  await page.getByLabel(`Authentication for ${ROW}`).selectOption("oauth");
  if (client) await typeClient(page, client);
}

async function typeClient(page: Page, client: { id: string; secret: string }) {
  await page.getByLabel(`Client ID for ${ROW}`).fill(client.id);
  await page.getByLabel(`Client secret for ${ROW}`).fill(client.secret);
}

async function clickConnect(page: Page, tenant: string, label = "Connect") {
  await page.getByRole("button", { name: `${label} ${ROW}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`^${MCP_SERVER_STUB_URL}/oauth/${tenant}/authorize\\?`));
}

/** Approves on the provider's page and returns where the callback sent the browser. */
async function approve(page: Page): Promise<string> {
  await expect(page.getByRole("heading", { name: "Authorize BoardPlanner PM Agent" })).toBeVisible();
  const callback = page.waitForResponse((r) => r.url().startsWith(CALLBACK));
  await page.getByRole("button", { name: "Approve" }).click();
  const res = await callback;
  expect(res.status()).toBe(302);
  await expect(page.getByRole("heading", { name: "MCP connections" })).toBeVisible();
  return res.headers()["location"] ?? "";
}

async function connect(page: Page, tenant: string, label = "Connect") {
  await clickConnect(page, tenant, label);
  expect(await approve(page)).toContain("mcp_oauth=ok");
  await expect(page.getByText("MCP OAuth connection established")).toBeVisible();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
}

async function testConnection(page: Page) {
  // The callback lands on the project's id rather than its key, and the page-load probe posts
  // here too without an authToken — only the button sends one
  const answered = page.waitForResponse(
    (r) => r.url().endsWith("/pm/mcp-test") && "authToken" in (r.request().postDataJSON() ?? {})
  );
  await page.getByRole("button", { name: `Test connection for ${ROW}` }).click();
  await answered;
}

test.beforeEach(seed);
test.beforeEach(async ({ request }) => {
  await request.post(`${PM_STUB_URL}/reset`);
  await request.post(`/api/projects/${PROJECT_KEY}/pm/interrupt`, { headers: ADMIN_AUTH });
});
test.afterEach(async ({ request }) => {
  await request.post(`/api/projects/${PROJECT_KEY}/pm/interrupt`, { headers: ADMIN_AUTH });
});

test("Connect registers a client, signs in through the provider, and the token reaches a turn", async ({ page, request }) => {
  const tenant = newTenant();
  await signIn(page, "admin");
  await openSettings(page);
  await addOauthServer(page, tenant);

  await connect(page, tenant);

  const log = await stubLog(request, tenant);
  const registrations = log.filter((e) => e.type === "register");
  expect(registrations).toEqual([
    expect.objectContaining({ redirectUris: [CALLBACK] }),
  ]);
  const registeredId = registrations[0].clientId;
  const [exchange] = tokenRequests(log);
  expect(exchange).toMatchObject({
    grantType: "authorization_code",
    authMethod: "none",
    clientId: registeredId,
    secret: "",
    pkce: "verified",
    outcome: "issued",
  });

  const oauth = await storedOauth();
  expect(oauth).toMatchObject({ status: "connected", clientId: registeredId, redirectUri: CALLBACK });
  expect(oauth.accessToken).toEqual(expect.any(String));
  expect(oauth.refreshToken).toEqual(expect.any(String));
  expect(String(oauth.accessToken).length).toBeGreaterThan(0);
  expect(JSON.stringify(oauth)).not.toContain(exchange.accessToken!);
  expect(JSON.stringify(oauth)).not.toContain(exchange.refreshToken!);

  await testConnection(page);
  await expect(page.getByText("✓ Connected — 1 tools offered. Tick the ones the agent should get.")).toBeVisible();

  await request.post(`${PM_STUB_URL}/reset`);
  await page.goto(PM_URL);
  await page.getByPlaceholder(/Message the PM/).fill(`Say hello. <<${JSON.stringify({ say: "Hi." })}>>`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Hi.", { exact: true })).toHaveCount(1, { timeout: 30_000 });
  const last = await (await request.get(`${PM_STUB_URL}/last`)).json();
  expect(last?.offeredTools).toContain(`mcp_${ROW}_list_oauth_record`);
});

test("a client typed by hand is the one the token request carries; an unknown one is refused", async ({ page, request }) => {
  const tenant = newTenant();
  const typed = { id: `typed-${tenant}`, secret: `typed-secret-${tenant}` };
  await request.post(`${MCP_SERVER_STUB_URL}/_control/oauth/${tenant}/client`, {
    data: {
      client_id: typed.id,
      client_secret: typed.secret,
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "client_secret_basic",
    },
  });
  await signIn(page, "admin");
  await openSettings(page);

  await addOauthServer(page, tenant, { id: "nobody-registered-this", secret: "whatever" });
  await clickConnect(page, tenant);
  await expect(page.getByRole("heading", { name: "Unknown client" })).toBeVisible();

  await openSettings(page);
  // Typed over the stored registration, which a save used to drop in silence
  await typeClient(page, { id: typed.id, secret: "not-the-secret" });
  await clickConnect(page, tenant);
  expect(await approve(page)).toContain("mcp_oauth=error%3Atoken_exchange");
  await expect(page.getByText("MCP OAuth failed: token_exchange")).toBeVisible();
  await expect(page.getByText("Not connected", { exact: true })).toBeVisible();

  await typeClient(page, typed);
  await connect(page, tenant);

  const log = await stubLog(request, tenant);
  expect(log.filter((e) => e.type === "register")).toEqual([]);
  expect(tokenRequests(log)).toEqual([
    expect.objectContaining({
      grantType: "authorization_code",
      authMethod: "client_secret_basic",
      clientId: typed.id,
      secret: "not-the-secret",
      outcome: "invalid_client",
    }),
    expect.objectContaining({
      grantType: "authorization_code",
      authMethod: "client_secret_basic",
      clientId: typed.id,
      secret: typed.secret,
      pkce: "verified",
      outcome: "issued",
    }),
  ]);
  const oauth = await storedOauth();
  expect(oauth).toMatchObject({ status: "connected", clientId: typed.id });
  expect(JSON.stringify(oauth)).not.toContain(typed.secret);
  expect(String(oauth.clientSecret).length).toBeGreaterThan(0);
  expect(String(oauth.accessToken).length).toBeGreaterThan(0);

  // Another client typed with no secret must not inherit this one's secret or its tokens
  await expect(page.getByLabel(`Client secret for ${ROW}`)).toHaveValue("");
  await page.getByLabel(`Client ID for ${ROW}`).fill("another-client");
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/projects\/[^/]+$/.test(r.url()));
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await saved).ok()).toBe(true);
  expect(await storedOauth()).toMatchObject({
    clientId: "another-client",
    clientSecret: "",
    accessToken: "",
    refreshToken: "",
    expiresAt: null,
    status: "unconfigured",
  });
  await expect(page.getByText("Not connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Disconnect ${ROW}` })).toHaveCount(0);
});

test("a token that expires is refreshed; once the refresh is refused the panel says to sign in again, and reconnecting recovers", async ({ page, request }) => {
  const tenant = newTenant();
  await signIn(page, "admin");
  await openSettings(page);
  await addOauthServer(page, tenant);
  await connect(page, tenant);

  // The control: an expired token with a refresh the provider still honours stays connected
  const before = await storedOauth();
  await expireStoredToken();
  await testConnection(page);
  await expect(page.getByText("✓ Connected — 1 tools offered. Tick the ones the agent should get.")).toBeVisible();
  const refreshed = await storedOauth();
  expect(refreshed.status).toBe("connected");
  expect(refreshed.accessToken).not.toBe(before.accessToken);
  expect(tokenRequests(await stubLog(request, tenant)).map((e) => [e.grantType, e.outcome])).toEqual([
    ["authorization_code", "issued"],
    ["refresh_token", "issued"],
  ]);

  await request.post(`${MCP_SERVER_STUB_URL}/_control/oauth/${tenant}/revoke`);
  await expireStoredToken();
  await testConnection(page);
  await expect(page.getByText("✗ OAuth connection not established — click Connect first")).toBeVisible();
  expect(tokenRequests(await stubLog(request, tenant)).map((e) => [e.grantType, e.outcome])).toEqual([
    ["authorization_code", "issued"],
    ["refresh_token", "issued"],
    ["refresh_token", "invalid_grant"],
  ]);
  expect((await storedOauth()).status).toBe("needs_reauth");

  await page.reload();
  await expect(page.getByText("Needs re-auth", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Disconnect ${ROW}` })).toHaveCount(0);

  await connect(page, tenant);
  expect((await storedOauth()).status).toBe("connected");
  await testConnection(page);
  await expect(page.getByText("✓ Connected — 1 tools offered. Tick the ones the agent should get.")).toBeVisible();
});

test("Disconnect deletes the stored tokens, not only the badge", async ({ page }) => {
  const tenant = newTenant();
  await signIn(page, "admin");
  await openSettings(page);
  await addOauthServer(page, tenant);
  await connect(page, tenant);

  const connected = await storedOauth();
  expect(String(connected.accessToken).length).toBeGreaterThan(0);
  expect(String(connected.refreshToken).length).toBeGreaterThan(0);
  expect(connected.expiresAt).toBeInstanceOf(Date);
  const clientId = connected.clientId;

  const disconnected = page.waitForResponse((r) => r.url().endsWith(`/pm/mcp-oauth/disconnect`));
  await page.getByRole("button", { name: `Disconnect ${ROW}` }).click();
  expect((await disconnected).ok()).toBe(true);
  await expect(page.getByText("Not connected", { exact: true })).toBeVisible();

  expect(await storedOauth()).toMatchObject({
    status: "unconfigured",
    accessToken: "",
    refreshToken: "",
    expiresAt: null,
    clientId,
  });

  await testConnection(page);
  await expect(page.getByText("✗ OAuth connection not established — click Connect first")).toBeVisible();
});
