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
  seed,
} from "./seed";

/**
 * BP-398. Every claim here is about what the browser does with `position: sticky`, and none of
 * it survives a unit test: JSDOM and happy-dom lay nothing out, so a header that has scrolled
 * out of sight measures exactly like one that has not.
 *
 * The regression that makes this file worth its runtime: a sticky `top` anchors to the scroll
 * container's *content* box, so the container's own top padding leaves a strip the task scrolls
 * through above the header — and an `overflow: hidden` ancestor makes itself the scrollport and
 * strands the header off the top of the page entirely.
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

/** The element the task actually scrolls inside — the page's <main>, or the modal's own box */
function scrollport(page: Page, inModal: boolean): Locator {
  return inModal ? page.locator("div[role=dialog] .overflow-y-auto") : page.locator("#main-content");
}

async function scrollToBottom(port: Locator) {
  await port.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  // The reveal runs off an IntersectionObserver, which is delivered on the next frame
  await port.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}

/** Where the scroll container's visible area starts, in viewport coordinates */
async function scrollportTop(port: Locator) {
  return port.evaluate((el) => el.getBoundingClientRect().top);
}

test.beforeEach(async () => {
  await seed();
});

test("the task header stays in view once the task has scrolled past it", async ({ page }) => {
  await signIn(page);
  await makeTaskTall(page);
  await page.goto(TASK_URL);
  await expect(bar(page)).toBeVisible();

  const port = scrollport(page, false);
  await expect(port).toHaveCount(1);
  await scrollToBottom(port);

  // Something actually scrolled, or the rest of this test proves nothing
  expect(await port.evaluate((el) => el.scrollTop)).toBeGreaterThan(400);

  await expect(bar(page)).toBeInViewport();
  await expect(page.getByRole("button", { name: "Close task" })).toBeInViewport();
  await expect(page.getByText(SIBLING_TASK_KEY, { exact: true })).toBeInViewport();
});

test("nothing scrolls through the gap above the pinned header", async ({ page }) => {
  await signIn(page);
  await makeTaskTall(page);
  await page.goto(TASK_URL);

  const port = scrollport(page, false);
  await scrollToBottom(port);

  // <main> carries py-6, and a sticky `top: 0` anchors to its content box — so without the
  // compensation the header sits 24px down and the task scrolls visibly through the gap
  const barTop = await bar(page).evaluate((el) => el.getBoundingClientRect().top);
  expect(barTop).toBeCloseTo(await scrollportTop(port), 0);
});

test("the header takes over the title only once the body's title has gone", async ({ page }) => {
  await signIn(page);
  await makeTaskTall(page);
  await page.goto(TASK_URL);

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

  const overflows = await barTitle(page).evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(overflows).toBe(true);
  await expect(barTitle(page)).toHaveCSS("text-overflow", "ellipsis");

  await expect(page.getByLabel("Task title")).toHaveValue(LONG_TITLE);
});

test("revealing the title moves nothing in the header", async ({ page }) => {
  await signIn(page);
  await makeTaskTall(page);
  await page.goto(TASK_URL);

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

  await scrollToBottom(scrollport(page, false));
  await page.getByRole("button", { name: "Close task" }).click();

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
});

test("the header stays pinned inside the modal the board opens", async ({ page }) => {
  await signIn(page);
  await makeTaskTall(page);
  await page.goto(BOARD_URL);
  await page.locator(`a[href$="/tasks/${SIBLING_TASK_NUMBER}"]`).first().click();

  const dialog = page.locator("div[role=dialog]");
  await expect(dialog).toBeVisible();
  await expect(bar(page)).toBeVisible();

  const port = scrollport(page, true);
  await scrollToBottom(port);
  expect(await port.evaluate((el) => el.scrollTop)).toBeGreaterThan(400);

  await expect(bar(page)).toBeInViewport();
  // The modal's scroll box pads itself by 5px for focus rings — the same gap, five pixels wide
  const barTop = await bar(page).evaluate((el) => el.getBoundingClientRect().top);
  expect(barTop).toBeCloseTo(await scrollportTop(port), 0);
});

test("Escape still closes the task from the bottom of the scroll", async ({ page }) => {
  await signIn(page);
  await makeTaskTall(page);
  await page.goto(BOARD_URL);
  await page.locator(`a[href$="/tasks/${SIBLING_TASK_NUMBER}"]`).first().click();
  await expect(page.locator("div[role=dialog]")).toBeVisible();

  await scrollToBottom(scrollport(page, true));
  await page.keyboard.press("Escape");

  await expect(page.locator("div[role=dialog]")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
});
