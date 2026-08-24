import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH, MEMBER_AUTH } from "./api";
import {
  ADMIN_ID,
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  AUDITOR_ID,
  AUDITOR_PASSWORD,
  AUDITOR_USERNAME,
  E2E_MONGODB_URI,
  FINISHED_TASK_ID,
  KEPT_TASK_ID,
  KEPT_TASK_KEY,
  MEMBER_ID,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  OUTSIDER_ID,
  OUTSIDER_USERNAME,
  PROJECT_ID,
  PROJECT_KEY,
  SECOND_PROJECT_KEY,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  seed,
  seedAssignmentOutsider,
  seedDemotableAdmin,
  seedSecondProject,
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
 * Five properties of these routes need a second person or a second row to be visible at all, and
 * each gets its own test below: who a row is addressed to, who may reach the board it came from,
 * who may mark it read, what happens to a row the notification grid hides from the bell but the
 * digest still needs, and who an @mention may name.
 *
 * What this file does NOT cover, so the next reader does not assume it: the badge is only ever
 * read after a reload, so the thirty-second poll that keeps it moving for somebody sitting on the
 * board is not exercised; and pagination (`before`, `limit`, "Load more") needs more rows than
 * these tests create.
 *
 * ## Mutation registry
 *
 * Every entry was applied to HEAD, run, and reverted — the harness is in the task's comments, and
 * so is the run log naming the failing assertion for each. Nothing here is a guess: an entry says
 * "killed by" only where the mutant was actually applied and the named test actually went red for
 * the reason the entry gives. Tests are referred to by their opening words.
 *
 * `src/app/api/notifications/route.ts`
 *  1. drop `filter.project = { $in: projectIds }`   → "a demoted admin…": the lost board's row
 *                                                     comes back into the feed
 *  2. `inApp: { $ne: false }` → `inApp: true`       → "a row the bell hides…": the row that omits
 *                                                     the key stops being listed
 *  3. drop `.sort({ createdAt: -1 })`               → "the bell counts…", "a row the bell hides…"
 *  4. `.sort({ createdAt: -1 })` → `{ createdAt: 1 }` → the same two, on order
 *  5. drop `.populate("actor", …)`                  → "the bell counts…": the actor's full name
 *  6. drop `.populate("task", …)`                   → "the bell counts…": the row's href
 *  7. drop `.populate("project", …)`                → "the bell counts…": the row's href
 *  8. drop `recipient: user._id`                    → "the bell counts…": the actor's own feed
 *
 * `src/app/api/notifications/unread-count/route.ts`
 *  9. drop `filter.project = { $in: projectIds }`   → "a demoted admin…": the badge stays at two
 * 10. `inApp: { $ne: false }` → `inApp: true`       → "a row the bell hides…": badge two → one
 * 11. drop `read: false`                            → all three mark-read tests
 *
 * `src/app/api/notifications/read/route.ts`
 * 12. `findOneAndUpdate` → `findOneAndDelete`       → "the bell counts…": the row is gone from the
 *                                                     feed. Only the toBeVisible above the dot
 *                                                     count catches this; the dot count alone
 *                                                     passes on a row that no longer exists.
 * 13. single-id: drop `recipient: user._id`         → "a row can only be read…": a stranger reads it
 * 14. single-id: drop `inApp: { $ne: false }`       → "a row the bell hides…": the hidden row reads
 * 15. single-id branch → mark-all over everything   → all three of the above
 * 16. mark-all: drop `recipient: user._id`          → "a row can only be read…"
 * 17. mark-all: drop `inApp: { $ne: false }`        → "a row the bell hides…"
 * 18. drop the `isValidObjectId` guard              → "a row can only be read…": 500 rather than
 *                                                     400, plus three unit tests beside the route
 * 19. `id !== undefined` → `if (id)`                → unit tests only: `""` and `null` fall
 *                                                     through to a mark-all. No e2e sends one, and
 *                                                     the cost of one that did is a whole feed
 *                                                     read, so the unit test is the guard.
 *
 * `src/lib/grants.ts`
 * 20. `recipientsWithAccess` refuses nobody         → "a mention cannot reach…": the stranger gets
 *                                                     a row written for them
 */

const TASK_KEY = `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`;
const TASK_URL = `/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;

// Seeded as the admin's fullName. The only way it can reach a row is the feed route resolving the
// actor behind it, so it is what an unresolved actor would cost the reader.
const ADMIN_FULL_NAME = "E2E Admin";

const ASSIGNED = `${TASK_KEY} assigned to you`;
const COMMENTED = `New comment on ${TASK_KEY}`;
const MENTIONED = `${ADMIN_USERNAME} mentioned you in ${TASK_KEY}`;
const KEPT_ASSIGNED = `${KEPT_TASK_KEY} assigned to you`;

test.beforeEach(seed);

async function signIn(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);
}

/**
 * Both API routes compiled and answered once, before anything is timed against them.
 *
 * A bare `goto` is not this. It resolves at `load`, which is before the page's own fetches have
 * come back, so the route behind them compiles inside the first assertion's window instead — on
 * whatever budget that assertion happens to carry, which for a cold Turbopack build is not enough.
 * Waiting for the responses is what makes the warm-up warm the thing that is about to be measured.
 */
async function warmNotificationRoutes(page: Page) {
  const answered = Promise.all(
    ["/api/notifications", "/api/notifications/unread-count"].map((pathname) =>
      page.waitForResponse((r) => new URL(r.url()).pathname === pathname, { timeout: 120_000 })
    )
  );
  await page.goto("/notifications");
  await answered;
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
 *
 * It syncs on the count route and nothing else, so it says nothing about the list: the two are
 * separate requests from one page load, and a caller that reads rows off the screen afterwards is
 * reading a response this never waited for. Every list assertion below reloads for itself.
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
 * The rows on screen, reloaded until they are exactly these, newest first — and none of `omits`.
 *
 * The badge and the list are two different requests answered by one page load, so a row that
 * commits between them leaves a count of three standing above a list of two — and this page
 * fetches once and never again, so that state is terminal rather than something the next
 * assertion outwaits. Retrying the whole load is what keeps the race from reading as an
 * ordering bug.
 *
 * `omits` is checked inside the same retry rather than after it. An absence read from a load that
 * beat the write is permanent for the same reason, and it is the polarity that fails silently:
 * "the hidden row is not here" holds trivially on a feed that has not loaded anything at all.
 */
async function expectFeedRows(page: Page, titles: string[], omits: string[] = []) {
  await expect(async () => {
    await page.goto("/notifications");
    // Scoped to the page body, not the document: a count taken globally would also collect a
    // sidebar or header link that happened to point at the same task.
    const rows = page.locator("#main-content").locator(`a[href="${TASK_URL}"]`);
    await expect(rows).toHaveCount(titles.length, { timeout: 3_000 });
    expect((await rows.allInnerTexts()).map((t) => t.split("\n")[0])).toEqual(titles);
    for (const title of omits) {
      await expect(page.getByText(title)).toHaveCount(0);
    }
  }).toPass({ timeout: 30_000 });
}

/**
 * The same idea for a feed whose rows point at more than one board, where counting hrefs against a
 * single task URL says nothing. Both halves inside one retry, for the reason above.
 */
async function expectFeed(
  page: Page,
  { carries, omits }: { carries: string[]; omits: string[] }
) {
  await expect(async () => {
    await page.goto("/notifications");
    for (const title of carries) {
      await expect(feedRow(page, title)).toBeVisible({ timeout: 3_000 });
    }
    for (const title of omits) {
      await expect(page.getByText(title)).toHaveCount(0);
    }
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
  auth: Record<string, string>,
  projectKey: string = PROJECT_KEY
) {
  const res = await request.put(`/api/projects/${projectKey}/tasks/${taskId}`, {
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
  await warmNotificationRoutes(member);

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
    // The row itself first. `unreadDot` is scoped to it, so a route that deleted the row instead
    // of marking it read resolves the dot to nothing and satisfies the count below either way —
    // swapping findOneAndUpdate for findOneAndDelete used to leave this whole test green.
    await expect(feedRow(member, COMMENTED)).toBeVisible();
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
 * BP-433. Which board a row came from, asked of both read routes at once.
 *
 * `recipient` is not the whole question. A row is addressed to a person *about a board*, and the
 * grant that justified sending it can go away while the row stays — so both GETs narrow to the
 * reader's accessible projects (BP-328). Nothing exercised that clause end to end: the only spec
 * that removes access goes through DELETE /members, which *deletes* the rows on its way out, so
 * the read-time filter never had to refuse anything.
 *
 * The door that leaves the rows behind is a demotion. PUT /api/users/[userId] changes a role and
 * touches neither grants nor sessions nor notifications, so an instance admin dropped to "member"
 * keeps a live session and a feed full of task titles and comment excerpts from boards they can no
 * longer open.
 *
 * Two rows, on two boards, because one would not tell the filter from a switch. The auditor keeps
 * a grant on the second board, so their accessible list stays non-empty after the demotion and the
 * routes' "no boards at all" early return never fires — `$in` is the only thing left doing the
 * work. The kept row is the control: without it, an empty feed is equally consistent with a route
 * that answers nothing to anybody who is not an admin.
 */
test("a demoted admin loses the feed for the board they no longer hold, rows and all", async ({
  browser,
  request,
}) => {
  await seedSecondProject();
  await seedDemotableAdmin();

  const auditorContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const auditor = await auditorContext.newPage();
  const admin = await adminContext.newPage();

  await signIn(auditor, AUDITOR_USERNAME, AUDITOR_PASSWORD);
  await warmNotificationRoutes(auditor);
  await signIn(admin, ADMIN_USERNAME, ADMIN_PASSWORD);

  // One row from each board, both by ordinary assignment rather than written in: what the ticket
  // is about is a real notification surviving a change of role.
  await assign(request, SIBLING_TASK_ID, AUDITOR_USERNAME, ADMIN_AUTH);
  await assign(request, KEPT_TASK_ID, AUDITOR_USERNAME, ADMIN_AUTH, SECOND_PROJECT_KEY);

  await test.step("while they are an admin both boards reach them", async () => {
    await expectUnreadBadge(auditor, 2);
    await expectFeed(auditor, { carries: [ASSIGNED, KEPT_ASSIGNED], omits: [] });
  });

  await test.step("the admin demotes them to a plain member", async () => {
    await admin.goto("/settings/users");
    await admin.getByText(`@${AUDITOR_USERNAME}`, { exact: true }).first().click();
    await admin.getByRole("button", { name: "Member", exact: true }).click();
    const saved = admin.waitForResponse(
      (r) =>
        r.request().method() === "PUT" &&
        /\/api\/users\/\w+$/.test(new URL(r.url()).pathname) &&
        r.status() < 400
    );
    await admin.getByRole("button", { name: "Save", exact: true }).click();
    await saved;
  });

  await test.step("the board they lost goes quiet; the one they kept does not", async () => {
    await expectUnreadBadge(auditor, 1);
    await expectFeed(auditor, { carries: [KEPT_ASSIGNED], omits: [ASSIGNED] });
  });

  // The point of the whole test. Removal-by-DELETE-members would leave nothing here, and an
  // assertion that the rows are gone would then pass without the read filter existing at all.
  await test.step("and the row is still in the collection, unread, waiting for the digest", async () => {
    const rows = await (await db())
      .collection("notifications")
      .find({ recipient: AUDITOR_ID })
      .toArray();
    expect(
      rows.map((r) => ({ project: String(r.project), read: r.read })).sort((a, b) =>
        a.project < b.project ? -1 : 1
      )
    ).toHaveLength(2);
    expect(rows.some((r) => String(r.project) === String(PROJECT_ID) && r.read === false)).toBe(
      true
    );
  });

  await auditorContext.close();
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
  await warmNotificationRoutes(member);
  await warmNotificationRoutes(admin);

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

  // `id` reaches the query directly, and a JSON body can carry an object where a string was meant.
  // Both shapes are refused rather than cast: one used to pick an arbitrary row of the caller's
  // own, the other used to throw a CastError out of the route as a 500.
  await test.step("an id that is not one is refused instead of being cast", async () => {
    for (const id of ["nope", { $ne: null }]) {
      const attempt = await request.patch("/api/notifications/read", {
        headers: ADMIN_AUTH,
        data: { id },
      });
      expect(attempt.status(), await attempt.text()).toBe(400);
    }
    // The admin's own row is the one `{ $ne: null }` would have marked read
    await expectUnreadBadge(admin, 1);
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
 * is assembled from these documents — so all four `inApp` clauses across the three routes say the
 * same thing, and all four are asked about it here: the row must not be counted, must not be
 * listed, must not be marked read by a mark-all, and must not be marked read by a PATCH naming its
 * id either.
 *
 * Three rows, not two. The clause is `$ne: false` rather than `true` because everything written
 * before BP-371 carries no `inApp` key at all, and a fixture where every row states the field can
 * only falsify `!== true` — flipping all four clauses to `inApp: true` left this test green. So
 * one row omits the key entirely and is required to behave exactly like a visible one.
 *
 * Inserted directly. Reaching this state through the screens means ticking a cell on the project's
 * notification grid, which is BP-402's subject and its spec's; what these three routes need is
 * simply a row in each state that tick produces.
 */
test("a row the bell hides is not counted, not listed, and survives mark all", async ({
  browser,
  request,
}) => {
  const HIDDEN_TITLE = "Hidden from the bell, kept for the digest";
  const LEGACY_TITLE = "Written before the grid existed";

  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  await signIn(member, MEMBER_USERNAME, MEMBER_PASSWORD);
  await warmNotificationRoutes(member);

  // Backdated, so the row dispatched below is unambiguously the newest and the order asserted on
  // the feed is a reading of the sort rather than of two writes landing in the same millisecond.
  const banked = new Date(Date.now() - 60_000);
  const stored = (title: string, over: Record<string, unknown>) => ({
    recipient: MEMBER_ID,
    type: "comment_added",
    task: SIBLING_TASK_ID,
    project: PROJECT_ID,
    actor: ADMIN_ID,
    title,
    body: "",
    read: false,
    createdAt: banked,
    ...over,
  });

  const written = await (await db())
    .collection("notifications")
    .insertMany([
      stored(HIDDEN_TITLE, { inApp: false, hiddenAt: new Date() }),
      // No `inApp` key, and the schema's `default: true` cannot put one here — a driver insert is
      // exactly the shape a row banked before the field existed still has in production.
      stored(LEGACY_TITLE, {}),
    ]);
  const hiddenId = String(written.insertedIds[0]);

  // The visible row beside them, dispatched for real. Without it a quiet bell would prove only
  // that nothing was delivered in this environment.
  await assign(request, SIBLING_TASK_ID, MEMBER_USERNAME, ADMIN_AUTH);

  await test.step("the bell counts two of the three, and lists those two", async () => {
    await expectUnreadBadge(member, 2);
    // The list, reloaded for itself: the badge above synced on the count route only, and the rows
    // come back from a different request of the same load.
    await expectFeedRows(member, [ASSIGNED, LEGACY_TITLE], [HIDDEN_TITLE]);
  });

  await test.step("naming the hidden row's id does not read it either", async () => {
    const attempt = await request.patch("/api/notifications/read", {
      headers: MEMBER_AUTH,
      data: { id: hiddenId },
    });
    expect(attempt.status()).toBe(200);

    const hidden = await (await db())
      .collection("notifications")
      .findOne({ _id: written.insertedIds[0] });
    expect(hidden?.read).toBe(false);
    await expectUnreadBadge(member, 2);
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
      { title: LEGACY_TITLE, read: true },
    ]);
  });

  await memberContext.close();
});

/**
 * BP-433. An @mention naming somebody who cannot reach the board.
 *
 * `resolveMentions` looks a username up across the whole instance and knows nothing about grants —
 * by design, because deciding who may hear about a board belongs to one place. That place is
 * `recipientsWithAccess`, one call later, and nothing here proved it was in the path: every
 * account the fixture had held either a grant on this board or the instance-admin role, so a
 * mention could not be aimed at anybody the check would refuse.
 *
 * The control is in the same act rather than beside it. Both usernames are mentioned in one
 * comment, so both go into one dispatch — the member's row landing is what says the mention path
 * ran at all, and it is the same call that had to drop the stranger.
 */
test("a mention cannot reach somebody who has no grant on the board", async ({ browser }) => {
  await seedAssignmentOutsider();

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signIn(admin, ADMIN_USERNAME, ADMIN_PASSWORD);
  await admin.goto(TASK_URL);
  await expect(admin.getByText(TASK_KEY).first()).toBeVisible();

  await comment(admin, `@${MEMBER_USERNAME} @${OUTSIDER_USERNAME} either of you free for this?`);

  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  await signIn(member, MEMBER_USERNAME, MEMBER_PASSWORD);

  await test.step("the person with a grant is told", async () => {
    await expectUnreadBadge(member, 1);
    await expectFeed(member, { carries: [MENTIONED], omits: [] });
  });

  // Measured at the source. The stranger has no board to open and no screen to check, and an empty
  // feed would in any case be indistinguishable from a session that had not loaded one.
  await test.step("the stranger has nothing written for them at all", async () => {
    expect(
      await (await db()).collection("notifications").countDocuments({ recipient: OUTSIDER_ID })
    ).toBe(0);
  });

  await memberContext.close();
  await adminContext.close();
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
