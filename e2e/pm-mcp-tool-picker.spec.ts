import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH } from "./api";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";
import { MCP_SERVER_STUB_URL, PM_STUB_URL } from "../playwright.config";

/**
 * BP-569. How many MCP tools a turn carries is decided by the remote server, not by this repo, so
 * a project that worked can break with no deploy and no settings change — which is what happened
 * on production on 2026-09-06, when two servers put 86 tool schemas into every call of every turn
 * and turns started ending at the step limit instead of answering.
 *
 * Driven end to end because the three halves only meet in the browser: a real MCP server offering
 * a real catalogue, the settings screen the allowlist is chosen on, and the turn that carries the
 * result to the model. The tool list is handed to the model BESIDE the conversation, so no
 * assertion on messages can see it; the stub reports `offeredTools` for exactly this.
 */

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

    // The description comes from the MCP server, so it is not something this test typed
    await expect(page.getByText("Read the alpha record")).toBeVisible();
    await expect(page.getByText("Write a gamma record")).toBeVisible();
    // and the one tool that mutates says so
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
      // The route param is the project KEY, not its id — the settings screen is addressed the
      // way a person addresses it
      (r) => r.request().method() === "PUT" && r.url().endsWith(`/api/projects/${PROJECT_KEY}`)
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    await saved;

    // Stored as the same array of names it always was, so an allowlist written before the picker
    // existed still loads and still means the same thing
    expect(await storedAllowlist("narrow")).toEqual(["list_narrow_alpha", "list_narrow_beta"]);
    expect(await storedAllowlist("wide")).toEqual([]);

    await page.goto(PM_URL);
    await page.getByPlaceholder(/Message the PM/).fill(`Say hello. <<${JSON.stringify({ say: "Hi." })}>>`);
    await page.getByRole("button", { name: "Send", exact: true }).click();

    // Not "PM Agent is visible": that bubble renders as "PM is thinking…", before any model call
    // has been made, and reading the stub then finds nothing recorded yet.
    let offered: string[] = [];
    await expect
      .poll(async () => {
        const last = await (await request.get(`${PM_STUB_URL}/last`)).json();
        offered = last?.offeredTools ?? [];
        return offered.length;
      }, { timeout: 30_000 })
      .toBeGreaterThan(0);

    // The turn must be FINISHED before this test ends, not merely started. Returning while it runs
    // leaves the next spec's seed() emptying collections underneath a live turn, and the turn lock
    // held — which surfaces as an unrelated pm-chat test failing on a 409 it did not expect.
    await expect(page.getByText("Hi.", { exact: true })).toBeVisible({ timeout: 30_000 });

    // The narrowed server contributed exactly what was ticked
    expect(offered.filter((n) => n.includes("narrow")).sort()).toEqual([
      "mcp_narrow_list_narrow_alpha",
      "mcp_narrow_list_narrow_beta",
    ]);
    // The control: a server nobody touched still offers its whole catalogue, so a silence above
    // cannot be a broken connection to the stub
    expect(offered.filter((n) => n.startsWith("mcp_wide_")).length).toBe(45);
  });

  /**
   * `transient` is keyed by array position. Removing a row slid every later row onto the previous
   * row's catalogue, so the picker under one server listed another's tools and an allowlist saved
   * from them matched nothing at turn time — the "ticked on screen, denied by the agent" outcome
   * this change exists to prevent (BP-569 review).
   */
  test("removing a server does not slide its catalogue onto the next one", async ({ page }) => {
    await connectServers([server("narrow", "/narrow"), server("wide", "/wide")]);
    await signIn(page, "admin");
    await page.goto(SETTINGS_URL);

    // Both probes must have landed before the removal, or wide's answer arriving afterwards is
    // itself the race this test is about and the failure would be indistinguishable
    await expect(page.getByLabel("list_narrow_alpha for narrow")).toBeVisible();
    await expect(page.getByLabel("list_wide_thing_0 for wide")).toBeVisible();

    await page.getByRole("button", { name: "Remove narrow" }).click();

    // wide is now the only row, and it must still be showing its OWN tools — asserting only that
    // narrow's are absent would pass against an empty picker, which is a different bug
    await expect(page.getByLabel("list_wide_thing_0 for wide")).toBeVisible();
    await expect(page.getByLabel("list_narrow_alpha for wide")).toHaveCount(0);
  });

  /**
   * A test-connection answering after its row was removed used to write its catalogue and green
   * success line onto whichever row had taken that array index (BP-569 review 2).
   */
  test("a test that answers after its row is gone lands on nothing", async ({ page }) => {
    await connectServers([server("narrow", "/narrow"), server("wide", "/wide")]);
    await signIn(page, "admin");
    await page.goto(SETTINGS_URL);
    await expect(page.getByLabel("list_wide_thing_0 for wide")).toBeVisible();

    // Hold narrow's answer, ask for it, then remove the row while it is in flight
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
    // Without this the four assertions below are all satisfied by the DOM as it already stands and
    // pass on their first poll, before the stale write could even arrive (BP-569 review 3)
    await answered;

    // wide is the only row left and keeps its own tools and its own Test button
    await expect(page.getByLabel("list_wide_thing_0 for wide")).toBeVisible();
    await expect(page.getByLabel("list_narrow_alpha for wide")).toHaveCount(0);
    await expect(testButton(page, "wide")).toBeEnabled();
    await expect(page.getByText(/Connected — 3 tools offered/)).toHaveCount(0);
  });

  /**
   * Saving is where the previous fix still broke: a row identity derived from array position was
   * re-minted on every save, so the surviving row inherited the removed row's catalogue only
   * after the PUT came back. Every earlier test stopped before Save (BP-569 review 3).
   */
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

    // wide is the only server left and still shows its own catalogue, not narrow's
    await expect(page.getByLabel("list_wide_thing_0 for wide")).toBeVisible();
    await expect(page.getByLabel("list_narrow_alpha for wide")).toHaveCount(0);
    expect(await storedAllowlist("narrow")).toEqual([]);
  });

  test("changing a server's url drops the catalogue that described the old one", async ({ page }) => {
    await connectServers([server("narrow", "/narrow")]);
    await signIn(page, "admin");
    await page.goto(SETTINGS_URL);

    await expect(page.getByLabel("list_narrow_alpha for narrow")).toBeVisible();
    await page.getByLabel("URL for narrow").fill(`${MCP_SERVER_STUB_URL}/wide`);

    // The old catalogue is gone rather than left describing a host no longer addressed
    await expect(page.getByLabel("list_narrow_alpha for narrow")).toHaveCount(0);

    // The control: testing again repopulates it, with the new host's tools
    await testButton(page, "narrow").click();
    await expect(page.getByLabel("list_wide_thing_0 for narrow")).toBeVisible();
  });

  test("warns when the connected servers flood every call, naming who is responsible", async ({
    page,
  }) => {
    await connectServers([server("wide", "/wide"), server("narrow", "/narrow")]);
    await signIn(page, "admin");
    await page.goto(SETTINGS_URL);

    // No Test connection click: the catalogues are fetched when the screen opens, or the warning
    // would be invisible to exactly the operator whose project is already flooded.
    // Not getByRole("status"): dnd-kit mounts its own live region with that role on this page
    const warning = page.getByTestId("mcp-tool-budget-warning");
    await expect(warning).toContainText("48 MCP tools");
    await expect(warning).toContainText("wide (45)");

    // The control: narrowing the offender clears the warning, so it is keyed on the count rather
    // than on merely having servers. The catalogue must still be on screen — `toBeHidden` is also
    // satisfied by a warning that vanished because the count fell to zero (BP-569 review 2).
    await page.getByLabel("list_wide_thing_0 for wide").check();
    await expect(warning).toBeHidden();
    await expect(page.getByLabel("list_wide_thing_1 for wide")).toBeVisible();
  });
});
