import { test, expect, type APIRequestContext } from "@playwright/test";
import { MONGO_PROXY_CONTROL_URL } from "../playwright.config";
import { ADMIN_AUTH } from "./api";
import { seed } from "./seed";
import { signIn } from "./session";

const PANEL = "This instance is having trouble";
const BANNER = /You are still signed in/;

const cut = (request: APIRequestContext) => request.post(`${MONGO_PROXY_CONTROL_URL}/outage`);
const restore = (request: APIRequestContext) => request.post(`${MONGO_PROXY_CONTROL_URL}/restore`);

test.beforeEach(seed);

test.afterEach(async ({ request }) => {
  await restore(request);
  await expect(async () => {
    expect((await request.get("/api/projects", { headers: ADMIN_AUTH })).status()).toBe(200);
  }).toPass({ timeout: 60_000 });
});

test("a session that cannot be resolved is an outage, not a sign-out", async ({ page, request }) => {
  await signIn(page, "admin");
  await cut(request);

  await page.goto("/projects");

  await expect(page.getByRole("heading", { name: PANEL })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/You have not been signed out/)).toBeVisible();
  await expect(page).toHaveURL("/projects");

  const asks: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/auth/me")) asks.push(req.url());
  });
  await restore(request);
  const before = asks.length;
  await page.getByRole("button", { name: "Try again now" }).click();
  await expect.poll(() => asks.length, { timeout: 2_000 }).toBe(before + 1);

  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: PANEL })).toHaveCount(0);
  await expect(page.getByText(BANNER)).toHaveCount(0);
  await expect(page).toHaveURL("/projects");
});

test("a reader who is already signed in keeps their screen, and is told it may be stale", async ({
  page,
  request,
}) => {
  await signIn(page, "admin");

  await page.goto("/my-tasks");
  await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible();
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

  await cut(request);
  const refused = page.waitForResponse((res) => res.url().includes("/api/tasks/mine"), {
    timeout: 45_000,
  });
  await page.getByRole("link", { name: "My Tasks" }).click();
  expect((await refused).status()).toBeGreaterThanOrEqual(500);

  await expect(page.getByText(BANNER)).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL("/my-tasks");
  await expect(page.getByRole("heading", { name: PANEL })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "My Tasks" })).toBeVisible();

  await restore(request);
  await expect(async () => {
    await page.getByRole("link", { name: "Notifications" }).click();
    await page.getByRole("link", { name: "My Tasks" }).click();
    await expect(page.getByText(BANNER)).toHaveCount(0, { timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible();
});

test("a visitor with no session is still sent to sign in", async ({ page }) => {
  await page.goto("/projects");

  await expect(page).toHaveURL(/\/login\?next=%2Fprojects/);
  await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
  await expect(page.getByRole("heading", { name: PANEL })).toHaveCount(0);
});
