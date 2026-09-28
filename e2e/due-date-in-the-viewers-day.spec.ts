import { test, expect, type Page } from "@playwright/test";
import { PROJECT_ID, PROJECT_KEY, SIBLING_TASK_ID, SIBLING_TASK_NUMBER, SIBLING_TASK_TITLE, seed } from "./seed";
import { ADMIN_AUTH } from "./api";
import { signIn } from "./session";

/**
 * BP-754. A picked day is stored as its UTC midnight. Read as an instant in the viewer's zone it
 * is the day before for anybody west of UTC, and an overdue check done on instants turns a day
 * late for anybody east of it.
 */

test.beforeEach(seed);

const BOARD = `/projects/${PROJECT_KEY}`;
const cardDue = (page: Page) =>
  page.getByRole("link", { name: new RegExp(SIBLING_TASK_TITLE) }).getByTestId("task-card-due");

async function openList(page: Page) {
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator("table")).toBeVisible();
  await page.getByRole("button", { name: "Choose columns" }).click();
  const due = page.getByRole("group", { name: "Columns" }).getByRole("checkbox", { name: "Due" });
  await due.check();
  await expect(due).toBeChecked();
  await page.keyboard.press("Escape");
  return page.getByRole("row", { name: new RegExp(SIBLING_TASK_TITLE) }).getByTestId("list-due");
}

test.describe("west of UTC", () => {
  test.use({ timezoneId: "America/Los_Angeles" });

  test("the day picked on the task is the day on the rail, the card and the list", async ({ page }) => {
    // 20:00 on the 15th in Los Angeles, when UTC is already on the 16th
    await page.clock.setFixedTime(new Date("2026-10-16T03:00:00Z"));
    await signIn(page);
    await page.goto(`${BOARD}/tasks/${SIBLING_TASK_NUMBER}`);
    await expect(page.getByLabel("Task title")).toHaveValue(SIBLING_TASK_TITLE);
    expect(await page.evaluate(() => new Date().getDate()), "the page's clock is not pinned").toBe(15);

    const dueRow = page.getByRole("button", { name: /^Due date/ });
    await dueRow.click();
    const saved = page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().endsWith(`/tasks/${SIBLING_TASK_ID}`)
    );
    await page.locator('input[type="date"]').fill("2026-10-15");
    expect((await saved).ok()).toBe(true);
    await page.keyboard.press("Escape");

    await expect(dueRow).toContainText("Oct 15, 2026");
    await expect(dueRow).not.toContainText("Oct 14");

    await page.goto(BOARD);
    await expect(cardDue(page)).toHaveText("Oct 15");
    // Its own day, not over yet
    await expect(cardDue(page)).toHaveClass(/text-warning/);
    await expect(cardDue(page)).not.toHaveClass(/text-danger/);

    const listDue = await openList(page);
    await expect(listDue).toHaveText("Oct 15");
    await expect(listDue).toHaveClass(/text-warning/);
  });

  // The control: the colour does turn, once the viewer's next day has begun
  test("the card turns overdue on the day after", async ({ page, request }) => {
    const set = await request.put(`/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}`, {
      headers: ADMIN_AUTH,
      data: { dueDate: "2026-10-15" },
    });
    expect(set.status(), await set.text()).toBe(200);

    // 00:30 on the 16th in Los Angeles
    await page.clock.setFixedTime(new Date("2026-10-16T07:30:00Z"));
    await signIn(page);
    await page.goto(BOARD);

    await expect(cardDue(page)).toHaveText("Oct 15");
    await expect(cardDue(page)).toHaveClass(/text-danger/);
  });
});

test.describe("east of UTC", () => {
  test.use({ timezoneId: "Asia/Tokyo" });

  test("a task due yesterday is overdue from the first minute of today", async ({ page, request }) => {
    const set = await request.put(`/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}`, {
      headers: ADMIN_AUTH,
      data: { dueDate: "2026-10-15" },
    });
    expect(set.status(), await set.text()).toBe(200);

    // 00:30 on the 16th in Tokyo, when UTC is still on the 15th
    await page.clock.setFixedTime(new Date("2026-10-15T15:30:00Z"));
    await signIn(page);
    await page.goto(BOARD);

    await expect(cardDue(page)).toHaveText("Oct 15");
    await expect(cardDue(page)).toHaveClass(/text-danger/);

    const listDue = await openList(page);
    await expect(listDue).toHaveText("Oct 15");
    await expect(listDue).toHaveClass(/text-danger/);
  });
});
