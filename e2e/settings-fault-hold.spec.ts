import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { ADMIN_AUTH } from "./api";
import { ADMIN_ID, E2E_MONGODB_URI, PROJECT_ID, WORKER_CREDENTIAL, WORKER_ID, seed } from "./seed";

/**
 * BP-1117. A project's own commands that cannot run stop a run before any step. Claimed and reported
 * over HTTP with a worker credential: the hold is a filter MongoDB evaluates and the refund a pipeline
 * update, so only real writes show that one task fails, the next stays put, and no attempt is spent.
 */

const APPROVED = "todo";
const ACTIVE = "in_progress";
const REVIEW = "needs_human_review";
const HELD_AGENT = new mongoose.Types.ObjectId();
const OTHER_AGENT = new mongoose.Types.ObjectId();
const REPO = "https://github.com/e2e-owner/settings-fault";
const GATES = ["test-run"];

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

const compose = (verification: unknown[]) => ({ analysis: [], implementation: [{ key: "hold-step" }], verification, delivery: [{ key: "hold-push" }] });

async function seedHold() {
  await seed();
  const handle = await db();
  const base = { description: "", builtIn: false, params: {}, provider: "claude", model: "", fallbackModel: "", createdAt: new Date(), updatedAt: new Date() };
  await handle.collection("agentblocks").deleteMany({ key: { $in: ["hold-step", "hold-push", "hold-tests"] } });
  await handle.collection("agentblocks").insertMany([
    { ...base, key: "hold-step", kind: "step", name: "Step", prompt: "make the change", capability: "edit", gateKind: "", deterministic: false },
    { ...base, key: "hold-push", kind: "step", name: "Push", prompt: "", capability: "read-only", gateKind: "", deterministic: true },
    { ...base, key: "hold-tests", kind: "gate", name: "Tests pass", prompt: "", capability: "read-only", gateKind: "test-run", deterministic: false },
  ]);
  const agent = (_id: mongoose.Types.ObjectId, name: string, composition: unknown) => ({
    _id, name, description: "", scope: "user", owner: ADMIN_ID, project: null, composition, builtIn: false,
  });
  await handle.collection("agents").deleteMany({ _id: { $in: [HELD_AGENT, OTHER_AGENT] } });
  await handle.collection("agents").insertMany([
    agent(HELD_AGENT, "Runs the tests", compose([{ key: "hold-tests" }])),
    agent(OTHER_AGENT, "Runs no tests", compose([])),
  ]);
  await handle.collection("tasks").deleteMany({ project: PROJECT_ID, status: APPROVED });
  await handle.collection("projects").updateOne(
    { _id: PROJECT_ID },
    { $set: { repositoryUrl: REPO, repositories: [] }, $unset: { githubRepo: "", gitlabRepo: "" } }
  );
  const identity = new mongoose.Types.ObjectId();
  await handle.collection("users").insertOne({
    _id: identity,
    username: "worker-settings-fault",
    fullName: "rig · worker-settings-fault",
    password: await bcrypt.hash("unused-worker-settings-fault", 4),
    email: "",
    kind: "machine",
    role: "member",
    createdAt: new Date(),
  });
  await handle.collection("workers").updateOne(
    { _id: WORKER_ID },
    { $set: { owner: ADMIN_ID, identity, repos: [{ remote: `${REPO}.git`, path: "/e2e/settings-fault" }], lastSeenAt: new Date() } }
  );
}

let nextNumber = 3300;
async function addTask(agent: mongoose.Types.ObjectId, attempts = 0) {
  const handle = await db();
  const _id = new mongoose.Types.ObjectId();
  const taskNumber = nextNumber++;
  await handle.collection("tasks").insertOne({
    _id, project: PROJECT_ID, taskNumber, title: `settings ${taskNumber}`, description: "", priority: "medium", category: "user-story",
    status: APPROVED, assignee: ADMIN_ID, assignedBy: ADMIN_ID, agent, checklist: [], linkedPRs: [], blockedBy: [], relations: [],
    watchers: [], customFieldValues: {}, order: taskNumber, createdBy: ADMIN_ID, createdAt: new Date(), updatedAt: new Date(),
    execution: { attempts },
  });
  return { _id, taskNumber };
}

const stored = async (_id: mongoose.Types.ObjectId) => (await db()).collection("tasks").findOne({ _id });

const asWorker = { authorization: `Bearer ${WORKER_CREDENTIAL}`, "x-worker-id": String(WORKER_ID), "x-cp-protocol": "1" };

const claim = (request: APIRequestContext, heldAgents?: unknown) =>
  request.post(`/api/projects/${PROJECT_ID}/tasks/claim`, { headers: asWorker, data: { runId: randomUUID(), ...(heldAgents ? { heldAgents } : {}) } });

const holding = () => [{ agentId: String(HELD_AGENT), gates: GATES }];

const report = (request: APIRequestContext, taskId: mongoose.Types.ObjectId, data: unknown, headers: Record<string, string> = asWorker) =>
  request.patch(`/api/projects/${PROJECT_ID}/tasks/${taskId}/status`, { headers, data });

test.describe("a project's own commands that cannot run", () => {
  test.beforeEach(seedHold);

  test("one task fails, the next stays in its column with its attempts, and the project's other work flows", async ({ request }) => {
    const first = await addTask(HELD_AGENT, 2);
    const next = await addTask(HELD_AGENT, 1);
    const other = await addTask(OTHER_AGENT);

    const taken = await claim(request);
    expect(taken.status(), await taken.text()).toBe(200);
    expect((await taken.json())._id).toBe(String(first._id));
    expect((await stored(first._id))?.execution.attempts).toBe(3);

    const reported = await report(request, first._id, { status: REVIEW, refundAttempt: true });
    expect(reported.status(), await reported.text()).toBe(200);
    const failed = await stored(first._id);
    expect(failed?.status).toBe(REVIEW);
    expect(failed?.execution.attempts).toBe(2);
    expect(failed?.execution.runId ?? "").toBe("");

    const flowed = await claim(request, holding());
    expect(flowed.status(), await flowed.text()).toBe(200);
    expect((await flowed.json())._id).toBe(String(other._id));

    const held = await stored(next._id);
    expect(held?.status).toBe(APPROVED);
    expect(held?.execution.attempts).toBe(1);
    expect((await claim(request, holding())).status()).toBe(204);
  });

  // The control: the same task, with the same machine asking, is only left alone because of the hold
  test("a machine that holds nothing takes the same task", async ({ request }) => {
    const { _id } = await addTask(HELD_AGENT);

    const answer = await claim(request);

    expect(answer.status(), await answer.text()).toBe(200);
    expect((await answer.json())._id).toBe(String(_id));
  });

  test("taking the gate out of the agent, as the fault's own message offers, is what lets it through", async ({ request }) => {
    const { _id } = await addTask(HELD_AGENT);
    expect((await claim(request, holding())).status()).toBe(204);

    await (await db()).collection("agents").updateOne({ _id: HELD_AGENT }, { $set: { composition: compose([]) } });

    const answer = await claim(request, holding());
    expect(answer.status(), await answer.text()).toBe(200);
    expect((await answer.json())._id).toBe(String(_id));
  });

  test("a report replayed after the run ended gives nothing back a second time", async ({ request }) => {
    const { _id } = await addTask(HELD_AGENT, 1);
    await claim(request);

    expect((await report(request, _id, { status: REVIEW, refundAttempt: true })).status()).toBe(200);
    expect((await report(request, _id, { status: REVIEW, refundAttempt: true })).status()).toBe(200);

    expect((await stored(_id))?.execution.attempts).toBe(1);
  });

  test("only the worker holding the run gets the attempt back", async ({ request }) => {
    const { _id } = await addTask(HELD_AGENT, 1);
    await claim(request);

    const asPerson = await request.patch(`/api/projects/${PROJECT_ID}/tasks/${_id}/status`, {
      headers: ADMIN_AUTH,
      data: { status: REVIEW, refundAttempt: true },
    });
    expect(asPerson.status()).toBe(403);

    const held = await stored(_id);
    expect(held?.status).toBe(ACTIVE);
    expect(held?.execution.attempts).toBe(2);
  });

  test("a claim naming something that is not an agent is refused, and takes no task", async ({ request }) => {
    const { _id } = await addTask(HELD_AGENT);

    const answer = await claim(request, [{ agentId: { $ne: null }, gates: [] }]);

    expect(answer.status()).toBe(400);
    expect((await stored(_id))?.status).toBe(APPROVED);
  });
});
