import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { PROJECT_ID, PROJECT_KEY, SIBLING_TASK_TITLE, seed } from "./seed";
import { signIn } from "./session";

test.beforeEach(seed);

const SORTABLE_COLUMNS = [
  "Status",
  "Assignee",
  "Priority",
  "Sprint",
  "Category",
  "Due",
  "Updated",
];
const HIDDEN_BY_DEFAULT = ["Category", "Due", "Updated"];
const PROJECT_FIELD = "Component";

const TITLE_FLOOR = "176px";

const header = (page: Page, label: string) =>
  page.getByRole("button", { name: `Sort by ${label}`, exact: true });

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
  await expect(header(page, "Updated")).toHaveCount(0);
}

async function tickEveryColumn(page: Page) {
  await page.getByRole("button", { name: "Choose columns" }).click();
  const boxes = page.getByRole("group", { name: "Columns" }).getByRole("checkbox");
  const count = await boxes.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) await boxes.nth(i).check();
  for (let i = 0; i < count; i++) await expect(boxes.nth(i)).toBeChecked();
}

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

    expect(await titleCell(page).evaluate((td) => getComputedStyle(td).minWidth)).toBe("0px");

    const wrapper = await scroller(page);
    expect(wrapper.scrollWidth).toBeLessThanOrEqual(wrapper.clientWidth + 1);
  });
});
