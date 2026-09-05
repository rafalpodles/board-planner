import { test, expect, type Page } from "@playwright/test";
import { PROJECT_KEY, SIBLING_TASK_NUMBER, SIBLING_TASK_TITLE, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-521. Duplicating from the full task page used to leave the copy on the screen twice — once
 * as the page, once in the intercepting modal over it — because `router.push` to another task is
 * a soft navigation, so the `@modal` slot intercepts while the `children` slot re-renders for the
 * new param. Two editable titles, two comment composers, and a close button that lands on the
 * original task.
 *
 * Both tests here assert the same thing, one editor for the copy, from the two surfaces that
 * reach it. The board→modal one is the control: it was always correct, and it is what a fix that
 * suppressed the modal too eagerly would break.
 */

const COPY_TITLE = `Copy of ${SIBLING_TASK_TITLE}`;

async function duplicate(page: Page) {
  const created = page.waitForResponse(
    (res) => res.request().method() === "POST" && /\/api\/projects\/[^/]+\/tasks$/.test(res.url())
  );
  await page.getByRole("button", { name: /^Duplicate$/ }).click();
  await created;
}

test.beforeEach(async () => {
  await seed();
});

test("duplicating from the task page leaves one editor, not a page and a dialog over it", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
  await expect(page.getByLabel("Task title")).toHaveValue(SIBLING_TASK_TITLE);

  await duplicate(page);

  await expect(page.getByLabel("Task title").first()).toHaveValue(COPY_TITLE);
  await expect(page).not.toHaveURL(new RegExp(`/tasks/${SIBLING_TASK_NUMBER}$`));
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/tasks/\\d+$`));

  await expect(page.getByLabel("Task title")).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("duplicating from the board's modal leaves one editor, still in the modal", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByRole("link", { name: new RegExp(SIBLING_TASK_TITLE) }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Task title")).toHaveValue(SIBLING_TASK_TITLE);

  await duplicate(page);

  await expect(dialog.getByLabel("Task title")).toHaveValue(COPY_TITLE);
  await expect(page.getByLabel("Task title")).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(1);
});
