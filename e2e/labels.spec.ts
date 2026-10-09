import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import {
  DECOY_TASK_TITLE,
  FINISHED_TASK_KEY,
  FINISHED_TASK_TITLE,
  HELD_TASK_TITLE,
  LABELS_FIELD_ID,
  LIST_DROPDOWN_FIELD_NAME,
  LIST_DROPDOWN_OPTIONS,
  PROJECT_KEY,
  SIBLING_TASK_TITLE,
  seed,
  seedLabelsField,
  seedListVisibleDropdownField,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-887. Labels are the project's "Labels" multiselect: picked several at a time in the filter,
 * found by name in the board's search, the palette and the tasks API, and edited in the list.
 */
test.beforeEach(seed);

const BOARD = `/projects/${PROJECT_KEY}`;
const rows = (page: Page) => page.locator("table tbody tr");
const row = (page: Page, title: string) => rows(page).filter({ hasText: title });
const panel = (page: Page) => page.getByRole("dialog", { name: "Filters" });

async function openList(page: Page) {
  await signIn(page);
  await page.goto(BOARD);
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator("table")).toBeVisible();
}

async function openPanel(page: Page) {
  if (!(await panel(page).isVisible())) await page.getByRole("button", { name: /^Filters/ }).click();
  await expect(panel(page)).toBeVisible();
  return panel(page);
}

const labelGroup = (page: Page) => panel(page).getByRole("group", { name: "Labels", exact: true });

async function storedLabels(request: APIRequestContext, taskNumber: number): Promise<string[]> {
  const res = await request.get(`/api/projects/${PROJECT_KEY}/tasks/${taskNumber}`, { headers: ADMIN_AUTH });
  expect(res.status()).toBe(200);
  const task = await res.json();
  return [...((task.customFieldValues?.[String(LABELS_FIELD_ID)] as string[] | undefined) ?? [])].sort();
}

test("the filter takes several labels, matches any or all of them, and keeps the choice across a reload", async ({ page }) => {
  await seedLabelsField();
  await openList(page);
  await expect(rows(page)).toHaveCount(4);

  await test.step("one label narrows to the tasks that carry it", async () => {
    await openPanel(page);
    await labelGroup(page).getByRole("button", { name: "Frontend", exact: true }).click();

    await expect(row(page, HELD_TASK_TITLE)).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
  });

  await test.step("a second label widens it: any of them", async () => {
    await labelGroup(page).getByRole("button", { name: "Backend", exact: true }).click();

    await expect(labelGroup(page).getByRole("button", { name: "Any of them" })).toHaveAttribute("aria-pressed", "true");
    await expect(row(page, HELD_TASK_TITLE)).toBeVisible();
    await expect(row(page, DECOY_TASK_TITLE)).toBeVisible();
    await expect(rows(page)).toHaveCount(2);
  });

  await test.step("all of them keeps only the task that has both", async () => {
    await labelGroup(page).getByRole("button", { name: "All of them" }).click();

    await expect(row(page, HELD_TASK_TITLE)).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
    await expect(panel(page)).toContainText("Labels: Frontend and Backend");
  });

  await test.step("the choice, mode included, is still there after a reload", async () => {
    await page.reload();
    await expect(page.locator("table")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Filters/ })).toContainText("1");
    await expect(row(page, HELD_TASK_TITLE)).toBeVisible();
    await expect(rows(page)).toHaveCount(1);

    await openPanel(page);
    await expect(labelGroup(page).getByRole("button", { name: "All of them" })).toHaveAttribute("aria-pressed", "true");
  });

  await test.step("clearing the picks gives every task back", async () => {
    await labelGroup(page).getByRole("button", { name: "Frontend", exact: true }).click();
    await labelGroup(page).getByRole("button", { name: "Backend", exact: true }).click();

    await expect(rows(page)).toHaveCount(4);
  });
});

test("a label's name typed in the board's search finds the task that carries it", async ({ page }) => {
  await seedLabelsField();
  await openList(page);
  const search = page.getByPlaceholder(/^Search tasks/);

  await search.fill("design");
  await expect(row(page, SIBLING_TASK_TITLE)).toBeVisible();
  await expect(rows(page)).toHaveCount(1);

  await search.fill("backend");
  await expect(row(page, HELD_TASK_TITLE)).toBeVisible();
  await expect(row(page, DECOY_TASK_TITLE)).toBeVisible();
  await expect(rows(page)).toHaveCount(2);

  await search.fill("nothing has this name");
  await expect(rows(page)).toHaveCount(0);
});

test("the search palette finds a task by its label, and the tasks API does too", async ({ page, request }) => {
  await seedLabelsField();
  await signIn(page);
  await page.goto(BOARD);
  await expect(page.getByText(HELD_TASK_TITLE).first()).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  const layer = page.getByRole("dialog", { name: "Search" });
  await layer.getByLabel("Search tasks and projects").fill("backend");

  await expect(layer.getByText(HELD_TASK_TITLE).first()).toBeVisible();
  await expect(layer.getByText(DECOY_TASK_TITLE).first()).toBeVisible();
  await expect(layer.getByText(SIBLING_TASK_TITLE)).toHaveCount(0);

  const found = await request.get(`/api/projects/${PROJECT_KEY}/tasks?search=design`, { headers: ADMIN_AUTH });
  expect(found.status()).toBe(200);
  expect((await found.json()).map((t: { title: string }) => t.title)).toEqual([SIBLING_TASK_TITLE]);
});

test("labels are edited from the list, several at a time", async ({ page, request }) => {
  await seedLabelsField();
  await openList(page);
  await page.getByRole("button", { name: "Choose columns" }).click();
  const box = page.getByRole("checkbox", { name: "Labels", exact: true });
  if (!(await box.isChecked())) await box.check();
  await page.keyboard.press("Escape");

  const rowLabel = `${FINISHED_TASK_KEY}: ${FINISHED_TASK_TITLE}`;
  const combo = page.getByRole("combobox", { name: `Labels for ${rowLabel}` });
  await expect(combo).toBeVisible();
  expect(await storedLabels(request, 4)).toEqual([]);

  await combo.click();
  const listbox = page.getByRole("listbox", { name: `Labels for ${rowLabel}` });
  await expect(listbox).toBeVisible();
  const write = () =>
    page.waitForResponse(
      (r) => /\/tasks\//.test(new URL(r.url()).pathname) && r.request().method() === "PUT" && r.ok()
    );

  let written = write();
  await listbox.getByRole("option", { name: "Design", exact: true }).click();
  await written;
  await expect(listbox, "the picker stays open for the next pick").toBeVisible();

  written = write();
  await listbox.getByRole("option", { name: "Backend", exact: true }).click();
  await written;

  expect(await storedLabels(request, 4)).toEqual(["o-back", "o-design"]);

  written = write();
  await listbox.getByRole("option", { name: "Design", exact: true }).click();
  await written;
  expect(await storedLabels(request, 4), "a ticked label unticks").toEqual(["o-back"]);
  await page.keyboard.press("Escape");
  await expect(row(page, FINISHED_TASK_TITLE)).toContainText("Backend");
  await expect(row(page, FINISHED_TASK_TITLE)).not.toContainText("Design");

  await combo.click();
  written = write();
  await listbox.getByRole("option", { name: "Clear all" }).click();
  await written;
  expect(await storedLabels(request, 4)).toEqual([]);
});

test("two quick picks in the list both reach the server, even when the first request is slow", async ({ page, request }) => {
  await seedLabelsField();
  await openList(page);
  await page.getByRole("button", { name: "Choose columns" }).click();
  await page.getByRole("checkbox", { name: "Labels", exact: true }).check();
  await page.keyboard.press("Escape");

  let writes = 0;
  let answered = 0;
  page.on("response", (r) => {
    if (r.request().method() === "PUT" && /\/tasks\/[^/]+$/.test(new URL(r.url()).pathname)) answered++;
  });
  await page.route(/\/api\/projects\/[^/]+\/tasks\/[^/]+$/, async (route) => {
    if (route.request().method() === "PUT" && writes++ === 0) await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });

  const rowLabel = `${FINISHED_TASK_KEY}: ${FINISHED_TASK_TITLE}`;
  await page.getByRole("combobox", { name: `Labels for ${rowLabel}` }).click();
  const listbox = page.getByRole("listbox", { name: `Labels for ${rowLabel}` });
  await listbox.getByRole("option", { name: "Design", exact: true }).click();
  await listbox.getByRole("option", { name: "Backend", exact: true }).click();

  await expect.poll(() => answered, { timeout: 10_000 }).toBe(2);
  expect(await storedLabels(request, 4)).toEqual(["o-back", "o-design"]);
});

test.describe("a board without a Labels field", () => {
  const SETTINGS = `/projects/${PROJECT_KEY}/settings?section=fields`;

  test("offers one, prefilled, and adds it without touching the fields already there", async ({ page, request }) => {
    await seedListVisibleDropdownField();
    await signIn(page);
    await page.goto(SETTINGS);
    await expect(page.getByRole("heading", { name: "Task fields", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "+ Add a Labels field" }).click();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Labels");
    await expect(page.getByLabel("Type", { exact: true })).toHaveValue("multiselect");

    await page.getByRole("button", { name: "+ Add option" }).click();
    await page.getByPlaceholder("Option name").nth(0).fill("Quick win");
    const created = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/custom-fields"));
    await page.getByRole("button", { name: "Create field" }).click();
    expect((await created).status()).toBe(201);

    await expect(page.getByRole("button", { name: "+ Add field" })).toBeVisible();
    await expect(page.getByRole("button", { name: "+ Add a Labels field" })).toHaveCount(0);
    const res = await request.get(`/api/projects/${PROJECT_KEY}/custom-fields`, { headers: ADMIN_AUTH });
    const stored = (await res.json()) as { name: string; fieldType: string; filterable: boolean; showOnCard: boolean }[];
    expect(stored.map((f) => f.name)).toEqual([LIST_DROPDOWN_FIELD_NAME, "Labels"]);
    expect(stored[0]).toMatchObject({ fieldType: "dropdown", showInList: true });
    expect((stored[0] as unknown as { options: { value: string }[] }).options.map((o) => o.value)).toEqual(
      LIST_DROPDOWN_OPTIONS.map((o) => o.value)
    );
    expect(stored[1]).toMatchObject({ fieldType: "multiselect", filterable: true, showOnCard: true });
  });

  test("is not offered once the board has one", async ({ page }) => {
    await seedLabelsField();
    await signIn(page);
    await page.goto(SETTINGS);
    await expect(page.getByRole("button", { name: "+ Add field" })).toBeVisible();

    await expect(page.getByRole("button", { name: "+ Add a Labels field" })).toHaveCount(0);
  });
});
