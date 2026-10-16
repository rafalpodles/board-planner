import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { ADMIN_AUTH } from "./api";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  HANDOVER_REPOSITORY,
  MEMBER_HANDOVER_TASK_NUMBER,
  PROJECT_ID,
  PROJECT_KEY,
  WORKER_CREDENTIAL,
  WORKER_ID,
  seed,
  seedAgents,
  seedMachine,
  seedMemberHandover,
  setBoardReadiness,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-1066. A project lists two repositories, a task names the one it changes, and a machine is
 * offered only the tasks of the repository its assignment names. Over HTTP with a real worker
 * credential, because the claim is a filter MongoDB evaluates, and through the task page, because
 * the picker and the notice are what a person acts on.
 */

const APPROVED = "todo";
const ACTIVE = "in_progress";
const AGENT_ID = new mongoose.Types.ObjectId();
const API = new mongoose.Types.ObjectId();
const WEB = new mongoose.Types.ObjectId();
const API_URL = "https://github.com/e2e-owner/api";
const WEB_URL = "https://github.com/e2e-owner/web";
const RUNNABLE = { analysis: [], implementation: [{ key: "implement" }], verification: [], delivery: [] };

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function listRepositories(entries: { _id: mongoose.Types.ObjectId; url: string; name: string }[]) {
  const handle = await db();
  await handle.collection("projects").updateOne(
    { _id: PROJECT_ID },
    { $set: { repositoryUrl: entries[0].url, repositories: entries }, $unset: { githubRepo: "", gitlabRepo: "" } }
  );
}

const BOTH = [
  { _id: API, url: API_URL, name: "api" },
  { _id: WEB, url: WEB_URL, name: "web" },
];

let nextNumber = 2100;

async function addTask(over: Record<string, unknown> = {}) {
  const handle = await db();
  const _id = new mongoose.Types.ObjectId();
  const taskNumber = nextNumber++;
  await handle.collection("tasks").insertOne({
    _id,
    project: PROJECT_ID,
    taskNumber,
    title: `repository ${taskNumber}`,
    description: "",
    priority: "medium",
    category: "user-story",
    status: APPROVED,
    assignee: ADMIN_ID,
    assignedBy: ADMIN_ID,
    agent: AGENT_ID,
    checklist: [],
    linkedPRs: [],
    blockedBy: [],
    relations: [],
    watchers: [],
    customFieldValues: {},
    order: 0,
    createdBy: ADMIN_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });
  return { _id, taskNumber };
}

async function storedTask(_id: mongoose.Types.ObjectId) {
  return (await db()).collection("tasks").findOne({ _id });
}

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test.describe("which tasks a machine is offered", () => {
  const asWorker = {
    authorization: `Bearer ${WORKER_CREDENTIAL}`,
    "x-worker-id": String(WORKER_ID),
    "x-cp-protocol": "1",
  };

  async function claim(request: APIRequestContext) {
    const answer = await request.post(`/api/projects/${PROJECT_ID}/tasks/claim`, {
      headers: asWorker,
      data: { runId: randomUUID() },
    });
    if (answer.status() === 204) return null;
    expect(answer.status(), await answer.text()).toBe(200);
    return answer.json();
  }

  async function machineHolds(...remotes: string[]) {
    const handle = await db();
    await handle.collection("workers").updateOne(
      { _id: WORKER_ID },
      { $set: { repos: remotes.map((remote) => ({ remote, path: `/e2e/${remote.split("/").pop()}` })), lastSeenAt: new Date() } }
    );
  }

  test.beforeEach(async () => {
    await seed();
    process.env.MONGODB_URI = E2E_MONGODB_URI;
    const handle = await db();
    await handle.collection("tasks").deleteMany({ project: PROJECT_ID, status: APPROVED });
    await handle.collection("agentblocks").updateOne(
      { key: "implement" },
      { $set: { key: "implement", kind: "step", name: "Implement", description: "", prompt: "make the change", capability: "edit", model: "opus", fallbackModel: "sonnet", deterministic: false, builtIn: true } },
      { upsert: true }
    );
    await handle.collection("agents").deleteMany({ _id: AGENT_ID });
    await handle.collection("agents").insertOne({
      _id: AGENT_ID, name: "The owner's own", description: "", scope: "user", owner: ADMIN_ID, project: null, composition: RUNNABLE, builtIn: false,
    });
    const identity = new mongoose.Types.ObjectId();
    await handle.collection("users").insertOne({
      _id: identity,
      username: "worker-task-repository",
      fullName: "rig · worker-task-repository",
      password: await bcrypt.hash("unused-worker-task-repository", 4),
      email: "",
      kind: "machine",
      role: "member",
      createdAt: new Date(),
    });
    await handle.collection("workers").updateOne({ _id: WORKER_ID }, { $set: { owner: ADMIN_ID, identity } });
    await listRepositories(BOTH);
  });

  test("a machine holding only the web checkout is given the web task, and nothing else", async ({ request }) => {
    await machineHolds(`${WEB_URL}.git`);
    const api = await addTask({ repository: String(API) });
    const web = await addTask({ repository: String(WEB) });
    const unnamed = await addTask();

    const claimed = await claim(request);

    expect(claimed._id).toBe(String(web._id));
    expect(claimed.status).toBe(ACTIVE);
    expect(await claim(request)).toBeNull();
    expect((await storedTask(api._id))?.status).toBe(APPROVED);
    expect((await storedTask(unnamed._id))?.status).toBe(APPROVED);
  });

  // The control: the same board, a machine that holds the other checkout, takes the other task
  test("a machine holding only the api checkout is given the api task", async ({ request }) => {
    await machineHolds(`${API_URL}.git`);
    const api = await addTask({ repository: String(API) });
    await addTask({ repository: String(WEB) });

    expect((await claim(request))._id).toBe(String(api._id));
    expect(await claim(request)).toBeNull();
  });

  test("a machine holding both is given the first repository's tasks, the one its assignment names", async ({ request }) => {
    await machineHolds(`${WEB_URL}.git`, `${API_URL}.git`);
    const api = await addTask({ repository: String(API) });
    await addTask({ repository: String(WEB) });

    expect((await claim(request))._id).toBe(String(api._id));
    expect(await claim(request)).toBeNull();
  });

  // The control for the refusals above: a board with one repository takes a task naming none, as before
  test("a board with one repository still gives out a task that names none", async ({ request }) => {
    await listRepositories([BOTH[1]]);
    await machineHolds(`${WEB_URL}.git`);
    const unnamed = await addTask();

    expect((await claim(request))._id).toBe(String(unnamed._id));
  });

  test("a task is written with a listed repository and refused an unlisted one", async ({ request }) => {
    const { _id } = await addTask({ agent: null });

    const refused = await request.put(`/api/projects/${PROJECT_ID}/tasks/${_id}`, {
      headers: ADMIN_AUTH,
      data: { repository: String(new mongoose.Types.ObjectId()) },
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error).toContain(`${WEB} (web)`);
    expect((await storedTask(_id))?.repository ?? null).toBeNull();

    const accepted = await request.put(`/api/projects/${PROJECT_ID}/tasks/${_id}`, {
      headers: ADMIN_AUTH,
      data: { repository: String(WEB) },
    });
    expect(accepted.status(), await accepted.text()).toBe(200);
    expect((await storedTask(_id))?.repository).toBe(String(WEB));

    const cleared = await request.put(`/api/projects/${PROJECT_ID}/tasks/${_id}`, {
      headers: ADMIN_AUTH,
      data: { repository: "" },
    });
    expect(cleared.status()).toBe(200);
    expect((await storedTask(_id))?.repository ?? null).toBeNull();
  });
});

test.describe("choosing the repository on the task page", () => {
  const notice = (page: Page) => page.getByRole("complementary").getByTestId("handover-notice");
  const waiting = (page: Page) => page.getByRole("complementary").getByTestId("handover-waiting");
  const row = (page: Page) => page.getByRole("complementary").getByRole("combobox").filter({ hasText: /^Repository/ });

  test.beforeEach(async () => {
    await seed();
    await seedAgents();
    await seedMemberHandover();
    await setBoardReadiness({ repositoryUrl: HANDOVER_REPOSITORY, workerEnabled: true });
    await seedMachine("git@github.com:e2e/handover-board.git");
    await listRepositories([
      { _id: API, url: HANDOVER_REPOSITORY, name: "app" },
      { _id: WEB, url: "https://github.com/e2e/handover-site", name: "site" },
    ]);
  });

  async function openAsMember(page: Page) {
    await signIn(page, "member");
    await page.goto(`/projects/${PROJECT_KEY}/tasks/${MEMBER_HANDOVER_TASK_NUMBER}`);
    await expect(page.getByText(`${PROJECT_KEY}-${MEMBER_HANDOVER_TASK_NUMBER}`).first()).toBeVisible();
  }

  test("says a task that names none will not be taken, and saves the repository that is picked", async ({ page }) => {
    await openAsMember(page);

    await expect(notice(page)).toHaveAttribute("data-reason", "repository-not-chosen");
    await expect(notice(page)).toContainText("lists several repositories and the task names none");
    await expect(row(page)).toContainText("Choose one");

    await row(page).click();
    const saved = page.waitForResponse((res) => res.request().method() === "PUT" && /\/tasks\/[^/]+$/.test(res.url()));
    await page.getByRole("option", { name: "site" }).click();
    const response = await saved;

    expect(response.status(), await response.text()).toBe(200);
    expect((await response.json()).repository).toBe(String(WEB));
    await expect(notice(page)).toHaveCount(0);
    await expect(waiting(page)).toBeVisible();

    await page.reload();
    await expect(row(page)).toContainText("site");
    await expect(notice(page)).toHaveCount(0);
  });

  async function taskNames(repository: mongoose.Types.ObjectId) {
    const handle = await db();
    await handle.collection("tasks").updateOne({ taskNumber: MEMBER_HANDOVER_TASK_NUMBER }, { $set: { repository: String(repository) } });
  }

  // The machine holds the checkout of "app" only, so a machine will never take a task for "site"
  test("says the reader's machine will not take a task naming a repository it does not hold", async ({ page }) => {
    await taskNames(WEB);
    await openAsMember(page);

    await expect(notice(page)).toHaveAttribute("data-reason", "repository-not-served");
    await expect(notice(page)).toContainText("Your machine holds the checkout of app");
    await expect(waiting(page)).toHaveCount(0);
  });

  // The control: the same machine and board, a task naming the repository the machine holds
  test("waits for the machine, and says so, when the task names the repository it holds", async ({ page }) => {
    await taskNames(API);
    await openAsMember(page);

    await expect(waiting(page)).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
  });

  test("offers no repository row on a board with one", async ({ page }) => {
    await listRepositories([{ _id: API, url: HANDOVER_REPOSITORY, name: "app" }]);
    await openAsMember(page);

    await expect(waiting(page)).toBeVisible();
    await expect(row(page)).toHaveCount(0);
  });
});
