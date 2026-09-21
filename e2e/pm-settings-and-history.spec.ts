import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_ID, E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-707. Three PM settings no spec had saved through the form, and the chat's older-messages
 * pager, which only appears on a thread longer than one page and so was never clicked.
 */

const SETTINGS_URL = `/projects/${PROJECT_KEY}/settings?section=pm`;
const PM_URL = `/projects/${PROJECT_KEY}/pm`;
const PAGE_SIZE = 50;
const THREAD_LENGTH = 62;

async function withDb<T>(fn: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await fn(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

const storedPm = () =>
  withDb(async (db) => (await db.collection("projects").findOne({ _id: PROJECT_ID }))?.pm ?? {});

const label = (n: number) => `history message ${String(n).padStart(2, "0")}`;

test.beforeEach(seed);

test("project context, tokens per day, the on/off switch and the review schedule are saved and read back", async ({ page }) => {
  const before = await storedPm();
  expect(before).toMatchObject({ enabled: true, contextNotes: "", autonomy: { dailyReview: false } });
  expect(before.dailyTokenCap ?? 0).toBe(0);
  await signIn(page, "admin");
  await page.goto(SETTINGS_URL);
  await expect(page.getByRole("heading", { name: "MCP connections" })).toBeVisible();

  const onOff = page.getByRole("switch", { name: "Run the PM agent on this project" });
  await expect(onOff).toBeChecked();
  await page.getByLabel("Project context").fill("Payments team; English only; ship on Thursdays.");
  await page.getByLabel("Tokens per day").fill("123456");
  await onOff.locator("xpath=ancestor::label[1]").click();
  await expect(onOff).not.toBeChecked();
  const review = page.getByRole("switch", { name: "Review the board on a schedule" });
  await expect(review).not.toBeChecked();
  await review.locator("xpath=ancestor::label[1]").click();
  await expect(review).toBeChecked();

  const saved = page.waitForResponse(
    (r) => r.request().method() === "PUT" && r.url().endsWith(`/api/projects/${PROJECT_KEY}`)
  );
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await saved).ok()).toBe(true);

  expect(await storedPm()).toMatchObject({
    enabled: false,
    contextNotes: "Payments team; English only; ship on Thursdays.",
    dailyTokenCap: 123456,
    autonomy: { dailyReview: true },
  });

  await page.reload();
  await expect(page.getByRole("heading", { name: "MCP connections" })).toBeVisible();
  await expect(page.getByLabel("Project context")).toHaveValue("Payments team; English only; ship on Thursdays.");
  await expect(page.getByLabel("Tokens per day")).toHaveValue("123456");
  await expect(page.getByRole("switch", { name: "Run the PM agent on this project" })).not.toBeChecked();
  await expect(page.getByRole("switch", { name: "Review the board on a schedule" })).toBeChecked();
});

test("a thread longer than a page shows its older messages only after Load older messages", async ({ page }) => {
  const start = Date.now() - 2 * 86_400_000;
  await withDb((db) =>
    db.collection("pmmessages").insertMany(
      Array.from({ length: THREAD_LENGTH }, (_, i) => ({
        _id: mongoose.Types.ObjectId.createFromTime(Math.floor(start / 1000) + i),
        project: PROJECT_ID,
        role: i % 2 === 0 ? "user" : "assistant",
        content: label(i + 1),
        actions: [],
        attachments: [],
        trigger: { type: "chat", taskKey: "" },
        triggeredBy: ADMIN_ID,
        createdAt: new Date(start + i * 1000),
      }))
    )
  );
  const oldest = THREAD_LENGTH - PAGE_SIZE;

  await signIn(page, "admin");
  await page.goto(PM_URL);
  await expect(page.getByText(label(THREAD_LENGTH), { exact: true })).toBeVisible();
  await expect(page.getByText(label(oldest + 1), { exact: true })).toBeVisible();
  await expect(page.getByText(label(oldest), { exact: true })).toHaveCount(0);
  await expect(page.getByText(label(1), { exact: true })).toHaveCount(0);

  const older = page.waitForResponse((r) => r.url().includes("/pm/messages?limit=50&before="));
  await page.getByRole("button", { name: "Load older messages" }).click();
  expect((await older).ok()).toBe(true);

  for (let n = 1; n <= oldest; n++) {
    await expect(page.getByText(label(n), { exact: true })).toBeVisible();
  }
  await expect(page.getByText(/^history message \d\d$/)).toHaveCount(THREAD_LENGTH);
  await expect(page.getByText(/^history message \d\d$/).first()).toHaveText(label(1));
  await expect(page.getByRole("button", { name: "Load older messages" })).toHaveCount(0);
});
