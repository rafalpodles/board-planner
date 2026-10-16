import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  HANDOVER_REPOSITORY,
  MEMBER_HANDOVER_TASK_NUMBER,
  MEMBER_MACHINE_ID,
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
 * BP-1070. A project lists several repositories and every task inherits all of them: one run in
 * several working trees. A machine takes the task only with a checkout of every repository and a
 * worker that says it can run them together. Over HTTP with a worker credential, because the claim is
 * a verdict plus an atomic update MongoDB evaluates, and through the task page, because what the
 * reader is told is what they act on.
 */

const APPROVED = "todo";
const ACTIVE = "in_progress";
const AGENT_ID = new mongoose.Types.ObjectId();
const API = new mongoose.Types.ObjectId();
const WEB = new mongoose.Types.ObjectId();
const API_URL = "https://github.com/e2e-owner/api";
const WEB_URL = "https://github.com/e2e-owner/web";
const RUNNABLE = { analysis: [], implementation: [{ key: "implement" }], verification: [], delivery: [] };
const CAPABLE = "multi-repository";

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

async function addTask() {
  const handle = await db();
  const _id = new mongoose.Types.ObjectId();
  const taskNumber = nextNumber++;
  await handle.collection("tasks").insertOne({
    _id,
    project: PROJECT_ID,
    taskNumber,
    title: `several repositories ${taskNumber}`,
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
  });
  return { _id, taskNumber };
}

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test.describe("which machine a project with several repositories is given to", () => {
  const asWorker = (capabilities?: string) => ({
    authorization: `Bearer ${WORKER_CREDENTIAL}`,
    "x-worker-id": String(WORKER_ID),
    "x-cp-protocol": "1",
    ...(capabilities ? { "x-cp-capabilities": capabilities } : {}),
  });

  async function claim(request: APIRequestContext, capabilities?: string) {
    return request.post(`/api/projects/${PROJECT_ID}/tasks/claim`, {
      headers: asWorker(capabilities),
      data: { runId: randomUUID() },
    });
  }

  async function heartbeat(request: APIRequestContext, repos: string[], capabilities?: string) {
    const answer = await request.post(`/api/workers/${WORKER_ID}/heartbeat`, {
      headers: asWorker(capabilities),
      data: { repos: repos.map((remote) => ({ remote, path: `/e2e/${remote.split("/").pop()}` })) },
    });
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
      username: "worker-multi-repository",
      fullName: "rig · worker-multi-repository",
      password: await bcrypt.hash("unused-worker-multi-repository", 4),
      email: "",
      kind: "machine",
      role: "member",
      createdAt: new Date(),
    });
    await handle.collection("workers").updateOne({ _id: WORKER_ID }, { $set: { owner: ADMIN_ID, identity } });
    await listRepositories(BOTH);
  });

  test("a machine holding both checkouts, with a worker that can run several, takes the task", async ({ request }) => {
    await machineHolds(`${API_URL}.git`, `${WEB_URL}.git`);
    const { _id } = await addTask();

    const answer = await claim(request, CAPABLE);

    expect(answer.status(), await answer.text()).toBe(200);
    expect((await answer.json())._id).toBe(String(_id));
    expect((await answer.json()).status).toBe(ACTIVE);
  });

  test("a worker that does not say it can run several is refused, whatever it holds", async ({ request }) => {
    await machineHolds(`${API_URL}.git`, `${WEB_URL}.git`);
    const { _id } = await addTask();

    const answer = await claim(request);

    expect(answer.status()).toBe(403);
    expect((await answer.json()).error).toContain("update the worker");
    expect((await (await db()).collection("tasks").findOne({ _id }))?.status).toBe(APPROVED);
  });

  test("a machine holding one of them is refused, with the one it lacks named", async ({ request }) => {
    await machineHolds(`${API_URL}.git`);
    await addTask();

    const answer = await claim(request, CAPABLE);

    expect(answer.status()).toBe(403);
    expect((await answer.json()).error).toBe("this worker reports no checkout of web");
  });

  test("two entries that read as one repository are not both held by one checkout", async ({ request }) => {
    await listRepositories([
      { _id: API, url: "e2e-owner/api", name: "first" },
      { _id: WEB, url: "https://github.com/e2e-owner/api", name: "second" },
    ]);
    await machineHolds(`${API_URL}.git`);
    await addTask();

    const answer = await claim(request, CAPABLE);

    expect(answer.status()).toBe(403);
    expect((await answer.json()).error).toBe("this worker reports no checkout of second");
  });

  // What the worker is told it serves is decided by the heartbeat route, not the claim route
  test("the heartbeat lists every repository to a capable worker and offers the project to no other", async ({ request }) => {
    const remotes = [`${WEB_URL}.git`, `${API_URL}.git`];

    const capable = await heartbeat(request, remotes, CAPABLE);
    expect(capable.assignments).toHaveLength(1);
    expect(capable.assignments[0].remote).toBe(`${API_URL}.git`);
    expect(capable.assignments[0].repositories).toEqual([
      { id: String(API), name: "api", remote: `${API_URL}.git` },
      { id: String(WEB), name: "web", remote: `${WEB_URL}.git` },
    ]);

    expect((await heartbeat(request, remotes)).assignments).toEqual([]);
    expect((await heartbeat(request, [`${API_URL}.git`], CAPABLE)).assignments).toEqual([]);
  });

  // The worker reads its assignments from this route between heartbeats, so it must answer the same
  test("the worker's own read lists the repositories to a capable worker and offers none to another", async ({ request }) => {
    await machineHolds(`${API_URL}.git`, `${WEB_URL}.git`);

    const capable = await request.get(`/api/workers/${WORKER_ID}`, { headers: asWorker(CAPABLE) });
    expect(capable.status(), await capable.text()).toBe(200);
    expect((await capable.json()).assignments[0].repositories.map((r: { id: string }) => r.id)).toEqual([String(API), String(WEB)]);

    const other = await request.get(`/api/workers/${WORKER_ID}`, { headers: asWorker() });
    expect((await other.json()).assignments).toEqual([]);
  });

  test("a worker's capability is kept only until its next heartbeat that does not say it", async ({ request }) => {
    await heartbeat(request, [`${API_URL}.git`], CAPABLE);
    expect((await (await db()).collection("workers").findOne({ _id: WORKER_ID }))?.capabilities).toEqual([CAPABLE]);

    await heartbeat(request, [`${API_URL}.git`]);
    expect((await (await db()).collection("workers").findOne({ _id: WORKER_ID }))?.capabilities).toEqual([]);
  });

  // The control: a project with one repository needs neither, as before
  test("a project with one repository still gives its task to a worker that says nothing", async ({ request }) => {
    await listRepositories([BOTH[0]]);
    await machineHolds(`${API_URL}.git`);
    const { _id } = await addTask();

    const answer = await claim(request);

    expect(answer.status(), await answer.text()).toBe(200);
    expect((await answer.json())._id).toBe(String(_id));
  });
});

test.describe("what the task page tells the reader about their machine", () => {
  const notice = (page: Page) => page.getByRole("complementary").getByTestId("handover-notice");
  const waiting = (page: Page) => page.getByRole("complementary").getByTestId("handover-waiting");
  const SITE = "https://github.com/e2e/handover-site";

  test.beforeEach(async () => {
    await seed();
    await seedAgents();
    await seedMemberHandover();
    await setBoardReadiness({ repositoryUrl: HANDOVER_REPOSITORY, workerEnabled: true });
    await seedMachine("git@github.com:e2e/handover-board.git");
    await listRepositories([
      { _id: API, url: HANDOVER_REPOSITORY, name: "app" },
      { _id: WEB, url: SITE, name: "site" },
    ]);
  });

  async function machine(repos: string[], capabilities: string[]) {
    await (await db()).collection("workers").updateOne(
      { _id: MEMBER_MACHINE_ID },
      { $set: { repos: repos.map((remote) => ({ remote, path: `/Users/someone/${remote.split("/").pop()}` })), capabilities } }
    );
  }

  async function open(page: Page) {
    await signIn(page, "member");
    await page.goto(`/projects/${PROJECT_KEY}/tasks/${MEMBER_HANDOVER_TASK_NUMBER}`);
    await expect(page.getByText(`${PROJECT_KEY}-${MEMBER_HANDOVER_TASK_NUMBER}`).first()).toBeVisible();
  }

  test("names the repository the reader's machine has no checkout of", async ({ page }) => {
    await machine(["git@github.com:e2e/handover-board.git"], [CAPABLE]);
    await open(page);

    await expect(notice(page)).toHaveAttribute("data-reason", "machine-missing-repository");
    await expect(notice(page)).toContainText("has no checkout of site");
    await expect(waiting(page)).toHaveCount(0);
  });

  test("says the worker is too old when the machine has every checkout but cannot run several", async ({ page }) => {
    await machine(["git@github.com:e2e/handover-board.git", `${SITE}.git`], []);
    await open(page);

    await expect(notice(page)).toHaveAttribute("data-reason", "machine-needs-update");
    await expect(notice(page)).toContainText("its worker is too old");
  });

  // The control: every checkout and a worker that can run them is a task waiting for its machine
  test("waits for the machine when it has every checkout and can run them", async ({ page }) => {
    await machine(["git@github.com:e2e/handover-board.git", `${SITE}.git`], [CAPABLE]);
    await open(page);

    await expect(waiting(page)).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
  });

  test("says nothing of it on a board that lists one repository", async ({ page }) => {
    await listRepositories([{ _id: API, url: HANDOVER_REPOSITORY, name: "app" }]);
    await machine(["git@github.com:e2e/handover-board.git"], []);
    await open(page);

    await expect(waiting(page)).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
  });
});
