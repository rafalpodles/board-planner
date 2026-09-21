import { test, expect, type Locator, type Page, type Response } from "@playwright/test";
import mongoose from "mongoose";
import {
  E2E_MONGODB_URI,
  FIELDS,
  PROJECT_ID,
  PROJECT_KEY,
  SIBLING_TASK_NUMBER,
  seed,
  seedCustomFields,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-709, the half of it a person meets while writing a task: the Markdown toolbar, and the parts
 * of the new-task form no browser test had touched — the template picker as a whole, the checklist
 * input, the due date and the custom fields.
 *
 * Each control is read back twice: from Mongo, which is what was written, and from the task's own
 * page, which is what the next reader sees. The form's own state proves neither.
 */

const BOARD = `/projects/${PROJECT_KEY}`;
const TEMPLATE_NAME = "Release checklist";

async function withDb<T>(fn: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  const dbName = new URL(E2E_MONGODB_URI.replace(/^mongodb/, "http")).pathname.slice(1);
  if (!dbName.endsWith("_e2e")) throw new Error(`Refusing to touch database "${dbName}"`);
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await fn(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

const storedTask = (taskNumber: number) =>
  withDb((db) => db.collection("tasks").findOne({ project: PROJECT_ID, taskNumber }));

test.beforeEach(seed);

async function openNewTask(page: Page): Promise<Locator> {
  await signIn(page);
  await page.goto(BOARD);
  await page.getByRole("button", { name: "New task" }).click();
  const modal = page.getByRole("dialog", { name: "New Task" });
  await expect(modal.getByLabel("Title")).toBeVisible();
  return modal;
}

function taskCreated(page: Page): Promise<Response> {
  return page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/tasks")
  );
}

async function create(page: Page, modal: Locator): Promise<number> {
  const created = taskCreated(page);
  await modal.getByRole("button", { name: "Create Task" }).click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { taskNumber: number }).taskNumber;
}

/** Puts the caret, or a selection, where a person would have left it. */
async function select(textarea: Locator, from: number, to = from) {
  await textarea.evaluate(
    (el, [a, b]) => {
      const t = el as HTMLTextAreaElement;
      t.focus();
      t.setSelectionRange(a, b);
    },
    [from, to] as const
  );
}

async function caretAtEnd(textarea: Locator) {
  const length = (await textarea.inputValue()).length;
  await select(textarea, length);
}

test.describe("the Markdown toolbar", () => {
  test("every button, with a selection and at the caret, writes the Markdown the task then renders", async ({
    page,
  }) => {
    const modal = await openNewTask(page);
    await modal.getByLabel("Title").fill("Formatted by the toolbar");
    const editor = modal.getByPlaceholder("Markdown supported", { exact: false });
    const tool = (title: string) => modal.getByTitle(title, { exact: true });

    await editor.click();
    await page.keyboard.type("Ship it");

    await test.step("an inline format wraps a selection", async () => {
      await select(editor, 0, 7);
      await tool("Bold (Cmd/Ctrl+B)").click();
      await expect(editor).toHaveValue("**Ship it**");
    });

    await test.step("at the caret it inserts a placeholder that typing replaces", async () => {
      await caretAtEnd(editor);
      await page.keyboard.press("Enter");
      await tool("Italic (Cmd/Ctrl+I)").click();
      await expect(editor).toHaveValue("**Ship it**\n_italic text_");
      await page.keyboard.type("carefully");
      await expect(editor).toHaveValue("**Ship it**\n_carefully_");

      await caretAtEnd(editor);
      await page.keyboard.press("Enter");
      await tool("Strikethrough").click();
      await page.keyboard.type("old plan");
      await expect(editor).toHaveValue("**Ship it**\n_carefully_\n~~old plan~~");
    });

    await test.step("a heading at the caret marks the line it is on, not the caret", async () => {
      await caretAtEnd(editor);
      await page.keyboard.press("Enter");
      await page.keyboard.type("Scope");
      await tool("Heading").click();
      await expect(editor).toHaveValue("**Ship it**\n_carefully_\n~~old plan~~\n## Scope");
    });

    await test.step("a list on an empty line starts one, and typing fills it", async () => {
      await caretAtEnd(editor);
      await page.keyboard.press("Enter");
      await tool("Bulleted list").click();
      await page.keyboard.type("first");
      await caretAtEnd(editor);
      await page.keyboard.press("Enter");
      await tool("Task list").click();
      await page.keyboard.type("write docs");
      await expect(editor).toHaveValue(
        "**Ship it**\n_carefully_\n~~old plan~~\n## Scope\n- first\n- [ ] write docs"
      );
    });

    await test.step("a numbered list over two selected lines numbers each of them", async () => {
      await caretAtEnd(editor);
      await page.keyboard.press("Enter");
      await page.keyboard.type("one");
      await page.keyboard.press("Enter");
      await page.keyboard.type("two");
      const value = await editor.inputValue();
      await select(editor, value.length - "one\ntwo".length, value.length);
      await tool("Numbered list").click();
      await expect(editor).toHaveValue(
        "**Ship it**\n_carefully_\n~~old plan~~\n## Scope\n- first\n- [ ] write docs\n1. one\n2. two"
      );
    });

    await test.step("a link wraps its text, and inline code goes in at the caret", async () => {
      await caretAtEnd(editor);
      await page.keyboard.press("Enter");
      await page.keyboard.type("docs");
      const value = await editor.inputValue();
      await select(editor, value.length - 4, value.length);
      await tool("Link").click();
      await caretAtEnd(editor);
      await page.keyboard.type(" run ");
      await tool("Inline code").click();
      await page.keyboard.type("npm test");
    });

    const written =
      "**Ship it**\n_carefully_\n~~old plan~~\n## Scope\n- first\n- [ ] write docs\n1. one\n2. two\n[docs](https://) run `npm test`";
    await expect(editor).toHaveValue(written);

    await test.step("Preview renders it and holds the toolbar; Edit gives the same text back", async () => {
      await modal.getByRole("button", { name: "Preview", exact: true }).click();
      await expect(editor).toHaveCount(0);
      await expect(modal.getByRole("heading", { name: "Scope", level: 2 })).toBeVisible();
      await expect(modal.locator("strong", { hasText: "Ship it" })).toBeVisible();
      await expect(modal.locator("del", { hasText: "old plan" })).toBeVisible();
      await expect(modal.locator("code", { hasText: "npm test" })).toBeVisible();
      await expect(tool("Bold (Cmd/Ctrl+B)")).toBeDisabled();

      await modal.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(editor).toHaveValue(written);
      await expect(tool("Bold (Cmd/Ctrl+B)")).toBeEnabled();
    });

    const taskNumber = await create(page, modal);
    expect((await storedTask(taskNumber))?.description).toBe(written);

    await page.goto(`${BOARD}/tasks/${taskNumber}`);
    await expect(page.getByRole("heading", { name: "Scope", level: 2 })).toBeVisible();
    await expect(page.locator("strong", { hasText: "Ship it" })).toBeVisible();
    await expect(page.locator("em", { hasText: "carefully" })).toBeVisible();
    await expect(page.getByRole("link", { name: "docs", exact: true })).toHaveAttribute("href", "https://");
    await expect(page.locator("ol > li")).toHaveCount(2);
    await expect(page.locator("ol > li").first()).toHaveText("one");
  });

  test("the task's own description editor carries the same toolbar, and saves what it writes", async ({
    page,
  }) => {
    await withDb((db) =>
      db
        .collection("tasks")
        .updateOne(
          { project: PROJECT_ID, taskNumber: SIBLING_TASK_NUMBER },
          { $set: { description: "Context\nOut of scope" } }
        )
    );
    await signIn(page);
    await page.goto(`${BOARD}/tasks/${SIBLING_TASK_NUMBER}`);
    await expect(page.getByText("Out of scope")).toBeVisible();

    await page
      .getByText("Description", { exact: true })
      .locator("xpath=..")
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    const editor = page.getByPlaceholder("Markdown supported", { exact: false });
    await expect(editor).toHaveValue("Context\nOut of scope");

    // The caret in the middle of the second line, which is where the old toolbar wrote "## " to
    await select(editor, "Context\nOut of".length);
    const saved = page.waitForResponse(
      (r) => r.request().method() === "PUT" && /\/tasks\/[^/]+$/.test(new URL(r.url()).pathname)
    );
    await page.getByTitle("Heading", { exact: true }).click();
    await expect(editor).toHaveValue("Context\n## Out of scope");
    expect((await saved).status()).toBe(200);
    expect((await storedTask(SIBLING_TASK_NUMBER))?.description).toBe("Context\n## Out of scope");
  });
});

test.describe("the new-task form", () => {
  test("a template, a checklist, a due date and every kind of custom field reach the task", async ({
    page,
  }) => {
    await seedCustomFields();
    await withDb((db) =>
      db.collection("projects").updateOne(
        { _id: PROJECT_ID },
        {
          $set: {
            taskTemplates: [
              {
                _id: new mongoose.Types.ObjectId(),
                name: TEMPLATE_NAME,
                title: "Release: ",
                category: "doc",
                description: "Cut the **release** branch",
                acceptanceCriteria: "- [ ] changelog written",
              },
            ],
          },
        }
      )
    );

    const modal = await openNewTask(page);

    await test.step("the template fills the title, category, description and checklist", async () => {
      const picker = modal.getByLabel("Template");
      await expect(picker.locator("option", { hasText: "Select a template..." })).toHaveCount(1);
      await picker.selectOption({ label: TEMPLATE_NAME });
      await expect(modal.getByLabel("Title")).toHaveValue("Release: ");
      await expect(modal.getByLabel("Category")).toHaveValue("doc");
      await expect(modal.getByPlaceholder("Markdown supported", { exact: false })).toHaveValue(
        "Cut the **release** branch"
      );
    });

    await modal.getByLabel("Title").fill("Release: 2.4");

    await test.step("a checklist item is added by Enter and by the Add button", async () => {
      const input = modal.getByPlaceholder("Add checklist item...");
      await input.fill("tag pushed");
      await input.press("Enter");
      await expect(input).toHaveValue("");
      await input.fill("announcement sent");
      await input.locator("xpath=following-sibling::button").click();
      await expect(input).toHaveValue("");
      // An empty entry adds nothing, and is not taken as the form's submit either
      let posts = 0;
      page.on("request", (r) => {
        if (r.method() === "POST" && new URL(r.url()).pathname.endsWith("/tasks")) posts += 1;
      });
      await input.press("Enter");
      await page.waitForTimeout(1_000);
      expect(posts, "Enter in an empty checklist box created the task").toBe(0);
      await expect(modal).toBeVisible();
      const rows = modal
        .getByText("Checklist", { exact: true })
        .locator("xpath=..")
        .locator("input[type='text']:not([placeholder])");
      await expect(rows).toHaveCount(3);
      expect(await rows.evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value))).toEqual([
        "changelog written",
        "tag pushed",
        "announcement sent",
      ]);
    });

    await modal.locator("xpath=.//label[normalize-space()='Due Date']/following-sibling::input").fill("2026-10-15");

    await test.step("every kind of custom field is set", async () => {
      await modal.getByLabel(FIELDS.difficulty.name, { exact: true }).selectOption({ label: "L" });
      await modal.getByRole("combobox", { name: FIELDS.platforms.name, exact: true }).click();
      await page
        .getByRole("listbox", { name: FIELDS.platforms.name, exact: true })
        .getByRole("option", { name: "Web", exact: true })
        .click();
      await page.keyboard.press("Escape");
      await expect(modal.getByRole("combobox", { name: FIELDS.platforms.name, exact: true })).toContainText("Web");
      await modal
        .getByRole("switch", { name: FIELDS.spike.name, exact: true })
        .locator("xpath=ancestor::label[1]")
        .click();
      await expect(modal.getByRole("switch", { name: FIELDS.spike.name, exact: true })).toBeChecked();
      await modal.getByLabel(FIELDS.points.name, { exact: true }).fill("5");
      await modal.getByLabel(FIELDS.target.name, { exact: true }).fill("2026-11-01");
      await modal.getByLabel(FIELDS.notes.name, { exact: true }).fill("Needs a freeze window");
      // Archived: offered nowhere on a new task
      await expect(modal.getByText(FIELDS.retired.name, { exact: true })).toHaveCount(0);
    });

    const taskNumber = await create(page, modal);

    const stored = await storedTask(taskNumber);
    expect(stored).toMatchObject({
      title: "Release: 2.4",
      category: "doc",
      description: "Cut the **release** branch",
    });
    expect(stored?.checklist.map((i: { text: string; done: boolean }) => [i.text, i.done])).toEqual([
      ["changelog written", false],
      ["tag pushed", false],
      ["announcement sent", false],
    ]);
    expect(new Date(stored?.dueDate).toISOString()).toMatch(/^2026-10-15/);
    expect(stored?.customFieldValues).toEqual({
      [String(FIELDS.difficulty._id)]: "aa-large",
      [String(FIELDS.platforms._id)]: ["aa-web"],
      [String(FIELDS.spike._id)]: true,
      [String(FIELDS.points._id)]: 5,
      [String(FIELDS.target._id)]: "2026-11-01",
      [String(FIELDS.notes._id)]: "Needs a freeze window",
    });

    await page.goto(`${BOARD}/tasks/${taskNumber}`);
    for (const item of ["changelog written", "tag pushed", "announcement sent"]) {
      await expect(page.getByRole("checkbox", { name: item, exact: true })).toBeVisible();
    }
    await expect(page.getByText(/Oct 1[45], 2026/).first()).toBeVisible();
    await expect(page.getByRole("switch", { name: FIELDS.spike.name, exact: true })).toBeChecked();
    await expect(page.locator(`input[aria-label="${FIELDS.points.name}"]`)).toHaveValue("5");
    await expect(page.locator(`input[aria-label="${FIELDS.target.name}"]`)).toHaveValue("2026-11-01");
    await expect(page.locator(`input[aria-label="${FIELDS.notes.name}"]`)).toHaveValue("Needs a freeze window");
    await expect(page.getByRole("combobox", { name: FIELDS.difficulty.name, exact: true })).toContainText("L");
    await expect(page.getByRole("combobox", { name: FIELDS.platforms.name, exact: true })).toContainText("Web");
    await expect(page.getByRole("combobox", { name: FIELDS.platforms.name, exact: true })).not.toContainText("iOS");
  });
});
