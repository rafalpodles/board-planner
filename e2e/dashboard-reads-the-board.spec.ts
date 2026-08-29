import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH } from "./api";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn as arriveSignedIn } from "./session";

/**
 * BP-446 and BP-447. The dashboard and the route behind it keyed on the seeded column ids and on
 * a difficulty option's stored id, so a board that renamed anything read its own numbers wrong.
 *
 * **This board shares no id with the seeded seven, on purpose.** `e2e/seed.ts` seeds the default
 * ids *and* the default labels, so on it `STATUS_LABELS[id]` and `columns[].label` are the same
 * string and no assertion can tell a hardcoded lookup from a resolved one — the shape
 * `column-roles.spec.ts` describes about itself in its own header.
 */

const COLUMNS = [
  { id: "icebox", label: "Icebox", color: "#6b7280", role: "backlog", order: 0 },
  { id: "ready", label: "Ready", color: "#3b82f6", role: "approved", order: 1 },
  { id: "building", label: "Building", color: "#f59e0b", role: "active", order: 2 },
  { id: "shipped", label: "Shipped", color: "#22c55e", role: "done", order: 3 },
];

/** id ≠ value, which is the only shape in which a missing resolution can show */
const DIFFICULTY_OPTIONS = [
  { id: "zz-small", value: "S" },
  { id: "zz-large", value: "L" },
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
        customFields: [
          {
            _id: difficultyFieldId,
            name: "Difficulty",
            type: "select",
            options: DIFFICULTY_OPTIONS,
            active: true,
            order: 0,
          },
        ],
      },
    },
  );

  // Every seeded task sits in a column this board no longer has, which would muddy the counts
  await handle.collection("tasks").deleteMany({ project: PROJECT_ID });

  const now = new Date();
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
      taskNumber: 910,
      title: "Landed",
      status: "shipped",
      priority: "medium",
      category: "bug",
      customFieldValues: { [String(difficultyFieldId)]: "zz-small" },
      createdAt: now,
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

/** The number under a summary card's title */
function card(page: Page, title: string) {
  return page.locator("div").filter({ hasText: new RegExp(`^${title}\\d`) }).last();
}

test("the numbers count this board's columns, not the ids they were seeded with", async ({
  page,
}) => {
  await openDashboard(page);

  // Three tasks: two in Building (role active), one in Shipped (role done)
  await expect(card(page, "Total Tasks")).toContainText("3");
  await expect(card(page, "In Progress")).toContainText("2");
  await expect(card(page, "Completed")).toContainText("1");
  await expect(card(page, "Completion")).toContainText("33%");
});

test("the legend names the board's columns and paints them its colours", async ({ page }) => {
  await openDashboard(page);

  const legend = page.locator("h2", { hasText: "Status Breakdown" }).locator("..");
  await expect(legend).toContainText("Building");
  await expect(legend).toContainText("Shipped");

  // The control: none of the seeded labels can be on screen, because no seeded id is on this board
  await expect(legend).not.toContainText("In Progress");
  await expect(legend).not.toContainText("Done");
  // Nor the raw ids the labels replace
  await expect(legend).not.toContainText("building");
  await expect(legend).not.toContainText("shipped");

  const swatches = await legend.locator("span.rounded-sm").evaluateAll((els) =>
    els.map((el) => getComputedStyle(el).backgroundColor),
  );
  // #f59e0b Building and #22c55e Shipped — the board's own, not the dashboard's old table
  expect(swatches).toContain("rgb(245, 158, 11)");
  expect(swatches).toContain("rgb(34, 197, 94)");
});

test("the difficulty chart says what the option is called, not what it is stored as", async ({
  page,
}) => {
  await openDashboard(page);

  const chart = page.locator("h2", { hasText: "By Difficulty" }).locator("..");
  await expect(chart).toContainText("L");
  await expect(chart).toContainText("S");
  // The stored ids, which is what reached the screen before
  await expect(chart).not.toContainText("zz-large");
  await expect(chart).not.toContainText("zz-small");
});

test("the API counts done by role, so velocity is not empty on a renamed board", async ({
  request,
}) => {
  const response = await request.get(`/api/projects/${PROJECT_KEY}/stats`, {
    headers: ADMIN_AUTH,
  });
  expect(response.status(), await response.text()).toBe(200);
  const stats = await response.json();

  expect(stats.done).toBe(1);
  expect(stats.statusBreakdown.building).toBe(2);
  // Resolved to the option's value on the way out, so every reader gets a label
  expect(Object.keys(stats.difficultyBreakdown).sort()).toEqual(["L", "S"]);
});
