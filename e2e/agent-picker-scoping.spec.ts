import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  DECOY_TASK_NUMBER,
  DECOY_TASK_TITLE,
  E2E_MONGODB_URI,
  OTHER_PROJECT_ID,
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
  await insertAgent(OURS, PROJECT_ID);
  theirsId = await insertAgent(THEIRS, OTHER_PROJECT_ID);
});

async function openAgentPicker(page: Page) {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${DECOY_TASK_NUMBER}`);
  // The rail renders after the task arrives; probing before it does finds an empty page
  await expect(page.getByText(DECOY_TASK_TITLE).first()).toBeVisible();

  // Button or combobox: the row is a combobox once it has a value and a button when empty,
  // which is the union `PropertyRail.test.tsx` reaches for too.
  const row = page
    .getByRole("button", { name: /Agent/ })
    .or(page.getByRole("combobox", { name: /Agent/ }))
    .first();
  await expect(row).toBeVisible();
  await row.click();
  return page.getByRole("option");
}

test("the picker offers this board's agent and withholds another board's", async ({ page }) => {
  const options = await openAgentPicker(page);
  const names = (await options.allTextContents()).join("|");

  // The control: withholding everything would satisfy the second line just as well, and an
  // instance admin sees both agents in `/api/agents` — that is what makes this worth filtering.
  expect(names).toContain(OURS);
  expect(names).not.toContain(THEIRS);
});

test("a task already carrying another board's agent never reads \"No agent\"", async ({ page }) => {
  const handle = await db();
  await handle
    .collection("tasks")
    .updateOne(
      { project: PROJECT_ID, taskNumber: DECOY_TASK_NUMBER },
      { $set: { agent: new mongoose.Types.ObjectId(theirsId) } },
    );

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${DECOY_TASK_NUMBER}`);
  await expect(page.getByText(DECOY_TASK_TITLE).first()).toBeVisible();

  /**
   * Measured rather than assumed: `/api/agents` does not send this reader another board's agent
   * at all, so the row is the read-only name and not a picker. Which branch renders is a
   * visibility question; the claim that matters either way is that the row names what the task
   * is carrying. Rendering "No agent" over a task that has one is the lie to guard against, and
   * the offered branch is covered in `PropertyRail.test.tsx`, where all three scopes can be set up.
   */
  const readOnly = page.getByTestId("agent-not-offered");
  await expect(readOnly).toBeVisible();
  await expect(readOnly).not.toHaveText(/No agent/);
});
