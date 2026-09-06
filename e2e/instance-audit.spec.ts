import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH, SAME_ORIGIN, signInApi } from "./api";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  E2E_MONGODB_URI,
  PROJECT_ID,
  PROJECT_KEY,
  WORKER_ID,
  WORKER_NAME,
  seed,
} from "./seed";
import { signIn as arriveSignedIn } from "./session";

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

const signIn = arriveSignedIn;

test.beforeEach(async () => {
  await seed();
  const handle = await db();
  // Without a repository the card refuses to offer the toggle at all, and the control under test
  // lives on it
  await handle
    .collection("projects")
    .updateOne(
      { _id: PROJECT_ID },
      { $set: { repositoryUrl: "git@github.com:owner/board-planner.git" } }
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
//
// This is also the last real-database coverage of the shared `worker.policy.<field>` +
// policyOverrides write path — every policy field goes through it, and
// project-worker-config.test.ts only compares the resulting update object to a literal, which
// proves what the code intends to write and nothing about what MongoDB does with it. That is the
// exact shape of gap this repo has shipped before: shape assertions never noticed `""` was truthy
// in Mongo's `$cond`. "Records nothing" would hold vacuously if the save had silently written
// nothing at all, so the value and its pin are read back from the real collection too.
test("changing worker policy without changing whether they run records nothing", async ({ page }) => {
  await signIn(page);
  await page.goto(SETTINGS);
  await page.getByRole("button", { name: "Workers", exact: true }).first().click();

  // Any policy field does. Reached by its label since BP-510 gave these rows one — the xpath this
  // replaces existed only because the text beside the input was a <span> with no `for`.
  // `exact` because the reset button in the same row is named after the field too.
  await page.getByLabel("Base branch", { exact: true }).fill("develop");
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/projects/") && r.request().method() === "PUT"
    ),
    page.getByRole("button", { name: "Save changes" }).click(),
  ]);

  expect(await auditRows()).toHaveLength(0);

  const handle = await db();
  const project = await handle.collection("projects").findOne({ _id: PROJECT_ID });
  expect(project?.worker?.policy?.baseBranch).toBe("develop");
  expect(project?.worker?.policyOverrides).toContain("baseBranch");
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

/**
 * BP-531. The log had two ways to stop a machine in it and drew only one of them as something to
 * notice: `worker_locked` was labelled "Kill switch on" in red, while `worker_command_sent` had no
 * label at all and fell back to its own identifier, in grey.
 *
 * Both halves are read here from the rendered row rather than from the stored document, because
 * the row is the whole of what was wrong — the write was always correct.
 */
test("a machine told to stop reads as loudly as one that was locked, and a resume does not", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/settings/workers");
  const machine = page.getByRole("row").filter({ hasText: WORKER_NAME }).first();

  for (const command of ["Stop", "Resume"] as const) {
    const [issued] = await Promise.all([
      page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === `/api/workers/${WORKER_ID}/command` &&
          r.request().method() === "POST"
      ),
      machine.getByRole("button", { name: command, exact: true }).click(),
    ]);
    expect(issued.status(), await issued.text()).toBe(200);
  }

  await page.goto("/settings/audit");
  await expect(page.getByRole("heading", { name: "Instance audit log" })).toBeVisible();

  // Which command, not that a command happened: the actions on this page are deliberately separate
  // verbs so nobody has to read the next column to find out what was done
  const stopped = page.getByRole("row").filter({ hasText: "Worker told to stop" });
  await expect(stopped).toHaveCount(1);
  await expect(stopped).toContainText(WORKER_NAME);
  await expect(stopped.getByText("Worker told to stop")).toHaveClass(/text-danger/);

  // The control, and the reason notability cannot be a property of the action: the same endpoint
  // wrote this row, and giving the work back is not worth the same red
  const resumed = page.getByRole("row").filter({ hasText: "Worker told to resume" });
  await expect(resumed).toHaveCount(1);
  await expect(resumed.getByText("Worker told to resume")).toHaveClass(/text-text-muted/);

  // And the identifier itself never reaches a reader
  await expect(page.getByText(/worker command sent/)).toHaveCount(0);
});
