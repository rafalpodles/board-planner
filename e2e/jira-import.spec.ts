import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, MEMBER_USERNAME, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-683: Jira's "Export → CSV (all fields)" is recognised and imports with its comments (their
 * times and a byline for authors with no account here), both label columns, Jira's dates and
 * priorities; the parent link is reported, and a second export of the same issues updates them.
 */

const LABELS_FIELD = new mongoose.Types.ObjectId("e2e00000000000000000f683");

const JIRA = [
  "Summary,Issue key,Issue id,Issue Type,Status,Priority,Assignee,Reporter,Created,Updated,Resolved,Due date,Labels,Labels,Description,Comment,Comment,Parent,Parent summary",
  'Export invoices as CSV,ORB-12,10012,Bug,Done,Highest,Maya Kowalska,Jan Nowak,15/Oct/25 9:30 AM,16/Oct/25 1:05 PM,16/Oct/25 1:05 PM,20/Oct/26,billing,urgent-fix,"Line 1\nLine 2","15/Oct/25 9:45 AM;712020:abc;First comment","16/Oct/25 12:05 PM;712020:def;Second; with a semicolon",10010,Billing epic',
  "Sign in with Google,ORB-13,10013,Story,To Do,Lowest,,Jan Nowak,01/Jan/26 12:00 PM,01/Jan/26 12:00 PM,,,,,,,,,",
].join("\n");

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

async function imported() {
  return (await db()).collection("tasks").find({ project: PROJECT_ID, "externalRef.source": "Jira" }).sort({ "externalRef.id": 1 }).toArray();
}

const card = (page: Page) => page.locator("section").filter({ has: page.getByLabel("Import file (CSV or JSON)") });

async function press(page: Page, name: string) {
  const answered = page.waitForResponse((r) => r.url().endsWith("/import") && r.request().method() === "POST");
  await card(page).getByRole("button", { name, exact: true }).click();
  expect((await answered).status()).toBe(200);
}

test.beforeEach(async () => {
  await seed();
  await (await db()).collection("projects").updateOne(
    { _id: PROJECT_ID },
    {
      $set: {
        customFields: [
          {
            _id: LABELS_FIELD,
            name: "Labels",
            fieldType: "multiselect",
            options: [
              { id: "lbl-billing", value: "billing", color: "#6b7280", order: 0 },
              { id: "lbl-urgent", value: "urgent-fix", color: "#6b7280", order: 1 },
            ],
            required: false,
            order: 0,
            showOnCard: false,
            showInList: false,
            filterable: false,
            archived: false,
          },
        ],
      },
    }
  );
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("a Jira export imports with comments, labels, dates and priorities, and a second export updates it", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=import`);
  await page.getByLabel("Import file (CSV or JSON)").setInputFiles({ name: "Jira.csv", mimeType: "text/csv", buffer: Buffer.from(JIRA) });

  const mapping = page.getByTestId("csv-mapping");
  await expect(mapping).toContainText("Recognised as a Jira export");
  await expect(mapping.getByLabel("Issue key", { exact: true })).toHaveValue("id");
  await expect(mapping.getByLabel("Resolved", { exact: true })).toHaveValue("completedAt");
  await expect(mapping.getByLabel("Comment (column 16)")).toHaveValue("comment");
  await expect(mapping.getByLabel("Comment (column 17)")).toHaveValue("comment");
  await expect(mapping.getByLabel("Labels (column 13)")).toHaveValue("field:Labels");
  await expect(mapping.getByLabel("Labels (column 14)")).toHaveValue("field:Labels");
  await expect(page.getByLabel("Source name")).toHaveValue("Jira");
  // Jira exports a display name, so the person is matched by hand
  await mapping.getByLabel("Assignee “Maya Kowalska”").selectOption(MEMBER_USERNAME);

  await press(page, "Check");
  const report = page.getByTestId("import-report");
  await expect(report).toContainText("Would create 2 and would update 0 of 2 tasks from Jira, with 2 comments.");
  await expect(report.locator("details", { hasText: "Not imported" })).toContainText("ORB-12: parent");
  expect(await imported()).toHaveLength(0);

  await press(page, "Import");
  await expect(report).toContainText("Created 2 and updated 0 of 2 tasks");
  const [invoices, google] = await imported();
  const member = await (await db()).collection("users").findOne({ username: MEMBER_USERNAME });
  expect(invoices).toMatchObject({
    title: "Export invoices as CSV",
    status: "done",
    priority: "urgent",
    category: "bug",
    description: "Line 1\nLine 2",
    createdAt: new Date("2025-10-15T09:30:00Z"),
    dueDate: new Date("2026-10-20T00:00:00Z"),
  });
  expect(String(invoices.assignee)).toBe(String(member!._id));
  expect(invoices.customFieldValues[String(LABELS_FIELD)]).toEqual(["lbl-billing", "lbl-urgent"]);
  expect(google).toMatchObject({ priority: "low", status: "todo", createdAt: new Date("2026-01-01T12:00:00Z") });

  const comments = await (await db()).collection("comments").find({ task: invoices._id }).sort({ createdAt: 1 }).toArray();
  expect(comments.map((c) => [c.body, c.createdAt.toISOString()])).toEqual([
    ["*Originally by 712020:abc*\n\nFirst comment", "2025-10-15T09:45:00.000Z"],
    ["*Originally by 712020:def*\n\nSecond; with a semicolon", "2025-10-16T12:05:00.000Z"],
  ]);
  const finish = await (await db()).collection("activitylogs").findOne({ task: invoices._id, action: "status_changed" });
  expect(finish!.createdAt.toISOString()).toBe("2025-10-16T13:05:00.000Z");

  // Exported again a week later: Jira names the file "Jira (1).csv", and nothing is made twice
  await page.reload();
  await page
    .getByLabel("Import file (CSV or JSON)")
    .setInputFiles({ name: "Jira (1).csv", mimeType: "text/csv", buffer: Buffer.from(JIRA.replace("Sign in with Google", "Sign in with Google and GitHub")) });
  await expect(page.getByLabel("Source name")).toHaveValue("Jira");
  await expect(mapping.getByLabel("Assignee “Maya Kowalska”")).toHaveValue(MEMBER_USERNAME);
  await press(page, "Check");
  await expect(report).toContainText("Would create 0 and would update 2 of 2 tasks from Jira");
  await press(page, "Import");
  const again = await imported();
  expect(again.map((t) => t.title)).toEqual(["Export invoices as CSV", "Sign in with Google and GitHub"]);
  expect(await (await db()).collection("comments").countDocuments({ task: invoices._id })).toBe(2);
});
