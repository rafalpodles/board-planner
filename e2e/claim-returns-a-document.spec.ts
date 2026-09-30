import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import {
  claimNextTask,
  releaseTask,
  EXECUTION_LEASE_MS,
  MAX_EXECUTION_ATTEMPTS,
} from "@/lib/task-service";
import "@/models/agent";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  PROJECT_ID,
  WORKER_CREDENTIAL,
  WORKER_ID,
  seed,
} from "./seed";

// BP-360: against a real MongoDB, so what is asserted is what the call returned, not its signature

const APPROVED = "todo";
const ACTIVE = "in_progress";
const ESCALATION = "needs_human_review";
const OWNER = ADMIN_ID;
const WORKER = "w-claim-document";
const AGENT_ID = new mongoose.Types.ObjectId();
const REMOTE = "e2e-owner/e2e-repo";
const RUNNABLE = { analysis: [], implementation: [{ key: "implement" }], verification: [], delivery: [] };

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

let nextNumber = 1400;

async function addTask(over: Record<string, unknown> = {}) {
  const handle = await db();
  const _id = new mongoose.Types.ObjectId();
  const taskNumber = nextNumber++;
  await handle.collection("tasks").insertOne({
    _id,
    project: PROJECT_ID,
    taskNumber,
    title: `claim document ${taskNumber}`,
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
  return { _id, taskNumber };
}

async function stored(taskId: mongoose.Types.ObjectId) {
  const handle = await db();
  return handle.collection("tasks").findOne({ _id: taskId });
}

// The fields of findOneAndUpdate's ModifyResult, which is what a caller got instead of the task
// when includeResultMetadata was on
function expectNotAModifyResult(result: object) {
  for (const key of ["value", "ok", "lastErrorObject"]) expect(key in result).toBe(false);
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

test.describe("what the claim and the release hand back", () => {
  test("a claim returns the claimed task as a document", async () => {
    const { _id, taskNumber } = await addTask();
    const runId = randomUUID();

    const claimed = await claimNextTask(String(PROJECT_ID), WORKER, runId, String(OWNER));

    expect(claimed).not.toBeNull();
    expectNotAModifyResult(claimed!);
    expect(typeof claimed!.toJSON).toBe("function");
    expect(String(claimed!._id)).toBe(String(_id));
    expect(claimed!.taskNumber).toBe(taskNumber);
    expect(claimed!.status).toBe(ACTIVE);
    expect(claimed!.execution.runId).toBe(runId);
    expect(claimed!.execution.workerId).toBe(WORKER);
    expect(claimed!.execution.attempts).toBe(1);
  });

  test("a refunded release returns the task as it is after the release", async () => {
    const { _id, taskNumber } = await addTask();
    await claimNextTask(String(PROJECT_ID), WORKER, randomUUID(), String(OWNER));

    const released = await releaseTask(String(PROJECT_ID), String(_id), { workerId: WORKER });

    expect(released).not.toBeNull();
    expectNotAModifyResult(released!);
    expect(String(released!._id)).toBe(String(_id));
    expect(released!.taskNumber).toBe(taskNumber);
    expect(released!.status).toBe(APPROVED);
    expect(released!.execution.attempts).toBe(0);
    expect(released!.execution.runId ?? "").toBe("");
  });

  test("a charged release out of attempts returns the task parked for a person", async () => {
    const { _id, taskNumber } = await addTask({ execution: { attempts: MAX_EXECUTION_ATTEMPTS - 1 } });
    await claimNextTask(String(PROJECT_ID), WORKER, randomUUID(), String(OWNER));

    const released = await releaseTask(String(PROJECT_ID), String(_id), {
      refund: false,
      workerId: WORKER,
    });

    expect(released).not.toBeNull();
    expectNotAModifyResult(released!);
    expect(released!.taskNumber).toBe(taskNumber);
    expect(released!.status).toBe(ESCALATION);
    expect(released!.execution.attempts).toBe(MAX_EXECUTION_ATTEMPTS);
    expect(released!.execution.runId ?? "").toBe("");
  });
});

// Over HTTP, reading the fields worker/src/api.ts reads off the claim: `_id`, `taskNumber`,
// `execution.attempts` and `execution.runId`
test.describe("a claim and a lease reclaim, through the worker's routes", () => {
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

  async function expireLease(_id: mongoose.Types.ObjectId) {
    const handle = await db();
    await handle.collection("tasks").updateOne(
      { _id },
      { $set: { "execution.startedAt": new Date(Date.now() - EXECUTION_LEASE_MS - 60_000) } }
    );
  }

  test.beforeEach(async () => {
    const handle = await db();
    await handle.collection("agentblocks").updateOne(
      { key: "implement" },
      { $set: { key: "implement", kind: "step", name: "Implement", description: "", prompt: "make the change", capability: "edit", model: "opus", fallbackModel: "sonnet", deterministic: false, builtIn: true } },
      { upsert: true }
    );
    await handle.collection("agents").deleteMany({ _id: AGENT_ID });
    await handle.collection("agents").insertOne({
      _id: AGENT_ID, name: "The owner's own", description: "", scope: "user", owner: OWNER, project: null, composition: RUNNABLE, builtIn: false,
    });
    const identity = new mongoose.Types.ObjectId();
    await handle.collection("users").insertOne({
      _id: identity,
      username: "worker-claim-document",
      fullName: "rig · worker-claim-document",
      password: await bcrypt.hash("unused-worker-claim-document", 4),
      email: "",
      kind: "machine",
      role: "member",
      createdAt: new Date(),
    });
    await handle.collection("workers").updateOne(
      { _id: WORKER_ID },
      { $set: { owner: OWNER, identity, repos: [{ remote: REMOTE, path: "/e2e/checkout" }], lastSeenAt: new Date() } }
    );
    await handle.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { githubRepo: REMOTE } });
  });

  test("an expired lease is reclaimed and the same task claimed again", async ({ request }) => {
    const { _id, taskNumber } = await addTask();

    const first = await claim(request);
    expect(first._id).toBe(String(_id));
    expect(first.taskNumber).toBe(taskNumber);
    expect(first.status).toBe(ACTIVE);
    expect(first.execution.attempts).toBe(1);
    expect(first.execution.runId).toMatch(/^[0-9a-f-]{36}$/);

    await expireLease(_id);
    const second = await claim(request);

    expect(second._id).toBe(String(_id));
    expect(second.taskNumber).toBe(taskNumber);
    expect(second.execution.attempts).toBe(2);
    expect(second.execution.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.execution.runId).not.toBe(first.execution.runId);
    const after = await stored(_id);
    expect(after?.status).toBe(ACTIVE);
    expect(after?.execution.runId).toBe(second.execution.runId);
  });

  // The control for the reclaim above: a lease that has not run out keeps its run
  test("a live lease is not reclaimed", async ({ request }) => {
    const { _id } = await addTask();

    const first = await claim(request);
    expect(first._id).toBe(String(_id));

    expect(await claim(request)).toBeNull();
    expect((await stored(_id))?.execution.runId).toBe(first.execution.runId);
  });

  test("an expired lease out of attempts is parked for a person, not claimed again", async ({
    request,
  }) => {
    const { _id } = await addTask({ execution: { attempts: MAX_EXECUTION_ATTEMPTS - 1 } });

    const first = await claim(request);
    expect(first.execution.attempts).toBe(MAX_EXECUTION_ATTEMPTS);

    await expireLease(_id);

    expect(await claim(request)).toBeNull();
    const after = await stored(_id);
    expect(after?.status).toBe(ESCALATION);
    expect(after?.execution.runId ?? "").toBe("");
  });

  test("the worker's release answers with the released task", async ({ request }) => {
    const { _id, taskNumber } = await addTask();
    await claim(request);

    const released = await request.post(`/api/projects/${PROJECT_ID}/tasks/${_id}/release`, {
      headers: asWorker,
      data: {},
    });

    expect(released.status(), await released.text()).toBe(200);
    const body = await released.json();
    expect(body._id).toBe(String(_id));
    expect(body.taskNumber).toBe(taskNumber);
    expect(body.status).toBe(APPROVED);
    expect(body.execution).toBeUndefined();
    const after = await stored(_id);
    expect(after?.execution.attempts).toBe(0);
    expect(after?.execution.runId ?? "").toBe("");
  });
});
