import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, FIELDS, MEMBER_USERNAME, PROJECT_ID, PROJECT_KEY, seed, seedCustomFields } from "./seed";
import { signIn } from "./session";

/**
 * BP-864: a spreadsheet goes through a mapping step into the import engine — a semicolon file from
 * Polish Excel with a byte-order mark and a cell over several lines, statuses mapped to columns or
 * made into new ones, people found by e-mail, and a second upload of the same file updating rather
 * than duplicating.
 */

const MEMBER_EMAIL = "member.csv@example.com";
// The source is named after the file unless changed, so two unrelated sheets do not update each other
const SOURCE = "eksport";

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

const CSV = [
  '"Klucz";Tytuł;Status;Przypisany;Termin;Difficulty;Opis',
  `X-1;Zażółć gęślą jaźń;Do zrobienia;${MEMBER_EMAIL};15.10.2027;L;"Pierwsza linia`,
  `druga; ze średnikiem"`,
  "X-2;Second task;Done;ghost@example.com;;S;",
  "X-3;Waiting on a vendor;Czeka na dostawcę;;;;",
  "X-4;=HYPERLINK(\"http://evil.example\",\"x\");Done;Jan Nowak;;;",
  "X-5;Parked;Odłożone;Old Colleague;;;",
].join("\r\n");

const file = (text: string) => ({
  name: "eksport.csv",
  mimeType: "text/csv",
  buffer: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf-8")]),
});

async function tasks() {
  return (await db())
    .collection("tasks")
    .find({ project: PROJECT_ID, "externalRef.source": SOURCE })
    .sort({ "externalRef.id": 1 })
    .toArray();
}

const card = (page: Page) => page.locator("section").filter({ has: page.getByLabel("Import file (CSV, Excel, Jira XML or JSON)") });

async function check(page: Page) {
  const answered = page.waitForResponse((r) => r.url().endsWith("/import") && r.request().method() === "POST");
  await card(page).getByRole("button", { name: "Check" }).click();
  expect((await answered).status()).toBe(200);
}

async function importIt(page: Page) {
  const answered = page.waitForResponse((r) => r.url().endsWith("/import") && r.request().method() === "POST");
  await card(page).getByRole("button", { name: "Import", exact: true }).click();
  expect((await answered).status()).toBe(200);
}

test.beforeEach(async () => {
  await seed();
  await seedCustomFields();
  await (await db()).collection("users").updateOne({ username: MEMBER_USERNAME }, { $set: { email: MEMBER_EMAIL } });
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("a semicolon Excel file maps its columns, statuses and people, imports, and a second upload updates it", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=import`);
  await page.getByLabel("Import file (CSV, Excel, Jira XML or JSON)").setInputFiles(file(CSV));

  const mapping = page.getByTestId("csv-mapping");
  await expect(mapping).toContainText("5 rows, 7 columns.");
  // Guessed from Polish headers and the board's own field names
  await expect(mapping.getByLabel("Klucz", { exact: true })).toHaveValue("id");
  await expect(mapping.getByLabel("Tytuł", { exact: true })).toHaveValue("title");
  await expect(mapping.getByLabel("Przypisany", { exact: true })).toHaveValue("assignee");
  await expect(mapping.getByLabel("Termin", { exact: true })).toHaveValue("dueDate");
  await expect(mapping.getByLabel("Difficulty", { exact: true })).toHaveValue(`field:${FIELDS.difficulty.name}`);
  await expect(mapping.getByLabel("Opis", { exact: true })).toHaveValue("description");

  await expect(mapping.getByLabel("Status “Done”")).toHaveValue("done");
  await mapping.getByLabel("Status “Do zrobienia”").selectOption("todo");
  // A status with no column is offered one, never made silently
  await mapping.getByLabel("Kind of column for “Czeka na dostawcę”").selectOption("blocked");
  const added = page.waitForResponse((r) => r.url().endsWith("/columns") && r.request().method() === "POST");
  await mapping.getByRole("button", { name: "Add column “Czeka na dostawcę”" }).click();
  expect((await added).status()).toBe(201);
  const column = await (await db()).collection("projects").findOne({ _id: PROJECT_ID });
  const vendor = column!.columns.find((c: { label: string }) => c.label === "Czeka na dostawcę");
  expect(vendor).toMatchObject({ role: "blocked" });
  await expect(mapping.getByLabel("Status “Czeka na dostawcę”")).toHaveValue(vendor.id);
  // The rest of the page knows the new column too: saving Board afterwards must not drop it
  await page.getByRole("button", { name: /^Board\b/ }).first().click();
  await expect
    .poll(() => page.locator("input:visible").evaluateAll((inputs) => inputs.map((i) => (i as HTMLInputElement).value)))
    .toContain("Czeka na dostawcę");
  await page.getByRole("button", { name: /^Import\b/ }).first().click();

  // People: one picked from the members, one deliberately left unassigned, one found by e-mail
  await mapping.getByLabel("Person “Jan Nowak”").selectOption(MEMBER_USERNAME);
  await mapping.getByLabel("Person “Old Colleague”").selectOption({ label: "Not on this board (left unassigned, named in comments)" });

  await check(page);
  const report = page.getByTestId("import-report");
  await expect(report).toContainText("Would create 5 and would update 0 of 5 tasks from eksport");
  const nobody = report.locator("details", { hasText: "People with no account here" });
  await expect(nobody).toContainText("ghost@example.com");
  await expect(nobody).not.toContainText("Old Colleague");
  await expect(nobody).not.toContainText("Jan Nowak");
  await expect(report.locator("details", { hasText: "Statuses with no column" })).toContainText("Odłożone");
  expect(await tasks()).toHaveLength(0);

  await importIt(page);
  await expect(report).toContainText("Created 5 and updated 0 of 5 tasks");
  await expect(report.locator("details", { hasText: "Statuses with no column" })).toContainText("Odłożone");
  const imported = await tasks();
  const member = await (await db()).collection("users").findOne({ username: MEMBER_USERNAME });
  expect(
    imported.map((t) => [t.externalRef.id, t.title, t.status, String(t.assignee), t.dueDate?.toISOString() ?? null])
  ).toEqual([
    ["X-1", "Zażółć gęślą jaźń", "todo", String(member!._id), "2027-10-15T00:00:00.000Z"],
    ["X-2", "Second task", "done", "null", null],
    ["X-3", "Waiting on a vendor", vendor.id, "null", null],
    ["X-4", '=HYPERLINK("http://evil.example","x")', "done", String(member!._id), null],
    ["X-5", "Parked", "planned", "null", null],
  ]);
  expect(imported[0].description).toBe("Pierwsza linia\ndruga; ze średnikiem");
  expect(imported[0].customFieldValues[String(FIELDS.difficulty._id)]).toBe("aa-large");

  // The same shape again: the mapping is remembered and nothing is made twice
  await page.reload();
  await page.getByLabel("Import file (CSV, Excel, Jira XML or JSON)").setInputFiles(file(CSV.replace("Second task;Done;", "Second task, renamed;;")));
  await expect(mapping.getByLabel("Status “Do zrobienia”")).toHaveValue("todo");
  await check(page);
  await expect(report).toContainText("Would create 0 and would update 5 of 5 tasks from eksport");
  await importIt(page);
  await expect(report).toContainText("Created 0 and updated 5 of 5 tasks");
  const again = await tasks();
  expect(again).toHaveLength(5);
  expect(again[1].title).toBe("Second task, renamed");
  // A row whose status cell is now empty leaves its task in the column it is in
  expect(again[1].status).toBe("done");

  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByText("Zażółć gęślą jaźń").first()).toBeVisible();
});

test("a file with no title column cannot be checked, and one with no id column is added again by a re-upload", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=import`);
  await page.getByLabel("Import file (CSV, Excel, Jira XML or JSON)").setInputFiles(file("Name,Owner\nOne,someone\n"));

  const mapping = page.getByTestId("csv-mapping");
  await expect(mapping).toContainText("No ID column");
  await mapping.getByLabel("Name", { exact: true }).selectOption("ignore");
  await expect(mapping).toContainText("Choose the column that holds each task's title.");
  await expect(card(page).getByRole("button", { name: "Check" })).toBeDisabled();

  await mapping.getByLabel("Name", { exact: true }).selectOption("title");
  await check(page);
  await expect(page.getByTestId("import-report")).toContainText("Would create 1 and would update 0 of 1 tasks");
  await importIt(page);
  await expect(page.getByTestId("import-report")).toContainText("Created 1 and updated 0 of 1 tasks");

  await page.getByLabel("Import file (CSV, Excel, Jira XML or JSON)").setInputFiles(file("Name,Owner\nOne,someone\n"));
  await check(page);
  await expect(page.getByTestId("import-report")).toContainText("Would create 1 and would update 0 of 1 tasks");
});

test("a status mapped to another column goes there, even though a column has its name", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=import`);
  await page.getByLabel("Import file (CSV, Excel, Jira XML or JSON)").setInputFiles(file("ID,Title,Status\nP-1,Parked on purpose,Done\n"));
  const mapping = page.getByTestId("csv-mapping");
  await expect(mapping.getByLabel("Status “Done”")).toHaveValue("done");
  await mapping.getByLabel("Status “Done”").selectOption({ label: "Planned" });

  await check(page);
  const report = page.getByTestId("import-report");
  await expect(report).toContainText("Would create 1");
  await expect(report).not.toContainText("Statuses with no column");
  await importIt(page);
  await expect(report).toContainText("Created 1");
  expect((await tasks()).map((t) => t.status)).toEqual(["planned"]);
});

test("a sheet whose text holds an HTML table is read as the sheet it is", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=import`);
  await page
    .getByLabel("Import file (CSV, Excel, Jira XML or JSON)")
    .setInputFiles(file('ID,Title,Description\nH-1,Has a table,"<table><tr><td>cell</td></tr></table>"\n'));
  await expect(page.getByTestId("csv-mapping")).toContainText("1 rows, 3 columns.");
  await check(page);
  await expect(page.getByTestId("import-report")).toContainText("Would create 1");
});
