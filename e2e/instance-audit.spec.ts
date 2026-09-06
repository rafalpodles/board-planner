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

  const toggle = page.getByRole("switch", { name: /Let workers run tasks/ });
  await expect(toggle).toBeChecked();

  await page.getByText("Let workers run tasks for this project", { exact: true }).click();
  await expect(toggle).not.toBeChecked();
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
  expect(rows[0].user).not.toBeNull();

  await page.goto("/settings/workers");
  await page.getByRole("link", { name: "Audit log" }).first().click();
  await expect(page).toHaveURL(/\/settings\/audit/);
  await expect(page.getByRole("heading", { name: "Instance audit log" })).toBeVisible();

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

  expect(await auditRows()).toHaveLength(0);
});

test("changing worker policy without changing whether they run records nothing", async ({ page }) => {
  await signIn(page);
  await page.goto(SETTINGS);
  await page.getByRole("button", { name: "Workers", exact: true }).first().click();

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

test("a refused save leaves no record of a decision that never happened", async ({ request }) => {
  await signInApi(request, ADMIN_USERNAME, ADMIN_PASSWORD);
  const response = await request.put(`/api/projects/${PROJECT_KEY}`, {
    headers: SAME_ORIGIN,
    data: { worker: { enabled: false }, gitlabHost: "http://gitlab.internal" },
  });

  expect(response.status()).toBe(400);
  expect(await auditRows()).toHaveLength(0);

  const handle = await db();
  const project = await handle.collection("projects").findOne({ _id: PROJECT_ID });
  expect(project?.worker?.enabled).toBe(true);
});

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

  await signInApi(request, ADMIN_USERNAME, ADMIN_PASSWORD);
  const response = await request.get("/api/admin/audit");

  expect(response.status()).toBe(403);
});

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

  const stopped = page.getByRole("row").filter({ hasText: "Worker told to stop" });
  await expect(stopped).toHaveCount(1);
  await expect(stopped).toContainText(WORKER_NAME);
  await expect(stopped.getByText("Worker told to stop")).toHaveClass(/text-danger/);

  const resumed = page.getByRole("row").filter({ hasText: "Worker told to resume" });
  await expect(resumed).toHaveCount(1);
  await expect(resumed.getByText("Worker told to resume")).toHaveClass(/text-text-muted/);

  await expect(page.getByText(/worker command sent/)).toHaveCount(0);
});
