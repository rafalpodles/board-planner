import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH, MEMBER_AUTH, SAME_ORIGIN } from "./api";
import {
  ADMIN_ID,
  ADMIN_USERNAME,
  E2E_MONGODB_URI,
  MEMBER_ID,
  MEMBER_USERNAME,
  PROJECT_ID,
  PROJECT_KEY,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  SIBLING_TASK_TITLE,
  seed,
} from "./seed";
import { signIn, signInContext } from "./session";

/**
 * BP-473. The Administration half of Settings, from a browser.
 *
 * Every one of these screens is gated twice — the nav group is filtered in
 * `src/app/(app)/settings/layout.tsx`, each page redirects itself on `!isAdmin`, and the endpoint
 * behind it is `withAdmin`. Only the last of the three was ever asserted, and this repo has
 * already shipped the failure the other two exist to prevent: a route moved to a new role while
 * the component kept gating on the old one.
 *
 * The two arms are deliberately separate. A member being bounced says nothing about the server,
 * and a 403 says nothing about what the browser drew on the way there — so the redirect is
 * asserted with the network watched, and the endpoints are asked again with each side's own
 * session cookie.
 */

interface Screen {
  path: string;
  heading: string;
  api: string;
}

const SCREENS: Screen[] = [
  { path: "/settings/users", heading: "Users", api: "/api/users" },
  { path: "/settings/email", heading: "Email", api: "/api/admin/email" },
  { path: "/settings/agents", heading: "PM agents", api: "/api/admin/agents" },
  { path: "/settings/workers", heading: "Worker fleet", api: "/api/admin/workers" },
  { path: "/settings/workers/runs", heading: "Run history", api: "/api/admin/runs" },
  { path: "/settings/audit", heading: "Instance audit log", api: "/api/admin/audit" },
];

/**
 * The session rows an account is holding. Nothing the browser can be shown distinguishes "the
 * account is gone" from "the account is gone AND its sessions were revoked" — the cookie is
 * refused either way, because resolving it ends at a user that no longer exists. The route's own
 * revoke is only observable here.
 */
async function sessionsOf(userId: mongoose.Types.ObjectId) {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle.collection("sessions").find({ user: userId }).toArray();
}

/** The desktop sidebar. The pill row below md carries the same links and is display:none here. */
const nav = (page: Page) => page.getByRole("navigation", { name: "Settings sections" });

/** Every admin answer this browser was actually given, as `200 /api/users`. */
function adminAnswers(page: Page): string[] {
  const seen: string[] = [];
  page.on("response", (res) => {
    const path = new URL(res.url()).pathname;
    if (SCREENS.some((s) => s.api === path)) seen.push(`${res.status()} ${path}`);
  });
  return seen;
}

test.beforeEach(seed);

// `sessionsOf` leaves a connection open, and seed()'s own disconnect only closes it when another
// test follows. sessions-and-auth.spec.ts carries the same teardown for the same reason.
test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test.describe("the administration screens", () => {
  test("a member is bounced off every one of them, and is handed nothing on the way", async ({
    page,
  }) => {
    await signIn(page, "member");
    const answers = adminAnswers(page);

    for (const screen of SCREENS) {
      await page.goto(screen.path);
      await expect(page, `${screen.path} kept a member`).toHaveURL("/projects");
      await expect(page.getByRole("heading", { name: screen.heading })).toHaveCount(0);
    }

    // Not "no 200s" but "no answers at all": each page returns from its effect before fetching, so
    // the stronger property is the true one — this browser never asked an administration endpoint
    // anything. A page that asked and was refused would be a redirect that arrives too late.
    expect(answers).toEqual([]);
  });

  /**
   * The control. Without it "the member saw no heading" is satisfied by a settings area that is
   * broken for everybody, and the network assertion above by a build that asks for nothing.
   */
  test("an admin reaches every one of them", async ({ page }) => {
    await signIn(page, "admin");
    const answers = adminAnswers(page);

    for (const screen of SCREENS) {
      await page.goto(screen.path);
      await expect(page).toHaveURL(screen.path);
      await expect(
        page.getByRole("heading", { name: screen.heading }),
        `${screen.path} did not render for an admin`
      ).toBeVisible();
    }

    // By path rather than by count: these screens poll, so the same endpoint answers more than
    // once and a count would be asserting the poll interval
    const served = new Set(
      answers.filter((a) => a.startsWith("200")).map((a) => a.split(" ")[1])
    );
    expect([...served].sort()).toEqual(SCREENS.map((s) => s.api).sort());
  });

  test("the Administration group is in an admin's nav and not in a member's", async ({
    browser,
    page,
  }) => {
    await signIn(page, "admin");
    await page.goto("/settings/profile");
    await expect(nav(page).getByRole("heading", { name: "Administration" })).toBeVisible();
    for (const label of ["Users", "Email", "PM Agents", "Workers", "Audit log"]) {
      await expect(nav(page).getByRole("link", { name: label, exact: true })).toBeVisible();
    }

    const theirs = await browser.newContext();
    await signInContext(theirs, "member");
    const memberPage = await theirs.newPage();
    await memberPage.goto("/settings/profile");

    // The Account group is the control: a nav that failed to render at all would satisfy every
    // absence below it
    await expect(nav(memberPage).getByRole("link", { name: "Profile" })).toBeVisible();
    await expect(nav(memberPage).getByRole("link", { name: "Security" })).toBeVisible();
    await expect(nav(memberPage).getByRole("heading", { name: "Administration" })).toHaveCount(0);
    for (const label of ["Users", "Email", "PM Agents", "Workers", "Audit log"]) {
      await expect(nav(memberPage).getByRole("link", { name: label, exact: true })).toHaveCount(0);
    }

    await theirs.close();
  });

  /**
   * The server's own answer, asked with the cookie the screens use rather than with a Bearer:
   * three of these six refuse a machine credential before they ever look at a role, so a token
   * would have produced six 403s that say nothing about who is an admin.
   */
  test("the endpoints behind them refuse a member and answer an admin", async ({
    browser,
    page,
  }) => {
    await signIn(page, "admin");
    const theirs = await browser.newContext();
    await signInContext(theirs, "member");

    for (const screen of SCREENS) {
      const refused = await theirs.request.get(screen.api);
      expect(refused.status(), `${screen.api} answered a member`).toBe(403);

      const answered = await page.request.get(screen.api);
      expect(answered.status(), `${screen.api} refused an admin`).toBe(200);
    }

    await theirs.close();
  });
});

test.describe("promotion", () => {
  test("a promoted member gains the Administration nav and the screens behind it", async ({
    browser,
    page,
  }) => {
    await signIn(page, "admin");
    await page.goto("/settings/users");

    await page.getByText("E2E Member").click();
    const saved = page.waitForResponse(
      (res) => res.url().includes(`/api/users/${MEMBER_ID}`) && res.request().method() === "PUT"
    );
    await page.getByRole("button", { name: "Admin", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saved).status()).toBe(200);

    // The list is re-read after the save, so the pill is the screen's own account of the change
    await expect(
      page
        // `.last()` on the container, not on the text: every ancestor div holding "@member" matches,
        // up to the one wrapping the whole shell — which also contains the sidebar's "E2E Admin",
        // the nav's "Administration" and the admin's own role pill
        .locator("div", { has: page.getByText("@member") })
        .last()
        .getByText("Admin", { exact: true })
    ).toBeVisible();

    const theirs = await browser.newContext();
    await signInContext(theirs, "member");
    const memberPage = await theirs.newPage();
    await memberPage.goto("/settings/profile");
    await expect(nav(memberPage).getByRole("heading", { name: "Administration" })).toBeVisible();

    // The nav appearing is not the point on its own — the page behind it has its own guard, and
    // this is the pair that has gone out of step before
    await memberPage.goto("/settings/users");
    await expect(memberPage).toHaveURL("/settings/users");
    await expect(memberPage.getByRole("heading", { name: "Users" })).toBeVisible();

    await theirs.close();
  });
});

test.describe("deleting a user", () => {
  /** The name the member is renamed to, so the rename that writes an audit row is a real change. */
  const RENAMED = "E2E Member Renamed";

  /** Signs the member in in their own browser, so what the delete does to them can be watched. */
  async function memberBrowser(browser: {
    newContext: () => Promise<BrowserContext>;
  }): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext();
    await signInContext(context, "member");
    const page = await context.newPage();
    return { context, page };
  }

  test("the confirm dialog deletes the account and ends the sessions it had", async ({
    browser,
    page,
  }) => {
    const member = await memberBrowser(browser);
    await member.page.goto("/projects");
    await expect(member.page.getByRole("heading", { name: "Projects" })).toBeVisible();
    // The control for the row count below: there is a session here to end
    expect(await sessionsOf(MEMBER_ID)).toHaveLength(1);

    await signIn(page, "admin");
    await page.goto("/settings/users");
    await page.getByText("E2E Member").click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    // The dialog is the subject: a Delete that went straight through would pass every assertion
    // below it and take the confirm step with it
    await expect(page.getByText('Are you sure you want to delete "E2E Member"?')).toBeVisible();

    const deleted = page.waitForResponse(
      (res) => res.url().includes(`/api/users/${MEMBER_ID}`) && res.request().method() === "DELETE"
    );
    await page.getByRole("button", { name: "Delete User", exact: true }).click();
    expect((await deleted).status()).toBe(200);

    await expect(page.getByText("@member")).toHaveCount(0);
    await expect(page.getByText("@admin")).toBeVisible();

    // The row, not only the refusal: an account that no longer exists cannot be resolved from a
    // cookie whatever happened to its sessions, so the browser below is bounced either way and
    // proves nothing about the revoke. Deleting `revokeUserSessions` from the route leaves every
    // other assertion in this test green — measured.
    expect(await sessionsOf(MEMBER_ID)).toHaveLength(0);

    // And what the person holding that session sees: the app, not a screen that keeps working
    // until it happens to reload
    await member.page.goto("/projects");
    await expect(member.page).toHaveURL(/\/login/);
    await member.context.close();
  });

  /**
   * The other thing this dialog can be pointed at, and the only guard on the route that nothing
   * anywhere pins — `route.test.ts` is four describes, all of them PUT.
   *
   * It is asserted through the API rather than the dialog because the screen offers no way to
   * confirm twice: the point is the refusal, and the refusal is the route's.
   */
  test("an admin is refused their own account, however the id is spelled", async ({
    page,
    request,
  }) => {
    await signIn(page, "admin");
    await page.goto("/settings/users");

    const refused = await page.request.delete(`/api/users/${ADMIN_ID}`, { headers: SAME_ORIGIN });
    expect(refused.status(), await refused.text()).toBe(400);
    expect(await refused.text()).toContain("Cannot delete yourself");

    // BP-546. The same account, spelled the way BSON also accepts: a 24-character hex id resolves
    // case-insensitively, so this was a different string and the same document. It answered 200,
    // and with no last-admin guard behind it the instance was left with no administrator at all.
    const shouted = await page.request.delete(
      `/api/users/${ADMIN_ID.toString().toUpperCase()}`,
      { headers: SAME_ORIGIN }
    );
    expect(shouted.status(), await shouted.text()).toBe(400);
    expect(await shouted.text()).toContain("Cannot delete yourself");

    // BP-537. The same call with this admin's API token, which is what every unattended credential
    // on this instance is. The three writes above it on that route refuse one; this one did not.
    const byToken = await request.delete(`/api/users/${MEMBER_ID}`, { headers: ADMIN_AUTH });
    expect(byToken.status(), await byToken.text()).toBe(403);

    // The consequence, not the status. Both accounts are still there, and the administrator still
    // holds the session they made these calls with.
    await page.reload();
    await expect(page.getByText("@admin")).toBeVisible();
    await expect(page.getByText("@member")).toBeVisible();
    expect(await sessionsOf(ADMIN_ID)).toHaveLength(1);
  });

  /**
   * The aftermath, which is where this codebase has actually broken: `populate` renders a
   * reference to a deleted user as `null`, and `typeof null === "object"`, so every surface that
   * asked the shape of the reference took the populated branch and threw. Nine of them were fixed
   * at once; nothing since has walked the screens with a genuinely deleted account behind them.
   *
   * Every screen is asserted to name the member BEFORE the delete. Without that, "their name is
   * gone" is equally what a screen that never showed it looks like — which is exactly what the
   * first cut of this test asserted on two of the three screens.
   */
  test("the screens that named them still render once they are gone", async ({ page, request }) => {
    // A row in the instance log written BY the account that is about to go. The fixture seeds no
    // audit rows and nothing else here writes one, so without this the audit screen is an empty
    // table and its only line that renders a user reference is never reached.
    const renamed = await request.put("/api/users/me", {
      headers: MEMBER_AUTH,
      data: { fullName: RENAMED },
    });
    expect(renamed.status(), await renamed.text()).toBe(200);

    const assigned = await request.put(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}`, {
      headers: ADMIN_AUTH,
      data: { assignee: MEMBER_USERNAME },
    });
    expect(assigned.status(), await assigned.text()).toBe(200);

    const commented = await request.post(
      `/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}/comments`,
      { headers: MEMBER_AUTH, data: { body: "Said before the account went" } }
    );
    expect(commented.status(), await commented.text()).toBe(201);

    await signIn(page, "admin");

    const boardCard = page.locator(
      `[data-column-body] a[href="/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}"]`
    );
    const auditRow = page.locator("tr", { hasText: "Name changed by the account itself" });
    const actorCell = auditRow.locator("td").nth(1);

    await test.step("every screen names them while the account exists", async () => {
      await page.goto(`/projects/${PROJECT_KEY}`);
      await expect(boardCard).toContainText(RENAMED);

      await page.goto(`/projects/${PROJECT_KEY}/settings`);
      await expect(page.getByText(RENAMED)).toBeVisible();

      // The audit write is fire-and-forget, so the row can arrive after the response that caused it
      await expect(async () => {
        await page.goto("/settings/audit");
        await expect(actorCell).toHaveText(MEMBER_USERNAME);
      }).toPass({ timeout: 20_000 });
    });

    // Through the browser's cookie session rather than the admin Bearer used for the setup above:
    // a machine credential is refused here since BP-537, which the test before this one asserts.
    // SAME_ORIGIN because the provenance check is fail-closed: an APIRequestContext sends neither
    // Origin nor Sec-Fetch-Site, and a state-changing request carrying neither is refused 403
    const gone = await page.request.delete(`/api/users/${MEMBER_ID}`, { headers: SAME_ORIGIN });
    expect(gone.status(), await gone.text()).toBe(200);

    await page.goto(`/projects/${PROJECT_KEY}`);
    await expect(boardCard).toBeVisible();
    await expect(boardCard).toContainText(SIBLING_TASK_TITLE);
    await expect(boardCard).not.toContainText(RENAMED);

    await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
    const comment = page.locator("div.group", { hasText: "Said before the account went" });
    await expect(comment).toBeVisible();
    // Inside the comment rather than anywhere on the page: "Unknown" is the fallback several
    // surfaces use, and an unscoped match would be satisfied by any of them
    await expect(comment.getByText("Unknown")).toBeVisible();

    await page.goto(`/projects/${PROJECT_KEY}/settings`);
    await expect(page.getByRole("heading", { name: "Who can use this board" })).toBeVisible();
    await expect(page.getByText(RENAMED)).toHaveCount(0);

    await page.goto("/settings/audit");
    await expect(auditRow).toBeVisible();
    // Both halves of the row outlive the account now: `target` was always a stored username, and
    // since BP-539 so is the actor. Before that this read "system" — the word this screen reserves
    // for a machine — so deleting somebody rewrote every row they had ever written.
    await expect(actorCell).toHaveText(MEMBER_USERNAME);
    await expect(auditRow).toContainText(MEMBER_USERNAME);

    // And the deletion itself, which nothing recorded before BP-538: the account is gone, so this
    // row is the only place it is written down that it existed and who removed it.
    const deletionRow = page.locator("tr", { hasText: "Account deleted" });
    await expect(deletionRow).toBeVisible();
    await expect(deletionRow.locator("td").nth(1)).toHaveText(ADMIN_USERNAME);
    await expect(deletionRow).toContainText(MEMBER_USERNAME);
  });
});
