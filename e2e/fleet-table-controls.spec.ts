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
// 542px of scrollport: past `lg`, and the width at which pinning a 232px column would take
// two fifths of the table. The threshold is a measurement, so this is where it has to be read.
const NARROW_DESKTOP = { width: 1100, height: 900 };
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
        // The four-argument form with a zero alpha, not "ends in 0)": an opaque colour whose
        // last channel happens to be zero is a shadow, and `--color-border` could become one
        (colour) => !/^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*0\s*\)$/.test(colour)
      ).length
  );

/** The alpha of the outer edge shade, which is what has to be visible against the row behind it */
const edgeShadowAlpha = (page: Page) =>
  controlsCell(page).evaluate((el) => {
    const outer = (getComputedStyle(el).boxShadow.match(/rgba?\([^)]*\)/g) ?? []).filter(
      (colour) => /^rgba\(/.test(colour) && !/,\s*0\s*\)$/.test(colour)
    );
    const alpha = outer[0]?.match(/,\s*([\d.]+)\s*\)$/)?.[1];
    return alpha ? Number(alpha) : 0;
  });

const maskOf = (page: Page) =>
  page.evaluate(() => {
    const scroller = document.querySelector("table")!.parentElement as HTMLElement;
    return getComputedStyle(scroller).maskImage;
  });

const setTheme = (page: Page, theme: "dark" | "light") =>
  page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);

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
  await expect.poll(() => maskOf(page)).toBe("none");

  // Scrolled to the end there is nothing left underneath, and an edge shadow would be a lie. The
  // inset rule drawing the column's own left edge stays, so this is narrowed to the outer one.
  await page.evaluate(() => {
    const scroller = document.querySelector("table")!.parentElement!;
    scroller.scrollLeft = scroller.scrollWidth;
  });
  await expect.poll(() => paintedShadows(page)).toBe(1);
});

/**
 * What the pinned column is worth is what a reader can see of it, and the value that decides that
 * is a per-theme token — so both themes are read, and the alpha is held above a floor. A token of
 * `rgba(0,0,0,0.01)` counts as a shadow and is the very defect the token was introduced for.
 */
test("the edge is visible in both themes, and focus does not park underneath it", async ({
  page,
}) => {
  await page.setViewportSize(LAPTOP);
  await openFleet(page);

  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    await expect.poll(() => paintedShadows(page), { message: theme }).toBe(2);
    expect(await edgeShadowAlpha(page), `${theme} edge is too faint to read`).toBeGreaterThan(0.2);
  }

  // Tabbing to a control off to the right scrolls it to the edge of the scrollport, which is
  // under the pinned column unless the scroller reserves its width
  const padding = await page.evaluate(() => {
    const scroller = document.querySelector("table")!.parentElement as HTMLElement;
    return parseFloat(getComputedStyle(scroller).scrollPaddingRight);
  });
  expect(padding, "no room reserved for the pinned column").toBeGreaterThan(200);
});

test("at phone width nothing is pinned and the scroller fades its own edge instead", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await openFleet(page);

  await expect(controlsCell(page)).toHaveCSS("position", "static");
  expect(await maskOf(page), "no fade on a table that plainly overflows").toContain("gradient");

  // And it stops at the end, for the same reason the pinned column's shadow does
  await page.evaluate(() => {
    const scroller = document.querySelector("table")!.parentElement!;
    scroller.scrollLeft = scroller.scrollWidth;
  });
  await expect.poll(() => maskOf(page)).toBe("none");
});

/**
 * The threshold is a measured scrollport, so it is readable only by standing either side of it.
 * Above `lg` and still unpinned: at 1100 the settings shell leaves 542px, and a 232px column
 * would be two fifths of the table. Without this the constant could be anything from 358 to 882
 * and every other test would stay green.
 */
test("a desktop too narrow for the table beside it pins nothing", async ({ page }) => {
  await page.setViewportSize(NARROW_DESKTOP);
  await openFleet(page);

  await expect(controlsCell(page)).toHaveCSS("position", "static");
  expect(await maskOf(page)).toContain("gradient");
});
