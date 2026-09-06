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

const BOARD = `/projects/${PROJECT_KEY}`;
const DAY_MS = 86400000;

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

async function storedTaskTitled(title: string): Promise<Record<string, unknown> | null> {
  return withDb(async (db) => db.collection("tasks").findOne({ project: PROJECT_ID, title }));
}

async function taskNumbers(): Promise<number[]> {
  return withDb(async (db) => {
    const rows = await db
      .collection("tasks")
      .find({ project: PROJECT_ID }, { projection: { taskNumber: 1 } })
      .toArray();
    return rows.map((r) => Number(r.taskNumber)).sort((a, b) => a - b);
  });
}

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

const repeatsSelect = (page: Page): Locator =>
  page.getByText("Repeats", { exact: true }).locator("xpath=following-sibling::select");
const intervalBox = (page: Page): Locator => page.locator("#main-content, [role=dialog]").getByRole("spinbutton");

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
    await withDb(async (db) => {
      await db
        .collection("tasks")
        .updateOne({ _id: SIBLING_TASK_ID }, { $set: { recurrence: { frequency: "daily", interval: 4 } } });
    });

    await signIn(page);
    await openRepeats(page);
    await expect(intervalBox(page)).toHaveValue("4");

    await page.getByRole("option", { name: "Never" }).click();

    await expect(intervalBox(page)).toHaveCount(0);
    await expect(repeatsRow(page)).toContainText("Never");
    await expect
      .poll(async () => (await storedTask(SIBLING_TASK_NUMBER))?.recurrence ?? null)
      .toBeNull();
  });
});

test.describe("what happens when the task is closed", () => {
  async function closeOnTheBoard(page: Page, taskNumber: number = SIBLING_TASK_NUMBER) {
    await page.goto(BOARD);
    await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
    const card = page.locator(`a[href="/projects/${PROJECT_KEY}/tasks/${taskNumber}"]`);
    await expect(card).toBeVisible();
    await card.click({ button: "right" });
    await page
      .getByTestId("task-context-menu")
      .getByRole("button", { name: "Done", exact: true })
      .click();
    await expect(
      page.getByTestId("column-done").locator(`a[href*="/tasks/${taskNumber}"]`)
    ).toBeVisible();
  }

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
    expect(created.checklist).toMatchObject([
      { text: "first", done: false },
      { text: "second", done: false },
    ]);
    expect(String(created.assignee)).toBe(String(ADMIN_ID));
    expect(created.status).toBe("planned");
  });

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
    expect([next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate()]).toEqual([2026, 6, 15]);
  });

  test("a monthly task due on the 31st comes back on the last day of the next month", async ({
    page,
  }) => {
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

  test("a series past its end stops, and one still inside it does not", async ({ page }) => {
    const due = new Date("2026-05-12");
    await giveDueDate(due);

    await withDb(async (db) => {
      await db.collection("tasks").updateOne(
        { _id: SIBLING_TASK_ID },
        { $set: { recurrence: { frequency: "weekly", interval: 1, endDate: new Date("2026-05-15") } } }
      );
    });

    await signIn(page);
    const before = await taskNumbers();
    await closeOnTheBoard(page);

    await page.waitForTimeout(6_000);
    expect(await taskNumbers(), "the series ran past its end").toEqual(before);

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

    const refused = await request.put(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}`, {
      headers: ADMIN_AUTH,
      data: { recurrence: { frequency: "daily", interval: 400 } },
    });

    expect(refused.status()).toBe(400);
    expect(await refused.text()).toContain("365");

    const accepted = await request.put(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}`, {
      headers: ADMIN_AUTH,
      data: { recurrence: { frequency: "daily", interval: 365 } },
    });

    expect(accepted.status(), await accepted.text()).toBe(200);
  });

  test("a monthly series clamped by February gets its day back in March", async ({ page }) => {
    await giveDueDate(new Date("2026-01-31"));
    await withDb(async (db) => {
      await db
        .collection("tasks")
        .updateOne({ _id: SIBLING_TASK_ID }, { $set: { recurrence: { frequency: "monthly", interval: 1 } } });
    });

    await signIn(page);
    const before = await taskNumbers();
    await closeOnTheBoard(page);

    const february = await newOccurrence(before);
    expect(new Date(february.dueDate as Date).toISOString()).toBe("2026-02-28T00:00:00.000Z");

    const beforeMarch = await taskNumbers();
    await closeOnTheBoard(page, Number(february.taskNumber));

    const march = await newOccurrence(beforeMarch);
    expect(new Date(march.dueDate as Date).toISOString()).toBe("2026-03-31T00:00:00.000Z");
  });

  test("two overlapping closes mint at most one occurrence", async ({ request }) => {
    const due = BASE_DUE();
    await giveDueDate(due);
    await withDb(async (db) => {
      await db
        .collection("tasks")
        .updateOne({ _id: SIBLING_TASK_ID }, { $set: { recurrence: { frequency: "weekly", interval: 1 } } });
    });

    const before = await taskNumbers();
    const close = () =>
      request.patch(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_ID}/status`, {
        headers: ADMIN_AUTH,
        data: { status: "done" },
      });
    const [first, second] = await Promise.all([close(), close()]);

    expect(first.status(), await first.text()).toBe(200);
    expect(second.status(), await second.text()).toBe(200);

    const created = await newOccurrence(before);
    expect(new Date(created.dueDate as Date).getTime() - due.getTime()).toBe(7 * DAY_MS);
  });

  test("a task with no rhythm leaves nothing behind", async ({ page, request }) => {
    await signIn(page);
    const before = await taskNumbers();
    await closeOnTheBoard(page);

    await page.waitForTimeout(6_000);
    expect(await taskNumbers()).toEqual(before);

    const still = await request.get(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`, {
      headers: ADMIN_AUTH,
    });
    expect((await still.json()).status).toBe("done");
  });
});

test.describe("duplicating one of these", () => {
  const SPRINT_ID = new mongoose.Types.ObjectId("e2e00000000000000000c701");
  const COPY_TITLE = `Copy of ${SIBLING_TASK_TITLE}`;

  async function catalogAgentId(): Promise<mongoose.Types.ObjectId> {
    await mongoose.connect(E2E_MONGODB_URI);
    const { seedAgents } = await import("@/lib/agent-seed");
    await seedAgents();
    await mongoose.disconnect();

    const agent = await withDb(async (db) => db.collection("agents").findOne({}));
    if (!agent) throw new Error("the shipped catalog seeded no agent to pair the task with");
    return agent._id as mongoose.Types.ObjectId;
  }

  async function makeWorthCopying() {
    const agentId = await catalogAgentId();
    await giveDueDate(BASE_DUE());
    await withDb(async (db) => {
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

  async function copyCreatedBy(page: Page, act: () => Promise<void>) {
    const posted = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === `/api/projects/${PROJECT_KEY}/tasks`
    );
    await act();
    const response = await posted;
    expect(response.status()).toBe(201);
    const created = await storedTaskTitled(COPY_TITLE);
    if (!created) throw new Error("the duplicate was answered 201 and is not in the database");
    return created;
  }

  function expectTheWorkAndNotTheHandover(copy: Record<string, unknown>) {
    expect(copy.title).toBe(COPY_TITLE);
    expect(copy.recurrence).toMatchObject({ frequency: "weekly", interval: 2 });
    expect(copy.priority).toBe("urgent");
    expect(copy.checklist).toMatchObject([
      { text: "first", done: false },
      { text: "second", done: false },
    ]);
    expect(copy.assignee ?? null).toBeNull();
    expect(copy.sprint ?? null).toBeNull();
    expect(copy.agent ?? null).toBeNull();
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
      page
        .getByTestId("task-context-menu")
        .getByRole("button", { name: "Duplicate", exact: true })
        .click()
    );

    expectTheWorkAndNotTheHandover(copy);
  });
});
