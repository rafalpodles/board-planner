import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-1059: an import's parents and blockers become the links a person makes on the board, between
 * tasks of this import or of an earlier one; what cannot be linked is listed, and a re-run adds none twice.
 */

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

const SHEET = ["ID,Title,Parent,Blocked by", "E-1,The epic,,", "E-2,A story,E-1,E-3", "E-3,The blocker,,", "E-4,An orphan,MISSING,"].join("\n");

const card = (page: Page) => page.locator("section").filter({ has: page.getByLabel("Import file (CSV, Excel, Jira XML or JSON)") });

async function press(page: Page, name: string) {
  const answered = page.waitForResponse((r) => r.url().endsWith("/import") && r.request().method() === "POST");
  await card(page).getByRole("button", { name, exact: true }).click();
  expect((await answered).status()).toBe(200);
}

async function byRef(ref: string) {
  return (await db()).collection("tasks").findOne({ project: PROJECT_ID, "externalRef.id": ref });
}

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("a sheet's parents and blockers become links, the one it cannot make is listed, and a re-run adds none twice", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=import`);
  const upload = () =>
    page.getByLabel("Import file (CSV, Excel, Jira XML or JSON)").setInputFiles({ name: "plan.csv", mimeType: "text/csv", buffer: Buffer.from(SHEET) });
  await upload();
  const mapping = page.getByTestId("csv-mapping");
  await expect(mapping.getByLabel("Parent", { exact: true })).toHaveValue("parent");
  await expect(mapping.getByLabel("Blocked by", { exact: true })).toHaveValue("blockedBy");

  await press(page, "Check");
  const report = page.getByTestId("import-report");
  await expect(report).toContainText("Would create 4 and would update 0 of 4 tasks from plan, with 0 comments, and 2 new links between tasks.");
  await expect(report.locator("details", { hasText: "Not imported" })).toContainText("E-4: parent “MISSING”: no such task in this file or an earlier import");

  await press(page, "Import");
  await expect(report).toContainText("Created 4 and updated 0 of 4 tasks from plan, with 0 comments, and 2 new links between tasks.");
  const [epic, story, blocker] = [await byRef("E-1"), await byRef("E-2"), await byRef("E-3")];
  expect(epic!.relations.map((r: { task: unknown; type: string }) => [String(r.task), r.type])).toEqual([[String(story!._id), "parent_of"]]);
  expect(story!.blockedBy.map(String)).toEqual([String(blocker!._id)]);

  // The task page shows them like any other link
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${story!.taskNumber}`);
  await expect(page.getByText(`${PROJECT_KEY}-${blocker!.taskNumber}`).first()).toBeVisible();
  await expect(page.getByText(`${PROJECT_KEY}-${epic!.taskNumber}`).first()).toBeVisible();

  // Again, the same file: everything updates, nothing is linked twice
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=import`);
  await upload();
  await press(page, "Check");
  await expect(report).toContainText("Would create 0 and would update 4 of 4 tasks from plan, with 0 comments.");
  await press(page, "Import");
  await expect(report).toContainText("Created 0 and updated 4");
  expect((await byRef("E-1"))!.relations).toHaveLength(1);
  expect((await byRef("E-2"))!.blockedBy).toHaveLength(1);
});
