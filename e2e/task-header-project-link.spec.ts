import { test, expect, type Page } from "@playwright/test";
import { BASE_URL } from "../playwright.config";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  PROJECT_KEY,
  PROJECT_NAME,
  SIBLING_TASK_NUMBER,
  seed,
} from "./seed";
import { signIn as arriveSignedIn } from "./session";

const TASK_URL = `${BASE_URL}/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;
const BOARD_URL = `${BASE_URL}/projects/${PROJECT_KEY}`;
const TASK_KEY = `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`;

const signIn = arriveSignedIn;

const bar = (page: Page) => page.getByTestId("task-top-bar");
const projectLink = (page: Page) => bar(page).getByRole("link", { name: PROJECT_NAME });

test.beforeEach(async () => {
  await seed();
});

test("the project name is a real link to the board; the task key beside it is not", async ({ page }) => {
  await signIn(page);
  await page.goto(TASK_URL);
  await expect(bar(page)).toBeVisible();

  await expect(projectLink(page)).toHaveAttribute("href", `/projects/${PROJECT_KEY}`);

  await expect(bar(page).getByRole("link", { name: TASK_KEY, exact: true })).toHaveCount(0);
});

test("clicking the project name opens that project's board", async ({ page }) => {
  await signIn(page);
  await page.goto(TASK_URL);

  await projectLink(page).click();

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
});

test("the project name is keyboard reachable and Enter activates it", async ({ page }) => {
  await signIn(page);
  await page.goto(TASK_URL);

  await projectLink(page).focus();
  await expect(projectLink(page)).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
});

test("the project name shows a pointer cursor, unlike the plain task key beside it", async ({ page }) => {
  await signIn(page);
  await page.goto(TASK_URL);

  await expect(projectLink(page)).toHaveCSS("cursor", "pointer");
  await expect(bar(page).getByText(TASK_KEY, { exact: true })).not.toHaveCSS("cursor", "pointer");
});

test("clicking the project name from the board's task modal returns to the board itself", async ({ page }) => {
  await signIn(page);
  await page.goto(BOARD_URL);
  await page.locator(`a[href$="/tasks/${SIBLING_TASK_NUMBER}"]`).first().click();

  const taskDialog = page.locator("div[role=dialog]").filter({ has: bar(page) });
  await expect(taskDialog).toBeVisible();

  await projectLink(page).click();

  await expect(taskDialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
});
