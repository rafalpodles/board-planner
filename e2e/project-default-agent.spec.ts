import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH } from "./api";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed } from "./seed";

const EMPTY = { analysis: [], implementation: [], verification: [], delivery: [] };
const RUNNABLE = {
  analysis: [],
  implementation: [{ key: "implement", kind: "step", name: "Implement", access: "edit" }],
  verification: [],
  delivery: [
    { key: "push", kind: "step", name: "Push" },
    { key: "pull_request", kind: "step", name: "Pull request" },
  ],
};

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function storedDefault() {
  const handle = await db();
  const project = await handle.collection("projects").findOne({ _id: PROJECT_ID });
  return project?.worker?.agent ?? null;
}

test.beforeEach(seed);

test("a default can be set, and then cleared again", async ({ request }) => {
  const handle = await db();
  const inserted = await handle.collection("agents").insertOne({
    name: "This board's own",
    description: "",
    scope: "project",
    owner: null,
    project: PROJECT_ID,
    builtIn: false,
    composition: RUNNABLE,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const agentId = String(inserted.insertedId);

  const set = await request.put(`/api/projects/${PROJECT_KEY}/agent`, {
    headers: ADMIN_AUTH,
    data: { agentId },
  });
  expect(set.status(), await set.text()).toBe(200);
  expect(String(await storedDefault())).toBe(agentId);

  const cleared = await request.put(`/api/projects/${PROJECT_KEY}/agent`, {
    headers: ADMIN_AUTH,
    data: { agentId: "" },
  });
  expect(cleared.status(), await cleared.text()).toBe(200);
  expect(await storedDefault()).toBeNull();
});

test("a body that does not say is a refusal, not a clear", async ({ request }) => {
  const handle = await db();
  const inserted = await handle.collection("agents").insertOne({
    name: "Runnable",
    description: "",
    scope: "project",
    owner: null,
    project: PROJECT_ID,
    builtIn: false,
    composition: RUNNABLE,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const agentId = String(inserted.insertedId);
  await request.put(`/api/projects/${PROJECT_KEY}/agent`, { headers: ADMIN_AUTH, data: { agentId } });
  expect(String(await storedDefault())).toBe(agentId);

  for (const data of [{}, { agentId: null }, { agent: agentId }, { agentId: 7 }]) {
    const response = await request.put(`/api/projects/${PROJECT_KEY}/agent`, {
      headers: ADMIN_AUTH,
      data,
    });
    expect(response.status(), JSON.stringify(data)).toBe(400);
    expect(String(await storedDefault()), JSON.stringify(data)).toBe(agentId);
  }

  const cleared = await request.put(`/api/projects/${PROJECT_KEY}/agent`, {
    headers: ADMIN_AUTH,
    data: { agentId: "" },
  });
  expect(cleared.status()).toBe(200);
  expect(await storedDefault()).toBeNull();
});

test("an agent with nothing in it is still refused, and says why", async ({ request }) => {
  const handle = await db();
  const inserted = await handle.collection("agents").insertOne({
    name: "Composed nothing",
    description: "",
    scope: "project",
    owner: null,
    project: PROJECT_ID,
    builtIn: false,
    composition: EMPTY,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const response = await request.put(`/api/projects/${PROJECT_KEY}/agent`, {
    headers: ADMIN_AUTH,
    data: { agentId: String(inserted.insertedId) },
  });
  expect(response.status()).toBe(400);
  expect(await response.text()).toContain("nothing in it yet");
  expect(await storedDefault()).toBeNull();
});
