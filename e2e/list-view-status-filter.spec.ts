import { test, expect, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import {
  DECOY_TASK_TITLE,
  FINISHED_TASK_TITLE,
  HELD_TASK_TITLE,
  PROJECT_KEY,
  RENAMED_COLUMN_ID,
  SIBLING_TASK_ID,
  SIBLING_TASK_TITLE,
  seed,
  seedRenamedColumn,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-566. The list view had no way to narrow by status, and the filter it now has keys on the
 * column's ROLE rather than its id — column ids are the project's own (BP-128), so a board whose
 * columns were renamed has ids nothing outside it can name.
 *
 * Driven through the browser because the filter is client-side: the API returns the whole board
 * and the narrowing happens in BoardFilters, so a request-level test would assert nothing.
 */

test.beforeEach(seed);

const rows = (page: Page) => page.locator("table tbody tr");
const row = (page: Page, title: string) => rows(page).filter({ hasText: title });

async function openList(page: Page) {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator("table")).toBeVisible();
}

async function openPanel(page: Page) {
  const panel = page.getByRole("dialog", { name: "Filters" });
  // The panel is a toggle and BoardFilters remembers it was open, so clicking blind closes it
  if (!(await panel.isVisible())) {
    await page.getByRole("button", { name: /^Filters/ }).click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

async function chooseStatus(page: Page, label: string) {
  const panel = await openPanel(page);
  await panel.getByLabel("Status").selectOption({ label });
  // Left open it covers the list, and every click on what the filter produced times out
  await page.getByRole("button", { name: /^Filters/ }).click();
  await expect(panel).toBeHidden();
}

test("the list narrows to a status role and says so when nothing matches", async ({ page }) => {
  await openList(page);

  await test.step("the premise: the board holds more than any one role does", async () => {
    await expect(rows(page)).toHaveCount(4);
  });

  await test.step("in progress leaves only the two tasks in that column", async () => {
    await chooseStatus(page, "In progress");

    await expect(row(page, HELD_TASK_TITLE)).toBeVisible();
    await expect(row(page, SIBLING_TASK_TITLE)).toBeVisible();
    await expect(row(page, DECOY_TASK_TITLE)).toHaveCount(0);
    await expect(row(page, FINISHED_TASK_TITLE)).toHaveCount(0);
    await expect(rows(page)).toHaveCount(2);
  });

  await test.step("a role no task on this board carries empties the list explicitly", async () => {
    // The seed leaves nothing finished, so this is a role the board offers and no task holds
    await chooseStatus(page, "Done");

    // The list renders nothing at all when it has no rows, which is what this replaces
    await expect(page.getByText("No tasks match the filters")).toBeVisible();
    await expect(page.locator("table")).toHaveCount(0);
  });

  await test.step("and the way back brings every task with it", async () => {
    await page.getByRole("button", { name: "Clear filters" }).click();

    await expect(rows(page)).toHaveCount(4);
    await expect(page.getByText("No tasks match the filters")).toHaveCount(0);
  });
});

test("it still filters on a board that renamed the column", async ({ page, request }) => {
  // `planned` becomes `parked`, keeping its backlog role. Nothing may reach for the id.
  await seedRenamedColumn();

  await test.step("park a task in the renamed column", async () => {
    const moved = await request.put(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}`, {
      headers: ADMIN_AUTH,
      data: { status: RENAMED_COLUMN_ID },
    });
    expect(moved.status(), await moved.text()).toBe(200);
  });

  await openList(page);

  await test.step("the picker names the role, never the column", async () => {
    const options = (await openPanel(page)).getByLabel("Status");
    await expect(options).toContainText("Ideas & backlog");
    await expect(options).not.toContainText("Parked");
  });

  await test.step("and it finds the task sitting in the renamed column", async () => {
    await chooseStatus(page, "Ideas & backlog");

    await expect(row(page, SIBLING_TASK_TITLE)).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
  });
});
