import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  E2E_MONGODB_URI,
  PROJECT_ID,
  HELD_TASK_ID,
  HELD_TASK_NUMBER,
  HELD_TASK_TITLE,
  PROJECT_KEY,
  SIBLING_TASK_ID,
  SIBLING_TASK_TITLE,
  SIBLING_TASK_NUMBER,
  seed,
} from "./seed";
import { ADMIN_AUTH } from "./api";
import { signIn } from "./session";

const COPY_TITLE = `Copy of ${SIBLING_TASK_TITLE}`;
const EDITED_TITLE = "Edited a moment before leaving";

async function storedTitle(taskNumber: number): Promise<string | undefined> {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const row = await mongoose.connection.db
    ?.collection("tasks")
    .findOne({ project: PROJECT_ID, taskNumber });
  return row?.title as string | undefined;
}

async function duplicate(page: Page) {
  const created = page.waitForResponse(
    (res) => res.request().method() === "POST" && /\/api\/projects\/[^/]+\/tasks$/.test(res.url())
  );
  await page.getByRole("button", { name: /^Duplicate$/ }).click();
  await created;
}

async function openTaskPage(page: Page, taskNumber: number, title: string) {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${taskNumber}`);
  await expect(page.getByLabel("Task title").first()).toHaveValue(title);
}

test.beforeEach(async ({ page }) => {
  await seed();
  await signIn(page);
});

test("duplicating from the task page leaves one editor, not a page and a dialog over it", async ({
  page,
}) => {
  await openTaskPage(page, SIBLING_TASK_NUMBER, SIBLING_TASK_TITLE);

  await duplicate(page);

  await expect(page.getByLabel("Task title")).toHaveValue(COPY_TITLE);
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/tasks/\\d+$`));
  await expect(page).not.toHaveURL(new RegExp(`/tasks/${SIBLING_TASK_NUMBER}$`));
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: "Close task" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a linked task opened from the task page is the page too, and leaves nothing behind", async ({
  page,
  request,
}) => {
  const linked = await request.post(
    `/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}/links`,
    { headers: ADMIN_AUTH, data: { taskId: HELD_TASK_ID, type: "relates" } }
  );
  expect(linked.status(), await linked.text()).toBeLessThan(300);

  await openTaskPage(page, SIBLING_TASK_NUMBER, SIBLING_TASK_TITLE);
  await page.getByRole("button", { name: `${PROJECT_KEY}-${HELD_TASK_NUMBER}`, exact: true }).first().click();

  await expect(page).toHaveURL(new RegExp(`/tasks/${HELD_TASK_NUMBER}$`));
  await expect(page.getByLabel("Task title")).toHaveValue(HELD_TASK_TITLE);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: "Close task" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("duplicating from the board's modal leaves one editor, still in the modal", async ({
  page,
}) => {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByRole("link", { name: new RegExp(SIBLING_TASK_TITLE) }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Task title")).toHaveValue(SIBLING_TASK_TITLE);

  await duplicate(page);

  await expect(dialog.getByLabel("Task title")).toHaveValue(COPY_TITLE);
  await expect(page.getByLabel("Task title")).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(1);

  await page.getByRole("button", { name: "Close task" }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${SIBLING_TASK_NUMBER}$`));
  await expect(dialog.getByLabel("Task title")).toHaveValue(SIBLING_TASK_TITLE);
  await expect(page.getByRole("dialog")).toHaveCount(1);

  await page.getByRole("button", { name: "Close task" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test.describe("an edit still in the debounce window", () => {
  test("survives leaving the page for the copy", async ({ page }) => {
    await page.clock.install();
    await page.clock.pauseAt(Date.now());
    await openTaskPage(page, SIBLING_TASK_NUMBER, SIBLING_TASK_TITLE);

    await page.getByLabel("Task title").fill(EDITED_TITLE);
    await page.getByRole("button", { name: /^Duplicate$/ }).click();

    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/tasks/\\d+$`));
    await expect
      .poll(() => storedTitle(SIBLING_TASK_NUMBER), { timeout: 10_000 })
      .toBe(EDITED_TITLE);
  });

  test("survives it from the modal too", async ({ page }) => {
    await page.clock.install();
    await page.clock.pauseAt(Date.now());
    await page.goto(`/projects/${PROJECT_KEY}`);
    await page.getByRole("link", { name: new RegExp(SIBLING_TASK_TITLE) }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Task title")).toHaveValue(SIBLING_TASK_TITLE);

    await dialog.getByLabel("Task title").fill(EDITED_TITLE);
    await page.getByRole("button", { name: /^Duplicate$/ }).click();

    await expect
      .poll(() => storedTitle(SIBLING_TASK_NUMBER), { timeout: 10_000 })
      .toBe(EDITED_TITLE);
  });
});
