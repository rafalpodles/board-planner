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
import { signIn as arriveSignedIn } from "./session";
import { dragTo } from "./drag";

/**
 * BP-384: the board is the product's most-used surface and until now had no coverage of its
 * own — drags appeared only inside refusal contexts (run-conflict) and sprint planning.
 * These tests drive the happy paths a person touches every day: moving cards, creating
 * tasks, editing rows, filtering, bulk-moving, reading the board on a phone.
 */

test.beforeEach(seed);

const boardUrl = `/projects/${PROJECT_KEY}`;
const cardHref = (taskNumber: number) => `/projects/${PROJECT_KEY}/tasks/${taskNumber}`;

/** Every card the board draws, in any column. */
const CARDS = "[data-column-body] a[href*='/tasks/']";

// seed() lays down four tasks and leaves taskCounter on the same number, so this is both the
// board's card count and the number the next created task has to mint.
const SEEDED_TASKS = 4;

/** The column by its board id, stable across markup changes in a way its heading is not. */
function boardColumn(page: Page, columnId: string): Locator {
  return page.getByTestId(`column-${columnId}`);
}

function cardIn(column: Locator, taskNumber: number): Locator {
  return column.locator(`a[href="${cardHref(taskNumber)}"]`);
}

async function signIn(page: Page) {
  await arriveSignedIn(page);
  await page.goto(boardUrl);
  await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
  // The heading comes from the project request and the cards from their own, so waiting only
  // for the heading hands the test a board that has not loaded its tasks yet
  await expect(page.locator(CARDS)).toHaveCount(SEEDED_TASKS);
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
 * The write the board makes for one task. Registered before the click and awaited after it:
 * the board repaints optimistically on several of these paths, so the UI settling says nothing
 * about the server having agreed — and a read fired off the click races the write it checks.
 */
function taskPut(page: Page, taskId: { toString(): string }) {
  return page.waitForResponse(
    (res) => res.request().method() === "PUT" && res.url().endsWith(`/tasks/${taskId}`)
  );
}

/**
 * Moves a card by dragging it, for real: see e2e/drag.ts for what the hand-dispatched version
 * could not test. When `onto` is given the pointer lands near that card's top edge, so the column
 * computes an insertion position before it instead of appending at the end.
 */
async function dragCardToColumn(page: Page, card: Locator, column: Locator, onto?: Locator) {
  const body = column.locator("[data-column-body]");
  const wasEmpty = (await column.locator(CARDS).count()) === 0;

  await dragTo(page, card, onto ?? body, {
    atTop: Boolean(onto),
    // The insertion marker is proof a drop index was computed; without one the drop falls
    // through to the plain status endpoint — a different code path than the one under test.
    // An empty column draws no marker at all (Column renders the trailing one only above a
    // card), so there the proof has to come from the request instead — see the empty-column
    // test below, which asserts the body carries an order only onTaskDrop would send.
    //
    // Asserted with the button still down, which the synthetic version could not do: there was
    // no drag session to be in the middle of.
    duringDrag: wasEmpty
      ? undefined
      : async () => {
          await expect(column.locator("[data-column-body] div.h-0\\.5").first()).toBeAttached();
        },
  });
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

  // The decoy, not the finished-run card out of To Do: that exact drag is run-conflict's
  // "a task whose run has already finished moves without being questioned", and repeating it
  // here would buy a second site to maintain and no second thing tested.
  const source = boardColumn(page, "in_review");
  const target = boardColumn(page, "todo");

  const move = taskPut(page, DECOY_TASK_ID);
  await dragCardToColumn(page, cardIn(source, DECOY_TASK_NUMBER), target);
  expect((await move).status()).toBe(200);

  await test.step("the card is in the new column, and nothing else moved", async () => {
    await expect(cardIn(target, DECOY_TASK_NUMBER)).toBeVisible();
    await expect(cardIn(source, DECOY_TASK_NUMBER)).toHaveCount(0);
    await expect(page.locator(CARDS)).toHaveCount(SEEDED_TASKS);

    const task = await readTask(request, DECOY_TASK_NUMBER);
    expect(task._id).toBe(String(DECOY_TASK_ID));
    expect(task.status).toBe("todo");
  });

  await test.step("the move left an activity entry naming both columns", async () => {
    const activity = await storedActivity(DECOY_TASK_ID);
    const entry = activity.find((a) => a.action === "status_changed");
    expect(entry).toMatchObject({ field: "status", oldValue: "in_review", newValue: "todo" });
  });

  await test.step("a reload shows the same board — the move was never only optimistic", async () => {
    await page.reload();
    await expect(page.getByText(DECOY_TASK_TITLE)).toBeVisible();
    await expect(cardIn(boardColumn(page, "todo"), DECOY_TASK_NUMBER)).toBeVisible();
    await expect(cardIn(boardColumn(page, "in_review"), DECOY_TASK_NUMBER)).toHaveCount(0);
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

  // Every attempt to create, whether or not the form let it through. A task count on its own
  // cannot tell a request the browser refused to make from one the server refused to honour —
  // and those are not even equivalent, because the server's refusal still burns a task number.
  const creates: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname.endsWith("/tasks")) {
      creates.push(req.url());
    }
  });

  await test.step("an empty title cannot reach the server", async () => {
    await page.getByRole("button", { name: "New task" }).click();
    await expect(modal).toBeVisible();
    // AI Assist renders only once /ai/generate-task has answered, and it adds ~110px above these
    // fields. Awaited here so a late answer cannot shift the form under an action in flight.
    await expect(modal.getByPlaceholder("Describe what you need")).toBeVisible();

    // The form leans on the browser's required-field validation, so the submit never happens
    await modal.getByRole("button", { name: "Create Task" }).click();
    const refusedByTheBrowser = await modal
      .getByLabel("Title")
      .evaluate((el) => (el as HTMLInputElement).validity.valueMissing);
    expect(refusedByTheBrowser).toBe(true);
    expect(creates).toEqual([]);
    await expect(modal).toBeVisible();

    const tasks = await request.get(`/api/projects/${PROJECT_KEY}/tasks`, { headers: ADMIN_AUTH });
    expect(await tasks.json()).toHaveLength(SEEDED_TASKS);
  });

  await test.step("a filled form creates the next key straight into the backlog column", async () => {
    // ui/Select's <label> is not associated with its control, so the picker is reached
    // through the wrapper it shares the row with rather than by accessible name
    const priority = modal.locator("div:has(> label:text-is('Priority')) > select");
    await modal.getByLabel("Title").fill("Created from the board");
    await priority.selectOption({ label: "High" });

    const posted = page.waitForResponse(
      (res) => res.request().method() === "POST" && res.url().endsWith("/tasks")
    );
    await modal.getByRole("button", { name: "Create Task" }).click();
    const created = await (await posted).json();

    // Read back rather than written down: the project's counter decides the number, and a
    // literal 5 here is also seed()'s own SECOND_HELD_TASK_NUMBER
    expect(created.taskNumber).toBe(SEEDED_TASKS + 1);
    expect(creates).toHaveLength(1);

    await expectToast(page, "Task created");
    await expect(modal).toHaveCount(0);

    const card = cardIn(boardColumn(page, "planned"), created.taskNumber);
    await expect(card).toContainText("Created from the board");
    await expect(card).toContainText(`${PROJECT_KEY}-${created.taskNumber}`);

    const task = await readTask(request, created.taskNumber);
    expect(task.title).toBe("Created from the board");
    expect(task.status).toBe("planned");
    expect(task.priority).toBe("high");
  });

  await test.step("cancelling the next draft leaves nothing behind", async () => {
    await page.getByRole("button", { name: "New task" }).click();
    await expect(modal).toBeVisible();
    // AI Assist renders only once /ai/generate-task has answered, and it adds ~110px above these
    // fields. Awaited here so a late answer cannot shift the form under an action in flight.
    await expect(modal.getByPlaceholder("Describe what you need")).toBeVisible();
    await modal.getByLabel("Title").fill("Never saved");
    await modal.getByRole("button", { name: "Cancel" }).click();
    await expect(modal).toHaveCount(0);

    expect(creates).toHaveLength(1);
    const tasks = await request.get(`/api/projects/${PROJECT_KEY}/tasks`, { headers: ADMIN_AUTH });
    expect(await tasks.json()).toHaveLength(SEEDED_TASKS + 1);
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
    // The status write is awaited before the board repaints, so the new label is itself
    // proof the server agreed
    await expect(row("Status")).toContainText("To Do");

    const task = await readTask(request, SIBLING_TASK_NUMBER);
    expect(task.status).toBe("todo");
  });

  await test.step("assignee and priority take effect too", async () => {
    // Unlike status, the priority cell repaints before its PUT is sent, so the write has to be
    // waited for by hand — a read fired straight off the click loses the race on a busy machine
    const assigned = taskPut(page, SIBLING_TASK_ID);
    await row("Assignee").click();
    await page.getByRole("option", { name: "E2E Admin" }).click();
    expect((await assigned).status()).toBe(200);

    const prioritised = taskPut(page, SIBLING_TASK_ID);
    await row("Priority").click();
    await page.getByRole("option", { name: "High" }).click();
    expect((await prioritised).status()).toBe(200);

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
  const cards = page.locator(CARDS);

  await test.step("text search narrows by title", async () => {
    await search.fill("Free to move");
    await expect(cards).toHaveCount(1);
    await expect(page.getByText(SIBLING_TASK_TITLE)).toBeVisible();
  });

  await test.step("and by task key", async () => {
    await search.fill(`${PROJECT_KEY}-${FINISHED_TASK_NUMBER}`);
    await expect(cards).toHaveCount(1);
    await expect(page.getByText(FINISHED_TASK_TITLE)).toBeVisible();
    await search.fill("");
    await expect(cards).toHaveCount(SEEDED_TASKS);
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
    await expect(cards).toHaveCount(SEEDED_TASKS);
  });

  await test.step("an assignee filter survives a reload", async () => {
    const popover = page.getByRole("dialog", { name: "Filters" });
    await popover.getByLabel("Assignee").selectOption({ label: "admin" });
    await expect(cards).toHaveCount(1);

    await page.reload();
    await expect(page.getByText(SIBLING_TASK_TITLE)).toBeVisible();
    await expect(page.locator(CARDS)).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Remove admin filter" })).toBeAttached();
  });

  await test.step("removing the chip restores the whole board", async () => {
    await page.getByRole("button", { name: "Remove admin filter" }).click();
    await expect(page.locator(CARDS)).toHaveCount(SEEDED_TASKS);
  });
});

test("a reorder inside a column carries an order and no status", async ({ page, request }) => {
  await signIn(page);

  const column = boardColumn(page, "in_progress");
  const held = cardIn(column, HELD_TASK_NUMBER);
  const sibling = cardIn(column, SIBLING_TASK_NUMBER);

  const before = await readTask(request, SIBLING_TASK_NUMBER);

  // Dragging the free card over the top half of the held one asks for the slot before it
  const move = taskPut(page, SIBLING_TASK_ID);
  await dragCardToColumn(page, sibling, column, held);
  const res = await move;

  await test.step("the request says order, and deliberately not status", async () => {
    expect(res.status()).toBe(200);
    // Resending the status a card already has is what stamps updatedAt, and on a card a worker
    // holds it is what detaches the run. It can only be caught on the card being *dragged*: the
    // card being dragged past is never the subject of this request, so asserting the anchor's
    // run survived would pass however this body were built. The held-card version of this drag
    // lives in run-conflict, "dragging a held card inside its own column reorders it".
    expect(res.request().postDataJSON()).toHaveProperty("order");
    expect(res.request().postDataJSON()).not.toHaveProperty("status");
  });

  await test.step("the free card took the slot, and a reorder is not an edit", async () => {
    const moved = await readTask(request, SIBLING_TASK_NUMBER);
    const anchor = await readTask(request, HELD_TASK_NUMBER);
    expect(moved.order).toBeLessThan(anchor.order);
    expect(moved.status).toBe("in_progress");
    // The server writes a pure reorder with timestamps off, so the card must not come back
    // reading "updated just now"
    expect(moved.updatedAt).toBe(before.updatedAt);
  });

  await test.step("the order outlives a reload", async () => {
    await page.reload();
    const column = boardColumn(page, "in_progress");
    await expect(cardIn(column, SIBLING_TASK_NUMBER)).toBeVisible();
    const hrefs = await column.locator(CARDS).evaluateAll(
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

  const move = taskPut(page, SIBLING_TASK_ID);
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

test("a card dropped into an empty column becomes its first", async ({ page, request }) => {
  await signIn(page);

  const source = boardColumn(page, "in_progress");
  const target = boardColumn(page, "ready_to_test");
  await expect(target.locator(CARDS)).toHaveCount(0);

  // The one drop the insertion marker cannot vouch for, and the branch handleTaskDrop takes
  // when the target column has nothing to sort against. The proof it took the drop path at all
  // is the request itself: the fallback the column reaches for when no index was computed goes
  // to the status endpoint with PATCH, and would never satisfy this PUT.
  const move = taskPut(page, SIBLING_TASK_ID);
  await dragCardToColumn(page, cardIn(source, SIBLING_TASK_NUMBER), target);
  const res = await move;

  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON()).toMatchObject({ status: "ready_to_test", order: 0 });

  await expect(cardIn(target, SIBLING_TASK_NUMBER)).toBeVisible();
  await expect(cardIn(source, SIBLING_TASK_NUMBER)).toHaveCount(0);

  const moved = await readTask(request, SIBLING_TASK_NUMBER);
  expect(moved.status).toBe("ready_to_test");
  expect(moved.order).toBe(0);
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

  // Measured from a column upwards rather than by asking the document for its first
  // .overflow-x-auto: that utility carries mobile tab rails elsewhere in the app, and the first
  // match would answer for whichever of those the shell happens to render above the board.
  // Seven columns at their floor width cannot fit 390px, so the row must scroll sideways.
  const scrollable = await boardColumn(page, "planned").evaluate((el) => {
    const rail = el.closest(".overflow-x-auto") as HTMLElement | null;
    return !!rail && rail.scrollWidth > rail.clientWidth;
  });
  expect(scrollable).toBe(true);

  await expect(page.getByText(HELD_TASK_TITLE)).toBeVisible();
});

/**
 * BP-488. On a phone each column fills the screen and a flick moves to the next one, in the
 * order the project configured.
 *
 * **What this spec can and cannot see.** The gestures are `TouchEvent`s constructed in the page,
 * so they drive the component's own handlers and the scroll geometry, and nothing else. They do
 * not exercise `touch-action`, native panning, or the browser's gesture arbitration.
 *
 * That is a limit of the tooling, not a choice. Driving it instead through Chrome's real input
 * pipeline (`Input.dispatchTouchEvent` over CDP) was tried and abandoned: measured, a 30px drag —
 * below the paging threshold, so the component does nothing — panned the rail 61px, and it still
 * panned 46px with `touch-action: none` on the rail. CDP-injected touch ignores `touch-action`
 * outright, so it invents native panning a real finger would not produce and fails for reasons
 * the product does not have.
 *
 * So `touch-action` is guarded in `Board.test.tsx` as a property of the rendered element, and
 * "works on iOS Safari and Android Chrome" is not something this suite can answer — it needs a
 * real device.
 */
test.describe("swiping between the columns on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  async function flick(page: Page, dx: number, dy = 0) {
    await page.evaluate(
      ({ dx, dy }) => {
        const rail = document
          .querySelector("[data-testid='column-planned']")!
          .closest(".overflow-x-auto") as HTMLElement;
        const box = rail.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const at = (px: number, py: number) => [
          new Touch({ identifier: 1, target: rail, clientX: px, clientY: py }),
        ];
        const send = (type: string, touches: Touch[], changedTouches: Touch[]) =>
          rail.dispatchEvent(
            new TouchEvent(type, { bubbles: true, cancelable: true, touches, changedTouches })
          );
        send("touchstart", at(x, y), at(x, y));
        // Several moves rather than one: the component reads the furthest point the finger
        // reached, not only where it ended, and a single jump would leave that unexercised
        for (const step of [0.34, 0.67, 1]) {
          send("touchmove", at(x + dx * step, y + dy * step), at(x + dx * step, y + dy * step));
        }
        send("touchend", [], at(x + dx, y + dy));
      },
      { dx, dy }
    );
  }

  const activeDot = (page: Page) => page.locator("[data-testid^='column-dot-'][aria-current]");

  /** Whether the column is the one the reader is looking at, rather than a page away. */
  function onScreen(page: Page, columnId: string) {
    return boardColumn(page, columnId).evaluate((el) => {
      const rail = el.closest(".overflow-x-auto") as HTMLElement;
      const column = el.getBoundingClientRect();
      const view = rail.getBoundingClientRect();
      return column.left >= view.left - 1 && column.right <= view.right + 1;
    });
  }

  async function expectShowing(page: Page, columnId: string, label: string) {
    await expect(activeDot(page)).toHaveAttribute("aria-label", `Show ${label}`);
    await expect.poll(() => onScreen(page, columnId)).toBe(true);
  }

  test("a flick left moves on a column, a flick right moves back, and the first column is the end of the road", async ({
    page,
  }) => {
    await signIn(page);

    // The control: the board opens on its first column and the second one is off screen
    await expectShowing(page, "planned", "Planned");
    expect(await onScreen(page, "todo")).toBe(false);

    await flick(page, -150);
    await expectShowing(page, "todo", "To Do");
    expect(await onScreen(page, "planned")).toBe(false);

    await flick(page, 150);
    await expectShowing(page, "planned", "Planned");

    // No loop: the board stays where it is rather than jumping to Done
    await flick(page, 150);
    await expectShowing(page, "planned", "Planned");
  });

  test("flicking past the last column stops there", async ({ page }) => {
    await signIn(page);

    const rest = [
      ["todo", "To Do"],
      ["in_progress", "In Progress"],
      ["in_review", "In Review"],
      ["needs_human_review", "Needs Human Review"],
      ["ready_to_test", "Ready to Test"],
      ["done", "Done"],
    ];
    for (const [columnId, label] of rest) {
      await flick(page, -150);
      await expectShowing(page, columnId, label);
    }

    await flick(page, -150);
    await expectShowing(page, "done", "Done");
  });

  // The same finger scrolls a column's cards. Paging on that gesture would make the board
  // unreadable, so a drag that is mostly vertical has to leave it alone.
  test("a mostly vertical drag does not page the board", async ({ page }) => {
    await signIn(page);
    await expectShowing(page, "planned", "Planned");

    await flick(page, -150, 400);
    await expectShowing(page, "planned", "Planned");
  });

  // Swiping is additive: the indicator is still a way to pick a column outright
  test("tapping a dot jumps to that column", async ({ page }) => {
    await signIn(page);

    await page.getByTestId("column-dot-done").click();
    await expectShowing(page, "done", "Done");
    expect(await onScreen(page, "planned")).toBe(false);
  });
});
