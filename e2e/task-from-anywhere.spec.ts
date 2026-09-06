import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  HELD_TASK_NUMBER,
  HELD_TASK_TITLE,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  SIBLING_TASK_NUMBER,
  SIBLING_TASK_TITLE,
  seed,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-533. BP-521 fixed the two ways the detail view itself opens another task, by having the
 * route say which surface was drawing it. ⌘K and the PM widget are mounted in the shell, above
 * both task routes, so they could not be told — and the address cannot answer it either, since
 * with the modal open the URL is already the task's. The page now publishes the fact instead.
 *
 * The two tests that open from the task page leave it again afterwards: a soft navigation keeps
 * an unmatched slot's state, so a test that stops at "the destination is here" cannot see the
 * modal parked behind it, waiting to be drawn over the board (BP-521). Their controls open the
 * same task from the board, where the modal must still swap and leave the board underneath —
 * which is what a fix that reached too far would break.
 */

const taskDialog = (page: Page) =>
  page.getByRole("dialog").filter({ has: page.getByLabel("Task title") });

async function withDb<T>(fn: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  const dbName = new URL(E2E_MONGODB_URI.replace(/^mongodb/, "http")).pathname.slice(1);
  if (!dbName.endsWith("_e2e")) {
    throw new Error(`Refusing to touch database "${dbName}": this fixture only runs against *_e2e`);
  }
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    const handle = mongoose.connection.db;
    if (!handle) throw new Error("no database handle");
    return await fn(handle);
  } finally {
    await mongoose.disconnect();
  }
}

/** A PM turn that already happened, with a chip pointing at a task. */
async function pmAnswerLinking(taskKey: string) {
  await withDb(async (db) => {
    await db.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { "pm.enabled": true } });
    await db.collection("pmmessages").insertOne({
      project: PROJECT_ID,
      role: "assistant",
      content: "Moved it along.",
      // The thread is private, so without this the reader is shown nothing (src/lib/pm/thread.ts)
      triggeredBy: ADMIN_ID,
      trigger: { type: "chat", taskKey: "" },
      actions: [{ tool: "update_task", taskKey, summary: `Updated ${taskKey}`, at: new Date() }],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 1 },
      attachments: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });
}

async function openTaskPage(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
  await expect(page.getByLabel("Task title")).toHaveValue(SIBLING_TASK_TITLE);
}

async function pickFromSearch(page: Page, title: string) {
  await page.keyboard.press("ControlOrMeta+k");
  const layer = page.getByRole("dialog", { name: "Search" });
  await layer.getByLabel("Search tasks and projects").fill(title);
  await layer.getByText(title).first().click();
}

async function openAPmChip(page: Page, taskKey: string) {
  await page.getByRole("button", { name: "Open PM chat" }).click();
  const chip = page.getByRole("link", { name: `Updated ${taskKey}` });
  await expect(chip).toBeVisible();
  await chip.click();
}

test.beforeEach(async ({ page }) => {
  await seed();
  await signIn(page);
});

test.describe("⌘K", () => {
  test("from the task page opens the task as a page, and leaves nothing behind", async ({
    page,
  }) => {
    await openTaskPage(page);

    await pickFromSearch(page, HELD_TASK_TITLE);

    await expect(page).toHaveURL(new RegExp(`/tasks/${HELD_TASK_NUMBER}$`));
    await expect(page.getByLabel("Task title")).toHaveValue(HELD_TASK_TITLE);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: "Close task" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("a PM chip", () => {
  test("from the task page opens the task as a page, and leaves nothing behind", async ({
    page,
  }) => {
    await pmAnswerLinking(`${PROJECT_KEY}-${HELD_TASK_NUMBER}`);
    await openTaskPage(page);

    await openAPmChip(page, `${PROJECT_KEY}-${HELD_TASK_NUMBER}`);

    // A chip links by key, not by number — the same task, spelled the way the PM wrote it
    await expect(page).toHaveURL(new RegExp(`/tasks/${PROJECT_KEY}-${HELD_TASK_NUMBER}$`));
    await expect(page.getByLabel("Task title")).toHaveValue(HELD_TASK_TITLE);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: "Close task" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("from the board opens the modal, as it always did", async ({ page }) => {
    await pmAnswerLinking(`${PROJECT_KEY}-${HELD_TASK_NUMBER}`);
    await page.goto(`/projects/${PROJECT_KEY}`);
    await expect(page.getByText(SIBLING_TASK_TITLE).first()).toBeVisible();

    await openAPmChip(page, `${PROJECT_KEY}-${HELD_TASK_NUMBER}`);

    // A chip links by key, not by number — the same task, spelled the way the PM wrote it
    await expect(page).toHaveURL(new RegExp(`/tasks/${PROJECT_KEY}-${HELD_TASK_NUMBER}$`));
    await expect(taskDialog(page).getByLabel("Task title")).toHaveValue(HELD_TASK_TITLE);
    await expect(taskDialog(page)).toHaveCount(1);
    await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
  });
});
