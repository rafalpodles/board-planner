import { test, expect, type Page } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  PROJECT_KEY,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  seed,
} from "./seed";

/**
 * BP-387. The bell and the feed behind it — `/api/notifications`, `/api/notifications/read` and
 * `/api/notifications/unread-count` — driven from the two screens a person actually uses: the
 * sidebar badge and the notifications list.
 *
 * Two browsers, because every assertion here is about the seam between them: one person acts, a
 * different person hears about it. A single-context test could write the rows itself and would
 * then be asserting on its own fixture rather than on the dispatch.
 *
 * Two controls travel with the assertions, and both exist to tell a working feature apart from a
 * broken one that happens to look the same:
 *
 * - The actor's own bell. Three events, all authored by the admin, and their badge must stay
 *   empty. Without it, "the member's badge says 3" is equally consistent with a pipeline that
 *   notifies everybody about everything.
 * - The count after a single row is read. Marking one must leave the other two unread, which is
 *   what separates the single-id branch of the read route from the mark-all branch beside it.
 *
 * Each assertion below was watched failing against a deliberately broken copy of the code it
 * covers: unread-count with its `read: false` clause dropped, the read route's single-id branch
 * falling through to mark-all, mark-all writing `read: false`, the feed's `inApp` filter inverted,
 * the feed no longer keyed on the recipient, and the row's href replaced by "/notifications".
 * Dropping `populate("task")` from the feed is the one change that leaves this green, and rightly:
 * the row then links by task id and useCanonicalUrl rewrites the address on arrival, so the reader
 * lands where they meant to.
 */

const TASK_KEY = `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`;
const TASK_URL = `/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;

const ASSIGNED = `${TASK_KEY} assigned to you`;
const COMMENTED = `New comment on ${TASK_KEY}`;
const MENTIONED = `${ADMIN_USERNAME} mentioned you in ${TASK_KEY}`;

test.beforeEach(seed);

async function signIn(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);
}

/** The sidebar's Notifications link; its text is the label plus whatever the badge says. */
function bell(page: Page) {
  return page.locator('a[href="/notifications"]').first();
}

const badgeText = (count: number) =>
  count === 0 ? /^Notifications$/ : new RegExp(`^Notifications\\s*${count}$`);

/**
 * The badge as the server last answered it, reloaded until it agrees.
 *
 * Two reasons this cannot be a single read. Notification writes are fire-and-forget by design, so
 * the request that caused one has already answered by the time the row exists — this is the race
 * that made BP-328's spec pass and fail at random. And the sidebar only asks for the count when it
 * mounts and every thirty seconds after; nothing pushes to it, so a reload is what turns this into
 * a reading of /api/notifications/unread-count rather than of what the page was told on arrival.
 */
async function expectUnreadBadge(page: Page, count: number) {
  await expect(async () => {
    const counted = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/notifications/unread-count" && r.status() === 200,
      { timeout: 10_000 }
    );
    await page.goto("/notifications");

    // The number the server answered, asserted before the badge that renders it. An absent badge
    // is also what the sidebar shows while that first request is still in flight, so a bare
    // `toHaveText(/^Notifications$/)` passes on a page that has not been told anything yet — it
    // let a mark-all that wrote nothing through on the first draft of this spec.
    expect((await (await counted).json()).count).toBe(count);
    await expect(bell(page)).toHaveText(badgeText(count), { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
}

/** A row in the feed, found by the title the dispatcher wrote. */
function feedRow(page: Page, title: string) {
  return page.getByRole("link", { name: new RegExp(title) });
}

async function comment(page: Page, text: string) {
  const posted = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().includes(`/tasks/${SIBLING_TASK_ID}/comments`) &&
      r.status() < 400
  );
  await page.getByPlaceholder("Write a comment, @mention someone…").fill(text);
  await page.getByRole("button", { name: "Comment" }).click();
  await posted;
}

test("the bell counts assign, comment and mention, and reading them takes them off it", async ({
  browser,
}) => {
  const memberContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const member = await memberContext.newPage();
  const admin = await adminContext.newPage();

  await signIn(member, MEMBER_USERNAME, MEMBER_PASSWORD);
  // Compiled here rather than inside the first assertion that depends on it: a cold Turbopack
  // build of this route is slower than any wait that assertion should be allowed.
  await member.goto("/notifications");

  await test.step("before anything happens the bell is bare and the feed says so", async () => {
    await expect(member.getByText("No notifications yet.")).toBeVisible();
    await expect(bell(member)).toHaveText(badgeText(0));
  });

  await signIn(admin, ADMIN_USERNAME, ADMIN_PASSWORD);
  await admin.goto(TASK_URL);
  await expect(admin.getByText(TASK_KEY).first()).toBeVisible();

  await test.step("the admin assigns the task to the member", async () => {
    const saved = admin.waitForResponse(
      (r) =>
        r.request().method() === "PUT" &&
        r.url().includes(`/tasks/${SIBLING_TASK_ID}`) &&
        r.status() < 400
    );
    await admin.getByRole("combobox", { name: "Assignee" }).click();
    await admin.getByRole("option", { name: "E2E Member" }).click();
    await saved;
  });

  await test.step("the admin comments, then mentions the member", async () => {
    await comment(admin, "Ready for a look whenever you get a moment");
    // A mention of somebody who is also the assignee yields the mention and not the comment —
    // so the count below is three events, not four
    await comment(admin, `@${MEMBER_USERNAME} anything blocking this?`);
  });

  await test.step("all three reach the member's badge and feed", async () => {
    await expectUnreadBadge(member, 3);
    await expect(member.getByText("3 unread")).toBeVisible();
    await expect(feedRow(member, ASSIGNED)).toBeVisible();
    await expect(feedRow(member, COMMENTED)).toBeVisible();
    await expect(feedRow(member, MENTIONED)).toBeVisible();
  });

  // The control the three assertions above rest on: same board, same three events, and the only
  // difference is who caused them.
  await test.step("the person who caused all three hears nothing about their own work", async () => {
    await admin.goto("/notifications");
    await expect(admin.getByText("No notifications yet.")).toBeVisible();
    await expect(bell(admin)).toHaveText(badgeText(0));
  });

  await test.step("a row opens the task it is about", async () => {
    const read = member.waitForResponse(
      (r) =>
        r.request().method() === "PATCH" &&
        new URL(r.url()).pathname === "/api/notifications/read" &&
        r.status() < 400
    );
    await feedRow(member, COMMENTED).click();
    await read;

    await expect(member).toHaveURL(new RegExp(`${TASK_URL}$`));
    await expect(member.getByText(TASK_KEY).first()).toBeVisible();
  });

  // The second control. A mark-all wired to the row click would satisfy every assertion above and
  // land here at zero.
  await test.step("opening it read that row and left the other two alone", async () => {
    await expectUnreadBadge(member, 2);
    await expect(member.getByText("2 unread")).toBeVisible();
  });

  await test.step("mark all as read empties the bell without emptying the feed", async () => {
    const read = member.waitForResponse(
      (r) =>
        r.request().method() === "PATCH" &&
        new URL(r.url()).pathname === "/api/notifications/read" &&
        r.status() < 400
    );
    await member.getByRole("button", { name: "Mark all as read" }).click();
    await read;

    await expect(member.getByText("All caught up")).toBeVisible();
    await expect(member.getByRole("button", { name: "Mark all as read" })).toHaveCount(0);

    await expectUnreadBadge(member, 0);
    // Read, not deleted — the rows are the digest's source as well as the reader's history
    await expect(feedRow(member, ASSIGNED)).toBeVisible();
    await expect(feedRow(member, MENTIONED)).toBeVisible();
    await expect(member.getByText("All caught up")).toBeVisible();
  });

  await memberContext.close();
  await adminContext.close();
});
