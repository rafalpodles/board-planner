import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, MEMBER_USERNAME, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-866: a Trello board's JSON export is recognised and goes through the mapping step. Lists land
 * in the columns picked for them, cards become tasks with their checklists, labels and comments,
 * what cannot be carried is in the report, and a later export updates the same tasks.
 */

const FILE_LABEL = "Import file (CSV, Excel, Jira XML or JSON)";
const BOARD = readFileSync(new URL("../src/lib/import/__fixtures__/trello-board.json", import.meta.url), "utf8");
const LABELS_FIELD = new mongoose.Types.ObjectId("e2e00000000000000000f866");

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

const imported = async () => (await db()).collection("tasks").find({ project: PROJECT_ID, "externalRef.source": "Trello" }).toArray();

const card = (page: Page) => page.locator("section").filter({ has: page.getByLabel(FILE_LABEL) });

async function press(page: Page, name: string) {
  const answered = page.waitForResponse((r) => r.url().endsWith("/import") && r.request().method() === "POST");
  await card(page).getByRole("button", { name, exact: true }).click();
  expect((await answered).status()).toBe(200);
}

const upload = (page: Page, json: string, name = "sample-board.json") =>
  page.getByLabel(FILE_LABEL).setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(json) });

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
            options: [{ id: "lbl-design", value: "design", color: "#6b7280", order: 0 }],
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

test("a Trello export imports through the mapping step, reports what it left behind, and a later export updates it", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=import`);
  await upload(page, BOARD);

  const mapping = page.getByTestId("csv-mapping");
  await expect(mapping).toContainText("9 rows, 9 columns. Recognised as a Trello export. Its 2 comments come with it. Its 6 checklist items come with it.");
  await expect(mapping.getByLabel("Trello card", { exact: true })).toHaveValue("id");
  await expect(mapping.getByLabel("Name", { exact: true })).toHaveValue("title");
  await expect(mapping.getByLabel("List", { exact: true })).toHaveValue("status");
  await expect(mapping.getByLabel("Members", { exact: true })).toHaveValue("assignee");
  await expect(mapping.getByLabel("Labels", { exact: true })).toHaveValue("field:Labels");
  await expect(page.getByLabel("Source name")).toHaveValue("Trello");

  // A list is matched to a column by a person, not by its name
  await mapping.getByLabel("Status “Backlog”").selectOption("todo");
  await mapping.getByLabel("Status “Doing”").selectOption("in_progress");
  await expect(mapping.getByLabel("Status “Done”")).toHaveValue("done");
  await mapping.getByLabel("Person “member1”").selectOption(MEMBER_USERNAME);

  await press(page, "Check");
  const report = page.getByTestId("import-report");
  await expect(report).toContainText("Would create 9 and would update 0 of 9 tasks from Trello, with 2 comments.");
  const left = report.locator("details", { hasText: "Not imported" });
  await expect(left).toContainText("Old ideas: an archived list, with its 1 card");
  await expect(left).toContainText("https://example.com/a-link-card: an archived card");
  await expect(left).toContainText("Audit log filter: 2 uploaded files: screenshot-3-0.png, screenshot-3-1.png");
  await expect(left).toContainText("Invoice export: the split into 2 checklists");
  await expect(left).toContainText("Backup restore: 673 of its 673 comments");
  await expect(left).toContainText("Single sign-on: its other members, as a task has one assignee: member2");
  await expect(report.locator("details", { hasText: "Statuses with no column" })).toContainText("Ideas");
  expect(await imported()).toHaveLength(0);

  await press(page, "Import");
  await expect(report).toContainText("Created 9 and updated 0 of 9 tasks from Trello");
  const tasks = await imported();
  expect(tasks).toHaveLength(9);
  expect(tasks.map((t) => t.title)).not.toContain("Mobile menu");

  const member = await (await db()).collection("users").findOne({ username: MEMBER_USERNAME });
  const byTitle = (title: string) => tasks.find((t) => t.title === title)!;
  const signOn = byTitle("Single sign-on");
  expect(String(signOn.assignee)).toBe(String(member!._id));
  expect(byTitle("Backup restore").status).toBe("done");
  expect(byTitle("Search by label").status).toBe("in_progress");
  expect(byTitle("Audit log filter").dueDate).toEqual(new Date("2017-04-12T00:00:00Z"));
  expect(byTitle("Webhook retries").customFieldValues[String(LABELS_FIELD)]).toEqual(["lbl-design"]);
  expect(byTitle("Rate limit banner").description).toContain("- [Design note 5](https://example.com/notes/5)");

  const invoice = byTitle("Invoice export");
  expect(invoice.checklist.map((i: { text: string; done: boolean }) => [i.text, i.done])).toEqual([
    ["Definition of done: Step 1", true],
    ["Definition of done: Step 2", false],
    ["Definition of done: Step 3", false],
    ["Rollout: Tell people 1", false],
    ["Rollout: Tell people 2", false],
    ["Rollout: Tell people 3", false],
  ]);

  const comments = await (await db()).collection("comments").find({ task: signOn._id }).sort({ createdAt: 1 }).toArray();
  expect(comments.map((c) => c.body)).toEqual(["*Originally by member2*\n\nComment 10 on this card.", "Comment 3 on this card."]);
  expect(String(comments[1].author)).toBe(String(member!._id));

  await page.goto(`/projects/${PROJECT_KEY}/tasks/${invoice.taskNumber}`);
  await expect(page.getByText("Definition of done: Step 1")).toBeVisible();
  await expect(page.getByText("Rollout: Tell people 3")).toBeVisible();

  // Exported again later, with a card renamed and a step ticked: nothing is made twice
  const later = JSON.parse(BOARD);
  later.cards.find((c: { name: string }) => c.name === "Single sign-on").name = "Single sign-on for everyone";
  later.checklists[0].checkItems[1].state = "complete";
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=import`);
  await upload(page, JSON.stringify(later), "sample-board (1).json");
  await expect(page.getByLabel("Source name")).toHaveValue("Trello");
  await expect(mapping.getByLabel("Status “Backlog”")).toHaveValue("todo");
  await press(page, "Check");
  await expect(report).toContainText("Would create 0 and would update 9 of 9 tasks from Trello, with 2 comments.");
  await press(page, "Import");
  await expect(report).toContainText("Created 0 and updated 9 of 9 tasks from Trello");

  const again = await imported();
  expect(again).toHaveLength(9);
  expect(again.map((t) => t.title)).toContain("Single sign-on for everyone");
  const reread = again.find((t) => String(t._id) === String(invoice._id))!;
  expect(reread.checklist[1]).toMatchObject({ text: "Definition of done: Step 2", done: true });
  expect(reread.checklist.every((i: { _id?: unknown }) => i._id)).toBe(true);
  expect(await (await db()).collection("comments").countDocuments({ task: signOn._id })).toBe(2);
});

test("a Trello export with nothing open says so, and a bundle in JSON is still read as a bundle", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=import`);

  const closed = JSON.parse(BOARD);
  for (const c of closed.cards) c.closed = true;
  await upload(page, JSON.stringify(closed));
  await expect(card(page).getByText("This Trello export holds no open cards.")).toBeVisible();
  await expect(page.getByTestId("csv-mapping")).toHaveCount(0);

  await upload(page, JSON.stringify({ source: "Script", tasks: [{ id: "1", title: "From a script" }] }), "bundle.json");
  await expect(card(page).getByText("This Trello export holds no open cards.")).toHaveCount(0);
  await expect(page.getByTestId("csv-mapping")).toHaveCount(0);
  await press(page, "Check");
  await expect(page.getByTestId("import-report")).toContainText("Would create 1 and would update 0 of 1 tasks from Script");
});
