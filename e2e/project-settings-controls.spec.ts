import { test, expect, type Locator, type Page, type Response } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, FIELDS, PROJECT_ID, PROJECT_KEY, seed, seedCustomFields } from "./seed";
import { signIn } from "./session";
import { expectToast, recordToasts } from "./toasts";

/**
 * BP-709, project settings: the controls on these screens that no browser test clicked — the icon
 * picker and its search, the description, a column's down arrow, a custom field's Filterable flag,
 * and the default-agent picker, which project-default-agent.spec.ts only ever drove over the API.
 *
 * Each one is read back from Mongo and then from the screen that uses it, never from the settings
 * form that just echoed the click.
 */

const SETTINGS = `/projects/${PROJECT_KEY}/settings`;
const BOARD = `/projects/${PROJECT_KEY}`;

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

const storedProject = () => withDb((db) => db.collection("projects").findOne({ _id: PROJECT_ID }));

test.beforeEach(seed);

async function openSection(page: Page, section: string, heading: string) {
  await signIn(page);
  await page.goto(`${SETTINGS}?section=${section}`);
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  await recordToasts(page);
}

function projectWrite(page: Page): Promise<Response> {
  return page.waitForResponse(
    (r) => r.request().method() === "PUT" && /^\/api\/projects\/[^/]+$/.test(new URL(r.url()).pathname)
  );
}

async function saveBar(page: Page, written: Promise<Response>) {
  await page.getByRole("button", { name: "Save changes" }).click();
  const response = await written;
  expect(response.status(), await response.text()).toBe(200);
}

const boardHeader = (page: Page): Locator =>
  page.getByRole("button", { name: "New task" }).locator("xpath=ancestor::header[1]");

test.describe("General · Identity", () => {
  test("the icon is found through the picker's search, saved, and shown on the board", async ({ page }) => {
    await openSection(page, "general", "General");
    const trigger = page.getByRole("button", { name: "Project icon" });
    await expect(trigger).toHaveText("📋");
    await trigger.click();

    const picker = page.getByRole("dialog", { name: "Project icon" });
    const search = picker.getByLabel("Search icons");
    await expect(search).toBeFocused();

    await search.fill("fix");
    await expect(picker.getByRole("button", { name: "🐛" })).toBeVisible();
    await expect(picker.getByRole("button", { name: "🔧" })).toBeVisible();
    // The control: what the words do not describe is gone, not merely scrolled away
    await expect(picker.getByRole("button", { name: "🚀" })).toHaveCount(0);

    await search.fill("zzz");
    await expect(picker.getByText("No icons match “zzz”.")).toBeVisible();

    await search.fill("defect");
    await expect(picker.getByRole("button")).toHaveCount(1);
    await picker.getByRole("button", { name: "🐛" }).click();
    await expect(picker).toBeHidden();
    await expect(trigger).toHaveText("🐛");

    await saveBar(page, projectWrite(page));
    await expectToast(page, "Changes saved");
    expect((await storedProject())?.icon).toBe("🐛");

    await page.goto(BOARD);
    await expect(boardHeader(page)).toContainText("🐛");
    await expect(boardHeader(page)).not.toContainText("📋");

    // And the picker marks it as the chosen one when it opens again
    await page.goto(`${SETTINGS}?section=general`);
    await page.getByRole("button", { name: "Project icon" }).click();
    await expect(page.getByRole("dialog", { name: "Project icon" }).getByRole("button", { name: "🐛" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  test("the description is saved, and is the line under the board's title", async ({ page }) => {
    const seeded = (await storedProject())?.description as string;
    expect(seeded, "the fixture's own description is what the change is measured against").toBeTruthy();
    await openSection(page, "general", "General");
    const description = page.getByLabel("Project description");
    await expect(description).toHaveValue(seeded);
    await description.fill("Where the run-conflict fixtures live");

    await saveBar(page, projectWrite(page));
    expect((await storedProject())?.description).toBe("Where the run-conflict fixtures live");

    await page.goto(BOARD);
    await expect(boardHeader(page).getByText("Where the run-conflict fixtures live")).toBeVisible();
    await expect(page.getByText(seeded)).toHaveCount(0);

    await page.goto(`${SETTINGS}?section=general`);
    await page.getByLabel("Project description").fill("");
    await saveBar(page, projectWrite(page));
    expect((await storedProject())?.description).toBe("");
    await page.goto(BOARD);
    await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
    await expect(page.getByText("Where the run-conflict fixtures live")).toHaveCount(0);
  });
});

test.describe("Board · columns", () => {
  const labels = async (page: Page) => {
    await expect(page.getByLabel("Column name")).toHaveCount(7);
    return page.getByLabel("Column name").evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
  };

  test("the down arrow moves a column down, and the last one's goes nowhere", async ({ page }) => {
    await openSection(page, "board", "Board");
    expect(await labels(page)).toEqual([
      "Planned",
      "To Do",
      "In Progress",
      "In Review",
      "Needs Human Review",
      "Ready to Test",
      "Done",
    ]);

    await page.getByRole("button", { name: "Move column down" }).nth(0).click();
    // The control: the last row has nowhere to go, and its arrow must not wrap it to the top
    await page.getByRole("button", { name: "Move column down" }).nth(6).click();
    expect(await labels(page)).toEqual([
      "To Do",
      "Planned",
      "In Progress",
      "In Review",
      "Needs Human Review",
      "Ready to Test",
      "Done",
    ]);

    const written = page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().endsWith("/columns")
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    expect((await written).status()).toBe(200);

    const columns = ((await storedProject())?.columns ?? []) as { id: string; order: number }[];
    expect([...columns].sort((a, b) => a.order - b.order).map((c) => c.id)).toEqual([
      "todo",
      "planned",
      "in_progress",
      "in_review",
      "needs_human_review",
      "ready_to_test",
      "done",
    ]);

    await page.reload();
    expect((await labels(page)).slice(0, 2)).toEqual(["To Do", "Planned"]);
  });
});

test.describe("Task fields · Filterable", () => {
  test("switching it on puts the field in the board's filter panel, and nothing else", async ({ page }) => {
    await seedCustomFields();
    await openSection(page, "fields", "Task fields");

    const row = page
      .locator(`span:text-is("${FIELDS.notes.name}")`)
      .locator("xpath=ancestor::div[.//button[normalize-space()='Edit']][1]");
    await row.getByRole("button", { name: "Edit" }).click();
    const filterable = page.getByRole("switch", { name: "Filterable" });
    await expect(filterable).not.toBeChecked();
    await page.getByText("Filterable", { exact: true }).click();
    await expect(filterable).toBeChecked();

    const saved = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().includes("/custom-fields")
    );
    await page.getByRole("button", { name: "Save field" }).click();
    expect((await saved).status()).toBe(200);

    const fields = ((await storedProject())?.customFields ?? []) as { name: string; filterable: boolean }[];
    expect(fields.find((f) => f.name === FIELDS.notes.name)?.filterable).toBe(true);
    expect(fields.filter((f) => f.filterable).map((f) => f.name)).toEqual([FIELDS.notes.name]);
    await expect(row).toContainText("Filterable");

    await page.goto(BOARD);
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Filters" });
    await expect(panel.getByLabel("Assignee")).toBeVisible();
    await expect(panel.getByRole("textbox", { name: FIELDS.notes.name })).toBeVisible();
    // Every other seeded field is still off, and the panel says so by not offering it
    await expect(panel.getByLabel(`${FIELDS.points.name} from`)).toHaveCount(0);
    await expect(panel.getByLabel(FIELDS.difficulty.name, { exact: true })).toHaveCount(0);
  });
});

test.describe("Workers · Default agent", () => {
  test("is set and cleared through its picker, and the store follows both", async ({ page }) => {
    await mongoose.connect(E2E_MONGODB_URI);
    const { seedAgents } = await import("@/lib/agent-seed");
    await seedAgents();
    await mongoose.disconnect();
    const defaultId = String(
      (await withDb((db) => db.collection("agents").findOne({ name: "Default" })))?._id
    );

    await openSection(page, "workers", "Workers");
    const picker = page.getByLabel("Default agent");
    await expect(picker).toBeEnabled();
    await expect(picker).toHaveValue("");
    await expect(picker.locator("option").filter({ hasText: /^Default$/ })).toHaveCount(1);

    const agentWrite = () =>
      page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/agent"));

    let written = agentWrite();
    await picker.selectOption({ label: "Default" });
    expect((await written).status()).toBe(200);
    expect(String((await storedProject())?.worker?.agent)).toBe(defaultId);
    await page.reload();
    await expect(page.getByLabel("Default agent")).toHaveValue(defaultId);

    written = agentWrite();
    await page.getByLabel("Default agent").selectOption({ label: "No default — the task picker starts empty" });
    expect((await written).status()).toBe(200);
    expect((await storedProject())?.worker?.agent ?? null).toBeNull();
    await page.reload();
    await expect(page.getByLabel("Default agent")).toHaveValue("");
  });
});
