import { test, expect } from "@playwright/test";
import { seed } from "./seed";
import { APP_NAME } from "../src/lib/brand";

/**
 * BP-990. The app answered no robots.txt and its login page carried a generic title and the
 * description "Task management with Kanban board", so every host serving it — one per
 * organisation — was open to be listed under that.
 */

test.beforeEach(seed);

test("robots.txt, served without a session, disallows everything", async ({ request }) => {
  const response = await request.get("/robots.txt");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/plain");
  expect(await response.text()).toMatch(/User-Agent: \*\s+Disallow: \//i);
});

test("the sign-in page is named, described and asks not to be indexed", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("Password")).toBeVisible();

  await expect(page).toHaveTitle(`Sign in — ${APP_NAME}`);
  await expect(page.locator('head meta[name="description"]')).toHaveAttribute("content", /^Sign in to Board Planner/);
  await expect(page.locator('head meta[name="robots"]')).toHaveAttribute("content", /noindex/);
});

test("the browser tab and an iPhone's home screen get an icon", async ({ page, request }) => {
  await page.goto("/login");
  await expect(page.locator('head link[rel="icon"][href^="/favicon.ico"]')).toHaveCount(1);
  const touch = page.locator('head link[rel="apple-touch-icon"]');
  await expect(touch).toHaveAttribute("sizes", "180x180");

  const ico = await request.get("/favicon.ico");
  expect(ico.status()).toBe(200);
  expect(ico.headers()["content-type"]).toContain("image/");
  const apple = await request.get((await touch.getAttribute("href"))!);
  expect(apple.status()).toBe(200);
  expect(apple.headers()["content-type"]).toBe("image/png");
});
