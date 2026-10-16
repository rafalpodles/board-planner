import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { PM_STUB_URL, WEBHOOK_RECEIVER_URL } from "../playwright.config";
import { SAME_ORIGIN } from "./api";
import { E2E_MONGODB_URI, MEMBER_ID, PROJECT_ID, PROJECT_KEY, seed, taskFactory } from "./seed";
import { signIn } from "./session";
import { e2eLicence, useLicenceKey } from "./licence-key";

/**
 * BP-870: a standup, sprint or project summary is the board's own figures with a model's note around
 * them; a note that gives a figure of its own is left out; Free gets the upsell and a 402; a summary
 * posts to the team channel only as the server wrote it.
 */

const SUMMARIES = `/api/projects/${PROJECT_KEY}/summaries`;
const HOOK = "/summary-hook";

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

async function movedToday(taskNumber: number, title: string) {
  const handle = await db();
  const _id = new mongoose.Types.ObjectId();
  const now = new Date();
  await handle.collection("tasks").insertOne(taskFactory(new Date(now.getTime() - 3 * 86_400_000))({ _id, taskNumber, title, status: "in_review" }));
  await handle.collection("activitylogs").insertOne({
    task: _id,
    project: PROJECT_ID,
    user: MEMBER_ID,
    action: "status_changed",
    field: "status",
    oldValue: "in_progress",
    newValue: "in_review",
    createdAt: new Date(now.getTime() - 60 * 60 * 1000),
  });
}

async function openSummary(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByRole("button", { name: "Summary", exact: true }).click();
  return page.getByRole("dialog", { name: "Summary" });
}

async function write(dialog: ReturnType<Page["getByRole"]>, page: Page) {
  const answered = page.waitForResponse((r) => r.url().endsWith("/summaries") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: /^Write/ }).click();
  expect((await answered).status()).toBe(200);
  return dialog.getByTestId("summary");
}

test.beforeEach(async ({ request }) => {
  await seed();
  await useLicenceKey(request, undefined);
  await fetch(`${PM_STUB_URL}/reset`);
  await fetch(`${WEBHOOK_RECEIVER_URL}/reset`, { method: "POST" });
  await (await db()).collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { taskCounter: 900 } });
});

test.afterEach(async ({ request }) => {
  await useLicenceKey(request, undefined);
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("on Free the summary is an upsell and the route answers 402", async ({ page }) => {
  await signIn(page, "owner");
  const dialog = await openSummary(page);
  await expect(dialog.getByTestId("pro-upsell")).toContainText("AI summaries");
  const refused = await page.request.post(SUMMARIES, { headers: SAME_ORIGIN, data: { kind: "standup" } });
  expect(refused.status()).toBe(402);
  const postRefused = await page.request.post(`${SUMMARIES}/post`, { headers: SAME_ORIGIN, data: { sealed: "anything" } });
  expect(postRefused.status()).toBe(402);

  // On a phone the header has no room for a button that only offers an upgrade
  await page.setViewportSize({ width: 390, height: 780 });
  await page.reload();
  await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Summary", exact: true })).toBeHidden();
});

test("a standup is the board's figures with the model's note, and posts to the team channel as written", async ({ page, request }) => {
  await useLicenceKey(request, e2eLicence());
  await movedToday(801, "Export invoices as CSV");
  await signIn(page, "owner");
  const added = await page.request.post(`/api/projects/${PROJECT_KEY}/notifications`, {
    headers: SAME_ORIGIN,
    data: { type: "slack", name: "Team", webhookUrl: `${WEBHOOK_RECEIVER_URL}${HOOK}` },
  });
  expect(added.status(), await added.text()).toBeLessThan(300);

  const dialog = await openSummary(page);
  const summary = await write(dialog, page);
  await expect(summary).toContainText("Export invoices as CSV (TP-801)");
  await expect(summary).toContainText("Moves between columns in the last day: 1");
  await expect(summary).toContainText("Moved by");
  await expect(dialog.getByText("left out because it gave figures")).toHaveCount(0);
  const sent = await (await fetch(`${PM_STUB_URL}/last-write`)).json();
  expect(sent.tools).toBeNull();

  const posted = page.waitForResponse((r) => r.url().endsWith("/summaries/post"));
  await dialog.getByRole("button", { name: "Post to team channel" }).click();
  expect((await posted).status()).toBe(200);
  await expect(dialog.getByRole("status")).toContainText("Posted to the team channel.");
  await expect(dialog.getByRole("button", { name: "Posted" })).toBeDisabled();
  await expect(async () => {
    const all: { url: string; body: string }[] = await (await fetch(`${WEBHOOK_RECEIVER_URL}/deliveries`)).json();
    const delivery = all.find((d) => d.url === HOOK);
    expect(delivery?.body).toContain("Moves between columns in the last day: **1**");
  }).toPass({ timeout: 15_000 });

  // Only what the board wrote can be posted
  const forged = await page.request.post(`${SUMMARIES}/post`, { headers: SAME_ORIGIN, data: { sealed: "## Anything I like" } });
  expect(forged.status()).toBe(400);

  // A summary of something else is not the one just written, so nothing of it stays to be posted
  await dialog.getByLabel("Summary of").selectOption("project");
  await expect(dialog.getByTestId("summary")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Post|Posted/ })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 780 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Summary", exact: true })).toBeVisible();
});

test("a note that counts for itself is left out, and the board's figures stand alone", async ({ page, request }) => {
  await useLicenceKey(request, e2eLicence());
  // The stub repeats titles into its note, so this one brings a number the board never counted
  await movedToday(802, "Scale to 42 nodes");
  await signIn(page, "owner");
  const dialog = await openSummary(page);
  const summary = await write(dialog, page);
  await expect(dialog.getByText("The written note was left out because it gave figures of its own")).toBeVisible();
  await expect(summary).toContainText("Moves between columns in the last day: 1");
  await expect(summary).not.toContainText("Written by the stub");
});

test("a sprint's summary measures the sprint, from the Sprints page", async ({ page, request }) => {
  await useLicenceKey(request, e2eLicence());
  const sprintId = new mongoose.Types.ObjectId();
  const now = new Date();
  await (await db()).collection("sprints").insertOne({
    _id: sprintId,
    project: PROJECT_ID,
    name: "Sprint 870",
    goal: "",
    status: "active",
    startDate: new Date(now.getTime() - 7 * 86_400_000),
    endDate: new Date(now.getTime() + 7 * 86_400_000),
    createdAt: now,
    updatedAt: now,
  });
  await (await db()).collection("tasks").insertOne(taskFactory(now)({ taskNumber: 870, title: "In the sprint", status: "done", sprint: sprintId }));
  await signIn(page, "owner");
  await page.goto(`/projects/${PROJECT_KEY}/sprints?sprint=${sprintId}`);
  await page.getByRole("button", { name: "Sprint summary" }).click();
  const dialog = page.getByRole("dialog", { name: "Summary" });
  await expect(dialog.getByLabel("Sprint", { exact: true })).toHaveValue(String(sprintId));
  const summary = await write(dialog, page);
  await expect(summary).toContainText("Sprint status: Sprint 870");
  await expect(summary).toContainText("Tasks in the sprint: 1");
  await expect(summary).toContainText("Done: 1");
});
