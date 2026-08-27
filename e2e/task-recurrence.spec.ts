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
  SIBLING_TASK_TITLE,
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
// UTC midnight, which is what a due date actually is: `<input type="date">` sends "2026-05-12"
// and Mongoose casts a date-only ISO string to this. The local-noon `Date` this used to build was
// a shape no user can produce, and it is why nothing here could see BP-485.
const BASE_DUE = () => new Date("2026-05-12");

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

  // Both of these were entirely uncovered, and each is the shape of defect BP-463 exists to fix.
  // Measured before adding them: replacing the create form's `endDate: recurrenceEnd || null` with
  // a hard `null` — a field that collects a date and throws it away — left the whole spec green,
  // and so did reverting its interval clamp. The only test that drove 400 was on the task detail
  // screen, which is a different component.
  test("an end set on the create form is what the task is created with", async ({ page }) => {
    await openNewTask(page);

    await page.getByLabel("Title").fill("Renew the certificate");
    await repeatsSelect(page).selectOption("monthly");
    await page.getByLabel("Repeats until").fill("2027-03-01");
    await page.getByRole("button", { name: "Create Task" }).click();

    await expect(page.getByRole("dialog", { name: "New Task" })).toHaveCount(0);
    await expect
      .poll(async () =>
        withDb(async (db) => {
          const task = await db.collection("tasks").findOne({ title: "Renew the certificate" });
          const end = task?.recurrence?.endDate;
          // The whole value, not just its presence: a date that arrives as the wrong day is its own
          // bug, and `toMatchObject` on frequency and interval is exactly what missed this before
          return end === undefined ? "absent" : end === null ? null : new Date(end).toISOString();
        })
      )
      .toBe("2027-03-01T00:00:00.000Z");
  });

  test("an interval pasted past the maximum is clamped before it is submitted", async ({ page }) => {
    await openNewTask(page);
    await repeatsSelect(page).selectOption("daily");

    await intervalBox(page).fill("400");
    await expect(intervalBox(page)).toHaveValue("365");

    await page.getByLabel("Title").fill("Not every four hundred days");
    await page.getByRole("button", { name: "Create Task" }).click();

    await expect(page.getByRole("dialog", { name: "New Task" })).toHaveCount(0);
    await expect
      .poll(async () =>
        withDb(async (db) => {
          const task = await db
            .collection("tasks")
            .findOne({ title: "Not every four hundred days" });
          return task?.recurrence?.interval ?? null;
        })
      )
      .toBe(365);
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
    const due = new Date("2026-05-15");
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
    expect([next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate()]).toEqual([2026, 6, 15]);
  });

  test("a monthly task due on the 31st comes back on the last day of the next month", async ({
    page,
  }) => {
    // BP-461. `setMonth` does not clamp, so 31 January used to become 3 March: the series skipped
    // February entirely and then drifted, because the occurrence after that was computed from the
    // 3rd. Measured before the fix: Jan 31 -> Mar 3, Jan 29 -> Mar 1, Mar 31 -> May 1.
    //
    // Driven through the board rather than through `nextRecurrenceDue` directly, which its own
    // unit tests cover: what this adds is that closing a task really does reach the clamp, and the
    // clamped date really is what comes back on the new card.
    //
    // Seeded as UTC midnight, the value a person's date input really produces, and asserted in UTC.
    // That pairing is BP-485: the arithmetic used to read the stored value with local getters, so
    // on a server west of UTC 31 January read as the 30th and this landed in March. The unit tests
    // pin the timezone-independence itself by running the same input under seven zones; what this
    // adds is that the shape reaching the database, and coming back on the new card, is that one.
    const due = new Date("2026-01-31");
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
    expect([next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate()]).toEqual([2026, 1, 28]);
  });

  // BP-463. A series had no way to stop: `endDate` was neither stored nor refused, so a client
  // that set one got a 200 and a task that repeated forever. Both arms here, because a silence
  // caused by a mis-wired fixture reads exactly like a silence caused by the end being honoured.
  test("a series past its end stops, and one still inside it does not", async ({ page }) => {
    const due = new Date("2026-05-12");
    await giveDueDate(due);

    // The end is BEFORE the occurrence this close would mint (19 May), so the series is over
    await withDb(async (db) => {
      await db.collection("tasks").updateOne(
        { _id: SIBLING_TASK_ID },
        { $set: { recurrence: { frequency: "weekly", interval: 1, endDate: new Date("2026-05-15") } } }
      );
    });

    await signIn(page);
    const before = await taskNumbers();
    await closeOnTheBoard(page);

    // The same budget the positive cases get, so this is a real absence rather than an early look
    await page.waitForTimeout(6_000);
    expect(await taskNumbers(), "the series ran past its end").toEqual(before);

    // The control, and the reason this test can be trusted: move the end past 19 May and the very
    // same close mints the occurrence. Only the end date differs between the two halves.
    await withDb(async (db) => {
      await db.collection("tasks").updateMany(
        { _id: SIBLING_TASK_ID },
        {
          $set: {
            status: "todo",
            dueDate: due,
            recurrence: { frequency: "weekly", interval: 1, endDate: new Date("2026-12-31") },
          },
          $unset: { recurringParentId: "" },
        }
      );
    });

    await closeOnTheBoard(page);
    const created = await newOccurrence(before);
    expect(new Date(created.dueDate as Date).toISOString()).toBe("2026-05-19T00:00:00.000Z");
  });

  // The other half of BP-463's end: `endDate` reaches the server from the task screen, and a value
  // it cannot read is refused rather than dropped. Driven through the UI because the silent
  // discard was invisible exactly there — the row saved, said nothing, and forgot the date.
  test("an end set on the task screen is stored, and comes back on the way in", async ({ page }) => {
    await signIn(page);
    await openRepeats(page);

    await page.getByRole("option", { name: "weekly" }).click();
    await page.getByLabel("Repeats until").fill("2026-12-31");

    await expect
      .poll(async () =>
        withDb(async (db) => {
          const task = await db.collection("tasks").findOne({ _id: SIBLING_TASK_ID });
          const end = task?.recurrence?.endDate;
          return end ? new Date(end).toISOString().slice(0, 10) : null;
        })
      )
      .toBe("2026-12-31");

    await openRepeats(page);
    await expect(page.getByLabel("Repeats until")).toHaveValue("2026-12-31");
  });

  // `max` on the number input stops neither typing nor pasting, and for a year it was the only
  // thing standing between a pasted 400 and the database.
  test("an interval above the advertised maximum never reaches the database", async ({ page, request }) => {
    await signIn(page);
    await openRepeats(page);

    await page.getByRole("option", { name: "daily" }).click();
    await intervalBox(page).fill("400");

    await expect(intervalBox(page)).toHaveValue("365");
    await expect
      .poll(async () =>
        withDb(async (db) => {
          const task = await db.collection("tasks").findOne({ _id: SIBLING_TASK_ID });
          return task?.recurrence?.interval ?? null;
        })
      )
      .toBe(365);

    // The other half, and it needs a different instrument: the clamp above means no sequence of
    // clicks can put 400 on the wire, so the browser alone cannot say whether anything behind it
    // would have refused. Who reaches this is MCP, the PM agent and anything else holding a token.
    //
    // Measured, both mutations, and the UI test above stays green through both: with the service
    // bound removed the schema's own `max` throws a ValidationError nobody catches and the route
    // answers **500**; with the schema's removed as well it answers **200** and stores 400. This
    // line is the only thing in the suite that tells those three apart.
    const refused = await request.put(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}`, {
      headers: ADMIN_AUTH,
      data: { recurrence: { frequency: "daily", interval: 400 } },
    });

    expect(refused.status()).toBe(400);
    expect(await refused.text()).toContain("365");

    // The control: one inside the bound is accepted, so the refusal above is about the value
    // rather than about the field being rejected wholesale
    const accepted = await request.put(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}`, {
      headers: ADMIN_AUTH,
      data: { recurrence: { frequency: "daily", interval: 365 } },
    });

    expect(accepted.status(), await accepted.text()).toBe(200);
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

/**
 * BP-462. The product's other "make me another one of these" path, and it disagreed with the one
 * above on three fields: the copy did not repeat, its priority reset to medium, and the checklist
 * came over with its ticks — a task claiming half its work was already done.
 *
 * Both writers are driven, because they disagreed with each other too: the task screen omitted the
 * priority the board's context menu sent.
 */
test.describe("duplicating one of these", () => {
  const SPRINT_ID = new mongoose.Types.ObjectId("e2e00000000000000000c701");
  const COPY_TITLE = `Copy of ${SIBLING_TASK_TITLE}`;

  /** The catalog the product ships, so the task can be paired with an agent that exists. */
  async function catalogAgentId(): Promise<mongoose.Types.ObjectId> {
    await mongoose.connect(E2E_MONGODB_URI);
    const { seedAgents } = await import("@/lib/agent-seed");
    await seedAgents();
    await mongoose.disconnect();

    const agent = await withDb(async (db) => db.collection("agents").findOne({}));
    if (!agent) throw new Error("the shipped catalog seeded no agent to pair the task with");
    return agent._id as mongoose.Types.ObjectId;
  }

  /**
   * The seeded task made worth copying: a rhythm, a priority that is not the default, half its
   * criteria ticked, and all three hand-over fields set.
   *
   * Every value here has to differ from what a copy would have anyway. `medium` is
   * DEFAULT_PRIORITY, and a task with no sprint or no agent would satisfy the drops below without
   * anything having been dropped.
   */
  async function makeWorthCopying() {
    const agentId = await catalogAgentId();
    await giveDueDate(BASE_DUE());
    await withDb(async (db) => {
      // Planned rather than active: an active sprint becomes the board's scope, and the board test
      // below reaches this card through the unscoped board
      await db.collection("sprints").insertOne({
        _id: SPRINT_ID,
        project: PROJECT_ID,
        name: "Sprint Duplicate",
        startDate: BASE_DUE(),
        endDate: new Date(BASE_DUE().getTime() + 14 * DAY_MS),
        goal: "",
        status: "planned",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.collection("tasks").updateOne(
        { _id: SIBLING_TASK_ID },
        {
          $set: {
            recurrence: { frequency: "weekly", interval: 2 },
            priority: "urgent",
            sprint: SPRINT_ID,
            agent: agentId,
          },
        }
      );
    });
  }

  /** The task the POST created, read back from the database rather than from the response. */
  async function copyCreatedBy(page: Page, act: () => Promise<void>) {
    const posted = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === `/api/projects/${PROJECT_KEY}/tasks`
    );
    await act();
    const response = await posted;
    expect(response.status(), await response.text()).toBe(201);
    const created = await storedTask((await response.json()).taskNumber);
    if (!created) throw new Error("the duplicate was answered 201 and is not in the database");
    return created;
  }

  function expectTheWorkAndNotTheHandover(copy: Record<string, unknown>) {
    expect(copy.title).toBe(COPY_TITLE);
    // The two omissions, and the reason for the ticket
    expect(copy.recurrence).toMatchObject({ frequency: "weekly", interval: 2 });
    expect(copy.priority).toBe("urgent");
    // Work to do, the way the next occurrence arrives
    expect(copy.checklist).toMatchObject([
      { text: "first", done: false },
      { text: "second", done: false },
    ]);
    // Dropped on purpose — see src/lib/task-duplicate.ts. The server is what enforces `agent`:
    // POST /tasks does not accept one at all, because choosing one is its own hand-over gesture.
    expect(copy.assignee ?? null).toBeNull();
    expect(copy.sprint ?? null).toBeNull();
    expect(copy.agent ?? null).toBeNull();
    // The board's own backlog column, never a literal "planned" the payload dictated (CP-128)
    expect(copy.status).toBe("planned");
  }

  test("the task screen copies the work, not the ticks and not the hand-over", async ({ page }) => {
    await makeWorthCopying();
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);
    await expect(page.getByRole("textbox", { name: "Title" })).toBeVisible();

    const copy = await copyCreatedBy(page, () =>
      page.getByRole("button", { name: "Duplicate", exact: true }).click()
    );

    expectTheWorkAndNotTheHandover(copy);
    expect(new Date(copy.dueDate as Date).getTime()).toBe(BASE_DUE().getTime());

    // The original is not a draft to be consumed: its ticks stay where the person left them
    expect((await storedTask(SIBLING_TASK_NUMBER))?.checklist).toMatchObject([
      { text: "first", done: true },
      { text: "second", done: false },
    ]);
  });

  test("and so does the board's context menu", async ({ page }) => {
    await makeWorthCopying();
    await signIn(page);
    await page.goto(BOARD);
    await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();

    const card = page.locator(`a[href="/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}"]`);
    await expect(card).toBeVisible();
    await card.click({ button: "right" });

    const copy = await copyCreatedBy(page, () =>
      // `exact`, because Playwright matches an accessible name by substring: this fixture's sprint
      // is called "Sprint Duplicate" and the menu offers it under "Move to sprint", so the loose
      // form resolves to two buttons and the click refuses. The task-screen case above already
      // says `exact` for the same reason; this one was missed, and it is red on `main`.
      page
        .getByTestId("task-context-menu")
        .getByRole("button", { name: "Duplicate", exact: true })
        .click()
    );

    expectTheWorkAndNotTheHandover(copy);
  });
});
