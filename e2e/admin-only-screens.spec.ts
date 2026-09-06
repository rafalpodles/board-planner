import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH, MEMBER_AUTH, SAME_ORIGIN } from "./api";
import {
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

    // The assertion that survives the redirect being restored by hand: a page that renders nothing
    // may still have asked, and the answer is what a leak looks like. Every 403 here is fine.
    expect(answers.filter((a) => a.startsWith("200"))).toEqual([]);
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
      page.locator("div", { has: page.getByText("@member") }).getByText("Admin").last()
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
   * The aftermath, which is where this codebase has actually broken: `populate` renders a
   * reference to a deleted user as `null`, and `typeof null === "object"`, so every surface that
   * asked the shape of the reference took the populated branch and threw. Nine of them were fixed
   * at once; nothing since has walked the screens with a genuinely deleted account behind them.
   */
  test("the screens that named them still render once they are gone", async ({ page, request }) => {
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

    // Through the browser's cookie session rather than the admin Bearer above. The Bearer is
    // accepted here today, which is BP-537 — a machine credential may delete an account though the
    // same route refuses it a role, a password or an address. This spec must not be the thing that
    // goes red when that is closed.
    await signIn(page, "admin");
    // SAME_ORIGIN because the provenance check is fail-closed: an APIRequestContext sends neither
    // Origin nor Sec-Fetch-Site, and a state-changing request carrying neither is refused 403
    const gone = await page.request.delete(`/api/users/${MEMBER_ID}`, { headers: SAME_ORIGIN });
    expect(gone.status(), await gone.text()).toBe(200);

    await page.goto(`/projects/${PROJECT_KEY}`);
    await expect(page.getByText(SIBLING_TASK_TITLE)).toBeVisible();

    await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
    const comment = page.locator("div.group", { hasText: "Said before the account went" });
    await expect(comment).toBeVisible();
    // Inside the comment rather than anywhere on the page: "Unknown" is the fallback several
    // surfaces use, and an unscoped match would be satisfied by any of them
    await expect(comment.getByText("Unknown")).toBeVisible();

    await page.goto("/settings/audit");
    await expect(page.getByRole("heading", { name: "Instance audit log" })).toBeVisible();

    await page.goto(`/projects/${PROJECT_KEY}/settings`);
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
    await expect(page.getByText("@member")).toHaveCount(0);
  });
});
