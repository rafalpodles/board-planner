import { test, expect, type Page } from "@playwright/test";
import { BASE_URL } from "../playwright.config";
import {
  PROJECT_KEY,
  SIBLING_TASK_KEY,
  SIBLING_TASK_NUMBER,
  SIBLING_TASK_TITLE,
  seed,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-300. The copy control is the one part of this feature no unit test can settle: what ends up
 * on the system clipboard, and whether the click reaches the card and row underneath it, are
 * both browser behaviour.
 */

const TASK_URL = `${BASE_URL}/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;
const COPY_BUTTON = `Copy link to ${SIBLING_TASK_KEY}`;

function clipboard(page: Page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

test.beforeEach(async ({ context }) => {
  await seed();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

test("a board card copies the task's own URL without opening the task", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByText(SIBLING_TASK_TITLE)).toBeVisible();

  await page.getByRole("button", { name: COPY_BUTTON }).first().click();

  expect(await clipboard(page)).toBe(TASK_URL);
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
});

test("the card confirms the copy and goes quiet again", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  const button = page.getByRole("button", { name: COPY_BUTTON }).first();

  await button.click();
  await expect(button).toHaveAttribute("title", "Copied!");
  await expect(button).toHaveAttribute("title", `Copy link to ${SIBLING_TASK_KEY}`, {
    timeout: 5_000,
  });
});

test("a list row copies the same URL without opening the task", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByRole("button", { name: "List", exact: true }).click();
  const row = page.getByRole("row", { name: new RegExp(SIBLING_TASK_TITLE) });

  await row.getByRole("button", { name: COPY_BUTTON }).click();

  expect(await clipboard(page)).toBe(TASK_URL);
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
});

// Enter on a focused button is the browser's own activation; a unit test can only show the
// handler does not swallow it
test("the task page copies on Enter from the keyboard", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
  const button = page.getByRole("button", { name: COPY_BUTTON });

  await button.focus();
  await page.keyboard.press("Enter");

  expect(await clipboard(page)).toBe(TASK_URL);
});
