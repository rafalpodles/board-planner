import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { PROJECT_ID, PROJECT_KEY, SIBLING_TASK_TITLE, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-491. Nine of the list's eleven columns carried a `hidden sm|md|lg:table-cell` pair, so on a
 * phone the picker took a tick, changed its own count and rendered nothing. Panning sideways was
 * not a way round it either: a display:none cell takes no width, so the `overflow-x-auto` wrapper
 * had nothing past its edge.
 *
 * What is asserted here is that the picker is now the only thing deciding what renders, that the
 * row is wide enough to be panned to the columns it turns on, and that a desktop keeps the
 * fit-in-one-screen layout 6ae1505 deliberately restored.
 */

test.beforeEach(seed);

/** Every built-in column, in the order `list-columns.ts` gives them */
const SORTABLE_COLUMNS = [
  "Status",
  "Assignee",
  "Priority",
  "Sprint",
  "Category",
  "Due",
  "Updated",
];
/** Off unless the picker turns them on — see DEFAULT_HIDDEN_BUILT_INS */
const HIDDEN_BY_DEFAULT = ["Category", "Due", "Updated"];
const PROJECT_FIELD = "Component";

/** min-w-44, the floor that stops the title collapsing to nothing while the row overflows */
const TITLE_FLOOR = "176px";

const header = (page: Page, label: string) =>
  page.getByRole("button", { name: `Sort by ${label}`, exact: true });

/**
 * A project field that shows in the list, added through the production route. The seed's own
 * fields are all `showInList: false`, and a project field's column carried a breakpoint pair like
 * every other — so without one, a third of what this ticket fixed is unreachable from a test.
 */
async function addListedField(request: APIRequestContext) {
  const created = await request.post(`/api/projects/${String(PROJECT_ID)}/custom-fields`, {
    headers: ADMIN_AUTH,
    data: { name: PROJECT_FIELD, fieldType: "text", showInList: true },
  });
  expect(created.status()).toBe(201);
}

async function openList(page: Page) {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator("table")).toBeVisible();
  // The stored selection is applied by an effect, so until a default-hidden column is absent the
  // page is still showing the pre-hydration state, where nothing is hidden at all
  await expect(header(page, "Updated")).toHaveCount(0);
}

/** Turns on every column the picker offers, and proves it did */
async function tickEveryColumn(page: Page) {
  await page.getByRole("button", { name: "Choose columns" }).click();
  const boxes = page.getByRole("group", { name: "Columns" }).getByRole("checkbox");
  const count = await boxes.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) await boxes.nth(i).check();
  // A panel that closed mid-loop leaves the rest silently unticked, and the control then covers
  // fewer columns than its name claims
  for (let i = 0; i < count; i++) await expect(boxes.nth(i)).toBeChecked();
}

/** The wrapper the table sits in, read from the table itself rather than a test-only hook */
async function scroller(page: Page) {
  return page.locator("table").evaluate((table) => {
    const wrapper = table.parentElement as HTMLElement;
    const style = getComputedStyle(wrapper);
    return {
      overflowX: style.overflowX,
      overscrollBehaviorX: style.overscrollBehaviorX,
      clientWidth: wrapper.clientWidth,
      scrollWidth: wrapper.scrollWidth,
    };
  });
}

const titleCell = (page: Page) => page.locator(`td[title="${SIBLING_TASK_TITLE}"]`);

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 800 }, hasTouch: true, isMobile: true });

  test("the columns that are on by default are on the screen, not only in the picker", async ({
    page,
  }) => {
    await openList(page);

    for (const label of SORTABLE_COLUMNS.filter((c) => !HIDDEN_BY_DEFAULT.includes(c))) {
      await expect(header(page, label), `${label} is on by default`).toBeVisible();
    }
    for (const label of HIDDEN_BY_DEFAULT) {
      await expect(header(page, label), `${label} is off by default`).toHaveCount(0);
    }

    const cell = titleCell(page);
    expect(await cell.evaluate((td) => getComputedStyle(td).minWidth)).toBe(TITLE_FLOOR);
    expect(await cell.evaluate((td) => td.getBoundingClientRect().width)).toBeGreaterThanOrEqual(
      parseInt(TITLE_FLOOR, 10),
    );

    const wrapper = await scroller(page);
    expect(wrapper.overflowX).toBe("auto");
    expect(wrapper.scrollWidth).toBeGreaterThan(wrapper.clientWidth);
    // Without it, panning to the end of the row chains into the browser's back gesture
    expect(wrapper.overscrollBehaviorX).toBe("contain");
  });

  test("every column the picker offers renders, and the row pans to the far one", async ({
    page,
    request,
  }) => {
    await addListedField(request);
    await openList(page);
    await tickEveryColumn(page);

    for (const label of [...SORTABLE_COLUMNS, PROJECT_FIELD]) {
      await expect(header(page, label), `${label} was ticked`).toBeVisible();
    }
    // The count the ticket caught lying: eight built-ins plus the project field, all rendered
    await expect(page.getByRole("button", { name: "Choose columns" })).toContainText("10/10");

    const panned = await page.locator("table").evaluate((table) => {
      const wrapper = table.parentElement as HTMLElement;
      wrapper.scrollLeft = wrapper.scrollWidth;
      const last = table.querySelector("thead th:last-child") as HTMLElement;
      const port = wrapper.getBoundingClientRect();
      const box = last.getBoundingClientRect();
      return {
        scrollLeft: wrapper.scrollLeft,
        label: last.textContent?.trim(),
        inside: box.left >= port.left - 1 && box.right <= port.right + 1,
      };
    });
    expect(panned.scrollLeft, "the row had nowhere to pan").toBeGreaterThan(0);
    expect(panned.label).toBe(PROJECT_FIELD);
    expect(panned.inside, "the far column cannot be panned into view").toBe(true);

    await page.getByRole("checkbox", { name: "Updated", exact: true }).uncheck();
    await expect(header(page, "Updated")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Choose columns" })).toContainText("9/10");
  });
});

/**
 * The panel's anchor is only correct at some widths, and which ones depends on whether the toolbar
 * row wrapped — 375 wraps the Columns button to the left, 390 and up do not. Measured with a fixed
 * anchor: `right-0` opens 128px past the left edge at 375, `left-0` opens 73-113px past the right
 * edge at 390-480. A check written at one width passes whichever way the anchoring is wrong.
 */
for (const width of [375, 390, 414, 430, 700]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true });

    test("the column picker's panel opens on the screen", async ({ page }) => {
      await openList(page);
      await page.getByRole("button", { name: "Choose columns" }).click();

      const panel = await page.getByRole("group", { name: "Columns" }).evaluate((el) => {
        const box = el.getBoundingClientRect();
        return { left: box.left, right: box.right, viewport: window.innerWidth };
      });
      expect(panel.left, `panel starts ${-panel.left}px past the left edge`).toBeGreaterThanOrEqual(
        0,
      );
      expect(
        panel.right,
        `panel ends ${panel.right - panel.viewport}px past the right edge`,
      ).toBeLessThanOrEqual(panel.viewport);

      // Reaching it is the point: an off-screen panel is one nothing can tick
      await page.getByRole("checkbox", { name: "Updated", exact: true }).check();
      await expect(header(page, "Updated")).toBeVisible();
    });
  });
}

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the title floor is off, and every column at once still fits in one screen", async ({
    page,
    request,
  }) => {
    await addListedField(request);
    await openList(page);
    await tickEveryColumn(page);
    await expect(header(page, PROJECT_FIELD)).toBeVisible();

    // 6ae1505 stopped the list scrolling sideways by removing a floor exactly like the phone's, so
    // the rule itself is asserted rather than one of its consequences: at this width the title
    // gets far more than 176px on its own, so a floor left on here would change nothing and a fit
    // assertion alone would pass whether it reached desktop or not.
    expect(await titleCell(page).evaluate((td) => getComputedStyle(td).minWidth)).toBe("0px");

    const wrapper = await scroller(page);
    expect(wrapper.scrollWidth).toBeLessThanOrEqual(wrapper.clientWidth + 1);
  });
});
