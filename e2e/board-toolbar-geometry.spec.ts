import { test, expect, type Page } from "@playwright/test";
import { PROJECT_KEY, PROJECT_NAME, seed } from "./seed";
import { signIn as arriveSignedIn } from "./session";

test.beforeEach(seed);

const signIn = arriveSignedIn;

async function controlHeights(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null | undefined) =>
      el ? Math.round(el.getBoundingClientRect().height) : null;
    const labelled = (label: string) => document.querySelector(`[aria-label="${label}"]`);
    const named = (text: string) =>
      [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

    return {
      filters: box(named("Filters")),
      sort: box(document.querySelector('select[aria-label="Sort tasks by"]')?.closest("div")),
      select: box(named("Select")),
      viewToggle: box(named("Board")?.parentElement),
      refresh: box(labelled("Refresh board")),
      newTask: box(labelled("New task")),
    };
  });
}

const PHONE = { width: 390, height: 780 };
const DESKTOP = { width: 1280, height: 900 };

test("every board toolbar control is the same height, at any width", async ({ page }) => {
  await signIn(page);
  await page.setViewportSize(PHONE);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
  await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeVisible();

  const onPhone = await controlHeights(page);

  expect(Object.entries(onPhone).filter(([, h]) => h === null)).toEqual([]);
  expect(Object.keys(onPhone)).toHaveLength(6);

  const phoneHeights = [...new Set(Object.values(onPhone))];
  expect(phoneHeights, `phone heights: ${JSON.stringify(onPhone)}`).toHaveLength(1);

  await page.setViewportSize(DESKTOP);
  await expect(page.getByPlaceholder(/^Search tasks/)).toBeVisible();

  const onDesktop = await controlHeights(page);
  expect(Object.entries(onDesktop).filter(([, h]) => h === null)).toEqual([]);

  const desktopHeights = [...new Set(Object.values(onDesktop))];
  expect(desktopHeights, `desktop heights: ${JSON.stringify(onDesktop)}`).toHaveLength(1);

  expect(desktopHeights[0], `phone ${phoneHeights[0]} vs desktop ${desktopHeights[0]}`).toBe(
    phoneHeights[0],
  );
});

test("the board's text search is a desktop-only control", async ({ page }) => {
  await signIn(page);
  await page.setViewportSize(DESKTOP);
  await page.goto(`/projects/${PROJECT_KEY}`);

  const search = page.getByPlaceholder(/^Search tasks/);
  await expect(search).toBeVisible();

  await page.setViewportSize(PHONE);
  await expect(search).toBeHidden();
});
