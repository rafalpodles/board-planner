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
  WORKER_NAME,
  seed,
  seedSecondProject,
  seedSprintPlanning,
  storedExecution,
} from "./seed";
import { signIn } from "./session";
import { expectToast, recordToasts } from "./toasts";

/**
 * BP-466 — the half of the board that cannot be undone: delete, bulk delete, duplicate, and the
 * sprint moves, driven from the card menu, the selection and the task screen. The reversible
 * half (drag, reorder, filter, bulk move) lives in kanban-board-core.spec.ts.
 *
 * Every irreversible action here is first cancelled and shown to have done nothing, then done and
 * shown over the API to have happened — the board repaints optimistically on most of these paths,
 * so a card vanishing says nothing about the server having agreed.
 */

// seed() lays down four tasks and leaves taskCounter on the same number, so a copy is minted with this
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

async function openBoard(page: Page, cards = SEEDED_TASKS) {
  await signIn(page);
  await page.goto(boardUrl);
  await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
  // The heading comes from the project request and the cards from their own
  await expect(page.locator(CARDS)).toHaveCount(cards);
  await recordToasts(page);
}

async function openMenuOn(page: Page, taskNumber: number): Promise<Locator> {
  await card(page, taskNumber).click({ button: "right" });
  const menu = contextMenu(page);
  await expect(menu).toBeVisible();
  return menu;
}

/** Selection mode, with the named cards ticked. */
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

/** A write on one task, registered before the click that causes it. */
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
  // What the copy has to carry, planted on the original first: every field the payload names is
  // set to something the seed does not default to, so a copy of the defaults could not pass
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

    // The body is the contract (src/lib/task-duplicate.ts): what a copy carries, and what it
    // deliberately leaves out — a status would 400 on a renamed board, an assignee would hand
    // somebody work nobody offered them
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

    // Minted with the next number and landing in the backlog column, not the original's.
    // Tight: the board's ten-second poll would show the copy anyway, and the reload the
    // duplicate makes is what this waits for
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

    // The original is untouched: still ticked, still assigned, still where it was
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
    // The same contract as the board's menu, from the other place that sends it
    const body = (await posted).postDataJSON();
    expect(body.title).toBe(`Copy of ${SIBLING_TASK_TITLE}`);
    for (const left of ["status", "assignee", "sprint", "agent"]) {
      expect(body, `a copy must not send ${left}`).not.toHaveProperty(left);
    }
    expect((await created).status()).toBe(201);

    await expect(page).toHaveURL(new RegExp(`${taskUrl(NEXT_TASK_NUMBER)}$`));
    // One editor, and no dialog over it: BP-521 turned the push into a document load, so the
    // intercepting modal is neither drawn on top of the copy nor left armed behind it.
    await expect(page.getByLabel("Task title")).toHaveCount(1);
    await expect(page.getByLabel("Task title")).toHaveValue(`Copy of ${SIBLING_TASK_TITLE}`);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const stored = await readTask(request, NEXT_TASK_NUMBER);
    expect(stored.body).toMatchObject({ status: "planned", priority: "high", assignee: null });
    expect(stored.body.checklist.map((i: { done: boolean }) => i.done)).toEqual([false, false]);
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
      // Tight, here and below: the ten-second poll would drop the card on its own, and the
      // board's own removal is what is under test
      await expect(card(page, FINISHED_TASK_NUMBER)).toHaveCount(0, { timeout: 1_000 });
      await expect(page.locator(CARDS)).toHaveCount(SEEDED_TASKS - 1, { timeout: 1_000 });
      expect((await readTask(request, FINISHED_TASK_NUMBER)).status).toBe(404);
    });
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

    // Gone, and the screen that showed it goes with it: the board loads without it
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
    await expect(page.locator(CARDS)).toHaveCount(SEEDED_TASKS - 1);
    await expect(card(page, FINISHED_TASK_NUMBER)).toHaveCount(0);
    expect((await readTask(request, FINISHED_TASK_NUMBER)).status).toBe(404);
  });

  test("from the task screen on a narrow window: the More actions menu", async ({
    page,
    request,
  }) => {
    // Below lg the property rail — and its Delete — is not on the screen; the top bar's menu
    // carries the action until there is room
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

  /**
   * BP-337. A delete takes strictly more off a worker than a move does — the task, not just the
   * column — so it asks separately, and "Delete anyway" is the person's force. The first dialog
   * is the ordinary one; the server's 409 is what turns it into the second.
   */
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
      // Still held, not merely still there
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

    // The control: confirmed, both go, and the selection is spent
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
      // Unscoped, the card stays on the board
      await expect(card(page, PLANNING_BACKLOG_TASK_NUMBER)).toBeVisible();
    });
  });

  test("on a board scoped to the sprint, a card removed from it leaves the board", async ({
    page,
    request,
  }) => {
    // A third card in the sprint, so a single removal and a two-card selection can both happen
    const joined = await request.put(`/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}`, {
      headers: ADMIN_AUTH,
      data: { sprint: String(PLANNING_SPRINT_ID) },
    });
    expect(joined.status(), await joined.text()).toBe(200);

    await signIn(page);
    await page.goto(scopedUrl);
    await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
    // Only the sprint's three tasks: the backlog one and the rest of the seed are elsewhere
    await expect(page.locator(CARDS)).toHaveCount(3);
    await recordToasts(page);

    await test.step("a single card", async () => {
      const written = taskWrite(page, "PUT", SIBLING_TASK_ID);
      const menu = await openMenuOn(page, SIBLING_TASK_NUMBER);
      await menu.getByRole("button", { name: "Remove from sprint" }).click();
      expect((await written).status()).toBe(200);
      await expectToast(page, "Moved to backlog");

      // Tight on purpose: the board also polls every ten seconds and would drop the card on its
      // own, so a patient wait here would pass with the board's own removal deleted
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

    // Back on the unscoped board, all three are still tasks
    await page.goto(boardUrl);
    await expect(card(page, SIBLING_TASK_NUMBER)).toBeVisible();
    await expect(card(page, PLANNING_SPRINT_TASK_NUMBER)).toBeVisible();
    await expect(card(page, PLANNING_SPRINT_DONE_TASK_NUMBER)).toBeVisible();
  });
});

test.describe("selecting without opening", () => {
  test("shift-click selects a card, and Escape lets it go", async ({ page }) => {
    await openBoard(page);

    await card(page, SIBLING_TASK_NUMBER).click({ modifiers: ["Shift"] });
    await expect(page.getByRole("button", { name: "Select (1)" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
    // Nor did the anchor open anywhere else
    expect(page.context().pages()).toHaveLength(1);

    await card(page, FINISHED_TASK_NUMBER).click({ modifiers: ["Shift"] });
    await expect(page.getByRole("button", { name: "Select (2)" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Select", exact: true })).toBeVisible();

    // The control: a plain click opens the task
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

    // The control
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

      // Two seconds, not the default thirty: the board polls every ten, and a poll's response
      // is indistinguishable from the one the key is supposed to cause
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

  /**
   * The help lists "Esc — Close dialogs", and for a while it did not: the board's own Escape
   * handler re-rendered on every press and the help's listener was re-subscribed in the middle of
   * the dispatch, so it never saw the key. This test asserted that limit until BP-522 fixed it,
   * and going red is how the fix was noticed. `e2e/shortcut-help-escape.spec.ts` carries the rest
   * of that surface — the modal, the confirm, the context menu and `?`.
   */
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

    // ⌘/Ctrl-click and a middle click leave the board where it is and open the card elsewhere
    for (const how of [{ modifiers: ["ControlOrMeta" as const] }, { button: "middle" as const }]) {
      const opened = page.context().waitForEvent("page");
      await card(page, SIBLING_TASK_NUMBER).click(how);
      const tab = await opened;
      // The page event fires before the new tab has navigated anywhere
      await expect(tab).toHaveURL(new RegExp(`${taskUrl(SIBLING_TASK_NUMBER)}$`));
      await tab.close();
      await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
    }
  });

  /**
   * The board's Enter listens on `document` and opens whichever task j/k focused; a card's own
   * Enter opens that card. Both can be true at once — a card focused with Tab while j has focused
   * another — and TaskCard stops the native event so only its own wins. Removing that stop makes
   * this land on the j-focused task instead.
   */
  test("Enter on a focused card opens that card, not the one j focused", async ({ page }) => {
    await openBoard(page);

    // Which task j focuses first is the list's business; ask it
    await page.keyboard.press("v");
    await page.keyboard.press("j");
    const focusedRow = page.locator("tr.ring-2");
    await expect(focusedRow).toHaveCount(1);
    const first = Number(/\b[A-Z]+-(\d+)\b/.exec((await focusedRow.innerText()) ?? "")?.[1]);
    expect([HELD_TASK_NUMBER, DECOY_TASK_NUMBER, SIBLING_TASK_NUMBER, FINISHED_TASK_NUMBER]).toContain(first);

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${taskUrl(first)}$`));

    await page.goto(boardUrl);
    // The view mode is remembered, so this comes back as the list; the seam is a card's
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await expect(page.locator(CARDS)).toHaveCount(SEEDED_TASKS);
    await page.keyboard.press("j");

    const other = first === SIBLING_TASK_NUMBER ? FINISHED_TASK_NUMBER : SIBLING_TASK_NUMBER;
    await card(page, other).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${taskUrl(other)}$`));

    // Shift+Enter is the keyboard's shift-click: the focused card joins the selection and nothing
    // opens. Last, because once a selection exists a plain Enter selects too, by design.
    await page.goto(boardUrl);
    await expect(page.locator(CARDS)).toHaveCount(SEEDED_TASKS);
    await card(page, other).focus();
    await page.keyboard.press("Shift+Enter");
    await expect(page.getByRole("button", { name: "Select (1)" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
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

    // The project request fails until Retry is pressed. The board polls every ten seconds, so a
    // failure that cleared itself would let the poll do Retry's job and leave the button unproven.
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
