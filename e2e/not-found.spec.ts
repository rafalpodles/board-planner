import { test, expect } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { OUTSIDER_PASSWORD, OUTSIDER_USERNAME, PROJECT_KEY, PROJECT_NAME, SIBLING_TASK_NUMBER, seed, seedAssignmentOutsider } from "./seed";
import { signIn, signInThroughForm } from "./session";

test.beforeEach(seed);

const HEADING = "This one slipped off the board.";

test("an unknown route is a real 404 in the app shell, and Projects is a working way out", async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 1340, height: 900 });
  const response = await page.goto("/not-a-route-bp262");
  expect(response?.status()).toBe(404);
  const missing = page.getByTestId("missing-page");
  await expect(missing.getByRole("heading", { name: HEADING })).toBeVisible();
  await expect(page.locator("#main-content")).toContainText(HEADING);
  // The real sidebar stays available, rather than a miniature imitation of the shell.
  await expect(page.locator("aside")).toHaveCount(1);
  await expect(page.locator("aside").getByRole("link", { name: "Projects", exact: true })).toBeVisible();
  await page.screenshot({ path: "e2e/.artifacts/BP-262-desktop.png" });
  await missing.getByRole("link", { name: "Back to projects" }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.locator("#main-content").getByRole("link", { name: PROJECT_NAME })).toBeVisible();
});

test("a mistyped project and a deleted task show the same lost-card recovery", async ({ page, request }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
  await page.goto("/projects/NOSUCHKEY");
  const missing = page.getByTestId("missing-page");
  await expect(missing.getByRole("heading", { name: HEADING })).toBeVisible();
  const message = await missing.innerText();

  expect((await request.delete(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`, { headers: ADMIN_AUTH })).status()).toBe(200);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
  await expect(missing.getByRole("heading", { name: HEADING })).toBeVisible();
  expect(await missing.innerText()).toBe(message);
  await expect(missing.getByRole("link", { name: "Back to projects" })).toHaveAttribute("href", "/projects");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
});

test("a board with no grant and a nonexistent board are indistinguishable to that reader", async ({ page }) => {
  await seedAssignmentOutsider();
  await signInThroughForm(page, OUTSIDER_USERNAME, OUTSIDER_PASSWORD);
  await page.goto(`/projects/${PROJECT_KEY}`);
  const missing = page.getByTestId("missing-page");
  await expect(missing.getByRole("heading", { name: HEADING })).toBeVisible();
  const denied = await missing.innerText();
  await expect(page.getByText(PROJECT_NAME, { exact: true })).toHaveCount(0);
  await page.goto("/projects/NOSUCHKEY");
  await expect(missing.getByRole("heading", { name: HEADING })).toBeVisible();
  expect(await missing.innerText()).toBe(denied);
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
});

for (const theme of ["light", "dark"]) {
test(`the lost card and its recovery fit a phone in ${theme} theme`, async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
    await page.goto("/not-a-route-bp262");
    await expect(page.getByTestId("missing-page").getByRole("heading", { name: HEADING })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const recovery = page.getByRole("link", { name: "Back to projects" });
    await recovery.scrollIntoViewIfNeeded();
    await expect(recovery).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // The shell clips overflow, so document width alone cannot detect an oversized recovery.
    expect((await page.getByTestId("missing-page").boundingBox())!.width).toBeLessThanOrEqual(390);
    const rect = await recovery.boundingBox();
    expect(rect!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: `e2e/.artifacts/BP-262-phone-${theme}.png` });
});
}
