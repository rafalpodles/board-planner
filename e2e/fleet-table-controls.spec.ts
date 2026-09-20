import { test, expect, type Page } from "@playwright/test";
import { WORKER_NAME, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-642. The admin fleet table carried twelve columns and the settings shell gives it 882px on a
 * 1440-wide laptop. The nine that describe a machine fit; Enabled, Lock and the three command
 * buttons did not, and with scrollbars hidden app-wide (BP-224) there was nothing on the screen to
 * say they existed at all. Lock is what the docs tell an operator to reach for when a machine is
 * misbehaving.
 *
 * Two things are pinned here, and they are different claims. That the controls are **within the
 * scrollport** is the fix; that the table **says it continues** is what keeps the columns now
 * sitting under the pinned one from disappearing as silently as the controls did. The second is
 * asserted at phone width too, where nothing is pinned and the scroller's own fade is the sign.
 *
 * Whether the column pins is decided by measuring the scrollport, not by a breakpoint — the
 * scrollport is the window less a sidebar and a settings nav — so the widths below are chosen
 * either side of that measurement rather than either side of `lg`.
 */
const LAPTOP = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };

async function openFleet(page: Page) {
  await signIn(page);
  await page.goto("/settings/workers");
  await expect(page.getByRole("heading", { name: "Worker fleet" })).toBeVisible();
  return page.getByRole("row").filter({ hasText: WORKER_NAME }).first();
}

const controlsCell = (page: Page) =>
  page.locator("tbody td").filter({ hasText: "Resume" }).first();

/**
 * How many shadows the pinned cell actually paints.
 *
 * `boxShadow` never reads "none" on a Tailwind shadow utility: the class expands to the ring and
 * shadow variables, so four fully transparent placeholders are always in the list. Counting the
 * entries with any alpha at all is what tells the column's own left edge (one, always) from the
 * edge it draws over content passing underneath (two).
 */
const paintedShadows = (page: Page) =>
  controlsCell(page).evaluate(
    (el) =>
      (getComputedStyle(el).boxShadow.match(/rgba?\([^)]*\)/g) ?? []).filter(
        (colour) => !/,\s*0\)$/.test(colour)
      ).length
  );

/** The visible right edge of the table, which is where a pinned column ends — not the window's */
const scrollportRight = (page: Page) =>
  page.evaluate(() => {
    const scroller = document.querySelector("table")!.parentElement!;
    return scroller.getBoundingClientRect().right;
  });

test.beforeEach(async () => {
  await seed();
});

test("every control of a fleet row is on the screen at 1440x900", async ({ page }) => {
  await page.setViewportSize(LAPTOP);
  const row = await openFleet(page);
  const edge = await scrollportRight(page);

  // Named one by one rather than by a container: the cell they moved into is the change, so a
  // locator scoped to it would pass by describing the fix back to itself. Bounded by the
  // scrollport rather than the viewport — the table's visible area ends ~18px short of the
  // window, and a control overflowing into that strip is off the screen just the same.
  for (const name of ["On", "Lock", "Pause", "Resume", "Stop"]) {
    const control = row.getByRole("button", { name, exact: true });
    const box = await control.boundingBox();
    expect(box, `${name} has no box`).not.toBeNull();
    expect(box!.x, `${name} starts past the left edge`).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `${name} ends past the right edge of the table`).toBeLessThanOrEqual(
      edge
    );
  }
});

test("the pinned column says the table continues, and stops saying it at the end", async ({
  page,
}) => {
  await page.setViewportSize(LAPTOP);
  await openFleet(page);

  await expect(controlsCell(page)).toHaveCSS("position", "sticky");
  // Polled, not snapshotted: the shadow arrives with the measurement the ref callback commits
  await expect.poll(() => paintedShadows(page)).toBe(2);
  // The fade belongs to the unpinned case only — drawn here it would wash out the very controls
  // the pinned column exists to show
  await expect
    .poll(() => page.evaluate(() => {
      const scroller = document.querySelector("table")!.parentElement as HTMLElement;
      return getComputedStyle(scroller).maskImage;
    }))
    .toBe("none");

  // Scrolled to the end there is nothing left underneath, and an edge shadow would be a lie. The
  // inset rule drawing the column's own left edge stays, so this is narrowed to the outer one.
  await page.evaluate(() => {
    const scroller = document.querySelector("table")!.parentElement!;
    scroller.scrollLeft = scroller.scrollWidth;
  });
  await expect.poll(() => paintedShadows(page)).toBe(1);
});

test("at phone width nothing is pinned and the scroller fades its own edge instead", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await openFleet(page);

  await expect(controlsCell(page)).toHaveCSS("position", "static");
  const mask = await page.evaluate(() => {
    const scroller = document.querySelector("table")!.parentElement as HTMLElement;
    return getComputedStyle(scroller).maskImage;
  });
  expect(mask, "no fade on a table that plainly overflows").toContain("gradient");
});
