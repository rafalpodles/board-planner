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

/** Whether a tap on the launcher's own square would reach the launcher */
async function whatIsOverTheLauncher(page: Page) {
  return page.getByRole("button", { name: /PM chat$/ }).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return at === el || el.contains(at) ? "the launcher" : "something else";
  });
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

  // Still mounted — it is painted a layer below, not taken away, so the chat it may be holding
  // open survives somebody else's dialog
  await expect(launcher(page)).toHaveCount(1);
  expect(await coversItsOwnCorner(page, /^Delete$/)).toBe(true);

  // The scrim owns the launcher's own square while the sheet is up
  expect(await whatIsOverTheLauncher(page)).not.toBe("the launcher");

  await dialog.getByRole("button", { name: /^Cancel$/ }).click();
  await expect(dialog).toHaveCount(0);

  // …and once the sheet is gone it takes its own clicks again
  await expect(launcher(page)).toBeVisible();
  expect(await whatIsOverTheLauncher(page)).toBe("the launcher");
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

/**
 * The control, and it has to be this one: with no dialog open the launcher is the topmost thing at
 * its own coordinates. Without it, "the launcher is not on top" above would also pass on a page
 * that never painted a launcher at all, or on a probe that reads the wrong point.
 */
test("with no dialog open the launcher owns its own square", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);

  await expect(launcher(page)).toBeVisible();
  expect(await whatIsOverTheLauncher(page)).toBe("the launcher");
});

/**
 * BP-591. The same launcher, a different collision, and one layering cannot settle: on a task at
 * phone width the comment bar is pinned to the bottom and the launcher sat on top of its Post
 * button — measured, the button's own centre belonged to the launcher, so it could not be tapped
 * at all. The bar declares the strip; the launcher steps over it.
 */
test("the comment bar's Post button keeps its own centre at phone width", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);

  const post = page.getByRole("button", { name: "Post comment" });
  await expect(post).toBeVisible();
  await expect(launcher(page)).toBeVisible();

  const geometry = await page.evaluate(() => {
    const postEl = document.querySelector('[aria-label="Post comment"]')!;
    const fabEl = document.querySelector('[aria-label="Open PM chat"]')!;
    const p = postEl.getBoundingClientRect();
    const f = fabEl.getBoundingClientRect();
    const owns = (el: Element, r: DOMRect) => {
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return at === el || el.contains(at);
    };
    return {
      overlap: Math.max(0, Math.min(p.bottom, f.bottom) - Math.max(p.top, f.top)),
      postOwnsItsCentre: owns(postEl, p),
      launcherOwnsItsCentre: owns(fabEl, f),
    };
  });

  expect(geometry.overlap).toBe(0);
  expect(geometry.postOwnsItsCentre).toBe(true);
  expect(geometry.launcherOwnsItsCentre).toBe(true);
});

// The control: with no pinned bar the launcher stays where it always was, rather than floating
// high on every screen
test("the launcher does not step up where nothing is pinned", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(launcher(page)).toBeVisible();

  const bottom = await page.evaluate(
    () => getComputedStyle(document.querySelector('[aria-label="Open PM chat"]')!).bottom
  );
  expect(bottom).toBe("24px");
});
