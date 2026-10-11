import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  MEMBER_ID,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  OWNER_ID,
  OWNER_PASSWORD,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  seed,
} from "./seed";
import { signIn } from "./session";
import { taskFactory } from "./seed";

/**
 * BP-946. Export and erasure of one's own account were administrator-only, and erasing left the
 * person's name in places no screen links back to: the history keeps an assignee as a username, the
 * audit log keeps whoever did something, notifications and PM conversations keep addressing them.
 *
 * Driven from the Profile page as the person, then looked at from the other side: the database for
 * what still names them, and an administrator's view of the task they commented on.
 */

const COMMENT = "Written by the member before they left";
const ADMINS_COMMENT = "Written by somebody who stays";
const ADMINS_QUESTION = "A question the admin asked the PM";
const MEMBERS_TASK_NUMBER = 90;
const label = (id: unknown) => `deleted-${createHash("sha256").update(String(id)).digest("hex").slice(0, 8)}`;

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function seedWhatNamesTheMember() {
  const handle = await db();
  const now = new Date();
  await handle.collection("users").updateOne({ _id: MEMBER_ID }, { $set: { email: `${MEMBER_USERNAME}@example.com` } });
  await handle.collection("comments").insertOne({
    task: SIBLING_TASK_ID,
    author: MEMBER_ID,
    body: COMMENT,
    reactions: [],
    createdAt: now,
    updatedAt: now,
  });
  await handle.collection("comments").insertOne({
    task: SIBLING_TASK_ID,
    author: ADMIN_ID,
    body: ADMINS_COMMENT,
    reactions: [],
    createdAt: now,
    updatedAt: now,
  });
  await handle.collection("tasks").insertOne(
    taskFactory(now)({ _id: new mongoose.Types.ObjectId(), taskNumber: MEMBERS_TASK_NUMBER, title: "Made by the member", status: "todo", createdBy: MEMBER_ID })
  );
  await handle.collection("projectauditlogs").insertMany([
    { project: PROJECT_ID, user: ADMIN_ID, action: "member_added", detail: `${MEMBER_USERNAME}: no access → member`, createdAt: now },
    { project: PROJECT_ID, user: ADMIN_ID, action: "member_role_changed", detail: "olga: member → owner", createdAt: now },
  ]);
  await handle.collection("activitylogs").insertMany([
    { task: SIBLING_TASK_ID, user: ADMIN_ID, action: "updated", field: "assignee", oldValue: "", newValue: MEMBER_USERNAME, createdAt: now },
    { task: SIBLING_TASK_ID, user: ADMIN_ID, action: "updated", field: "assignee", oldValue: MEMBER_USERNAME, newValue: "admin", createdAt: now },
  ]);
  await handle.collection("notifications").insertMany([
    { recipient: MEMBER_ID, type: "mentioned", project: PROJECT_ID, actor: ADMIN_ID, title: "admin mentioned you", body: "", read: false, inApp: true, createdAt: now },
    { recipient: ADMIN_ID, type: "mentioned", project: PROJECT_ID, actor: MEMBER_ID, title: `${MEMBER_USERNAME} mentioned you`, body: "", read: false, inApp: true, createdAt: now },
  ]);
  await handle.collection("pmmessages").insertOne({
    project: PROJECT_ID,
    role: "user",
    content: "What is left on the board?",
    triggeredBy: MEMBER_ID,
    trigger: { type: "chat", taskKey: "" },
    createdAt: now,
  });
  await handle.collection("pmmessages").insertOne({
    project: PROJECT_ID,
    role: "user",
    content: ADMINS_QUESTION,
    triggeredBy: ADMIN_ID,
    trigger: { type: "chat", taskKey: "" },
    createdAt: now,
  });
  await handle.collection("instanceauditlogs").insertOne({
    user: MEMBER_ID,
    actorUsername: MEMBER_USERNAME,
    action: "user_email_changed_self",
    target: MEMBER_USERNAME,
    detail: "old@example.com → member@example.com",
    createdAt: now,
  });
}

test.beforeEach(async () => {
  await seed();
  await seedWhatNamesTheMember();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

async function openProfile(page: Page) {
  await page.goto("/settings/profile");
  await expect(page.getByRole("heading", { name: "Your data" })).toBeVisible();
}

function confirmation(page: Page) {
  return page.getByRole("dialog", { name: "Delete your account?" });
}

async function startDeleting(page: Page) {
  await page.getByRole("button", { name: "Delete my account" }).click();
  await expect(confirmation(page)).toBeVisible();
}

test("a person downloads their data, deletes their account, and nothing that names them is left", async ({ page }) => {
  await signIn(page, "member");
  await openProfile(page);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download my data" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(new RegExp(`^${MEMBER_USERNAME}-data-\\d{4}-\\d{2}-\\d{2}\\.json$`));
  const raw = readFileSync((await download.path())!, "utf8");
  const exported = JSON.parse(raw);
  expect(exported.account.username).toBe(MEMBER_USERNAME);
  expect(exported.comments).toEqual([expect.objectContaining({ task: `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`, body: COMMENT })]);
  expect(exported.pmMessages).toEqual([expect.objectContaining({ board: PROJECT_KEY, content: "What is left on the board?" })]);
  expect(exported.notifications).toHaveLength(1);
  expect(exported.tasksCreated).toEqual([expect.objectContaining({ key: `${PROJECT_KEY}-${MEMBERS_TASK_NUMBER}`, title: "Made by the member" })]);
  expect(exported.boardAccess).toEqual([expect.objectContaining({ board: PROJECT_KEY, relation: "member" })]);
  expect(raw).not.toMatch(/\$2[aby]\$/);
  for (const theirs of [ADMINS_COMMENT, ADMINS_QUESTION, `${MEMBER_USERNAME} mentioned you`]) expect(raw).not.toContain(theirs);

  await startDeleting(page);
  const dialog = confirmation(page);
  await expect(dialog.getByRole("button", { name: "Delete my account" })).toBeDisabled();
  await dialog.getByLabel("Current password").fill(MEMBER_PASSWORD);
  const [deletion] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === "/api/users/me" && r.request().method() === "DELETE"),
    dialog.getByRole("button", { name: "Delete my account" }).click(),
  ]);
  expect(deletion.status()).toBe(200);
  await expect(page).toHaveURL(/\/login/);

  const handle = await db();
  expect(await handle.collection("users").countDocuments({ _id: MEMBER_ID })).toBe(0);
  expect(await handle.collection("notifications").countDocuments({ $or: [{ recipient: MEMBER_ID }, { actor: MEMBER_ID }] })).toBe(0);
  expect(await handle.collection("pmmessages").countDocuments({ triggeredBy: MEMBER_ID })).toBe(0);
  expect(await handle.collection("sessions").countDocuments({ user: MEMBER_ID })).toBe(0);
  expect(await handle.collection("grants").countDocuments({ subject: MEMBER_ID })).toBe(0);
  const history = await handle.collection("activitylogs").find({ field: "assignee" }).toArray();
  expect(JSON.stringify(history)).not.toContain(`"${MEMBER_USERNAME}"`);
  expect(history.map((row) => row.newValue)).toContain("admin");
  const erased = label(MEMBER_ID);
  const audit = await handle.collection("instanceauditlogs").find({}).toArray();
  expect(JSON.stringify(audit)).not.toMatch(new RegExp(`"${MEMBER_USERNAME}"|${MEMBER_USERNAME}@example\\.com|old@example\\.com`));
  const rewritten = audit.find((row) => row.action === "user_email_changed_self");
  expect(rewritten).toMatchObject({ actorUsername: erased, target: erased, detail: erased });
  expect(audit.find((row) => row.action === "user_deleted")).toMatchObject({ target: erased, actorUsername: erased });
  const access = (await handle.collection("projectauditlogs").find({}).sort({ _id: 1 }).toArray()).map((row) => row.detail);
  expect(access).toEqual([`${erased}: no access → member`, "olga: member → owner"]);
  expect(await handle.collection("tasks").countDocuments({ taskNumber: MEMBERS_TASK_NUMBER, createdBy: MEMBER_ID })).toBe(1);

  await page.goto("/login");
  await page.getByLabel("Username").fill(MEMBER_USERNAME);
  await page.getByLabel("Password").fill(MEMBER_PASSWORD);
  const [attempt] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/login"),
    page.getByRole("button", { name: "Sign In" }).click(),
  ]);
  expect(attempt.status()).toBe(401);
  await expect(page).not.toHaveURL(/\/projects/);

  await signIn(page, "admin");
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
  const theirs = page.locator("div.group", { hasText: COMMENT });
  await expect(theirs).toBeVisible();
  await expect(theirs.getByText("Deleted user")).toBeVisible();
  await expect(page.locator("div.group", { hasText: ADMINS_COMMENT })).not.toContainText("Deleted user");
});

test("a wrong password keeps the account, and says so", async ({ page }) => {
  await signIn(page, "member");
  await openProfile(page);
  await startDeleting(page);
  const dialog = confirmation(page);
  await dialog.getByLabel("Current password").fill("not-the-password");
  const [refusal] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === "/api/users/me" && r.request().method() === "DELETE"),
    dialog.getByRole("button", { name: "Delete my account" }).click(),
  ]);
  expect(refusal.status()).toBe(400);
  await expect(dialog.getByRole("alert")).toHaveText("Current password is incorrect");
  expect(await (await db()).collection("users").countDocuments({ _id: MEMBER_ID })).toBe(1);
  expect(await (await db()).collection("notifications").countDocuments({ recipient: MEMBER_ID })).toBe(1);
});

test("the only owner of a board is told which one to hand over, and keeps the account", async ({ page }) => {
  await signIn(page, "owner");
  await openProfile(page);
  await startDeleting(page);
  const dialog = confirmation(page);
  await dialog.getByLabel("Current password").fill(OWNER_PASSWORD);
  const [refusal] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === "/api/users/me" && r.request().method() === "DELETE"),
    dialog.getByRole("button", { name: "Delete my account" }).click(),
  ]);
  expect(refusal.status()).toBe(409);
  await expect(dialog.getByRole("alert")).toContainText(`the only owner of ${PROJECT_NAME} (${PROJECT_KEY})`);
  expect(await (await db()).collection("users").countDocuments({ _id: OWNER_ID })).toBe(1);
});
