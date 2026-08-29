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

/**
 * BP-456. `/api/agents` answers with the project agents of every project the reader can reach —
 * every one of them, for an instance admin — and the picker filtered that list by scope alone.
 * The server refuses any whose project is not the task's, so the row offered a control that 400s
 * on click and then a retry whose only possible outcome was the same refusal.
 */

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
  /**
   * `seed()` inserts exactly one project, so without this the second board does not exist and
   * `agents/route.ts` — which widens the list to *every project that exists* for an admin —
   * never sends its agent at all. The client filter would then be untestable from here: the
   * server withholds it, and removing the filter leaves the spec green.
   */
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
  // The list this row is built from, not the rendered text: the row renders its read-only
  // branch while `agents` is still the empty array it mounts with, so waiting on what is on
  // screen means asserting the pre-fetch state.
  const listed = page.waitForResponse((r) => r.url().includes("/api/agents") && r.ok());
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${DECOY_TASK_NUMBER}`);
  await listed;
  await expect(page.getByText(DECOY_TASK_TITLE).first()).toBeVisible();

  // `Combobox` renders `role="combobox"` unconditionally; the read-only branch is a plain div
  // with no role at all, which is why the picker is reached by this role and nothing else.
  const row = page.getByRole("combobox", { name: /Agent/ }).first();
  await expect(row).toBeVisible();
  await row.click();
  return page.getByRole("option");
}

test("the picker offers this board's agent and withholds another board's", async ({ page }) => {
  const options = await openAgentPicker(page);
  const names = (await options.allTextContents()).join("|");

  // The control: withholding everything would satisfy the second line just as well. Both agents
  // reach this reader — an admin's project list is every project that exists — so the absence
  // below is the client filter's doing and not the server's.
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

  // Hiding the current value would render "No agent" over a task that is carrying one — the lie
  // the personal-agent rule beside this one is careful to avoid. Waiting on `/api/agents` inside
  // the helper is what stops this asserting the mount state, where `agents` is still `[]`.
  const options = await openAgentPicker(page);
  expect((await options.allTextContents()).join("|")).toContain(THEIRS);
});
