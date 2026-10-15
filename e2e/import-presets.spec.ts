import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-964: Asana's, GitHub Projects' and OpenProject's CSV exports are recognised and mapped already,
 * so the mapping step needs no hand work for their usual columns.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

const card = (page: Page) => page.locator("section").filter({ has: page.getByLabel("Import file (CSV, Excel, Jira XML or JSON)") });

async function press(page: Page, name: string) {
  const answered = page.waitForResponse((r) => r.url().endsWith("/import") && r.request().method() === "POST");
  await card(page).getByRole("button", { name, exact: true }).click();
  expect((await answered).status()).toBe(200);
}

async function upload(page: Page, name: string, text: string) {
  await page.getByLabel("Import file (CSV, Excel, Jira XML or JSON)").setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(text) });
}

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("an Asana export is recognised and imports with its sections and dependencies, under the source Asana", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=import`);
  await upload(
    page,
    "Launch_tasks.csv",
    [
      "Task ID,Created At,Completed At,Last Modified,Name,Section/Column,Assignee,Assignee Email,Start Date,Due Date,Tags,Notes,Projects,Parent task,Blocked By (Dependencies),Blocking (Dependencies)",
      "1200,2026-01-05,,2026-01-06,Pick a date,To Do,,,,,,,Launch,,,1201",
      "1201,2026-01-05,,2026-01-06,Write the brief,In Progress,,,,2026-02-01,,Notes here,Launch,,1200,",
    ].join("\n")
  );
  const mapping = page.getByTestId("csv-mapping");
  await expect(mapping).toContainText("Recognised as an Asana export.");
  await expect(page.getByLabel("Source name")).toHaveValue("Asana");
  await expect(mapping.getByLabel("Section/Column", { exact: true })).toHaveValue("status");
  await expect(mapping.getByLabel("Blocked By (Dependencies)", { exact: true })).toHaveValue("blockedBy");

  await press(page, "Check");
  await expect(page.getByTestId("import-report")).toContainText("Would create 2 and would update 0 of 2 tasks from Asana, with 0 comments, and 1 new link between tasks.");
  await press(page, "Import");
  const [date, brief] = await (await db()).collection("tasks").find({ project: PROJECT_ID, "externalRef.source": "Asana" }).sort({ "externalRef.id": 1 }).toArray();
  expect([date.status, brief.status, brief.description]).toEqual(["todo", "in_progress", "Notes here"]);
  expect(brief.blockedBy.map(String)).toEqual([String(date._id)]);
});

test("a GitHub Projects export keeps each item by its URL, so a second export updates it", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=import`);
  const sheet = (title: string) => ["Title,URL,Assignees,Status,Labels,Repository", `${title},https://github.com/o/r/issues/7,,Done,,o/r`].join("\n");
  await upload(page, "Roadmap.csv", sheet("Fix login"));
  await expect(page.getByTestId("csv-mapping")).toContainText("Recognised as a GitHub Projects export.");
  await press(page, "Check");
  await press(page, "Import");
  await upload(page, "Roadmap (1).csv", sheet("Fix login on Safari"));
  await press(page, "Check");
  await expect(page.getByTestId("import-report")).toContainText("Would create 0 and would update 1 of 1 tasks from GitHub Projects");
  await press(page, "Import");
  const items = await (await db()).collection("tasks").find({ project: PROJECT_ID, "externalRef.source": "GitHub Projects" }).toArray();
  expect(items.map((t) => [t.externalRef.id, t.title, t.status])).toEqual([["https://github.com/o/r/issues/7", "Fix login on Safari", "done"]]);
});
