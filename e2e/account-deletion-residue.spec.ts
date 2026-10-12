import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  HELD_TASK_ID,
  HELD_TASK_KEY,
  HELD_TASK_NUMBER,
  MEMBER_ID,
  MEMBER_PASSWORD,
  PROJECT_ID,
  PROJECT_KEY,
  WORKER_CREDENTIAL,
  WORKER_ID,
  seed,
  taskFactory,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-1036. What BP-946's erasure still left: a personal agent and the name its owner gave it, the
 * blocks a person authored, the decision panel's line about who answered, and an export that did not
 * say what the account holds about their own use of it.
 *
 * As the person: download the data, read what is in it, delete the account. Then the database, and
 * the held task as an administrator sees it.
 */

const AGENT_NAME = "The member's night shift agent";
const MEMBERS_AGENT_TASK_NUMBER = 91;
const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const AGENT_ID = new mongoose.Types.ObjectId();
const BLOCK_ID = new mongoose.Types.ObjectId();
const AGENT_TASK_ID = new mongoose.Types.ObjectId();
const OTHERS_AGENT_ID = new mongoose.Types.ObjectId();

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function seedWhatTheMemberAuthored() {
  const handle = await db();
  const now = new Date();
  await handle.collection("agents").insertMany([
    {
      _id: AGENT_ID,
      name: AGENT_NAME,
      description: "Runs on my own tasks",
      scope: "user",
      owner: MEMBER_ID,
      project: null,
      composition: { analysis: [], implementation: [{ key: "implement" }], verification: [], delivery: [] },
      builtIn: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: OTHERS_AGENT_ID,
      name: "An administrator's own agent",
      description: "",
      scope: "user",
      owner: ADMIN_ID,
      project: null,
      composition: {},
      builtIn: false,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await handle.collection("tasks").insertOne(
    taskFactory(now)({
      _id: AGENT_TASK_ID,
      taskNumber: MEMBERS_AGENT_TASK_NUMBER,
      title: "Run by the member's agent",
      status: "todo",
      createdBy: MEMBER_ID,
      assignee: MEMBER_ID,
      agent: AGENT_ID,
    })
  );
  await handle.collection("agentruns").insertOne({
    project: PROJECT_ID,
    task: AGENT_TASK_ID,
    taskKey: `${PROJECT_KEY}-${MEMBERS_AGENT_TASK_NUMBER}`,
    agent: AGENT_ID,
    agentName: AGENT_NAME,
    outcome: "delivered",
    startedAt: now,
    finishedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await handle.collection("agentblocks").insertOne({
    _id: BLOCK_ID,
    key: "members-own-gate",
    kind: "gate",
    name: "Written by the member",
    description: "",
    builtIn: false,
    gateKind: "size",
    params: {},
    capability: "read-only",
    createdBy: MEMBER_ID,
    createdAt: now,
    updatedAt: now,
  });
  await handle.collection("activitylogs").insertOne({
    task: AGENT_TASK_ID,
    user: MEMBER_ID,
    action: "updated",
    field: "title",
    oldValue: "Before",
    newValue: "Run by the member's agent",
    createdAt: now,
  });
}

/** The machine holds a change the gate refused, and the member is the person who declined it. */
async function aDecisionTheMemberDeclined(request: import("@playwright/test").APIRequestContext) {
  const created = await request.post(`/api/workers/${WORKER_ID}/decisions`, {
    headers: { Authorization: `Bearer ${WORKER_CREDENTIAL}`, "X-Worker-Id": String(WORKER_ID), "X-CP-Protocol": "1" },
    data: {
      taskId: String(HELD_TASK_ID),
      runId: "e2e-run-0001",
      gate: "protected-paths",
      files: ["package.json"],
      protectedFiles: ["package.json"],
      patch: 'diff --git a/package.json b/package.json\n+    "build": "next build"\n',
      patchTruncated: false,
      patchSha256: "b".repeat(64),
      commit: COMMIT,
      taskKey: HELD_TASK_KEY,
      title: "Held by a live worker run",
      acceptable: true,
      unacceptableReason: "",
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const handle = await db();
  await handle
    .collection("tasks")
    .updateOne(
      { _id: HELD_TASK_ID },
      { $set: { "decision.state": "declined", "decision.decidedBy": MEMBER_ID, "decision.decidedAt": new Date() } }
    );
}

test.beforeEach(async () => {
  await seed();
  await seedWhatTheMemberAuthored();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

async function deleteOwnAccount(page: Page) {
  await page.goto("/settings/profile");
  await expect(page.getByRole("heading", { name: "Your data" })).toBeVisible();
  await page.getByRole("button", { name: "Delete my account" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete your account?" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Current password").fill(MEMBER_PASSWORD);
  const [deletion] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === "/api/users/me" && r.request().method() === "DELETE"),
    dialog.getByRole("button", { name: "Delete my account" }).click(),
  ]);
  expect(deletion.status()).toBe(200);
  await expect(page).toHaveURL(/\/login/);
}

test("the export holds the person's sessions, changes and agents; deleting removes the agents and the panel says Deleted user", async ({
  page,
  request,
}) => {
  await aDecisionTheMemberDeclined(request);

  await signIn(page, "member");
  await page.goto("/settings/profile");
  await expect(page.getByRole("heading", { name: "Your data" })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download my data" }).click(),
  ]);
  const raw = readFileSync((await download.path())!, "utf8");
  const exported = JSON.parse(raw);

  expect(exported.personalAgents).toEqual([expect.objectContaining({ name: AGENT_NAME, description: "Runs on my own tasks" })]);
  expect(exported.activity).toEqual([
    expect.objectContaining({ task: `${PROJECT_KEY}-${MEMBERS_AGENT_TASK_NUMBER}`, field: "title", from: "Before" }),
  ]);
  expect(exported.sessions.length).toBeGreaterThan(0);
  expect(Array.isArray(exported.consents)).toBe(true);
  expect(raw).not.toContain("An administrator's own agent");
  expect(raw).not.toMatch(/tokenHash|"hash"/);

  await deleteOwnAccount(page);

  const handle = await db();
  expect(await handle.collection("agents").countDocuments({ _id: AGENT_ID })).toBe(0);
  expect(await handle.collection("agents").countDocuments({ _id: OTHERS_AGENT_ID })).toBe(1);
  expect(await handle.collection("tasks").findOne({ _id: AGENT_TASK_ID })).toMatchObject({ agent: null, assignee: null });
  const run = await handle.collection("agentruns").findOne({ task: AGENT_TASK_ID });
  expect(run).toMatchObject({ agent: null, agentName: "Deleted agent" });
  expect(JSON.stringify(run)).not.toContain(AGENT_NAME);
  expect(await handle.collection("agentblocks").findOne({ _id: BLOCK_ID })).toMatchObject({ createdBy: null });

  await signIn(page, "admin");
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${HELD_TASK_NUMBER}`);
  await expect(page.getByLabel("Task title")).toHaveValue(/Held by a live worker run/);
  await expect(page.getByTestId("decision-decided-by")).toContainText("Declined by Deleted user");
});

test("the control: while the account exists the panel names the person who answered", async ({ page, request }) => {
  await aDecisionTheMemberDeclined(request);
  await signIn(page, "admin");
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${HELD_TASK_NUMBER}`);
  await expect(page.getByLabel("Task title")).toHaveValue(/Held by a live worker run/);
  await expect(page.getByTestId("decision-decided-by")).toContainText(/Declined by (?!Deleted user)\S+/);
  expect(await (await db()).collection("agents").countDocuments({ _id: AGENT_ID })).toBe(1);
});
