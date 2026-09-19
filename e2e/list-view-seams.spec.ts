import { test, expect, type Page } from "@playwright/test";
import {
  DECOY_TASK_TITLE,
  FINISHED_TASK_TITLE,
  HELD_TASK_TITLE,
  LIST_DROPDOWN_FIELD_NAME,
  LIST_DROPDOWN_OPTIONS,
  PLANNING_SPRINT_ID,
  PLANNING_SPRINT_NAME,
  PROJECT_KEY,
  SIBLING_TASK_KEY,
  SIBLING_TASK_TITLE,
  seed,
  seedListVisibleDropdownField,
  seedSprintPlanning,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-470. The seams left after BP-491/BP-493/BP-449/BP-455 closed the list view's larger gaps: the
 * pointer path of the grip's drag (the keyboard sensor is covered elsewhere), clicking a column
 * header to sort, `Reset to default`, a hidden column surviving a real reload, and inline editing
 * of category/sprint/a project dropdown field (status/assignee/priority are covered elsewhere).
 */

// Only what every test needs. seedSprintPlanning() and seedListVisibleDropdownField() add three
// more tasks and a field respectively — real fixtures the inline-edit test wants, but rows and
// columns the other four don't, and the sort test's expected order would have to grow with them.
test.beforeEach(seed);

const BOARD = `/projects/${PROJECT_KEY}`;

async function openList(page: Page) {
  await signIn(page);
  await page.goto(BOARD);
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator("table")).toBeVisible();
}

const sortHeader = (page: Page, label: string) =>
  page.getByRole("button", { name: `Sort by ${label}`, exact: true });

/**
 * The `<th>` itself, which is where `aria-sort` lives — the button inside it only carries the
 * click. The `<th>`'s accessible name is inherited from the button's `aria-label`
 * ("Sort by X"), not its visible text, since an explicit aria-label wins the accname computation.
 */
const columnHeader = (page: Page, label: string) =>
  page.getByRole("columnheader", { name: `Sort by ${label}`, exact: true });

const handles = (page: Page) => page.getByRole("button", { name: /^Reorder / });

/** The task keys the list shows, top to bottom. */
async function rowOrder(page: Page): Promise<string[]> {
  return handles(page).evaluateAll((els) =>
    els.map((el) => el.getAttribute("aria-label")!.replace("Reorder ", ""))
  );
}

/** dnd-kit's own announcements. `.last()` because an empty region is rendered before the first. */
const announced = (page: Page) =>
  page.locator('[id^="DndLiveRegion"]').filter({ hasText: /./ }).last();

async function overDroppable(page: Page): Promise<string | null> {
  const said = (await announced(page).textContent()) ?? "";
  return said.match(/over droppable area (\S+?)\.?$/)?.[1] ?? null;
}

async function openColumnPicker(page: Page) {
  await page.getByRole("button", { name: "Choose columns" }).click();
  await expect(page.getByRole("group", { name: "Columns" })).toBeVisible();
}

async function toggleColumnOn(page: Page, label: string) {
  await openColumnPicker(page);
  const box = page.getByRole("checkbox", { name: label, exact: true });
  if (!(await box.isChecked())) await box.check();
  await page.keyboard.press("Escape");
}

test.describe("list view, desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a row is reordered by dragging its grip with the pointer", async ({ page }) => {
    await openList(page);
    // The default sort is manual/asc, which is what makes the grip appear at all — settle past
    // any hydration flicker before trusting the geometry below.
    await expect.poll(async () => (await rowOrder(page)).length).toBeGreaterThan(1);

    const before = await rowOrder(page);
    const grips = handles(page);
    const start = await grips.nth(0).boundingBox();
    const target = await grips.nth(1).boundingBox();
    if (!start || !target) throw new Error("a reorder handle has no box to drag from or to");

    const startX = start.x + start.width / 2;
    const startY = start.y + start.height / 2;
    const endX = target.x + target.width / 2;
    const endY = target.y + target.height / 2;

    const written = page.waitForResponse(
      (r) => r.url().includes("/tasks/reorder") && r.request().method() === "PUT" && r.ok()
    );

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Past PointerSensor's own `activationConstraint: { distance: 4 }` (ListView.tsx) before
    // anything else is asked of it — a shorter move never arms the sensor, and BP-455's note
    // that a pointer drag "depends on the row's height and the activation constraint" is exactly
    // the geometry this clears explicitly rather than assuming.
    await page.mouse.move(startX, startY + 8, { steps: 4 });
    await expect
      .poll(() => overDroppable(page), {
        message: "the pointer never picked the row up — the activation constraint was not cleared",
      })
      .not.toBeNull();
    const from = await overDroppable(page);

    await page.mouse.move(endX, endY, { steps: 15 });
    await expect
      .poll(() => overDroppable(page), {
        message: "the pointer drag never reached the second row",
      })
      .not.toBe(from);

    await page.mouse.up();
    await expect(announced(page)).toContainText(/was dropped/i);
    await written;

    // The whole array, not just the two rows that moved: a reorder that also disturbed the
    // untouched rows would satisfy a check on the first two alone.
    const after = await rowOrder(page);
    expect(after).toEqual([before[1], before[0], ...before.slice(2)]);

    // The server agrees, which is what makes the screen right rather than merely stable
    await page.reload();
    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect.poll(() => rowOrder(page)).toEqual(after);
  });

  test("clicking a column header sorts the rows both ways, and the filter bar agrees", async ({
    page,
  }) => {
    await openList(page);

    const ascending = [DECOY_TASK_TITLE, SIBLING_TASK_TITLE, HELD_TASK_TITLE, FINISHED_TASK_TITLE];
    const titleCells = () => page.locator("table tbody tr td.font-medium");
    const sortSelect = page.getByRole("combobox", { name: "Sort tasks by" });

    await sortHeader(page, "Title").click();
    await expect(titleCells()).toHaveText(ascending);
    await expect(columnHeader(page, "Title")).toHaveAttribute("aria-sort", "ascending");
    await expect(sortSelect).toHaveValue("title");
    await expect(page.getByRole("button", { name: "Sort ascending" })).toBeVisible();

    await sortHeader(page, "Title").click();
    await expect(titleCells()).toHaveText([...ascending].reverse());
    await expect(columnHeader(page, "Title")).toHaveAttribute("aria-sort", "descending");
    await expect(sortSelect).toHaveValue("title");
    await expect(page.getByRole("button", { name: "Sort descending" })).toBeVisible();

    // The control: a header that is not the active sort makes no claim either way
    await expect(columnHeader(page, "Status")).toHaveAttribute("aria-sort", "none");
  });

  test("Reset to default restores the default columns from a changed selection", async ({
    page,
  }) => {
    await openList(page);
    await openColumnPicker(page);
    await expect(page.getByRole("button", { name: "Reset to default" })).toBeDisabled();
    await expect(sortHeader(page, "Category")).toHaveCount(0);

    await page.getByRole("checkbox", { name: "Category", exact: true }).check();
    await expect(sortHeader(page, "Category")).toBeVisible();
    await expect(page.getByRole("button", { name: "Reset to default" })).toBeEnabled();

    await page.getByRole("button", { name: "Reset to default" }).click();
    await expect(sortHeader(page, "Category")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reset to default" })).toBeDisabled();
  });

  test("a hidden column is still hidden after a reload", async ({ page }) => {
    await openList(page);
    await expect(sortHeader(page, "Sprint")).toBeVisible();

    await openColumnPicker(page);
    await page.getByRole("checkbox", { name: "Sprint", exact: true }).uncheck();
    await expect(sortHeader(page, "Sprint")).toHaveCount(0);

    await page.reload();
    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect(page.locator("table")).toBeVisible();
    await expect(sortHeader(page, "Sprint")).toHaveCount(0);
    // Control: a column nobody hid is still there, so this is the stored selection being
    // re-read rather than an empty or half-rendered table
    await expect(sortHeader(page, "Status")).toBeVisible();
  });

  test("inline editing covers category, sprint, and a project dropdown field", async ({
    page,
  }) => {
    await seedSprintPlanning();
    await seedListVisibleDropdownField();
    await openList(page);
    await toggleColumnOn(page, "Category");
    await toggleColumnOn(page, LIST_DROPDOWN_FIELD_NAME);

    const rowLabel = `${SIBLING_TASK_KEY}: ${SIBLING_TASK_TITLE}`;

    // Category
    {
      const combo = page.getByRole("combobox", { name: `Category for ${rowLabel}` });
      await expect(combo).toHaveText("user-story");
      await combo.click();
      const listbox = page.getByRole("listbox", { name: `Category for ${rowLabel}` });
      await expect(listbox).toBeVisible();
      const written = page.waitForResponse(
        (r) => /\/tasks\//.test(new URL(r.url()).pathname) && r.request().method() === "PUT" && r.ok()
      );
      await listbox.getByRole("option", { name: "bug", exact: true }).click();
      await written;
      await expect(combo).toHaveText("bug");
    }

    // Sprint — verified against the server rather than the row, since assigning a sprint can
    // take a row off the current scope's list (BP-557) and that is a different behaviour from
    // whether the edit itself saved.
    {
      const combo = page.getByRole("combobox", { name: `Sprint for ${rowLabel}` });
      await combo.click();
      const listbox = page.getByRole("listbox", { name: `Sprint for ${rowLabel}` });
      await expect(listbox).toBeVisible();
      const written = page.waitForResponse(
        (r) => /\/tasks\//.test(new URL(r.url()).pathname) && r.request().method() === "PUT" && r.ok()
      );
      await listbox.getByRole("option", { name: PLANNING_SPRINT_NAME, exact: true }).click();
      const response = await written;
      expect((await response.json()).sprint).toBe(String(PLANNING_SPRINT_ID));
    }

    // A project dropdown field
    {
      const combo = page.getByRole("combobox", { name: `${LIST_DROPDOWN_FIELD_NAME} for ${rowLabel}` });
      await expect(combo).toHaveText("—");
      await combo.click();
      const listbox = page.getByRole("listbox", {
        name: `${LIST_DROPDOWN_FIELD_NAME} for ${rowLabel}`,
      });
      await expect(listbox).toBeVisible();
      const written = page.waitForResponse(
        (r) => /\/tasks\//.test(new URL(r.url()).pathname) && r.request().method() === "PUT" && r.ok()
      );
      await listbox.getByRole("option", { name: LIST_DROPDOWN_OPTIONS[0].value, exact: true }).click();
      await written;
      await expect(combo).toHaveText(LIST_DROPDOWN_OPTIONS[0].value);
    }
  });
});
