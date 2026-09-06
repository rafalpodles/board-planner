import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  DECOY_TASK_NUMBER,
  DECOY_TASK_TITLE,
  E2E_MONGODB_URI,
  OTHER_PROJECT_ID,
  OTHER_PROJECT_KEY,
  OTHER_PROJECT_NAME,
  PROJECT_ID,
  PROJECT_KEY,
  seed,
} from "./seed";
import { signIn as arriveSignedIn } from "./session";

const OURS = "This board's agent";
const THEIRS = "Other board's agent";

const signIn = arriveSignedIn;

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

const EMPTY = { analysis: [], implementation: [], verification: [], delivery: [] };

async function insertAgent(name: string, project: mongoose.Types.ObjectId) {
  const handle = await db();
  const result = await handle.collection("agents").insertOne({
    name,
    description: "",
    scope: "project",
    owner: null,
    project,
    builtIn: false,
    composition: EMPTY,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return String(result.insertedId);
}

let theirsId: string;

test.beforeEach(async () => {
  await seed();
  const handle = await db();
  await handle.collection("projects").insertOne({
    _id: OTHER_PROJECT_ID,
    name: OTHER_PROJECT_NAME,
    key: OTHER_PROJECT_KEY,
    description: "",
    icon: "",
    categories: [],
    columns: [],
    taskTemplates: [],
    customFields: [],
    webhooks: [],
    notificationChannels: [],
    taskCounter: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await insertAgent(OURS, PROJECT_ID);
  theirsId = await insertAgent(THEIRS, OTHER_PROJECT_ID);
});

async function openAgentPicker(page: Page) {
  await signIn(page);
  const listed = page.waitForResponse((r) => r.url().includes("/api/agents") && r.ok());
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${DECOY_TASK_NUMBER}`);
  await listed;
  await expect(page.getByText(DECOY_TASK_TITLE).first()).toBeVisible();

  const row = page.getByRole("combobox", { name: /Agent/ }).first();
  await expect(row).toBeVisible();
  await row.click();
  return page.getByRole("option");
}

test("the picker offers this board's agent and withholds another board's", async ({ page }) => {
  const options = await openAgentPicker(page);
  const names = (await options.allTextContents()).join("|");

  expect(names).toContain(OURS);
  expect(names).not.toContain(THEIRS);
});

test("a task already carrying another board's agent still names it", async ({ page }) => {
  const handle = await db();
  await handle
    .collection("tasks")
    .updateOne(
      { project: PROJECT_ID, taskNumber: DECOY_TASK_NUMBER },
      { $set: { agent: new mongoose.Types.ObjectId(theirsId) } },
    );

  const options = await openAgentPicker(page);
  expect((await options.allTextContents()).join("|")).toContain(THEIRS);
});
