import { test, expect, type Locator, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { ADMIN_AUTH } from "./api";
import {
  ADMIN_ID,
  E2E_MONGODB_URI,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  seed,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-397. Recurrence had three tests in `field-history.spec.ts` — the activity note, an occurrence
 * being created, and a negative control — plus unit tests that mock `Task.create`. None of them
 * asserted the **computed due date**, which is the thing a person actually notices, and the two
 * screens that configure it had no coverage at all.
 *
 * There is no "next occurrence preview" anywhere in the product, despite the ticket's wording —
 * neither `TaskForm` nor `PropertyRail` renders one. Nothing here pretends otherwise.
 */

const BOARD = `/projects/${PROJECT_KEY}`;
const DAY_MS = 86400000;

/**
 * Mid-May, and deliberately. The closing tests compare exact millisecond differences, so a base
 * date near a clock change would make `+7 days` off by an hour in some zones and not others. Any
 * date moved here should stay clear of late March and late October.
 */
const BASE_DUE = () => new Date(2026, 4, 12, 12, 0, 0);

async function withDb<T>(fn: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
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

async function storedTask(taskNumber: number): Promise<Record<string, unknown> | null> {
  return withDb(async (db) => db.collection("tasks").findOne({ project: PROJECT_ID, taskNumber }));
}

/** Every task on the board, so a new occurrence can be told from the ones already there. */
async function taskNumbers(): Promise<number[]> {
  return withDb(async (db) => {
    const rows = await db
      .collection("tasks")
      .find({ project: PROJECT_ID }, { projection: { taskNumber: 1 } })
      .toArray();
    return rows.map((r) => Number(r.taskNumber)).sort((a, b) => a - b);
  });
}

/** Puts a due date and a half-ticked checklist on the seeded task. */
async function giveDueDate(due: Date) {
  await withDb(async (db) => {
    await db.collection("tasks").updateOne(
      { _id: SIBLING_TASK_ID },
      {
        $set: {
          dueDate: due,
          assignee: ADMIN_ID,
          checklist: [
            { text: "first", done: true },
            { text: "second", done: false },
          ],
        },
      }
    );
  });
}

test.beforeEach(seed);

const repeatsRow = (page: Page) => page.getByRole("button", { name: /^Repeats/ });

/**
 * The create form's Repeats picker, reached by structure rather than by its label.
 *
 * `Select` renders its `<label>` with no `htmlFor` and does not wrap the control, so the select has
 * no accessible name and `getByRole("combobox", { name: "Repeats" })` finds nothing — BP-450, and
 * this is the second spec forced into the same workaround. Replace it with the role the day that
 * lands.
 */
const repeatsSelect = (page: Page): Locator =>
  page.getByText("Repeats", { exact: true }).locator("xpath=following-sibling::select");
/**
 * The interval control, scoped rather than page-wide. It is the only spinbutton on these screens
 * today only because this spec never seeds a number custom field; one of those would turn an
 * unscoped `getByRole("spinbutton")` into a strict-mode violation.
 */
const intervalBox = (page: Page): Locator => page.locator("#main-content, [role=dialog]").getByRole("spinbutton");

/** Opens the Repeats panel on the task's own screen. */
async function openRepeats(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
  await expect(page.getByRole("textbox", { name: "Title" })).toBeVisible();
  await repeatsRow(page).click();
}

test.describe("choosing a rhythm on the create form", () => {
  async function openNewTask(page: Page) {
    await signIn(page);
    await page.goto(BOARD);
    await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
    await page.getByRole("button", { name: "New task" }).click();
    await expect(page.getByRole("dialog", { name: "New Task" })).toBeVisible();
  }

  test("there is no interval to set until something is repeating", async ({ page }) => {
    await openNewTask(page);

    await expect(intervalBox(page)).toHaveCount(0);
    await expect(page.getByText("Every", { exact: true })).toHaveCount(0);

    await repeatsSelect(page).selectOption("weekly");

    await expect(intervalBox(page)).toBeVisible();
    await expect(intervalBox(page)).toHaveValue("1");
  });

  test("the unit follows the rhythm, which nothing on the server decides", async ({ page }) => {
    await openNewTask(page);
    const repeats = repeatsSelect(page);

    await repeats.selectOption("daily");
    await expect(page.getByText("day(s)")).toBeVisible();
    await repeats.selectOption("weekly");
    await expect(page.getByText("week(s)")).toBeVisible();
    await expect(page.getByText("day(s)")).toHaveCount(0);
    await repeats.selectOption("monthly");
    await expect(page.getByText("month(s)")).toBeVisible();
  });

  test("what was chosen is what the task is created with", async ({ page }) => {
    await openNewTask(page);

    await page.getByLabel("Title").fill("Water the plants");
    await repeatsSelect(page).selectOption("weekly");
    await intervalBox(page).fill("2");
    await page.getByRole("button", { name: "Create Task" }).click();

    await expect(page.getByRole("dialog", { name: "New Task" })).toHaveCount(0);
    await expect
      .poll(async () =>
        withDb(async (db) => {
          const task = await db.collection("tasks").findOne({ title: "Water the plants" });
          return task?.recurrence ?? null;
        })
      )
      .toMatchObject({ frequency: "weekly", interval: 2 });
  });

  test("an interval below one is not a rhythm, and the form says one instead", async ({ page }) => {
    await openNewTask(page);
    await repeatsSelect(page).selectOption("daily");

    // `-5`, not `0`. The floor is `Math.max(1, parseInt(value) || 1)`, and at "0" the two halves
    // are indistinguishable — `parseInt("0") || 1` is already 1, so deleting `Math.max` leaves a
    // test that only fills "0" perfectly green. A negative is the value that tells them apart.
    await intervalBox(page).fill("-5");
    await expect(intervalBox(page)).toHaveValue("1");
    await intervalBox(page).fill("0");
    await expect(intervalBox(page)).toHaveValue("1");
    await intervalBox(page).fill("7");
    await expect(intervalBox(page)).toHaveValue("7");
  });
});

test.describe("changing it on the task itself", () => {
  test("reads Never until it is set, and then reads what it does", async ({ page }) => {
    await signIn(page);
    await openRepeats(page);

    await expect(page.getByRole("option", { name: "Never" })).toBeVisible();
    await expect(intervalBox(page)).toHaveCount(0);

    await page.getByRole("option", { name: "monthly" }).click();
    await intervalBox(page).fill("3");

    // "Every 3 months", not "Every 3 monthly" — the sentence is assembled in the browser from
    // RECURRENCE_UNITS, and the singular below is the half that catches a naive template
    await expect(repeatsRow(page)).toContainText("Every 3 months");

    await intervalBox(page).fill("1");
    await expect(repeatsRow(page)).toContainText("Every month");
    await expect(repeatsRow(page)).not.toContainText("Every 1 month");
  });

  test("it is kept, and is there on the way back in", async ({ page }) => {
    await signIn(page);
    await openRepeats(page);

    await page.getByRole("option", { name: "weekly" }).click();
    await intervalBox(page).fill("2");
    await page.keyboard.press("Escape");

    await expect
      .poll(async () => (await storedTask(SIBLING_TASK_NUMBER))?.recurrence)
      .toMatchObject({ frequency: "weekly", interval: 2 });

    await page.reload();
    await expect(page.getByRole("textbox", { name: "Title" })).toBeVisible();
    await expect(repeatsRow(page)).toContainText("Every 2 weeks");
  });

  test("and it can be taken off again", async ({ page }) => {
    // Seeded as already repeating. `seed()` stores `recurrence: null`, so a test that sets it in
    // the browser and then polls for null is satisfied by the state it started in — break the
    // write path entirely and it stays green. Starting from a stored recurrence is what makes the
    // null below a thing that happened.
    await withDb(async (db) => {
      await db
        .collection("tasks")
        .updateOne({ _id: SIBLING_TASK_ID }, { $set: { recurrence: { frequency: "daily", interval: 4 } } });
    });

    await signIn(page);
    await openRepeats(page);
    await expect(intervalBox(page)).toHaveValue("4");

    await page.getByRole("option", { name: "Never" }).click();

    // The interval goes with it: an interval with nothing to repeat is a control over nothing
    await expect(intervalBox(page)).toHaveCount(0);
    await expect(repeatsRow(page)).toContainText("Never");
    await expect
      .poll(async () => (await storedTask(SIBLING_TASK_NUMBER))?.recurrence ?? null)
      .toBeNull();
  });
});

test.describe("what happens when the task is closed", () => {
  /** Closes the seeded task through the board's own context menu. */
  async function closeOnTheBoard(page: Page) {
    await page.goto(BOARD);
    await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
    const card = page.locator(`a[href="/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}"]`);
    await expect(card).toBeVisible();
    await card.click({ button: "right" });
    await page
      .getByTestId("task-context-menu")
      .getByRole("button", { name: "Done", exact: true })
      .click();
    await expect(
      page.getByTestId("column-done").locator(`a[href*="/tasks/${SIBLING_TASK_NUMBER}"]`)
    ).toBeVisible();
  }

  /** The occurrence created by closing, whichever number it was given. */
  async function newOccurrence(before: number[]): Promise<Record<string, unknown>> {
    let created: Record<string, unknown> | null = null;
    await expect
      .poll(
        async () => {
          const after = await taskNumbers();
          const fresh = after.filter((n) => !before.includes(n));
          if (fresh.length !== 1) return fresh.length;
          created = await storedTask(fresh[0]);
          return 1;
        },
        { timeout: 20_000 }
      )
      .toBe(1);
    return created!;
  }

  test("a weekly task comes back a week later, with the checklist untouched by last time", async ({
    page,
  }) => {
    const due = BASE_DUE();
    await giveDueDate(due);
    await withDb(async (db) => {
      await db
        .collection("tasks")
        .updateOne({ _id: SIBLING_TASK_ID }, { $set: { recurrence: { frequency: "weekly", interval: 1 } } });
    });

    await signIn(page);
    const before = await taskNumbers();
    await closeOnTheBoard(page);

    const created = await newOccurrence(before);
    expect(new Date(created.dueDate as Date).getTime() - due.getTime()).toBe(7 * DAY_MS);
    // Ticked items came back ticked would be the quiet defect: the next occurrence is work to do
    expect(created.checklist).toMatchObject([
      { text: "first", done: false },
      { text: "second", done: false },
    ]);
    // The series keeps its standing assignment rather than landing on nobody
    expect(String(created.assignee)).toBe(String(ADMIN_ID));
    expect(created.status).toBe("planned");
  });

  /**
   * One per frequency, and both with an interval above one.
   *
   * A single weekly test at interval 1 leaves `7 * interval` untested — mutating it to a bare `7`
   * is a no-op against it, which is exactly what happened to the first version of this file. The
   * daily and weekly lines are separate arithmetic and need separate cases.
   */
  for (const { frequency, interval, days } of [
    { frequency: "daily", interval: 3, days: 3 },
    { frequency: "weekly", interval: 2, days: 14 },
  ] as const) {
    test(`${frequency} every ${interval} comes back ${days} days later`, async ({ page }) => {
      const due = BASE_DUE();
      await giveDueDate(due);
      await withDb(async (db) => {
        await db
          .collection("tasks")
          .updateOne({ _id: SIBLING_TASK_ID }, { $set: { recurrence: { frequency, interval } } });
      });

      await signIn(page);
      const before = await taskNumbers();
      await closeOnTheBoard(page);

      const created = await newOccurrence(before);
      expect(new Date(created.dueDate as Date).getTime() - due.getTime()).toBe(days * DAY_MS);
    });
  }

  test("a monthly task on a day every month has comes back in the right month", async ({ page }) => {
    // The plain case, which the overflow BP-461 was about never touched: a mid-month date is the
    // same under `setMonth` and under the clamp that replaced it. It is here to pin the branch —
    // without it, deleting `case "monthly"` outright leaves only the 31st test below, and that one
    // is about the day of the month rather than about the month advancing at all.
    const due = new Date(2026, 4, 15, 12, 0, 0);
    await giveDueDate(due);
    await withDb(async (db) => {
      await db
        .collection("tasks")
        .updateOne({ _id: SIBLING_TASK_ID }, { $set: { recurrence: { frequency: "monthly", interval: 2 } } });
    });

    await signIn(page);
    const before = await taskNumbers();
    await closeOnTheBoard(page);

    const created = await newOccurrence(before);
    const next = new Date(created.dueDate as Date);
    // 15 May + 2 months, and the day of the month is kept
    expect([next.getFullYear(), next.getMonth(), next.getDate()]).toEqual([2026, 6, 15]);
  });

  test("a monthly task due on the 31st comes back on the last day of the next month", async ({
    page,
  }) => {
    // BP-461. `setMonth` does not clamp, so 31 January used to become 3 March: the series skipped
    // February entirely and then drifted, because the occurrence after that was computed from the
    // 3rd. Measured before the fix: Jan 31 -> Mar 3, Jan 29 -> Mar 1, Mar 31 -> May 1.
    //
    // Driven through the board rather than through `nextRecurrenceDue` directly, which its own
    // unit tests cover: what this adds is that the date a person actually receives on the new card
    // is the clamped one — the value survives the write, the schema's cast and the read back.
    const due = new Date(2026, 0, 31, 12, 0, 0);
    await giveDueDate(due);
    await withDb(async (db) => {
      await db
        .collection("tasks")
        .updateOne({ _id: SIBLING_TASK_ID }, { $set: { recurrence: { frequency: "monthly", interval: 1 } } });
    });

    await signIn(page);
    const before = await taskNumbers();
    await closeOnTheBoard(page);

    const created = await newOccurrence(before);
    const next = new Date(created.dueDate as Date);
    expect([next.getFullYear(), next.getMonth(), next.getDate()]).toEqual([2026, 1, 28]);
  });

  test("a task with no rhythm leaves nothing behind", async ({ page, request }) => {
    // The control for all of the above, driven the same way — through the board rather than
    // through the API, which is the path `field-history` already covers.
    //
    // Worth being exact about its reach: nothing recurs here for two independent reasons, and
    // removing either alone leaves this green. The gate on `oldTask.recurrence` is one;
    // `createNextRecurrence` destructuring a null recurrence and throwing into a `.catch` is the
    // other. Both mutated together turn it red — measured. So it watches the behaviour, not a
    // line, and either guard on its own is enough to hold it.
    await signIn(page);
    const before = await taskNumbers();
    await closeOnTheBoard(page);

    // Given the budget the positive cases needed and then some
    await page.waitForTimeout(6_000);
    expect(await taskNumbers()).toEqual(before);

    const still = await request.get(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`, {
      headers: ADMIN_AUTH,
    });
    expect((await still.json()).status).toBe("done");
  });
});
