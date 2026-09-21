import { test, expect, type Locator, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  DECOY_TASK_ID,
  DECOY_TASK_NUMBER,
  E2E_MONGODB_URI,
  FIELDS,
  PLANNING_BACKLOG_TASK_NUMBER,
  PLANNING_SPRINT_ID,
  PLANNING_SPRINT_NAME,
  PLANNING_SPRINT_TASK_NUMBER,
  PLANNING_SECOND_SPRINT_NAME,
  PROJECT_ID,
  PROJECT_KEY,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  seed,
  seedCustomFields,
  seedSecondPlanningSprint,
  seedSprintPlanning,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-709, the board and the sprints screen: the sprint-scope switch in the board's header, the
 * "contains…" operator a text field gets in the filter panel, and the planning view's "Filter
 * backlog". Each one is judged by what it filters — a card that has to stay beside a card that
 * has to go — because a filter that hides everything and one that hides nothing both look like a
 * filter that ran.
 */

const BOARD = `/projects/${PROJECT_KEY}`;
const cardHref = (taskNumber: number) => `${BOARD}/tasks/${taskNumber}`;
const CARDS = "[data-column-body] a[href*='/tasks/']";

const card = (page: Page, taskNumber: number): Locator =>
  page.locator(`[data-column-body] a[href="${cardHref(taskNumber)}"]`);

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

test.beforeEach(seed);

async function openBoard(page: Page, expectedCards: number) {
  await signIn(page);
  await page.goto(BOARD);
  await expect(page.locator(CARDS)).toHaveCount(expectedCards);
}

test.describe("the sprint scope in the board's header", () => {
  test.beforeEach(async () => {
    await seedSprintPlanning();
    await seedSecondPlanningSprint();
  });

  const scopeFetch = (page: Page, scope: string | null) =>
    page.waitForResponse((r) => {
      const url = new URL(r.url());
      return (
        r.request().method() === "GET" &&
        url.pathname.endsWith("/tasks") &&
        url.searchParams.get("sprint") === scope
      );
    });

  async function pick(page: Page, option: string) {
    await page.getByRole("button", { name: "Change sprint scope" }).click();
    const menu = page.getByRole("menu", { name: "Sprint scope" });
    await expect(menu).toBeVisible();
    await menu.getByRole("button", { name: option, exact: true }).click();
    await expect(menu).toBeHidden();
  }

  test("each scope shows what belongs to it, and only that", async ({ page }) => {
    // Every seeded task: four from seed(), and the planning fixture's three
    await openBoard(page, 7);
    const scope = page.getByRole("button", { name: "Change sprint scope" });
    await expect(scope).toHaveText("All tasks");

    await test.step("the active sprint", async () => {
      const fetched = scopeFetch(page, String(PLANNING_SPRINT_ID));
      await pick(page, `${PLANNING_SPRINT_NAME} (Active)`);
      expect((await fetched).status()).toBe(200);
      await expect(page).toHaveURL(new RegExp(`\\?sprint=${PLANNING_SPRINT_ID}$`));
      await expect(scope).toHaveText(PLANNING_SPRINT_NAME, { timeout: 1_000 });
      await expect(card(page, PLANNING_SPRINT_TASK_NUMBER)).toBeVisible({ timeout: 1_000 });
      await expect(card(page, PLANNING_BACKLOG_TASK_NUMBER)).toHaveCount(0, { timeout: 1_000 });
      await expect(card(page, SIBLING_TASK_NUMBER)).toHaveCount(0, { timeout: 1_000 });
    });

    await test.step("the backlog", async () => {
      const fetched = scopeFetch(page, "backlog");
      await pick(page, "Backlog (no sprint)");
      expect((await fetched).status()).toBe(200);
      await expect(page).toHaveURL(/\?sprint=backlog$/);
      await expect(scope).toHaveText("Backlog", { timeout: 1_000 });
      await expect(card(page, PLANNING_BACKLOG_TASK_NUMBER)).toBeVisible({ timeout: 1_000 });
      await expect(card(page, SIBLING_TASK_NUMBER)).toBeVisible({ timeout: 1_000 });
      await expect(card(page, PLANNING_SPRINT_TASK_NUMBER)).toHaveCount(0, { timeout: 1_000 });
    });

    await test.step("a planned sprint with nothing in it yet", async () => {
      await pick(page, PLANNING_SECOND_SPRINT_NAME);
      await expect(scope).toHaveText(PLANNING_SECOND_SPRINT_NAME);
      await expect(page.locator(CARDS)).toHaveCount(0);
    });

    await test.step("and back to everything", async () => {
      const fetched = scopeFetch(page, null);
      await pick(page, "All tasks");
      expect((await fetched).status()).toBe(200);
      await expect(page).toHaveURL(new RegExp(`${BOARD}$`));
      await expect(page.locator(CARDS)).toHaveCount(7, { timeout: 1_000 });
    });

    // The scope is the URL's, so it survives a reload and the menu marks where it is
    await pick(page, "Backlog (no sprint)");
    await expect(page).toHaveURL(/\?sprint=backlog$/);
    await page.reload();
    await expect(scope).toHaveText("Backlog");
    await scope.click();
    await expect(
      page.getByRole("menu", { name: "Sprint scope" }).getByRole("button", { name: "Backlog (no sprint)" })
    ).toHaveAttribute("aria-current", "true");
    await expect(card(page, PLANNING_SPRINT_TASK_NUMBER)).toHaveCount(0);
  });
});

test.describe("the filter panel's text operator", () => {
  test("“contains…” keeps a task whose field holds the words, in any case, and drops the rest", async ({
    page,
  }) => {
    await seedCustomFields();
    await withDb(async (db) => {
      await db
        .collection("projects")
        .updateOne(
          { _id: PROJECT_ID },
          { $set: { "customFields.$[f].filterable": true } },
          { arrayFilters: [{ "f._id": FIELDS.notes._id }] }
        );
      const notes = String(FIELDS.notes._id);
      await db
        .collection("tasks")
        .updateOne({ _id: SIBLING_TASK_ID }, { $set: { [`customFieldValues.${notes}`]: "Needs a Freeze window" } });
      await db
        .collection("tasks")
        .updateOne({ _id: DECOY_TASK_ID }, { $set: { [`customFieldValues.${notes}`]: "Ships any time" } });
    });

    await openBoard(page, 4);
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Filters" });
    const contains = panel.getByPlaceholder("contains…");
    await expect(contains).toHaveAccessibleName(FIELDS.notes.name);

    await contains.fill("FREEZE");
    await expect(card(page, SIBLING_TASK_NUMBER)).toBeVisible();
    await expect(card(page, DECOY_TASK_NUMBER)).toHaveCount(0);
    // A task with no value at all does not contain anything
    await expect(page.locator(CARDS)).toHaveCount(1);
    await expect(page.getByText(`${FIELDS.notes.name}: FREEZE`)).toBeVisible();

    await contains.fill("any");
    await expect(card(page, DECOY_TASK_NUMBER)).toBeVisible();
    await expect(card(page, SIBLING_TASK_NUMBER)).toHaveCount(0);

    await contains.fill("");
    await expect(page.locator(CARDS)).toHaveCount(4);
  });
});

test.describe("the planning view's backlog filter", () => {
  test("narrows the backlog by title and gives it back when cleared, leaving the sprint alone", async ({
    page,
  }) => {
    await seedSprintPlanning();
    await signIn(page);
    await page.goto(`${BOARD}/sprints?sprint=${PLANNING_SPRINT_ID}&view=planning`);

    const backlog = page.getByTestId("planning-pane-backlog");
    const sprint = page.getByTestId("planning-pane-sprint");
    const backlogCard = (n: number) => backlog.locator(`a[href="${cardHref(n)}"]`);
    await expect(backlogCard(PLANNING_BACKLOG_TASK_NUMBER)).toBeVisible();
    await expect(backlogCard(SIBLING_TASK_NUMBER)).toBeVisible();
    const everything = await backlog.locator("a[href*='/tasks/']").count();

    const filter = page.getByPlaceholder("Filter backlog");
    await filter.fill("WAITING");
    await expect(backlogCard(PLANNING_BACKLOG_TASK_NUMBER)).toBeVisible();
    await expect(backlogCard(SIBLING_TASK_NUMBER)).toHaveCount(0);
    await expect(backlog.locator("a[href*='/tasks/']")).toHaveCount(1);
    // The sprint's own pane is not the backlog, and the filter says nothing about it
    await expect(sprint.locator(`a[href="${cardHref(PLANNING_SPRINT_TASK_NUMBER)}"]`)).toBeVisible();

    await filter.fill("nothing is called this");
    await expect(backlog.locator("a[href*='/tasks/']")).toHaveCount(0);

    await filter.fill("");
    await expect(backlog.locator("a[href*='/tasks/']")).toHaveCount(everything);
    await expect(backlogCard(SIBLING_TASK_NUMBER)).toBeVisible();
  });
});
