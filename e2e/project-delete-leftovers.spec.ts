import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import {
  ADMIN_ID,
  API_TOKEN,
  E2E_MONGODB_URI,
  MEMBER_ID,
  OTHER_PROJECT_ID,
  OTHER_PROJECT_KEY,
  OWNER_ID,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  WORKER_ID,
  seed,
  seedSearchCorpus,
} from "./seed";
import { signIn } from "./session";

/** BP-792. Deleting a board takes every row naming it elsewhere, and never widens a credential. */

const id = (hex: string) => new mongoose.Types.ObjectId(hex);

const ONLY_DELETED_TOKEN = "cp_e792a001deadbeefdeadbeefdeadbeef";
const BOTH_BOARDS_TOKEN = "cp_e792a002deadbeefdeadbeefdeadbeef";
const ONLY_DELETED_OAUTH = "cpat_e792only0deadbeefdeadbeefdeadbeef";
const BOTH_BOARDS_OAUTH = "cpat_e792both0deadbeefdeadbeefdeadbeef";
const OAUTH_CLIENT_ID = "e2e-bp792-client";
const SECOND_WORKER_ID = id("e2e00000000000000000b792");
const RUN_TASK_KEY = `${PROJECT_KEY}-792`;

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

const both = [PROJECT_ID, OTHER_PROJECT_ID];
const deletedOnly = [PROJECT_ID];

test.beforeEach(async () => {
  await seed();
  await seedSearchCorpus();
  const handle = await db();
  const now = new Date();
  const later = new Date(now.getTime() + 60 * 60 * 1000);

  await handle.collection("grants").insertOne({
    subject: OWNER_ID,
    relation: "owner",
    objectType: "project",
    object: OTHER_PROJECT_ID,
    createdBy: ADMIN_ID,
    createdAt: now,
    updatedAt: now,
  });

  const apiToken = (_id: string, raw: string, allowedProjects: mongoose.Types.ObjectId[]) => ({
    _id: id(_id),
    user: OWNER_ID,
    name: `bp792 ${raw.slice(0, 11)}`,
    tokenHash: bcrypt.hashSync(raw, 10),
    prefix: raw.slice(0, 11),
    allowedProjects,
    lastUsedAt: null,
    createdAt: now,
  });
  await handle.collection("apitokens").insertMany([
    apiToken("e2e00000000000000000a792", ONLY_DELETED_TOKEN, deletedOnly),
    apiToken("e2e00000000000000000a793", BOTH_BOARDS_TOKEN, both),
  ]);

  await handle.collection("oauthclients").insertOne({
    clientId: OAUTH_CLIENT_ID,
    clientName: "BP-792 client",
    redirectUris: ["http://localhost/callback"],
    createdAt: now,
  });
  const oauthToken = (raw: string, allowedProjects: mongoose.Types.ObjectId[]) => ({
    accessTokenHash: sha256(raw),
    refreshTokenHash: sha256(`${raw}-refresh`),
    clientId: OAUTH_CLIENT_ID,
    user: OWNER_ID,
    scope: "mcp",
    allowedProjects,
    accessExpiresAt: later,
    refreshExpiresAt: later,
    createdAt: now,
  });
  await handle.collection("oauthtokens").insertMany([
    oauthToken(ONLY_DELETED_OAUTH, deletedOnly),
    oauthToken(BOTH_BOARDS_OAUTH, both),
  ]);
  const oauthCode = (name: string, allowedProjects: mongoose.Types.ObjectId[]) => ({
    codeHash: sha256(name),
    clientId: OAUTH_CLIENT_ID,
    user: OWNER_ID,
    redirectUri: "http://localhost/callback",
    codeChallenge: "challenge",
    scope: "mcp",
    allowedProjects,
    used: false,
    expiresAt: later,
    createdAt: now,
  });
  await handle.collection("oauthcodes").insertMany([
    oauthCode("only-deleted", deletedOnly),
    oauthCode("both-boards", both),
  ]);

  await handle.collection("workers").updateOne({ _id: WORKER_ID }, { $set: { desiredProjects: both } });
  await handle.collection("workers").insertOne({
    _id: SECOND_WORKER_ID,
    name: "bp792-second-machine",
    host: "bp792-host",
    protocolVersion: 1,
    owner: OWNER_ID,
    credentialHash: sha256("bp792-worker-credential"),
    enabled: true,
    repos: [],
    desiredProjects: deletedOnly,
    createdAt: now,
    updatedAt: now,
  });

  const override = (project: mongoose.Types.ObjectId) => ({ project, matrix: {} });
  for (const user of [OWNER_ID, MEMBER_ID]) {
    await handle
      .collection("users")
      .updateOne(
        { _id: user },
        { $set: { "notifications.projects": [override(PROJECT_ID), override(OTHER_PROJECT_ID)] } }
      );
  }

  const trigger = (project: mongoose.Types.ObjectId, taskKey: string) => ({
    project,
    type: "needs_human_review",
    taskKey,
    task: new mongoose.Types.ObjectId(),
    state: "pending",
    active: true,
    attempts: 0,
    lastError: "",
    createdAt: now,
    updatedAt: now,
  });
  await handle
    .collection("pmtriggers")
    .insertMany([trigger(PROJECT_ID, `${PROJECT_KEY}-1`), trigger(OTHER_PROJECT_ID, `${OTHER_PROJECT_KEY}-1`)]);

  const pending = (project: mongoose.Types.ObjectId, state: string) => ({
    state,
    project,
    serverName: "Linear",
    codeVerifier: "verifier",
    initiatedBy: OWNER_ID,
    createdAt: now,
  });
  await handle
    .collection("pmoauthstates")
    .insertMany([pending(PROJECT_ID, "bp792-deleted"), pending(OTHER_PROJECT_ID, "bp792-kept")]);

  const agent = (name: string, over: Record<string, unknown>) => ({
    name,
    description: "",
    owner: null,
    project: null,
    composition: { analysis: [], implementation: [], verification: [], delivery: [] },
    builtIn: false,
    createdAt: now,
    updatedAt: now,
    ...over,
  });
  await handle.collection("agents").insertMany([
    agent("BP-792 deleted board agent", { scope: "project", project: PROJECT_ID }),
    agent("BP-792 other board agent", { scope: "project", project: OTHER_PROJECT_ID }),
    agent("BP-792 personal agent", { scope: "user", owner: OWNER_ID }),
  ]);

  await handle.collection("agentruns").insertOne({
    project: PROJECT_ID,
    task: new mongoose.Types.ObjectId(),
    taskKey: RUN_TASK_KEY,
    worker: WORKER_ID,
    agent: null,
    agentName: "BP-792 deleted board agent",
    outcome: "delivered",
    refusedBy: "",
    detail: "Opened pull request #792",
    startedAt: new Date(now.getTime() - 5 * 60_000),
    finishedAt: new Date(now.getTime() - 60_000),
    costUsd: 0,
    createdAt: now,
    updatedAt: now,
  });
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

async function status(request: APIRequestContext, token: string, path: string) {
  const response = await request.get(path, { headers: { Authorization: `Bearer ${token}` } });
  return response.status();
}

async function boardKeys(request: APIRequestContext, token: string) {
  const response = await request.get("/api/projects", { headers: { Authorization: `Bearer ${token}` } });
  if (response.status() !== 200) return response.status();
  return ((await response.json()) as { key: string }[]).map((p) => p.key).sort();
}

async function deleteBoardThroughSettings(page: Page) {
  await signIn(page, "owner");
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=general`);
  await expect(page.getByLabel("Project name")).toHaveValue(PROJECT_NAME);

  const deleted = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/projects/${PROJECT_KEY}` && r.request().method() === "DELETE"
  );
  await page.getByRole("button", { name: "Delete project..." }).click();
  await expect(page.getByRole("dialog")).toContainText(`Delete "${PROJECT_NAME}"?`);
  await page.getByRole("button", { name: "Delete project", exact: true }).click();
  const response = await deleted;
  expect(response.status(), await response.text()).toBe(200);
  await expect(page).toHaveURL(/\/projects$/);
}

const idsOf = (rows: mongoose.mongo.Document[]) =>
  rows.map((r) => ((r.allowedProjects ?? []) as unknown[]).map(String));

test("a credential scoped only to the deleted board stops working instead of reaching every board", async ({
  page,
  request,
}) => {
  expect(await status(request, ONLY_DELETED_TOKEN, `/api/projects/${PROJECT_KEY}`)).toBe(200);
  expect(await status(request, ONLY_DELETED_TOKEN, `/api/projects/${OTHER_PROJECT_KEY}`)).toBe(403);
  expect(await status(request, ONLY_DELETED_OAUTH, `/api/projects/${OTHER_PROJECT_KEY}`)).toBe(403);
  expect(await boardKeys(request, BOTH_BOARDS_TOKEN)).toEqual([OTHER_PROJECT_KEY, PROJECT_KEY].sort());

  await deleteBoardThroughSettings(page);

  for (const token of [ONLY_DELETED_TOKEN, ONLY_DELETED_OAUTH]) {
    expect(await status(request, token, `/api/projects/${OTHER_PROJECT_KEY}`), token).toBe(401);
    expect(await boardKeys(request, token), token).toBe(401);
  }
  for (const token of [BOTH_BOARDS_TOKEN, BOTH_BOARDS_OAUTH]) {
    expect(await status(request, token, `/api/projects/${OTHER_PROJECT_KEY}`), token).toBe(200);
    expect(await boardKeys(request, token), token).toEqual([OTHER_PROJECT_KEY]);
  }
  expect(await status(request, API_TOKEN, `/api/projects/${OTHER_PROJECT_KEY}`)).toBe(200);

  const handle = await db();
  const owned = { user: OWNER_ID };
  expect(idsOf(await handle.collection("apitokens").find(owned).toArray())).toEqual([
    [String(OTHER_PROJECT_ID)],
  ]);
  expect(idsOf(await handle.collection("oauthtokens").find(owned).toArray())).toEqual([
    [String(OTHER_PROJECT_ID)],
  ]);
  expect(idsOf(await handle.collection("oauthcodes").find(owned).toArray())).toEqual([
    [String(OTHER_PROJECT_ID)],
  ]);
  expect(
    (await handle.collection("apitokens").find({ allowedProjects: { $size: 0 } }).toArray())
      .map((t) => t.name)
      .sort()
  ).toEqual(["e2e mcp", "e2e member"]);
});

test("deleting a board drops the rows that name it and leaves another board's", async ({ page }) => {
  await deleteBoardThroughSettings(page);

  const handle = await db();
  const pickedBy = async (_id: mongoose.Types.ObjectId) =>
    ((await handle.collection("workers").findOne({ _id }))?.desiredProjects ?? null)?.map(String);
  expect(await pickedBy(WORKER_ID)).toEqual([String(OTHER_PROJECT_ID)]);
  expect(await pickedBy(SECOND_WORKER_ID)).toEqual([]);

  for (const user of [OWNER_ID, MEMBER_ID]) {
    const row = await handle.collection("users").findOne({ _id: user });
    expect(row?.notifications.projects.map((o: { project: unknown }) => String(o.project))).toEqual([
      String(OTHER_PROJECT_ID),
    ]);
  }

  const projectsOf = async (collection: string, filter = {}) =>
    (await handle.collection(collection).find(filter).toArray()).map((r) => String(r.project)).sort();
  expect(await projectsOf("pmtriggers")).toEqual([String(OTHER_PROJECT_ID)]);
  expect(await projectsOf("pmoauthstates")).toEqual([String(OTHER_PROJECT_ID)]);

  const agents = (await handle.collection("agents").find({ name: /^BP-792/ }).toArray())
    .map((a) => a.name)
    .sort();
  expect(agents).toEqual(["BP-792 other board agent", "BP-792 personal agent"]);

  expect(await projectsOf("agentruns", { taskKey: RUN_TASK_KEY })).toEqual([String(PROJECT_ID)]);
});

test("the fleet's run history keeps a deleted board's run and names the board as deleted", async ({
  page,
}) => {
  await deleteBoardThroughSettings(page);
  await page.context().clearCookies();

  await signIn(page);
  const runs = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/runs");
  await page.goto("/settings/workers/runs");
  expect((await runs).status()).toBe(200);

  const row = page.getByRole("row").filter({ hasText: RUN_TASK_KEY });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Deleted project");
  await expect(row).not.toContainText(PROJECT_NAME);
  await expect(page.getByText("Opened pull request #792")).toBeVisible();
});
