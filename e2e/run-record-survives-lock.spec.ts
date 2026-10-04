import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { claimNextTask } from "@/lib/task-service";
import { scopedToDefaultOrganisation } from "@/lib/db-scope";
import "@/models/agent";
import { signIn } from "./session";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  PROJECT_ID,
  PROJECT_KEY,
  SIBLING_TASK_ID,
  TARGET_COLUMN,
  WORKER_CREDENTIAL,
  WORKER_ID,
  seed,
  setBoardReadiness,
} from "./seed";

/**
 * BP-758. The worker queues a run's outcome record in its outbox and sends it on the next flush —
 * after the run's own final status change has cleared `execution.runId`. The seeded machine serves
 * this project only by the run it holds (it reports no checkout), which is exactly a machine whose
 * project was locked, switched off or ungranted mid-run: once that run released the task, nothing
 * exempted `POST /runs` any more, it answered 403, and the outbox retried it to the limit and lost
 * the run's history and cost.
 *
 * Driven over HTTP the way `worker/src/api.ts` sends it, after a real claim, because the id the
 * record is matched by is written by the claim's update pipeline, which casts nothing.
 */

const TASK_KEY_NUMBER = 9_758;

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

function asWorker() {
  return {
    Authorization: `Bearer ${WORKER_CREDENTIAL}`,
    "X-Worker-Id": String(WORKER_ID),
    "X-CP-Protocol": "1",
  };
}

async function giveWorkerAnIdentity() {
  const handle = await db();
  const identityId = new mongoose.Types.ObjectId();
  await handle.collection("users").insertOne({
    _id: identityId,
    username: "worker-run-record",
    fullName: "rig · worker-run-record",
    password: await bcrypt.hash("unused-run-record", 4),
    email: "",
    kind: "machine",
    role: "member",
    createdAt: new Date(),
  });
  await handle.collection("workers").updateOne({ _id: WORKER_ID }, { $set: { identity: identityId } });
}

/** A task the machine's owner handed it, claimed for real, so the claim writes what it writes. */
async function claimOne(runId: string): Promise<mongoose.Types.ObjectId> {
  const handle = await db();
  const _id = new mongoose.Types.ObjectId();
  await handle.collection("tasks").insertOne({
    _id,
    project: PROJECT_ID,
    taskNumber: TASK_KEY_NUMBER,
    title: "run whose record must survive",
    description: "",
    priority: "medium",
    category: "user-story",
    status: "todo",
    assignee: ADMIN_ID,
    assignedBy: ADMIN_ID,
    agent: new mongoose.Types.ObjectId(),
    checklist: [],
    linkedPRs: [],
    blockedBy: [],
    relations: [],
    watchers: [],
    customFieldValues: {},
    order: -1,
    createdBy: ADMIN_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const claimed = await claimNextTask(scopedToDefaultOrganisation(), String(PROJECT_ID), String(WORKER_ID), runId, String(ADMIN_ID));
  expect(String(claimed?._id)).toBe(String(_id));
  return _id;
}

function recordOf(taskId: mongoose.Types.ObjectId | string, runId: string) {
  return {
    taskId: String(taskId),
    runId,
    taskKey: `${PROJECT_KEY}-${TASK_KEY_NUMBER}`,
    agentId: "",
    agentName: "Default",
    outcome: "merged",
    refusedBy: "",
    detail: "",
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    finishedAt: new Date().toISOString(),
    costUsd: 1.75,
    workerId: String(WORKER_ID),
  };
}

function postRecord(request: APIRequestContext, record: ReturnType<typeof recordOf>) {
  return request.post(`/api/projects/${PROJECT_ID}/runs`, { headers: asWorker(), data: record });
}

async function recordsOf(runId: string) {
  return (await db()).collection("agentruns").find({ runId }).toArray();
}

let runId: string;
let taskId: mongoose.Types.ObjectId;

test.beforeEach(async () => {
  await seed();
  process.env.MONGODB_URI = E2E_MONGODB_URI;
  await giveWorkerAnIdentity();
  // The seed leaves this machine holding runs of its own; with any of them live the project-wide
  // exemption this ticket removed would still have let the record in, and the test would prove
  // nothing. The run claimed below is the only one it holds.
  await (await db())
    .collection("tasks")
    .updateMany(
      { project: PROJECT_ID, "execution.workerId": String(WORKER_ID) },
      { $unset: { "execution.runId": "" } }
    );
  runId = randomUUID();
  taskId = await claimOne(runId);
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

for (const [what, change] of [
  ["an instance admin locks the project", { lockedByInstance: true }],
  ["the project switches its workers off", { workerEnabled: false }],
] as const) {
  test(`${what} mid-run: the run finishes, reports, and its record is kept once`, async ({
    page,
    request,
  }) => {
    await setBoardReadiness(change);

    // reporter.ts's report(): a comment, then the move that ends the run
    const commented = await request.post(`/api/projects/${PROJECT_ID}/tasks/${taskId}/comments`, {
      headers: asWorker(),
      data: { body: "Merged." },
    });
    expect(commented.status(), await commented.text()).toBe(201);
    const moved = await request.patch(`/api/projects/${PROJECT_ID}/tasks/${taskId}/status`, {
      headers: asWorker(),
      data: { status: TARGET_COLUMN.id },
    });
    expect(moved.status(), await moved.text()).toBe(200);

    const released = await (await db()).collection("tasks").findOne({ _id: taskId });
    expect(released?.execution?.runId).toBeUndefined();
    expect(released?.execution?.lastRunId).toBe(runId);

    // Then the outbox flush, with nothing left holding the task
    const sent = await postRecord(request, recordOf(taskId, runId));
    expect(sent.status(), await sent.text()).toBe(201);
    // And again, as the outbox does when it never saw the first answer
    const resent = await postRecord(request, recordOf(taskId, runId));
    expect(resent.status(), await resent.text()).toBe(200);

    const stored = await recordsOf(runId);
    expect(stored).toHaveLength(1);
    expect(stored[0].costUsd).toBe(1.75);
    expect(String(stored[0].worker)).toBe(String(WORKER_ID));

    // Where a person reads it
    await signIn(page);
    await page.goto("/settings/workers/runs");
    await expect(page.getByRole("heading", { name: "Run history" })).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: `${PROJECT_KEY}-${TASK_KEY_NUMBER}` });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("$1.75");
  });
}

test("a record for anything but the run this machine ran is refused, finally", async ({ request }) => {
  await setBoardReadiness({ lockedByInstance: true });

  const anotherTask = await postRecord(request, recordOf(SIBLING_TASK_ID, runId));
  expect(anotherTask.status(), await anotherTask.text()).toBe(422);
  const anotherRun = await postRecord(request, recordOf(taskId, randomUUID()));
  expect(anotherRun.status(), await anotherRun.text()).toBe(422);

  // The control: the run it did run, which it still holds, goes through on the same locked board
  const ownRun = await postRecord(request, recordOf(taskId, runId));
  expect(ownRun.status(), await ownRun.text()).toBe(201);
  expect(await (await db()).collection("agentruns").countDocuments({ project: PROJECT_ID })).toBe(1);
});

for (const [what, lock] of [
  ["without a lock", false],
  ["under an instance admin's lock", true],
] as const) {
  test(`holding one run reaches no other task on the board, ${what}`, async ({ request }) => {
    if (lock) await setBoardReadiness({ lockedByInstance: true });
    const other = `/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}`;

    const status = await request.patch(`${other}/status`, {
      headers: asWorker(),
      data: { status: TARGET_COLUMN.id },
    });
    expect(status.status(), await status.text()).toBe(403);
    const comment = await request.post(`${other}/comments`, {
      headers: asWorker(),
      data: { body: "not mine" },
    });
    expect(comment.status(), await comment.text()).toBe(403);
    const release = await request.post(`${other}/release`, { headers: asWorker() });
    expect(release.status(), await release.text()).toBe(403);

    const sibling = await (await db()).collection("tasks").findOne({ _id: SIBLING_TASK_ID });
    expect(sibling?.status).not.toBe(TARGET_COLUMN.id);
    expect(await (await db()).collection("comments").countDocuments({ task: SIBLING_TASK_ID })).toBe(0);

    // The control: the task it holds is still its own to report on
    const own = await request.post(`/api/projects/${PROJECT_ID}/tasks/${taskId}/comments`, {
      headers: asWorker(),
      data: { body: "mine" },
    });
    expect(own.status(), await own.text()).toBe(201);
  });
}

// BP-758 review. A released outcome requeues the task, and it can be claimed again — here by
// another machine — before the first machine's outbox sends the record. A machine the project still
// serves is not narrowed by the run, so that record is kept rather than refused for good.
test("a machine the project serves records a run whose task was already claimed again", async ({
  request,
}) => {
  const repository = "https://github.com/e2e/run-record";
  const handle = await db();
  await handle.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { repositoryUrl: repository } });
  await handle.collection("workers").updateOne(
    { _id: WORKER_ID },
    { $set: { owner: ADMIN_ID, repos: [{ remote: `${repository}.git`, path: "/Users/someone/run-record" }] } }
  );

  const released = await request.post(`/api/projects/${PROJECT_ID}/tasks/${taskId}/release`, {
    headers: asWorker(),
  });
  expect(released.status(), await released.text()).toBe(200);
  const nextRun = randomUUID();
  const reclaimed = await claimNextTask(
    scopedToDefaultOrganisation(),
    String(PROJECT_ID),
    String(new mongoose.Types.ObjectId()),
    nextRun,
    String(ADMIN_ID)
  );
  expect(String(reclaimed?._id)).toBe(String(taskId));

  const sent = await postRecord(request, { ...recordOf(taskId, runId), outcome: "released" });
  expect(sent.status(), await sent.text()).toBe(201);
  const resent = await postRecord(request, { ...recordOf(taskId, runId), outcome: "released" });
  expect(resent.status(), await resent.text()).toBe(200);
  expect(await recordsOf(runId)).toHaveLength(1);
});

// Claimed on a server from before BP-758, which wrote no lastRunId, and finished on this one
test("a run claimed before the upgrade still records its outcome after it ends", async ({ request }) => {
  await (await db()).collection("tasks").updateOne({ _id: taskId }, { $unset: { "execution.lastRunId": "" } });
  await setBoardReadiness({ lockedByInstance: true });

  const moved = await request.patch(`/api/projects/${PROJECT_ID}/tasks/${taskId}/status`, {
    headers: asWorker(),
    data: { status: TARGET_COLUMN.id },
  });
  expect(moved.status(), await moved.text()).toBe(200);

  const sent = await postRecord(request, recordOf(taskId, runId));
  expect(sent.status(), await sent.text()).toBe(201);
});

test("the way in for a record ends with the run's lease", async ({ request }) => {
  await setBoardReadiness({ lockedByInstance: true });
  const handle = await db();
  await handle.collection("tasks").updateOne(
    { _id: taskId },
    {
      $unset: { "execution.runId": "" },
      $set: { status: TARGET_COLUMN.id, "execution.startedAt": new Date(Date.now() - 2 * 60 * 60 * 1000 - 60_000) },
    }
  );

  const late = await postRecord(request, recordOf(taskId, runId));
  expect(late.status(), await late.text()).toBe(422);

  // The control: the same record, inside the lease
  await handle.collection("tasks").updateOne(
    { _id: taskId },
    { $set: { "execution.startedAt": new Date(Date.now() - 60 * 60 * 1000) } }
  );
  const inTime = await postRecord(request, recordOf(taskId, runId));
  expect(inTime.status(), await inTime.text()).toBe(201);
});

// The run reads the board's columns from the project itself (worker/src/api.ts readColumns)
test("a run on a locked project still reads the board, and the read ends with the run", async ({
  request,
}) => {
  await setBoardReadiness({ lockedByInstance: true });

  const during = await request.get(`/api/projects/${PROJECT_ID}`, { headers: asWorker() });
  expect(during.status(), await during.text()).toBe(200);
  expect(((await during.json()).columns as Array<{ id: string }>).map((c) => c.id)).toContain(
    TARGET_COLUMN.id
  );

  const moved = await request.patch(`/api/projects/${PROJECT_ID}/tasks/${taskId}/status`, {
    headers: asWorker(),
    data: { status: TARGET_COLUMN.id },
  });
  expect(moved.status(), await moved.text()).toBe(200);

  const after = await request.get(`/api/projects/${PROJECT_ID}`, { headers: asWorker() });
  expect(after.status()).toBe(403);
});
