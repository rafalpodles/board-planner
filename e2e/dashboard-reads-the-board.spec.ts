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

/**
 * Two things here are load-bearing and easy to lose.
 *
 * **Building's colour is one no seeded palette carries.** Give a column the same hex the old
 * table used for its role and the swatch assertion below cannot tell a resolved colour from a
 * hardcoded one — the canonical-fixture trap this file's header is about, one floor down.
 *
 * **Two columns carry the `active` role.** In Progress sums them, and a fixture with one would
 * pass just as well against `columnIdsWithRole(...)[0]`.
 */
const COLUMNS = [
  { id: "icebox", label: "Icebox", color: "#6b7280", role: "backlog", order: 0 },
  { id: "ready", label: "Ready", color: "#3b82f6", role: "approved", order: 1 },
  { id: "building", label: "Building", color: "#e11d48", role: "active", order: 2 },
  { id: "polishing", label: "Polishing", color: "#0ea5e9", role: "active", order: 3 },
  { id: "shipped", label: "Shipped", color: "#22c55e", role: "done", order: 4 },
];

/**
 * `id ≠ value` is the only shape in which a missing resolution can show. The third is the shape
 * the field's `Mixed` type exists for: a pre-CP-211 option carrying no `value` at all, which a
 * hand-rolled `String(o.value)` turns into the literal "undefined" — and merges with any other
 * such option into one bar with their counts added together.
 */
const DIFFICULTY_OPTIONS = [
  { id: "zz-small", value: "S", color: "#4ade80", order: 0 },
  { id: "zz-large", value: "L", color: "#f59e0b", order: 1 },
  { id: "ancient", order: 2 },
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
            fieldType: "dropdown",
            options: DIFFICULTY_OPTIONS,
            archived: false,
            order: 0,
          },
        ],
      },
    },
  );

  // Every seeded task sits in a column this board no longer has, which would muddy the counts
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
      // Created outside the eight-week window and finished inside it. Velocity matches on
      // `updatedAt`, so a task created `now` is caught by the other arm of that `$or` and
      // cannot tell a role-resolved match from the literal `done` it replaced.
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

/** The number under a summary card's title */
function card(page: Page, title: string) {
  return page.locator("div").filter({ hasText: new RegExp(`^${title}\\d`) }).last();
}

test("the numbers count this board's columns, not the ids they were seeded with", async ({
  page,
}) => {
  await openDashboard(page);

  // Five tasks: three in Building and one in Polishing (both role active), one Shipped (done).
  // In Progress is 4 only if both active columns are summed.
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

  // The control: none of the seeded labels can be on screen, because no seeded id is on this board
  await expect(legend).not.toContainText("In Progress");
  await expect(legend).not.toContainText("Done");
  // Nor the raw ids the labels replace. These are the two negatives that actually go red against
  // the old code, and they lean on `toContainText` being case-sensitive by default — the legend
  // does read "Building" and "Shipped". Do not add `ignoreCase` here.
  await expect(legend).not.toContainText("building");
  await expect(legend).not.toContainText("shipped");

  const swatches = await legend.locator("span.rounded-sm").evaluateAll((els) =>
    els.map((el) => getComputedStyle(el).backgroundColor),
  );
  // #e11d48 Building — a hex no seeded palette carries, so this cannot pass against a lookup
  // that resolved the role in the old table instead of reading the board
  expect(swatches).toContain("rgb(225, 29, 72)");
  expect(swatches).toContain("rgb(14, 165, 233)");
});

test("the difficulty chart says what the option is called, not what it is stored as", async ({
  page,
}) => {
  await openDashboard(page);

  const chart = page.locator("h2", { hasText: "By Difficulty" }).locator("..");

  // A row, label and count together — not the bare letters. This chart's empty state reads
  // "the S/M/L/XL split shows up once tasks exist", so `toContainText("S")` passes on a chart
  // with nothing in it, and every assertion here would have been green against no data at all.
  const row = (label: string, count: number) =>
    chart.locator("div.flex.items-center").filter({ hasText: new RegExp(`^${label}${count}$`) });

  await expect(row("L", 3)).toHaveCount(1);
  await expect(row("S", 1)).toHaveCount(1);
  // An option with no `value` falls back to its id, the way every other reader of these options
  // does. A hand-rolled `String(o.value)` labels it "undefined" — and merges every such option
  // into one bar with the counts added together.
  await expect(row("ancient", 1)).toHaveCount(1);

  // The stored ids, which is what reached the screen before
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

  // The Shipped task was created ten weeks ago and finished this week, so it can only be here
  // through the arm that matches on status — the one that used to read the literal `done`.
  const velocity = (stats.velocity as { week: string; count: number }[]).reduce(
    (n, w) => n + w.count,
    0,
  );
  expect(velocity, "a renamed done column left this chart empty").toBe(1);

  // Same task, same reason, through the other hardcoded line: the completed series.
  const completed = (
    stats.createdOverTime as { week: string; created: number; completed: number }[]
  ).reduce((n, w) => n + w.completed, 0);
  expect(completed, "the created-vs-completed line counted the literal id too").toBe(1);

  // Resolved to the option's value on the way out, so every reader gets a label
  expect(Object.keys(stats.difficultyBreakdown).sort()).toEqual(["L", "S", "ancient"]);
});

test("the category chart is painted from the project's own categories", async ({ page }) => {
  await openDashboard(page);

  const chart = page.locator("h2", { hasText: "By Category" }).locator("..");
  const bars = await chart.locator("div.h-full.rounded").evaluateAll((els) =>
    els.map((el) => getComputedStyle(el).backgroundColor),
  );
  expect(bars.length).toBeGreaterThan(0);
  // The seeded project's own `doc` colour. The dashboard's retired table painted doc #3b82f6,
  // so a chart still reading that table cannot produce this pixel.
  const docColour = await page.evaluate(async (key) => {
    const res = await fetch(`/api/projects/${key}`, { credentials: "include" });
    const project = await res.json();
    return (project.categories ?? []).find((c: { name: string }) => c.name === "doc")?.color;
  }, PROJECT_KEY);
  expect(docColour, "the seeded project defines its own categories").toBeTruthy();
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(String(docColour).slice(i, i + 2), 16));
  expect(bars).toContain(`rgb(${r}, ${g}, ${b})`);
});
