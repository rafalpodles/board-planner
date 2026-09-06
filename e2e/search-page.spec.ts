import { test, expect, type Page } from "@playwright/test";
import {
  DECOY_TASK_TITLE,
  SIBLING_TASK_TITLE,
  PROJECT_KEY,
  PROJECT_NAME,
  seed,
} from "./seed";
import { signIn as arriveSignedIn } from "./session";

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

  await expect(page.getByText(DECOY_TASK_TITLE)).toHaveCount(0);

  const answered = page.waitForResponse(
    (r) => r.url().includes("/api/search?q=") && r.status() === 200,
  );
  await box.pressSequentially("review", { delay: 40 });
  await answered;

  await expect(page.getByText(DECOY_TASK_TITLE)).toBeVisible();
  await expect(box).toHaveValue("review");
});

test("the address follows the box, and a shared link still searches", async ({ page }) => {
  await signIn(page);
  await page.goto("/search");

  await searchBox(page).pressSequentially("review", { delay: 40 });
  await expect(page).toHaveURL(/\/search\?q=review$/);

  await page.goto("/search?q=review");
  await expect(searchBox(page)).toHaveValue("review");
  await expect(page.getByText(DECOY_TASK_TITLE)).toBeVisible();
});

test("a project is a result too, as it is in the palette", async ({ page }) => {
  await signIn(page);
  await page.goto("/search");

  await searchBox(page).pressSequentially(PROJECT_KEY, { delay: 40 });

  const results = page.locator("#main-content");
  await expect(results.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(results.getByRole("link", { name: new RegExp(PROJECT_NAME) })).toBeVisible();
});

test("a late answer for an earlier query cannot overwrite a newer one", async ({ page }) => {
  await signIn(page);

  const STALE = "already";
  const CURRENT = "free to";

  await page.route("**/api/search?q=*", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    if (q === STALE) await new Promise((r) => setTimeout(r, 3000));
    await route.continue();
  });

  await page.goto("/search");
  const box = searchBox(page);

  await box.fill(STALE);
  await page.waitForTimeout(700);

  await box.fill(CURRENT);
  await expect(page.getByText(SIBLING_TASK_TITLE)).toBeVisible();
  await expect(page.getByText(DECOY_TASK_TITLE)).toHaveCount(0);

  await page.waitForTimeout(3500);
  await expect(page.getByText(SIBLING_TASK_TITLE)).toBeVisible();
  await expect(page.getByText(DECOY_TASK_TITLE)).toHaveCount(0);
});

test("on a phone the drawer's Search is the same page the magnifier opens", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);

  await page.getByRole("button", { name: "Open navigation" }).click();

  const drawer = page.getByRole("dialog", { name: "Navigation" });
  const searchRow = drawer.getByRole("link", { name: "Search" });
  await expect(searchRow).toHaveAttribute("href", "/search");

  await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0);

  await searchRow.click();
  await expect(page).toHaveURL(/\/search$/);
  await expect(page.getByRole("heading", { name: "Search", level: 1 })).toBeVisible();
  await expect(searchBox(page)).toBeVisible();
});

test("with a keyboard, Search still opens the palette", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);

  const row = page.getByRole("button", { name: "Search" });
  await expect(row).toBeVisible();
  await row.click();

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
  await expect(page.getByRole("dialog")).toBeVisible();
});
