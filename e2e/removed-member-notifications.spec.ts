import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  E2E_MONGODB_URI,
  MEMBER_ID,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  PROJECT_KEY,
  SIBLING_TASK_NUMBER,
  seed,
} from "./seed";
import { signIn as arriveSignedIn, signInThroughForm } from "./session";

const TASK_PATH = `/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;

const signIn = (page: Page, username: string, password: string) =>
  username === ADMIN_USERNAME
    ? arriveSignedIn(page)
    : username === MEMBER_USERNAME
      ? arriveSignedIn(page, "member")
      : signInThroughForm(page, username, password);

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

async function expectFeedToCarry(page: Page, excerpt: string) {
  await expect(async () => {
    await page.goto("/notifications");
    await expect(page.getByText(excerpt).first()).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
}

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function expectNothingReachesThem(page: Page) {
  const handle = await db();
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const rows = await handle
      .collection("notifications")
      .countDocuments({ recipient: MEMBER_ID });
    expect(rows, "a notification was written for somebody removed from the board").toBe(0);
    await page.waitForTimeout(500);
  }

  await page.goto("/notifications");
  await expect(page.getByText("No notifications yet.")).toBeVisible();
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

  await signIn(member, MEMBER_USERNAME, MEMBER_PASSWORD);
  await member.goto("/notifications");
  await comment(member, "I can take this one");

  await signIn(admin, ADMIN_USERNAME, ADMIN_PASSWORD);
  await comment(admin, "Thanks, it is yours");

  await expectFeedToCarry(member, "Thanks, it is yours");

  await admin.goto(`/projects/${PROJECT_KEY}/settings`);
  await admin.getByLabel(`Access for ${MEMBER_USERNAME}`).selectOption("none");
  await expect(admin.getByLabel(`Access for ${MEMBER_USERNAME}`)).toHaveCount(0);

  await expectNothingReachesThem(member);
  await expect(member.getByText("Thanks, it is yours")).toHaveCount(0);

  await comment(admin, "Reassigning this, since they are gone");

  await expectNothingReachesThem(member);
  await expect(member.getByText("Reassigning this, since they are gone")).toHaveCount(0);

  await memberContext.close();
  await adminContext.close();
});

test("a member who still holds the board keeps hearing about it", async ({ browser }) => {
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
