import { test, expect, type Page } from "@playwright/test";
import { PROJECT_KEY, PROJECT_NAME, seed } from "./seed";
import { signIn as arriveSignedIn } from "./session";

/**
 * BP-492. The board's toolbar controls disagreed on height, and two of them changed height at a
 * breakpoint the others did not have — `Button`'s `sm` size carries `min-h-11 sm:min-h-[36px]`.
 * So the row grew and shrank as the window resized, which is what a person actually sees.
 *
 * Heights are the one thing here the server cannot answer, so they are measured in the browser.
 */

test.beforeEach(seed);

const signIn = arriveSignedIn;

/** Every control in the board's two header rows, by the name a person would use for it. */
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

  // Without this, a renamed control would drop out of the map and `every` would agree
  // with itself over an empty list. Six controls, all found.
  expect(Object.entries(onPhone).filter(([, h]) => h === null)).toEqual([]);
  expect(Object.keys(onPhone)).toHaveLength(6);

  const phoneHeights = [...new Set(Object.values(onPhone))];
  expect(phoneHeights, `phone heights: ${JSON.stringify(onPhone)}`).toHaveLength(1);

  await page.setViewportSize(DESKTOP);
  // The row re-lays out on resize; the search input only exists at this width, which is the
  // control that proves the viewport change actually reached the page
  await expect(page.getByPlaceholder(/^Search tasks/)).toBeVisible();

  const onDesktop = await controlHeights(page);
  expect(Object.entries(onDesktop).filter(([, h]) => h === null)).toEqual([]);

  const desktopHeights = [...new Set(Object.values(onDesktop))];
  expect(desktopHeights, `desktop heights: ${JSON.stringify(onDesktop)}`).toHaveLength(1);

  // The complaint was that the row's height changed with the window, so this is the assertion
  // that matters: the one height on a phone is the one height on a desktop.
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
