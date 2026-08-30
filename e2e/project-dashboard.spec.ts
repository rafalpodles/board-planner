import { test, expect, type Locator, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH, MEMBER_AUTH } from "./api";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  MEMBER_ID,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  SECOND_PROJECT_ID,
  SECOND_PROJECT_KEY,
  SECOND_PROJECT_NAME,
  seed,
  seedSecondProject,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-390. The dashboard's chart geometry already has a unit suite of its own
 * (`dashboard/page.test.tsx`), so nothing here re-measures a bar against a hand-written props
 * object. What only an end-to-end run can say is whether a **real board**, through the real
 * `/stats` aggregation, arrives in the browser as the numbers a person would count by hand.
 *
 * Two properties of the fixture are load-bearing and were arrived at by mutation, not by taste:
 *
 * - **7 tasks, 3 of them done.** Not 4 and 2. `Math.round(3 / 7 * 100)` is 43 and truncation
 *   would say 42, so the one arithmetic decision the browser makes on its own can fail.
 * - **The server's own key order is not the order the page draws.** `assigneeBreakdown` and
 *   `categoryBreakdown` are plain objects built in `$push` order, and `HorizontalBars` sorts them
 *   descending in the browser. A fixture whose tasks happen to arrive largest-bucket-first cannot
 *   tell a working sort from a missing one — so the tasks are deliberately inserted in an order
 *   that is neither, and the API response is read in the same test as the control.
 */

const WEEK_MS = 7 * 86400000;
const weeksAgo = (weeks: number) => new Date(Date.now() - weeks * WEEK_MS);

const DIFFICULTY_FIELD_ID = new mongoose.Types.ObjectId("e2e00000000000000000f390");
const UNUSED_FIELD_ID = new mongoose.Types.ObjectId("e2e00000000000000000f391");

const FIELD_DEFAULTS = {
  required: false,
  showOnCard: false,
  showInList: false,
  filterable: false,
  archived: false,
};

const CUSTOM_FIELDS = [
  {
    ...FIELD_DEFAULTS,
    _id: DIFFICULTY_FIELD_ID,
    name: "Difficulty",
    fieldType: "dropdown",
    // id === value, which is what a field defined before CP-211 carries and what the real board
    // still has. The chart prints whatever `$customFieldValues.<id>` holds, so an option whose id
    // differs from its value renders as the id — BP-447. This fixture is deliberately the safe
    // shape, and so says nothing about that either way.
    options: ["S", "L", "XL"].map((value, order) => ({ id: value, value, color: "#6b7280", order })),
    order: 0,
  },
  // Nobody's task carries this one. It is the control for the usage count on the delete dialog.
  { ...FIELD_DEFAULTS, _id: UNUSED_FIELD_ID, name: "Notes", fieldType: "text", options: [], order: 1 },
];

const TOTAL = 7;
const DONE = 3;
const IN_PROGRESS = 2;
/** Math.round, not truncation: 3/7 is 42.857… */
const COMPLETION = "43%";

const REVIEWED_TASK = 205;

/**
 * The board the whole file reads.
 *
 * `createdAt`/`updatedAt` sit half a week inside their bucket, as far from a week boundary as the
 * eight-week window allows, so nothing here depends on what time the suite runs.
 */
const FIXTURE = [
  // number, status, category, assignee, difficulty, createdAt, updatedAt
  { n: 200, title: "Mooring mast rigged", status: "done", category: "doc", assignee: MEMBER_ID, difficulty: "L", created: 6.5, updated: 1.5 },
  { n: 201, title: "Gondola bolts torqued", status: "done", category: "bug", assignee: MEMBER_ID, difficulty: "S", created: 6.5, updated: 1.5 },
  { n: 202, title: "Envelope patched", status: "done", category: "bug", assignee: ADMIN_ID, difficulty: "S", created: 6.5, updated: 5.5 },
  { n: 203, title: "Ballast trial underway", status: "in_progress", category: "user-story", assignee: MEMBER_ID, difficulty: "S", created: 6.5, updated: 6.5 },
  { n: 204, title: "Weather brief underway", status: "in_progress", category: "bug", assignee: MEMBER_ID, difficulty: "XL", created: 2.5, updated: 2.5 },
  { n: REVIEWED_TASK, title: "Hangar doors reviewed", status: "in_review", category: "user-story", assignee: null, difficulty: "L", created: 2.5, updated: 2.5 },
  // Older than the eight-week window on both timestamps: it counts towards Total and towards its
  // column, and appears in neither time chart. Without it, "the window is a window" is untested.
  { n: 206, title: "Logbook from the old airship", status: "todo", category: "bug", assignee: null, difficulty: "", created: 10, updated: 10 },
] as const;

/** Buckets 0..7 of the eight-week window, counted from the fixture above by hand. */
const CREATED_PER_WEEK = [0, 4, 0, 0, 0, 2, 0, 0];
const COMPLETED_PER_WEEK = [0, 0, 1, 0, 0, 0, 2, 0];

async function withDb<T>(fn: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  // seed.ts's own connect() refuses a database whose name does not end in _e2e, and this helper
  // runs deleteMany. Relying on seed() having thrown first makes the guard transitive and silent.
  const dbName = new URL(E2E_MONGODB_URI.replace(/^mongodb/, "http")).pathname.slice(1);
  if (!dbName.endsWith("_e2e")) {
    throw new Error(`Refusing to touch database "${dbName}": this fixture only runs against *_e2e`);
  }
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    const handle = mongoose.connection.db;
    if (!handle) throw new Error("no database handle");
    return await fn(handle);
  } finally {
    await mongoose.disconnect();
  }
}

async function seedDashboardBoard() {
  await withDb(async (db) => {
    // seed()'s own four cards would make every count below a sum of two fixtures
    await db.collection("tasks").deleteMany({ project: PROJECT_ID });

    // Both boards get the same fields. Without them on the empty board, its blank difficulty
    // chart would mean "this project has no Difficulty field" and the empty-state assertion
    // would be reading something other than the emptiness it names.
    await db.collection("projects").updateMany(
      { _id: { $in: [PROJECT_ID, SECOND_PROJECT_ID] } },
      { $set: { customFields: CUSTOM_FIELDS } }
    );
    await db.collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { taskCounter: 206 } });

    await db.collection("tasks").insertMany(
      FIXTURE.map((row) => ({
        _id: new mongoose.Types.ObjectId(),
        project: PROJECT_ID,
        taskNumber: row.n,
        title: row.title,
        description: "",
        priority: "medium",
        category: row.category,
        status: row.status,
        assignee: row.assignee,
        dueDate: null,
        checklist: [],
        linkedPRs: [],
        blockedBy: [],
        relations: [],
        watchers: [],
        sprint: null,
        customFieldValues: row.difficulty
          ? { [String(DIFFICULTY_FIELD_ID)]: row.difficulty }
          : {},
        recurrence: null,
        recurringParentId: null,
        order: 0,
        createdBy: ADMIN_ID,
        createdAt: weeksAgo(row.created),
        updatedAt: weeksAgo(row.updated),
      }))
    );
  });
}

test.beforeEach(async () => {
  await seed();
  await seedSecondProject();
  await seedDashboardBoard();
});

const dashboardUrl = (key: string) => `/projects/${key}/dashboard`;

/** The value beside a summary label — `<p>Total Tasks</p><p>7</p>`. */
function summary(page: Page, label: string): Locator {
  return page
    .locator("p")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::p[1]");
}

/** One of the six chart cards, addressed by its heading rather than by its classes. */
function chart(page: Page, heading: string): Locator {
  return page.getByRole("heading", { name: heading, exact: true }).locator("xpath=..");
}

/** The rows of a HorizontalBars chart, in the order the browser drew them. */
function barRows(page: Page, heading: string): Locator {
  return chart(page, heading).locator("h2 + div > div");
}

async function openDashboard(page: Page, key = PROJECT_KEY, name = PROJECT_NAME) {
  await page.goto(dashboardUrl(key));
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  // Scoped to the page rather than the document: the sidebar names the project too
  await expect(main(page).getByText(name, { exact: true })).toBeVisible();
}

/** The page itself, with the sidebar left out of it. */
function main(page: Page): Locator {
  return page.locator("#main-content");
}

/** A drawn bar's height in px, rounded — the browser's own arithmetic, not the API's. */
async function barHeight(bar: Locator): Promise<number> {
  const box = await bar.boundingBox();
  return box ? Math.round(box.height) : -1;
}

/** Uncaught exceptions, which is what "renders without crashing" actually means. */
function recordCrashes(page: Page): string[] {
  const crashes: string[] = [];
  page.on("pageerror", (error) => crashes.push(String(error)));
  return crashes;
}

test.describe("a board with tasks on it", () => {
  test("the summary cards are the board, counted", async ({ page, request }) => {
    await signIn(page);
    await openDashboard(page);

    await expect(summary(page, "Total Tasks")).toHaveText(String(TOTAL));
    await expect(summary(page, "Completed")).toHaveText(String(DONE));
    await expect(summary(page, "In Progress")).toHaveText(String(IN_PROGRESS));

    // The control: the same numbers, counted from the tasks themselves rather than from the
    // aggregation the page and this assertion would otherwise both be reading.
    const tasks = await request.get(`/api/projects/${PROJECT_KEY}/tasks`, { headers: ADMIN_AUTH });
    expect(tasks.status()).toBe(200);
    const rows = (await tasks.json()) as { status: string }[];
    expect(rows).toHaveLength(TOTAL);
    expect(rows.filter((t) => t.status === "done")).toHaveLength(DONE);
    expect(rows.filter((t) => t.status === "in_progress")).toHaveLength(IN_PROGRESS);
  });

  test("completion is rounded, not truncated", async ({ page }) => {
    await signIn(page);
    await openDashboard(page);

    // 3/7 is 42.857…, so a page that truncated would say 42% and one that rounded says 43%.
    await expect(summary(page, "Completion")).toHaveText(COMPLETION);
  });

  test("the status donut leaves out the columns nobody is standing in", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await openDashboard(page);

    const stats = await request.get(`/api/projects/${PROJECT_KEY}/stats`, { headers: ADMIN_AUTH });
    expect(stats.status()).toBe(200);
    const { statusBreakdown } = (await stats.json()) as {
      statusBreakdown: Record<string, number>;
    };

    // The control. The server answers with every status the instance knows, zeroes included —
    // so an empty legend row is a decision the browser makes, not one it is handed.
    expect(statusBreakdown).toMatchObject({
      planned: 0,
      todo: 1,
      in_progress: 2,
      in_review: 1,
      needs_human_review: 0,
      ready_to_test: 0,
      done: 3,
    });

    const legend = chart(page, "Status Breakdown").locator("svg + div > div");
    await expect(legend).toHaveText([/^To Do1$/, /^In Progress2$/, /^In Review1$/, /^Done3$/]);
  });

  test("the donut legend prints a readable label, not a raw status id", async ({ page }) => {
    await signIn(page);
    await openDashboard(page);

    const card = chart(page, "Status Breakdown");
    await expect(card.getByText("In Progress", { exact: true })).toBeVisible();
    await expect(card.getByText("in_progress", { exact: true })).toHaveCount(0);
    await expect(card.locator("svg text")).toHaveText(String(TOTAL));

    // Deliberately NOT named "the way the board does". On the seeded board the project's own
    // labels and the static STATUS_LABELS map hold the same strings, so no assertion here can
    // tell which one the legend read. BP-446 fixed the legend to read the project, and proves
    // it on a board sharing no id with the seeded seven — `dashboard-reads-the-board.spec.ts`.
  });

  test("assignee bars are sorted by the browser, tallest first, with an Unassigned bucket", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await openDashboard(page);

    const stats = await request.get(`/api/projects/${PROJECT_KEY}/stats`, { headers: ADMIN_AUTH });
    const { assigneeBreakdown } = (await stats.json()) as {
      assigneeBreakdown: Record<string, number>;
    };
    expect(assigneeBreakdown).toEqual({ "E2E Member": 4, "E2E Admin": 1, Unassigned: 2 });

    // The control. If the server ever started answering in descending order this assertion fails
    // loudly, because from that day on the rendered order proves nothing about the browser.
    const served = Object.values(assigneeBreakdown);
    expect(
      served.every((value, i) => i === 0 || served[i - 1] >= value),
      "the fixture must not hand the page an already-sorted breakdown"
    ).toBe(false);

    await expect(barRows(page, "By Assignee")).toHaveText([
      /^E2E Member4$/,
      /^Unassigned2$/,
      /^E2E Admin1$/,
    ]);
  });

  test("category bars are sorted by the browser too", async ({ page, request }) => {
    await signIn(page);
    await openDashboard(page);

    const stats = await request.get(`/api/projects/${PROJECT_KEY}/stats`, { headers: ADMIN_AUTH });
    const { categoryBreakdown } = (await stats.json()) as {
      categoryBreakdown: Record<string, number>;
    };
    expect(categoryBreakdown).toEqual({ doc: 1, bug: 4, "user-story": 2 });

    const served = Object.values(categoryBreakdown);
    expect(
      served.every((value, i) => i === 0 || served[i - 1] >= value),
      "the fixture must not hand the page an already-sorted breakdown"
    ).toBe(false);

    await expect(barRows(page, "By Category")).toHaveText([/^bug4$/, /^user-story2$/, /^doc1$/]);
  });

  test("the difficulty split comes from the project field, not from a column on the task", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await openDashboard(page);

    const stats = await request.get(`/api/projects/${PROJECT_KEY}/stats`, { headers: ADMIN_AUTH });
    const { difficultyBreakdown } = (await stats.json()) as {
      difficultyBreakdown: Record<string, number>;
    };
    // One task carries no Difficulty at all, so the bars add up to six and not to seven
    expect(difficultyBreakdown).toEqual({ L: 2, S: 3, XL: 1 });

    const served = Object.values(difficultyBreakdown);
    expect(
      served.every((value, i) => i === 0 || served[i - 1] >= value),
      "the fixture must not hand the page an already-sorted breakdown"
    ).toBe(false);

    // No two counts are equal, so the order does not rest on the sort being stable over whatever
    // document order the aggregation happened to see
    await expect(barRows(page, "By Difficulty")).toHaveText([/^S3$/, /^L2$/, /^XL1$/]);
  });

  test("velocity counts the week a task reached Done, and draws nothing for a quiet week", async ({
    page,
  }) => {
    await signIn(page);
    await openDashboard(page);

    const columns = chart(page, "Velocity (tasks done/week)").locator("h2 + div > div > div");
    await expect(columns).toHaveCount(8);

    // `d.value || ""` — a week with no completion gets a blank, never a nought
    await expect(columns).toHaveText(
      COMPLETED_PER_WEEK.map((count) => (count ? String(count) : ""))
    );

    // Heights are the browser's arithmetic: the tallest week owns the whole 112px track and the
    // one-task week is half of it. Reading them is how a chart that "renders" is told from one
    // that means something.
    await expect.poll(() => barHeight(columns.nth(6).locator("div"))).toBe(112);
    await expect.poll(() => barHeight(columns.nth(2).locator("div"))).toBe(56);
  });

  test("created vs completed is the same eight weeks, from both timestamps", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await openDashboard(page);

    const stats = await request.get(`/api/projects/${PROJECT_KEY}/stats`, { headers: ADMIN_AUTH });
    const { createdOverTime, velocity } = (await stats.json()) as {
      createdOverTime: { week: string; created: number; completed: number }[];
      velocity: { week: string; count: number }[];
    };

    expect(createdOverTime.map((w) => w.created)).toEqual(CREATED_PER_WEEK);
    expect(createdOverTime.map((w) => w.completed)).toEqual(COMPLETED_PER_WEEK);
    expect(velocity.map((w) => w.count)).toEqual(COMPLETED_PER_WEEK);

    const card = chart(page, "Created vs Completed");
    await expect(card.getByText("Created", { exact: true })).toBeVisible();
    await expect(card.getByText("Completed", { exact: true })).toBeVisible();

    const weeks = card.locator("h2 + div > div").first().locator("> div");
    await expect(weeks).toHaveCount(8);

    // Unlike the velocity bars, these are sized as a percentage of an h-32 parent — the very
    // shape BarChart's own comment records having shipped as collapsed bars once. So they are
    // measured rather than counted: 4 created is the whole 128px track, 2 is half of it, and the
    // completed bar beside it is a quarter.
    const created = (week: number) => barHeight(weeks.nth(week).locator("> div").first());
    const completed = (week: number) => barHeight(weeks.nth(week).locator("> div").last());
    await expect.poll(() => created(1)).toBe(128);
    await expect.poll(() => created(5)).toBe(64);
    await expect.poll(() => completed(2)).toBe(32);
    await expect.poll(() => completed(6)).toBe(64);
    await expect.poll(() => created(0)).toBe(0);
  });

  test("a task older than the window still counts on the board and in neither time chart", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await openDashboard(page);

    // TP-206 was created ten weeks ago and has never moved. It is one of the seven.
    await expect(summary(page, "Total Tasks")).toHaveText(String(TOTAL));
    await expect(barRows(page, "By Category")).toHaveText([/^bug4$/, /^user-story2$/, /^doc1$/]);

    const stats = await request.get(`/api/projects/${PROJECT_KEY}/stats`, { headers: ADMIN_AUTH });
    const { createdOverTime } = (await stats.json()) as {
      createdOverTime: { created: number }[];
    };
    // Six of the seven were created inside the window; the seventh is nowhere in it
    expect(createdOverTime.reduce((sum, w) => sum + w.created, 0)).toBe(TOTAL - 1);
  });

  test("the sidebar's own count agrees with the dashboard's", async ({ page }) => {
    await signIn(page);
    await openDashboard(page);

    // Two aggregations that never see each other: /api/projects counts for the sidebar pill,
    // /stats counts for the card. They are the same board, so they are the same number.
    // Not `a[href=…]` filtered on "Board": the project's own row link has the same href, and the
    // seeded project is called "E2E Run Conflict Board", so that matches two anchors and lands on
    // the pill only because the row happens to come first in the DOM.
    const boardLink = page.getByRole("link", { name: /^Board \d+$/ });
    await expect(boardLink).toHaveCount(1);
    await expect(boardLink.locator("span").last()).toHaveText(String(TOTAL));
    await expect(summary(page, "Total Tasks")).toHaveText(String(TOTAL));
  });

  test("the dashboard is reachable from the sidebar, not only by URL", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}`);
    await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();

    await page.getByRole("link", { name: "Dashboard" }).click();

    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/dashboard$`));
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    // The subtitle comes from the project request, the cards from the stats request: seeing both
    // is what says the page did not settle for half of what it asked for
    await expect(main(page).getByText(PROJECT_NAME, { exact: true })).toBeVisible();
    await expect(summary(page, "Total Tasks")).toHaveText(String(TOTAL));
  });

  test("moving a card on the board moves the numbers on the dashboard", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}`);
    await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();

    const card = page.locator(`a[href="/projects/${PROJECT_KEY}/tasks/${REVIEWED_TASK}"]`);
    await expect(card).toBeVisible();

    // The board's own path, not a PATCH: what this test is about is the round trip
    const moved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().includes("/tasks/") &&
        response.ok()
    );
    await card.click({ button: "right" });
    await page.getByTestId("task-context-menu").getByRole("button", { name: "Done", exact: true }).click();
    await moved;

    await openDashboard(page);
    await expect(summary(page, "Completed")).toHaveText(String(DONE + 1));
    await expect(summary(page, "Total Tasks")).toHaveText(String(TOTAL));
    // 4/7 is 57.14…
    await expect(summary(page, "Completion")).toHaveText("57%");
    await expect(summary(page, "In Progress")).toHaveText(String(IN_PROGRESS));
    // In Review is empty now, so it drops out of the legend the same way Planned always was
    const legend = chart(page, "Status Breakdown").locator("svg + div > div");
    await expect(legend).toHaveText([/^To Do1$/, /^In Progress2$/, /^Done4$/]);
  });
});

test.describe("the other reader of the same endpoint", () => {
  /**
   * `/stats` is not only the dashboard's. `TaskFieldsSection` reads `customFieldUsage` from it to
   * fill in "Used by N tasks" on the dialog that offers to delete a field and every value on it.
   * That is a destructive path fed by an endpoint whose shape gets changed for the dashboard's
   * sake, so it is asserted here, next to the change that would break it, rather than nowhere.
   */
  const fieldRow = (page: Page, name: string) =>
    // span(name) -> div(flex) -> div(min-w) -> the row
    page.getByText(name, { exact: true }).locator("xpath=../../..");

  test("counts the tasks a field would take with it, before it is deleted", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/settings?section=fields`);
    await expect(page.getByRole("heading", { name: "Task fields", exact: true })).toBeVisible();

    await fieldRow(page, "Difficulty").getByRole("button", { name: "Delete" }).click();
    // Six of the seven tasks carry a Difficulty; the seventh is the one outside the window
    await expect(page.getByText("Used by 6 tasks. Archiving hides the field and keeps their values.")).toBeVisible();

    // Nothing is deleted by this test — the count is the subject
    await page.getByRole("button", { name: "Cancel" }).click();
  });

  test("and says so plainly when a field holds nothing", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/settings?section=fields`);
    await expect(page.getByRole("heading", { name: "Task fields", exact: true })).toBeVisible();

    // The control for the test above: same dialog, same board, a field nobody has filled in
    await fieldRow(page, "Notes").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("No task holds a value for it.")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
  });
});

test.describe("a project with nothing on it", () => {
  test("renders every chart as its empty state rather than as bare axes", async ({ page }) => {
    const crashes = recordCrashes(page);
    await signIn(page);
    await openDashboard(page, SECOND_PROJECT_KEY, SECOND_PROJECT_NAME);

    await expect(
      page.getByText("No tasks on the board yet — every task counts towards its column here.")
    ).toBeVisible();
    await expect(
      page.getByText(
        "No tasks completed in the last 8 weeks — each week a task reaches Done adds a bar."
      )
    ).toBeVisible();
    await expect(
      page.getByText("No tasks yet — categories appear as soon as the board has tasks.")
    ).toBeVisible();
    await expect(
      page.getByText("Nobody is assigned yet — assign a task to see the split per person.")
    ).toBeVisible();
    await expect(
      page.getByText("No tasks yet — the S/M/L/XL split shows up once tasks exist.")
    ).toBeVisible();
    await expect(
      page.getByText(
        "Nothing created or completed in the last 8 weeks — new and finished tasks show up here."
      )
    ).toBeVisible();

    expect(crashes).toEqual([]);
  });

  test("counts nothing as nought, and completion as 0% rather than as NaN", async ({ page }) => {
    await signIn(page);
    await openDashboard(page, SECOND_PROJECT_KEY, SECOND_PROJECT_NAME);

    await expect(summary(page, "Total Tasks")).toHaveText("0");
    await expect(summary(page, "Completed")).toHaveText("0");
    await expect(summary(page, "In Progress")).toHaveText("0");
    await expect(summary(page, "Completion")).toHaveText("0%");
    await expect(page.getByText("NaN", { exact: false })).toHaveCount(0);
    await expect(page.getByTestId("toast")).toHaveCount(0);
  });
});

test.describe("who may read a dashboard", () => {
  test("a member reads the board they hold a grant on", async ({ page, request }) => {
    await signIn(page, "member");
    await openDashboard(page);

    await expect(summary(page, "Total Tasks")).toHaveText(String(TOTAL));

    const stats = await request.get(`/api/projects/${PROJECT_KEY}/stats`, { headers: MEMBER_AUTH });
    expect(stats.status()).toBe(200);
  });

  test("and is refused the board they do not", async ({ page, request }) => {
    // The negative's control is the test above: the same reader, the same page, one grant apart.
    const stats = await request.get(`/api/projects/${SECOND_PROJECT_KEY}/stats`, {
      headers: MEMBER_AUTH,
    });
    expect(stats.status()).toBe(403);

    await signIn(page, "member");
    await page.goto(dashboardUrl(SECOND_PROJECT_KEY));

    /**
     * A banner that stays, not a toast that is gone in three seconds — and one that says which
     * refusal this was. Before BP-448 this asserted `/Failed to load dashboard/` on a toast, and
     * what the reader was left with once it expired was a spinner that never stopped.
     */
    await expect(page.getByTestId("dashboard-error")).toContainText(
      "You do not have access to this board"
    );
    // The heading is chrome and now renders above the banner, deliberately, so the reader can see
    // which page refused them. The charts are the thing that must not be there.
    await expect(page.getByRole("heading", { name: "Status Breakdown" })).toHaveCount(0);
    await expect(page.getByTestId("toast")).toHaveCount(0);
  });
});

test.describe("read on a phone, and read by nobody", () => {
  test("every card and chart is still there at 390px, and the page does not scroll sideways", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await openDashboard(page);

    await expect(summary(page, "Total Tasks")).toHaveText(String(TOTAL));
    await expect(summary(page, "Completed")).toHaveText(String(DONE));
    await expect(summary(page, "In Progress")).toHaveText(String(IN_PROGRESS));
    await expect(summary(page, "Completion")).toHaveText(COMPLETION);

    for (const heading of [
      "Status Breakdown",
      "Velocity (tasks done/week)",
      "By Category",
      "By Assignee",
      "By Difficulty",
      "Created vs Completed",
    ]) {
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    }

    // Measured on #main-content, not on the document. The shell's scrollport is the <main>, which
    // carries overflow-y-auto and nothing horizontal — so content wider than it is clipped and
    // unreachable while `document.documentElement.scrollWidth` stays exactly the viewport width.
    // A first version of this assertion read the document and could not fail: a deliberate 900px
    // page left html at 390/390 and only #main-content at 932/390.
    const overflow = await main(page).evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, "the dashboard is wider than the phone it is being read on").toBeLessThanOrEqual(0);
  });

  test("a signed-out visitor is sent to sign in, not shown an empty dashboard", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(dashboardUrl(PROJECT_KEY));

    await expect(page).toHaveURL(/\/login/);
    // The shell must not have rendered any of it on the way past
    await expect(page.getByRole("heading", { name: "Dashboard" })).toHaveCount(0);
    await expect(summary(page, "Total Tasks")).toHaveCount(0);
  });
});
