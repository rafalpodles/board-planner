import { test, expect, type Page } from "@playwright/test";
import { PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-491. Nine of the list's eleven columns carried a `hidden sm|md|lg:table-cell` pair, so on a
 * phone the picker took a tick, changed its own count and rendered nothing. Panning sideways was
 * not a way round it either: a display:none cell takes no width, so the `overflow-x-auto` wrapper
 * had nothing past its edge.
 *
 * What is asserted here is that the picker is now the only thing deciding what renders, and that
 * the row is allowed to be wider than the phone so the columns it turns on are reachable — while
 * a desktop keeps the fit-in-one-screen layout 6ae1505 deliberately restored.
 */

test.beforeEach(seed);

const header = (page: Page, label: string) =>
  page.getByRole("button", { name: `Sort by ${label}`, exact: true });

async function openList(page: Page) {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator("table")).toBeVisible();
}

/** The wrapper the table sits in, read from the table itself rather than a test-only hook */
async function scroller(page: Page) {
  return page.locator("table").evaluate((table) => {
    const wrapper = table.parentElement as HTMLElement;
    return {
      overflowX: getComputedStyle(wrapper).overflowX,
      clientWidth: wrapper.clientWidth,
      scrollWidth: wrapper.scrollWidth,
    };
  });
}

const TITLE_FLOOR = 176; // min-w-44, the floor that stops the title collapsing to nothing

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 780 }, hasTouch: true, isMobile: true });

  test("a ticked column renders, and the row can be panned to reach it", async ({ page }) => {
    await openList(page);

    await test.step("the columns on by default are on the screen, not only in the picker", async () => {
      await expect(header(page, "Status")).toBeVisible();
      await expect(header(page, "Assignee")).toBeVisible();
      await expect(header(page, "Priority")).toBeVisible();
    });

    await test.step("the row is wider than the phone, so the far columns are reachable", async () => {
      const wrapper = await scroller(page);
      expect(wrapper.overflowX).toBe("auto");
      expect(wrapper.scrollWidth).toBeGreaterThan(wrapper.clientWidth);
    });

    await test.step("the title keeps a readable width rather than collapsing", async () => {
      // The title cell carries the full title as its `title` attribute; the key cell carries the key
      const width = await page
        .locator('td[title="Free to move"]')
        .evaluate((td) => td.getBoundingClientRect().width);
      expect(width).toBeGreaterThanOrEqual(TITLE_FLOOR);
    });

    await test.step("a column the picker turns on appears, and turning it off removes it", async () => {
      await expect(header(page, "Updated")).toHaveCount(0);

      await page.getByRole("button", { name: "Choose columns" }).click();

      // The panel is anchored to the button's right edge, and the toolbar wraps the button to the
      // left of a phone — so a 224px panel used to open at x=-128, entirely past the screen
      const panel = await page
        .getByRole("group", { name: "Columns" })
        .evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, viewport: window.innerWidth };
        });
      expect(panel.left).toBeGreaterThanOrEqual(0);
      expect(panel.right).toBeLessThanOrEqual(panel.viewport);

      const updated = page.getByRole("checkbox", { name: "Updated", exact: true });
      await expect(updated).not.toBeChecked();
      await updated.check();
      await expect(header(page, "Updated")).toBeVisible();

      await updated.uncheck();
      await expect(header(page, "Updated")).toHaveCount(0);
    });
  });
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the same columns render, and the default list still fits in one screen", async ({
    page,
  }) => {
    await openList(page);
    await expect(header(page, "Status")).toBeVisible();
    await expect(header(page, "Sprint")).toBeVisible();

    // 6ae1505 removed the sideways scrolling on purpose. The phone's floor is dropped from lg up
    // precisely so that decision survives, and this is what would catch putting it back.
    const wrapper = await scroller(page);
    expect(wrapper.scrollWidth).toBe(wrapper.clientWidth);
  });
});

