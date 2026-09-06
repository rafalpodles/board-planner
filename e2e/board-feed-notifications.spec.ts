import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  BYSTANDER_ID,
  BYSTANDER_PASSWORD,
  BYSTANDER_USERNAME,
  E2E_MONGODB_URI,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  PROJECT_KEY,
  seed,
  seedBoardFeedBystander,
} from "./seed";
import { signIn as arriveSignedIn, signInThroughForm } from "./session";

const SETTINGS = `/projects/${PROJECT_KEY}/settings`;
const CREATED_TITLE = "Bounded fan-out for the board feed";
const PROJECT_ROW = "Anybody creates a task on this board";
const GLOBAL_ROW = "Anybody creates a task on a board";

const signIn = (page: Page, username: string, password: string) =>
  username === ADMIN_USERNAME
    ? arriveSignedIn(page)
    : username === MEMBER_USERNAME
      ? arriveSignedIn(page, "member")
      : signInThroughForm(page, username, password);

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function subscribeToTheBoard(page: Page) {
  await page.goto(SETTINGS);
  await page.getByRole("button", { name: "Notifications", exact: true }).first().click();

  const cell = page.getByRole("checkbox", { name: `${PROJECT_ROW} — In app` });
  await expect(cell).toBeVisible();
  await expect(cell).toBeDisabled();

  const overrideSaved = page.waitForResponse(
    (r) => r.request().method() === "PUT" && /\/notifications\//.test(new URL(r.url()).pathname)
  );
  await page.getByLabel("Use my own settings for this project").check();
  await overrideSaved;

  await cell.check();
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === "PUT" &&
      /\/notifications\//.test(new URL(r.url()).pathname) &&
      r.status() < 400
  );
  await page.getByRole("button", { name: "Save" }).click();
  await saved;
}

async function createTask(page: Page, title: string) {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByRole("button", { name: "New task" }).click();

  const modal = page.getByRole("dialog", { name: "New Task" });
  await expect(modal.getByPlaceholder("Describe what you need")).toBeVisible();
  await modal.getByLabel("Title").fill(title);

  const created = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname.endsWith("/tasks") &&
      r.status() < 400
  );
  await modal.getByRole("button", { name: "Create Task" }).click();
  await created;
}

async function expectFeedToCarry(page: Page, text: string) {
  await expect(async () => {
    await page.goto("/notifications");
    await expect(page.getByText(text).first()).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
}

async function expectNothingReaches(page: Page, recipient: mongoose.Types.ObjectId) {
  const handle = await db();
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const rows = await handle.collection("notifications").countDocuments({ recipient });
    expect(rows, "a task creation was announced to somebody who never asked for it").toBe(0);
    await page.waitForTimeout(500);
  }

  await page.goto("/notifications");
  await expect(page.getByText("No notifications yet.")).toBeVisible();
}

test.beforeEach(async () => {
  await seed();
  await seedBoardFeedBystander();
});

test("the board feed reaches the member who ticked the row and nobody else", async ({ browser }) => {
  const memberContext = await browser.newContext();
  const bystanderContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const member = await memberContext.newPage();
  const bystander = await bystanderContext.newPage();
  const admin = await adminContext.newPage();

  await signIn(member, MEMBER_USERNAME, MEMBER_PASSWORD);
  await member.goto("/notifications");

  await test.step("the row is on the global screen too, worded for a reader with many boards", async () => {
    await member.goto("/settings/notifications");
    await expect(
      member.getByRole("checkbox", { name: `${GLOBAL_ROW} — In app` })
    ).toBeVisible();
  });

  await test.step("the member subscribes to this board", async () => {
    await subscribeToTheBoard(member);
  });

  await signIn(bystander, BYSTANDER_USERNAME, BYSTANDER_PASSWORD);
  await bystander.goto("/notifications");

  await signIn(admin, ADMIN_USERNAME, ADMIN_PASSWORD);
  await createTask(admin, CREATED_TITLE);

  await test.step("the subscriber hears about a task nobody assigned them", async () => {
    await expectFeedToCarry(member, CREATED_TITLE);
  });

  await test.step("the member of the same board who ticked nothing hears nothing", async () => {
    await expectNothingReaches(bystander, BYSTANDER_ID);
  });

  await memberContext.close();
  await bystanderContext.close();
  await adminContext.close();
});

test.afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});
