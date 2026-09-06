import { test, expect, type Locator, type Page } from "@playwright/test";
import { PROJECT_KEY, SIBLING_TASK_NUMBER, seed } from "./seed";
import { signIn } from "./session";

const taskUrl = `/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;
const PICKER = "Priority";

test.beforeEach(seed);

async function openTask(page: Page) {
  await signIn(page);
  await page.goto(taskUrl);
  await expect(page.getByRole("combobox", { name: PICKER })).toBeVisible();
}

const listbox = (page: Page) => page.getByRole("listbox", { name: PICKER });

async function countScrolls(page: Page) {
  await page.evaluate(() => {
    const w = window as Window & { __scrolls?: number };
    w.__scrolls = 0;
    window.addEventListener("scroll", () => (w.__scrolls = (w.__scrolls ?? 0) + 1), true);
  });
}

const scrollWasDelivered = (page: Page) =>
  page.waitForFunction(() => ((window as Window & { __scrolls?: number }).__scrolls ?? 0) > 0);

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
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(parked);
});

test("the listbox takes focus on the first open, so the keyboard reaches it straight away", async ({
  page,
}) => {
  await openTask(page);

  await page.getByRole("combobox", { name: PICKER }).click();
  const options = listbox(page);
  await expect(options).toBeVisible();

  await expect(options).toBeFocused();

  const highlighted = async () => {
    const id = await options.getAttribute("aria-activedescendant");
    expect(id, "nothing is highlighted, so the arrows have nothing to move").toBeTruthy();
    return Number(id!.split("-").pop());
  };
  const first = await highlighted();
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
