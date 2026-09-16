import { test, expect } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { seed } from "./seed";
import { signIn } from "./session";

test.beforeEach(seed);

async function openNewUser(page: import("@playwright/test").Page, username: string) {
  await signIn(page);
  await page.goto("/settings/users");
  await page.getByRole("button", { name: "New User" }).click();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill("a-starting-password");
  await page.getByLabel("Full Name").fill("Somebody");
}

test("an admin cannot create a person under the name the PM identity is found by", async ({
  page,
  request,
}) => {
  await openNewUser(page, "pm");
  const refused = page.waitForResponse(
    (res) => res.url().endsWith("/api/users") && res.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Create User" }).click();

  expect((await refused).status()).toBe(400);
  await expect(page.getByRole("dialog")).toContainText("That username is reserved");

  const listed = await request.get("/api/users", { headers: ADMIN_AUTH });
  expect((await listed.json()).map((u: { username: string }) => u.username)).not.toContain("pm");
});

// The control: the same gesture with an ordinary name goes through
test("an ordinary name is created as before", async ({ page }) => {
  await openNewUser(page, "pmarek");
  const created = page.waitForResponse(
    (res) => res.url().endsWith("/api/users") && res.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Create User" }).click();

  expect((await created).status()).toBe(201);
});
