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

/**
 * BP-540. The intercepting modal lives under `projects/[projectId]`, and takes its project from
 * `useParams()` — which resolves against the layout still mounted for the project the reader came
 * from, while the task id follows the new URL. Pick another board's task out of ⌘K and the two
 * halves of the identity disagree: the address says one task, the screen draws another.
 *
 * The control is a hit on *this* board, which must still open as the modal it always did.
 */

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
  await expect(page.getByLabel("Task title")).toHaveValue(OTHER_HIT_TITLE);
  await expect(page.getByText(HELD_TASK_TITLE)).toHaveCount(0);
  await expect(page.getByText(OTHER_HIT_KEY).first()).toBeVisible();
  // As its own page, not an overlay on the board being left: the intercepting route belongs to
  // that board, and this task does not. This is the assertion the navigation itself has to earn —
  // the modal's own guard would satisfy every line above it.
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a hit on this board still opens as the modal it always did", async ({ page }) => {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByText(SIBLING_TASK_TITLE).first()).toBeVisible();

  await pickFromSearch(page, HELD_TASK_TITLE);

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/tasks/1$`));
  await expect(taskDialog(page).getByLabel("Task title")).toHaveValue(HELD_TASK_TITLE);
  await expect(taskDialog(page)).toHaveCount(1);
});
