import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH, MEMBER_AUTH } from "./api";
import {
  ADMIN_ID,
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  AUDITOR_FULL_NAME,
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
import { signIn as arriveSignedIn, signInThroughForm } from "./session";

const TASK_KEY = `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`;
const TASK_URL = `/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;

const ADMIN_FULL_NAME = "E2E Admin";

const ASSIGNED = `${TASK_KEY} assigned to you`;
const COMMENTED = `New comment on ${TASK_KEY}`;
const MENTIONED = `${ADMIN_USERNAME} mentioned you in ${TASK_KEY}`;
const KEPT_ASSIGNED = `${KEPT_TASK_KEY} assigned to you`;

test.beforeEach(seed);

const signIn = (page: Page, username: string, password: string) =>
  username === ADMIN_USERNAME
    ? arriveSignedIn(page)
    : username === MEMBER_USERNAME
      ? arriveSignedIn(page, "member")
      : signInThroughForm(page, username, password);

async function warmNotificationRoutes(page: Page) {
  const answered = Promise.all(
    ["/api/notifications", "/api/notifications/unread-count"].map((pathname) =>
      page.waitForResponse((r) => new URL(r.url()).pathname === pathname, { timeout: 120_000 })
    )
  );
  await page.goto("/notifications");
  await answered;
}

function bell(page: Page) {
  return page.locator('a[href="/notifications"]').first();
}

const badgeText = (count: number) =>
  count === 0 ? /^Notifications$/ : new RegExp(`^Notifications\\s*${count}$`);

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

function feedRow(page: Page, title: string) {
  return page.getByRole("link", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
}

async function expectFeedRows(page: Page, titles: string[], omits: string[] = []) {
  await expect(async () => {
    await page.goto("/notifications");
    const rows = page.locator("#main-content").locator(`a[href="${TASK_URL}"]`);
    await expect(rows).toHaveCount(titles.length, { timeout: 3_000 });
    expect((await rows.allInnerTexts()).map((t) => t.split("\n")[0])).toEqual(titles);
    for (const title of omits) {
      await expect(page.getByText(title)).toHaveCount(0);
    }
  }).toPass({ timeout: 30_000 });
}

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
    await comment(admin, `@${MEMBER_USERNAME} anything blocking this?`);
  });

  await test.step("all three reach the member's badge and feed", async () => {
    await expectUnreadBadge(member, 3);
    await expectFeedRows(member, [MENTIONED, COMMENTED, ASSIGNED]);
    await expect(member.getByText("3 unread")).toBeVisible();

    for (const title of [ASSIGNED, COMMENTED, MENTIONED]) {
      await expect(feedRow(member, title)).toHaveAttribute("href", TASK_URL);
      await expect(unreadDot(member, title)).toHaveCount(1);
    }
    await expect(feedRow(member, ASSIGNED)).toContainText(ADMIN_FULL_NAME);
  });

  await test.step("the person who caused all three hears nothing about their own work", async () => {
    await expectUnreadBadge(admin, 0);
    await expect(admin.getByText("No notifications yet.")).toBeVisible();
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

  await test.step("opening it read that row and left the other two alone", async () => {
    await expectUnreadBadge(member, 2);
    await expect(member.getByText("2 unread")).toBeVisible();
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

    await expectUnreadBadge(member, 0);
    await expect(member.getByText("All caught up")).toBeVisible();
    await expect(member.getByRole("button", { name: "Mark all as read" })).toHaveCount(0);

    await expect(feedRow(member, ASSIGNED)).toBeVisible();
    await expect(feedRow(member, MENTIONED)).toBeVisible();
    await expect(unreadDot(member, ASSIGNED)).toHaveCount(0);
  });

  await memberContext.close();
  await adminContext.close();
});

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

  await assign(request, SIBLING_TASK_ID, AUDITOR_USERNAME, ADMIN_AUTH);
  await assign(request, KEPT_TASK_ID, AUDITOR_USERNAME, ADMIN_AUTH, SECOND_PROJECT_KEY);

  await test.step("while they are an admin both boards reach them", async () => {
    await expectUnreadBadge(auditor, 2);
    await expectFeed(auditor, { carries: [ASSIGNED, KEPT_ASSIGNED], omits: [] });
  });

  await test.step("the admin demotes them to a plain member", async () => {
    await admin.goto("/settings/users");
    await admin.getByText(`@${AUDITOR_USERNAME}`, { exact: true }).first().click();
    await expect(admin.getByText(`Edit ${AUDITOR_FULL_NAME}`)).toBeVisible();
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

  await test.step("and the row is still in the collection, unread, waiting for the digest", async () => {
    const rows = await (await db())
      .collection("notifications")
      .find({ recipient: AUDITOR_ID })
      .toArray();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => ({ project: String(r.project), read: r.read }))).toContainEqual({
      project: String(PROJECT_ID),
      read: false,
    });
  });

  await auditorContext.close();
  await adminContext.close();
});

test("a row can only be read by the person it was addressed to", async ({ browser, request }) => {
  const memberContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const member = await memberContext.newPage();
  const admin = await adminContext.newPage();

  await signIn(member, MEMBER_USERNAME, MEMBER_PASSWORD);
  await signIn(admin, ADMIN_USERNAME, ADMIN_PASSWORD);
  await warmNotificationRoutes(member);
  await warmNotificationRoutes(admin);

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

  await test.step("an id that is not one is refused instead of being cast", async () => {
    for (const id of ["nope", { $ne: null }]) {
      const attempt = await request.patch("/api/notifications/read", {
        headers: ADMIN_AUTH,
        data: { id },
      });
      expect(attempt.status(), await attempt.text()).toBe(400);
    }
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
      stored(LEGACY_TITLE, {}),
    ]);
  const hiddenId = String(written.insertedIds[0]);

  await assign(request, SIBLING_TASK_ID, MEMBER_USERNAME, ADMIN_AUTH);

  await test.step("the bell counts two of the three, and lists those two", async () => {
    await expectUnreadBadge(member, 2);
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
