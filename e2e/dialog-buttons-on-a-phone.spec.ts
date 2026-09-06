import { test, expect, type Page } from "@playwright/test";
import { PROJECT_KEY, SIBLING_TASK_NUMBER, seed } from "./seed";
import { signIn as arriveSignedIn } from "./session";

/**
 * BP-589. At phone width a dialog is a bottom sheet, and its action row lands where the shell
 * paints the PM launcher: on a right-aligned footer the launcher covered the primary button's own
 * right-hand corner, so a finger there opened the PM chat instead of pressing the button.
 *
 * Driven with a real `click()` rather than a dispatched event: a dispatched one is delivered to
 * the element whatever is painted over it, which is precisely the defect this covers.
 */

const PHONE = { width: 390, height: 844 };

test.beforeEach(seed);

const signIn = arriveSignedIn;

const launcher = (page: Page) => page.getByRole("button", { name: /PM chat$/ });

/** Below lg the property rail is gone and Delete lives in the top bar's overflow (BP-298) */
async function openDeleteConfirm(page: Page) {
  const rail = page.getByRole("button", { name: /^Delete task$/ });
  if (await rail.count()) {
    await rail.click();
    return;
  }
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("option", { name: "Delete task" }).click();
}

/** What the browser would actually deliver a tap at that point to */
async function coversItsOwnCorner(page: Page, name: RegExp) {
  return page.getByRole("dialog").getByRole("button", { name }).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.right - 3, r.top + r.height / 2);
    return at === el || el.contains(at);
  });
}

test("a dialog's own buttons keep their corners at phone width", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);

  // The launcher has to be there first, or its absence below proves nothing
  await expect(launcher(page)).toBeVisible();

  await openDeleteConfirm(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await expect(launcher(page)).toHaveCount(0);
  expect(await coversItsOwnCorner(page, /^Delete$/)).toBe(true);

  // The click a finger makes, at the point the launcher used to own
  await dialog.getByRole("button", { name: /^Cancel$/ }).click();
  await expect(dialog).toHaveCount(0);

  // And it comes back once the sheet is gone
  await expect(launcher(page)).toBeVisible();
});

test("the primary button takes a real click rather than the launcher", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
  await expect(launcher(page)).toBeVisible();

  await openDeleteConfirm(page);
  const confirm = page.getByRole("dialog").getByRole("button", { name: /^Delete$/ });

  // position aims at the corner the launcher used to cover, not the safe centre
  const box = await confirm.boundingBox();
  await confirm.click({ position: { x: (box?.width ?? 10) - 4, y: (box?.height ?? 10) / 2 } });

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
});

// The control: on a wide screen nothing is layered over anything, and the launcher stays put
test("a desktop dialog leaves the launcher where it was", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
  await expect(launcher(page)).toBeVisible();

  await openDeleteConfirm(page);
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await coversItsOwnCorner(page, /^Delete$/)).toBe(true);
});
