import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import {
  FINISHED_TASK_ID,
  FINISHED_TASK_TITLE,
  HELD_TASK_ID,
  LIST_DROPDOWN_FIELD_ID,
  LIST_DROPDOWN_FIELD_NAME,
  MEMBER_USERNAME,
  PROJECT_KEY,
  SIBLING_TASK_ID,
  parkTaskOnMissingColumn,
  seed,
  seedListVisibleDropdownField,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-884. The list can be grouped by assignee, priority, category, status or a dropdown field.
 * Setup goes through the API; every assertion is on the rendered list.
 */
test.beforeEach(seed);

const headers = (page: Page) => page.getByTestId("list-group-header");
const header = (page: Page, label: string) => headers(page).filter({ hasText: label });
const taskRows = (page: Page) => page.locator("table tbody tr:not([data-testid='list-group-header'])");
const groupSelect = (page: Page) => page.getByLabel("Group tasks by");

async function put(request: APIRequestContext, taskId: unknown, data: Record<string, unknown>) {
  const response = await request.put(`/api/projects/${PROJECT_KEY}/tasks/${taskId}`, {
    headers: ADMIN_AUTH,
    data,
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** Two urgent tasks (one assigned), the rest medium: three tasks in two groups. */
async function sortOutPriorities(request: APIRequestContext) {
  await put(request, HELD_TASK_ID, { priority: "urgent" });
  await put(request, SIBLING_TASK_ID, { priority: "urgent", assignee: MEMBER_USERNAME });
}

async function openList(page: Page) {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator("table")).toBeVisible();
}

async function groupBy(page: Page, label: string) {
  await groupSelect(page).selectOption({ label });
}

/** The keys of the rows, in the order they are drawn. */
async function drawn(page: Page): Promise<string[]> {
  return taskRows(page).evaluateAll((els) =>
    els.map((el) => el.textContent?.match(/TP-\d+/)?.[0] ?? "")
  );
}

async function focusedKey(page: Page): Promise<string | null> {
  const focused = page.locator("table tbody tr.ring-primary");
  return (await focused.count()) === 1
    ? ((await focused.textContent())?.match(/TP-\d+/)?.[0] ?? null)
    : null;
}

test("priority groups carry their headers and counts, in a stable order", async ({ page, request }) => {
  await sortOutPriorities(request);
  await openList(page);

  await test.step("the premise: ungrouped, no headers", async () => {
    await expect(taskRows(page)).toHaveCount(4);
    await expect(headers(page)).toHaveCount(0);
  });

  await test.step("grouping by priority draws urgent first, then medium", async () => {
    await groupBy(page, "Group: Priority");

    await expect(headers(page)).toHaveCount(2);
    await expect(headers(page).nth(0)).toContainText("Urgent");
    await expect(headers(page).nth(0).getByTestId("list-group-count")).toHaveText("2");
    await expect(headers(page).nth(1)).toContainText("Medium");
    await expect(headers(page).nth(1).getByTestId("list-group-count")).toHaveText("2");
    expect((await drawn(page)).slice(0, 2).sort()).toEqual(["TP-1", "TP-3"]);
  });

  await test.step("the unassigned tasks form a none group after the people", async () => {
    await groupBy(page, "Group: Assignee");

    await expect(headers(page)).toHaveCount(2);
    await expect(headers(page).nth(1)).toContainText("Unassigned");
    await expect(headers(page).nth(1).getByTestId("list-group-count")).toHaveText("3");
    await expect(taskRows(page)).toHaveCount(4);
  });

  await test.step("grouping by status follows the columns, one group per column in use", async () => {
    await groupBy(page, "Group: Status");

    await expect(headers(page).nth(0)).toContainText("To Do");
    await expect(headers(page).nth(1)).toContainText("In Progress");
    await expect(headers(page).nth(2)).toContainText("In Review");
    await expect(header(page, "Done")).toHaveCount(0);
  });

  await test.step("grouping by category", async () => {
    await groupBy(page, "Group: Category");

    await expect(headers(page)).toHaveCount(1);
    await expect(headers(page).first()).toContainText("user-story");
  });
});

test("a dropdown field groups in option order with a none group", async ({ page, request }) => {
  await seedListVisibleDropdownField();
  const field = String(LIST_DROPDOWN_FIELD_ID);
  await put(request, HELD_TASK_ID, { customFieldValues: { [field]: "aa-ui" } });
  await put(request, SIBLING_TASK_ID, { customFieldValues: { [field]: "zz-api" } });
  await openList(page);

  await groupBy(page, `Group: ${LIST_DROPDOWN_FIELD_NAME}`);

  await expect(headers(page)).toHaveCount(3);
  await expect(headers(page).nth(0)).toContainText("API");
  await expect(headers(page).nth(1)).toContainText("UI");
  await expect(headers(page).nth(2)).toContainText(`No ${LIST_DROPDOWN_FIELD_NAME}`);
  await expect(headers(page).nth(2).getByTestId("list-group-count")).toHaveText("2");
});

test("J and K walk the rows in the order they are drawn and skip a collapsed group", async ({ page, request }) => {
  await sortOutPriorities(request);
  await openList(page);
  await groupBy(page, "Group: Status");
  await expect(headers(page)).toHaveCount(3);
  const order = await drawn(page);

  await test.step("the drawn order is not the ungrouped one", async () => {
    await groupBy(page, "No grouping");
    await expect(headers(page)).toHaveCount(0);
    expect(await drawn(page)).not.toEqual(order);
    await groupBy(page, "Group: Status");
    await expect(headers(page)).toHaveCount(3);
  });

  await test.step("j visits each row top to bottom", async () => {
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    const visited: (string | null)[] = [];
    for (let i = 0; i < order.length; i++) {
      await page.keyboard.press("j");
      await expect.poll(() => focusedKey(page)).toBe(order[i]);
      visited.push(await focusedKey(page));
    }
    expect(visited).toEqual(order);
  });

  await test.step("a collapsed group hides its rows and j passes over them", async () => {
    await header(page, "In Progress").getByRole("button").click();
    await expect(header(page, "In Progress").getByRole("button")).toHaveAttribute("aria-expanded", "false");
    await expect(header(page, "In Progress").getByTestId("list-group-count")).toHaveText("2");
    await expect(taskRows(page)).toHaveCount(2);
    const remaining = await drawn(page);
    expect(remaining).not.toContain("TP-1");
    expect(remaining).not.toContain("TP-3");

    await page.keyboard.press("j");
    await expect.poll(() => focusedKey(page)).toBe(remaining[0]);
    await page.keyboard.press("j");
    await expect.poll(() => focusedKey(page)).toBe(remaining[1]);
    await page.keyboard.press("j");
    await expect.poll(() => focusedKey(page)).toBe(remaining[1]);
  });

  await test.step("expanding it brings the rows back", async () => {
    await header(page, "In Progress").getByRole("button").click();
    await expect(taskRows(page)).toHaveCount(4);
  });
});

test("every group collapsed still leaves the headers to open them again", async ({ page, request }) => {
  await sortOutPriorities(request);
  await openList(page);
  await groupBy(page, "Group: Priority");

  await header(page, "Urgent").getByRole("button").click();
  await header(page, "Medium").getByRole("button").click();

  await expect(headers(page)).toHaveCount(2);
  await expect(taskRows(page)).toHaveCount(0);

  await header(page, "Medium").getByRole("button").click();
  await expect(taskRows(page)).toHaveCount(2);
});

test("rows cannot be reordered while grouped, and the grips come back ungrouped", async ({ page, request }) => {
  await sortOutPriorities(request);
  await openList(page);
  const grips = page.getByRole("button", { name: /^Reorder / });

  await expect(grips).toHaveCount(4);

  await groupBy(page, "Group: Priority");
  await expect(headers(page)).toHaveCount(2);
  await expect(grips).toHaveCount(0);

  await groupBy(page, "No grouping");
  await expect(headers(page)).toHaveCount(0);
  await expect(grips).toHaveCount(4);
});

test("the choice survives a reload and is dropped when its field is archived", async ({ page, request }) => {
  await seedListVisibleDropdownField();
  await put(request, HELD_TASK_ID, { customFieldValues: { [String(LIST_DROPDOWN_FIELD_ID)]: "aa-ui" } });
  await openList(page);

  await test.step("a built-in choice comes back after a reload", async () => {
    await groupBy(page, "Group: Priority");
    await expect(headers(page)).toHaveCount(1);

    await page.reload();
    await expect(page.locator("table")).toBeVisible();
    await expect(groupSelect(page)).toHaveValue("priority");
    await expect(headers(page)).toHaveCount(1);
  });

  await test.step("a field choice comes back too", async () => {
    await groupBy(page, `Group: ${LIST_DROPDOWN_FIELD_NAME}`);
    await expect(headers(page)).toHaveCount(2);

    await page.reload();
    await expect(page.locator("table")).toBeVisible();
    await expect(groupSelect(page)).toHaveValue(`field:${LIST_DROPDOWN_FIELD_ID}`);
    await expect(headers(page)).toHaveCount(2);
  });

  await test.step("archiving the field leaves an ungrouped list and no dead choice", async () => {
    const archived = await request.patch(
      `/api/projects/${PROJECT_KEY}/custom-fields/${LIST_DROPDOWN_FIELD_ID}`,
      { headers: ADMIN_AUTH, data: { archived: true } }
    );
    expect(archived.status(), await archived.text()).toBe(200);

    await page.reload();
    await expect(page.locator("table")).toBeVisible();
    await expect(groupSelect(page)).toHaveValue("");
    await expect(headers(page)).toHaveCount(0);
    await expect(taskRows(page)).toHaveCount(4);
  });
});

test("a task on a deleted column lands in an unfiled group instead of vanishing", async ({ page }) => {
  await parkTaskOnMissingColumn(FINISHED_TASK_ID);
  await openList(page);
  await expect(taskRows(page)).toHaveCount(4);

  await groupBy(page, "Group: Status");

  await expect(taskRows(page)).toHaveCount(4);
  await expect(headers(page).last()).toContainText("No column");
  await expect(headers(page).last().getByTestId("list-group-count")).toHaveText("1");
  await expect(taskRows(page).last()).toContainText(FINISHED_TASK_TITLE);
});

test("the grouped list on a phone keeps its headers readable with no page scroll", async ({ page, request }) => {
  await sortOutPriorities(request);
  await page.setViewportSize({ width: 390, height: 800 });
  await openList(page);
  await groupBy(page, "Group: Priority");

  await expect(headers(page)).toHaveCount(2);
  await expect(headers(page).first().getByRole("button")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);

  const [row, rowHeader] = await Promise.all([
    taskRows(page).first().boundingBox(),
    headers(page).first().getByRole("button").boundingBox(),
  ]);
  expect(rowHeader!.height).toBeGreaterThanOrEqual(32);
  expect(row).not.toBeNull();
});
