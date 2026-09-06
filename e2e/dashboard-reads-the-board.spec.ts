import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH } from "./api";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn as arriveSignedIn } from "./session";

const COLUMNS = [
  { id: "icebox", label: "Icebox", color: "#6b7280", role: "backlog", order: 0 },
  { id: "ready", label: "Ready", color: "#3b82f6", role: "approved", order: 1 },
  { id: "building", label: "Building", color: "#e11d48", role: "active", order: 2 },
  { id: "polishing", label: "Polishing", color: "#0ea5e9", role: "active", order: 3 },
  { id: "shipped", label: "Shipped", color: "#22c55e", role: "done", order: 4 },
];

const DIFFICULTY_OPTIONS = [
  { id: "zz-small", value: "S", color: "#4ade80", order: 0 },
  { id: "zz-large", value: "L", color: "#f59e0b", order: 1 },
  { id: "ancient", order: 2 },
];

const CATEGORIES = [
  { name: "bug", color: "#7c3aed" },
  { name: "doc", color: "#0d9488" },
];

const signIn = arriveSignedIn;

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

let difficultyFieldId: mongoose.Types.ObjectId;

test.beforeEach(async () => {
  await seed();
  const handle = await db();

  difficultyFieldId = new mongoose.Types.ObjectId();
  await handle.collection("projects").updateOne(
    { _id: PROJECT_ID },
    {
      $set: {
        columns: COLUMNS,
        categories: CATEGORIES,
        customFields: [
          {
            _id: difficultyFieldId,
            name: "Difficulty",
            fieldType: "dropdown",
            options: DIFFICULTY_OPTIONS,
            archived: false,
            order: 0,
          },
        ],
      },
    },
  );

  await handle.collection("tasks").deleteMany({ project: PROJECT_ID });

  const now = new Date();
  const LONG_AGO = new Date(now.getTime() - 10 * 7 * 24 * 60 * 60 * 1000);
  await handle.collection("tasks").insertMany([
    ...["building", "building"].map((status, i) => ({
      project: PROJECT_ID,
      taskNumber: 900 + i,
      title: `In flight ${i}`,
      status,
      priority: "medium",
      category: "bug",
      customFieldValues: { [String(difficultyFieldId)]: "zz-large" },
      createdAt: now,
      updatedAt: now,
      watchers: [],
      checklist: [],
      blockedBy: [],
      relations: [],
    })),
    {
      project: PROJECT_ID,
      taskNumber: 911,
      title: "Carries a pre-CP-211 option",
      status: "building",
      priority: "medium",
      category: "bug",
      customFieldValues: { [String(difficultyFieldId)]: "ancient" },
      createdAt: now,
      updatedAt: now,
      watchers: [],
      checklist: [],
      blockedBy: [],
      relations: [],
    },
    {
      project: PROJECT_ID,
      taskNumber: 912,
      title: "Being polished",
      status: "polishing",
      priority: "medium",
      category: "doc",
      customFieldValues: { [String(difficultyFieldId)]: "zz-large" },
      createdAt: now,
      updatedAt: now,
      watchers: [],
      checklist: [],
      blockedBy: [],
      relations: [],
    },
    {
      project: PROJECT_ID,
      taskNumber: 910,
      title: "Landed",
      status: "shipped",
      priority: "medium",
      category: "bug",
      customFieldValues: { [String(difficultyFieldId)]: "zz-small" },
      createdAt: LONG_AGO,
      updatedAt: now,
      watchers: [],
      checklist: [],
      blockedBy: [],
      relations: [],
    },
  ]);
});

async function openDashboard(page: Page) {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/dashboard`);
  await expect(page.getByRole("heading", { name: "Status Breakdown" })).toBeVisible();
}

function card(page: Page, title: string) {
  return page.locator("div").filter({ hasText: new RegExp(`^${title}\\d`) }).last();
}

test("the numbers count this board's columns, not the ids they were seeded with", async ({
  page,
}) => {
  await openDashboard(page);

  await expect(card(page, "Total Tasks")).toContainText("5");
  await expect(card(page, "In Progress")).toContainText("4");
  await expect(card(page, "Completed")).toContainText("1");
  await expect(card(page, "Completion")).toContainText("20%");
});

test("the legend names the board's columns and paints them its colours", async ({ page }) => {
  await openDashboard(page);

  const legend = page.locator("h2", { hasText: "Status Breakdown" }).locator("..");
  await expect(legend).toContainText("Building");
  await expect(legend).toContainText("Shipped");

  await expect(legend).not.toContainText("In Progress");
  await expect(legend).not.toContainText("Done");
  await expect(legend).not.toContainText("building");
  await expect(legend).not.toContainText("shipped");

  const swatches = await legend.locator("span.rounded-sm").evaluateAll((els) =>
    els.map((el) => getComputedStyle(el).backgroundColor),
  );
  expect(swatches).toContain("rgb(225, 29, 72)");
  expect(swatches).toContain("rgb(14, 165, 233)");
});

test("the difficulty chart says what the option is called, not what it is stored as", async ({
  page,
}) => {
  await openDashboard(page);

  const chart = page.locator("h2", { hasText: "By Difficulty" }).locator("..");

  const row = (label: string, count: number) =>
    chart.locator("div.flex.items-center").filter({ hasText: new RegExp(`^${label}${count}$`) });

  await expect(row("L", 3)).toHaveCount(1);
  await expect(row("S", 1)).toHaveCount(1);
  await expect(row("ancient", 1)).toHaveCount(1);

  await expect(chart).not.toContainText("zz-large");
  await expect(chart).not.toContainText("zz-small");
  await expect(chart).not.toContainText("undefined");
});

test("velocity and the completed line count the done role, not the id `done`", async ({
  request,
}) => {
  const response = await request.get(`/api/projects/${PROJECT_KEY}/stats`, {
    headers: ADMIN_AUTH,
  });
  expect(response.status(), await response.text()).toBe(200);
  const stats = await response.json();

  expect(stats.done).toBe(1);
  expect(stats.statusBreakdown.building).toBe(3);
  expect(stats.statusBreakdown.polishing).toBe(1);

  const velocity = (stats.velocity as { week: string; count: number }[]).reduce(
    (n, w) => n + w.count,
    0,
  );
  expect(velocity, "a renamed done column left this chart empty").toBe(1);

  const completed = (
    stats.createdOverTime as { week: string; created: number; completed: number }[]
  ).reduce((n, w) => n + w.completed, 0);
  expect(completed, "the created-vs-completed line counted the literal id too").toBe(1);

  expect(Object.keys(stats.difficultyBreakdown).sort()).toEqual(["L", "S", "ancient"]);
});

test("the category chart is painted from the project's own categories", async ({ page }) => {
  await openDashboard(page);

  const chart = page.locator("h2", { hasText: "By Category" }).locator("..");
  const bars = await chart.locator("div.h-full.rounded").evaluateAll((els) =>
    els.map((el) => getComputedStyle(el).backgroundColor),
  );
  expect(bars).toContain("rgb(124, 58, 237)");
  expect(bars).toContain("rgb(13, 148, 136)");
});
