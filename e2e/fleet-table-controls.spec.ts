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
// 466px of scrollport, which is under the threshold: a 130px column there would be more than a
// quarter of the table. `lg` is 1024 too, and the coincidence is not the point — the threshold is
// a measurement of the scrollport, and this is the width that reads it.
const NARROW_DESKTOP = { width: 1024, height: 900 };
const PHONE = { width: 375, height: 812 };

async function openFleet(page: Page) {
  await signIn(page);
  await page.goto("/settings/workers");
  await expect(page.getByRole("heading", { name: "Worker fleet" })).toBeVisible();
  return page.getByRole("row").filter({ hasText: WORKER_NAME }).first();
}

// By test id, not by the text in it: the commands are icons and carry their words as accessible
// names rather than as content, so there is nothing in this cell to match on
const controlsCell = (page: Page) => page.getByTestId("worker-controls").first();

/**
 * How many shadows the pinned cell actually paints.
 *
 * `boxShadow` never reads "none" on a Tailwind shadow utility: the class expands to the ring and
 * shadow variables, so four fully transparent placeholders are always in the list. Counting the
 * entries with any alpha at all is what tells the column's own left edge (one, always) from the
 * edge it draws over content passing underneath (two).
 */
/**
 * The shadow entries that are actually painted, each with whatever follows its colour.
 *
 * Read in the browser by both callers below, so there is one answer to "is this shadow painted".
 * A transparent placeholder is the four-argument form with a zero alpha — not "ends in 0)", which
 * would also discard an opaque colour whose last channel happens to be zero.
 */
const paintedShadows = (page: Page) =>
  controlsCell(page).evaluate(
    (el) =>
      (getComputedStyle(el).boxShadow.match(/(rgba?\([^)]*\))([^,]*)/g) ?? []).filter(
        (entry) => !/^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*0\s*\)/.test(entry)
      ).length
  );

/**
 * The alpha of the outer edge shade — the thing that has to be visible against the row behind it.
 *
 * Chosen by the `inset` keyword, not by position and not by colour format. The column's own rule
 * is the inset one; skipping it because `--color-border` is a hex and serializes as `rgb()` would
 * hold only until that token gained an alpha, at which point this would measure the inset rule
 * under the shade's name and pass.
 */
const edgeShadowAlpha = (page: Page) =>
  controlsCell(page).evaluate((el) => {
    const shade = (getComputedStyle(el).boxShadow.match(/(rgba?\([^)]*\))([^,]*)/g) ?? []).find(
      (entry) =>
        !/^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*0\s*\)/.test(entry) &&
        !/\binset\b/.test(entry)
    );
    const alpha = shade?.match(/,\s*([\d.]+)\s*\)/)?.[1];
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
  for (const name of ["On", "Pause", "Resume", "Stop"]) {
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
 * What a pinned column is worth is what a reader can see of its edge, and the value deciding that
 * is a per-theme token.
 *
 * The floors are per theme and both sit ABOVE the value that made this a ticket: 0.35 black, which
 * reads on white and is all but invisible on `#1e293b`. A single floor of 0.2 would pass on
 * exactly that regression. They differ for the same reason the token does — alpha stands in for
 * contrast, and one number cannot mean "visible" against two backgrounds.
 *
 * The last assertion is what catches the per-theme split being deleted altogether: `:root` holds
 * the dark value, so removing the light override leaves light inheriting it, clearing every floor
 * while the themes stop differing at all.
 */
test("the pinned edge is readable in both themes", async ({ page }) => {
  await page.setViewportSize(LAPTOP);
  await openFleet(page);

  const alphas: Record<string, number> = {};
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    await expect.poll(() => paintedShadows(page), { message: theme }).toBe(2);
    alphas[theme] = await edgeShadowAlpha(page);
  }

  expect(alphas.dark, "a dark edge at or under 0.35 is the defect this token replaced").toBeGreaterThan(0.6);
  expect(alphas.light, "light edge too faint to read").toBeGreaterThan(0.25);
  expect(alphas.light, "light edge heavy enough to read as a bar").toBeLessThan(0.6);
  expect(alphas.dark, "one value for both themes is the thing the token exists to avoid").not.toBe(
    alphas.light
  );
});

/**
 * Tabbing to a control off to the right scrolls it to the edge of the scrollport, which is under
 * the pinned column unless the scroller reserves its width. Measured against the column's own box
 * rather than a number copied from `CONTROLS_WIDTH`, so the constant is checked against the layout
 * it claims to describe.
 */
test("the scroller reserves the pinned column's width", async ({ page }) => {
  await page.setViewportSize(LAPTOP);
  await openFleet(page);

  const column = await controlsCell(page).boundingBox();
  const padding = await page.evaluate(() => {
    const scroller = document.querySelector("table")!.parentElement as HTMLElement;
    return parseFloat(getComputedStyle(scroller).scrollPaddingRight);
  });
  expect(column).not.toBeNull();
  expect(padding, "less room reserved than the column takes").toBeGreaterThanOrEqual(column!.width);
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
 * At 1024 the settings shell leaves 466px, under the threshold, so nothing pins. Without this the
 * constant could be anything from 358 to 882 and every other test would stay green.
 */
test("a desktop too narrow for the table beside it pins nothing", async ({ page }) => {
  await page.setViewportSize(NARROW_DESKTOP);
  await openFleet(page);

  await expect(controlsCell(page)).toHaveCSS("position", "static");
  expect(await maskOf(page)).toContain("gradient");
});
