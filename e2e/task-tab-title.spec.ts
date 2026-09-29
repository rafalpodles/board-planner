import { test, expect } from "@playwright/test";
import {
  PROJECT_KEY,
  PROJECT_NAME,
  SIBLING_TASK_KEY,
  SIBLING_TASK_NUMBER,
  SIBLING_TASK_TITLE,
  seed,
} from "./seed";
import { signIn } from "./session";
import { APP_NAME } from "../src/lib/brand";

/**
 * BP-746. The board names its tab; a task did not, so a task opened directly read only the app's
 * name, and a task opened over the board left the board's name on a tab showing a task.
 */

test.beforeEach(seed);

const BOARD = `/projects/${PROJECT_KEY}`;
const TASK_TAB = `${SIBLING_TASK_KEY} ${SIBLING_TASK_TITLE} — ${APP_NAME}`;
const BOARD_TAB = new RegExp(`^${PROJECT_NAME}( \\(.+\\))? — ${APP_NAME}$`);

test("a task opened directly names its tab after the task", async ({ page }) => {
  await signIn(page);
  await page.goto(`${BOARD}/tasks/${SIBLING_TASK_NUMBER}`);
  await expect(page.getByLabel("Task title")).toHaveValue(SIBLING_TASK_TITLE);

  await expect(page).toHaveTitle(TASK_TAB);

  const title = page.getByLabel("Task title");
  await title.fill("Renamed in place");
  await expect(page).toHaveTitle(`${SIBLING_TASK_KEY} Renamed in place — ${APP_NAME}`);
});

test("leaving the task page for the board gives the tab to the board", async ({ page }) => {
  await signIn(page);
  await page.goto(`${BOARD}/tasks/${SIBLING_TASK_NUMBER}`);
  await expect(page).toHaveTitle(TASK_TAB);

  await page.getByRole("button", { name: "Close task" }).click();
  await expect(page).toHaveURL(new RegExp(`${BOARD}$`));
  await expect(page).toHaveTitle(BOARD_TAB);
});

test("a task opened over the board takes the tab, and closing it hands the tab back", async ({ page }) => {
  await signIn(page);
  await page.goto(BOARD);
  // The control: the board names the tab before anything is opened over it
  await expect(page).toHaveTitle(BOARD_TAB);

  await page.getByRole("link", { name: new RegExp(SIBLING_TASK_TITLE) }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Task title")).toHaveValue(SIBLING_TASK_TITLE);
  await expect(page).toHaveTitle(TASK_TAB);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveTitle(BOARD_TAB);
});
