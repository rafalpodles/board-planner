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

async function sessionsOf(userId: mongoose.Types.ObjectId) {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle.collection("sessions").find({ user: userId }).toArray();
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Settings sections" });

function adminAnswers(page: Page): string[] {
  const seen: string[] = [];
  page.on("response", (res) => {
    const path = new URL(res.url()).pathname;
    if (SCREENS.some((s) => s.api === path)) seen.push(`${res.status()} ${path}`);
  });
  return seen;
}

test.beforeEach(seed);

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

    expect(answers).toEqual([]);
  });

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

    await expect(nav(memberPage).getByRole("link", { name: "Profile" })).toBeVisible();
    await expect(nav(memberPage).getByRole("link", { name: "Security" })).toBeVisible();
    await expect(nav(memberPage).getByRole("heading", { name: "Administration" })).toHaveCount(0);
    for (const label of ["Users", "Email", "PM Agents", "Workers", "Audit log"]) {
      await expect(nav(memberPage).getByRole("link", { name: label, exact: true })).toHaveCount(0);
    }

    await theirs.close();
  });

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

    await expect(
      page
        .locator("div", { has: page.getByText("@member") })
        .last()
        .getByText("Admin", { exact: true })
    ).toBeVisible();

    const theirs = await browser.newContext();
    await signInContext(theirs, "member");
    const memberPage = await theirs.newPage();
    await memberPage.goto("/settings/profile");
    await expect(nav(memberPage).getByRole("heading", { name: "Administration" })).toBeVisible();

    await memberPage.goto("/settings/users");
    await expect(memberPage).toHaveURL("/settings/users");
    await expect(memberPage.getByRole("heading", { name: "Users" })).toBeVisible();

    await theirs.close();
  });
});

test.describe("deleting a user", () => {
  const RENAMED = "E2E Member Renamed";

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
    expect(await sessionsOf(MEMBER_ID)).toHaveLength(1);

    await signIn(page, "admin");
    await page.goto("/settings/users");
    await page.getByText("E2E Member").click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    await expect(page.getByText('Are you sure you want to delete "E2E Member"?')).toBeVisible();

    const deleted = page.waitForResponse(
      (res) => res.url().includes(`/api/users/${MEMBER_ID}`) && res.request().method() === "DELETE"
    );
    await page.getByRole("button", { name: "Delete User", exact: true }).click();
    expect((await deleted).status()).toBe(200);

    await expect(page.getByText("@member")).toHaveCount(0);
    await expect(page.getByText("@admin")).toBeVisible();

    expect(await sessionsOf(MEMBER_ID)).toHaveLength(0);

    await member.page.goto("/projects");
    await expect(member.page).toHaveURL(/\/login/);
    await member.context.close();
  });

  test("an admin is refused their own account, however the id is spelled", async ({
    page,
    request,
  }) => {
    await signIn(page, "admin");
    await page.goto("/settings/users");

    const refused = await page.request.delete(`/api/users/${ADMIN_ID}`, { headers: SAME_ORIGIN });
    expect(refused.status(), await refused.text()).toBe(400);
    expect(await refused.text()).toContain("Cannot delete yourself");

    const shouted = await page.request.delete(
      `/api/users/${ADMIN_ID.toString().toUpperCase()}`,
      { headers: SAME_ORIGIN }
    );
    expect(shouted.status(), await shouted.text()).toBe(400);
    expect(await shouted.text()).toContain("Cannot delete yourself");

    const byToken = await request.delete(`/api/users/${MEMBER_ID}`, { headers: ADMIN_AUTH });
    expect(byToken.status(), await byToken.text()).toBe(403);

    await page.reload();
    await expect(page.getByText("@admin")).toBeVisible();
    await expect(page.getByText("@member")).toBeVisible();
    expect(await sessionsOf(ADMIN_ID)).toHaveLength(1);
  });

  test("the screens that named them still render once they are gone", async ({ page, request }) => {
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

      await expect(async () => {
        await page.goto("/settings/audit");
        await expect(actorCell).toHaveText(MEMBER_USERNAME);
      }).toPass({ timeout: 20_000 });
    });

    const gone = await page.request.delete(`/api/users/${MEMBER_ID}`, { headers: SAME_ORIGIN });
    expect(gone.status(), await gone.text()).toBe(200);

    await page.goto(`/projects/${PROJECT_KEY}`);
    await expect(boardCard).toBeVisible();
    await expect(boardCard).toContainText(SIBLING_TASK_TITLE);
    await expect(boardCard).not.toContainText(RENAMED);

    await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
    const comment = page.locator("div.group", { hasText: "Said before the account went" });
    await expect(comment).toBeVisible();
    await expect(comment.getByText("Unknown")).toBeVisible();

    await page.goto(`/projects/${PROJECT_KEY}/settings`);
    await expect(page.getByRole("heading", { name: "Who can use this board" })).toBeVisible();
    await expect(page.getByText(RENAMED)).toHaveCount(0);

    await page.goto("/settings/audit");
    await expect(auditRow).toBeVisible();
    await expect(actorCell).toHaveText(MEMBER_USERNAME);
    await expect(auditRow).toContainText(MEMBER_USERNAME);

    const deletionRow = page.locator("tr", { hasText: "Account deleted" });
    await expect(async () => {
      await page.goto("/settings/audit");
      await expect(deletionRow).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    await expect(deletionRow.locator("td").nth(1)).toHaveText(ADMIN_USERNAME);
    await expect(deletionRow).toContainText(MEMBER_USERNAME);
  });
});
