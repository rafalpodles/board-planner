import { test, expect, type APIRequestContext } from "@playwright/test";
import { MONGO_PROXY_CONTROL_URL } from "../playwright.config";
import { seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-473, and the browser half of BP-362.
 *
 * A database that cannot be reached used to read as a logout: `/api/auth/me` answered 401, the
 * guard redirected, and the sign-in page it redirected to was served by the same instance that had
 * just failed — so the way out of it was a screen that could not sign anybody in either. The fix
 * is three pieces that only meet in a browser: a 503 from the endpoint, an `outage` flag the guard
 * keeps apart from `user`, and two panels — one for a reader whose session could not be resolved,
 * one for a reader already holding it.
 *
 * `db-reconnect-leaks` and `mcp-tools` both take the database away, and both measure the server.
 * Nothing has ever looked at the screen, which is where the bug was.
 */

const PANEL = "This instance is having trouble";
const BANNER = /You are still signed in/;

const cut = (request: APIRequestContext) => request.post(`${MONGO_PROXY_CONTROL_URL}/outage`);
const restore = (request: APIRequestContext) => request.post(`${MONGO_PROXY_CONTROL_URL}/restore`);

test.beforeEach(seed);

// Unconditional, so a failed assertion cannot leave the database cut for the rest of the run
test.afterEach(async ({ request }) => {
  await restore(request);
});

test("a session that cannot be resolved is an outage, not a sign-out", async ({ page, request }) => {
  await signIn(page, "admin");
  await cut(request);

  await page.goto("/projects");

  // The client gives /api/auth/me eight seconds before calling it unreachable, and the server's own
  // 503 can take longer than that during server selection — so this is the one assertion in the
  // spec that has to outwait both
  await expect(page.getByRole("heading", { name: PANEL })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/You have not been signed out/)).toBeVisible();
  // The whole point. A redirect here is the bug, and it is the redirect the guard still performs
  // for a reader who genuinely has no session — see the control at the bottom of this file.
  await expect(page).toHaveURL("/projects");

  // The button asks again, and the ask is what is pinned here rather than the recovery: the guard's
  // own backoff fires its first automatic attempt ten seconds after the outage was noticed, and the
  // click lands within a moment of the panel appearing — so a request this soon after it is the
  // click's. Waiting on the *request* and not the answer, because the answer is the instance's to
  // give and it takes its time reconnecting.
  await restore(request);
  const asked = page.waitForRequest((req) => req.url().includes("/api/auth/me"), {
    timeout: 5_000,
  });
  await page.getByRole("button", { name: "Try again now" }).click();
  await asked;

  // Back where they were, with the session they never lost — no sign-in in between. The driver
  // needs a moment to notice the database is there again, and the backoff would arrive here too,
  // so this asserts the return and not which attempt achieved it.
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: PANEL })).toHaveCount(0);
  await expect(page).toHaveURL("/projects");
});

test("a reader who is already signed in keeps their screen, and is told it may be stale", async ({
  page,
  request,
}) => {
  await signIn(page, "admin");
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

  // Signed in before the outage, so nothing sends this reader back through /api/auth/me: the shell
  // learns about it from the status of an ordinary answer, and that path is the whole reason
  // `noteApiStatus` exists
  await cut(request);
  const refused = page.waitForResponse((res) => res.url().includes("/api/tasks/mine"), {
    timeout: 45_000,
  });
  await page.getByRole("link", { name: "My Tasks" }).click();
  expect((await refused).status()).toBeGreaterThanOrEqual(500);

  await expect(page.getByText(BANNER)).toBeVisible({ timeout: 15_000 });
  // Still inside the app, not on the panel and not at sign-in: this reader's session was never in
  // question, and taking the screen away from them is the other half of the same bug
  await expect(page).toHaveURL("/my-tasks");
  await expect(page.getByRole("heading", { name: PANEL })).toHaveCount(0);
  // The shell is still drawn under the banner rather than replaced by it
  await expect(page.getByRole("link", { name: "My Tasks" })).toBeVisible();

  // And it goes away by itself: any answer below 500 is proof the instance is answering again
  await restore(request);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(BANNER)).toHaveCount(0);
  }).toPass({ timeout: 45_000 });
});

/**
 * The control for the first test's `toHaveURL("/projects")`. Without it, "an outage does not
 * redirect" is equally satisfied by a guard that has stopped redirecting anybody — which is a
 * signed-out visitor left staring at an empty shell.
 */
test("a visitor with no session is still sent to sign in", async ({ page }) => {
  await page.goto("/projects");

  await expect(page).toHaveURL(/\/login\?next=%2Fprojects/);
  await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
  await expect(page.getByRole("heading", { name: PANEL })).toHaveCount(0);
});
