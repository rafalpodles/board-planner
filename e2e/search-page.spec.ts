import { test, expect, type Page } from "@playwright/test";
import {
  DECOY_TASK_TITLE,
  HELD_TASK_TITLE,
  PROJECT_KEY,
  PROJECT_NAME,
  seed,
} from "./seed";
import { signIn as arriveSignedIn } from "./session";

/**
 * BP-494. `/search` carried a second copy of the search: it ran only on submit, and a late
 * response could overwrite a newer one. It now renders from `useSearch`, the palette's hook.
 *
 * Nothing here presses Enter — that is the point.
 */

test.beforeEach(seed);

const signIn = arriveSignedIn;

const PHONE = { width: 390, height: 780 };

function searchBox(page: Page) {
  return page.getByRole("textbox", { name: "Search tasks and projects" });
}

test("typing alone searches — no Enter, no submit", async ({ page }) => {
  await signIn(page);
  await page.goto("/search");

  const box = searchBox(page);
  await expect(box).toBeVisible();

  // The control: an empty box shows nothing, so a hit below cannot be something already on screen
  await expect(page.getByText(DECOY_TASK_TITLE)).toHaveCount(0);

  const answered = page.waitForResponse(
    (r) => r.url().includes("/api/search?q=") && r.status() === 200,
  );
  await box.pressSequentially("review", { delay: 40 });
  await answered;

  await expect(page.getByText(DECOY_TASK_TITLE)).toBeVisible();
  // Enter was never pressed, and the box still holds what was typed
  await expect(box).toHaveValue("review");
});

test("the address follows the box, and a shared link still searches", async ({ page }) => {
  await signIn(page);
  await page.goto("/search");

  await searchBox(page).pressSequentially("review", { delay: 40 });
  await expect(page).toHaveURL(/\/search\?q=review$/);

  // The same address, arrived at cold: it must search on its own
  await page.goto("/search?q=review");
  await expect(searchBox(page)).toHaveValue("review");
  await expect(page.getByText(DECOY_TASK_TITLE)).toBeVisible();
});

test("a project is a result too, as it is in the palette", async ({ page }) => {
  await signIn(page);
  await page.goto("/search");

  await searchBox(page).pressSequentially(PROJECT_KEY, { delay: 40 });

  // Scoped: the sidebar links every project too, and the claim is about the results
  const results = page.locator("#main-content");
  await expect(results.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(results.getByRole("link", { name: new RegExp(PROJECT_NAME) })).toBeVisible();
});

/**
 * The reason the page could not simply keep its own fetch: with two requests in flight, the
 * slower one used to land last and win. The route below makes that ordering certain rather
 * than hoping for it.
 */
test("a late answer for an earlier query cannot overwrite a newer one", async ({ page }) => {
  await signIn(page);

  await page.route("**/api/search?q=*", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    if (q === "he") await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });

  await page.goto("/search");
  const box = searchBox(page);

  // "he" fires and is left in flight; the debounce is 250ms, so the pause matters
  await box.pressSequentially("he", { delay: 40 });
  await page.waitForTimeout(600);
  await box.pressSequentially("ld by", { delay: 40 });

  await expect(page.getByText(HELD_TASK_TITLE)).toBeVisible();
  await expect(box).toHaveValue("held by");

  // Long enough for the stalled "he" answer to arrive and, if unguarded, replace what is shown
  await page.waitForTimeout(2500);
  await expect(page.getByText(HELD_TASK_TITLE)).toBeVisible();
  await expect(box).toHaveValue("held by");
});

test("on a phone the drawer's Search is the same page the magnifier opens", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);

  await page.getByRole("button", { name: "Open navigation" }).click();

  const drawer = page.getByRole("dialog", { name: "Navigation" });
  const searchRow = drawer.getByRole("link", { name: "Search" });
  await expect(searchRow).toHaveAttribute("href", "/search");

  await searchRow.click();
  await expect(page).toHaveURL(/\/search$/);
  // A page, not the palette laid over the board
  await expect(page.getByRole("heading", { name: "Search", level: 1 })).toBeVisible();
  await expect(searchBox(page)).toBeVisible();
});

test("with a keyboard, Search still opens the palette", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);

  // The desktop sidebar's row is a button, and it must not have become a link
  const row = page.getByRole("button", { name: "Search" });
  await expect(row).toBeVisible();
  await row.click();

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
  await expect(page.getByRole("dialog")).toBeVisible();
});
