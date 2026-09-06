import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { changeStatus, claimNextTask, releaseTask, updateTask } from "@/lib/task-service";
import "@/models/agent";
import { ADMIN_AUTH, MEMBER_AUTH } from "./api";
import {
  ADMIN_ID,
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  E2E_MONGODB_URI,
  MEMBER_ID,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  PROJECT_ID,
  PROJECT_KEY,
  WORKER_CREDENTIAL,
  WORKER_ID,
  seed,
} from "./seed";
import { signIn as arriveSignedIn, signInThroughForm } from "./session";

const APPROVED = "todo";
const ACTIVE = "in_progress";
const OWNER = ADMIN_ID;
const IDENTITY = "6a70afff45d39cd9bc8bb5ff";
const WORKER = "w-claim-ownership";
const AGENT_ID = new mongoose.Types.ObjectId();

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

let nextNumber = 900;

async function addTask(over: Record<string, unknown> = {}): Promise<mongoose.Types.ObjectId> {
  const handle = await db();
  const _id = new mongoose.Types.ObjectId();
  await handle.collection("tasks").insertOne({
    _id,
    project: PROJECT_ID,
    taskNumber: nextNumber++,
    title: `claim ownership ${nextNumber}`,
    description: "",
    priority: "medium",
    category: "user-story",
    status: APPROVED,
    assignee: OWNER,
    assignedBy: OWNER,
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
  return _id;
}

async function addLegacyTask(over: Record<string, unknown> = {}): Promise<mongoose.Types.ObjectId> {
  const _id = await addTask(over);
  const handle = await db();
  await handle.collection("tasks").updateOne({ _id }, { $unset: { assignedBy: "" } });
  return _id;
}

async function read(taskId: mongoose.Types.ObjectId) {
  const handle = await db();
  const task = await handle.collection("tasks").findOne({ _id: taskId });
  return {
    status: task?.status as string,
    assignee: task?.assignee ? String(task.assignee) : null,
    assigneeType: task?.assignee?._bsontype ?? typeof task?.assignee,
    execution: (task?.execution ?? {}) as Record<string, unknown>,
  };
}

test.beforeEach(async () => {
  await seed();
  process.env.MONGODB_URI = E2E_MONGODB_URI;

  const handle = await db();
  await handle.collection("tasks").deleteMany({ project: PROJECT_ID, status: APPROVED });
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test.describe("what a claim requires", () => {
  test("an approved column full of unassigned work is left alone", async () => {
    const untouched = await addTask({ assignee: null, assignedBy: null, agent: null });
    await addTask({ assignee: null, assignedBy: null, agent: null });
    await addTask({ assignee: null, assignedBy: null, agent: null });

    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER))
    ).toBeNull();
    expect((await read(untouched)).status).toBe(APPROVED);
  });

  test("a task the owner assigned to themselves is taken, and stays assigned to them", async () => {
    const handed = await addTask();

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER));
    expect(String(claimed?._id)).toBe(String(handed));

    const after = await read(handed);
    expect(after.status).toBe(ACTIVE);
    expect(after.assignee).toBe(String(OWNER));
    expect(after.execution.assignedByRun).toBe(false);
  });

  test("a task assigned to somebody else is not taken", async () => {
    await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID });

    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER))
    ).toBeNull();
  });

  test("a task assigned to the owner by somebody else is not taken", async () => {
    await addTask({ assignee: OWNER, assignedBy: MEMBER_ID });

    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER))
    ).toBeNull();
  });

  test("unassigned work in the column does not hide the one task that was handed over", async () => {
    await addTask({ assignee: null, assignedBy: null, agent: null });
    const handed = await addTask({ order: 5 });

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER));
    expect(String(claimed?._id)).toBe(String(handed));
  });

  test("a task assigned to the machine's own identity is not taken", async () => {
    await addTask({ assignee: IDENTITY, assignedBy: IDENTITY });

    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER))).toBeNull();
  });

  test("claims nothing for a machine whose owner is unset", async () => {
    const untouched = await addTask({ assignee: null, assignedBy: null });

    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", null)).toBeNull();
    expect((await read(untouched)).status).toBe(APPROVED);
  });
});

test.describe("a task from before assignedBy existed", () => {
  test("is not claimed, even though its assignee is the machine's owner", async () => {
    const legacy = await addLegacyTask();

    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER))).toBeNull();
    expect((await read(legacy)).status).toBe(APPROVED);
  });

  test("really has no assignedBy key at all, not a null one", async () => {
    const legacy = await addLegacyTask();
    const handle = await db();

    const stored = await handle.collection("tasks").findOne({ _id: legacy });
    expect("assignedBy" in (stored ?? {})).toBe(false);
  });

  test("becomes claimable once its assignee takes it on, through the ordinary write", async () => {
    const legacy = await addLegacyTask();

    const assigned = await updateTask(
      String(PROJECT_ID),
      String(legacy),
      { assignee: ADMIN_USERNAME },
      String(OWNER)
    );
    expect(assigned.ok).toBe(true);

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER));
    expect(String(claimed?._id)).toBe(String(legacy));
  });

  test("is not adopted by a third writer that merely echoes its assignee", async () => {
    const legacy = await addLegacyTask();

    const echoed = await updateTask(
      String(PROJECT_ID),
      String(legacy),
      { assignee: ADMIN_USERNAME, title: "renamed by somebody else" },
      String(MEMBER_ID)
    );
    expect(echoed.ok).toBe(true);

    const handle = await db();
    const stored = await handle.collection("tasks").findOne({ _id: legacy });
    expect(stored?.assignedBy ?? null).toBeNull();
    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER))).toBeNull();
  });
});

test.describe("blockers", () => {
  const DONE = "done";

  test("a task whose blocker is still open is passed over", async () => {
    const blocker = await addTask({ status: "in_review", order: 1 });
    const blocked = await addTask({ blockedBy: [blocker], order: 2 });

    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER))
    ).toBeNull();
    expect((await read(blocked)).status).toBe(APPROVED);
  });

  test("the blocker is taken first, against board order", async () => {
    const blocker = await addTask({ order: 2 });
    const blocked = await addTask({ blockedBy: [blocker], order: 1 });

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER));

    expect(String(claimed?._id)).toBe(String(blocker));
    expect((await read(blocked)).status).toBe(APPROVED);
  });

  test("a blocker orphaned by a deleted column still counts as unfinished", async () => {
    const blocker = await addTask({ status: "column_since_deleted", order: 1 });
    await addTask({ blockedBy: [blocker], order: 2 });

    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER))
    ).toBeNull();
  });

  test("the unblocked sibling behind it is claimed instead", async () => {
    const blocker = await addTask({ status: "in_review", order: 1 });
    const blocked = await addTask({ blockedBy: [blocker], order: 2 });
    const free = await addTask({ order: 3 });

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER));

    expect(String(claimed?._id)).toBe(String(free));
    expect((await read(blocked)).status).toBe(APPROVED);
  });

  test("finishing the blocker makes the task claimable", async () => {
    const blocker = await addTask({ status: "in_review", order: 1 });
    const blocked = await addTask({ blockedBy: [blocker], order: 2 });

    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER))
    ).toBeNull();

    const handle = await db();
    await handle.collection("tasks").updateOne({ _id: blocker }, { $set: { status: DONE } });

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-2", String(OWNER));
    expect(String(claimed?._id)).toBe(String(blocked));
    expect((await read(blocked)).status).toBe(ACTIVE);
  });
});

test.describe("releasing gives back exactly what the claim took", () => {
  test("a hand-over survives the release, so the task can be retried", async () => {
    const handed = await addTask();

    await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER));
    await releaseTask(String(PROJECT_ID), String(handed));

    const after = await read(handed);
    expect(after.status).toBe(APPROVED);
    expect(after.assignee).toBe(String(OWNER));

    const again = await claimNextTask(String(PROJECT_ID), WORKER, "run-2", String(OWNER));
    expect(String(again?._id)).toBe(String(handed));
  });

  test("an assignment the claim invented does not survive it", async () => {
    const free = await addTask({
      status: ACTIVE,
      assignee: IDENTITY,
      assignedBy: IDENTITY,
      execution: { workerId: WORKER, runId: "run-1", assignedByRun: true, attempts: 1 },
    });

    await releaseTask(String(PROJECT_ID), String(free));

    const after = await read(free);
    expect(after.status).toBe(APPROVED);
    expect(after.assignee).toBeNull();
  });

  test("dragging a finished task on the board keeps a fresh assignment", async () => {
    const free = await addTask();
    await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER));
    await releaseTask(String(PROJECT_ID), String(free));

    const handle = await db();
    await handle.collection("tasks").updateOne({ _id: free }, { $set: { assignee: OWNER } });

    const moved = await updateTask(
      String(PROJECT_ID),
      String(free),
      { status: ACTIVE, order: 3 },
      String(ADMIN_ID)
    );
    expect(moved.ok).toBe(true);

    expect((await read(free)).assignee).toBe(String(OWNER));
  });

  test("forcing a held task off a worker keeps the hand-over", async () => {
    const handed = await addTask();
    await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(OWNER));

    const forced = await updateTask(
      String(PROJECT_ID),
      String(handed),
      { status: APPROVED, order: 1 },
      String(ADMIN_ID),
      true
    );
    expect(forced.ok).toBe(true);

    const after = await read(handed);
    expect(after.assignee).toBe(String(OWNER));
    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-2", String(OWNER))
    ).not.toBeNull();
  });

  test("assigning a finished task and then moving it keeps the assignment", async () => {
    const free = await addTask({
      assignee: null,
      assignedBy: null,
      execution: { workerId: WORKER, runId: "", attempts: 1 },
    });

    const handle = await db();
    await handle.collection("tasks").updateOne({ _id: free }, { $set: { assignee: OWNER } });
    expect((await read(free)).execution.workerId).toBe(WORKER);

    const moved = await changeStatus(String(PROJECT_ID), String(free), ACTIVE, String(ADMIN_ID));
    expect(moved.ok).toBe(true);

    expect((await read(free)).assignee).toBe(String(OWNER));
  });
});

test.describe("whose task a personal agent may go on", () => {
  const MINE = new mongoose.Types.ObjectId();
  const PROJECTS = new mongoose.Types.ObjectId();
  const THEIRS = new mongoose.Types.ObjectId();
  const RUNNABLE = { analysis: [], implementation: [{ key: "write-the-change" }], verification: [], delivery: [] };

  test.beforeEach(async () => {
    const handle = await db();
    await handle.collection("agents").deleteMany({ _id: { $in: [MINE, PROJECTS, THEIRS] } });
    await handle.collection("agents").insertMany([
      { _id: MINE, name: "Member's own", description: "", scope: "user", owner: MEMBER_ID, project: null, composition: RUNNABLE, builtIn: false },
      { _id: PROJECTS, name: "The project's", description: "", scope: "project", owner: null, project: PROJECT_ID, composition: RUNNABLE, builtIn: false },
    ]);
  });

  function put(
    request: APIRequestContext,
    taskId: mongoose.Types.ObjectId,
    data: Record<string, unknown>,
    auth: Record<string, string>
  ) {
    return request.put(`/api/projects/${PROJECT_ID}/tasks/${taskId}`, { headers: auth, data });
  }

  const signIn = (page: Page, username: string, password: string) =>
    username === ADMIN_USERNAME
      ? arriveSignedIn(page)
      : username === MEMBER_USERNAME
        ? arriveSignedIn(page, "member")
        : signInThroughForm(page, username, password);

  test("goes on its owner's own task, and that owner's machine takes it", async () => {
    const own = await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID, agent: null });

    const chosen = await updateTask(
      String(PROJECT_ID),
      String(own),
      { agent: String(MINE) },
      String(MEMBER_ID)
    );

    expect(chosen.ok).toBe(true);
    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(MEMBER_ID))
    ).not.toBeNull();
  });

  test("is refused on a colleague's self-assigned task, and nothing is written", async () => {
    const theirs = await addTask({ assignee: ADMIN_ID, assignedBy: ADMIN_ID, agent: null });

    const chosen = await updateTask(
      String(PROJECT_ID),
      String(theirs),
      { agent: String(MINE) },
      String(MEMBER_ID)
    );

    expect(chosen.ok).toBe(false);
    expect((chosen as { error: string }).error).toMatch(/personal agent/i);
    const handle = await db();
    expect((await handle.collection("tasks").findOne({ _id: theirs }))?.agent).toBeNull();
    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(ADMIN_ID))).toBeNull();
  });

  test("a project's own agent goes on a colleague's task, and their machine takes it", async () => {
    const theirs = await addTask({ assignee: ADMIN_ID, assignedBy: ADMIN_ID, agent: null });

    const chosen = await updateTask(
      String(PROJECT_ID),
      String(theirs),
      { agent: String(PROJECTS) },
      String(MEMBER_ID)
    );

    expect(chosen.ok).toBe(true);
    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(ADMIN_ID))
    ).not.toBeNull();
  });

  test("does not survive a hand-over to somebody who could not have chosen it", async () => {
    const own = await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID, agent: null });
    await updateTask(String(PROJECT_ID), String(own), { agent: String(MINE) }, String(MEMBER_ID));

    const handed = await updateTask(
      String(PROJECT_ID),
      String(own),
      { assignee: ADMIN_USERNAME },
      String(MEMBER_ID)
    );

    expect(handed.ok).toBe(true);
    const handle = await db();
    const after = await handle.collection("tasks").findOne({ _id: own });
    expect(after?.agent).toBeNull();
    expect(String(after?.assignedBy)).toBe(String(MEMBER_ID));
    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(ADMIN_ID))).toBeNull();
  });

  test("survives a hand-over to the person it belongs to", async () => {
    const handle = await db();
    await handle.collection("agents").insertOne({
      _id: THEIRS,
      name: "The admin's own",
      description: "",
      scope: "user",
      owner: ADMIN_ID,
      project: null,
      composition: RUNNABLE,
      builtIn: false,
    });
    const held = await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID, agent: THEIRS });

    const handed = await updateTask(
      String(PROJECT_ID),
      String(held),
      { assignee: ADMIN_USERNAME },
      String(MEMBER_ID)
    );
    expect(handed.ok).toBe(true);
    expect(String((await handle.collection("tasks").findOne({ _id: held }))?.agent)).toBe(
      String(THEIRS)
    );
    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(ADMIN_ID))).toBeNull();
  });

  test("an edit that does not move the assignee leaves the agent, and it still runs", async ({
    request,
  }) => {
    const handle = await db();
    await handle.collection("agents").insertOne({
      _id: THEIRS,
      name: "The admin's own",
      description: "",
      scope: "user",
      owner: ADMIN_ID,
      project: null,
      composition: RUNNABLE,
      builtIn: false,
    });
    const own = await addTask({ assignee: ADMIN_ID, assignedBy: ADMIN_ID, agent: THEIRS });

    const renamed = await put(request, own, { title: "renamed" }, ADMIN_AUTH);
    expect(renamed.status(), await renamed.text()).toBe(200);

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(ADMIN_ID));
    expect(String(claimed?._id)).toBe(String(own));
    expect(String(claimed?.agent)).toBe(String(THEIRS));
  });

  test("a project's agent survives the same hand-over", async () => {
    const own = await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID, agent: PROJECTS });

    await updateTask(String(PROJECT_ID), String(own), { assignee: ADMIN_USERNAME }, String(MEMBER_ID));

    const handle = await db();
    expect(String((await handle.collection("tasks").findOne({ _id: own }))?.agent)).toBe(
      String(PROJECTS)
    );
  });

  test("the four gestures that used to end with my composition on their machine", async ({
    request,
  }) => {
    const own = await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID, agent: null });
    const handle = await db();
    const stored = () => handle.collection("tasks").findOne({ _id: own });

    const chose = await put(request, own, { agent: String(MINE) }, MEMBER_AUTH);
    expect(chose.status(), await chose.text()).toBe(200);
    expect(String((await stored())?.agent)).toBe(String(MINE));

    const handed = await put(request, own, { assignee: ADMIN_USERNAME }, MEMBER_AUTH);
    expect(handed.status(), await handed.text()).toBe(200);
    expect((await handed.json()).agent).toBeNull();
    expect((await stored())?.agent).toBeNull();

    expect((await put(request, own, { assignee: null }, ADMIN_AUTH)).status()).toBe(200);
    expect((await put(request, own, { assignee: ADMIN_USERNAME }, ADMIN_AUTH)).status()).toBe(200);

    const after = await stored();
    expect(String(after?.assignee)).toBe(String(ADMIN_ID));
    expect(String(after?.assignedBy)).toBe(String(ADMIN_ID));
    expect(after?.agent).toBeNull();
    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(ADMIN_ID))).toBeNull();
  });

  test("a legacy repair does not arm the repairer's machine with somebody else's agent", async ({
    request,
  }) => {
    const old = await addLegacyTask({ assignee: ADMIN_ID, agent: MINE });
    const handle = await db();
    expect(await handle.collection("tasks").findOne({ _id: old })).not.toHaveProperty("assignedBy");

    const repaired = await put(request, old, { assignee: ADMIN_USERNAME }, ADMIN_AUTH);
    expect(repaired.status(), await repaired.text()).toBe(200);

    const after = await handle.collection("tasks").findOne({ _id: old });
    expect(String(after?.assignedBy)).toBe(String(ADMIN_ID));
    expect(after?.agent).toBeNull();
    expect(await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(ADMIN_ID))).toBeNull();
  });

  test("a legacy repair keeps the repairer's own agent, and their machine then takes it", async () => {
    const handle = await db();
    await handle.collection("agents").insertOne({
      _id: THEIRS,
      name: "The admin's own",
      description: "",
      scope: "user",
      owner: ADMIN_ID,
      project: null,
      composition: RUNNABLE,
      builtIn: false,
    });
    const old = await addLegacyTask({ assignee: ADMIN_ID, agent: THEIRS });

    const repaired = await updateTask(
      String(PROJECT_ID),
      String(old),
      { assignee: ADMIN_USERNAME },
      String(ADMIN_ID)
    );
    expect(repaired.ok).toBe(true);

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(ADMIN_ID));
    expect(String(claimed?._id)).toBe(String(old));
    expect(String(claimed?.agent)).toBe(String(THEIRS));
  });

  test("the drop is written to the task's history", async ({ request }) => {
    const own = await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID, agent: MINE });

    await put(request, own, { assignee: ADMIN_USERNAME }, MEMBER_AUTH);

    const handle = await db();
    const rows = await handle.collection("activitylogs").find({ task: own, field: "agent" }).toArray();
    expect(rows.map((r) => [String(r.oldValue), String(r.newValue ?? "")])).toEqual([
      [String(MINE), ""],
    ]);
  });

  test("an ordinary edit invents no agent change, though the answer comes back populated", async ({
    request,
  }) => {
    const own = await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID, agent: MINE });

    const renamed = await put(request, own, { title: "renamed" }, MEMBER_AUTH);
    expect(renamed.status(), await renamed.text()).toBe(200);
    expect((await renamed.json()).agent).toMatchObject({ name: "Member's own" });

    const handle = await db();
    expect(await handle.collection("activitylogs").countDocuments({ task: own, field: "agent" })).toBe(0);
  });

  test("names the agent it may not offer, rather than showing the row empty", async ({ page }) => {
    const theirs = await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID, agent: MINE });
    const handle = await db();
    const number = (await handle.collection("tasks").findOne({ _id: theirs }))?.taskNumber;

    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/${number}`);

    await expect(page.getByTestId("agent-not-offered")).toHaveText("Member's own");
    await expect(page.getByTestId("agent-not-offered-reason")).toContainText(
      /only offered to the person who composed it/i
    );
  });

  test("and offers the same agent to the person it belongs to", async ({ page }) => {
    const own = await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID, agent: MINE });
    const handle = await db();
    const number = (await handle.collection("tasks").findOne({ _id: own }))?.taskNumber;

    await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/${number}`);

    await expect(page.getByTestId("agent-not-offered")).toHaveCount(0);
    await expect(
      page.getByRole("combobox").filter({ hasText: /^Agent/ })
    ).toContainText("Member's own");
  });

  test("is refused in the write that hands the task away, though it was mine when it was read", async () => {
    const own = await addTask({ assignee: MEMBER_ID, assignedBy: MEMBER_ID, agent: null });

    const chosen = await updateTask(
      String(PROJECT_ID),
      String(own),
      { assignee: ADMIN_USERNAME, agent: String(MINE) },
      String(MEMBER_ID)
    );

    expect(chosen.ok).toBe(false);
    const handle = await db();
    const after = await handle.collection("tasks").findOne({ _id: own });
    expect(after?.agent).toBeNull();
    expect(String(after?.assignee)).toBe(String(MEMBER_ID));
  });
});

test.describe("what the machine refuses at the moment it picks the work up", () => {
  const MINE = new mongoose.Types.ObjectId();
  const THEIRS = new mongoose.Types.ObjectId();
  const PROJECTS = new mongoose.Types.ObjectId();
  const RUNNABLE = { analysis: [], implementation: [{ key: "implement" }], verification: [], delivery: [] };
  const REMOTE = "e2e-owner/e2e-repo";

  test.beforeEach(async () => {
    const handle = await db();
    await handle.collection("agentblocks").updateOne(
      { key: "implement" },
      { $set: { key: "implement", kind: "step", name: "Implement", description: "", prompt: "make the change", capability: "edit", model: "opus", fallbackModel: "sonnet", deterministic: false, builtIn: true } },
      { upsert: true }
    );
    await handle.collection("agents").deleteMany({ _id: { $in: [MINE, THEIRS, PROJECTS] } });
    await handle.collection("agents").insertMany([
      { _id: MINE, name: "The owner's own", description: "", scope: "user", owner: OWNER, project: null, composition: RUNNABLE, builtIn: false },
      { _id: THEIRS, name: "The member's own", description: "", scope: "user", owner: MEMBER_ID, project: null, composition: RUNNABLE, builtIn: false },
      { _id: PROJECTS, name: "The project's", description: "", scope: "project", owner: null, project: PROJECT_ID, composition: RUNNABLE, builtIn: false },
    ]);
    await handle.collection("workers").updateOne(
      { _id: WORKER_ID },
      { $set: { owner: OWNER, repos: [{ remote: REMOTE, path: "/e2e/checkout" }], lastSeenAt: new Date() } }
    );
    await handle.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { githubRepo: REMOTE } });
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

  test("takes a task carrying the machine owner's own composition", async ({ request }) => {
    const own = await addTask({ assignee: OWNER, assignedBy: OWNER, agent: MINE });

    const claimed = await claim(request, "run-owner");

    expect(claimed.status(), await claimed.text()).toBe(200);
    const body = await claimed.json();
    expect(String(body._id)).toBe(String(own));
    expect(body.agent).toMatchObject({ agentId: String(MINE), name: "The owner's own" });
    expect((await read(own)).status).toBe(ACTIVE);
  });

  test("says why the board cannot claim, instead of reporting an empty queue", async ({ request }) => {
    const own = await addTask({ assignee: OWNER, assignedBy: OWNER, agent: MINE });
    const handle = await db();
    const demoted = await handle
      .collection("projects")
      .updateOne(
        { _id: PROJECT_ID },
        { $set: { "columns.$[column].role": "review" } },
        { arrayFilters: [{ "column.id": ACTIVE }] }
      );
    expect(demoted.modifiedCount).toBe(1);

    const refused = await claim(request, "run-nowhere");

    expect(refused.status(), await refused.text()).toBe(409);
    expect((await refused.json()).error).toMatch(/no column meaning In progress/);
    const after = await read(own);
    expect(after.status).toBe(APPROVED);
    expect(after.execution.runId).toBeUndefined();

    await expect(
      claimNextTask(String(PROJECT_ID), WORKER, "run-nowhere", String(OWNER))
    ).rejects.toThrow(/no column meaning In progress/);
  });

  test("refuses a stranger's composition on a document no writer will look at again", async ({
    request,
  }) => {
    const armed = await addTask({ assignee: OWNER, assignedBy: OWNER, agent: THEIRS });

    const claimed = await claim(request, "run-alien");

    expect(claimed.status()).toBe(204);
    const after = await read(armed);
    expect(after.status).toBe(APPROVED);
    const handle = await db();
    expect(String((await handle.collection("tasks").findOne({ _id: armed }))?.agent)).toBe(String(THEIRS));
    expect(after.execution.attempts).toBe(1);
  });

  test("parks it where a person reads, rather than handing it back forever", async ({ request }) => {
    const armed = await addTask({ assignee: OWNER, assignedBy: OWNER, agent: THEIRS });

    expect((await claim(request, "run-1")).status()).toBe(204);
    expect((await claim(request, "run-2")).status()).toBe(204);
    expect((await claim(request, "run-3")).status()).toBe(204);

    const after = await read(armed);
    expect(after.status).toBe("needs_human_review");
    expect(after.execution.attempts).toBe(3);
  });

  test("still runs the project's own agent on a machine belonging to anybody", async ({ request }) => {
    const sanctioned = await addTask({ assignee: OWNER, assignedBy: OWNER, agent: PROJECTS });

    const claimed = await claim(request, "run-project");

    expect(claimed.status(), await claimed.text()).toBe(200);
    expect((await claimed.json()).agent).toMatchObject({ name: "The project's" });
    expect((await read(sanctioned)).status).toBe(ACTIVE);
  });

  test("refuses an agent that became somebody's own after the task chose it", async ({ request }) => {
    const chosen = await addTask({ assignee: OWNER, assignedBy: OWNER, agent: PROJECTS });
    const handle = await db();
    await handle
      .collection("agents")
      .updateOne({ _id: PROJECTS }, { $set: { scope: "user", owner: MEMBER_ID, project: null } });

    expect((await claim(request, "run-rescoped")).status()).toBe(204);
    expect((await read(chosen)).status).toBe(APPROVED);
  });

  test("refuses every copy a recurring series makes of a pairing nothing re-judges", async ({
    request,
  }) => {
    const parent = await addTask({
      status: ACTIVE,
      assignee: OWNER,
      assignedBy: OWNER,
      agent: THEIRS,
      dueDate: new Date(),
      recurrence: { frequency: "weekly", interval: 1 },
    });
    const handle = await db();

    await changeStatus(String(PROJECT_ID), String(parent), "done", String(OWNER));

    await expect
      .poll(async () => await handle.collection("tasks").countDocuments({ recurringParentId: parent }))
      .toBe(1);
    const copy = (await handle.collection("tasks").findOne({ recurringParentId: parent }))!;
    expect(String(copy.agent)).toBe(String(THEIRS));
    expect(String(copy.assignedBy)).toBe(String(OWNER));

    await changeStatus(String(PROJECT_ID), String(copy._id), APPROVED, String(OWNER));

    expect((await claim(request, "run-recurrence")).status()).toBe(204);
    expect((await read(copy._id)).status).toBe(APPROVED);
  });

  for (const shape of ["$$REMOVE", "$execution.workerId", "a".repeat(65), "run 1", "run/1"]) {
    test(`refuses a runId of ${JSON.stringify(shape)}`, async ({ request }) => {
      const armed = await addTask({ assignee: OWNER, assignedBy: OWNER, agent: MINE });

      const answer = await claim(request, shape);

      expect(answer.status(), await answer.text()).toBe(400);
      expect((await read(armed)).status).toBe(APPROVED);
    });
  }

  test("takes the work when the runId is the uuid a worker mints", async ({ request }) => {
    const armed = await addTask({ assignee: OWNER, assignedBy: OWNER, agent: MINE });

    const answer = await claim(request, randomUUID());

    expect(answer.status(), await answer.text()).toBe(200);
    expect((await read(armed)).status).toBe(ACTIVE);
  });

  test("refuses one whose owner no longer exists at all", async ({ request }) => {
    const gone = new mongoose.Types.ObjectId();
    const handle = await db();
    await handle.collection("agents").updateOne({ _id: THEIRS }, { $set: { owner: gone } });
    const armed = await addTask({ assignee: OWNER, assignedBy: OWNER, agent: THEIRS });

    expect((await claim(request, "run-orphan")).status()).toBe(204);
    expect((await read(armed)).status).toBe(APPROVED);
  });
});

test.describe("a run identity is text, whatever it looks like", () => {
  test("an ordinary uuid is stored verbatim", async () => {
    const armed = await addTask();
    const runId = randomUUID();

    await claimNextTask(String(PROJECT_ID), WORKER, runId, String(OWNER));

    expect((await read(armed)).execution.runId).toBe(runId);
  });

  test("$$REMOVE is a run identity, not an instruction to drop the field", async () => {
    const armed = await addTask();

    await claimNextTask(String(PROJECT_ID), WORKER, "$$REMOVE", String(OWNER));

    expect((await read(armed)).execution.runId).toBe("$$REMOVE");
  });

  test("a field path is a run identity, not the value of that field", async () => {
    const armed = await addTask();

    await claimNextTask(String(PROJECT_ID), WORKER, "$execution.workerId", String(OWNER));

    const after = await read(armed);
    expect(after.execution.runId).toBe("$execution.workerId");
    expect(after.execution.workerId).toBe(WORKER);
  });
});
