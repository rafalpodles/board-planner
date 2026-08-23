import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  DECOY_TASK_ID,
  DECOY_TASK_NUMBER,
  DECOY_TASK_TITLE,
  FINISHED_TASK_ID,
  FINISHED_TASK_NUMBER,
  FINISHED_TASK_TITLE,
  HELD_TASK_NUMBER,
  HELD_TASK_TITLE,
  PROJECT_KEY,
  PROJECT_NAME,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  SIBLING_TASK_TITLE,
  storedActivity,
  seed,
} from "./seed";

/**
 * BP-384: the board is the product's most-used surface and until now had no coverage of its
 * own — drags appeared only inside refusal contexts (run-conflict) and sprint planning.
 * These tests drive the happy paths a person touches every day: moving cards, creating
 * tasks, editing rows, filtering, bulk-moving, reading the board on a phone.
 */

test.beforeEach(seed);

const boardUrl = `/projects/${PROJECT_KEY}`;
const cardHref = (taskNumber: number) => `/projects/${PROJECT_KEY}/tasks/${taskNumber}`;

/** The column by its board id, stable across markup changes in a way its heading is not. */
function boardColumn(page: Page, columnId: string): Locator {
  return page.getByTestId(`column-${columnId}`);
}

function cardIn(column: Locator, taskNumber: number): Locator {
  return column.locator(`a[href="${cardHref(taskNumber)}"]`);
}

async function signIn(page: Page) {
  await page.goto(boardUrl);
  await page.getByLabel("Username").fill(ADMIN_USERNAME);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
}

/** Same MutationObserver trick as run-conflict: a toast clears itself before a poll can see it. */
async function recordToasts(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = ((window as unknown as { __toasts?: string[] }).__toasts = []);
    const collect = (node: Node) => {
      if (!(node instanceof HTMLElement)) return;
      const added = node.matches('[data-testid="toast"]')
        ? [node]
        : Array.from(node.querySelectorAll('[data-testid="toast"]'));
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

/**
 * Native HTML5 drag, driven by hand: Chromium runs real drags on the OS, so mouse events
 * produce nothing (see run-conflict for the fuller explanation). One live DataTransfer is
 * shared — the card writes its id on dragstart, the column reads it back on drop.
 *
 * When `onto` is given, the dragover goes to that card rather than the column body, so the
 * column computes an insertion position from the pointer instead of appending at the end.
 */
async function dragCardToColumn(page: Page, card: Locator, column: Locator, onto?: Locator) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const body = column.locator("[data-column-body]");

  await card.dispatchEvent("dragstart", { dataTransfer });
  await body.dispatchEvent("dragenter", { dataTransfer });
  if (onto) {
    // clientY near the top of the card puts the insertion point before it
    await onto.dispatchEvent("dragover", { dataTransfer, clientY: 1 });
  } else {
    await body.dispatchEvent("dragover", { dataTransfer });
  }

  // The insertion marker is proof a drop index was computed; without one the drop falls
  // through to the plain status endpoint — a different code path than the one under test
  await expect(column.locator("[data-column-body] div.h-0\\.5").first()).toBeAttached();

  await body.dispatchEvent("drop", { dataTransfer });
  // No dragend: a successful drop moves the card out from under the locator
  await dataTransfer.dispose();
}

async function readTask(request: APIRequestContext, taskNumber: number) {
  const res = await request.get(`/api/projects/${PROJECT_KEY}/tasks/${taskNumber}`, {
    headers: ADMIN_AUTH,
  });
  expect(res.status()).toBe(200);
  return res.json();
}

async function patchTask(
  request: APIRequestContext,
  taskId: string,
  body: Record<string, unknown>
) {
  const res = await request.put(`/api/projects/${PROJECT_KEY}/tasks/${taskId}`, {
    headers: ADMIN_AUTH,
    data: body,
  });
  expect(res.status()).toBe(200);
}

test("a free card drags to another column, lands in the right place, and survives a reload", async ({
  page,
  request,
}) => {
  await signIn(page);

  const source = boardColumn(page, "todo");
  const target = boardColumn(page, "in_review");
  const finished = cardIn(source, FINISHED_TASK_NUMBER);

  await test.step("the board settles: four cards, the finished-run leftovers in To Do", async () => {
    await expect(cardIn(source, FINISHED_TASK_NUMBER)).toBeVisible();
    await expect(page.getByText(FINISHED_TASK_TITLE)).toBeVisible();
  });

  // The board moves the card optimistically, so the UI cannot prove the server agreed —
  // every server-side assertion below waits for the PUT to land first
  const move = page.waitForResponse(
    (res) => res.request().method() === "PUT" && res.url().endsWith(`/tasks/${FINISHED_TASK_ID}`)
  );
  await dragCardToColumn(page, finished, target);
  await move;

  await test.step("the move happens with no refusal dialog — this card is nobody's run", async () => {
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(cardIn(target, FINISHED_TASK_NUMBER)).toBeVisible();
    await expect(cardIn(source, FINISHED_TASK_NUMBER)).toHaveCount(0);

    const task = await readTask(request, FINISHED_TASK_NUMBER);
    expect(task._id).toBe(String(FINISHED_TASK_ID));
    expect(task.status).toBe("in_review");
  });

  await test.step("the move left an activity entry naming both columns", async () => {
    const activity = await storedActivity(FINISHED_TASK_ID);
    const move = activity.find((a) => a.action === "status_changed");
    expect(move).toMatchObject({ field: "status", oldValue: "todo", newValue: "in_review" });
  });

  await test.step("a reload shows the same board — the move was never only optimistic", async () => {
    await page.reload();
    await expect(page.getByText(FINISHED_TASK_TITLE)).toBeVisible();
    await expect(cardIn(boardColumn(page, "in_review"), FINISHED_TASK_NUMBER)).toBeVisible();
    await expect(cardIn(boardColumn(page, "todo"), FINISHED_TASK_NUMBER)).toHaveCount(0);
  });
});

test("a move the server refuses rolls the card back", async ({ page, request }) => {
  await signIn(page);
  await recordToasts(page);

  // Only the PUT the drop makes; polls and everything else pass through untouched
  await page.route(`**/api/projects/*/tasks/${FINISHED_TASK_ID}`, async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({ status: 500, body: '{"message":"broken"}' });
      return;
    }
    await route.continue();
  });

  await dragCardToColumn(
    page,
    cardIn(boardColumn(page, "todo"), FINISHED_TASK_NUMBER),
    boardColumn(page, "in_review")
  );

  await expectToast(page, "Failed to move task");
  await expect(cardIn(boardColumn(page, "todo"), FINISHED_TASK_NUMBER)).toBeVisible();
  await expect(cardIn(boardColumn(page, "in_review"), FINISHED_TASK_NUMBER)).toHaveCount(0);

  const task = await readTask(request, FINISHED_TASK_NUMBER);
  expect(task.status).toBe("todo");
});

test("creating a task from the header mints the next key and rejects an empty title", async ({
  page,
  request,
}) => {
  await signIn(page);
  await recordToasts(page);

  const modal = page.getByRole("dialog", { name: "New Task" });

  await test.step("an empty title cannot reach the server", async () => {
    await page.getByRole("button", { name: "New task" }).click();
    await expect(modal).toBeVisible();

    // The form leans on the browser's required-field validation, so submission is refused
    // before any request exists — proven by the counter below staying put
    await modal.getByRole("button", { name: "Create Task" }).click();
    await expect(modal).toBeVisible();

    const tasks = await request.get(`/api/projects/${PROJECT_KEY}/tasks`, { headers: ADMIN_AUTH });
    expect(await tasks.json()).toHaveLength(4);
  });

  await test.step("a filled form creates TP-5 straight into the backlog column", async () => {
    // ui/Select's <label> is not associated with its control, so the picker is reached
    // through the wrapper it shares the row with rather than by accessible name
    const priority = modal.locator("div:has(> label:text-is('Priority')) > select");
    await modal.getByLabel("Title").fill("Created from the board");
    await priority.selectOption({ label: "High" });
    await modal.getByRole("button", { name: "Create Task" }).click();

    await expectToast(page, "Task created");
    await expect(modal).toHaveCount(0);

    const created = cardIn(boardColumn(page, "planned"), 5);
    await expect(created).toContainText("Created from the board");
    await expect(created).toContainText(`${PROJECT_KEY}-5`);

    const task = await readTask(request, 5);
    expect(task.taskNumber).toBe(5);
    expect(task.title).toBe("Created from the board");
    expect(task.status).toBe("planned");
    expect(task.priority).toBe("high");
  });

  await test.step("cancelling the next draft leaves nothing behind", async () => {
    await page.getByRole("button", { name: "New task" }).click();
    await expect(modal).toBeVisible();
    await modal.getByLabel("Title").fill("Never saved");
    await modal.getByRole("button", { name: "Cancel" }).click();
    await expect(modal).toHaveCount(0);

    const tasks = await request.get(`/api/projects/${PROJECT_KEY}/tasks`, { headers: ADMIN_AUTH });
    expect(await tasks.json()).toHaveLength(5);
  });
});

test("a row edited in the list view really edits the task", async ({ page, request }) => {
  await signIn(page);
  await page.getByRole("button", { name: "List", exact: true }).click();

  const row = (kind: string) =>
    page.getByRole("combobox", { name: `${kind} for ${PROJECT_KEY}-${SIBLING_TASK_NUMBER}: ${SIBLING_TASK_TITLE}` });

  await test.step("status changes through the row picker", async () => {
    await expect(row("Status")).toContainText("In Progress");
    await row("Status").click();
    await page.getByRole("option", { name: "To Do", exact: true }).click();
    await expect(row("Status")).toContainText("To Do");

    const task = await readTask(request, SIBLING_TASK_NUMBER);
    expect(task.status).toBe("todo");
  });

  await test.step("assignee and priority take effect too", async () => {
    await row("Assignee").click();
    await page.getByRole("option", { name: "E2E Admin" }).click();
    await row("Priority").click();
    await page.getByRole("option", { name: "High" }).click();

    const task = await readTask(request, SIBLING_TASK_NUMBER);
    expect(task.assignee?.username).toBe("admin");
    expect(task.priority).toBe("high");

    const activity = await storedActivity(SIBLING_TASK_ID);
    expect(activity.some((a) => a.field === "priority" && a.newValue === "high")).toBe(true);
  });

  await test.step("back on the board, the card carries its new look", async () => {
    await page.getByRole("button", { name: "Board", exact: true }).click();
    const sibling = cardIn(boardColumn(page, "todo"), SIBLING_TASK_NUMBER);
    await expect(sibling).toContainText("High");
    await expect(sibling).toContainText("E2E Admin");
  });
});

test("filters narrow the board, combine, and survive a reload", async ({ page, request }) => {
  // Give the filters something real to chew on: one high-priority bug, one assigned task
  await patchTask(request, String(DECOY_TASK_ID), { priority: "high" });
  await patchTask(request, String(FINISHED_TASK_ID), { category: "bug" });
  await patchTask(request, String(SIBLING_TASK_ID), { assignee: "admin" });

  await signIn(page);

  const search = page.getByPlaceholder("Search tasks, or TP-128…");
  const cards = page.locator("[data-column-body] a[href*='/tasks/']");

  await test.step("text search narrows by title", async () => {
    await search.fill("Free to move");
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveText([new RegExp(SIBLING_TASK_TITLE)]);
  });

  await test.step("and by task key", async () => {
    await search.fill(`${PROJECT_KEY}-${FINISHED_TASK_NUMBER}`);
    await expect(cards).toHaveCount(1);
    await expect(page.getByText(FINISHED_TASK_TITLE)).toBeVisible();
    await search.fill("");
    await expect(cards).toHaveCount(4);
  });

  await test.step("the filter popover filters by category", async () => {
    await page.getByRole("button", { name: "Filters" }).click();
    const popover = page.getByRole("dialog", { name: "Filters" });
    await popover.getByLabel("Category").selectOption({ label: "bug" });

    // Only the finished card is a bug; the decoy stayed user-story
    await expect(cards).toHaveCount(1);
    await expect(page.getByText(FINISHED_TASK_TITLE)).toBeVisible();
    await expect(page.getByText(DECOY_TASK_TITLE)).toHaveCount(0);
  });

  await test.step("two filters combine into an empty board", async () => {
    const popover = page.getByRole("dialog", { name: "Filters" });
    await popover.getByLabel("Priority").selectOption({ label: "High" });

    await expect(cards).toHaveCount(0);
    await expect(page.getByText("Drop tasks here")).toHaveCount(7);

    await popover.getByRole("button", { name: "Clear all" }).click();
    await expect(cards).toHaveCount(4);
  });

  await test.step("an assignee filter survives a reload", async () => {
    const popover = page.getByRole("dialog", { name: "Filters" });
    await popover.getByLabel("Assignee").selectOption({ label: "admin" });
    await expect(cards).toHaveCount(1);

    await page.reload();
    await expect(page.getByText(SIBLING_TASK_TITLE)).toBeVisible();
    await expect(page.locator("[data-column-body] a[href*='/tasks/']")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Remove admin filter" })).toBeAttached();
  });

  await test.step("removing the chip restores the whole board", async () => {
    await page.getByRole("button", { name: "Remove admin filter" }).click();
    await expect(page.locator("[data-column-body] a[href*='/tasks/']")).toHaveCount(4);
  });
});

test("reordering a column keeps the run held and the status alone", async ({ page, request }) => {
  await signIn(page);

  const column = boardColumn(page, "in_progress");
  const held = cardIn(column, HELD_TASK_NUMBER);
  const sibling = cardIn(column, SIBLING_TASK_NUMBER);

  // Dragging the free card over the top half of the held one asks for the slot before it —
  // a pure reorder: same column, so the request carries an order and deliberately no status
  const move = page.waitForResponse(
    (res) => res.request().method() === "PUT" && res.url().endsWith(`/tasks/${SIBLING_TASK_ID}`)
  );
  await dragCardToColumn(page, sibling, column, held);
  await move;

  await test.step("the free card took the slot, the held card kept its state", async () => {
    const sibling_task = await readTask(request, SIBLING_TASK_NUMBER);
    const held_task = await readTask(request, HELD_TASK_NUMBER);
    expect(sibling_task.order).toBeLessThan(held_task.order);
    expect(sibling_task.status).toBe("in_progress");
    expect(held_task.execution?.phase).toBe("agent");
  });

  await test.step("the order outlives a reload", async () => {
    await page.reload();
    const column = boardColumn(page, "in_progress");
    await expect(cardIn(column, SIBLING_TASK_NUMBER)).toBeVisible();
    const hrefs = await column.locator("[data-column-body] a[href*='/tasks/']").evaluateAll(
      (cards) => cards.map((card) => (card as HTMLAnchorElement).getAttribute("href"))
    );
    expect(hrefs.indexOf(cardHref(SIBLING_TASK_NUMBER))).toBeLessThan(
      hrefs.indexOf(cardHref(HELD_TASK_NUMBER))
    );
  });
});

test("crossing columns with a position lands the card at that position", async ({
  page,
  request,
}) => {
  await signIn(page);

  const source = boardColumn(page, "in_progress");
  const target = boardColumn(page, "in_review");
  const decoy = cardIn(target, DECOY_TASK_NUMBER);

  const move = page.waitForResponse(
    (res) => res.request().method() === "PUT" && res.url().endsWith(`/tasks/${SIBLING_TASK_ID}`)
  );
  await dragCardToColumn(page, cardIn(source, SIBLING_TASK_NUMBER), target, decoy);
  await move;

  await test.step("it sits above the card it was dropped on, on both sides of the wire", async () => {
    await expect(cardIn(target, SIBLING_TASK_NUMBER)).toBeVisible();
    await expect(cardIn(source, SIBLING_TASK_NUMBER)).toHaveCount(0);

    const moved = await readTask(request, SIBLING_TASK_NUMBER);
    const anchor = await readTask(request, DECOY_TASK_NUMBER);
    expect(moved.status).toBe("in_review");
    expect(moved.order).toBeLessThan(anchor.order);
  });
});

test("bulk move takes every selected card through the context menu", async ({ page, request }) => {
  await signIn(page);
  await recordToasts(page);

  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: `Select ${PROJECT_KEY}-${SIBLING_TASK_NUMBER}` }).click();
  await page.getByRole("button", { name: `Select ${PROJECT_KEY}-${FINISHED_TASK_NUMBER}` }).click();
  await expect(page.getByRole("button", { name: "Select (2)" })).toBeVisible();

  await test.step("right-clicking one of them speaks for both", async () => {
    await cardIn(boardColumn(page, "in_progress"), SIBLING_TASK_NUMBER).click({
      button: "right",
    });
    await page
      .getByTestId("task-context-menu")
      .getByRole("button", { name: "Ready to Test", exact: true })
      .click();
  });

  await expectToast(page, "Moved 2 tasks");
  await expect(cardIn(boardColumn(page, "ready_to_test"), SIBLING_TASK_NUMBER)).toBeVisible();
  await expect(cardIn(boardColumn(page, "ready_to_test"), FINISHED_TASK_NUMBER)).toBeVisible();

  const movedSibling = await readTask(request, SIBLING_TASK_NUMBER);
  const movedFinished = await readTask(request, FINISHED_TASK_NUMBER);
  expect(movedSibling.status).toBe("ready_to_test");
  expect(movedFinished.status).toBe("ready_to_test");

  // The selection is spent: the header control reads plain "Select" again
  await expect(page.getByRole("button", { name: /^Select$/ })).toBeVisible();
});

test("the board works on a phone: every column is there and the rail scrolls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);

  for (const column of ["planned", "todo", "in_progress", "in_review", "needs_human_review", "ready_to_test", "done"]) {
    await expect(boardColumn(page, column)).toBeAttached();
  }

  // Seven columns at their floor width cannot fit 390px: the row must scroll sideways
  const scrollable = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".overflow-x-auto");
    return !!el && el.scrollWidth > el.clientWidth;
  });
  expect(scrollable).toBe(true);

  await expect(page.getByText(HELD_TASK_TITLE)).toBeVisible();
});
