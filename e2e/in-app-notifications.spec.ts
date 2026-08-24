import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH, MEMBER_AUTH } from "./api";
import {
  ADMIN_ID,
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  E2E_MONGODB_URI,
  FINISHED_TASK_ID,
  MEMBER_ID,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  PROJECT_ID,
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
 * Three properties of these routes need a second person or a second row to be visible at all, and
 * each gets its own test below: who a row is addressed to, who may mark it read, and what happens
 * to a row the notification grid hides from the bell but the digest still needs.
 *
 * What this file does NOT cover, so the next reader does not assume it: the badge is only ever
 * read after a reload, so the thirty-second poll that keeps it moving for somebody sitting on the
 * board is not exercised; and pagination (`before`, `limit`, "Load more") needs more rows than
 * these tests create.
 */

const TASK_KEY = `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`;
const TASK_URL = `/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;

// Seeded as the admin's fullName. The only way it can reach a row is the feed route resolving the
// actor behind it, so it is what an unresolved actor would cost the reader.
const ADMIN_FULL_NAME = "E2E Admin";

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
 *
 * The JSON is asserted before the badge that renders it, and that order is the point. An absent
 * badge is also what the sidebar shows while the first request is still in flight — `useState(0)` —
 * so a bare `toHaveText(/^Notifications$/)` matches at t=0 and never observes the server at all.
 * Two assertions in the first draft of this file were vacuous for exactly that reason, including
 * one described as a control.
 */
async function expectUnreadBadge(page: Page, count: number) {
  await expect(async () => {
    const counted = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/notifications/unread-count" && r.status() === 200,
      { timeout: 60_000 }
    );
    await page.goto("/notifications");

    expect((await (await counted).json()).count).toBe(count);
    await expect(bell(page)).toHaveText(badgeText(count), { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
}

/** A row in the feed, found by the title the dispatcher wrote. Escaped: one of these titles
 *  interpolates a username, and a dot in one would quietly widen the matcher instead of failing. */
function feedRow(page: Page, title: string) {
  return page.getByRole("link", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
}

/**
 * The rows on screen, reloaded until they are exactly these, newest first.
 *
 * The badge and the list are two different requests answered by one page load, so a row that
 * commits between them leaves a count of three standing above a list of two — and this page
 * fetches once and never again, so that state is terminal rather than something the next
 * assertion outwaits. Retrying the whole load is what keeps the race from reading as an
 * ordering bug.
 */
async function expectFeedRows(page: Page, titles: string[]) {
  await expect(async () => {
    await page.goto("/notifications");
    // Scoped to the page body, not the document: a count taken globally would also collect a
    // sidebar or header link that happened to point at the same task.
    const rows = page.locator("#main-content").locator(`a[href="${TASK_URL}"]`);
    await expect(rows).toHaveCount(titles.length, { timeout: 3_000 });
    expect((await rows.allInnerTexts()).map((t) => t.split("\n")[0])).toEqual(titles);
  }).toPass({ timeout: 30_000 });
}

/** The dot that tells a reader which rows are new; the only thing on the row that says so. */
function unreadDot(page: Page, title: string) {
  return feedRow(page, title).locator("span.rounded-full");
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

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

/**
 * Assigns a task over the API. Setup only, and only where the assignment is not the subject: the
 * screen for it is driven by hand in the first test, which is where it is being tested.
 */
async function assign(
  request: APIRequestContext,
  taskId: unknown,
  username: string,
  auth: Record<string, string>
) {
  const res = await request.put(`/api/projects/${PROJECT_KEY}/tasks/${taskId}`, {
    headers: auth,
    data: { assignee: username },
  });
  expect(res.status(), await res.text()).toBe(200);
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
    await expectUnreadBadge(member, 0);
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
    // Newest first, which is the whole ordering contract of the feed: with more rows than a page
    // holds, the wrong sort leaves a reader looking at the oldest thirty forever.
    await expectFeedRows(member, [MENTIONED, COMMENTED, ASSIGNED]);
    await expect(member.getByText("3 unread")).toBeVisible();

    // Every row points at the task, not just the one clicked below — the href is computed per row,
    // and it is also where an unresolved project would show up as a bare id.
    for (const title of [ASSIGNED, COMMENTED, MENTIONED]) {
      await expect(feedRow(member, title)).toHaveAttribute("href", TASK_URL);
      await expect(unreadDot(member, title)).toHaveCount(1);
    }
    // Deliberately not the project key beside it: the title already reads "TP-3", so asserting
    // "TP" would hold with the project unresolved and prove nothing.
    await expect(feedRow(member, ASSIGNED)).toContainText(ADMIN_FULL_NAME);
  });

  // The control the three assertions above rest on: same board, same three events, and the only
  // difference is who caused them. Measured at the count route as well as the list, because a
  // badge that stays bare is also what a sidebar that has not been told anything yet looks like.
  await test.step("the person who caused all three hears nothing about their own work", async () => {
    await expectUnreadBadge(admin, 0);
    await expect(admin.getByText("No notifications yet.")).toBeVisible();
    // That sentence is also what the page renders when the feed request fails — it swallows the
    // error — so the silence is confirmed at the source rather than taken from the screen.
    expect(
      await (await db()).collection("notifications").countDocuments({ recipient: ADMIN_ID })
    ).toBe(0);
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
    await expect(unreadDot(member, COMMENTED)).toHaveCount(0);
    await expect(unreadDot(member, ASSIGNED)).toHaveCount(1);
    await expect(unreadDot(member, MENTIONED)).toHaveCount(1);
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

    // Everything below is asserted after a reload. The page repaints its own rows read as soon as
    // the button is clicked, so "All caught up" and a vanished button hold on screen even when the
    // request wrote nothing at all.
    await expectUnreadBadge(member, 0);
    await expect(member.getByText("All caught up")).toBeVisible();
    await expect(member.getByRole("button", { name: "Mark all as read" })).toHaveCount(0);

    // Read, not deleted — the rows are the digest's source as well as the reader's history
    await expect(feedRow(member, ASSIGNED)).toBeVisible();
    await expect(feedRow(member, MENTIONED)).toBeVisible();
    await expect(unreadDot(member, ASSIGNED)).toHaveCount(0);
  });

  await memberContext.close();
  await adminContext.close();
});

/**
 * Who a row belongs to, asked of both branches of the read route.
 *
 * It answers a constant `{ok:true}` by design (BP-328) — whether the row exists is not something
 * it will tell a stranger — so the response says nothing and the effect is asserted instead, in
 * each person's own browser. The single-id attempt goes over the API because no screen offers it:
 * a person can only click rows their own feed rendered. Mark-all is clicked for real, because
 * that button is exactly how somebody would clear an instance's bells by accident.
 *
 * Each half is the other's control. Without the second person's row surviving, "the member's bell
 * went quiet" is equally consistent with a route that reads everything for everybody; without the
 * member's own row going quiet, it is consistent with a route that reads nothing at all.
 */
test("a row can only be read by the person it was addressed to", async ({ browser, request }) => {
  const memberContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const member = await memberContext.newPage();
  const admin = await adminContext.newPage();

  await signIn(member, MEMBER_USERNAME, MEMBER_PASSWORD);
  await signIn(admin, ADMIN_USERNAME, ADMIN_PASSWORD);
  // Compiled before anything is timed against it, so this test still stands up when run alone
  await member.goto("/notifications");
  await admin.goto("/notifications");

  // One row each, dispatched by the other person so neither is its own actor
  await assign(request, SIBLING_TASK_ID, MEMBER_USERNAME, ADMIN_AUTH);
  await assign(request, FINISHED_TASK_ID, ADMIN_USERNAME, MEMBER_AUTH);

  await expectUnreadBadge(member, 1);
  await expectUnreadBadge(admin, 1);

  const memberRowId = await theOnlyRowAddressedTo(request, MEMBER_AUTH);

  await test.step("a stranger holding the row's id cannot read it on their behalf", async () => {
    const attempt = await request.patch("/api/notifications/read", {
      headers: ADMIN_AUTH,
      data: { id: memberRowId },
    });
    expect(attempt.status()).toBe(200);
    await expectUnreadBadge(member, 1);
  });

  await test.step("mark all as read reaches the reader's own rows and stops there", async () => {
    const read = member.waitForResponse(
      (r) =>
        r.request().method() === "PATCH" &&
        new URL(r.url()).pathname === "/api/notifications/read" &&
        r.status() < 400
    );
    await member.getByRole("button", { name: "Mark all as read" }).click();
    await read;

    await expectUnreadBadge(member, 0);
    await expectUnreadBadge(admin, 1);
  });

  await memberContext.close();
  await adminContext.close();
});

/**
 * A row the grid hides from the bell. The write happens either way on purpose — the morning digest
 * is assembled from these documents — so all three routes carry the same `inApp` clause, and all
 * three are asked about it here: it must not be counted, must not be listed, and must not be
 * marked read by a mark-all, because a read row is one the digest has already decided to drop.
 *
 * Inserted directly. Reaching this state through the screens means ticking a cell on the project's
 * notification grid, which is BP-402's subject and its spec's; what these three routes need is
 * simply a row in the state that tick produces.
 */
test("a row the bell hides is not counted, not listed, and survives mark all", async ({
  browser,
  request,
}) => {
  const HIDDEN_TITLE = "Hidden from the bell, kept for the digest";

  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  await signIn(member, MEMBER_USERNAME, MEMBER_PASSWORD);
  await member.goto("/notifications");

  await (await db()).collection("notifications").insertOne({
    recipient: MEMBER_ID,
    type: "comment_added",
    task: SIBLING_TASK_ID,
    project: PROJECT_ID,
    actor: ADMIN_ID,
    title: HIDDEN_TITLE,
    body: "",
    read: false,
    inApp: false,
    hiddenAt: new Date(),
    createdAt: new Date(),
  });

  // The visible row beside it, dispatched for real. Without it a quiet bell would prove only that
  // nothing was delivered in this environment.
  await assign(request, SIBLING_TASK_ID, MEMBER_USERNAME, ADMIN_AUTH);

  await test.step("the bell counts one of the two, and lists that one", async () => {
    await expectUnreadBadge(member, 1);
    await expect(feedRow(member, ASSIGNED)).toBeVisible();
    await expect(member.getByText(HIDDEN_TITLE)).toHaveCount(0);
  });

  await test.step("mark all as read leaves the hidden row unread", async () => {
    const read = member.waitForResponse(
      (r) =>
        r.request().method() === "PATCH" &&
        new URL(r.url()).pathname === "/api/notifications/read" &&
        r.status() < 400
    );
    await member.getByRole("button", { name: "Mark all as read" }).click();
    await read;

    await expectUnreadBadge(member, 0);

    const rows = await (await db())
      .collection("notifications")
      .find({ recipient: MEMBER_ID })
      .toArray();
    expect(
      rows.map((r) => ({ title: r.title, read: r.read })).sort((a, b) => (a.title < b.title ? -1 : 1))
    ).toEqual([
      { title: HIDDEN_TITLE, read: false },
      { title: ASSIGNED, read: true },
    ]);
  });

  await memberContext.close();
});

async function theOnlyRowAddressedTo(
  request: APIRequestContext,
  auth: Record<string, string>
): Promise<string> {
  const res = await request.get("/api/notifications", { headers: auth });
  expect(res.status()).toBe(200);
  const feed = await res.json();
  expect(feed).toHaveLength(1);
  return feed[0]._id;
}

test.afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});
