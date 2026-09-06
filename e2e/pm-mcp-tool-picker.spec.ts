import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH } from "./api";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";
import { MCP_SERVER_STUB_URL, PM_STUB_URL } from "../playwright.config";

const SETTINGS_URL = `/projects/${PROJECT_KEY}/settings?section=pm`;
const PM_URL = `/projects/${PROJECT_KEY}/pm`;

async function connectServers(servers: Record<string, unknown>[]) {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error("no database handle");
  await db.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { "pm.mcpServers": servers } });
}

const server = (name: string, path: string, extra: Record<string, unknown> = {}) => ({
  name,
  url: `${MCP_SERVER_STUB_URL}${path}`,
  authType: "none",
  authToken: "",
  enabled: true,
  allowWrites: true,
  toolAllowlist: [],
  ...extra,
});

const storedAllowlist = async (name: string): Promise<string[]> => {
  const db = mongoose.connection.db;
  if (!db) throw new Error("no database handle");
  const project = await db.collection("projects").findOne({ _id: PROJECT_ID });
  const row = (project?.pm?.mcpServers ?? []).find((s: { name: string }) => s.name === name);
  return row?.toolAllowlist ?? [];
};

const testButton = (page: Page, name: string) =>
  page.getByRole("button", { name: `Test connection for ${name}` });

test.beforeEach(seed);
test.beforeEach(async ({ request }) => {
  await request.post(`${PM_STUB_URL}/reset`);
  await request.post(`/api/projects/${PROJECT_KEY}/pm/interrupt`, { headers: ADMIN_AUTH });
});
test.afterEach(async ({ request }) => {
  await request.post(`/api/projects/${PROJECT_KEY}/pm/interrupt`, { headers: ADMIN_AUTH });
});

test.describe("choosing an MCP server's tools", () => {
  test("shows what each tool does, instead of a line of names to retype", async ({ page }) => {
    await connectServers([server("narrow", "/narrow")]);
    await signIn(page, "admin");
    await page.goto(SETTINGS_URL);

    await testButton(page, "narrow").click();

    await expect(page.getByText("Read the alpha record")).toBeVisible();
    await expect(page.getByText("Write a gamma record")).toBeVisible();
    await expect(page.getByText("writes", { exact: true })).toBeVisible();
  });

  test("ticking tools narrows what a turn carries, and leaves an untouched server whole", async ({
    page,
    request,
  }) => {
    await connectServers([server("narrow", "/narrow"), server("wide", "/wide")]);
    await signIn(page, "admin");
    await page.goto(SETTINGS_URL);

    await testButton(page, "narrow").click();
    await page.getByLabel("list_narrow_alpha for narrow").check();
    await page.getByLabel("list_narrow_beta for narrow").check();

    const saved = page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().endsWith(`/api/projects/${PROJECT_KEY}`)
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    await saved;

    expect(await storedAllowlist("narrow")).toEqual(["list_narrow_alpha", "list_narrow_beta"]);
    expect(await storedAllowlist("wide")).toEqual([]);

    await page.goto(PM_URL);
    await page.getByPlaceholder(/Message the PM/).fill(`Say hello. <<${JSON.stringify({ say: "Hi." })}>>`);
    await page.getByRole("button", { name: "Send", exact: true }).click();

    let offered: string[] = [];
    await expect
      .poll(async () => {
        const last = await (await request.get(`${PM_STUB_URL}/last`)).json();
        offered = last?.offeredTools ?? [];
        return offered.length;
      }, { timeout: 30_000 })
      .toBeGreaterThan(0);

    await expect(page.getByText("Hi.", { exact: true })).toBeVisible({ timeout: 30_000 });

    expect(offered.filter((n) => n.includes("narrow")).sort()).toEqual([
      "mcp_narrow_list_narrow_alpha",
      "mcp_narrow_list_narrow_beta",
    ]);
    expect(offered.filter((n) => n.startsWith("mcp_wide_")).length).toBe(45);
  });

  test("removing a server does not slide its catalogue onto the next one", async ({ page }) => {
    await connectServers([server("narrow", "/narrow"), server("wide", "/wide")]);
    await signIn(page, "admin");
    await page.goto(SETTINGS_URL);

    await expect(page.getByLabel("list_narrow_alpha for narrow")).toBeVisible();
    await expect(page.getByLabel("list_wide_thing_0 for wide")).toBeVisible();

    await page.getByRole("button", { name: "Remove narrow" }).click();

    await expect(page.getByLabel("list_wide_thing_0 for wide")).toBeVisible();
    await expect(page.getByLabel("list_narrow_alpha for wide")).toHaveCount(0);
  });

  test("a test that answers after its row is gone lands on nothing", async ({ page }) => {
    await connectServers([server("narrow", "/narrow"), server("wide", "/wide")]);
    await signIn(page, "admin");
    await page.goto(SETTINGS_URL);
    await expect(page.getByLabel("list_wide_thing_0 for wide")).toBeVisible();

    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/pm/mcp-test", async (route) => {
      if (route.request().postDataJSON()?.name === "narrow") await held;
      await route.continue();
    });

    const answered = page.waitForResponse((r) => r.url().includes("/pm/mcp-test"));
    await testButton(page, "narrow").click();
    await page.getByRole("button", { name: "Remove narrow" }).click();
    release();
    await answered;

    await expect(page.getByLabel("list_wide_thing_0 for wide")).toBeVisible();
    await expect(page.getByLabel("list_narrow_alpha for wide")).toHaveCount(0);
    await expect(testButton(page, "wide")).toBeEnabled();
    await expect(page.getByText(/Connected — 3 tools offered/)).toHaveCount(0);
  });

  test("a removal that is saved leaves the surviving row its own tools", async ({ page }) => {
    await connectServers([server("narrow", "/narrow"), server("wide", "/wide")]);
    await signIn(page, "admin");
    await page.goto(SETTINGS_URL);
    await expect(page.getByLabel("list_narrow_alpha for narrow")).toBeVisible();
    await expect(page.getByLabel("list_wide_thing_0 for wide")).toBeVisible();

    await page.getByRole("button", { name: "Remove narrow" }).click();
    const saved = page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().endsWith(`/api/projects/${PROJECT_KEY}`)
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    await saved;

    await expect(page.getByLabel("list_wide_thing_0 for wide")).toBeVisible();
    await expect(page.getByLabel("list_narrow_alpha for wide")).toHaveCount(0);

    await page.getByLabel("list_wide_thing_0 for wide").check();
    const savedAgain = page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().endsWith(`/api/projects/${PROJECT_KEY}`)
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    await savedAgain;
    expect(await storedAllowlist("wide")).toEqual(["list_wide_thing_0"]);
  });

  test("saving does not make a server's tools, or the warning, disappear", async ({ page }) => {
    await connectServers([
      server("wide", "/wide", { authType: "bearer", authToken: "" }),
      server("narrow", "/narrow"),
    ]);
    await signIn(page, "admin");
    await page.goto(SETTINGS_URL);

    const warning = page.getByTestId("mcp-tool-budget-warning");
    await expect(warning).toContainText("48 MCP tools");

    await page.getByLabel("Tool allowlist for narrow").fill("list_narrow_alpha");
    const saved = page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().endsWith(`/api/projects/${PROJECT_KEY}`)
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    await saved;

    await expect(page.getByLabel("list_wide_thing_0 for wide")).toBeVisible();
    await expect(warning).toContainText("wide (45)");
  });

  test("changing a server's url drops the catalogue that described the old one", async ({ page }) => {
    await connectServers([server("narrow", "/narrow")]);
    await signIn(page, "admin");
    await page.goto(SETTINGS_URL);

    await expect(page.getByLabel("list_narrow_alpha for narrow")).toBeVisible();
    await page.getByLabel("URL for narrow").fill(`${MCP_SERVER_STUB_URL}/wide`);

    await expect(page.getByLabel("list_narrow_alpha for narrow")).toHaveCount(0);

    await testButton(page, "narrow").click();
    await expect(page.getByLabel("list_wide_thing_0 for narrow")).toBeVisible();
  });

  test("warns when the connected servers flood every call, naming who is responsible", async ({
    page,
  }) => {
    await connectServers([server("wide", "/wide"), server("narrow", "/narrow")]);
    await signIn(page, "admin");
    await page.goto(SETTINGS_URL);

    const warning = page.getByTestId("mcp-tool-budget-warning");
    await expect(warning).toContainText("48 MCP tools");
    await expect(warning).toContainText("wide (45)");

    await page.getByLabel("list_wide_thing_0 for wide").check();
    await expect(warning).toBeHidden();
    await expect(page.getByLabel("list_wide_thing_1 for wide")).toBeVisible();
  });

  test("a project owner is neither warned nor charged for the probe", async ({ page }) => {
    await connectServers([server("wide", "/wide"), server("narrow", "/narrow")]);

    const probes: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/pm/mcp-test")) probes.push(r.url());
    });

    await signIn(page, "owner");
    await page.goto(SETTINGS_URL);
    await expect(page.getByText("MCP connections")).toBeVisible();

    await expect(page.getByTestId("mcp-tool-budget-warning")).toHaveCount(0);
    expect(probes).toEqual([]);
  });

  test("an instance admin is", async ({ page }) => {
    await connectServers([server("wide", "/wide"), server("narrow", "/narrow")]);
    await signIn(page, "admin");
    await page.goto(SETTINGS_URL);

    await expect(page.getByTestId("mcp-tool-budget-warning")).toContainText("48 MCP tools");
  });
});
