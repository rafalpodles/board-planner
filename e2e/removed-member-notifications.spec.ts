import { test, expect, type Page } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  PROJECT_KEY,
  SIBLING_TASK_NUMBER,
  seed,
} from "./seed";

/**
 * BP-328. Watch membership is acquired by commenting and never expires, so a contractor removed
 * from a board kept receiving task titles and comment excerpts through a session that was still
 * valid — the recipients were read off the task and never checked against the grant.
 *
 * Driven through both browsers because the seam is the whole bug: the member's feed is a screen,
 * the removal is a select in project settings, and asserting that DELETE /members returned 200
 * would prove the grant row went away, not that the board stopped talking to them.
 *
 * The control matters more than the assertion here. Step 2 proves the notification actually
 * arrives while the grant stands, so the silence in step 5 is the fix working rather than a
 * pipeline that was never wired in this environment.
 */

const TASK_PATH = `/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;

async function signIn(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);
}

/**
 * Waits for the POST, not for the comment to appear. The list renders optimistically, so the text
 * is on screen before the server has done anything — and the server-side work is the point here:
 * commenting is what adds the author to `watchers`. Waiting on the render let a second comment
 * load the task before the first one's watcher had landed, and the notification under test was
 * then never addressed to anybody.
 */
async function comment(page: Page, text: string) {
  await page.goto(TASK_PATH);
  await page.getByPlaceholder(/comment/i).first().fill(text);
  const posted = page.waitForResponse(
    (r) => r.request().method() === "POST" && /\/comments$/.test(new URL(r.url()).pathname) && r.status() < 400
  );
  await page.getByRole("button", { name: /^(Comment|Post|Add comment)$/ }).first().click();
  await posted;
  await expect(page.getByText(text).first()).toBeVisible();
}

/**
 * The excerpt, not the title: "New comment on TP-3" is a label, and the 120 characters of comment
 * body underneath it are the thing the ticket says a removed member kept receiving.
 *
 * Reloaded until it appears because addComment answers before createNotifications has finished —
 * the write is deliberately fire-and-forget, so a single load can beat it.
 */
async function expectFeedToCarry(page: Page, excerpt: string) {
  await expect(async () => {
    await page.goto("/notifications");
    await expect(page.getByText(excerpt).first()).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * Absence needs the same fire-and-forget window to have passed, or it proves only that the test
 * was quicker than the write. Loaded twice with a real round trip in between.
 */
async function expectFeedEmpty(page: Page) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto("/notifications");
    await expect(page.getByText("No notifications yet.")).toBeVisible();
    if (attempt === 0) await page.waitForTimeout(1_500);
  }
}

test.beforeEach(async () => {
  await seed();
});

test("a member removed from the board stops hearing about the task they watch", async ({
  browser,
}) => {
  const memberContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const member = await memberContext.newPage();
  const admin = await adminContext.newPage();

  // 1. Commenting is what makes somebody a watcher — the silent subscription the bug rides on.
  await signIn(member, MEMBER_USERNAME, MEMBER_PASSWORD);
  // Compiled once here rather than inside the first assertion that depends on it — a cold
  // Turbopack build of this route is slower than any wait the assertion should be allowed.
  await member.goto("/notifications");
  await comment(member, "I can take this one");

  await signIn(admin, ADMIN_USERNAME, ADMIN_PASSWORD);
  await comment(admin, "Thanks, it is yours");

  // 2. The control: while the grant stands, the watcher hears about it.
  await expectFeedToCarry(member, "Thanks, it is yours");

  // 3. Removal, through the screen an owner actually uses. The row goes with the grant: the
  // members list is built from grant rows, so losing one is how the screen shows it worked.
  await admin.goto(`/projects/${PROJECT_KEY}/settings`);
  await admin.getByLabel(`Access for ${MEMBER_USERNAME}`).selectOption("none");
  await expect(admin.getByLabel(`Access for ${MEMBER_USERNAME}`)).toHaveCount(0);

  // 4. What was already queued goes with the grant, rather than staying readable forever.
  await expectFeedEmpty(member);
  await expect(member.getByText("Thanks, it is yours")).toHaveCount(0);

  // 5. And the board stops talking to them from here on.
  await comment(admin, "Reassigning this, since they are gone");

  await expectFeedEmpty(member);
  await expect(member.getByText("Reassigning this, since they are gone")).toHaveCount(0);

  await memberContext.close();
  await adminContext.close();
});

test("the board they still belong to keeps reaching them", async ({ browser }) => {
  const memberContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const member = await memberContext.newPage();
  const admin = await adminContext.newPage();

  await signIn(member, MEMBER_USERNAME, MEMBER_PASSWORD);
  await comment(member, "Watching this one");

  await signIn(admin, ADMIN_USERNAME, ADMIN_PASSWORD);
  await comment(admin, "Still here, still yours");

  await expectFeedToCarry(member, "Still here, still yours");

  await memberContext.close();
  await adminContext.close();
});
