import { test, expect, type Page } from "@playwright/test";
import { ADMIN_USERNAME, seed, wipe } from "./seed";

const TOGGLE = "First time? Create Account";

async function afterTheInstanceAnswers(page: Page, act: () => Promise<unknown>) {
  const answered = page.waitForResponse((res) => res.url().includes("/api/auth/instance"));
  await act();
  await answered;
}

test.describe("an instance nobody has claimed", () => {
  test.beforeEach(wipe);

  test("offers account creation, and the first account is an administrator", async ({
    page,
    request,
  }) => {
    const instance = await request.get("/api/auth/instance");
    expect(await instance.json()).toEqual({ unclaimed: true });

    await page.goto("/login");
    await expect(page.getByRole("button", { name: TOGGLE })).toBeVisible();

    await page.getByRole("button", { name: TOGGLE }).click();
    await page.getByLabel("Username").fill("firstadmin");
    await page.getByLabel("Password").fill("test1234");
    await page.getByLabel("Full Name").fill("First Admin");

    const created = page.waitForResponse(
      (res) => res.url().endsWith("/api/users") && res.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Create Account" }).click();
    expect((await created).status()).toBe(201);
    await expect(page).not.toHaveURL(/\/login/);

    const me = await page.request.get("/api/auth/me");
    expect(await me.json()).toMatchObject({ username: "firstadmin", role: "admin" });

    expect(await (await request.get("/api/auth/instance")).json()).toEqual({ unclaimed: false });
  });

  test("stops offering it once the instance has been claimed", async ({ page, request }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: TOGGLE })).toBeVisible();

    const claimed = await request.post("/api/users", {
      headers: { "sec-fetch-site": "none" },
      data: { username: "someoneelse", password: "test1234", fullName: "Someone Else" },
    });
    expect(claimed.status()).toBe(201);

    await afterTheInstanceAnswers(page, () => page.reload());
    await expect(page.getByRole("button", { name: TOGGLE })).toHaveCount(0);
  });
});

test.describe("an instance that already has users", () => {
  test.beforeEach(seed);

  test("offers no account creation, and signing in still works", async ({ page }) => {
    await afterTheInstanceAnswers(page, () => page.goto("/login"));

    await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
    await expect(page.getByRole("button", { name: TOGGLE })).toHaveCount(0);

    await page.getByLabel("Username").fill(ADMIN_USERNAME);
    await page.getByLabel("Password").fill("test1234");
    await page.getByRole("button", { name: "Sign In" }).click();

    await expect(page).not.toHaveURL(/\/login/);
  });

  test("refuses a bootstrap posted straight at the endpoint", async ({ request }) => {
    const res = await request.post("/api/users", {
      headers: { "sec-fetch-site": "none" },
      data: { username: "sneaky", password: "test1234", fullName: "Sneaky" },
    });

    expect(res.status()).toBe(403);
    expect(await res.json()).toMatchObject({ error: "Forbidden" });
  });
});
