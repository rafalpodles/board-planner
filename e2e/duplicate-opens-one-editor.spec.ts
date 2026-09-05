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

/**
 * BP-521. Opening a task from a page that is already a task used to draw it twice — once as the
 * page, once in the intercepting modal over it — because `router.push` is a soft navigation, so
 * `@modal` intercepts while the `children` slot re-renders for the new param.
 *
 * The second assertion in each test is the one that costs something to get right. A soft
 * navigation keeps an unmatched slot's state (Next's parallel-routes docs say so outright), so
 * merely hiding that modal leaves the task parked in the slot, to reappear over the board the
 * moment the reader closes the one they are on. Every test here therefore leaves the task after
 * arriving at it, and looks at what is on the screen then.
 *
 * The board→modal test is the control: that surface was always correct, and it is what a fix
 * that suppressed the modal too eagerly would break.
 */

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

  // Closing a modal is a step back through history, so it lands on the task this copy was made
  // from — still a modal, still one of them, with the board underneath it and no ghost.
  await page.getByRole("button", { name: "Close task" }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${SIBLING_TASK_NUMBER}$`));
  await expect(dialog.getByLabel("Task title")).toHaveValue(SIBLING_TASK_TITLE);
  await expect(page.getByRole("dialog")).toHaveCount(1);

  await page.getByRole("button", { name: "Close task" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

/**
 * The autosave flushes a pending edit from React's unmount cleanup, which a document load does
 * not run — so leaving the page for the copy would drop whatever was typed in the 700ms before
 * the click, silently, under a status line still reading "All changes saved". The modal is the
 * control: it unmounts, so it was always safe.
 */
test.describe("an edit still in the debounce window", () => {
  test("survives leaving the page for the copy", async ({ page }) => {
    // The debounce is the other way this edit could reach the server, and whether it wins is a
    // race against how long the dev server takes to answer the new document. Frozen, it cannot
    // fire at all, so a green here is the flush and nothing else.
    await page.clock.install();
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
