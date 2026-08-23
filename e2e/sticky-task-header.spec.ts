import { test, expect, type Locator, type Page } from "@playwright/test";
import { BASE_URL } from "../playwright.config";
import { ADMIN_AUTH } from "./api";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  PROJECT_ID,
  PROJECT_KEY,
  SIBLING_TASK_ID,
  SIBLING_TASK_KEY,
  SIBLING_TASK_NUMBER,
  TARGET_COLUMN,
  seed,
} from "./seed";

/**
 * BP-398. Every claim here is about where the browser puts the header while the task moves, and
 * none of it survives a unit test: JSDOM and happy-dom lay nothing out, so a header that has
 * scrolled out of sight measures exactly like one that has not.
 *
 * The regression that makes this file worth its runtime: the header used to be `sticky` inside
 * the scrolled content, which looks pinned in a screenshot taken at the bottom and is not. It
 * travelled the length of the scrollport's own top padding — 24px on the page, 5px in the modal
 * — before it engaged, took the card's border and rounded corner out of view when it did, and an
 * elastic overscroll dragged it along with the rest of the content. Hence `headerTravel` below,
 * which samples the whole range rather than trusting the end state.
 */

const TASK_URL = `${BASE_URL}/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;
const BOARD_URL = `${BASE_URL}/projects/${PROJECT_KEY}`;

const LONG_TITLE =
  "A deliberately very long task title that has to truncate with an ellipsis inside the " +
  "pinned header while staying readable in full in the body of the task";

const TALL_BODY = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i + 1}. Body text that exists only to give the header something to stay
in front of while the task scrolls.`
).join("\n\n");

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN_USERNAME);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);
}

/** A task tall enough to scroll and titled long enough to overflow the header */
async function makeTaskTall(page: Page) {
  const response = await page.request.put(
    `/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}`,
    {
      headers: ADMIN_AUTH,
      data: {
        title: LONG_TITLE,
        description: TALL_BODY,
        checklist: Array.from({ length: 25 }, (_, i) => ({
          text: `Criterion ${i + 1}`,
          done: false,
        })),
      },
    }
  );
  expect(response.status(), await response.text()).toBe(200);
}

const bar = (page: Page) => page.getByTestId("task-top-bar");
const barTitle = (page: Page) => page.getByTestId("task-top-bar-title");

// Next's own dev-error overlay is also a role=dialog, so the task's modal is the one holding
// the task, never the first match
const taskDialog = (page: Page) =>
  page.locator("div[role=dialog]").filter({ has: page.getByTestId("task-top-bar") });

/** The task scrolls in a box of its own, below the header, on both routes */
function scrollport(page: Page, inModal: boolean): Locator {
  const scope = inModal ? taskDialog(page) : page.locator("#main-content");
  return scope.getByTestId("task-scroll");
}

/** The task arrives over the network; scrolling before it lands scrolls nothing */
async function waitForTask(page: Page) {
  await expect(bar(page)).toBeVisible();
  await expect(page.getByLabel("Task title")).toHaveValue(LONG_TITLE);
}

async function scrollToBottom(port: Locator) {
  await port.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  // The reveal runs off an IntersectionObserver, which is delivered on the next frame
  await port.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  // Nothing below this point means anything if the task was too short to scroll
  expect(await port.evaluate((el) => el.scrollTop)).toBeGreaterThan(400);
}

/** Where the scroll container's visible area starts, in viewport coordinates */
async function scrollportTop(port: Locator) {
  return port.evaluate((el) => el.getBoundingClientRect().top);
}

/**
 * Every header position the task passes through, other than the one it holds at rest — so an
 * empty list is the whole claim: the header did not move. Sampling is the point. A sticky header
 * reaches the right place eventually, so a measurement taken at the bottom passes over the 24px
 * of travel it never looked at.
 *
 * What this cannot do: `scrollTop` clamps, so the past-the-end offsets pin the scroll at its
 * limit rather than reproducing an elastic overscroll — that bounce is a compositor effect no
 * script can drive. The guarantee against it is structural and asserted separately: the page
 * has nothing to scroll, and the header is not inside the box that does.
 */
async function headerTravel(page: Page, port: Locator) {
  const resting = await bar(page).evaluate((el) => el.getBoundingClientRect().top);
  const max = await port.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(max, "the task was too short to scroll, so this proves nothing").toBeGreaterThan(400);

  const moved: number[] = [];
  for (const offset of [0, 1, 3, 5, 12, 24, 25, 40, 200, max - 1, max, max + 2000]) {
    const top = await port.evaluate((el, y) => {
      el.scrollTop = y;
      const header = el.parentElement!.querySelector('[data-testid="task-top-bar"]')!;
      return header.getBoundingClientRect().top;
    }, offset);
    if (Math.abs(top - resting) > 0.5) moved.push(Math.round(top));
  }
  return moved;
}

test.beforeEach(async () => {
  await seed();
});

test("the task header stays in view once the task has scrolled past it", async ({ page }) => {
  await signIn(page);
  await makeTaskTall(page);
  await page.goto(TASK_URL);
  await waitForTask(page);

  const port = scrollport(page, false);
  await expect(port).toHaveCount(1);
  await scrollToBottom(port);

  await expect(bar(page)).toBeInViewport();
  await expect(page.getByRole("button", { name: "Close task" })).toBeInViewport();
  await expect(page.getByText(SIBLING_TASK_KEY, { exact: true })).toBeInViewport();
});

test("the header does not move at any point in the scroll, page route", async ({ page }) => {
  await signIn(page);
  await makeTaskTall(page);
  await page.goto(TASK_URL);
  await waitForTask(page);

  expect(await headerTravel(page, scrollport(page, false))).toEqual([]);
});

test("the header does not move at any point in the scroll, modal route", async ({ page }) => {
  await signIn(page);
  await makeTaskTall(page);
  await page.goto(BOARD_URL);
  await page.locator(`a[href$="/tasks/${SIBLING_TASK_NUMBER}"]`).first().click();
  await expect(taskDialog(page)).toBeVisible();
  await waitForTask(page);

  expect(await headerTravel(page, scrollport(page, true))).toEqual([]);
});

// The other half of the same claim: a header cannot be dragged by a scroll that cannot happen
test("the page itself never scrolls, so nothing can drag the header", async ({ page }) => {
  await signIn(page);
  await makeTaskTall(page);
  await page.goto(TASK_URL);
  await waitForTask(page);

  const overflow = await page
    .locator("#main-content")
    .evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow).toBe(0);
});

test("the header takes over the title only once the body's title has gone", async ({ page }) => {
  await signIn(page);
  await makeTaskTall(page);
  await page.goto(TASK_URL);
  await waitForTask(page);

  await expect(barTitle(page)).toHaveText(LONG_TITLE);
  await expect(barTitle(page)).toHaveCSS("opacity", "0");

  const port = scrollport(page, false);
  await scrollToBottom(port);

  await expect(barTitle(page)).toHaveCSS("opacity", "1");
  await expect(barTitle(page)).toHaveAttribute("aria-hidden", "false");
});

test("a long title truncates in the header and stays whole in the body", async ({ page }) => {
  await signIn(page);
  await makeTaskTall(page);
  await page.goto(TASK_URL);
  await waitForTask(page);

  const overflows = await barTitle(page).evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(overflows).toBe(true);
  await expect(barTitle(page)).toHaveCSS("text-overflow", "ellipsis");

  await expect(page.getByLabel("Task title")).toHaveValue(LONG_TITLE);
});

test("revealing the title moves nothing in the header", async ({ page }) => {
  await signIn(page);
  await makeTaskTall(page);
  await page.goto(TASK_URL);
  await waitForTask(page);

  const measure = () =>
    bar(page).evaluate((el) => {
      const title = el.querySelector('[data-testid="task-top-bar-title"]') as HTMLElement;
      return { barHeight: el.getBoundingClientRect().height, titleX: title.getBoundingClientRect().x };
    });

  const before = await measure();
  await scrollToBottom(scrollport(page, false));
  await expect(barTitle(page)).toHaveCSS("opacity", "1");

  expect(await measure()).toEqual(before);
});

test("the close button works from the bottom of a long task", async ({ page }) => {
  await signIn(page);
  await makeTaskTall(page);
  await page.goto(TASK_URL);
  await waitForTask(page);

  await scrollToBottom(scrollport(page, false));
  await page.getByRole("button", { name: "Close task" }).click();

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
});

// Pinning the bar gave it a z-index and a container-query containment context, and both are
// ways to trap a dropdown that used to escape fine
test("the status menu opens from the pinned header and paints over the task", async ({ page }) => {
  await signIn(page);
  await makeTaskTall(page);
  await page.goto(TASK_URL);
  await waitForTask(page);
  await scrollToBottom(scrollport(page, false));

  await bar(page).getByRole("combobox", { name: "Status" }).click();

  const option = page.getByRole("option", { name: TARGET_COLUMN.label });
  await expect(option).toBeVisible();
  await expect(option).toBeInViewport();

  // Visible is not the same as reachable: an ancestor could be painting over it
  const box = (await option.boundingBox())!;
  const onTop = await page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return !!el?.closest("[role=option]");
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  );
  expect(onTop).toBe(true);
});

test("the header stays pinned inside the modal the board opens", async ({ page }) => {
  await signIn(page);
  await makeTaskTall(page);
  await page.goto(BOARD_URL);
  await page.locator(`a[href$="/tasks/${SIBLING_TASK_NUMBER}"]`).first().click();

  await expect(taskDialog(page)).toBeVisible();
  await waitForTask(page);

  const port = scrollport(page, true);
  await scrollToBottom(port);

  await expect(bar(page)).toBeInViewport();
  // Flush on the box it sits above: no strip between them for the task to scroll through
  const barBottom = await bar(page).evaluate((el) => el.getBoundingClientRect().bottom);
  expect(barBottom).toBeCloseTo(await scrollportTop(port), 0);
});

test("Escape still closes the task from the bottom of the scroll", async ({ page }) => {
  await signIn(page);
  await makeTaskTall(page);
  await page.goto(BOARD_URL);
  await page.locator(`a[href$="/tasks/${SIBLING_TASK_NUMBER}"]`).first().click();
  await expect(taskDialog(page)).toBeVisible();
  await waitForTask(page);

  await scrollToBottom(scrollport(page, true));
  await page.keyboard.press("Escape");

  await expect(taskDialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
});
