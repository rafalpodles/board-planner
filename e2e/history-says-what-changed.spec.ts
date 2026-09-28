import { test, expect, type Locator, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { db } from "./notification-grid";
import {
  ADMIN_ID,
  PROJECT_AGENT_ID,
  PROJECT_AGENT_NAME,
  PROJECT_KEY,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  seed,
  seedAgents,
  storedActivity,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-729 and BP-730: two things History recorded too little of. Acceptance criteria changed with
 * no row at all, and an agent change read as two ObjectIds. Every sentence is asserted exactly on
 * the History panel, because the rows are what the product writes and the panel is what it says.
 */

const TASK_URL = `/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;
const ADMIN_FULL_NAME = "E2E Admin";

test.beforeEach(async () => {
  await seed();
  await seedAgents();
});

async function openTask(page: Page) {
  await signIn(page);
  await page.goto(TASK_URL);
  await expect(page.getByRole("textbox", { name: "Title" })).toBeVisible();
}

function taskPut(page: Page) {
  return page.waitForResponse(
    (r) => r.request().method() === "PUT" && r.url().endsWith(`/tasks/${SIBLING_TASK_ID}`)
  );
}

// Waits for a row, which only an answered read can show; an empty panel shows none either way
async function openHistory(page: Page): Promise<Locator> {
  await page.getByRole("tab", { name: /^History/ }).click();
  const panel = page.locator("#task-panel-history");
  await expect(panel.getByRole("time").first()).toBeVisible();
  const showAll = panel.getByRole("button", { name: /Show all \d+ entries/ });
  if (await showAll.isVisible()) await showAll.click();
  return panel;
}

const sentence = (panel: Locator, text: string) => panel.getByText(`${ADMIN_FULL_NAME} ${text}`, { exact: true });

test.describe("an agent change", () => {
  test("names the agent it was switched to, not its id", async ({ page }) => {
    await openTask(page);

    const saved = taskPut(page);
    await page.getByRole("combobox", { name: "Agent" }).click();
    await page.getByRole("option", { name: PROJECT_AGENT_NAME }).click();
    expect((await saved).status()).toBe(200);

    // The name is what is stored, so it survives the agent being deleted later
    const stored = (await storedActivity(SIBLING_TASK_ID)).find((row) => row.field === "agent");
    expect(stored).toMatchObject({ oldValue: "", newValue: PROJECT_AGENT_NAME });

    const panel = await openHistory(page);
    await expect(sentence(panel, `changed agent from no agent to “${PROJECT_AGENT_NAME}”`)).toBeVisible();
    await expect(panel.getByText(String(PROJECT_AGENT_ID))).toHaveCount(0);
  });

  test("written before names were stored, reads as names, and as a deleted agent when it is gone", async ({
    page,
  }) => {
    const gone = new mongoose.Types.ObjectId();
    await (await db()).collection("activitylogs").insertOne({
      task: SIBLING_TASK_ID,
      user: ADMIN_ID,
      action: "updated",
      field: "agent",
      oldValue: String(PROJECT_AGENT_ID),
      newValue: String(gone),
      customField: false,
      fieldType: "",
      createdAt: new Date(),
    });

    await openTask(page);
    const panel = await openHistory(page);

    await expect(sentence(panel, `changed agent from “${PROJECT_AGENT_NAME}” to a deleted agent`)).toBeVisible();
  });
});

test.describe("acceptance criteria", () => {
  const criterion = (page: Page, text: string) => page.getByRole("checkbox", { name: text, exact: true });

  test("each change to a criterion is in History, and typing its text reads as one edit", async ({ page }) => {
    await openTask(page);

    let saved = taskPut(page);
    const addBox = page.getByLabel("Add criterion");
    await addBox.fill("Loads");
    await addBox.press("Enter");
    await expect(criterion(page, "Loads")).toBeVisible();
    expect((await saved).status()).toBe(200);

    saved = taskPut(page);
    await criterion(page, "Loads").click();
    expect((await saved).status()).toBe(200);

    // Two separate autosaves of one edit, each its own row in the store
    await page.getByRole("button", { name: "Criterion 1", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Criterion 1", exact: true });
    saved = taskPut(page);
    await editor.press("End");
    await editor.pressSequentially(" fast");
    expect((await saved).status()).toBe(200);
    saved = taskPut(page);
    await editor.pressSequentially(", cached");
    expect((await saved).status()).toBe(200);
    await editor.blur();

    saved = taskPut(page);
    await criterion(page, "Loads fast, cached").click();
    expect((await saved).status()).toBe(200);

    saved = taskPut(page);
    await page.getByRole("button", { name: "Remove criterion 1" }).click();
    expect((await saved).status()).toBe(200);

    const edits = (await storedActivity(SIBLING_TASK_ID)).filter((row) => row.action === "criterion_edited");
    expect(edits.length).toBeGreaterThanOrEqual(2);

    await page.reload();
    const panel = await openHistory(page);
    await expect(sentence(panel, "added criterion “Loads”")).toBeVisible();
    await expect(sentence(panel, "checked criterion “Loads”")).toBeVisible();
    await expect(sentence(panel, "changed criterion “Loads” to “Loads fast, cached”")).toBeVisible();
    await expect(panel.getByText(/changed criterion/)).toHaveCount(1);
    await expect(sentence(panel, "unchecked criterion “Loads fast, cached”")).toBeVisible();
    await expect(sentence(panel, "removed criterion “Loads fast, cached”")).toBeVisible();
  });
});
