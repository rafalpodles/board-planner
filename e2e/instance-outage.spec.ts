import { test, expect, type APIRequestContext } from "@playwright/test";
import { MONGO_PROXY_CONTROL_URL } from "../playwright.config";
import { ADMIN_AUTH } from "./api";
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

/**
 * Unconditional, so a failed assertion cannot leave the database cut for the rest of the run — and
 * it waits for the app, not only for the proxy. The specs that follow this one open with a single
 * un-retried `GET /api/auth/me` inside `signInContext`, and the driver takes seconds to notice the
 * database is back: without this wait, `own-display-name.spec.ts` — the next file in this group —
 * failed with a 503 out of a helper that reports it as "did this spec seed()?".
 */
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

  // Two clocks, and the shorter one usually wins: the app gives the driver 5 s to select a server
  // (`SERVER_SELECTION_TIMEOUT_MS`, src/lib/db.ts:36) and answers 503, while the client abandons
  // /api/auth/me after 8 s and treats that as the same thing. The budget is for a cold Turbopack
  // compile on top of whichever arrives.
  await expect(page.getByRole("heading", { name: PANEL })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/You have not been signed out/)).toBeVisible();
  // The whole point. A redirect here is the bug, and it is the redirect the guard still performs
  // for a reader who genuinely has no session — see the control at the bottom of this file.
  await expect(page).toHaveURL("/projects");

  // The button asks again, and the ask is what is pinned here rather than the recovery. Counted
  // rather than waited for, and inside two seconds: the guard's own backoff fires its first
  // automatic attempt ten seconds after the outage was noticed, so a window this short cannot be
  // satisfied by it however slow the runner is. The *request*, not the answer — the answer is the
  // instance's to give and it takes its time reconnecting.
  const asks: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/auth/me")) asks.push(req.url());
  });
  await restore(request);
  const before = asks.length;
  await page.getByRole("button", { name: "Try again now" }).click();
  await expect.poll(() => asks.length, { timeout: 2_000 }).toBe(before + 1);

  // Back where they were, with the session they never lost — no sign-in in between. The driver
  // needs a moment to notice the database is there again, and the backoff would arrive here too,
  // so this asserts the return and not which attempt achieved it.
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: PANEL })).toHaveCount(0);
  // The panel's absence is not enough on its own: it is drawn on `!user && outage`, so it goes the
  // moment the reader is known again whether or not the flag was cleared. The banner is the half
  // that reads the flag.
  await expect(page.getByText(BANNER)).toHaveCount(0);
  await expect(page).toHaveURL("/projects");
});

test("a reader who is already signed in keeps their screen, and is told it may be stale", async ({
  page,
  request,
}) => {
  await signIn(page, "admin");

  // Visited before the cut, for two reasons: it is the control — this screen works while the
  // instance does — and nothing else in this group opens /my-tasks, so a first visit pays for a
  // Turbopack compile of the page and its endpoint that would otherwise land inside the budget
  // below, on a runner that is already waiting out a server-selection timeout.
  await page.goto("/my-tasks");
  await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible();
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

  // And it goes away once the instance answers again — in place, without a reload. A reload is
  // what made the first version of this arm vacuous: a document load remounts the provider with
  // `outage` back at its initial `false`, so the banner's absence was guaranteed by initialisation
  // whatever the product did. Moving between two screens keeps the same provider and produces the
  // ordinary answers `noteApiStatus` reads, which is the path being asserted.
  await restore(request);
  await expect(async () => {
    await page.getByRole("link", { name: "Notifications" }).click();
    await page.getByRole("link", { name: "My Tasks" }).click();
    await expect(page.getByText(BANNER)).toHaveCount(0, { timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  // The positive half of the same moment: the reader is on a working screen, not on the panel
  await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible();
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
