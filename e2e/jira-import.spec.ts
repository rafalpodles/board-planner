import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, MEMBER_USERNAME, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";
import { zip } from "./zip";

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

const card = (page: Page) => page.locator("section").filter({ has: page.getByLabel("Import file (CSV, Excel, Jira XML or JSON)") });

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
  await page.getByLabel("Import file (CSV, Excel, Jira XML or JSON)").setInputFiles({ name: "Jira.csv", mimeType: "text/csv", buffer: Buffer.from(JIRA) });

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
    .getByLabel("Import file (CSV, Excel, Jira XML or JSON)")
    .setInputFiles({ name: "Jira (1).csv", mimeType: "text/csv", buffer: Buffer.from(JIRA.replace("Sign in with Google", "Sign in with Google and GitHub")) });
  await expect(page.getByLabel("Source name")).toHaveValue("Jira");
  await expect(mapping.getByLabel("Assignee “Maya Kowalska”")).toHaveValue(MEMBER_USERNAME);
  await expect(mapping.getByLabel("Comment (column 17)")).toHaveValue("comment");
  await expect(mapping.getByLabel("Labels (column 14)")).toHaveValue("field:Labels");
  await press(page, "Check");
  await expect(report).toContainText("Would create 0 and would update 2 of 2 tasks from Jira, with 2 comments.");
  await press(page, "Import");
  const again = await imported();
  expect(again.map((t) => t.title)).toEqual(["Export invoices as CSV", "Sign in with Google and GitHub"]);
  expect(await (await db()).collection("comments").countDocuments({ task: invoices._id })).toBe(2);
});

const xmlEscape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

test("a Jira Excel export imports through the same mapping, its wiki text turned into Markdown", async ({ page }) => {
  const headers = ["Summary", "Issue key", "Issue id", "Issue Type", "Status", "Priority", "Created", "Description", "Parent", "Parent key"];
  const values = ["Excel issue", "ORB-40", "10040", "Story", "Done", "Normal", "18/Aug/26 10:16 AM", "h2. Context\nThe {{Repo}} is *fast*.\n* one\n* two", "10001", "ORB-1"];
  const row = (cells: string[]) => `<row>${cells.map((c) => `<c s="2" t="str"><v>${xmlEscape(c)}</v></c>`).join("")}</row>`;
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const workbook = zip({
    "xl/workbook.xml": `<?xml version="1.0"?><workbook ${ns}><sheets><sheet name="Work Item Fields ORB-40" sheetId="1" r:id="rId2"/><sheet name="Work Item Activity ORB-40" sheetId="2" r:id="rId3"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Target="worksheets/sheet2.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<worksheet ${ns}><sheetData>${row(headers)}${row(values)}</sheetData></worksheet>`,
    "xl/worksheets/sheet2.xml": `<worksheet ${ns}><sheetData>${row(["Type", "Author"])}${row(["HISTORY", "someone"])}</sheetData></worksheet>`,
  });

  await signIn(page, "owner");
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=import`);
  await page.getByLabel("Import file (CSV, Excel, Jira XML or JSON)").setInputFiles({
    name: "ORB-40_Export_15-10-2026.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(workbook),
  });
  const mapping = page.getByTestId("csv-mapping");
  await expect(mapping).toContainText("1 rows, 10 columns. Recognised as a Jira export.");
  await expect(mapping.getByLabel("Parent key", { exact: true })).toHaveValue("parent");
  await expect(mapping.getByLabel("Parent", { exact: true })).toHaveValue("ignore");

  await press(page, "Check");
  const report = page.getByTestId("import-report");
  await expect(report.locator("details", { hasText: "Not imported" })).toContainText("ORB-40: parent");
  await press(page, "Import");
  await expect(report).toContainText("Created 1");
  const [task] = await (await db()).collection("tasks").find({ project: PROJECT_ID, "externalRef.id": "ORB-40" }).toArray();
  expect(task).toMatchObject({
    title: "Excel issue",
    status: "done",
    priority: "medium",
    description: "## Context\nThe `Repo` is **fast**.\n- one\n- two",
    createdAt: new Date("2026-08-18T10:16:00Z"),
  });
});

test("a Jira XML export imports with its comments named by their authors and its HTML turned into Markdown", async ({ page }) => {
  const html = (text: string) => xmlEscape(text);
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<!-- RSS generated by JIRA -->
<rss version="0.92"><channel><title>Jira</title>
<item>
  <title>[ORB-50] XML issue</title>
  <description>${html("<h2>Context</h2><p>The <tt>Repo</tt> is <b>fast</b>.</p><ul><li>one</li></ul>")}</description>
  <key id="10050">ORB-50</key>
  <summary>XML issue</summary>
  <type id="1">Story</type>
  <parent id="10001">ORB-1</parent>
  <priority id="1">Highest</priority>
  <status id="5">Done</status>
  <assignee accountid="712020:aaa">Maya Kowalska</assignee>
  <reporter accountid="712020:bbb">Jan Nowak</reporter>
  <labels><label>billing</label></labels>
  <created>Tue, 18 Aug 2026 10:16:16 +0200</created>
  <resolved>Fri, 21 Aug 2026 14:58:19 +0200</resolved>
  <comments><comment id="1" author="712020:bbb" created="Wed, 19 Aug 2026 09:00:00 +0200">${html("<p>Ship it</p>")}</comment></comments>
</item>
</channel></rss>`;

  await signIn(page, "owner");
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=import`);
  await page.getByLabel("Import file (CSV, Excel, Jira XML or JSON)").setInputFiles({ name: "SearchRequest.xml", mimeType: "text/xml", buffer: Buffer.from(xml) });
  const mapping = page.getByTestId("csv-mapping");
  await expect(mapping).toContainText("Recognised as a Jira export.");
  await expect(page.getByLabel("Source name")).toHaveValue("Jira");
  await mapping.getByLabel("Assignee “Maya Kowalska”").selectOption(MEMBER_USERNAME);

  await press(page, "Check");
  await press(page, "Import");
  await expect(page.getByTestId("import-report")).toContainText("Created 1");
  const [task] = await (await db()).collection("tasks").find({ project: PROJECT_ID, "externalRef.id": "ORB-50" }).toArray();
  expect(task).toMatchObject({
    priority: "urgent",
    status: "done",
    description: "## Context\n\nThe `Repo` is **fast**.\n\n- one",
    createdAt: new Date("2026-08-18T08:16:16Z"),
  });
  expect(task.customFieldValues[String(LABELS_FIELD)]).toEqual(["lbl-billing"]);
  const [comment] = await (await db()).collection("comments").find({ task: task._id }).toArray();
  expect([comment.body, comment.createdAt.toISOString()]).toEqual(["*Originally by Jan Nowak*\n\nShip it", "2026-08-19T07:00:00.000Z"]);
});
