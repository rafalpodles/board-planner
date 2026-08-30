import { test, expect, type Page } from "@playwright/test";
import { PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-501, and BP-491 before it. Both of the board toolbar's popovers are anchored to their own
 * button, and the toolbar is `flex flex-wrap` — so which edge a button sits at depends on the
 * width, on the sort control's current label and on whether the board is read-only. No breakpoint
 * can express that, and both panels proved it in opposite directions: Filters (first in the row)
 * opened 242px past the LEFT edge at every width below 640, showing 98 of its 340; Columns (last)
 * opened 128px past the left at 375 and, once flipped to `left-0`, 73-113px past the RIGHT at
 * 390-480.
 *
 * Geometry is the subject, so geometry is what is asserted — `getBoundingClientRect()`, not that a
 * dialog exists. A panel entirely off the screen is still in the DOM, still visible to
 * `toBeVisible()`, and still clickable by Playwright, which scrolls to whatever it clicks.
 */

test.beforeEach(seed);

interface Box {
  left: number;
  right: number;
  width: number;
  viewport: number;
}

async function boxOf(page: Page, name: string): Promise<Box> {
  return page.getByRole(name === "Filters" ? "dialog" : "group", { name }).evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width, viewport: window.innerWidth };
  });
}

async function openPanel(page: Page, button: string) {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByRole("button", { name: button })).toBeVisible();
  await page.getByRole("button", { name: button }).click();
}

function expectOnScreen(box: Box, what: string) {
  expect(box.left, `${what} starts ${Math.round(-box.left)}px past the left edge`).toBeGreaterThanOrEqual(0);
  expect(
    box.right,
    `${what} ends ${Math.round(box.right - box.viewport)}px past the right edge`
  ).toBeLessThanOrEqual(box.viewport);
  // The premise the two assertions above rest on: they are both satisfied by a panel of zero width,
  // and by one the fixture never opened.
  expect(box.width, `${what} has no width — was it opened at all?`).toBeGreaterThan(100);
}

/**
 * The widths people carry, plus the two edges of the rule. 375 is where the Columns row wraps and
 * 390-480 is where it does not; 639/640 are the two sides of `sm`, where the static anchors flip.
 */
for (const width of [360, 375, 390, 414, 430, 480, 600, 639, 640]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 }, hasTouch: true, isMobile: width < 768 });

    test("both of the board's panels open on the screen", async ({ page }) => {
      await signIn(page, "admin");

      await openPanel(page, "Filters");
      expectOnScreen(await boxOf(page, "Filters"), `the Filters panel at ${width}px`);
      // Reaching it is the point: a panel off the screen is one nobody can use
      await expect(page.getByRole("dialog", { name: "Filters" }).getByLabel("Assignee")).toBeVisible();

      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "List", exact: true }).click();
      await page.getByRole("button", { name: "Choose columns" }).click();
      expectOnScreen(await boxOf(page, "Columns"), `the Columns panel at ${width}px`);
    });
  });
}

// The control. Everything above is satisfied by a panel that never opens, or by one broken in a way
// that happens to keep it inside a narrow screen — a desktop is where these were always correct,
// and it has to stay that way.
test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the panels open where they always did, at their full width", async ({ page }) => {
    await signIn(page, "admin");

    await openPanel(page, "Filters");
    const filters = await boxOf(page, "Filters");
    expectOnScreen(filters, "the Filters panel on a desktop");
    // Its full 340, not a clamped remnant: the clamp must do nothing at all here
    expect(Math.round(filters.width)).toBe(340);

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "List", exact: true }).click();
    await page.getByRole("button", { name: "Choose columns" }).click();
    const columns = await boxOf(page, "Columns");
    expectOnScreen(columns, "the Columns panel on a desktop");
    expect(Math.round(columns.width)).toBe(224);
  });
});
