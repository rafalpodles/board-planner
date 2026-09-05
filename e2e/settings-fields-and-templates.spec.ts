import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { dragTo } from "./drag";
import {
  FIELDS,
  PROJECT_ID,
  PROJECT_KEY,
  SIBLING_TASK_NUMBER,
  seed,
  seedCustomFields,
} from "./seed";
import { signIn } from "./session";
import { expectToast, recordToasts } from "./toasts";

/**
 * BP-468 — the definition half of custom fields, and task templates, driven from the settings
 * screen. The values half lives in field-history.spec.ts; the board's columns and categories in
 * project-settings.spec.ts. Every write here is read back from the server, because the section
 * repaints from its own draft before anything has landed.
 */

const SETTINGS = `/projects/${PROJECT_KEY}/settings`;
const boardUrl = `/projects/${PROJECT_KEY}`;

async function openFields(page: Page) {
  await signIn(page);
  await page.goto(`${SETTINGS}?section=fields`);
  await expect(page.getByRole("heading", { name: "Task fields", exact: true })).toBeVisible();
  await recordToasts(page);
}

async function storedFields(request: APIRequestContext) {
  const res = await request.get(`/api/projects/${PROJECT_ID}/custom-fields`, { headers: ADMIN_AUTH });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as {
    _id: string;
    name: string;
    fieldType: string;
    required: boolean;
    showOnCard: boolean;
    archived: boolean;
    options: { value: string }[];
  }[];
}

async function storedProject(request: APIRequestContext) {
  const res = await request.get(`/api/projects/${PROJECT_ID}`, { headers: ADMIN_AUTH });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as {
    estimateFieldId: string;
    categories: { name: string }[];
    taskTemplates: {
      _id: string;
      name: string;
      title: string;
      category: string;
      description: string;
      acceptanceCriteria: string;
    }[];
  };
}

async function readTask(request: APIRequestContext, taskNumber: number) {
  const res = await request.get(`/api/projects/${PROJECT_KEY}/tasks/${taskNumber}`, { headers: ADMIN_AUTH });
  expect(res.status()).toBe(200);
  return res.json();
}

/** The collapsed row of one field: the nearest block around its name that carries an Edit button. */
function fieldRow(page: Page, name: string): Locator {
  return page
    .locator(`span:text-is("${name}")`)
    .locator("xpath=ancestor::div[.//button[normalize-space()='Edit']][1]");
}

/** ui/Select's label is not associated with its control, so the picker is reached through the wrapper. */
function selectLabelled(scope: Locator | Page, label: string): Locator {
  return scope.locator(`div:has(> label:text-is('${label}')) > select`);
}

const saveButton = (page: Page) => page.getByRole("button", { name: "Save changes" });

function fieldWrite(page: Page, method: string) {
  return page.waitForResponse(
    (res) => res.request().method() === method && res.url().includes("/custom-fields")
  );
}

test.beforeEach(async () => {
  await seed();
});

test.describe("custom fields", () => {
  test("a choice field is created with its options and flags, and edited in place", async ({
    page,
    request,
  }) => {
    await openFields(page);
    await page.getByRole("button", { name: "+ Add field" }).click();

    await page.getByLabel("Name", { exact: true }).fill("Component");
    await page.getByLabel("Type", { exact: true }).selectOption("dropdown");

    await test.step("a choice field with no options is refused before anything is sent", async () => {
      await page.getByRole("button", { name: "Create field" }).click();
      await expect(page.getByText("A choice field needs at least one option.")).toBeVisible();
      expect(await storedFields(request)).toEqual([]);
    });

    await test.step("with options and Required, it is created and the row describes it", async () => {
      await page.getByRole("button", { name: "+ Add option" }).click();
      await page.getByPlaceholder("Option name").nth(0).fill("Web");
      await page.getByRole("button", { name: "+ Add option" }).click();
      await page.getByPlaceholder("Option name").nth(1).fill("iOS");
      await page.getByText("Required", { exact: true }).click();
      await expect(page.getByRole("switch", { name: "Required" })).toBeChecked();

      const created = fieldWrite(page, "POST");
      await page.getByRole("button", { name: "Create field" }).click();
      expect((await created).status()).toBe(201);

      const row = fieldRow(page, "Component");
      await expect(row).toContainText("Choice · 2 options");

      const [stored] = await storedFields(request);
      expect(stored).toMatchObject({ name: "Component", fieldType: "dropdown", required: true, archived: false });
      expect(stored.options.map((o) => o.value)).toEqual(["Web", "iOS"]);
    });

    await test.step("editing renames it and puts it on the card; the type is fixed", async () => {
      await fieldRow(page, "Component").getByRole("button", { name: "Edit" }).click();
      await expect(page.getByLabel("Type", { exact: true })).toBeDisabled();
      await page.getByLabel("Name", { exact: true }).fill("Platform");
      await page.getByText("On the card", { exact: true }).click();
      await expect(page.getByRole("switch", { name: "On the card" })).toBeChecked();

      const saved = fieldWrite(page, "PATCH");
      await page.getByRole("button", { name: "Save field" }).click();
      expect((await saved).status()).toBe(200);

      await expect(fieldRow(page, "Platform")).toContainText("On card");
      const [stored] = await storedFields(request);
      expect(stored).toMatchObject({ name: "Platform", showOnCard: true, required: true, fieldType: "dropdown" });
    });

    await test.step("a second field with the same name is refused, and the first is untouched", async () => {
      await page.getByRole("button", { name: "+ Add field" }).click();
      await page.getByLabel("Name", { exact: true }).fill("Platform");
      await page.getByLabel("Type", { exact: true }).selectOption("text");
      const refused = fieldWrite(page, "POST");
      await page.getByRole("button", { name: "Create field" }).click();
      expect((await refused).status()).toBe(409);
      // The form shows the server's refusal inline, under the name
      await expect(page.getByText("Field with this name already exists")).toBeVisible();
      expect((await storedFields(request)).map((f) => f.name)).toEqual(["Platform"]);
    });
  });

  test("archiving keeps a task's value, deleting erases it, and the dialog counts the tasks first", async ({
    page,
    request,
  }) => {
    const difficulty = String(FIELDS.difficulty._id);
    // One task holds a value for the field the dialog will be asked about
    await seedCustomFields({ [difficulty]: "aa-large" });
    await openFields(page);

    await test.step("Archive marks the row and keeps the value on the task", async () => {
      const archived = fieldWrite(page, "PATCH");
      await fieldRow(page, "Difficulty").getByRole("button", { name: "Archive" }).click();
      expect((await archived).status()).toBe(200);
      await expect(fieldRow(page, "Difficulty")).toContainText("Archived");
      await expect(fieldRow(page, "Difficulty")).toContainText("values kept on tasks");

      expect((await storedFields(request)).find((f) => f.name === "Difficulty")?.archived).toBe(true);
      expect((await readTask(request, SIBLING_TASK_NUMBER)).customFieldValues[difficulty]).toBe("aa-large");
    });

    await test.step("Restore brings it back", async () => {
      const restored = fieldWrite(page, "PATCH");
      await fieldRow(page, "Difficulty").getByRole("button", { name: "Restore" }).click();
      expect((await restored).status()).toBe(200);
      await expect(fieldRow(page, "Difficulty")).not.toContainText("Archived");
      expect((await storedFields(request)).find((f) => f.name === "Difficulty")?.archived).toBe(false);
    });

    await test.step("the delete dialog counts the task and offers to archive instead", async () => {
      await fieldRow(page, "Difficulty").getByRole("button", { name: "Delete" }).click();
      const dialog = page.getByRole("dialog", { name: "Delete “Difficulty”?" });
      await expect(dialog).toContainText("Used by 1 task. Archiving hides the field and keeps their values.");

      const archived = fieldWrite(page, "PATCH");
      await dialog.getByRole("button", { name: "Archive instead" }).click();
      expect((await archived).status()).toBe(200);
      await expect(dialog).toBeHidden();

      // Archived, not deleted: the field and the value are both still there
      expect((await storedFields(request)).find((f) => f.name === "Difficulty")?.archived).toBe(true);
      expect((await readTask(request, SIBLING_TASK_NUMBER)).customFieldValues[difficulty]).toBe("aa-large");
    });

    await test.step("Delete field takes the field and every task's value with it", async () => {
      await fieldRow(page, "Difficulty").getByRole("button", { name: "Delete" }).click();
      const dialog = page.getByRole("dialog", { name: "Delete “Difficulty”?" });
      const deleted = fieldWrite(page, "DELETE");
      await dialog.getByRole("button", { name: "Delete field" }).click();
      expect((await deleted).status()).toBe(200);

      await expect(page.locator('span:text-is("Difficulty")')).toHaveCount(0);
      expect((await storedFields(request)).map((f) => f.name)).not.toContain("Difficulty");
      expect((await readTask(request, SIBLING_TASK_NUMBER)).customFieldValues).not.toHaveProperty(difficulty);
      // The control: the other fields are exactly where they were
      expect((await storedFields(request)).map((f) => f.name)).toContain("Platforms");
    });
  });

  test("the estimate field is created in one click when none exists, then chosen from the numeric fields", async ({
    page,
    request,
  }) => {
    await openFields(page);

    await test.step("Create \"Story points\" makes a number field and designates it", async () => {
      const created = fieldWrite(page, "POST");
      const designated = page.waitForResponse(
        (res) => res.request().method() === "PUT" && /\/api\/projects\/[^/]+$/.test(res.url())
      );
      await page.getByRole("button", { name: 'Create "Story points"' }).click();
      expect((await created).status()).toBe(201);
      expect((await designated).status()).toBe(200);

      const [points] = await storedFields(request);
      expect(points).toMatchObject({ name: "Story points", fieldType: "number" });
      expect((await storedProject(request)).estimateFieldId).toBe(points._id);
      await expect(page.getByRole("combobox", { name: "Estimate field" })).toHaveValue(points._id);
    });

    await test.step("another numeric field can be chosen instead", async () => {
      await page.getByRole("button", { name: "+ Add field" }).click();
      await page.getByLabel("Name", { exact: true }).fill("Hours");
      await page.getByLabel("Type", { exact: true }).selectOption("number");
      const created = fieldWrite(page, "POST");
      await page.getByRole("button", { name: "Create field" }).click();
      expect((await created).status()).toBe(201);
      const hours = (await storedFields(request)).find((f) => f.name === "Hours")!;

      const designated = page.waitForResponse(
        (res) => res.request().method() === "PUT" && /\/api\/projects\/[^/]+$/.test(res.url())
      );
      await page.getByRole("combobox", { name: "Estimate field" }).selectOption({ label: "Hours" });
      expect((await designated).status()).toBe(200);
      expect((await storedProject(request)).estimateFieldId).toBe(hours._id);
    });

    await test.step("archiving the designated field clears the designation", async () => {
      const archived = fieldWrite(page, "PATCH");
      await fieldRow(page, "Hours").getByRole("button", { name: "Archive" }).click();
      expect((await archived).status()).toBe(200);
      expect((await storedProject(request)).estimateFieldId).toBe("");
      await expect(page.getByRole("combobox", { name: "Estimate field" })).toHaveValue("");
    });
  });
});

test.describe("task templates", () => {
  /** The row of the nth template on the screen: the block around its name input that carries Edit/Done. */
  function templateRow(page: Page, index: number): Locator {
    return page
      .locator('input[aria-label="Template name"]')
      .nth(index)
      .locator("xpath=ancestor::div[.//button[normalize-space()='Edit' or normalize-space()='Done']][1]");
  }

  test("a template is saved, offered on the new-task form, and follows a category rename", async ({
    page,
    request,
  }) => {
    await openFields(page);

    await test.step("adding one and saving stores every part of it", async () => {
      await page.getByRole("button", { name: "+ Add template" }).click();
      const nameInput = page.getByLabel("Template name");
      await nameInput.fill("Bug report");
      // The row's own button reads Edit until it is open and Done after, so the row is found
      // by either
      const row = nameInput.locator(
        "xpath=ancestor::div[.//button[normalize-space()='Edit' or normalize-space()='Done']][1]"
      );
      await row.getByRole("button", { name: "Edit" }).click();
      await row.getByLabel("Title template").fill("Bug: ");
      const picker = row.getByRole("combobox", { name: "Template category" });
      const options = page.getByRole("listbox", { name: "Template category" });
      // The picker mounts in a portal on open; a click that lands during the row's own repaint
      // is lost, so the open is retried rather than assumed
      await expect(async () => {
        await picker.click();
        await expect(options).toBeVisible({ timeout: 1_500 });
      }).toPass({ timeout: 15_000 });
      await options.getByRole("option", { name: /^\s*bug\s*$/ }).click();
      await expect(row.getByRole("combobox", { name: "Template category" })).toContainText("bug");
      await row.getByLabel("Description").fill("Steps to reproduce");
      await row.getByLabel("Acceptance Criteria").fill("- [ ] reproduced\n- [ ] fixed");

      const posted = page.waitForResponse(
        (res) => res.request().method() === "POST" && res.url().endsWith("/templates")
      );
      await saveButton(page).click();
      expect((await posted).status()).toBe(201);
      await expectToast(page, "Templates saved");
      await expect(saveButton(page)).toBeHidden();

      const { taskTemplates } = await storedProject(request);
      expect(taskTemplates).toHaveLength(1);
      expect(taskTemplates[0]).toMatchObject({
        name: "Bug report",
        title: "Bug: ",
        category: "bug",
        description: "Steps to reproduce",
        acceptanceCriteria: "- [ ] reproduced\n- [ ] fixed",
      });
    });

    await test.step("the new-task form offers it, and a task made from it carries it", async () => {
      await page.goto(boardUrl);
      await page.getByRole("button", { name: "New task" }).click();
      const modal = page.getByRole("dialog", { name: "New Task" });
      await selectLabelled(modal, "Template").selectOption({ label: "Bug report" });
      await expect(modal.getByLabel("Title")).toHaveValue("Bug: ");
      await expect(selectLabelled(modal, "Category")).toHaveValue("bug");

      await modal.getByLabel("Title").fill("Bug: the login form forgets the username");
      const created = page.waitForResponse(
        (res) => res.request().method() === "POST" && res.url().endsWith("/tasks")
      );
      await modal.getByRole("button", { name: "Create Task" }).click();
      const task = await (await created).json();
      expect(task).toMatchObject({
        title: "Bug: the login form forgets the username",
        category: "bug",
        description: "Steps to reproduce",
      });
      expect(task.checklist.map((i: { text: string; done: boolean }) => [i.text, i.done])).toEqual([
        ["reproduced", false],
        ["fixed", false],
      ]);
    });

    await test.step("renaming its category and editing it in the same save leaves it on the new name", async () => {
      await openFields(page);
      // The category first: both groups go dirty, and one Save has to carry the rename across
      // to a template whose draft still remembers the old name
      const names = await page.getByLabel("Category name").evaluateAll((els) =>
        els.map((el) => (el as HTMLInputElement).value)
      );
      await page.getByLabel("Category name").nth(names.indexOf("bug")).fill("defect");

      const row = templateRow(page, 0);
      await expect(row.locator('input[aria-label="Template name"]')).toHaveValue("Bug report");
      await row.getByRole("button", { name: "Edit" }).click();
      await row.getByLabel("Title template").fill("Defect: ");

      const renamed = page.waitForResponse(
        (res) => res.request().method() === "PATCH" && res.url().endsWith("/categories")
      );
      const updated = page.waitForResponse(
        (res) => res.request().method() === "PUT" && res.url().endsWith("/templates")
      );
      await saveButton(page).click();
      expect((await renamed).status()).toBe(200);
      expect((await updated).status()).toBe(200);
      await expectToast(page, "Categories saved");
      await expectToast(page, "Templates saved");

      const project = await storedProject(request);
      expect(project.categories.map((c) => c.name)).toContain("defect");
      expect(project.categories.map((c) => c.name)).not.toContain("bug");
      expect(project.taskTemplates[0]).toMatchObject({ name: "Bug report", title: "Defect: ", category: "defect" });
      // And the task made from it moved with the category
      expect((await readTask(request, 5)).category).toBe("defect");
    });

    await test.step("a second template with the same name is refused and stays on screen to fix", async () => {
      await page.getByRole("button", { name: "+ Add template" }).click();
      const fresh = page.getByLabel("Template name").last();
      await fresh.fill("Bug report");
      const refused = page.waitForResponse(
        (res) => res.request().method() === "POST" && res.url().endsWith("/templates")
      );
      await saveButton(page).click();
      expect((await refused).status()).toBe(409);
      await expectToast(page, "Template with this name already exists");
      expect((await storedProject(request)).taskTemplates).toHaveLength(1);

      // The row is still there to correct, and the save bar still open
      await expect(page.getByLabel("Template name").last()).toHaveValue("Bug report");
      await page.getByLabel("Template name").last().fill("Bug report (short)");
      const posted = page.waitForResponse(
        (res) => res.request().method() === "POST" && res.url().endsWith("/templates")
      );
      await saveButton(page).click();
      expect((await posted).status()).toBe(201);
      await expectToast(page, "Templates saved");
      expect((await storedProject(request)).taskTemplates.map((t) => t.name)).toEqual([
        "Bug report",
        "Bug report (short)",
      ]);
    });

    await test.step("removing one and saving deletes it, and the other stays", async () => {
      await page.getByRole("button", { name: "Remove Bug report (short)" }).click();
      const deleted = page.waitForResponse(
        (res) => res.request().method() === "DELETE" && res.url().endsWith("/templates")
      );
      await saveButton(page).click();
      expect((await deleted).status()).toBe(200);
      await expectToast(page, "Templates saved");
      expect((await storedProject(request)).taskTemplates.map((t) => t.name)).toEqual(["Bug report"]);
    });
  });
});

test.describe("board columns", () => {
  const columnNames = (page: Page) => page.getByLabel("Column name");
  const columnRow = (page: Page, index: number) =>
    columnNames(page).nth(index).locator("xpath=ancestor::div[@draggable='true'][1]");

  test("the rows count the tasks standing in each column, and a column can be dragged into a new order", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await page.goto(`${SETTINGS}?section=board`);
    await expect(page.getByRole("heading", { name: "Board", exact: true })).toBeVisible();
    await recordToasts(page);
    await expect(columnNames(page)).toHaveCount(7);

    // seed(): TP-4 in To Do, TP-1 and TP-3 in In Progress, TP-2 in In Review — from /stats,
    // which nothing else in the suite reads for these counts
    await expect(columnRow(page, 1)).toContainText("1 task");
    await expect(columnRow(page, 2)).toContainText("2 tasks");
    await expect(columnRow(page, 3)).toContainText("1 task");
    await expect(columnRow(page, 0)).toContainText("0 tasks");

    await dragTo(page, columnRow(page, 0), columnRow(page, 1));
    const reordered = await columnNames(page).evaluateAll((els) =>
      els.map((el) => (el as HTMLInputElement).value)
    );
    expect(reordered.slice(0, 3)).toEqual(["To Do", "Planned", "In Progress"]);

    const saved = page.waitForResponse(
      (res) => res.request().method() === "PUT" && res.url().endsWith("/columns")
    );
    await saveButton(page).click();
    expect((await saved).status()).toBe(200);
    await expectToast(page, "Columns saved");

    const stored = await request.get(`/api/projects/${PROJECT_ID}/columns`, { headers: ADMIN_AUTH });
    expect(((await stored.json()) as { label: string }[]).map((c) => c.label).slice(0, 3)).toEqual([
      "To Do",
      "Planned",
      "In Progress",
    ]);
  });
});
