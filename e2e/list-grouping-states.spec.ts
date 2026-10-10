import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { AA_TEXT, DARK_SURFACE_MAX_LUMINANCE, surfaceLuminance, textContrast } from "./colour";
import {
  DECOY_TASK_NUMBER,
  DECOY_TASK_TITLE,
  HELD_TASK_ID,
  MEMBER_USERNAME,
  PROJECT_KEY,
  SIBLING_TASK_ID,
  seed,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-884 follow-up: what the grouped list does around the grouping itself. An inline edit that
 * changes the value a list is grouped by, a filter that empties a group, and the header rows in
 * the dark theme. Setup goes through the API; every assertion is on the rendered list.
 */
test.use({ colorScheme: "light" });
test.beforeEach(seed);

const headers = (page: Page) => page.getByTestId("list-group-header");
const header = (page: Page, label: string) => headers(page).filter({ hasText: label });
const count = (page: Page, label: string) => header(page, label).getByTestId("list-group-count");
const taskRows = (page: Page) => page.locator("table tbody tr:not([data-testid='list-group-header'])");

async function put(request: APIRequestContext, taskId: unknown, data: Record<string, unknown>) {
  const response = await request.put(`/api/projects/${PROJECT_KEY}/tasks/${taskId}`, { headers: ADMIN_AUTH, data });
  expect(response.status(), await response.text()).toBe(200);
}

/** Urgent: TP-1 and TP-3. Medium: TP-2 and TP-4. */
async function openGroupedByPriority(page: Page, request: APIRequestContext) {
  await put(request, HELD_TASK_ID, { priority: "urgent" });
  await put(request, SIBLING_TASK_ID, { priority: "urgent", assignee: MEMBER_USERNAME });
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator("table")).toBeVisible();
  await page.getByLabel("Group tasks by").selectOption({ label: "Group: Priority" });
  await expect(headers(page)).toHaveCount(2);
}

test("an inline edit that changes the grouped value moves the row to its new group and moves the counts", async ({ page, request }) => {
  await openGroupedByPriority(page, request);
  await expect(count(page, "Urgent")).toHaveText("2");
  await expect(count(page, "Medium")).toHaveText("2");

  const written = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/tasks/") && r.ok());
  await page.getByRole("combobox", { name: `Priority for ${PROJECT_KEY}-${DECOY_TASK_NUMBER}: ${DECOY_TASK_TITLE}` }).click();
  await page.getByRole("option", { name: "Urgent", exact: true }).click();
  await written;

  await expect(count(page, "Urgent")).toHaveText("3");
  await expect(count(page, "Medium")).toHaveText("1");
  const urgentRows = await page.locator("table tbody tr").evaluateAll((els) => {
    const seen: string[] = [];
    let inUrgent = false;
    for (const el of els) {
      if (el.getAttribute("data-testid") === "list-group-header") inUrgent = el.getAttribute("data-group-key") === "v:urgent";
      else if (inUrgent) seen.push(el.textContent?.match(/TP-\d+/)?.[0] ?? "");
    }
    return seen.sort();
  });
  expect(urgentRows).toEqual(["TP-1", "TP-2", "TP-3"]);
  await expect(taskRows(page)).toHaveCount(4);
});

test("a group the last task leaves is gone, not drawn empty", async ({ page, request }) => {
  await openGroupedByPriority(page, request);
  await put(request, HELD_TASK_ID, { priority: "medium" });
  await put(request, SIBLING_TASK_ID, { priority: "medium" });
  await page.reload();
  await expect(page.locator("table")).toBeVisible();

  await expect(headers(page)).toHaveCount(1);
  await expect(header(page, "Urgent")).toHaveCount(0);
  await expect(count(page, "Medium")).toHaveText("4");
});

test("a filter narrows the groups and their counts, and clearing it brings them back", async ({ page, request }) => {
  await openGroupedByPriority(page, request);

  await page.getByRole("button", { name: /^Filters/ }).click();
  const panel = page.getByRole("dialog", { name: "Filters" });
  await panel.getByLabel("Priority").selectOption({ label: "Urgent" });

  await expect(headers(page)).toHaveCount(1);
  await expect(count(page, "Urgent")).toHaveText("2");
  await expect(header(page, "Medium")).toHaveCount(0);
  await expect(taskRows(page)).toHaveCount(2);

  await panel.getByLabel("Priority").selectOption({ index: 0 });

  await expect(headers(page)).toHaveCount(2);
  await expect(count(page, "Medium")).toHaveText("2");
  await expect(taskRows(page)).toHaveCount(4);
});

test("the group header rows are readable in the dark theme", async ({ page, request }) => {
  await openGroupedByPriority(page, request);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.mouse.move(0, 0);

  for (const label of ["Urgent", "Medium"]) {
    const name = header(page, label).getByRole("button").locator("span", { hasText: label });
    await expect(name).toBeVisible();
    const painted = await name.evaluate((element) => {
      const backgrounds: string[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        backgrounds.push(getComputedStyle(node).backgroundColor);
      }
      return { color: getComputedStyle(element).color, backgrounds };
    });
    expect(textContrast(painted), `${label} header text`).toBeGreaterThanOrEqual(AA_TEXT);
    expect(surfaceLuminance(painted.backgrounds), `${label} header surface`).toBeLessThanOrEqual(DARK_SURFACE_MAX_LUMINANCE);
  }
});
