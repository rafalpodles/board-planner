import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import {
  DECOY_TASK_ID,
  DECOY_TASK_NUMBER,
  FINISHED_TASK_ID,
  FINISHED_TASK_NUMBER,
  FINISHED_TASK_TITLE,
  HELD_TASK_ID,
  HELD_TASK_KEY,
  HELD_TASK_NUMBER,
  MEMBER_USERNAME,
  PLANNING_BACKLOG_TASK_ID,
  PLANNING_BACKLOG_TASK_NUMBER,
  PLANNING_SPRINT_DONE_TASK_ID,
  PLANNING_SPRINT_DONE_TASK_NUMBER,
  PLANNING_SPRINT_ID,
  PLANNING_SPRINT_NAME,
  PLANNING_SPRINT_TASK_ID,
  PLANNING_SPRINT_TASK_NUMBER,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  RUN_PHASE,
  SECOND_PROJECT_KEY,
  SECOND_PROJECT_NAME,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  SIBLING_TASK_TITLE,
  STRANDED_TASK_ID,
  STRANDED_TASK_NUMBER,
  WORKER_NAME,
  seed,
  seedSecondProject,
  seedSprintPlanning,
  seedTaskInCompletedSprint,
  storedExecution,
} from "./seed";
import { signIn } from "./session";
import { expectToast, recordedToasts, recordToasts } from "./toasts";

const SEEDED_TASKS = 4;
const NEXT_TASK_NUMBER = 5;

const boardUrl = `/projects/${PROJECT_KEY}`;
const taskUrl = (taskNumber: number) => `/projects/${PROJECT_KEY}/tasks/${taskNumber}`;
const CARDS = "[data-column-body] a[href*='/tasks/']";

function boardColumn(page: Page, columnId: string): Locator {
  return page.getByTestId(`column-${columnId}`);
}

function card(page: Page, taskNumber: number): Locator {
  return page.locator(`[data-column-body] a[href="${taskUrl(taskNumber)}"]`);
}

function contextMenu(page: Page): Locator {
  return page.getByTestId("task-context-menu");
}

async function focusedRowTaskNumber(page: Page): Promise<number> {
  const focusedRow = page.locator("tr.ring-2");
  await expect(focusedRow).toHaveCount(1);
  return Number(/\b[A-Z]+-(\d+)\b/.exec((await focusedRow.innerText()) ?? "")?.[1]);
}

async function openBoard(page: Page, cards = SEEDED_TASKS) {
  await signIn(page);
  await page.goto(boardUrl);
  await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
  await expect(page.locator(CARDS)).toHaveCount(cards);
  await recordToasts(page);
}

async function openMenuOn(page: Page, taskNumber: number): Promise<Locator> {
  await card(page, taskNumber).click({ button: "right" });
  const menu = contextMenu(page);
  await expect(menu).toBeVisible();
  return menu;
}

async function select(page: Page, taskNumbers: number[]) {
  await page.getByRole("button", { name: "Select", exact: true }).click();
  for (const n of taskNumbers) {
    await page.getByRole("button", { name: `Select ${PROJECT_KEY}-${n}` }).click();
  }
  await expect(page.getByRole("button", { name: `Select (${taskNumbers.length})` })).toBeVisible();
}

async function readTask(request: APIRequestContext, taskNumber: number) {
  const res = await request.get(`/api/projects/${PROJECT_KEY}/tasks/${taskNumber}`, {
    headers: ADMIN_AUTH,
  });
  return { status: res.status(), body: res.status() === 200 ? await res.json() : null };
}

function taskWrite(page: Page, method: string, taskId: { toString(): string }) {
  return page.waitForResponse(
    (res) => res.request().method() === method && res.url().endsWith(`/tasks/${taskId}`)
  );
}

function taskCreated(page: Page) {
  return page.waitForResponse(
    (res) => res.request().method() === "POST" && res.url().endsWith("/tasks")
  );
}

test.beforeEach(async () => {
  await seed();
});

test.describe("duplicate", () => {
  async function dressTheOriginal(request: APIRequestContext) {
    const res = await request.put(`/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}`, {
      headers: ADMIN_AUTH,
      data: {
        description: "The work, described",
        priority: "high",
        category: "bug",
        dueDate: "2026-10-01T00:00:00.000Z",
        checklist: [
          { text: "Already done on the original", done: true },
          { text: "Still open on the original", done: false },
        ],
        assignee: MEMBER_USERNAME,
      },
    });
    expect(res.status(), await res.text()).toBe(200);
  }

  test("from the card's menu, the copy is the work and not the hand-over", async ({
    page,
    request,
  }) => {
    await dressTheOriginal(request);
    await openBoard(page);

    const posted = page.waitForRequest(
      (req) => req.method() === "POST" && req.url().endsWith("/tasks")
    );
    const created = taskCreated(page);
    const menu = await openMenuOn(page, SIBLING_TASK_NUMBER);
    await menu.getByRole("button", { name: "Duplicate", exact: true }).click();

    const body = (await posted).postDataJSON();
    expect(body).toMatchObject({
      title: `Copy of ${SIBLING_TASK_TITLE}`,
      description: "The work, described",
      priority: "high",
      category: "bug",
      dueDate: "2026-10-01T00:00:00.000Z",
      checklist: [
        { text: "Already done on the original", done: false },
        { text: "Still open on the original", done: false },
      ],
    });
    for (const left of ["status", "assignee", "sprint", "agent", "order"]) {
      expect(body, `a copy must not send ${left}`).not.toHaveProperty(left);
    }
    expect((await created).status()).toBe(201);
    await expectToast(page, "Task duplicated");

    const copy = card(page, NEXT_TASK_NUMBER);
    await expect(copy).toHaveCount(1, { timeout: 2_000 });
    await expect(boardColumn(page, "planned").locator(`a[href="${taskUrl(NEXT_TASK_NUMBER)}"]`)).toContainText(
      `Copy of ${SIBLING_TASK_TITLE}`
    );

    const stored = await readTask(request, NEXT_TASK_NUMBER);
    expect(stored.body).toMatchObject({
      status: "planned",
      priority: "high",
      category: "bug",
      assignee: null,
      sprint: null,
    });
    expect(stored.body.checklist.map((i: { done: boolean }) => i.done)).toEqual([false, false]);

    const original = await readTask(request, SIBLING_TASK_NUMBER);
    expect(original.body.status).toBe("in_progress");
    expect(original.body.assignee.username).toBe(MEMBER_USERNAME);
    expect(original.body.checklist.map((i: { done: boolean }) => i.done)).toEqual([true, false]);
  });

  test("from the task screen, the copy opens as its own task", async ({ page, request }) => {
    await dressTheOriginal(request);
    await signIn(page);
    await page.goto(taskUrl(SIBLING_TASK_NUMBER));
    await expect(page.getByLabel("Task title")).toHaveValue(SIBLING_TASK_TITLE);

    const posted = page.waitForRequest(
      (req) => req.method() === "POST" && req.url().endsWith("/tasks")
    );
    const created = taskCreated(page);
    await page.getByRole("button", { name: "Duplicate", exact: true }).click();
    const body = (await posted).postDataJSON();
    expect(body.title).toBe(`Copy of ${SIBLING_TASK_TITLE}`);
    for (const left of ["status", "assignee", "sprint", "agent"]) {
      expect(body, `a copy must not send ${left}`).not.toHaveProperty(left);
    }
    expect((await created).status()).toBe(201);

    await expect(page).toHaveURL(new RegExp(`${taskUrl(NEXT_TASK_NUMBER)}$`));
    await expect(page.getByLabel("Task title")).toHaveCount(1);
    await expect(page.getByLabel("Task title")).toHaveValue(`Copy of ${SIBLING_TASK_TITLE}`);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const stored = await readTask(request, NEXT_TASK_NUMBER);
    expect(stored.body).toMatchObject({ status: "planned", priority: "high", assignee: null });
    expect(stored.body.checklist.map((i: { done: boolean }) => i.done)).toEqual([false, false]);
  });

  test("a title at the old cutoff still duplicates, clamped to the cap", async ({ page, request }) => {
    const longTitle = "A".repeat(193);
    const renamed = await request.put(`/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}`, {
      headers: ADMIN_AUTH,
      data: { title: longTitle },
    });
    expect(renamed.status(), await renamed.text()).toBe(200);

    await openBoard(page);
    const created = taskCreated(page);
    const menu = await openMenuOn(page, SIBLING_TASK_NUMBER);
    await menu.getByRole("button", { name: "Duplicate", exact: true }).click();
    expect((await created).status()).toBe(201);
    await expectToast(page, "Task duplicated");

    const stored = await readTask(request, NEXT_TASK_NUMBER);
    expect(stored.body.title).toHaveLength(200);
    expect(stored.body.title).toBe(`Copy of ${longTitle}`.slice(0, 200));
  });
});

test.describe("delete", () => {
  test("from the card's menu: Cancel keeps the task, Delete removes it", async ({
    page,
    request,
  }) => {
    await openBoard(page);

    await test.step("cancelling the dialog deletes nothing", async () => {
      const menu = await openMenuOn(page, FINISHED_TASK_NUMBER);
      await menu.getByRole("button", { name: "Delete", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Delete Task" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("This action cannot be undone.");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();

      await expect(card(page, FINISHED_TASK_NUMBER)).toBeVisible();
      expect((await readTask(request, FINISHED_TASK_NUMBER)).status).toBe(200);
    });

    await test.step("confirming removes it from the board and from the API", async () => {
      const deleted = taskWrite(page, "DELETE", FINISHED_TASK_ID);
      const menu = await openMenuOn(page, FINISHED_TASK_NUMBER);
      await menu.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("dialog", { name: "Delete Task" }).getByRole("button", { name: "Delete" }).click();
      expect((await deleted).status()).toBe(200);

      await expectToast(page, "Task deleted");
      await expect(card(page, FINISHED_TASK_NUMBER)).toHaveCount(0, { timeout: 1_000 });
      await expect(page.locator(CARDS)).toHaveCount(SEEDED_TASKS - 1, { timeout: 1_000 });
      expect((await readTask(request, FINISHED_TASK_NUMBER)).status).toBe(404);
    });
  });

  test("a double click sends one DELETE, not two, and no false failure toast", async ({
    page,
    request,
  }) => {
    await openBoard(page);

    let deleteRequests = 0;
    await page.route(`**/api/projects/*/tasks/${FINISHED_TASK_ID}`, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      deleteRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.continue();
    });

    const menu = await openMenuOn(page, FINISHED_TASK_NUMBER);
    await menu.getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Delete Task" });

    const deleted = taskWrite(page, "DELETE", FINISHED_TASK_ID);
    await dialog.getByRole("button", { name: "Delete", exact: true }).dblclick();
    await expect(dialog.getByRole("button", { name: "Deleting..." })).toBeDisabled();
    expect((await deleted).status()).toBe(200);

    expect(deleteRequests).toBe(1);
    await expect.poll(() => recordedToasts(page)).toEqual(["Task deleted"]);
    await expect(card(page, FINISHED_TASK_NUMBER)).toHaveCount(0, { timeout: 1_000 });
    expect((await readTask(request, FINISHED_TASK_NUMBER)).status).toBe(404);
  });

  test("Cancel and Escape are refused while the delete is in flight, so a later failure still has a dialog to land on", async ({
    page,
    request,
  }) => {
    await openBoard(page);

    await page.route(`**/api/projects/*/tasks/${FINISHED_TASK_ID}`, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({ status: 500, body: "{}" });
    });

    const requestSent = page.waitForRequest(
      (req) => req.method() === "DELETE" && req.url().endsWith(`/tasks/${FINISHED_TASK_ID}`)
    );
    const deleted = taskWrite(page, "DELETE", FINISHED_TASK_ID);
    const menu = await openMenuOn(page, FINISHED_TASK_NUMBER);
    await menu.getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Delete Task" });
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await requestSent;

    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();

    expect((await deleted).status()).toBe(500);
    await expect(dialog).toBeHidden();
    await expectToast(page, "Failed to delete task");
    await expect(card(page, FINISHED_TASK_NUMBER)).toBeVisible();
    expect((await readTask(request, FINISHED_TASK_NUMBER)).status).toBe(200);
  });

  test("from the task screen: the rail's button, naming the task", async ({ page, request }) => {
    await signIn(page);
    await page.goto(taskUrl(FINISHED_TASK_NUMBER));
    await expect(page.getByLabel("Task title")).toHaveValue(FINISHED_TASK_TITLE);

    await page.getByRole("button", { name: "Delete task" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete Task" });
    await expect(dialog).toContainText(
      `Are you sure you want to delete ${PROJECT_KEY}-${FINISHED_TASK_NUMBER} "${FINISHED_TASK_TITLE}"?`
    );
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`${taskUrl(FINISHED_TASK_NUMBER)}$`));
    expect((await readTask(request, FINISHED_TASK_NUMBER)).status).toBe(200);

    const deleted = taskWrite(page, "DELETE", FINISHED_TASK_ID);
    await page.getByRole("button", { name: "Delete task" }).click();
    await dialog.getByRole("button", { name: "Delete" }).click();
    expect((await deleted).status()).toBe(200);

    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
    await expect(page.locator(CARDS)).toHaveCount(SEEDED_TASKS - 1);
    await expect(card(page, FINISHED_TASK_NUMBER)).toHaveCount(0);
    expect((await readTask(request, FINISHED_TASK_NUMBER)).status).toBe(404);
  });

  test("from the task screen on a narrow window: the More actions menu", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await signIn(page);
    await page.goto(taskUrl(DECOY_TASK_NUMBER));
    await expect(page.getByLabel("Task title")).toBeVisible();

    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("option", { name: "Delete task" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete Task" });
    await expect(dialog).toContainText(`${PROJECT_KEY}-${DECOY_TASK_NUMBER}`);

    const deleted = taskWrite(page, "DELETE", DECOY_TASK_ID);
    await dialog.getByRole("button", { name: "Delete" }).click();
    expect((await deleted).status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
    await expect(page.locator(CARDS)).toHaveCount(SEEDED_TASKS - 1);
    expect((await readTask(request, DECOY_TASK_NUMBER)).status).toBe(404);
  });

  test("a task a worker holds is kept until a person says Delete anyway", async ({
    page,
    request,
  }) => {
    await openBoard(page);
    const heldWording = `${HELD_TASK_KEY} is being executed by ${WORKER_NAME} (phase ${RUN_PHASE}). Deleting it takes the task off that worker`;

    await test.step("the refusal becomes a second question, and Cancel keeps the task", async () => {
      const refused = taskWrite(page, "DELETE", HELD_TASK_ID);
      const menu = await openMenuOn(page, HELD_TASK_NUMBER);
      await menu.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("dialog", { name: "Delete Task" }).getByRole("button", { name: "Delete" }).click();
      expect((await refused).status()).toBe(409);

      const held = page.getByRole("dialog", { name: "This task is being executed" });
      await expect(held).toContainText(heldWording);
      await held.getByRole("button", { name: "Cancel" }).click();
      await expect(held).toBeHidden();

      await expect(card(page, HELD_TASK_NUMBER)).toBeVisible();
      expect((await readTask(request, HELD_TASK_NUMBER)).status).toBe(200);
      expect((await storedExecution(HELD_TASK_ID))?.runId).toBe("e2e-run-0001");
    });

    await test.step("Delete anyway is the force, and the task is gone", async () => {
      const refused = taskWrite(page, "DELETE", HELD_TASK_ID);
      const menu = await openMenuOn(page, HELD_TASK_NUMBER);
      await menu.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("dialog", { name: "Delete Task" }).getByRole("button", { name: "Delete" }).click();
      expect((await refused).status()).toBe(409);

      const forced = page.waitForResponse(
        (res) =>
          res.request().method() === "DELETE" &&
          res.url().endsWith(`/tasks/${HELD_TASK_ID}`) &&
          res.request().postDataJSON()?.force === true
      );
      await page
        .getByRole("dialog", { name: "This task is being executed" })
        .getByRole("button", { name: "Delete anyway" })
        .click();
      expect((await forced).status()).toBe(200);

      await expectToast(page, "Task deleted");
      await expect(card(page, HELD_TASK_NUMBER)).toHaveCount(0, { timeout: 2_000 });
      expect((await readTask(request, HELD_TASK_NUMBER)).status).toBe(404);
    });
  });
});

test.describe("bulk delete", () => {
  test("names the count, and Cancel keeps every selected task", async ({ page, request }) => {
    await openBoard(page);
    await select(page, [SIBLING_TASK_NUMBER, FINISHED_TASK_NUMBER]);

    const menu = await openMenuOn(page, SIBLING_TASK_NUMBER);
    await expect(menu).toContainText("2 tasks selected");
    await menu.getByRole("button", { name: "Delete 2 tasks", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Delete Selected Tasks" });
    await expect(dialog).toContainText("Are you sure you want to delete 2 tasks?");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    await expect(page.locator(CARDS)).toHaveCount(SEEDED_TASKS);
    expect((await readTask(request, SIBLING_TASK_NUMBER)).status).toBe(200);
    expect((await readTask(request, FINISHED_TASK_NUMBER)).status).toBe(200);

    const deletes = [
      taskWrite(page, "DELETE", SIBLING_TASK_ID),
      taskWrite(page, "DELETE", FINISHED_TASK_ID),
    ];
    await (await openMenuOn(page, SIBLING_TASK_NUMBER))
      .getByRole("button", { name: "Delete 2 tasks", exact: true })
      .click();
    await dialog.getByRole("button", { name: "Delete 2 tasks", exact: true }).click();
    for (const res of await Promise.all(deletes)) expect(res.status()).toBe(200);

    await expectToast(page, "Deleted 2 tasks");
    await expect(page.locator(CARDS)).toHaveCount(SEEDED_TASKS - 2, { timeout: 1_000 });
    expect((await readTask(request, SIBLING_TASK_NUMBER)).status).toBe(404);
    expect((await readTask(request, FINISHED_TASK_NUMBER)).status).toBe(404);
    await expect(page.getByRole("button", { name: "Select", exact: true })).toBeVisible();
  });

  test("a held task in the selection is reported by name and kept", async ({ page, request }) => {
    await openBoard(page);
    await select(page, [HELD_TASK_NUMBER, DECOY_TASK_NUMBER]);

    const refused = taskWrite(page, "DELETE", HELD_TASK_ID);
    const deleted = taskWrite(page, "DELETE", DECOY_TASK_ID);
    await (await openMenuOn(page, DECOY_TASK_NUMBER))
      .getByRole("button", { name: "Delete 2 tasks", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Delete Selected Tasks" })
      .getByRole("button", { name: "Delete 2 tasks", exact: true })
      .click();
    expect((await refused).status()).toBe(409);
    expect((await deleted).status()).toBe(200);

    await expectToast(page, `Deleted 1 of 2. ${HELD_TASK_KEY} being executed by a worker.`);
    await expect(card(page, HELD_TASK_NUMBER)).toBeVisible();
    await expect(card(page, DECOY_TASK_NUMBER)).toHaveCount(0, { timeout: 1_000 });
    expect((await readTask(request, HELD_TASK_NUMBER)).status).toBe(200);
    expect((await readTask(request, DECOY_TASK_NUMBER)).status).toBe(404);
    expect((await storedExecution(HELD_TASK_ID))?.runId).toBe("e2e-run-0001");
  });
});

test.describe("sprints from the card menu", () => {
  const PLANNED_CARDS = SEEDED_TASKS + 3;
  const scopedUrl = `${boardUrl}?sprint=${PLANNING_SPRINT_ID}`;

  test.beforeEach(async () => {
    await seedSprintPlanning();
  });

  test("bulk Move to sprint, and a single card in and out again", async ({ page, request }) => {
    await openBoard(page, PLANNED_CARDS);

    await test.step("two selected cards move together", async () => {
      await select(page, [SIBLING_TASK_NUMBER, FINISHED_TASK_NUMBER]);
      const writes = [
        taskWrite(page, "PUT", SIBLING_TASK_ID),
        taskWrite(page, "PUT", FINISHED_TASK_ID),
      ];
      const menu = await openMenuOn(page, SIBLING_TASK_NUMBER);
      await menu.getByRole("button", { name: new RegExp(`^${PLANNING_SPRINT_NAME}`) }).click();
      for (const res of await Promise.all(writes)) expect(res.status()).toBe(200);

      await expectToast(page, `Moved 2 tasks to ${PLANNING_SPRINT_NAME}`);
      expect((await readTask(request, SIBLING_TASK_NUMBER)).body.sprint).toBe(String(PLANNING_SPRINT_ID));
      expect((await readTask(request, FINISHED_TASK_NUMBER)).body.sprint).toBe(String(PLANNING_SPRINT_ID));
      await expect(page.getByRole("button", { name: "Select", exact: true })).toBeVisible();
    });

    await test.step("one card into the sprint", async () => {
      const written = taskWrite(page, "PUT", PLANNING_BACKLOG_TASK_ID);
      const menu = await openMenuOn(page, PLANNING_BACKLOG_TASK_NUMBER);
      await menu.getByRole("button", { name: new RegExp(`^${PLANNING_SPRINT_NAME}`) }).click();
      expect((await written).status()).toBe(200);
      await expectToast(page, `Moved to ${PLANNING_SPRINT_NAME}`);
      expect((await readTask(request, PLANNING_BACKLOG_TASK_NUMBER)).body.sprint).toBe(
        String(PLANNING_SPRINT_ID)
      );
    });

    await test.step("and out again", async () => {
      const written = taskWrite(page, "PUT", PLANNING_BACKLOG_TASK_ID);
      const menu = await openMenuOn(page, PLANNING_BACKLOG_TASK_NUMBER);
      await menu.getByRole("button", { name: "Remove from sprint" }).click();
      expect((await written).status()).toBe(200);
      await expectToast(page, "Moved to backlog");
      expect((await readTask(request, PLANNING_BACKLOG_TASK_NUMBER)).body.sprint).toBeNull();
      await expect(card(page, PLANNING_BACKLOG_TASK_NUMBER)).toBeVisible();
    });
  });

  test("one task's PUT failing does not hide the other's success, and the selection clears", async ({
    page,
    request,
  }) => {
    await openBoard(page, PLANNED_CARDS);
    await select(page, [SIBLING_TASK_NUMBER, FINISHED_TASK_NUMBER]);

    await page.route(`**/api/projects/*/tasks/${FINISHED_TASK_ID}`, (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      return route.fulfill({ status: 500, body: "{}" });
    });

    const succeeded = taskWrite(page, "PUT", SIBLING_TASK_ID);
    const failed = taskWrite(page, "PUT", FINISHED_TASK_ID);
    const menu = await openMenuOn(page, SIBLING_TASK_NUMBER);
    await menu.getByRole("button", { name: new RegExp(`^${PLANNING_SPRINT_NAME}`) }).click();
    expect((await succeeded).status()).toBe(200);
    expect((await failed).status()).toBe(500);

    await expectToast(page, `Moved 1 of 2 to ${PLANNING_SPRINT_NAME}`);
    expect((await readTask(request, SIBLING_TASK_NUMBER)).body.sprint).toBe(String(PLANNING_SPRINT_ID));
    expect((await readTask(request, FINISHED_TASK_NUMBER)).body.sprint).toBeNull();
    await expect(page.getByRole("button", { name: "Select", exact: true })).toBeVisible();
  });

  test("on a board scoped to the sprint, only the task whose PUT actually landed leaves it", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await page.goto(scopedUrl);
    await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
    await expect(page.locator(CARDS)).toHaveCount(2);
    await recordToasts(page);

    await select(page, [PLANNING_SPRINT_TASK_NUMBER, PLANNING_SPRINT_DONE_TASK_NUMBER]);
    await page.route(`**/api/projects/*/tasks/${PLANNING_SPRINT_DONE_TASK_ID}`, (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      return route.fulfill({ status: 500, body: "{}" });
    });

    const succeeded = taskWrite(page, "PUT", PLANNING_SPRINT_TASK_ID);
    const failed = taskWrite(page, "PUT", PLANNING_SPRINT_DONE_TASK_ID);
    const menu = await openMenuOn(page, PLANNING_SPRINT_DONE_TASK_NUMBER);
    await menu.getByRole("button", { name: "Remove from sprint" }).click();
    expect((await succeeded).status()).toBe(200);
    expect((await failed).status()).toBe(500);

    await expectToast(page, "Moved 1 of 2 to backlog");
    await expect(card(page, PLANNING_SPRINT_TASK_NUMBER)).toHaveCount(0, { timeout: 1_000 });
    expect(await card(page, PLANNING_SPRINT_DONE_TASK_NUMBER).count()).toBe(1);

    expect((await readTask(request, PLANNING_SPRINT_TASK_NUMBER)).body.sprint).toBeNull();
    expect((await readTask(request, PLANNING_SPRINT_DONE_TASK_NUMBER)).body.sprint).toBe(
      String(PLANNING_SPRINT_ID)
    );
    await expect(page.getByRole("button", { name: "Select", exact: true })).toBeVisible();
  });

  test("on a board scoped to the sprint, a card removed from it leaves the board", async ({
    page,
    request,
  }) => {
    const joined = await request.put(`/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}`, {
      headers: ADMIN_AUTH,
      data: { sprint: String(PLANNING_SPRINT_ID) },
    });
    expect(joined.status(), await joined.text()).toBe(200);

    await signIn(page);
    await page.goto(scopedUrl);
    await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
    await expect(page.locator(CARDS)).toHaveCount(3);
    await recordToasts(page);

    await test.step("a single card", async () => {
      const written = taskWrite(page, "PUT", SIBLING_TASK_ID);
      const menu = await openMenuOn(page, SIBLING_TASK_NUMBER);
      await menu.getByRole("button", { name: "Remove from sprint" }).click();
      expect((await written).status()).toBe(200);
      await expectToast(page, "Moved to backlog");

      await expect(card(page, SIBLING_TASK_NUMBER)).toHaveCount(0, { timeout: 1_000 });
      await expect(page.locator(CARDS)).toHaveCount(2, { timeout: 1_000 });
      expect((await readTask(request, SIBLING_TASK_NUMBER)).body.sprint).toBeNull();
    });

    await test.step("a selection, through the bulk path", async () => {
      await select(page, [PLANNING_SPRINT_TASK_NUMBER, PLANNING_SPRINT_DONE_TASK_NUMBER]);
      const writes = [
        taskWrite(page, "PUT", PLANNING_SPRINT_TASK_ID),
        taskWrite(page, "PUT", PLANNING_SPRINT_DONE_TASK_ID),
      ];
      const menu = await openMenuOn(page, PLANNING_SPRINT_DONE_TASK_NUMBER);
      await expect(menu).toContainText("2 tasks selected");
      await menu.getByRole("button", { name: "Remove from sprint" }).click();
      for (const res of await Promise.all(writes)) expect(res.status()).toBe(200);
      await expectToast(page, "Moved 2 tasks to backlog");

      await expect(page.locator(CARDS)).toHaveCount(0, { timeout: 1_000 });
      expect((await readTask(request, PLANNING_SPRINT_TASK_NUMBER)).body.sprint).toBeNull();
      expect((await readTask(request, PLANNING_SPRINT_DONE_TASK_NUMBER)).body.sprint).toBeNull();
    });

    await page.goto(boardUrl);
    await expect(card(page, SIBLING_TASK_NUMBER)).toBeVisible();
    await expect(card(page, PLANNING_SPRINT_TASK_NUMBER)).toBeVisible();
    await expect(card(page, PLANNING_SPRINT_DONE_TASK_NUMBER)).toBeVisible();
  });
});

test.describe("a sprint that closed with the task still in it", () => {
  test.beforeEach(async () => {
    await seedTaskInCompletedSprint();
  });

  test("Remove from sprint is offered even though there is no open sprint to move to", async ({
    page,
    request,
  }) => {
    await openBoard(page, SEEDED_TASKS + 1);

    const menu = await openMenuOn(page, STRANDED_TASK_NUMBER);
    await expect(menu.getByText("Move to sprint")).toHaveCount(0);
    const removeButton = menu.getByRole("button", { name: "Remove from sprint" });
    await expect(removeButton).toBeVisible();

    const written = taskWrite(page, "PUT", STRANDED_TASK_ID);
    await removeButton.click();
    expect((await written).status()).toBe(200);
    await expectToast(page, "Moved to backlog");

    expect((await readTask(request, STRANDED_TASK_NUMBER)).body.sprint).toBeNull();
  });
});

test.describe("selecting without opening", () => {
  test("shift-click selects a card, and Escape lets it go", async ({ page }) => {
    await openBoard(page);

    await card(page, SIBLING_TASK_NUMBER).click({ modifiers: ["Shift"] });
    await expect(page.getByRole("button", { name: "Select (1)" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
    expect(page.context().pages()).toHaveLength(1);

    await card(page, FINISHED_TASK_NUMBER).click({ modifiers: ["Shift"] });
    await expect(page.getByRole("button", { name: "Select (2)" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Select", exact: true })).toBeVisible();

    await card(page, SIBLING_TASK_NUMBER).click();
    await expect(page).toHaveURL(new RegExp(`${taskUrl(SIBLING_TASK_NUMBER)}$`));
  });

  test("ctrl-click selects a list row", async ({ page }) => {
    await openBoard(page);
    await page.getByRole("button", { name: "List", exact: true }).click();
    const row = page.locator("tr", { hasText: SIBLING_TASK_TITLE });
    await expect(row).toBeVisible();

    const title = row.getByText(SIBLING_TASK_TITLE);
    await title.click({ modifiers: ["ControlOrMeta"] });
    await expect(page.getByRole("button", { name: "Select (1)" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));

    await title.click({ modifiers: ["ControlOrMeta"] });
    await expect(page.getByRole("button", { name: "Select", exact: true })).toBeVisible();

    await title.click();
    await expect(page).toHaveURL(new RegExp(`${taskUrl(SIBLING_TASK_NUMBER)}$`));
  });
});

test.describe("keyboard", () => {
  test("the shortcuts the help dialog advertises do what it says", async ({ page }) => {
    await openBoard(page);

    await test.step("? opens the help, and ? closes it again", async () => {
      const help = page.getByRole("heading", { name: "Keyboard Shortcuts" });
      await page.keyboard.press("?");
      await expect(help).toBeVisible();
      await expect(page.getByText("Close dialogs / clear selection")).toBeVisible();
      await page.keyboard.press("?");
      await expect(help).toHaveCount(0);
    });

    await test.step("n opens the new task form", async () => {
      await page.keyboard.press("n");
      const dialog = page.getByRole("dialog", { name: "New Task" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Close dialog" }).click();
      await expect(dialog).toBeHidden();
    });

    await test.step("v switches the view, r reloads it", async () => {
      await page.keyboard.press("v");
      await expect(page.getByRole("button", { name: "List", exact: true })).toHaveAttribute("aria-current", "true");
      await expect(page.locator("tr", { hasText: SIBLING_TASK_TITLE })).toBeVisible();

      const reloaded = page.waitForResponse(
        (res) => res.request().method() === "GET" && /\/api\/projects\/[^/]+\/tasks/.test(res.url()),
        { timeout: 2_000 }
      );
      await page.keyboard.press("r");
      expect((await reloaded).status()).toBe(200);

      await page.keyboard.press("v");
      await expect(page.getByRole("button", { name: "Board", exact: true })).toHaveAttribute("aria-current", "true");
      await expect(boardColumn(page, "in_progress")).toBeVisible();
    });
  });

  test("Escape closes the help", async ({ page }) => {
    await openBoard(page);
    const help = page.getByRole("heading", { name: "Keyboard Shortcuts" });
    await page.keyboard.press("?");
    await expect(help).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(help).toHaveCount(0);
  });

  test("Space opens the focused card, k walks back, and a modifier click opens a new tab", async ({
    page,
  }) => {
    await openBoard(page);

    await card(page, SIBLING_TASK_NUMBER).focus();
    await page.keyboard.press("Space");
    await expect(page).toHaveURL(new RegExp(`${taskUrl(SIBLING_TASK_NUMBER)}$`));

    await page.goto(boardUrl);
    await expect(page.locator(CARDS)).toHaveCount(SEEDED_TASKS);
    await page.keyboard.press("v");
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await page.keyboard.press("k");
    await expect(page.locator("tr.ring-2")).toHaveCount(1);
    await expect(page.locator("tbody tr").first()).toHaveClass(/ring-2/);
    await page.keyboard.press("v");

    for (const how of [{ modifiers: ["ControlOrMeta" as const] }, { button: "middle" as const }]) {
      const opened = page.context().waitForEvent("page");
      await card(page, SIBLING_TASK_NUMBER).click(how);
      const tab = await opened;
      await expect(tab).toHaveURL(new RegExp(`${taskUrl(SIBLING_TASK_NUMBER)}$`));
      await tab.close();
      await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
    }
  });

  test("Enter on a focused card opens that card, not the one j focused", async ({ page }) => {
    await openBoard(page);

    await page.keyboard.press("v");
    await page.keyboard.press("j");
    const first = await focusedRowTaskNumber(page);
    expect([HELD_TASK_NUMBER, DECOY_TASK_NUMBER, SIBLING_TASK_NUMBER, FINISHED_TASK_NUMBER]).toContain(first);

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${taskUrl(first)}$`));

    await page.goto(boardUrl);
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await expect(page.locator(CARDS)).toHaveCount(SEEDED_TASKS);
    await page.keyboard.press("j");

    const other = first === SIBLING_TASK_NUMBER ? FINISHED_TASK_NUMBER : SIBLING_TASK_NUMBER;
    await card(page, other).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${taskUrl(other)}$`));

    await page.goto(boardUrl);
    await expect(page.locator(CARDS)).toHaveCount(SEEDED_TASKS);
    await card(page, other).focus();
    await page.keyboard.press("Shift+Enter");
    await expect(page.getByRole("button", { name: "Select (1)" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
  });

  test("j/k/Enter are inert on the board — the cursor they move is only ever drawn in the list", async ({
    page,
  }) => {
    await openBoard(page);
    await expect(page.getByRole("button", { name: "Board", exact: true })).toHaveAttribute(
      "aria-current",
      "true"
    );

    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await page.keyboard.press("k");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1_000);
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(CARDS)).toHaveCount(SEEDED_TASKS);

    await page.getByRole("button", { name: "List", exact: true }).click();
    await page.keyboard.press("j");
    const focused = await focusedRowTaskNumber(page);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${taskUrl(focused)}$`));
  });
});

test.describe("a board with nothing on it, and one that would not load", () => {
  test("an empty board offers the first task, and the empty state goes with it", async ({
    page,
    request,
  }) => {
    await seedSecondProject();
    await signIn(page);
    await page.goto(`/projects/${SECOND_PROJECT_KEY}`);
    await expect(page.getByRole("heading", { name: SECOND_PROJECT_NAME })).toBeVisible();
    await expect(page.getByText("No tasks yet")).toBeVisible();

    await page.getByRole("button", { name: "Create Task" }).click();
    const dialog = page.getByRole("dialog", { name: "New Task" });
    await dialog.getByLabel("Title").fill("First on this board");
    const created = taskCreated(page);
    await dialog.getByRole("button", { name: "Create Task" }).click();
    expect((await created).status()).toBe(201);

    await expect(page.locator(CARDS)).toHaveCount(1);
    await expect(page.locator(CARDS)).toContainText("First on this board");
    await expect(page.getByText("No tasks yet")).toHaveCount(0);

    const listed = await request.get(`/api/projects/${SECOND_PROJECT_KEY}/tasks`, { headers: ADMIN_AUTH });
    expect((await listed.json()).map((t: { title: string }) => t.title)).toEqual(["First on this board"]);
  });

  test("when the board cannot load, Retry loads it", async ({ page }) => {
    await signIn(page);

    let failing = true;
    await page.route(`**/api/projects/${PROJECT_KEY}`, (route) =>
      failing ? route.fulfill({ status: 500, body: "{}" }) : route.continue()
    );

    await page.goto(boardUrl);
    await expect(page.getByText("Failed to load this board.")).toBeVisible();
    await expect(page.getByRole("heading", { name: PROJECT_NAME })).toHaveCount(0);

    failing = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
    await expect(page.locator(CARDS)).toHaveCount(SEEDED_TASKS);
    await expect(page.getByText("Failed to load this board.")).toHaveCount(0);
  });
});
