import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  ADMIN_ID,
  API_TOKEN,
  E2E_MONGODB_URI,
  MEMBER_FULL_NAME,
  MEMBER_ID,
  PROJECT_ID,
  PROJECT_KEY,
  WORKER_CREDENTIAL,
  WORKER_ID,
  seed,
} from "./seed";
import { signIn } from "./session";
import { SAME_ORIGIN } from "./api";

/**
 * BP-420. A machine takes a task only when its owner handed it to themselves, so work a colleague
 * hands over sat inert with nothing that could make it run. Accept on the task is the owner's
 * consent: its own request, from a person's session only, after which the claim takes the task.
 *
 * The member plays the colleague who hands work over and the admin the assignee whose machine runs
 * it. Driven through the real task screen, the real accept route and the real claim route, because
 * the defect was the seam between the notice that says "nothing will run this" and the filter
 * that refuses it.
 */

test.beforeEach(seed);

const APPROVED = "todo";
const ACTIVE = "in_progress";
const REMOTE = "e2e-owner/e2e-repo";
const RUNNABLE = { analysis: [], implementation: [{ key: "implement" }], verification: [], delivery: [] };
const AGENT_ID = new mongoose.Types.ObjectId();

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

let nextNumber = 760;

/** A task in the approved column naming the board's agent — everything a claim wants but the hand-over */
async function addTask(over: Record<string, unknown> = {}): Promise<{ id: mongoose.Types.ObjectId; number: number }> {
  const handle = await db();
  const _id = new mongoose.Types.ObjectId();
  const taskNumber = nextNumber++;
  await handle.collection("tasks").insertOne({
    _id,
    project: PROJECT_ID,
    taskNumber,
    title: `hand-over ${taskNumber}`,
    description: "",
    priority: "medium",
    category: "user-story",
    status: APPROVED,
    assignee: null,
    assignedBy: null,
    agent: AGENT_ID,
    checklist: [],
    blockedBy: [],
    watchers: [],
    relations: [],
    linkedPRs: [],
    customFieldValues: {},
    execution: { runId: "", workerId: "", attempts: 0, startedAt: null, lastError: "" },
    order: 0,
    createdBy: MEMBER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });
  await handle.collection("projects").updateOne({ _id: PROJECT_ID }, { $max: { taskCounter: taskNumber } });
  return { id: _id, number: taskNumber };
}

const read = async (id: mongoose.Types.ObjectId) =>
  (await (await db()).collection("tasks").findOne({ _id: id }))!;

test.beforeEach(async () => {
  const handle = await db();
  // The block catalog is written at server boot and seed() empties the database
  await handle.collection("agentblocks").updateOne(
    { key: "implement" },
    { $set: { key: "implement", kind: "step", name: "Implement", description: "", prompt: "make the change", capability: "edit", model: "opus", fallbackModel: "sonnet", deterministic: false, builtIn: true } },
    { upsert: true }
  );
  // The board's own agent, which anybody who can edit the task may choose
  await handle.collection("agents").updateOne(
    { _id: AGENT_ID },
    { $set: { _id: AGENT_ID, name: "The board's agent", description: "", scope: "project", owner: null, project: PROJECT_ID, composition: RUNNABLE, builtIn: false } },
    { upsert: true }
  );
  await handle.collection("workers").updateOne(
    { _id: WORKER_ID },
    { $set: { owner: ADMIN_ID, repos: [{ remote: REMOTE, path: "/e2e/checkout" }], lastSeenAt: new Date() } }
  );
  await handle.collection("projects").updateOne(
    { _id: PROJECT_ID },
    { $set: { githubRepo: REMOTE, "worker.enabled": true } }
  );
});

function claim(request: APIRequestContext, runId: string) {
  return request.post(`/api/projects/${PROJECT_ID}/tasks/claim`, {
    headers: {
      authorization: `Bearer ${WORKER_CREDENTIAL}`,
      "x-worker-id": String(WORKER_ID),
      "x-cp-protocol": "1",
    },
    data: { runId },
  });
}

async function openTask(page: Page, number: number) {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${number}`);
  await expect(page.getByText(`${PROJECT_KEY}-${number}`).first()).toBeVisible();
}

const rail = (page: Page) => page.getByRole("complementary");
const notice = (page: Page) => rail(page).getByTestId("handover-notice");
const acceptButton = (page: Page) => rail(page).getByTestId("accept-handover");

test("the assignee accepts a colleague's hand-over, and only then does the machine take it", async ({
  page,
  request,
}) => {
  const task = await addTask({ assignee: ADMIN_ID, assignedBy: MEMBER_ID });

  await test.step("before accepting, the machine refuses it", async () => {
    const refused = await claim(request, "run-before-accept");
    expect(refused.status(), await refused.text()).toBe(204);
    expect((await read(task.id)).status).toBe(APPROVED);
  });

  await signIn(page, "admin");
  await openTask(page, task.number);
  await expect(notice(page)).toHaveAttribute("data-reason", /assigned-by-someone-else/);
  await expect(notice(page)).toContainText(`${MEMBER_FULL_NAME} handed this to you`);

  await test.step("Accept is its own request, and records the assignee as the one who handed it over", async () => {
    const accepted = page.waitForResponse(
      (res) => res.request().method() === "POST" && res.url().endsWith(`/tasks/${task.id}/accept`)
    );
    await acceptButton(page).click();
    expect((await accepted).status()).toBe(200);

    const stored = await read(task.id);
    expect(String(stored.assignedBy)).toBe(String(ADMIN_ID));
    expect(stored.pmAssignedFor ?? null).toBeNull();
  });

  await test.step("the screen and the history say so", async () => {
    await page.getByRole("tab", { name: /^History/ }).click();
    await expect(page.getByText(`accepted the hand-over from ${MEMBER_FULL_NAME}`)).toBeVisible();
    await expect(acceptButton(page)).toHaveCount(0);
  });

  await test.step("and the machine takes it", async () => {
    const claimed = await claim(request, "run-after-accept");
    expect(claimed.status(), await claimed.text()).toBe(200);
    expect(String((await claimed.json())._id)).toBe(String(task.id));
    expect((await read(task.id)).status).toBe(ACTIVE);
  });
});

test("a task assigned before the board recorded who hands work over is accepted the same way", async ({
  page,
  request,
}) => {
  const task = await addTask({ assignee: ADMIN_ID, assignedBy: null });
  await signIn(page, "admin");
  await openTask(page, task.number);
  await expect(notice(page)).toHaveAttribute("data-reason", /assigner-unrecorded/);

  const accepted = page.waitForResponse((res) => res.url().endsWith(`/tasks/${task.id}/accept`));
  await acceptButton(page).click();
  expect((await accepted).status()).toBe(200);

  const claimed = await claim(request, "run-legacy");
  expect(claimed.status(), await claimed.text()).toBe(200);
  expect(String((await claimed.json())._id)).toBe(String(task.id));
});

test("the colleague who handed it over sees it waiting, with nothing to press", async ({ page }) => {
  const task = await addTask({ assignee: ADMIN_ID, assignedBy: MEMBER_ID });
  await signIn(page, "member");
  await openTask(page, task.number);

  await expect(notice(page)).toHaveAttribute("data-reason", /assigned-by-someone-else/);
  await expect(notice(page)).toContainText("handed it to E2E Admin; waiting for them to accept it");
  await expect(acceptButton(page)).toHaveCount(0);
});

test("handing a task over on the task screen says it waits, without reopening the task", async ({ page }) => {
  const task = await addTask();
  await signIn(page, "member");
  await openTask(page, task.number);
  await expect(notice(page)).toHaveAttribute("data-reason", /unassigned/);

  const saved = page.waitForResponse(
    (res) => res.request().method() === "PUT" && res.url().endsWith(`/tasks/${task.id}`)
  );
  await rail(page).getByRole("combobox", { name: "Assignee" }).click();
  await page.getByRole("option", { name: /E2E Admin/ }).click();
  const answer = await (await saved).json();

  // The write itself says it will not run yet, which is what an API or MCP caller reads
  expect(answer.handover).toEqual({
    willRun: false,
    why: expect.stringContaining("it waits for @admin to accept it in the app"),
  });
  await expect(notice(page)).toHaveAttribute("data-reason", /assigned-by-someone-else/);
  await expect(notice(page)).toContainText("handed it to E2E Admin; waiting for them to accept it");
});

test("only the assignee, in a session of their own, can accept", async ({ page, request }) => {
  const task = await addTask({ assignee: ADMIN_ID, assignedBy: MEMBER_ID });
  const url = `/api/projects/${PROJECT_ID}/tasks/${task.id}/accept`;

  await test.step("not the assignee's own API token", async () => {
    const res = await request.post(url, { headers: { authorization: `Bearer ${API_TOKEN}` } });
    expect(res.status(), await res.text()).toBe(403);
    expect((await res.json()).error).toMatch(/interactive session/);
  });

  await test.step("not the colleague who handed it over", async () => {
    await signIn(page, "member");
    const res = await page.request.post(url, { headers: SAME_ORIGIN });
    expect(res.status(), await res.text()).toBe(403);
    expect((await res.json()).error).toMatch(/only the task's assignee/);
  });

  expect(String((await read(task.id)).assignedBy)).toBe(String(MEMBER_ID));

  await test.step("the control: the assignee's own session", async () => {
    await page.context().clearCookies();
    await signIn(page, "admin");
    const res = await page.request.post(url, { headers: SAME_ORIGIN });
    expect(res.status(), await res.text()).toBe(200);
    expect(String((await read(task.id)).assignedBy)).toBe(String(ADMIN_ID));
  });
});
