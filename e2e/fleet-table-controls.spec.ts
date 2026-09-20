import { test, expect, type Page } from "@playwright/test";
import { WORKER_NAME, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-642. The admin fleet table carries twelve columns' worth of information and the settings
 * shell gives it 882px on a 1440-wide laptop. Enabled, Lock and the three command buttons used to
 * be the part that fell off the right edge — with scrollbars hidden app-wide (BP-224) there was
 * nothing on the screen to say they existed at all, and Lock is what the docs tell an operator to
 * reach for when a machine is misbehaving.
 *
 * Two things are pinned here, and they are different claims. That the controls are **within the
 * viewport** is the fix; that the table **says it continues** is what keeps the columns now
 * sitting under the pinned one from disappearing as silently as the controls did. The second is
 * asserted at phone width too, where nothing is pinned at all and the fade is the only sign.
 */
const LAPTOP = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };

async function openFleet(page: Page) {
  await signIn(page);
  await page.goto("/settings/workers");
  await expect(page.getByRole("heading", { name: "Worker fleet" })).toBeVisible();
  return page.getByRole("row").filter({ hasText: WORKER_NAME }).first();
}

test.beforeEach(async () => {
  await seed();
});

test("every control of a fleet row is on the screen at 1440x900", async ({ page }) => {
  await page.setViewportSize(LAPTOP);
  const row = await openFleet(page);

  // Named one by one rather than by a container: the cell they moved into is the change, so a
  // locator scoped to it would pass by describing the fix back to itself
  for (const name of ["On", "Lock", "Pause", "Resume", "Stop"]) {
    const control = row.getByRole("button", { name, exact: true });
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box, `${name} has no box`).not.toBeNull();
    expect(box!.x, `${name} starts past the right edge`).toBeGreaterThanOrEqual(0);
    expect(
      box!.x + box!.width,
      `${name} ends past the right edge of a ${LAPTOP.width}px viewport`
    ).toBeLessThanOrEqual(LAPTOP.width);
  }
});

test("the pinned column says the table continues, and stops saying it at the end", async ({
  page,
}) => {
  await page.setViewportSize(LAPTOP);
  await openFleet(page);
  const controls = page.locator("tbody td").filter({ hasText: "Resume" }).first();

  await expect(controls).toHaveCSS("position", "sticky");
  const atRest = await controls.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(atRest, "no shadow while columns lie under the pinned one").not.toBe("none");

  // Scrolled to the end there is nothing left underneath, and a shadow would be a lie
  await page.evaluate(() => {
    const scroller = document.querySelector("table")!.parentElement!;
    scroller.scrollLeft = scroller.scrollWidth;
  });
  await expect
    .poll(() => controls.evaluate((el) => getComputedStyle(el).boxShadow))
    .toBe("none");
});

test("at phone width nothing is pinned and the fade carries the signal instead", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  const row = await openFleet(page);

  // The control: the row is there and readable, rather than a strip of pinned buttons
  await expect(row.getByText(WORKER_NAME)).toBeVisible();
  const controls = page.locator("tbody td").filter({ hasText: "Resume" }).first();
  await expect(controls).toHaveCSS("position", "static");
  await expect(page.getByTestId("fleet-overflow-fade")).toBeVisible();
});
