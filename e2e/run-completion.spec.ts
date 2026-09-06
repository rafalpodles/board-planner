import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import {
  E2E_MONGODB_URI,
  HELD_TASK_ID,
  HELD_TASK_KEY,
  PROJECT_ID,
  RUN_PHASE,
  SOURCE_COLUMN,
  TARGET_COLUMN,
  WORKER_CREDENTIAL,
  WORKER_ID,
  WORKER_NAME,
  seed,
} from "./seed";

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function giveWorkerAnIdentity(workerId: mongoose.Types.ObjectId, username: string) {
  const handle = await db();
  const identityId = new mongoose.Types.ObjectId();
  await handle.collection("users").insertOne({
    _id: identityId,
    username,
    fullName: `rig · ${username}`,
    password: await bcrypt.hash(`unused-${username}`, 4),
    email: "",
    kind: "machine",
    role: "member",
    createdAt: new Date(),
  });
  await handle.collection("workers").updateOne({ _id: workerId }, { $set: { identity: identityId } });
}

async function readTask(taskId: mongoose.Types.ObjectId) {
  const handle = await db();
  return handle.collection("tasks").findOne({ _id: taskId });
}

function workerHeaders(workerId: string, credential: string) {
  return {
    Authorization: `Bearer ${credential}`,
    "X-Worker-Id": workerId,
    "X-CP-Protocol": "1",
  };
}

test.beforeEach(async () => {
  await seed();
  await giveWorkerAnIdentity(WORKER_ID, "worker-run-completion");
});

test("the run's own holder reports its outcome the way the worker actually does — comment, then move", async ({
  request,
}) => {
  const commented = await request.post(`/api/projects/${PROJECT_ID}/tasks/${HELD_TASK_ID}/comments`, {
    headers: workerHeaders(String(WORKER_ID), WORKER_CREDENTIAL),
    data: { body: "Delivered — PR opened." },
  });
  expect(commented.status(), await commented.text()).toBe(201);

  const moved = await request.patch(`/api/projects/${PROJECT_ID}/tasks/${HELD_TASK_ID}/status`, {
    headers: workerHeaders(String(WORKER_ID), WORKER_CREDENTIAL),
    data: { status: TARGET_COLUMN.id },
  });
  expect(moved.status(), await moved.text()).toBe(200);

  const stored = await readTask(HELD_TASK_ID);
  expect(stored?.status).toBe(TARGET_COLUMN.id);
  expect(stored?.execution?.runId).toBeUndefined();
});

test("a different worker holding its own run is still refused the first worker's task", async ({
  request,
}) => {
  const otherWorkerId = new mongoose.Types.ObjectId();
  const otherCredential = "e2e-other-worker-credential";
  const otherTaskId = new mongoose.Types.ObjectId();
  const handle = await db();

  await handle.collection("workers").insertOne({
    _id: otherWorkerId,
    name: "e2e-other-worker",
    host: "e2e-host",
    platform: "darwin",
    version: "0.0.0-e2e",
    protocolVersion: 1,
    credentialHash: bcrypt.hashSync(otherCredential, 10),
    repos: [],
    policy: { pollIntervalMs: 30_000 },
    policyOverrides: [],
    enabled: true,
    lockedByInstance: false,
    lastSeenAt: new Date(),
    identity: null,
    bindingError: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await giveWorkerAnIdentity(otherWorkerId, "worker-run-completion-other");
  await handle.collection("tasks").insertOne({
    _id: otherTaskId,
    project: PROJECT_ID,
    taskNumber: 9101,
    title: "held by the other worker",
    description: "",
    status: SOURCE_COLUMN.id,
    category: "bug",
    priority: "medium",
    checklist: [],
    blockedBy: [],
    watchers: [],
    relations: [],
    linkedPRs: [],
    customFieldValues: {},
    execution: { runId: "e2e-run-other", workerId: String(otherWorkerId), attempts: 1, startedAt: new Date(), lastError: "", phase: RUN_PHASE },
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const moved = await request.patch(`/api/projects/${PROJECT_ID}/tasks/${HELD_TASK_ID}/status`, {
    headers: workerHeaders(String(otherWorkerId), otherCredential),
    data: { status: TARGET_COLUMN.id },
  });

  expect(moved.status()).toBe(409);
  const body = await moved.json();
  expect(body.error).toContain(HELD_TASK_KEY);
  expect(body.error).toContain(WORKER_NAME);

  const stored = await readTask(HELD_TASK_ID);
  expect(stored?.status).toBe(SOURCE_COLUMN.id);
  expect(stored?.execution?.runId).toBe("e2e-run-0001");
});
