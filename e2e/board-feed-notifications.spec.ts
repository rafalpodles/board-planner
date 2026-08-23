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

/**
 * BP-402. The fifth row of the notification grid is the only one whose recipients are not derived
 * from a task: nobody is an assignee or a watcher of a task that has just been created, so the
 * tick itself has to select the audience.
 *
 * Driven through both browsers because the tick and the delivery are two different people on two
 * different screens, and everything interesting lives between them. A test that wrote the grid
 * with a PUT would prove the storage shape and nothing about whether the checkbox on the project's
 * Notifications page is wired to the cell the dispatcher searches for.
 *
 * The bystander is the control, and does more work than the assertion it supports: they hold a
 * grant on the same board and are in the same audience query, so their silence separates "the
 * opt-in decides" from "nothing was delivered to anybody in this environment".
 */

const SETTINGS = `/projects/${PROJECT_KEY}/settings`;
const CREATED_TITLE = "Bounded fan-out for the board feed";
const PROJECT_ROW = "Anybody creates a task on this board";
const GLOBAL_ROW = "Anybody creates a task on a board";

async function signIn(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);
}

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

/**
 * Ticks the row on the project's own grid.
 *
 * Both writes are waited for at the response, not at the render. The override switch saves as soon
 * as it is ticked and Save sends a second PUT; a click that raced either one left the grid the
 * dispatcher reads still holding the old cell, and the notification under test then had no
 * subscriber — a silence indistinguishable from the bug.
 */
async function subscribeToTheBoard(page: Page) {
  await page.goto(SETTINGS);
  await page.getByRole("button", { name: "Notifications", exact: true }).first().click();

  const cell = page.getByRole("checkbox", { name: `${PROJECT_ROW} — In app` });
  await expect(cell).toBeVisible();
  // Disabled until the reader takes this board off the global grid, which is what the switch means
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

/** Creates a task on the board through the form anybody would use. */
async function createTask(page: Page, title: string) {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByRole("button", { name: "New task" }).click();

  const modal = page.getByRole("dialog", { name: "New Task" });
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

/**
 * Reloaded until it appears: creating a task answers before the notification write has finished —
 * deliberately, it is fire-and-forget — so a single load can beat it.
 */
async function expectFeedToCarry(page: Page, text: string) {
  await expect(async () => {
    await page.goto("/notifications");
    await expect(page.getByText(text).first()).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * Absence measured at the source rather than against a clock. A single load proves only that the
 * test was quicker than the write; the count is required to stay at zero for the whole window, so
 * a notification that lands late still fails this.
 */
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
  // Compiled once here rather than inside the first assertion that depends on it: a cold
  // Turbopack build of this route is slower than any wait that assertion should be allowed.
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

  // The control the row's whole design rests on. Same board, same grant, same audience query —
  // the only difference is the tick.
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
