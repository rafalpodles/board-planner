import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { ADMIN_AUTH } from "./api";
import { ADMIN_ID, E2E_MONGODB_URI, PROJECT_ID, WORKER_CREDENTIAL, WORKER_ID, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-987. A step and the review gate name the coding CLI they run on. Authored through the editor and
 * read back from Mongo, and claimed over HTTP with a worker credential: the claim is a filter MongoDB
 * evaluates, so only a real claim shows that a machine without Codex is never handed a Codex task.
 */

const APPROVED = "todo";
const CLAUDE_AGENT = new mongoose.Types.ObjectId();
const CODEX_AGENT = new mongoose.Types.ObjectId();
const CODEX_REVIEW_AGENT = new mongoose.Types.ObjectId();
const REPO = "https://github.com/e2e-owner/provider";

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

const compose = (implementation: unknown[], verification: unknown[] = []) => ({ analysis: [], implementation, verification, delivery: [] });

async function seedProviders() {
  await seed();
  const handle = await db();
  const base = { description: "", builtIn: false, gateKind: "", params: {}, createdAt: new Date(), updatedAt: new Date() };
  await handle.collection("agentblocks").deleteMany({ key: { $in: ["claude-step", "codex-step", "plain-review"] } });
  await handle.collection("agentblocks").insertMany([
    { ...base, key: "claude-step", kind: "step", name: "Claude step", prompt: "make the change", capability: "edit", provider: "claude", model: "opus", fallbackModel: "sonnet", deterministic: false },
    { ...base, key: "codex-step", kind: "step", name: "Codex step", prompt: "make the change", capability: "edit", provider: "codex", model: "gpt-5", fallbackModel: "", deterministic: false },
    { ...base, key: "plain-review", kind: "gate", name: "Plain review", gateKind: "review", params: { focus: "general", provider: "claude", model: "opus" }, capability: "read-only", provider: "claude", model: "", fallbackModel: "", deterministic: false },
  ]);
  await handle.collection("agents").deleteMany({ _id: { $in: [CLAUDE_AGENT, CODEX_AGENT, CODEX_REVIEW_AGENT] } });
  const agent = (_id: mongoose.Types.ObjectId, name: string, composition: unknown) => ({
    _id, name, description: "", scope: "user", owner: ADMIN_ID, project: null, composition, builtIn: false,
  });
  await handle.collection("agents").insertMany([
    agent(CLAUDE_AGENT, "On Claude", compose([{ key: "claude-step" }], [{ key: "plain-review" }])),
    agent(CODEX_AGENT, "On Codex", compose([{ key: "codex-step" }])),
    // The block is on Claude; only the position names Codex, which is where a per-position parameter reaches the worker
    agent(CODEX_REVIEW_AGENT, "Reviewed on Codex", compose([{ key: "claude-step" }], [{ key: "plain-review", params: { provider: "codex", model: "gpt-5" } }])),
  ]);
  await handle.collection("tasks").deleteMany({ project: PROJECT_ID, status: APPROVED });
  await handle.collection("projects").updateOne(
    { _id: PROJECT_ID },
    { $set: { repositoryUrl: REPO, repositories: [] }, $unset: { githubRepo: "", gitlabRepo: "" } }
  );
  const identity = new mongoose.Types.ObjectId();
  await handle.collection("users").insertOne({
    _id: identity,
    username: "worker-provider",
    fullName: "rig · worker-provider",
    password: await bcrypt.hash("unused-worker-provider", 4),
    email: "",
    kind: "machine",
    role: "member",
    createdAt: new Date(),
  });
  await handle.collection("workers").updateOne(
    { _id: WORKER_ID },
    { $set: { owner: ADMIN_ID, identity, repos: [{ remote: `${REPO}.git`, path: "/e2e/provider" }], lastSeenAt: new Date() } }
  );
}

let nextNumber = 3100;
async function addTask(agent: mongoose.Types.ObjectId) {
  const handle = await db();
  const _id = new mongoose.Types.ObjectId();
  const taskNumber = nextNumber++;
  await handle.collection("tasks").insertOne({
    _id, project: PROJECT_ID, taskNumber, title: `provider ${taskNumber}`, description: "", priority: "medium", category: "user-story",
    status: APPROVED, assignee: ADMIN_ID, assignedBy: ADMIN_ID, agent, checklist: [], linkedPRs: [], blockedBy: [], relations: [],
    watchers: [], customFieldValues: {}, order: taskNumber, createdBy: ADMIN_ID, createdAt: new Date(), updatedAt: new Date(),
  });
  return { _id, taskNumber };
}

test.describe("which machine a task on a coding CLI is given to", () => {
  const asWorker = (capabilities?: string) => ({
    authorization: `Bearer ${WORKER_CREDENTIAL}`,
    "x-worker-id": String(WORKER_ID),
    "x-cp-protocol": "1",
    ...(capabilities ? { "x-cp-capabilities": capabilities } : {}),
  });
  const claim = (request: APIRequestContext, capabilities?: string) =>
    request.post(`/api/projects/${PROJECT_ID}/tasks/claim`, { headers: asWorker(capabilities), data: { runId: randomUUID() } });

  test.beforeEach(seedProviders);

  test("a machine that does not report Codex is given no Codex task, and the task stays where it was", async ({ request }) => {
    const { _id } = await addTask(CODEX_AGENT);

    const answer = await claim(request, "agent-claude");

    expect(answer.status()).toBe(204);
    expect((await (await db()).collection("tasks").findOne({ _id }))?.status).toBe(APPROVED);
  });

  test("a machine that reports Codex takes it, and the snapshot names the provider and its model", async ({ request }) => {
    const { _id } = await addTask(CODEX_AGENT);

    const answer = await claim(request, "agent-claude,agent-codex");

    expect(answer.status(), await answer.text()).toBe(200);
    const body = await answer.json();
    expect(body._id).toBe(String(_id));
    expect(body.agent.sequence[0]).toMatchObject({ key: "codex-step", provider: "codex", model: "gpt-5" });
  });

  test("steps over the Codex task to the Claude one behind it, rather than stopping at it", async ({ request }) => {
    await addTask(CODEX_AGENT);
    const claude = await addTask(CLAUDE_AGENT);

    const answer = await claim(request, "agent-claude");

    expect(answer.status(), await answer.text()).toBe(200);
    expect((await answer.json())._id).toBe(String(claude._id));
  });

  test("a review that only a position's own parameter puts on Codex is held to the same rule", async ({ request }) => {
    await addTask(CODEX_REVIEW_AGENT);

    expect((await claim(request, "agent-claude")).status()).toBe(204);
    const taken = await claim(request, "agent-codex");
    expect(taken.status(), await taken.text()).toBe(200);
    expect((await taken.json()).agent.sequence[1].params).toMatchObject({ provider: "codex", model: "gpt-5" });
  });

  // The control: a worker built before this said nothing about agents and ran Claude Code only
  test("a worker that says nothing still takes a task on Claude Code, as every worker did", async ({ request }) => {
    const { _id } = await addTask(CLAUDE_AGENT);

    const answer = await claim(request);

    expect(answer.status(), await answer.text()).toBe(200);
    expect((await answer.json())._id).toBe(String(_id));
    expect((await answer.json()).agent.sequence[0]).toMatchObject({ provider: "claude" });
  });

  test("a heartbeat keeps the coding CLIs a worker named, and drops them on the next that does not", async ({ request }) => {
    const beat = (capabilities?: string) =>
      request.post(`/api/workers/${WORKER_ID}/heartbeat`, { headers: asWorker(capabilities), data: { repos: [{ remote: `${REPO}.git`, path: "/e2e/provider" }] } });

    expect((await beat("agent-claude,agent-codex")).status()).toBe(200);
    expect((await (await db()).collection("workers").findOne({ _id: WORKER_ID }))?.capabilities).toEqual(["agent-claude", "agent-codex"]);

    expect((await beat()).status()).toBe(200);
    expect((await (await db()).collection("workers").findOne({ _id: WORKER_ID }))?.capabilities).toEqual([]);
  });
});

test.describe("choosing the coding CLI in the editor", () => {
  test.beforeEach(seedProviders);

  async function openSteps(page: Page) {
    await page.goto("/agents");
    await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
    await page.getByRole("tab", { name: "Steps" }).click();
  }

  test("a step authored on Codex keeps its provider and the model typed for it", async ({ page }) => {
    await signIn(page);
    await openSteps(page);
    await page.getByRole("button", { name: "New step" }).click();
    const dialog = page.getByRole("dialog", { name: "New step" });
    await dialog.getByPlaceholder("Write the tests").fill("Write it on Codex");

    await dialog.getByLabel("Runs on").selectOption({ label: "Codex" });
    await expect(dialog.getByText(/shell and has network access/)).toBeVisible();
    // Nothing is guessed for Codex, so creating waits for a name
    await expect(dialog.getByRole("button", { name: "Create" })).toBeDisabled();
    await dialog.getByLabel("Model", { exact: true }).fill("gpt-6.1-sol");

    const written = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/agent-blocks");
    await dialog.getByRole("button", { name: "Create" }).click();
    expect((await written).status()).toBe(201);

    const stored = await (await db()).collection("agentblocks").findOne({ name: "Write it on Codex" });
    expect(stored).toMatchObject({ provider: "codex", model: "gpt-6.1-sol", fallbackModel: "" });
  });

  test("a step authored without touching the choice is on Claude Code, as before", async ({ page }) => {
    await signIn(page);
    await openSteps(page);
    await page.getByRole("button", { name: "New step" }).click();
    const dialog = page.getByRole("dialog", { name: "New step" });
    await dialog.getByPlaceholder("Write the tests").fill("Plain step");
    const written = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/agent-blocks");
    await dialog.getByRole("button", { name: "Create" }).click();
    expect((await written).status()).toBe(201);

    expect(await (await db()).collection("agentblocks").findOne({ name: "Plain step" })).toMatchObject({ provider: "claude", model: "opus" });
  });

  test("moving an existing step to Codex saves the pair, and the list says so", async ({ page }) => {
    await signIn(page);
    await openSteps(page);
    await page.getByRole("button", { name: "Claude step", exact: true }).click();
    const dialog = page.getByRole("dialog");

    await dialog.getByLabel("Runs on").selectOption({ label: "Codex" });
    await dialog.getByLabel("Model", { exact: true }).fill("gpt-5.6-luna");
    const written = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname.startsWith("/api/agent-blocks/"));
    await dialog.getByRole("button", { name: "Save" }).click();
    expect((await written).status()).toBe(200);

    expect(await (await db()).collection("agentblocks").findOne({ key: "claude-step" })).toMatchObject({ provider: "codex", model: "gpt-5.6-luna" });
    await expect(page.getByRole("button", { name: "Claude step", exact: true }).locator("xpath=ancestor::li[1]")).toContainText("Codex");
  });

  test("the review gate offers a reviewer, and a Codex review keeps its provider among the parameters", async ({ page }) => {
    await signIn(page);
    await page.goto("/agents");
    await page.getByRole("tab", { name: "Gates" }).click();
    await page.getByRole("button", { name: "New gate" }).click();
    const dialog = page.getByRole("dialog", { name: "New gate" });
    await dialog.getByLabel("What it checks").selectOption({ label: "Reviewed" });
    await dialog.getByPlaceholder(/stricter/).fill("Reviewed by Codex");
    await dialog.getByLabel("Reviewer").selectOption({ label: "Codex" });
    await dialog.getByLabel("Model", { exact: true }).fill("gpt-6.1-sol");
    const written = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/agent-blocks");
    await dialog.getByRole("button", { name: "Create" }).click();
    expect((await written).status()).toBe(201);

    expect(await (await db()).collection("agentblocks").findOne({ name: "Reviewed by Codex" })).toMatchObject({
      gateKind: "review",
      params: { provider: "codex", model: "gpt-6.1-sol" },
    });
  });

  test("the API refuses a pair that cannot exist, naming why, and stores nothing", async ({ request }) => {
    for (const [body, message] of [
      [{ provider: "codex", model: "sonnet" }, /Claude model, not a Codex one/],
      [{ provider: "codex" }, /required for Codex/],
      [{ provider: "claude", model: "gpt-5" }, /not a Claude model/],
      [{ provider: "cursor", model: "x" }, /provider must be one of/],
    ] as const) {
      const answer = await request.post("/api/agent-blocks", {
        headers: ADMIN_AUTH,
        data: { kind: "step", name: "Refused pair", prompt: "p", capability: "edit", ...body },
      });
      expect(answer.status(), JSON.stringify(body)).toBe(400);
      expect((await answer.json()).error).toMatch(message);
    }
    expect(await (await db()).collection("agentblocks").countDocuments({ name: "Refused pair" })).toBe(0);
  });

  test("an agent may not be stored with a position that puts a review on a pair that cannot exist", async ({ request }) => {
    const answer = await request.post("/api/agents", {
      headers: ADMIN_AUTH,
      data: { name: "Bad position", composition: compose([{ key: "claude-step" }], [{ key: "plain-review", params: { provider: "codex", model: "opus" } }]) },
    });

    expect(answer.status()).toBe(400);
    expect((await answer.json()).error).toMatch(/Claude model, not a Codex one/);
  });
});
