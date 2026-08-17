import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH, SAME_ORIGIN, signInApi } from "./api";
import { ADMIN_PASSWORD, ADMIN_USERNAME, E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed } from "./seed";

/**
 * BP-233. BP-232 removed stored worker assignments, and the audit call that hung off them went with
 * them — so stopping a machine, or committing a project to workers, became things nobody could
 * prove had happened.
 *
 * Driven through the browser rather than mocked: the write sits behind a settings screen, and what
 * needs proving is that a person doing the ordinary thing leaves a row somebody else can read.
 * A mocked PUT would prove the handler calls a function.
 */

const SETTINGS = `/projects/${PROJECT_KEY}/settings`;

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function auditRows() {
  const handle = await db();
  return handle.collection("instanceauditlogs").find({}).sort({ createdAt: -1 }).toArray();
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN_USERNAME);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);
}

test.beforeEach(async () => {
  await seed();
  const handle = await db();
  // Without a repository the card refuses to offer the toggle at all, and the control under test
  // lives on it
  await handle
    .collection("projects")
    .updateOne(
      { _id: PROJECT_ID },
      { $set: { repositoryUrl: "git@github.com:rafalpodles/board-planner.git" } }
    );
  await handle.collection("instanceauditlogs").deleteMany({});
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("committing a project to workers is recorded, and readable afterwards", async ({ page }) => {
  await signIn(page);
  await page.goto(SETTINGS);
  await page.getByRole("button", { name: "Workers", exact: true }).first().click();

  // ui/Switch renders its role="switch" input `sr-only`, so Playwright refuses to click it as not
  // visible. The clickable surface is the wrapping label — which is also what a person clicks.
  const toggle = page.getByRole("switch", { name: /Let workers run tasks/ });
  await expect(toggle).toBeChecked();

  // The seed leaves this on, so the ordinary gesture available here turns it off. Either direction
  // is the same decision being recorded — one commits a machine to running agent-written code, the
  // other takes that back.
  await page.getByText("Let workers run tasks for this project", { exact: true }).click();
  await expect(toggle).not.toBeChecked();
  // Awaited, not merely clicked: the save bar closes on the committed draft, and reading the
  // collection off that alone races the write
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/projects/") && r.request().method() === "PUT"
    ),
    page.getByRole("button", { name: "Save changes" }).click(),
  ]);
  await expect(page.getByRole("button", { name: "Save changes" })).toBeHidden();

  const rows = await auditRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ action: "project_workers_disabled", target: PROJECT_KEY });
  // Named by key, not by id: this log outlives its subjects, and an id names nothing to a reader
  expect(rows[0].user).not.toBeNull();

  // The other half of the ticket: a row nobody can find is not an audit trail. Navigated to, not
  // goto'd — removing the nav entry left every assertion here passing.
  await page.goto("/settings/workers");
  await page.getByRole("link", { name: "Audit log" }).first().click();
  await expect(page).toHaveURL(/\/settings\/audit/);
  await expect(page.getByRole("heading", { name: "Instance audit log" })).toBeVisible();

  // Scoped to one row rather than asserted as three loose strings: the project key also appears in
  // the sidebar, and "somewhere on the page" would not prove who did what to which project
  const row = page.getByRole("row").filter({ hasText: "Workers disabled for project" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(PROJECT_KEY);
  await expect(row).toContainText(ADMIN_USERNAME);
});

test("changing something else about the project records nothing", async ({ page }) => {
  await signIn(page);
  await page.goto(SETTINGS);
  await page.getByRole("button", { name: "General", exact: true }).first().click();

  const description = page.getByLabel("Description");
  await description.fill("Touched, but not committed to any machine");
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/projects/") && r.request().method() === "PUT"
    ),
    page.getByRole("button", { name: "Save changes" }).click(),
  ]);

  // The instance log is for fleet decisions. Ordinary project edits already have their own log,
  // under that project, and duplicating them here would bury the rows that matter.
  expect(await auditRows()).toHaveLength(0);
});

// A worker-settings save that leaves `enabled` alone must not claim the project was committed or
// withdrawn. The description test cannot cover this: it never sends `worker` at all, so the whole
// branch is skipped and a broken condition inside it goes unseen.
test("changing worker policy without changing whether they run records nothing", async ({ page }) => {
  await signIn(page);
  await page.goto(SETTINGS);
  await page.getByRole("button", { name: "Workers", exact: true }).first().click();

  // Any policy field does: the row has no label association, so it is found by the row it shares
  // with its own text rather than by an accessible label
  await page
    .locator("xpath=//span[normalize-space()='Base branch']/..")
    .getByRole("textbox")
    .fill("develop");
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/projects/") && r.request().method() === "PUT"
    ),
    page.getByRole("button", { name: "Save changes" }).click(),
  ]);

  expect(await auditRows()).toHaveLength(0);
});

// The write used to fire before the update and before five later refusals, all in one handler. A
// request carrying a worker toggle and one bad field returns 400, changes nothing, and used to
// leave a row saying a project had been committed to workers.
//
// Through the API, not the browser: the settings screen saves one section at a time, so no
// gesture produces a request carrying both. Intercepting the response in the page would be worse
// than no test — the handler under examination would never run at all.
//
// A browser session rather than the API token every other call here carries: since BP-306 the
// worker fields refuse a machine credential outright, so a token answers 403 and never reaches
// the ordering this test is about.
test("a refused save leaves no record of a decision that never happened", async ({ request }) => {
  await signInApi(request, ADMIN_USERNAME, ADMIN_PASSWORD);
  const response = await request.put(`/api/projects/${PROJECT_KEY}`, {
    headers: SAME_ORIGIN,
    data: { worker: { enabled: false }, gitlabHost: "http://gitlab.internal" },
  });

  expect(response.status()).toBe(400);
  expect(await auditRows()).toHaveLength(0);

  // And the decision itself did not land either, so the absent row is telling the truth
  const handle = await db();
  const project = await handle.collection("projects").findOne({ _id: PROJECT_ID });
  expect(project?.worker?.enabled).toBe(true);
});

// BP-306: an unscoped admin API token keeps role: "admin" and so passed withAdmin. Committing a
// machine to running agent-written code needs a person at a keyboard, which is the line the
// device-enrolment route performing the same enable already drew.
test("worker settings refuse an admin API token", async ({ request }) => {
  const response = await request.put(`/api/projects/${PROJECT_KEY}`, {
    headers: ADMIN_AUTH,
    data: { worker: { enabled: false } },
  });

  expect(response.status()).toBe(403);

  const handle = await db();
  const project = await handle.collection("projects").findOne({ _id: PROJECT_ID });
  expect(project?.worker?.enabled).toBe(true);
});

test("the log is not readable by someone who could not have written to it", async ({ request }) => {
  const handle = await db();
  await handle.collection("users").updateOne({ username: ADMIN_USERNAME }, { $set: { role: "member" } });

  // A browser session, not the API token every other call here carries: this route turns away a
  // machine credential before it ever reads the caller's role, so a token would answer 403 while
  // saying nothing at all about the demotion under test
  await signInApi(request, ADMIN_USERNAME, ADMIN_PASSWORD);
  const response = await request.get("/api/admin/audit");

  expect(response.status()).toBe(403);
});
