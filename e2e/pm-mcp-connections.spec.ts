import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH } from "./api";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";
import { MCP_SERVER_STUB_URL, PM_STUB_URL } from "../playwright.config";

/**
 * BP-476. Project Settings → PM Agent → MCP connections points the agent at external servers.
 * Every spec before this one wrote the server into Mongo and started from there, so the form that
 * creates one had never been filled in, and no spec had ever had a server with writes off — the
 * one setting that decides whether a third-party tool that changes things reaches an agent nobody
 * is watching.
 *
 * The server is the MCP stub: `/narrow` offers two reads and one write, `create_narrow_gamma`.
 */

const SETTINGS_URL = `/projects/${PROJECT_KEY}/settings?section=pm`;
const PM_URL = `/projects/${PROJECT_KEY}/pm`;

async function storedServers(): Promise<Record<string, unknown>[]> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    const project = await mongoose.connection.db!.collection("projects").findOne({ _id: PROJECT_ID });
    return (project?.pm?.mcpServers ?? []) as Record<string, unknown>[];
  } finally {
    await mongoose.disconnect();
  }
}

async function seedServer(over: Record<string, unknown>) {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    await mongoose.connection.db!.collection("projects").updateOne(
      { _id: PROJECT_ID },
      {
        $set: {
          "pm.mcpServers": [
            {
              name: "stubby",
              url: `${MCP_SERVER_STUB_URL}/narrow`,
              authType: "none",
              authToken: "",
              enabled: true,
              allowWrites: false,
              toolAllowlist: [],
              ...over,
            },
          ],
        },
      }
    );
  } finally {
    await mongoose.disconnect();
  }
}

async function openSettings(page: Page) {
  await page.goto(SETTINGS_URL);
  await expect(page.getByRole("heading", { name: "MCP connections" })).toBeVisible();
}

async function save(page: Page) {
  const saved = page.waitForResponse(
    (r) => r.request().method() === "PUT" && r.url().endsWith(`/api/projects/${PROJECT_KEY}`)
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await saved).ok()).toBe(true);
}

/** The tools a real turn handed the model, read from the stub once the turn has finished */
async function toolsOfferedToATurn(page: Page, request: APIRequestContext, earlierTurns = 0): Promise<string[]> {
  await request.post(`${PM_STUB_URL}/reset`);
  await page.goto(PM_URL);
  const answers = page.getByText("Hi.", { exact: true });
  // Waited for, not counted: a count taken while the thread is still loading reads zero
  await expect(answers).toHaveCount(earlierTurns);
  await page.getByPlaceholder(/Message the PM/).fill(`Say hello. <<${JSON.stringify({ say: "Hi." })}>>`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  // Finished, not started: a turn still holding the lock when the next test seeds is a 409 there
  await expect(answers).toHaveCount(earlierTurns + 1, { timeout: 30_000 });
  const last = await (await request.get(`${PM_STUB_URL}/last`)).json();
  return last?.offeredTools ?? [];
}

test.beforeEach(seed);
test.beforeEach(async ({ request }) => {
  await request.post(`${PM_STUB_URL}/reset`);
  await request.post(`/api/projects/${PROJECT_KEY}/pm/interrupt`, { headers: ADMIN_AUTH });
});
test.afterEach(async ({ request }) => {
  await request.post(`/api/projects/${PROJECT_KEY}/pm/interrupt`, { headers: ADMIN_AUTH });
});

test("a server added through the form is stored, survives a reload and connects", async ({ page }) => {
  await signIn(page, "admin");
  await openSettings(page);

  await page.getByRole("button", { name: "Add MCP server" }).click();
  await page.getByLabel("Name for Server 1").fill("stubby");
  await page.getByLabel("URL for stubby").fill(`${MCP_SERVER_STUB_URL}/narrow`);
  await save(page);

  expect(await storedServers()).toEqual([
    expect.objectContaining({ name: "stubby", url: `${MCP_SERVER_STUB_URL}/narrow`, authType: "none", allowWrites: false, enabled: true }),
  ]);

  await page.reload();
  await expect(page.getByLabel("Name for stubby")).toHaveValue("stubby");
  await expect(page.getByLabel("URL for stubby")).toHaveValue(`${MCP_SERVER_STUB_URL}/narrow`);

  await page.getByRole("button", { name: "Test connection for stubby" }).click();
  await expect(page.getByText("✓ Connected — 3 tools offered. Tick the ones the agent should get.")).toBeVisible();
});

test("each way of signing in shows its own fields, and a bearer token is kept without being shown", async ({ page }) => {
  await seedServer({});
  await signIn(page, "admin");
  await openSettings(page);
  const auth = page.getByLabel("Authentication for stubby");

  await expect(page.getByLabel("Token for stubby")).toHaveCount(0);
  await expect(page.getByLabel("Client ID for stubby")).toHaveCount(0);

  await auth.selectOption("oauth");
  await expect(page.getByLabel("Client ID for stubby")).toBeVisible();
  await expect(page.getByLabel("Client secret for stubby")).toBeVisible();
  await expect(page.getByText("Not connected", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Token for stubby")).toHaveCount(0);

  await auth.selectOption("bearer");
  await expect(page.getByLabel("Client ID for stubby")).toHaveCount(0);
  await page.getByLabel("Token for stubby").fill("a-bearer-token-for-the-stub");
  await save(page);

  const [stored] = await storedServers();
  expect(stored.authType).toBe("bearer");
  // Encrypted at rest, never the token itself
  expect(JSON.stringify(stored)).not.toContain("a-bearer-token-for-the-stub");

  await page.reload();
  await expect(page.getByLabel("Token for stubby")).toHaveValue("");
  await expect(page.getByLabel("Token for stubby")).toHaveAttribute("placeholder", "Token set — leave empty to keep");
});

test("a connection that cannot be reached says so", async ({ page }) => {
  // A port nothing listens on, on the loopback address the development server may reach
  await seedServer({ url: "http://127.0.0.1:9/mcp" });
  await signIn(page, "admin");
  await openSettings(page);

  await page.getByRole("button", { name: "Test connection for stubby" }).click();

  await expect(page.getByText(/^✗ /)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/✓ Connected/)).toHaveCount(0);
});

test("with writes off a turn gets the server's reads and not its write; allowing writes adds it", async ({ page, request }) => {
  await seedServer({});
  await signIn(page, "admin");

  const readOnly = await toolsOfferedToATurn(page, request);
  expect(readOnly.filter((n) => n.startsWith("mcp_stubby_")).sort()).toEqual([
    "mcp_stubby_list_narrow_alpha",
    "mcp_stubby_list_narrow_beta",
  ]);

  await openSettings(page);
  await page.getByRole("switch", { name: "Allow writes", exact: true }).locator("xpath=ancestor::label[1]").click();
  await save(page);
  expect((await storedServers())[0].allowWrites).toBe(true);

  const writable = await toolsOfferedToATurn(page, request, 1);
  expect(writable).toContain("mcp_stubby_create_narrow_gamma");
});

test("a server switched off offers a turn nothing at all", async ({ page, request }) => {
  await seedServer({ enabled: false, allowWrites: true });
  await signIn(page, "admin");

  const offered = await toolsOfferedToATurn(page, request);

  expect(offered.some((n) => n.startsWith("mcp_stubby_"))).toBe(false);
  expect(offered.length).toBeGreaterThan(0);
});

test("an OAuth connection shows whether it is connected or needs signing in again", async ({ page }) => {
  await seedServer({ authType: "oauth", oauth: { status: "needs_reauth" } });
  await signIn(page, "admin");
  await openSettings(page);

  await expect(page.getByText("Needs re-auth", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect stubby" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect stubby" })).toHaveCount(0);

  await seedServer({ authType: "oauth", oauth: { status: "connected", accessToken: "enc:v2:not-real" } });
  await page.reload();

  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect stubby" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect stubby" })).toBeVisible();
});
