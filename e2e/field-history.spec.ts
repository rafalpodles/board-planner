import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  API_TOKEN,
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

/**
 * CP-250: a task's history ignored every field the project defines, which since CP-213 is most of
 * what people edit. These tests cover the two halves separately — what gets written when a field
 * is edited, and how the timeline reads it back — because a defect in either one is invisible from
 * the other side.
 *
 * The values asserted here are the *displayed* ones. Every fixture option deliberately has an id
 * that differs from its text, so a regression that logged storage keys would fail rather than
 * quietly write `zz-small` into somebody's history.
 */

const TASK_URL = `/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;
const AUTH = {
  Authorization: `Basic ${Buffer.from(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`).toString("base64")}`,
};

type Entry = { action: string; field: string; oldValue: string; newValue: string };

test.beforeEach(async () => {
  await seed();
});

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN_USERNAME);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);
}

/** Only the entries this suite is about: the fixture's own edits, never the seed's own noise. */
async function fieldEntries(name?: string): Promise<Entry[]> {
  const all = await storedActivity(SIBLING_TASK_ID);
  const names: string[] = Object.values(FIELDS).map((f) => f.name);
  return all.filter((e) => (name ? e.field === name : names.includes(e.field)));
}

/** Waits for the autosave rather than for a fixed delay, and returns what it wrote. */
async function entriesAfterSave(expected: number, name?: string): Promise<Entry[]> {
  await expect.poll(async () => (await fieldEntries(name)).length, { timeout: 15_000 }).toBe(expected);
  return fieldEntries(name);
}

/** The rail's row for one field. Every row but the checkbox opens a popup. */
function pickerRow(page: Page, name: string): Locator {
  return page.locator('button[aria-haspopup="dialog"]').filter({ hasText: name });
}

async function openPicker(page: Page, name: string): Promise<Locator> {
  await pickerRow(page, name).click();
  return page.getByLabel(name, { exact: true });
}

async function chooseOption(page: Page, field: string, option: string) {
  const panel = await openPicker(page, field);
  await panel.getByRole("option", { name: option, exact: true }).click();
}

async function toggleChip(page: Page, field: string, option: string) {
  const panel = await openPicker(page, field);
  await panel.getByRole("button", { name: option, exact: true }).click();
  // The panel stays open for a second pick; close it so the next row is clickable
  await page.keyboard.press("Escape");
}

/** The one row that is not a picker: the rail draws a checkbox inline. */
async function setCheckbox(page: Page, field: string, on: boolean) {
  const box = page
    .getByText(field, { exact: true })
    .locator("xpath=ancestor::div[1]")
    .locator('input[type="checkbox"]');
  if (on) await box.check();
  else await box.uncheck();
}

async function typeValue(page: Page, field: string, value: string) {
  const panel = await openPicker(page, field);
  await panel.locator("input").fill(value);
  await page.keyboard.press("Escape");
}

async function openHistory(page: Page): Promise<Locator> {
  await page.goto(TASK_URL);
  await page.getByRole("tab", { name: /^History/ }).click();
  const showAll = page.getByRole("button", { name: /Show all \d+ entries/ });
  if (await showAll.isVisible().catch(() => false)) await showAll.click();
  // Scoped on purpose: the rail alongside shows each field's *current* name and value, so a
  // page-wide assertion about a renamed field would be answered by the rail, not by the history.
  return page.locator("#task-panel-history");
}

/** A PUT through the app's own API — the path MCP, the PM agent and the board all end up on. */
async function putFields(request: APIRequestContext, values: Record<string, unknown>) {
  const response = await request.put(
    `/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}`,
    { headers: AUTH, data: { customFieldValues: values } }
  );
  expect(response.status()).toBe(200);
}

const ALL_VALUES = {
  [String(FIELDS.difficulty._id)]: "zz-small",
  [String(FIELDS.platforms._id)]: ["zz-ios", "aa-web"],
  [String(FIELDS.notes._id)]: "kept",
};

// ---------------------------------------------------------------------------
// Every field type, through its whole life: unset, set, changed, cleared
// ---------------------------------------------------------------------------

/**
 * One entry per field type the product offers, so coverage cannot quietly depend on somebody
 * remembering to add a test when a type is added. Each case drives the widget a person actually
 * uses and states the text the history is expected to carry — never the stored value.
 */
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
      // iOS is first in the project's order though it is picked second — the entry must say so
      { act: (p: Page) => toggleChip(p, "Platforms", "iOS"), from: "Web", to: "iOS, Web" },
      { act: (p: Page) => toggleChip(p, "Platforms", "Web"), from: "iOS, Web", to: "iOS" },
      { act: (p: Page) => toggleChip(p, "Platforms", "iOS"), from: "iOS", to: "" },
    ],
  },
  {
    // No empty state of its own: the rail draws an unset box exactly like an unticked one
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
      // Zero is a value, and the falsy one that a truthiness check would swallow
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
    }

    // Nothing else moved: a field no lifecycle touches must stay silent throughout
    expect(await fieldEntries("Retired")).toEqual([]);
  });
}

// ---------------------------------------------------------------------------
// Edge cases the widgets cannot produce, driven through the same server endpoint
// ---------------------------------------------------------------------------

test("a save that carries every field unchanged records nothing", async ({ page, request }) => {
  // The shape the board's inline edit, MCP and the PM agent all send: they merge the task's
  // current values with the one they are changing, so N-1 fields arrive unchanged every time
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
  // The rail draws never-set and false identically, so logging this would announce a change to
  // the state already on screen
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
    { headers: AUTH, data: { order: 7 } }
  );
  expect(response.status()).toBe(200);

  expect(await storedActivity(SIBLING_TASK_ID)).toEqual([]);
});

// ---------------------------------------------------------------------------
// How the timeline reads it back
// ---------------------------------------------------------------------------

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

// The criterion the implementation satisfies by construction — entries store the name and the
// text as snapshots — but which nothing was proving until this test.
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
  // The rail now reads "Size" and "Extra Large"; the entry written before the rename must not
  await expect(history.getByText(/Size/)).toHaveCount(0);
  await expect(history.getByText(/Extra Large/)).toHaveCount(0);
});

test("a long value is cut short instead of filling the row", async ({ page, request }) => {
  await seedCustomFields();
  await signIn(page);
  const long = "x".repeat(200);
  const response = await request.put(
    `/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}`,
    { headers: AUTH, data: { title: long } }
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

  // A real recurrence: the task is given one, then moved to the done column, which is what makes
  // createNextRecurrence write its note
  await request.put(`/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}`, {
    headers: AUTH,
    data: { recurrence: { frequency: "weekly", interval: 1, endDate: null } },
  });
  const moved = await request.patch(
    `/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}/status`,
    { headers: AUTH, data: { status: "done" } }
  );
  expect(moved.status(), await moved.text()).toBe(200);
  await expect
    .poll(async () => (await storedActivity(SIBLING_TASK_ID)).some((e) => e.field === "recurrence"))
    .toBe(true);

  const history = await openHistory(page);

  await expect(history.getByText(/Next occurrence created: TP-/)).toBeVisible();
  await expect(history.getByText(/changed recurrence from/)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// The other writers: MCP names a field by its label, never by its id
// ---------------------------------------------------------------------------

/**
 * An MCP client — and the PM agent, through the same resolver — knows a field as the word a human
 * gave it. That is a different path into the same update: name to id, then the option's text to
 * the option's id. Everything the widgets exercise is bypassed here, so a break in resolution
 * would leave every test above green.
 */
async function callMcp(request: APIRequestContext, name: string, args: Record<string, unknown>) {
  const response = await request.post("/api/mcp", {
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      Accept: "application/json, text/event-stream",
    },
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
  // update_task merges the task's current values with the one field it was given, so every other
  // field arrives unchanged on the wire — exactly the shape that must stay silent
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

  // Lowercase on the wire; the entry must carry the option's own text
  await callMcp(request, "update_task", {
    taskKey: `${PROJECT_KEY}-${SIBLING_TASK_NUMBER}`,
    fields: { Platforms: ["web", "ios"] },
  });

  expect(await entriesAfterSave(1, "Platforms")).toEqual([
    { action: "updated", field: "Platforms", oldValue: "", newValue: "iOS, Web" },
  ]);
});

// ---------------------------------------------------------------------------
// The PM agent, driven through a real turn against a stubbed model
// ---------------------------------------------------------------------------

/**
 * The one writer the tests above reach only by proxy. A PM turn is the whole chain — the chat
 * box, the SSE stream, the agent loop, tool dispatch, `updateTask` — and the model is the only
 * part replaced (see e2e/openrouter-stub.mjs). What the agent "decides" travels inside the
 * message, between << and >>, so this reads as a person typing and the stub does no guessing.
 *
 * The point is attribution: an unattended agent editing somebody's board has to leave its name
 * on what it changed, not the name of whoever happened to be signed in.
 */
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
  // The agent's own merge of current values, which is the shape most likely to spray noise
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
