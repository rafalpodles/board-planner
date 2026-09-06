import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH } from "./api";
import { claimNextTask } from "@/lib/task-service";
import { ADMIN_ID, E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed } from "./seed";

const COLUMNS = [
  { id: "icebox", label: "Icebox", color: "#6b7280", role: "backlog", order: 0 },
  { id: "ready", label: "Ready", color: "#3b82f6", role: "approved", order: 1 },
  { id: "building", label: "Building", color: "#f59e0b", role: "active", order: 2 },
  { id: "checking", label: "Checking", color: "#a855f7", role: "review", order: 3 },
  { id: "shipped", label: "Shipped", color: "#22c55e", role: "done", order: 4 },
];

const SPRINT_ID = new mongoose.Types.ObjectId();
const NEXT_SPRINT_ID = new mongoose.Types.ObjectId();

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

let nextNumber = 700;

async function addTask(status: string, over: Record<string, unknown> = {}) {
  const handle = await db();
  const _id = new mongoose.Types.ObjectId();
  await handle.collection("tasks").insertOne({
    _id,
    project: PROJECT_ID,
    taskNumber: nextNumber++,
    title: `role fixture ${nextNumber}`,
    description: "",
    priority: "medium",
    category: "user-story",
    status,
    assignee: null,
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

test.beforeEach(async () => {
  await seed();
  const handle = await db();

  await handle.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { columns: COLUMNS } });
  await handle.collection("tasks").deleteMany({ project: PROJECT_ID });

  await handle.collection("sprints").insertMany([
    {
      _id: SPRINT_ID,
      project: PROJECT_ID,
      name: "Sprint one",
      status: "active",
      startDate: new Date("2026-08-01"),
      endDate: new Date("2026-08-14"),
      goal: "",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      _id: NEXT_SPRINT_ID,
      project: PROJECT_ID,
      name: "Sprint two",
      status: "planned",
      startDate: new Date("2026-08-15"),
      endDate: new Date("2026-08-28"),
      goal: "",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
});

test.afterEach(async () => {
  const handle = await db();
  await handle.collection("sprints").deleteMany({ project: PROJECT_ID });
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test.describe("closing a sprint on a board with no column called done", () => {
  test("leaves finished work behind instead of dragging it into the next sprint", async ({
    request,
  }) => {
    const finished = await addTask("shipped", { sprint: SPRINT_ID });
    const unfinished = await addTask("building", { sprint: SPRINT_ID });

    const response = await request.put(
      `/api/projects/${PROJECT_KEY}/sprints/${SPRINT_ID}`,
      {
        headers: ADMIN_AUTH,
        data: { status: "completed", moveIncompleteToSprint: String(NEXT_SPRINT_ID) },
      }
    );
    expect(response.status()).toBe(200);

    const handle = await db();
    const after = async (id: mongoose.Types.ObjectId) =>
      (await handle.collection("tasks").findOne({ _id: id }))?.sprint;

    expect(String(await after(finished))).toBe(String(SPRINT_ID));
    expect(String(await after(unfinished))).toBe(String(NEXT_SPRINT_ID));
  });

  test("sends unfinished work to the backlog and keeps the rest", async ({ request }) => {
    const finished = await addTask("shipped", { sprint: SPRINT_ID });
    const unfinished = await addTask("checking", { sprint: SPRINT_ID });

    await request.put(`/api/projects/${PROJECT_KEY}/sprints/${SPRINT_ID}`, {
      headers: ADMIN_AUTH,
      data: { status: "completed", moveIncompleteToBacklog: true },
    });

    const handle = await db();
    const after = async (id: mongoose.Types.ObjectId) =>
      (await handle.collection("tasks").findOne({ _id: id }))?.sprint;

    expect(String(await after(finished))).toBe(String(SPRINT_ID));
    expect(await after(unfinished)).toBeNull();
  });

  test("counts progress by role, on the sprint itself and in the list", async ({ request }) => {
    await addTask("shipped", { sprint: SPRINT_ID });
    await addTask("shipped", { sprint: SPRINT_ID });
    await addTask("building", { sprint: SPRINT_ID });

    const one = await request.get(`/api/projects/${PROJECT_KEY}/sprints/${SPRINT_ID}`, {
      headers: ADMIN_AUTH,
    });
    expect(await one.json()).toMatchObject({ taskCount: 3, doneCount: 2 });

    const list = await request.get(`/api/projects/${PROJECT_KEY}/sprints`, { headers: ADMIN_AUTH });
    const sprint = (await list.json()).find(
      (s: { _id: string }) => s._id === String(SPRINT_ID)
    );
    expect(sprint).toMatchObject({ taskCount: 3, doneCount: 2 });
  });
});

test.describe("My Tasks across boards that agree on roles and nothing else", () => {
  test("hides finished work, and labels the rest the way its own board does", async ({
    request,
  }) => {
    await addTask("shipped", { assignee: ADMIN_ID });
    await addTask("building", { assignee: ADMIN_ID });

    const response = await request.get("/api/tasks/mine", { headers: ADMIN_AUTH });
    const tasks = await response.json();

    const done = tasks.find((t: { status: string }) => t.status === "shipped");
    const active = tasks.find((t: { status: string }) => t.status === "building");

    expect(done).toMatchObject({ statusRole: "done", statusLabel: "Shipped", statusColor: "#22c55e" });
    expect(active).toMatchObject({ statusRole: "active", statusLabel: "Building" });
  });

  test("a task whose column is gone keeps its raw status and no role", async ({ request }) => {
    await addTask("a_column_that_was_deleted", { assignee: ADMIN_ID });

    const tasks = await (await request.get("/api/tasks/mine", { headers: ADMIN_AUTH })).json();
    const orphan = tasks.find((t: { status: string }) => t.status === "a_column_that_was_deleted");

    expect(orphan).toMatchObject({
      statusRole: null,
      statusLabel: "a_column_that_was_deleted",
      statusColor: null,
    });
  });

  test("does not ship a copy of every board alongside the tasks", async ({ request }) => {
    await addTask("building", { assignee: ADMIN_ID });

    const tasks = await (await request.get("/api/tasks/mine", { headers: ADMIN_AUTH })).json();

    expect(tasks[0].project).not.toHaveProperty("columns");
    expect(tasks[0].project).toHaveProperty("key", PROJECT_KEY);
  });
});

test.describe("a worker claiming on a board with no column called done", () => {
  const WORKER = "w-column-roles";

  test.beforeEach(async () => {
    process.env.MONGODB_URI = E2E_MONGODB_URI;
  });

  test("waits for its blocker until that blocker reaches Shipped", async () => {
    const blocker = await addTask("checking", { order: 1 });
    const blocked = await addTask("ready", {
      blockedBy: [blocker],
      order: 2,
      assignee: ADMIN_ID,
      assignedBy: ADMIN_ID,
      agent: new mongoose.Types.ObjectId(),
    });

    expect(
      await claimNextTask(String(PROJECT_ID), WORKER, "run-1", String(ADMIN_ID))
    ).toBeNull();

    const handle = await db();
    await handle.collection("tasks").updateOne({ _id: blocker }, { $set: { status: "shipped" } });

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, "run-2", String(ADMIN_ID));
    expect(String(claimed?._id)).toBe(String(blocked));
  });
});
