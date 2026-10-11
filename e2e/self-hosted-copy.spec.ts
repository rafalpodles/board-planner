import { test, expect } from "@playwright/test";
import { seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-922. The words of the cloud say organisation and admin; a self-hosted instance keeps the product's own
 * name on its sign-in page, names nobody to a visitor, and still reads right: one organisation, one set of admins.
 */
test.beforeEach(seed);

test("a self-hosted sign-in page keeps the product's name, and the host names no organisation", async ({ page, request }) => {
  expect(await (await request.get("/api/auth/instance")).json()).toMatchObject({ cloud: false, organisation: null });

  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "Board Planner" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Sign in to / })).toHaveCount(0);
});

test("an admin's settings and audit log say audit log and your account, not instance", async ({ page }) => {
  await signIn(page);

  await page.goto("/settings/audit");
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
  await expect(page.getByText(/^Organisation-wide actions:/)).toBeVisible();
  await expect(page.getByText("This account and this instance")).toHaveCount(0);
  await expect(page.getByText("Instance audit log")).toHaveCount(0);
});
