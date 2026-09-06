import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { QUIET_MS } from "@/components/tasks/ExecutionPanel";
import { ADMIN_AUTH, MEMBER_AUTH } from "./api";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  DECOY_TASK_TITLE,
  FINISHED_TASK_ID,
  FINISHED_TASK_NUMBER,
  HELD_TASK_ID,
  HELD_TASK_KEY,
  HELD_TASK_NUMBER,
  HELD_TASK_TITLE,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  QUIET_TASK_ID,
  QUIET_TASK_KEY,
  QUIET_TASK_NUMBER,
  RUN_PHASE,
  SECOND_HELD_TASK_ID,
  SECOND_HELD_TASK_KEY,
  SECOND_HELD_TASK_NUMBER,
  SIBLING_TASK_ID,
  SIBLING_TASK_KEY,
  SIBLING_TASK_NUMBER,
  SOURCE_COLUMN,
  SPARE_COLUMN,
  TARGET_COLUMN,
  WORKER_NAME,
  seed,
  seedQuietTask,
  seedSecondHeldTask,
  storedExecution,
} from "./seed";
import { signIn as arriveSignedIn, signInThroughForm } from "./session";
import { dragTo } from "./drag";

test.beforeEach(seed);

const cardHref = (taskNumber: number) => `/projects/${PROJECT_KEY}/tasks/${taskNumber}`;
const heldCardHref = cardHref(HELD_TASK_NUMBER);

function boardColumn(page: Page, columnId: string): Locator {
  return page.getByTestId(`column-${columnId}`);
}

function moveMenu(page: Page): Locator {
  return page.getByTestId("task-context-menu");
}

function runBadge(scope: Locator | Page): Locator {
  return scope.locator('[data-testid="card-run-live"], [data-testid="card-run-quiet"]');
}

function listStatus(page: Page, taskKey: string, title: string): Locator {
  return page.getByRole("combobox", { name: `Status for ${taskKey}: ${title}` });
}

async function showList(page: Page) {
  const tab = page.getByRole("button", { name: "List", exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-current", "true");
}

async function recordToasts(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = ((window as unknown as { __toasts?: string[] }).__toasts = []);
    const collect = (node: Node) => {
      if (!(node instanceof HTMLElement)) return;
      const added = node.matches("[data-testid=\"toast\"]")
        ? [node]
        : Array.from(node.querySelectorAll("[data-testid=\"toast\"]"));
      for (const toast of added) seen.push(toast.textContent ?? "");
    };
    new MutationObserver((records) =>
      records.forEach((record) => record.addedNodes.forEach(collect))
    ).observe(document.body, { childList: true, subtree: true });
  });
}

function expectToast(page: Page, message: string) {
  return expect
    .poll(() => page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts))
    .toContain(message);
}

async function signIn(page: Page, username = ADMIN_USERNAME, password = ADMIN_PASSWORD) {
  if (username === ADMIN_USERNAME) await arriveSignedIn(page);
  else if (username === MEMBER_USERNAME) await arriveSignedIn(page, "member");
  else await signInThroughForm(page, username, password);
  await page.goto(`/projects/${PROJECT_KEY}`);

  await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
  await expect(page.getByText(HELD_TASK_TITLE)).toBeVisible();
  await recordToasts(page);
}

async function readTask(
  request: APIRequestContext,
  taskNumber: number,
  headers: Record<string, string> = ADMIN_AUTH
) {
  const res = await request.get(`/api/projects/${PROJECT_KEY}/tasks/${taskNumber}`, { headers });
  expect(res.status()).toBe(200);
  return res.json();
}

async function dragCardToColumn(page: Page, card: Locator, column: Locator) {
  const body = column.locator("[data-column-body]");

  await dragTo(page, card, body, {
    duringDrag: async () => {
      await expect(column.locator("[data-column-body] > div.h-0\\.5")).toBeAttached();
    },
  });
}

test("a task a worker is running cannot be dragged away without confirming", async ({
  page,
  request,
}) => {
  await test.step("the server is talking to the e2e database", async () => {
    const res = await request.get(`/api/projects/${PROJECT_KEY}`, { headers: ADMIN_AUTH });
    expect(res.status()).toBe(200);
    const project = await res.json();
    expect(project._id).toBe(String(PROJECT_ID));
    expect(project.name).toBe(PROJECT_NAME);
  });

  await test.step("sign in and land on the board", async () => {
    await signIn(page);
    await expect(page.getByText(DECOY_TASK_TITLE)).toBeVisible();
  });

  const source = boardColumn(page, SOURCE_COLUMN.id);
  const target = boardColumn(page, TARGET_COLUMN.id);
  const heldCard = source.locator(`a[href="${heldCardHref}"]`);

  await test.step("the card shows a live run", async () => {
    await expect(heldCard).toBeVisible();
    await expect(runBadge(heldCard)).toContainText(RUN_PHASE);
  });

  await test.step("dragging it to another column is refused", async () => {
    await dragCardToColumn(page, heldCard, target);

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "This task is being executed" })).toBeVisible();
    await expect(dialog).toContainText(
      `${HELD_TASK_KEY} is being executed by ${WORKER_NAME} (phase ${RUN_PHASE})`
    );
    await expect(dialog.getByRole("button", { name: "Move anyway" })).toBeVisible();
  });

  await test.step("cancelling leaves the task where it was", async () => {
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await expect(source.locator(`a[href="${heldCardHref}"]`)).toBeVisible();
    await expect(target.locator(`a[href="${heldCardHref}"]`)).toHaveCount(0);

    const task = await readTask(request, HELD_TASK_NUMBER);
    expect(task._id).toBe(String(HELD_TASK_ID));
    expect(task.status).toBe(SOURCE_COLUMN.id);
    expect(task.execution?.phase).toBe(RUN_PHASE);
  });

  await test.step("confirming moves it and releases the run", async () => {
    await dragCardToColumn(page, source.locator(`a[href="${heldCardHref}"]`), target);
    await page.getByRole("dialog").getByRole("button", { name: "Move anyway" }).click();

    await expectToast(page, `${HELD_TASK_KEY} taken from the worker`);
    await expect(target.locator(`a[href="${heldCardHref}"]`)).toBeVisible();
    await expect(source.locator(`a[href="${heldCardHref}"]`)).toHaveCount(0);
    await expect(runBadge(page)).toHaveCount(0);

    const task = await readTask(request, HELD_TASK_NUMBER);
    expect(task.status).toBe(TARGET_COLUMN.id);
    expect(task.execution).toBeUndefined();
  });
});

test("the same refusal reaches the person through the right-click menu", async ({
  page,
  request,
}) => {
  await signIn(page);

  const source = boardColumn(page, SOURCE_COLUMN.id);
  const target = boardColumn(page, TARGET_COLUMN.id);
  const heldCard = source.locator(`a[href="${heldCardHref}"]`);

  await expect(runBadge(heldCard)).toContainText(RUN_PHASE);

  await test.step("moving it from the menu is refused by the status endpoint", async () => {
    const refusal = page.waitForResponse(
      (res) =>
        res.url().endsWith(`/tasks/${HELD_TASK_ID}/status`) &&
        res.request().method() === "PATCH" &&
        res.status() === 409
    );

    await heldCard.click({ button: "right" });
    await moveMenu(page).getByRole("button", { name: TARGET_COLUMN.label, exact: true }).click();
    await refusal;

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "This task is being executed" })).toBeVisible();
    await expect(dialog).toContainText(
      `${HELD_TASK_KEY} is being executed by ${WORKER_NAME} (phase ${RUN_PHASE})`
    );

    await expect(source.locator(`a[href="${heldCardHref}"]`)).toBeVisible();
    await expect(target.locator(`a[href="${heldCardHref}"]`)).toHaveCount(0);
  });

  await test.step("confirming moves it and releases the run", async () => {
    const forced = page.waitForResponse(
      (res) =>
        res.url().endsWith(`/tasks/${HELD_TASK_ID}/status`) &&
        res.request().method() === "PATCH" &&
        res.status() === 200
    );

    await page.getByRole("dialog").getByRole("button", { name: "Move anyway" }).click();
    expect((await forced).request().postDataJSON()).toMatchObject({
      status: TARGET_COLUMN.id,
      force: true,
    });

    await expectToast(page, `${HELD_TASK_KEY} taken from the worker`);
    await expect(target.locator(`a[href="${heldCardHref}"]`)).toBeVisible();
    await expect(source.locator(`a[href="${heldCardHref}"]`)).toHaveCount(0);
    await expect(runBadge(page)).toHaveCount(0);

    const task = await readTask(request, HELD_TASK_NUMBER);
    expect(task.status).toBe(TARGET_COLUMN.id);
    expect(task.execution).toBeUndefined();
  });
});

test("dragging a held card inside its own column reorders it and keeps the run", async ({
  page,
  request,
}) => {
  await signIn(page);

  const source = boardColumn(page, SOURCE_COLUMN.id);
  const cards = source.locator("[data-column-body] a[href*='/tasks/']");
  const heldCard = source.locator(`a[href="${heldCardHref}"]`);

  await test.step("the column holds the running task and a free one, in that order", async () => {
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toHaveAttribute("href", heldCardHref);
    await expect(cards.nth(1)).toHaveAttribute("href", cardHref(SIBLING_TASK_NUMBER));
  });

  const reorder = page.waitForResponse(
    (res) => res.url().endsWith(`/tasks/${HELD_TASK_ID}`) && res.request().method() === "PUT"
  );

  await dragCardToColumn(page, heldCard, source);

  const res = await reorder;
  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON()).toHaveProperty("order");

  await test.step("it stays in the column, below the card it was dragged past", async () => {
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toHaveAttribute("href", cardHref(SIBLING_TASK_NUMBER));
    await expect(cards.nth(1)).toHaveAttribute("href", heldCardHref);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  await test.step("the run is still holding the task", async () => {
    await expect(runBadge(heldCard)).toContainText(RUN_PHASE);

    const task = await readTask(request, HELD_TASK_NUMBER);
    expect(task.status).toBe(SOURCE_COLUMN.id);
    expect(task.execution?.phase).toBe(RUN_PHASE);
    expect(task.execution?.workerName).toBe(WORKER_NAME);
  });
});

test("a bulk move takes what it can and leaves the task a worker is running", async ({
  page,
  request,
}) => {
  await signIn(page);

  const source = boardColumn(page, SOURCE_COLUMN.id);
  const target = boardColumn(page, TARGET_COLUMN.id);

  await test.step("select the running task and a free one", async () => {
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page.getByRole("button", { name: `Select ${HELD_TASK_KEY}`, exact: true }).click();
    await page.getByRole("button", { name: `Select ${SIBLING_TASK_KEY}`, exact: true }).click();
    await expect(page.getByRole("button", { name: "Select (2)", exact: true })).toBeVisible();
  });

  await test.step("the move is partial, and the toast names what stayed", async () => {
    await source.locator(`a[href="${heldCardHref}"]`).click({ button: "right" });
    await expect(moveMenu(page)).toContainText("2 tasks selected");
    await moveMenu(page).getByRole("button", { name: TARGET_COLUMN.label, exact: true }).click();

    await expectToast(page, `Moved 1 of 2. ${HELD_TASK_KEY} being executed by a worker.`);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  await test.step("the free task moved and the held one did not", async () => {
    await expect(target.locator(`a[href="${cardHref(SIBLING_TASK_NUMBER)}"]`)).toBeVisible();
    await expect(source.locator(`a[href="${cardHref(SIBLING_TASK_NUMBER)}"]`)).toHaveCount(0);

    await expect(source.locator(`a[href="${heldCardHref}"]`)).toBeVisible();
    await expect(target.locator(`a[href="${heldCardHref}"]`)).toHaveCount(0);
    await expect(runBadge(source.locator(`a[href="${heldCardHref}"]`))).toContainText(RUN_PHASE);

    const held = await readTask(request, HELD_TASK_NUMBER);
    expect(held.status).toBe(SOURCE_COLUMN.id);
    expect(held.execution?.phase).toBe(RUN_PHASE);

    const sibling = await readTask(request, SIBLING_TASK_NUMBER);
    expect(sibling._id).toBe(String(SIBLING_TASK_ID));
    expect(sibling.status).toBe(TARGET_COLUMN.id);
  });
});

test("a task whose run has already finished moves without being questioned", async ({
  page,
  request,
}) => {
  await test.step("the fixture still carries the worker that ran it", async () => {
    const execution = await storedExecution(FINISHED_TASK_ID);
    expect(execution?.workerId).toBeTruthy();
    expect(execution?.runId).toBeFalsy();
  });

  await signIn(page);

  const source = boardColumn(page, SPARE_COLUMN.id);
  const target = boardColumn(page, TARGET_COLUMN.id);
  const finishedCard = source.locator(`a[href="${cardHref(FINISHED_TASK_NUMBER)}"]`);

  await expect(finishedCard).toBeVisible();
  await expect(runBadge(finishedCard)).toHaveCount(0);

  const move = page.waitForResponse(
    (res) => res.url().endsWith(`/tasks/${FINISHED_TASK_ID}`) && res.request().method() === "PUT"
  );

  await dragCardToColumn(page, finishedCard, target);
  expect((await move).status()).toBe(200);

  await expect(target.locator(`a[href="${cardHref(FINISHED_TASK_NUMBER)}"]`)).toBeVisible();
  await expect(source.locator(`a[href="${cardHref(FINISHED_TASK_NUMBER)}"]`)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const task = await readTask(request, FINISHED_TASK_NUMBER);
  expect(task.status).toBe(TARGET_COLUMN.id);
  expect(task.execution).toBeUndefined();
});

test("a project member, holding a grant and nothing else, meets the same refusal", async ({
  page,
  request,
}) => {
  await test.step("the account is a member of this project and nothing on the instance", async () => {
    const me = await request.get("/api/auth/me", { headers: MEMBER_AUTH });
    expect(me.status()).toBe(200);
    expect((await me.json()).role).toBe("member");

    expect((await request.get("/api/users", { headers: MEMBER_AUTH })).status()).toBe(403);
    expect(
      (await request.get(`/api/projects/${PROJECT_KEY}`, { headers: MEMBER_AUTH })).status()
    ).toBe(200);
  });

  await signIn(page, MEMBER_USERNAME);

  const source = boardColumn(page, SOURCE_COLUMN.id);
  const target = boardColumn(page, TARGET_COLUMN.id);
  const heldCard = source.locator(`a[href="${heldCardHref}"]`);

  await expect(runBadge(heldCard)).toContainText(RUN_PHASE);

  await test.step("their drag is refused by the server, and they get the same dialog", async () => {
    const refusal = page.waitForResponse(
      (res) =>
        res.url().endsWith(`/tasks/${HELD_TASK_ID}`) &&
        res.request().method() === "PUT" &&
        res.status() === 409
    );

    await dragCardToColumn(page, heldCard, target);
    await refusal;

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "This task is being executed" })).toBeVisible();
    await expect(dialog).toContainText(
      `${HELD_TASK_KEY} is being executed by ${WORKER_NAME} (phase ${RUN_PHASE})`
    );
    await expect(dialog.getByRole("button", { name: "Move anyway" })).toBeVisible();
  });

  await test.step("and Move anyway is theirs to click", async () => {
    await page.getByRole("dialog").getByRole("button", { name: "Move anyway" }).click();

    await expectToast(page, `${HELD_TASK_KEY} taken from the worker`);
    await expect(target.locator(`a[href="${heldCardHref}"]`)).toBeVisible();
    await expect(source.locator(`a[href="${heldCardHref}"]`)).toHaveCount(0);
    await expect(runBadge(page)).toHaveCount(0);

    const task = await readTask(request, HELD_TASK_NUMBER, MEMBER_AUTH);
    expect(task._id).toBe(String(HELD_TASK_ID));
    expect(task.status).toBe(TARGET_COLUMN.id);
    expect(task.execution).toBeUndefined();
  });
});

test("the list view refuses the same move, and confirming there releases the run", async ({
  page,
  request,
}) => {
  await signIn(page);
  await showList(page);

  const status = listStatus(page, HELD_TASK_KEY, HELD_TASK_TITLE);
  await expect(status).toContainText(SOURCE_COLUMN.label);

  await test.step("picking another status from the row is refused", async () => {
    const refusal = page.waitForResponse(
      (res) =>
        res.url().endsWith(`/tasks/${HELD_TASK_ID}/status`) &&
        res.request().method() === "PATCH" &&
        res.status() === 409
    );

    await status.click();
    await page.getByRole("option", { name: TARGET_COLUMN.label, exact: true }).click();
    await refusal;

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "This task is being executed" })).toBeVisible();
    await expect(dialog).toContainText(
      `${HELD_TASK_KEY} is being executed by ${WORKER_NAME} (phase ${RUN_PHASE})`
    );

    await expect(status).toContainText(SOURCE_COLUMN.label);
  });

  await test.step("confirming moves it and releases the run", async () => {
    await page.getByRole("dialog").getByRole("button", { name: "Move anyway" }).click();

    await expectToast(page, `${HELD_TASK_KEY} taken from the worker`);
    await expect(status).toContainText(TARGET_COLUMN.label);

    const task = await readTask(request, HELD_TASK_NUMBER);
    expect(task.status).toBe(TARGET_COLUMN.id);
    expect(task.execution).toBeUndefined();
  });
});

test("a bulk move names every task it had to leave behind", async ({ page, request }) => {
  await seedSecondHeldTask();
  await signIn(page);

  const source = boardColumn(page, SOURCE_COLUMN.id);
  const target = boardColumn(page, TARGET_COLUMN.id);
  const secondHeldHref = cardHref(SECOND_HELD_TASK_NUMBER);
  const siblingHref = cardHref(SIBLING_TASK_NUMBER);

  await test.step("two of the three are under a live run", async () => {
    await expect(runBadge(source.locator(`a[href="${heldCardHref}"]`))).toContainText(RUN_PHASE);
    await expect(runBadge(source.locator(`a[href="${secondHeldHref}"]`))).toContainText(RUN_PHASE);
    await expect(runBadge(source.locator(`a[href="${siblingHref}"]`))).toHaveCount(0);
  });

  await test.step("select all three", async () => {
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page.getByRole("button", { name: `Select ${HELD_TASK_KEY}`, exact: true }).click();
    await page.getByRole("button", { name: `Select ${SECOND_HELD_TASK_KEY}`, exact: true }).click();
    await page.getByRole("button", { name: `Select ${SIBLING_TASK_KEY}`, exact: true }).click();
    await expect(page.getByRole("button", { name: "Select (3)", exact: true })).toBeVisible();
  });

  await test.step("the free one moves and the toast names both held ones", async () => {
    await source.locator(`a[href="${heldCardHref}"]`).click({ button: "right" });
    await expect(moveMenu(page)).toContainText("3 tasks selected");
    await moveMenu(page).getByRole("button", { name: TARGET_COLUMN.label, exact: true }).click();

    await expectToast(
      page,
      `Moved 1 of 3. ${HELD_TASK_KEY}, ${SECOND_HELD_TASK_KEY} being executed by a worker.`
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  await test.step("only the free task moved, and both runs are intact", async () => {
    await expect(target.locator(`a[href="${siblingHref}"]`)).toBeVisible();
    await expect(source.locator(`a[href="${siblingHref}"]`)).toHaveCount(0);

    for (const href of [heldCardHref, secondHeldHref]) {
      await expect(source.locator(`a[href="${href}"]`)).toBeVisible();
      await expect(target.locator(`a[href="${href}"]`)).toHaveCount(0);
      await expect(runBadge(source.locator(`a[href="${href}"]`))).toContainText(RUN_PHASE);
    }

    for (const [taskNumber, taskId] of [
      [HELD_TASK_NUMBER, HELD_TASK_ID],
      [SECOND_HELD_TASK_NUMBER, SECOND_HELD_TASK_ID],
    ] as const) {
      const held = await readTask(request, taskNumber);
      expect(held._id).toBe(String(taskId));
      expect(held.status).toBe(SOURCE_COLUMN.id);
      expect(held.execution?.phase).toBe(RUN_PHASE);
    }

    const sibling = await readTask(request, SIBLING_TASK_NUMBER);
    expect(sibling._id).toBe(String(SIBLING_TASK_ID));
    expect(sibling.status).toBe(TARGET_COLUMN.id);
  });
});

test("a run that has gone quiet still holds its task", async ({ page, request }) => {
  await seedQuietTask(2 * QUIET_MS);
  await signIn(page);

  const source = boardColumn(page, SOURCE_COLUMN.id);
  const target = boardColumn(page, TARGET_COLUMN.id);
  const quietHref = cardHref(QUIET_TASK_NUMBER);
  const quietCard = source.locator(`a[href="${quietHref}"]`);

  await test.step("the card calls the run quiet, not live", async () => {
    await expect(quietCard).toBeVisible();
    await expect(quietCard.getByTestId("card-run-quiet")).toContainText(RUN_PHASE);
    await expect(quietCard.getByTestId("card-run-live")).toHaveCount(0);
    await expect(source.locator(`a[href="${heldCardHref}"]`).getByTestId("card-run-live")).toBeVisible();
  });

  await test.step("moving it is refused all the same — silence is not permission", async () => {
    const refusal = page.waitForResponse(
      (res) =>
        res.url().endsWith(`/tasks/${QUIET_TASK_ID}`) &&
        res.request().method() === "PUT" &&
        res.status() === 409
    );

    await dragCardToColumn(page, quietCard, target);
    await refusal;

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "This task is being executed" })).toBeVisible();
    await expect(dialog).toContainText(
      `${QUIET_TASK_KEY} is being executed by ${WORKER_NAME} (phase ${RUN_PHASE})`
    );
  });

  await test.step("cancelling leaves the run holding it", async () => {
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await expect(source.locator(`a[href="${quietHref}"]`)).toBeVisible();
    await expect(target.locator(`a[href="${quietHref}"]`)).toHaveCount(0);

    const task = await readTask(request, QUIET_TASK_NUMBER);
    expect(task._id).toBe(String(QUIET_TASK_ID));
    expect(task.status).toBe(SOURCE_COLUMN.id);
    expect(task.execution?.phase).toBe(RUN_PHASE);
  });
});

test("deleting a task a worker is running is refused, and confirming takes it anyway", async ({
  page,
  request,
}) => {
  await signIn(page);
  await page.goto(cardHref(HELD_TASK_NUMBER));
  const deleteTask = page.getByRole("button", { name: "Delete task" });
  await expect(deleteTask).toBeVisible();
  await recordToasts(page);

  async function askToDelete() {
    await deleteTask.click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
  }

  await test.step("the delete endpoint refuses it", async () => {
    const refusal = page.waitForResponse(
      (res) =>
        res.url().endsWith(`/tasks/${HELD_TASK_ID}`) &&
        res.request().method() === "DELETE" &&
        res.status() === 409
    );

    await askToDelete();
    await refusal;

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "This task is being executed" })).toBeVisible();
    await expect(dialog).toContainText(
      `${HELD_TASK_KEY} is being executed by ${WORKER_NAME} (phase ${RUN_PHASE})`
    );

    expect((await readTask(request, HELD_TASK_NUMBER)).taskNumber).toBe(HELD_TASK_NUMBER);
  });

  await test.step("confirming deletes it, and says so with force", async () => {
    const forced = page.waitForResponse(
      (res) =>
        res.url().endsWith(`/tasks/${HELD_TASK_ID}`) &&
        res.request().method() === "DELETE" &&
        res.status() === 200
    );

    await page.getByRole("dialog").getByRole("button", { name: "Delete anyway" }).click();
    expect((await forced).request().postDataJSON()).toMatchObject({ force: true });

    await expectToast(page, "Task deleted");
    const gone = await request.get(
      `/api/projects/${PROJECT_KEY}/tasks/${HELD_TASK_NUMBER}`,
      { headers: ADMIN_AUTH }
    );
    expect(gone.status()).toBe(404);
  });
});

test("deleting a task no worker is running still goes through on the first ask", async ({
  page,
  request,
}) => {
  await signIn(page);
  await page.goto(cardHref(SIBLING_TASK_NUMBER));
  const deleteTask = page.getByRole("button", { name: "Delete task" });
  await expect(deleteTask).toBeVisible();

  const deleted = page.waitForResponse(
    (res) =>
      res.url().endsWith(`/tasks/${SIBLING_TASK_ID}`) &&
      res.request().method() === "DELETE" &&
      res.status() === 200
  );

  await deleteTask.click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await deleted;

  await expect(page.getByRole("heading", { name: "This task is being executed" })).toHaveCount(0);

  const gone = await request.get(`/api/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`, {
    headers: ADMIN_AUTH,
  });
  expect(gone.status()).toBe(404);
});
