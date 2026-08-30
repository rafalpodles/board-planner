import { test, expect, type Page } from "@playwright/test";
import { ADMIN_USERNAME, seed, wipe } from "./seed";

/**
 * BP-268. The login page rendered "First time? Create Account" with no condition on it, so every
 * visitor to a populated instance was invited to fill in a username and a password and answered
 * 403 by POST /api/users — a path that existed only to end in a refusal.
 *
 * Both arms, because "hides the toggle" and "the login page is broken" look identical with only
 * one of them.
 */

const TOGGLE = "First time? Create Account";

/**
 * `/login` is statically prerendered and the toggle starts hidden, so `toHaveCount(0)` is satisfied
 * before the page has asked anything — the first version of the two absence assertions below passed
 * with the endpoint mutated to answer `unclaimed: true` unconditionally, which is the whole server
 * half of the fix removed. Waiting for the answer is what makes the absence mean something.
 */
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
    // The server's own answer, asserted before the page is read: if this were false the toggle's
    // absence below would be correct rather than a bug
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

    // The role is the point of the bootstrap and the login page never shows it. Read through the
    // browser's own session rather than off the 201 body: the page signs in and navigates, and a
    // response body read across that navigation hangs. Without this assertion the test's title was
    // the only thing claiming the role, and minting "member" instead left the whole suite green.
    const me = await page.request.get("/api/auth/me");
    expect(await me.json()).toMatchObject({ username: "firstadmin", role: "admin" });

    expect(await (await request.get("/api/auth/instance")).json()).toEqual({ unclaimed: false });
  });

  test("stops offering it once the instance has been claimed", async ({ page, request }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: TOGGLE })).toBeVisible();

    // Claimed by somebody else, through the same endpoint the page uses. `sec-fetch-site: none`
    // is what a request typed straight at the address bar carries, and checkProvenance accepts it
    // — without it this is refused by the provenance check before the bootstrap rule is reached,
    // which would have made the assertion below pass for a reason it does not name.
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

  /**
   * The control. Without it, a page that rendered nothing at all would satisfy the arm above.
   */
  test("offers no account creation, and signing in still works", async ({ page }) => {
    await afterTheInstanceAnswers(page, () => page.goto("/login"));

    await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
    await expect(page.getByRole("button", { name: TOGGLE })).toHaveCount(0);

    await page.getByLabel("Username").fill(ADMIN_USERNAME);
    await page.getByLabel("Password").fill("test1234");
    await page.getByRole("button", { name: "Sign In" }).click();

    await expect(page).not.toHaveURL(/\/login/);
  });

  /**
   * The endpoint is the whole control: hiding the toggle is about what is offered.
   *
   * The 403 here comes from the "must be an authenticated admin" arm, reached *because* the user
   * count is non-zero — `provenanceRefusal` is only called on the bootstrap branch. Asserted by
   * mutation: forcing `isBootstrap` true turns this red with a 201. The `sec-fetch-site` header is
   * inert on this path and kept only so the request is the same shape as the one above.
   */
  test("refuses a bootstrap posted straight at the endpoint", async ({ request }) => {
    const res = await request.post("/api/users", {
      headers: { "sec-fetch-site": "none" },
      data: { username: "sneaky", password: "test1234", fullName: "Sneaky" },
    });

    expect(res.status()).toBe(403);
    expect(await res.json()).toMatchObject({ error: "Forbidden" });
  });
});
