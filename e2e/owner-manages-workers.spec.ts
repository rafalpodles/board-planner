import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { SAME_ORIGIN } from "./api";
import {
  E2E_MONGODB_URI,
  OWNER_ID,
  PROJECT_ID,
  PROJECT_KEY,
  WORKER_CREDENTIAL,
  WORKER_ID,
  seed,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-736. A project's owner — a Grant `relation: "owner"`, no standing on the instance — manages
 * the project's worker settings: the Workers section is theirs, and so is the API behind it. A
 * member is still refused, on the screen and on the wire. An instance admin keeps a lock that
 * wins over the owner: set from the same section, it refuses the owner's switch and stops the
 * project reaching a machine, which is checked on the machine's own credential.
 */

const SETTINGS = `/projects/${PROJECT_KEY}/settings`;
const REPOSITORY = "git@github.com:e2e-owner/owner-managed.git";

test.beforeEach(async () => {
  await seed();
  await onProject({ "worker.enabled": false, repositoryUrl: REPOSITORY });
});

test.afterAll(async () => {
  await mongoose.disconnect();
});

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

async function onProject(update: Record<string, unknown>) {
  await (await db()).collection("projects").updateOne({ _id: PROJECT_ID }, { $set: update });
}

async function storedWorker() {
  const project = await (await db()).collection("projects").findOne({ _id: PROJECT_ID });
  return project?.worker as { enabled: boolean; lockedByInstance?: boolean; policy: { baseBranch: string } };
}

const workersNav = (page: Page) => page.getByRole("button", { name: "Workers", exact: true });
const enableSwitch = (page: Page) =>
  page.getByRole("switch", { name: "Let workers run tasks for this project" });
const lockSwitch = (page: Page) =>
  page.getByRole("switch", { name: "Lock workers off for this project" });

async function openWorkers(page: Page) {
  await page.goto(SETTINGS);
  await workersNav(page).first().click();
  await expect(enableSwitch(page)).toBeVisible();
}

async function saveWorkers(page: Page) {
  const written = page.waitForResponse(
    (res) => res.request().method() === "PUT" && res.url().endsWith(`/api/projects/${PROJECT_KEY}`)
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  const response = await written;
  expect(response.status(), await response.text()).toBe(200);
}

const putWorker = (request: APIRequestContext, worker: Record<string, unknown>) =>
  request.put(`/api/projects/${PROJECT_KEY}`, { headers: SAME_ORIGIN, data: { worker } });

async function assignedProjects(request: APIRequestContext): Promise<string[]> {
  const response = await request.post(`/api/workers/${WORKER_ID}/heartbeat`, {
    headers: {
      Authorization: `Bearer ${WORKER_CREDENTIAL}`,
      "x-worker-id": String(WORKER_ID),
      "x-cp-protocol": "1",
    },
    data: { repos: [{ remote: REPOSITORY, path: "/checkouts/owner-managed" }] },
  });
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()).assignments as { project: string }[]).map((a) => a.project);
}

test("a project owner who is not an instance admin switches workers on and sets the base branch", async ({
  page,
}) => {
  await signIn(page, "owner");
  await openWorkers(page);

  await expect(enableSwitch(page)).toBeEnabled();
  await expect(enableSwitch(page)).not.toBeChecked();
  await expect(lockSwitch(page)).toHaveCount(0);

  await enableSwitch(page).check({ force: true });
  await page.getByLabel("Base branch").fill("develop");
  await saveWorkers(page);

  const worker = await storedWorker();
  expect(worker.enabled).toBe(true);
  expect(worker.policy.baseBranch).toBe("develop");
  const audit = await (await db())
    .collection("instanceauditlogs")
    .findOne({ action: "project_workers_enabled", target: PROJECT_KEY });
  expect(String(audit?.user)).toBe(String(OWNER_ID));
});

test("a member is shown no Workers section, and the API refuses them 403", async ({ page }) => {
  await signIn(page, "member");
  await page.goto(SETTINGS);
  await expect(page.getByRole("button", { name: "Task fields", exact: true }).first()).toBeVisible();
  await expect(workersNav(page)).toHaveCount(0);

  const refused = await putWorker(page.context().request, { enabled: true });
  expect(refused.status()).toBe(403);
  expect((await storedWorker()).enabled).toBe(false);
});

test("an instance admin's lock wins over the owner, on the screen, on the API and on the machine", async ({
  page,
  browser,
  request,
}) => {
  // The seeded machine belongs to the owner, whose grant is what it reaches the project through
  await (await db()).collection("workers").updateOne({ _id: WORKER_ID }, { $set: { owner: OWNER_ID } });
  await onProject({ "worker.enabled": true });
  expect(await assignedProjects(request)).toEqual([String(PROJECT_ID)]);

  await signIn(page, "admin");
  await openWorkers(page);
  await lockSwitch(page).check({ force: true });
  await saveWorkers(page);
  expect((await storedWorker()).lockedByInstance).toBe(true);

  expect(await assignedProjects(request)).toEqual([]);

  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage, "owner");
  await openWorkers(ownerPage);
  await expect(ownerPage.getByTestId("workers-locked")).toContainText(
    "An instance admin has locked workers off."
  );
  await expect(enableSwitch(ownerPage)).toBeDisabled();
  await expect(lockSwitch(ownerPage)).toHaveCount(0);

  await onProject({ "worker.enabled": false });
  const refused = await putWorker(ownerContext.request, { enabled: true });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error).toBe(
    "An instance admin has locked workers off for this project"
  );
  const unlock = await putWorker(ownerContext.request, { lockedByInstance: false });
  expect(unlock.status()).toBe(403);
  const worker = await storedWorker();
  expect(worker.enabled).toBe(false);
  expect(worker.lockedByInstance).toBe(true);
  await ownerContext.close();
});
