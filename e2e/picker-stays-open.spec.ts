import { test, expect, type Locator, type Page } from "@playwright/test";
import { PROJECT_KEY, SIBLING_TASK_NUMBER, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-532. A Combobox closed itself on the same click that opened it.
 *
 * The panel is fixed to the viewport, so anything that moves the trigger has to close it. But a
 * scroll *event* is delivered at the next rendering opportunity rather than when the scrolling
 * happened, so a scroll already applied before the panel opened still arrived at the listener the
 * open had just attached. The panel opened and closed within one tick and the listbox was never
 * usable.
 *
 * In the wild that is the browser scrolling a half-hidden trigger into view as it takes focus on
 * mousedown — which is why it only showed near the bottom edge of a scrolling page, and why it read
 * as flaky: whether the event lands before or after the click handler is a race, and both orders
 * were observed on the same page. These tests scroll and click in one task, so the losing order is
 * the only one.
 *
 * Both halves are asserted, because a picker that simply never closed would satisfy the first one
 * alone: the panel survives the scroll that opened it, and still closes for a later one.
 */

const taskUrl = `/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;
const PICKER = "Priority";

test.beforeEach(seed);

async function openTask(page: Page) {
  await signIn(page);
  await page.goto(taskUrl);
  await expect(page.getByRole("combobox", { name: PICKER })).toBeVisible();
}

const listbox = (page: Page) => page.getByRole("listbox", { name: PICKER });

/** Counts scroll events the way the listener under test sees them: capture phase, any container. */
async function countScrolls(page: Page) {
  await page.evaluate(() => {
    const w = window as Window & { __scrolls?: number };
    w.__scrolls = 0;
    window.addEventListener("scroll", () => (w.__scrolls = (w.__scrolls ?? 0) + 1), true);
  });
}

const scrollWasDelivered = (page: Page) =>
  page.waitForFunction(() => ((window as Window & { __scrolls?: number }).__scrolls ?? 0) > 0);

/** The trigger's own scroll container, or the document when it has none. */
const scrollerOf = (trigger: Locator) =>
  trigger.evaluateHandle((el) => {
    let node: HTMLElement | null = el.parentElement;
    while (node) {
      const scrolls = /(auto|scroll)/.test(getComputedStyle(node).overflowY);
      if (scrolls && node.scrollHeight > node.clientHeight) return node;
      node = node.parentElement;
    }
    return document.scrollingElement as HTMLElement;
  });

/**
 * Scrolls the trigger's container and clicks it in the same task, so the scroll event is queued
 * before the panel exists and delivered after it does. Reports what actually happened: a scroll
 * that moved nothing — or moved the container without moving the trigger — would leave the test
 * asserting something much weaker than it claims.
 */
const clickAfterScrollingInTheSameTask = (trigger: Locator) =>
  trigger.evaluate((el) => {
    let node: HTMLElement | null = el.parentElement;
    while (node) {
      const scrolls = /(auto|scroll)/.test(getComputedStyle(node).overflowY);
      if (scrolls && node.scrollHeight > node.clientHeight) break;
      node = node.parentElement;
    }
    const scroller = node ?? (document.scrollingElement as HTMLElement);
    const wasAt = scroller.scrollTop;
    const triggerWasAt = el.getBoundingClientRect().top;
    scroller.scrollTop = wasAt + 12;
    const scrolled = scroller.scrollTop !== wasAt;
    const triggerMoved = el.getBoundingClientRect().top !== triggerWasAt;
    (el as HTMLElement).click();
    return { scrolled, triggerMoved };
  });

test("a scroll already applied when the picker opens does not close it again", async ({ page }) => {
  await openTask(page);
  await countScrolls(page);

  const trigger = page.getByRole("combobox", { name: PICKER });
  const { scrolled, triggerMoved } = await clickAfterScrollingInTheSameTask(trigger);
  expect(scrolled, "the container did not scroll, so this test proves nothing").toBe(true);
  expect(
    triggerMoved,
    "the trigger did not move, so this covers an unrelated scroll rather than the reported one"
  ).toBe(true);

  // The event, not a stopwatch. The bug is that this listener *receives* it, so a test that only
  // waited a while would go green the day delivery changed, over a reintroduced bug
  await scrollWasDelivered(page);
  await expect(listbox(page)).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
});

test("a scroll that moves the trigger while the picker is open still closes it", async ({ page }) => {
  await openTask(page);

  const trigger = page.getByRole("combobox", { name: PICKER });
  await trigger.click();
  await expect(listbox(page)).toBeVisible();

  const before = await trigger.evaluate((el) => el.getBoundingClientRect().top);
  const scroller = await scrollerOf(trigger);
  const scrolled = await scroller.evaluate((el) => {
    const wasAt = el.scrollTop;
    el.scrollTop = wasAt + 40;
    return el.scrollTop !== wasAt;
  });
  expect(scrolled, "the container did not scroll, so this test proves nothing").toBe(true);
  const after = await trigger.evaluate((el) => el.getBoundingClientRect().top);
  expect(after, "the trigger has to have moved for this to be the case it covers").not.toBe(before);

  await expect(listbox(page)).toBeHidden();
});

test("a scroll that closes the picker hands focus back rather than dropping it on the body", async ({
  page,
}) => {
  // Short, so the rail the picker sits in scrolls clear off the top: on a full-height viewport
  // this page has barely 30px of scroll and the trigger never leaves the screen
  await page.setViewportSize({ width: 1280, height: 400 });
  await openTask(page);

  const trigger = page.getByRole("combobox", { name: PICKER });
  await trigger.click();
  await expect(listbox(page)).toBeFocused();

  const scroller = await scrollerOf(trigger);
  const parked = await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  expect(parked, "nothing scrolled, so the picker had no reason to close").toBeGreaterThan(0);
  expect(
    await trigger.evaluate((el) => el.getBoundingClientRect().bottom),
    "the trigger is still on screen, so focusing it would need no scroll either way"
  ).toBeLessThan(0);
  await expect(listbox(page)).toBeHidden();

  await expect(trigger).toBeFocused();
  // Handing focus back must not undo the scroll that caused it: focusing an off-screen trigger
  // without `preventScroll` drags the page back against the gesture
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(parked);
});

test("the listbox takes focus on the first open, so the keyboard reaches it straight away", async ({
  page,
}) => {
  await openTask(page);

  await page.getByRole("combobox", { name: PICKER }).click();
  const options = listbox(page);
  await expect(options).toBeVisible();

  // The listbox itself, not the panel around it: that wrapper carries no role and no name, so a
  // reader would be told nothing about what had just taken focus
  await expect(options).toBeFocused();

  const highlighted = async () => {
    const id = await options.getAttribute("aria-activedescendant");
    expect(id, "nothing is highlighted, so the arrows have nothing to move").toBeTruthy();
    return Number(id!.split("-").pop());
  };
  const first = await highlighted();
  // The highlight starts on the selected option and wraps, so the next one is only `first + 1`
  // while that is not the last: computed rather than assumed, or reseeding the task's priority
  // would turn this red for a reason that has nothing to do with the keyboard
  const count = await options.getByRole("option").count();
  expect(count, "one option, so the next one and this one are the same").toBeGreaterThan(1);

  await page.keyboard.press("ArrowDown");
  await expect
    .poll(highlighted, { message: "ArrowDown did not move the highlight to the next option" })
    .toBe((first + 1) % count);
});

test("clicking the panel itself keeps focus inside it", async ({ page }) => {
  await openTask(page);

  await page.getByRole("combobox", { name: PICKER }).click();
  const options = listbox(page);
  await expect(options).toBeFocused();
  const panel = options.locator("xpath=..");

  // The panel's right edge, which is the strip belonging to the wrapper rather than to the search
  // box or the listbox — measured, because the listbox covers the top border entirely. Focus
  // landing on the body here takes the arrow keys with it: they scroll the page, and that scroll
  // is what then dismisses the picker the person was aiming at
  const box = (await panel.boundingBox())!;
  const edge = { x: box.x + box.width - 0.5, y: box.y + box.height / 2 };
  expect(
    await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.className.includes("z-50"),
      [edge.x, edge.y]
    ),
    "that point is not the panel wrapper, so this covers something else"
  ).toBe(true);
  await page.mouse.click(edge.x, edge.y);

  expect(
    await page.evaluate(() => document.activeElement?.tagName),
    "focus fell through to the document"
  ).not.toBe("BODY");
  await expect(options).toBeVisible();

  const before = await options.getAttribute("aria-activedescendant");
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(() => options.getAttribute("aria-activedescendant"), {
      message: "the arrows no longer reach the panel",
    })
    .not.toBe(before);
});
