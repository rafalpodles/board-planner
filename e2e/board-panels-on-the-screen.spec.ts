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
  /** "none" when the clamp decided the panel was already where it should be */
  transform: string;
}

async function boxOf(page: Page, name: string): Promise<Box> {
  return page.getByRole(name === "Filters" ? "dialog" : "group", { name }).evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      viewport: window.innerWidth,
      transform: getComputedStyle(el).transform,
    };
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

      // The List toggle is what closes Filters — it lives in the row above, and its mousedown is
      // the outside click the panel listens for. Escape does not: only ColumnPicker binds it.
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
    // Its full 340, not a clamped remnant: a "fix" that shrank the panel instead of moving it
    expect(Math.round(filters.width)).toBe(340);
    // And it did not MOVE either. Without this, a clamp that unconditionally pinned every panel to
    // x=12 would pass everything above — on screen, full width, and torn off its button.
    expect(filters.transform, "the clamp moved a panel that was already in place").toBe("none");

    await page.getByRole("button", { name: "List", exact: true }).click();
    await page.getByRole("button", { name: "Choose columns" }).click();
    const columns = await boxOf(page, "Columns");
    expectOnScreen(columns, "the Columns panel on a desktop");
    expect(Math.round(columns.width)).toBe(224);
    expect(columns.transform, "the clamp moved a panel that was already in place").toBe("none");
  });
});

/**
 * The panel's own primary interaction moves its anchor. Picking a filter adds the count badge to
 * the Filters button — measured at 375px, its right edge goes 98 to 120 — and below `sm` the panel
 * is anchored to that edge, so it travels 22px with a shift computed before the click. 360 is where
 * that runs off the screen; the same click at 375 lands one pixel inside it and proves nothing.
 */
test.describe("after a click inside the panel", () => {
  test.use({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true });

  test("the Filters panel is still on the screen", async ({ page }) => {
    await signIn(page, "admin");
    await openPanel(page, "Filters");
    const before = await boxOf(page, "Filters");
    expectOnScreen(before, "the Filters panel before the click");

    const dialog = page.getByRole("dialog", { name: "Filters" });
    await dialog.getByLabel("Priority").selectOption({ label: "High" });
    // The premise: the anchor really did move. Without it this test passes on a build where the
    // badge never appears, and says nothing about the clamp.
    await expect(page.getByRole("button", { name: "Filters" })).toContainText("1");

    expectOnScreen(await boxOf(page, "Filters"), "the Filters panel after picking a priority");
  });
});
