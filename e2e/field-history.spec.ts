import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  FIELDS,
  PROJECT_ID,
  PROJECT_KEY,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  renameField,
  seed,
  seedCustomFields,
  storedActivity,
} from "./seed";
import { signIn as arriveSignedIn } from "./session";

const TASK_URL = `/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;

type Entry = { action: string; field: string; oldValue: string; newValue: string };

test.beforeEach(async () => {
  await seed();
});

const signIn = arriveSignedIn;

async function fieldEntries(name?: string): Promise<Entry[]> {
  const all = await storedActivity(SIBLING_TASK_ID);
  const names: string[] = Object.values(FIELDS).map((f) => f.name);
  return all.filter((e) => (name ? e.field === name : names.includes(e.field)));
}

async function entriesAfterSave(expected: number, name?: string): Promise<Entry[]> {
  await expect.poll(async () => (await fieldEntries(name)).length, { timeout: 15_000 }).toBe(expected);
  return fieldEntries(name);
}

function fieldRow(page: Page, name: string): Locator {
  return page
    .getByText(name, { exact: true })
    .locator("xpath=ancestor::*[self::button or self::div][1]");
}

function fieldInput(page: Page, name: string): Locator {
  return page.locator(`input[aria-label="${name}"]`);
}

async function expectRailShows(page: Page, name: string, text: string, type: string) {
  if (type === "checkbox") {
    await expect(page.getByRole("switch", { name })).toBeChecked({ checked: text === "Yes" });
    return;
  }
  if (type === "text" || type === "number" || type === "date") {
    await expect(fieldInput(page, name)).toHaveValue(text);
    return;
  }
  const row = fieldRow(page, name);
  for (const piece of text ? text.split(", ") : ["Empty"]) {
    await expect(row).toContainText(piece);
  }
}

async function openPicker(page: Page, name: string): Promise<Locator> {
  await page.getByRole("combobox", { name, exact: true }).click();
  return page.getByRole("listbox", { name, exact: true });
}

async function chooseOption(page: Page, field: string, option: string) {
  const panel = await openPicker(page, field);
  await panel.getByRole("option", { name: option, exact: true }).click();
}

async function toggleChip(page: Page, field: string, option: string) {
  const panel = await openPicker(page, field);
  await panel.getByRole("option", { name: option, exact: true }).click();
  await page.keyboard.press("Escape");
}

async function setCheckbox(page: Page, field: string, on: boolean) {
  const toggle = page.getByRole("switch", { name: field, exact: true });
  if ((await toggle.isChecked()) !== on) {
    await toggle.locator("xpath=ancestor::label[1]").click();
  }
}

async function typeValue(page: Page, field: string, value: string) {
  const input = fieldInput(page, field);
  await input.fill(value);
  await input.blur();
}

async function openHistory(page: Page): Promise<Locator> {
  await page.goto(TASK_URL);
  await page.getByRole("tab", { name: /^History/ }).click();
  const panel = page.locator("#task-panel-history");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("No history yet")).toBeHidden();

  const showAll = page.getByRole("button", { name: /Show all \d+ entries/ });
  if (await showAll.isVisible()) await showAll.click();
  return panel;
}

async function putFields(request: APIRequestContext, values: Record<string, unknown>) {
  const response = await request.put(
    `/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}`,
    { headers: ADMIN_AUTH, data: { customFieldValues: values } }
  );
  expect(response.status()).toBe(200);
}

const ALL_VALUES = {
  [String(FIELDS.difficulty._id)]: "zz-small",
  [String(FIELDS.platforms._id)]: ["zz-ios", "aa-web"],
  [String(FIELDS.notes._id)]: "kept",
};

const LIFECYCLES = [
  {
    type: "dropdown",
    name: "Difficulty",
    steps: [
      { act: (p: Page) => chooseOption(p, "Difficulty", "S"), from: "", to: "S" },
      { act: (p: Page) => chooseOption(p, "Difficulty", "L"), from: "S", to: "L" },
      { act: (p: Page) => chooseOption(p, "Difficulty", "Empty"), from: "L", to: "" },
    ],
  },
  {
    type: "multiselect",
    name: "Platforms",
    steps: [
      { act: (p: Page) => toggleChip(p, "Platforms", "Web"), from: "", to: "Web" },
      { act: (p: Page) => toggleChip(p, "Platforms", "iOS"), from: "Web", to: "iOS, Web" },
      { act: (p: Page) => toggleChip(p, "Platforms", "Web"), from: "iOS, Web", to: "iOS" },
      { act: (p: Page) => toggleChip(p, "Platforms", "iOS"), from: "iOS", to: "" },
    ],
  },
  {
    type: "checkbox",
    name: "Spike?",
    steps: [
      { act: (p: Page) => setCheckbox(p, "Spike?", true), from: "No", to: "Yes" },
      { act: (p: Page) => setCheckbox(p, "Spike?", false), from: "Yes", to: "No" },
    ],
  },
  {
    type: "number",
    name: "Points",
    steps: [
      { act: (p: Page) => typeValue(p, "Points", "5"), from: "", to: "5" },
      { act: (p: Page) => typeValue(p, "Points", "0"), from: "5", to: "0" },
      { act: (p: Page) => typeValue(p, "Points", ""), from: "0", to: "" },
    ],
  },
  {
    type: "date",
    name: "Target",
    steps: [
      { act: (p: Page) => typeValue(p, "Target", "2026-08-08"), from: "", to: "2026-08-08" },
      { act: (p: Page) => typeValue(p, "Target", "2026-09-01"), from: "2026-08-08", to: "2026-09-01" },
      { act: (p: Page) => typeValue(p, "Target", ""), from: "2026-09-01", to: "" },
    ],
  },
  {
    type: "text",
    name: "Notes",
    steps: [
      { act: (p: Page) => typeValue(p, "Notes", "ping"), from: "", to: "ping" },
      { act: (p: Page) => typeValue(p, "Notes", "pong"), from: "ping", to: "pong" },
      { act: (p: Page) => typeValue(p, "Notes", ""), from: "pong", to: "" },
    ],
  },
] as const;

for (const { type, name, steps } of LIFECYCLES) {
  test(`a ${type} field records every step of its life under its own name`, async ({ page }) => {
    await seedCustomFields();
    await signIn(page);
    await page.goto(TASK_URL);

    for (const [index, step] of steps.entries()) {
      await step.act(page);
      const written = await entriesAfterSave(index + 1, name);
      expect(written[0]).toEqual({
        action: "updated",
        field: name,
        oldValue: step.from,
        newValue: step.to,
      });
      await expectRailShows(page, name, step.to, type);
    }

    expect(await fieldEntries("Retired")).toEqual([]);
  });
}

test("a save that carries every field unchanged records nothing", async ({ page, request }) => {
  await seedCustomFields(ALL_VALUES);
  await signIn(page);

  await putFields(request, ALL_VALUES);

  expect(await fieldEntries()).toEqual([]);
});

test("re-picking the same options in a different order records nothing", async ({
  page,
  request,
}) => {
  await seedCustomFields({ [String(FIELDS.platforms._id)]: ["zz-ios", "aa-web"] });
  await signIn(page);

  await putFields(request, { [String(FIELDS.platforms._id)]: ["aa-web", "zz-ios"] });

  expect(await fieldEntries()).toEqual([]);
});

test("an explicit false on a checkbox nobody ever ticked records nothing", async ({
  page,
  request,
}) => {
  await seedCustomFields();
  await signIn(page);

  await putFields(request, { [String(FIELDS.spike._id)]: false });

  expect(await fieldEntries()).toEqual([]);
});

test("moving the value of an archived field is still recorded", async ({ page, request }) => {
  await seedCustomFields();
  await signIn(page);

  await putFields(request, { [String(FIELDS.retired._id)]: "kept-value" });

  expect(await fieldEntries("Retired")).toEqual([
    { action: "updated", field: "Retired", oldValue: "", newValue: "Kept" },
  ]);
});

test("a value whose field the project never defined is dropped, not recorded", async ({
  page,
  request,
}) => {
  await seedCustomFields();
  await signIn(page);

  await putFields(request, { "e2e00000000000000000fdead": "ghost" });

  expect(await fieldEntries()).toEqual([]);
});

test("a stored option that no longer exists reads as empty on both sides", async ({
  page,
  request,
}) => {
  await seedCustomFields({ [String(FIELDS.difficulty._id)]: "an-option-since-deleted" });
  await signIn(page);

  await putFields(request, { [String(FIELDS.difficulty._id)]: "" });

  expect(await fieldEntries()).toEqual([]);
});

test("reordering a card on the board records nothing at all", async ({ page, request }) => {
  await seedCustomFields(ALL_VALUES);
  await signIn(page);

  const response = await request.put(
    `/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}`,
    { headers: ADMIN_AUTH, data: { order: 7 } }
  );
  expect(response.status()).toBe(200);

  expect(await storedActivity(SIBLING_TASK_ID)).toEqual([]);
});

test("the history says which field changed and what it became", async ({ page }) => {
  await seedCustomFields({ [String(FIELDS.difficulty._id)]: "zz-small" });
  await signIn(page);
  await page.goto(TASK_URL);
  await chooseOption(page, "Difficulty", "L");
  await entriesAfterSave(1);

  const history = await openHistory(page);

  await expect(history.getByText("E2E Admin changed Difficulty from S to L")).toBeVisible();
});

test("a cleared field reads as empty rather than trailing off", async ({ page }) => {
  await seedCustomFields({ [String(FIELDS.difficulty._id)]: "aa-large" });
  await signIn(page);
  await page.goto(TASK_URL);
  await chooseOption(page, "Difficulty", "Empty");
  await entriesAfterSave(1);

  const history = await openHistory(page);

  await expect(history.getByText("E2E Admin changed Difficulty from L to (empty)")).toBeVisible();
});

test("a field named with punctuation still reads as a sentence", async ({ page }) => {
  await seedCustomFields();
  await signIn(page);
  await page.goto(TASK_URL);
  await setCheckbox(page, "Spike?", true);
  await entriesAfterSave(1, "Spike?");

  const history = await openHistory(page);

  await expect(history.getByText("E2E Admin changed Spike? from No to Yes")).toBeVisible();
});

test("renaming a field afterwards does not rewrite the history already written about it", async ({
  page,
}) => {
  await seedCustomFields({ [String(FIELDS.difficulty._id)]: "zz-small" });
  await signIn(page);
  await page.goto(TASK_URL);
  await chooseOption(page, "Difficulty", "L");
  await entriesAfterSave(1);

  await renameField(FIELDS.difficulty._id, { name: "Size" });
  await renameField(FIELDS.difficulty._id, { optionId: "aa-large", optionValue: "Extra Large" });

  const history = await openHistory(page);

  await expect(history.getByText("E2E Admin changed Difficulty from S to L")).toBeVisible();
  await expect(history.getByText(/Size/)).toHaveCount(0);
  await expect(history.getByText(/Extra Large/)).toHaveCount(0);
});

test("a long value is cut short instead of filling the row", async ({ page, request }) => {
  await seedCustomFields();
  await signIn(page);
  const long = "x".repeat(200);
  const response = await request.put(
    `/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}`,
    { headers: ADMIN_AUTH, data: { title: long } }
  );
  expect(response.status(), await response.text()).toBe(200);

  const history = await openHistory(page);

  await expect(history.getByText(new RegExp(`x{60}…`))).toBeVisible();
  await expect(history.getByText(new RegExp(`x{100}`))).toHaveCount(0);
});

test("the note left by a recurrence reads as a note, not as a field somebody edited", async ({
  page,
  request,
}) => {
  await seedCustomFields();
  await signIn(page);

  await request.put(`/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}`, {
    headers: ADMIN_AUTH,
    data: { recurrence: { frequency: "weekly", interval: 1, endDate: null } },
  });
  const moved = await request.patch(
    `/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}/status`,
    { headers: ADMIN_AUTH, data: { status: "done" } }
  );
  expect(moved.status(), await moved.text()).toBe(200);
  await expect
    .poll(async () => (await storedActivity(SIBLING_TASK_ID)).some((e) => e.field === "recurrence"))
    .toBe(true);

  const history = await openHistory(page);

  await expect(history.getByText(/Next occurrence created: TP-/)).toBeVisible();
  await expect(history.getByText(/changed recurrence from/)).toHaveCount(0);
});

async function callMcp(request: APIRequestContext, name: string, args: Record<string, unknown>) {
  const response = await request.post("/api/mcp", {
    headers: { ...ADMIN_AUTH, Accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.status(), await response.text()).toBe(200);
  return response.text();
}

test("MCP naming a field by its label records the same entry the widget does", async ({
  page,
  request,
}) => {
  await seedCustomFields({ [String(FIELDS.difficulty._id)]: "zz-small" });
  await signIn(page);

  await callMcp(request, "update_task", {
    taskKey: `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`,
    fields: { Difficulty: "L" },
  });

  expect(await entriesAfterSave(1, "Difficulty")).toEqual([
    { action: "updated", field: "Difficulty", oldValue: "S", newValue: "L" },
  ]);
});

test("MCP changing one field leaves the others it merged along untouched", async ({
  page,
  request,
}) => {
  await seedCustomFields(ALL_VALUES);
  await signIn(page);

  await callMcp(request, "update_task", {
    taskKey: `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`,
    fields: { Notes: "changed by mcp" },
  });

  expect(await entriesAfterSave(1)).toEqual([
    { action: "updated", field: "Notes", oldValue: "kept", newValue: "changed by mcp" },
  ]);
});

test("MCP naming a multiselect option records the project's wording, not the client's", async ({
  page,
  request,
}) => {
  await seedCustomFields();
  await signIn(page);

  await callMcp(request, "update_task", {
    taskKey: `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`,
    fields: { Platforms: ["web", "ios"] },
  });

  expect(await entriesAfterSave(1, "Platforms")).toEqual([
    { action: "updated", field: "Platforms", oldValue: "", newValue: "iOS, Web" },
  ]);
});

async function askPm(page: Page, prompt: string, call: Record<string, unknown>) {
  await page.goto(`/projects/${PROJECT_KEY}/pm`);
  const box = page.getByPlaceholder(/Message the PM/);
  await box.fill(`${prompt} <<${JSON.stringify(call)}>>`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

test("a PM turn records its field change under the agent's own name", async ({ page }) => {
  await seedCustomFields({ [String(FIELDS.difficulty._id)]: "zz-small" });
  await signIn(page);

  await askPm(page, "This one looks bigger than S — please size it up.", {
    name: "update_task",
    arguments: {
      taskKey: `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`,
      fields: { Difficulty: "L" },
    },
  });

  expect(await entriesAfterSave(1, "Difficulty")).toEqual([
    { action: "updated", field: "Difficulty", oldValue: "S", newValue: "L" },
  ]);

  const history = await openHistory(page);
  await expect(history.getByText("PM Agent changed Difficulty from S to L")).toBeVisible();
  await expect(history.getByText(/E2E Admin changed Difficulty/)).toHaveCount(0);
});

test("a PM turn that changes one field stays silent about the rest", async ({ page }) => {
  await seedCustomFields(ALL_VALUES);
  await signIn(page);

  await askPm(page, "Record what we agreed about the notes.", {
    name: "update_task",
    arguments: {
      taskKey: `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`,
      fields: { Notes: "agreed with the team" },
    },
  });

  expect(await entriesAfterSave(1)).toEqual([
    { action: "updated", field: "Notes", oldValue: "kept", newValue: "agreed with the team" },
  ]);
});

async function tasksInProject(request: APIRequestContext): Promise<{ taskNumber: number; title: string }[]> {
  const response = await request.get(`/api/projects/${PROJECT_ID}/tasks`, { headers: ADMIN_AUTH });
  expect(response.status()).toBe(200);
  return response.json();
}

test("closing a recurring task from the edit form creates its next occurrence", async ({
  page,
  request,
}) => {
  await seedCustomFields();
  await signIn(page);

  const before = await tasksInProject(request);

  await request.put(`/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}`, {
    headers: ADMIN_AUTH,
    data: { recurrence: { frequency: "weekly", interval: 1, endDate: null } },
  });

  const closed = await request.put(`/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}`, {
    headers: ADMIN_AUTH,
    data: { status: "done" },
  });
  expect(closed.status(), await closed.text()).toBe(200);

  await expect
    .poll(async () => (await tasksInProject(request)).length, { timeout: 15_000 })
    .toBe(before.length + 1);

  const after = await tasksInProject(request);
  const created = after.find((t) => !before.some((b) => b.taskNumber === t.taskNumber));
  expect(created?.title, "the new occurrence does not carry the original's title").toBe(
    before.find((b) => b.taskNumber === SIBLING_TASK_NUMBER)?.title
  );
});

test("closing a task that does not recur creates nothing", async ({ page, request }) => {
  await seedCustomFields();
  await signIn(page);

  const before = await tasksInProject(request);
  const closed = await request.put(`/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}`, {
    headers: ADMIN_AUTH,
    data: { status: "done" },
  });
  expect(closed.status()).toBe(200);

  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect((await tasksInProject(request)).length).toBe(before.length);
});
