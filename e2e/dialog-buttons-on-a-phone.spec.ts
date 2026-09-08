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

// The panel is sized from the position it is anchored at, so raising the launcher without
// resizing it pushed its header — and its only close control — off the top of the screen
test("the PM panel opens fully on screen above a pinned bar", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
  await expect(launcher(page)).toBeVisible();

  // With a draft in it the bar grows from 75px to about 160px, which is the state the panel's own
  // raised position is for: at the lower anchor it clears an empty bar and not a full one
  const draft = page.getByLabel("Add a comment");
  await draft.fill("A comment long enough to grow the bar\n".repeat(5));
  await expect
    .poll(async () => (await draft.boundingBox())?.height ?? 0)
    .toBeGreaterThan(60);

  await launcher(page).click();
  const close = page.getByRole("button", { name: "Close PM chat" }).first();
  await expect(close).toBeVisible();

  // What the panel's own raised position is for: the launcher is painted after it at the same z,
  // so at the lower anchor it sits on Send — a tap meant for it closed the chat and took the
  // message with it
  await page.getByPlaceholder(/Message the PM/).fill("A message worth not losing");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeVisible();
  const sendKeepsItself = await send.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const owns = (x: number, y: number) => {
      const at = document.elementFromPoint(x, y);
      return at === el || el.contains(at);
    };
    // The launcher comes up from below, so its bite is the bottom edge — a raise that is merely
    // too small leaves the centre alone and takes that
    return {
      centre: owns(r.left + r.width / 2, r.top + r.height / 2),
      bottomEdge: owns(r.left + r.width / 2, r.bottom - 3),
      bottomRight: owns(r.right - 3, r.bottom - 3),
    };
  });
  expect(sendKeepsItself).toEqual({ centre: true, bottomEdge: true, bottomRight: true });

  const fits = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="pm-chat-panel"]')!;
    const closeEl = document.querySelector('[aria-label="Close PM chat"]')!;
    const p = panel.getBoundingClientRect();
    const c = closeEl.getBoundingClientRect();
    const at = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
    const box = document.querySelector('[aria-label="Add a comment"]')!;
    const t = box.getBoundingClientRect();
    // Its top edge, not its centre: the centre sits below where either anchor reaches, so a
    // raise that stopped protecting the draft would not move it
    const overTheBox = document.elementFromPoint(t.left + t.width / 2, t.top + 4);
    return {
      panelTop: Math.round(p.top),
      closeTop: Math.round(c.top),
      closeOwnsItsCentre: at === closeEl || closeEl.contains(at),
      // What the raise is for: at the lower anchor the panel comes down over the draft somebody
      // is in the middle of typing. It touches the grown bar's top edge either way — that part is
      // cosmetic — but the text they are writing has to stay theirs.
      draftKeepsItsTop: overTheBox === box || box.contains(overTheBox),
    };
  });

  // The claim the fixed 96px rests on: the Post button stays pinned to the bar's bottom, so a
  // grown bar does not bring it up into the launcher
  const postClearOfTheLauncher = await page.evaluate(() => {
    const post = document.querySelector('[aria-label="Post comment"]')!.getBoundingClientRect();
    const fab = document.querySelector('[aria-label="Close PM chat"]')!.getBoundingClientRect();
    return post.top >= fab.bottom;
  });
  expect(postClearOfTheLauncher).toBe(true);

  expect(fits.panelTop).toBeGreaterThanOrEqual(0);
  expect(fits.closeTop).toBeGreaterThanOrEqual(0);
  expect(fits.closeOwnsItsCentre).toBe(true);
  expect(fits.draftKeepsItsTop).toBe(true);
});

// The control for the scope: at desktop width the bar is `lg:hidden` — in the DOM but not on
// screen — so nothing is actually pinned and the launcher must stay where it always is
test("a task page at desktop width does not raise the launcher", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
  await expect(page.getByRole("button", { name: /^Delete task$/ }).or(page.getByRole("button", { name: "More actions" })).first()).toBeVisible();
  await expect(launcher(page)).toBeVisible();

  const state = await page.evaluate(() => ({
    bottom: getComputedStyle(document.querySelector('[aria-label="Open PM chat"]')!).bottom,
    barIsInTheDom: !!document.querySelector("[data-pinned-phone-bar]"),
    barIsOnScreen:
      document.querySelector("[data-pinned-phone-bar]")?.getBoundingClientRect().height !== 0,
  }));

  expect(state.barIsInTheDom).toBe(true);
  expect(state.barIsOnScreen).toBe(false);
  expect(state.bottom).toBe("24px");
});

/**
 * BP-590. The toast is the third thing that lands in a bottom sheet's action row, and unlike the
 * launcher it cannot be painted below the sheet: behind the scrim it would be unreadable, and a
 * toast is often the only thing on screen saying why an action failed. So it moves to the top
 * instead — including a toast already up when the sheet opens under it, which is this flow.
 */
test("a toast still on screen clears the sheet it opens under", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await signIn(page);

  await page.route(/\/api\/projects\/[^/]+\/tasks\/[^/?]+$/, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"nope"}' });
  });

  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
  await expect(launcher(page)).toBeVisible();

  // A toast lives three seconds on a real timer, and reopening the sheet is a menu, a popover and
  // an option click. `install` alone leaves the clock running; the pair is what stops it, so a
  // loaded machine cannot turn "it expired" into "the fix regressed".
  await page.clock.install();
  await page.clock.pauseAt(Date.now());

  await test.step("a refused delete raises the toast", async () => {
    await openDeleteConfirm(page);
    await page.getByRole("dialog").getByRole("button", { name: /^Delete$/ }).click();
    await expect(page.getByTestId("toast").first()).toBeVisible();
  });

  await openDeleteConfirm(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  const toast = page.getByTestId("toast").first();
  await expect(toast).toBeVisible();

  const overlapsTheActionRow = await toast.evaluate((el) => {
    const t = el.getBoundingClientRect();
    const lowest = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button'))
      .map((b) => b.getBoundingClientRect())
      .reduce((low, r) => (r.bottom > low.bottom ? r : low));
    return t.bottom > lowest.top && t.top < lowest.bottom;
  });
  expect(overlapsTheActionRow, "the toast is off the sheet's lowest button").toBe(false);

  // Not "is the toast on top at its own centre" — it is `z-50` and last in the DOM, so it wins
  // that point wherever it sits, including on top of the button. This asks the opposite: whether
  // the button's own corner is still the button's.
  expect(await coversItsOwnCorner(page, /^Delete$/)).toBe(true);

  // …and the toast is still readable rather than greyed out under the scrim, which is the half a
  // z-index fix would have traded away. The scrim is `z-50` too, so the number proves nothing —
  // what decides between equals is that the tray is painted after the page, and this reads that.
  const scrimIsBehind = await toast.evaluate((el) => {
    const scrim = document.querySelector('[role="dialog"]')!.parentElement!;
    return !!(scrim.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(scrimIsBehind, "the tray is painted after the scrim, so it is the readable one").toBe(true);
});

/**
 * BP-596. The third thing that lands on that same Post button, and the one layering cannot settle
 * either: a toast is raised *by* a failed post, so it appears exactly when the reader is about to
 * press the button again. Dropping it below the bar would hide the only explanation on screen, so
 * it steps over the bar the way the launcher does — and over the launcher, which has stepped up by
 * then as well.
 */
test("a failed post's toast keeps off the Post button and the launcher", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await signIn(page);

  await page.route(/\/api\/projects\/[^/]+\/tasks\/[^/]+\/comments$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"nope"}' });
  });

  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
  const post = page.getByRole("button", { name: "Post comment" });
  await expect(post).toBeVisible();
  await expect(launcher(page)).toBeVisible();

  // The toast's own three seconds must not run out while the geometry is read
  await page.clock.install();
  await page.clock.pauseAt(Date.now());

  await page.getByLabel("Add a comment").fill("this will not go through");
  await post.click();
  await expect(page.getByTestId("toast").first()).toBeVisible();

  const geometry = await page.evaluate(() => {
    const toast = document.querySelector('[data-testid="toast-tray"]')!.getBoundingClientRect();
    const owns = (selector: string) => {
      const el = document.querySelector(selector)!;
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return at === el || el.contains(at);
    };
    const overlaps = (selector: string) => {
      const r = document.querySelector(selector)!.getBoundingClientRect();
      return toast.bottom > r.top && toast.top < r.bottom;
    };
    return {
      postOwnsItsCentre: owns('[aria-label="Post comment"]'),
      launcherOwnsItsCentre: owns('[aria-label="Open PM chat"]'),
      overlapsTheBar: overlaps("[data-pinned-phone-bar]"),
      overlapsTheLauncher: overlaps('[aria-label="Open PM chat"]'),
      // The point of stepping rather than dropping a layer: it is still on screen to be read
      toastOnScreen: toast.top >= 0 && toast.bottom <= window.innerHeight,
    };
  });

  expect(geometry.overlapsTheBar, "the toast is clear of the pinned bar").toBe(false);
  expect(geometry.overlapsTheLauncher, "and of the launcher, which stepped up too").toBe(false);
  expect(geometry.postOwnsItsCentre, "so a second tap reaches Post, not the toast").toBe(true);
  expect(geometry.launcherOwnsItsCentre).toBe(true);
  expect(geometry.toastOnScreen).toBe(true);
});
