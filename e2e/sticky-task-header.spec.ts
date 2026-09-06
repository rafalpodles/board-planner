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
import { signIn as arriveSignedIn } from "./session";

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

const signIn = arriveSignedIn;

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

const taskDialog = (page: Page) =>
  page.locator("div[role=dialog]").filter({ has: page.getByTestId("task-top-bar") });

function scrollport(page: Page, inModal: boolean): Locator {
  const scope = inModal ? taskDialog(page) : page.locator("#main-content");
  return scope.getByTestId("task-scroll");
}

async function waitForTask(page: Page) {
  await expect(bar(page)).toBeVisible();
  await expect(page.getByLabel("Task title")).toHaveValue(LONG_TITLE);
}

async function scrollToBottom(port: Locator) {
  await port.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await port.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  expect(await port.evaluate((el) => el.scrollTop)).toBeGreaterThan(400);
}

async function scrollportTop(port: Locator) {
  return port.evaluate((el) => el.getBoundingClientRect().top);
}

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
