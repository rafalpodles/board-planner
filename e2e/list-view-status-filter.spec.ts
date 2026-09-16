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
  if (!(await panel.isVisible())) {
    await page.getByRole("button", { name: /^Filters/ }).click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

async function chooseStatus(page: Page, label: string) {
  const panel = await openPanel(page);
  await panel.getByLabel("Status").selectOption({ label });
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
    await chooseStatus(page, "Done");

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
  await seedRenamedColumn();

  await test.step("park a task in the renamed column", async () => {
    const moved = await request.put(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}`, {
      headers: ADMIN_AUTH,
      data: { status: RENAMED_COLUMN_ID },
    });
    expect(moved.status(), await moved.text()).toBe(200);
  });

  await openList(page);
  await expect(rows(page)).toHaveCount(4);

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
