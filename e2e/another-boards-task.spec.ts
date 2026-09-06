import { test, expect, type Page } from "@playwright/test";
import {
  HELD_TASK_TITLE,
  OTHER_HIT_KEY,
  OTHER_HIT_NUMBER,
  OTHER_HIT_TITLE,
  OTHER_PROJECT_KEY,
  PROJECT_KEY,
  SIBLING_TASK_TITLE,
  seed,
  seedSearchCorpus,
} from "./seed";
import { signIn } from "./session";

const taskDialog = (page: Page) =>
  page.getByRole("dialog").filter({ has: page.getByLabel("Task title") });

async function pickFromSearch(page: Page, title: string) {
  await page.keyboard.press("ControlOrMeta+k");
  const layer = page.getByRole("dialog", { name: "Search" });
  await layer.getByLabel("Search tasks and projects").fill(title);
  await layer.getByText(title).first().click();
}

test.beforeEach(async ({ page }) => {
  await seed();
  await seedSearchCorpus();
  await signIn(page);
});

test("a hit on another board opens that board's task, not this board's", async ({ page }) => {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByText(SIBLING_TASK_TITLE).first()).toBeVisible();

  await pickFromSearch(page, OTHER_HIT_TITLE);

  await expect(page).toHaveURL(
    new RegExp(`/projects/${OTHER_PROJECT_KEY}/tasks/${OTHER_HIT_NUMBER}$`)
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Task title")).toHaveValue(OTHER_HIT_TITLE);
  await expect(page.getByText(HELD_TASK_TITLE)).toHaveCount(0);
  await expect(page.getByText(OTHER_HIT_KEY).first()).toBeVisible();
});

test("a hit on this board still opens as the modal it always did", async ({ page }) => {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByText(SIBLING_TASK_TITLE).first()).toBeVisible();

  await pickFromSearch(page, HELD_TASK_TITLE);

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/tasks/1$`));
  await expect(taskDialog(page).getByLabel("Task title")).toHaveValue(HELD_TASK_TITLE);
  await expect(taskDialog(page)).toHaveCount(1);
});
