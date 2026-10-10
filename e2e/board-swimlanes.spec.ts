import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { silenceBoardPoll } from "./board-poll";
import { dragTo as realDrag, type DragOptions } from "./drag";
import {
  DECOY_TASK_ID,
  FINISHED_TASK_ID,
  HELD_TASK_ID,
  HELD_TASK_NUMBER,
  MEMBER_USERNAME,
  PROJECT_KEY,
  SIBLING_TASK_ID,
  seed,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-885. The board can lay its columns out in rows by assignee, priority or category; a drop into
 * another row also gives the task that row's value, in the same request as the status.
 */
test.beforeEach(seed);

const BOARD = `/projects/${PROJECT_KEY}`;
const SEEDED_TASKS = 4;
const SIBLING = 3;
const DECOY = 2;
const FINISHED = 4;

const href = (n: number) => `${BOARD}/tasks/${n}`;
const cardIn = (cell: Locator, n: number) => cell.locator(`a[href="${href(n)}"]`);
const headers = (page: Page) => page.getByTestId("board-lane-header");
const header = (page: Page, label: string) => headers(page).filter({ hasText: label });
const cell = (page: Page, lane: string, column: string) =>
  page.locator(`[data-testid="column-${column}"][data-lane="${lane}"]`);
const body = (target: Locator) => target.locator("[data-column-body]");
const groupSelect = (page: Page) => page.getByLabel("Group tasks by");

/** The rows stack down the board, so the card may start below the fold: a person scrolls to it first. */
async function dragTo(page: Page, card: Locator, target: Locator, options?: DragOptions) {
  await card.scrollIntoViewIfNeeded();
  await realDrag(page, card, target, options);
}

async function put(request: APIRequestContext, id: unknown, data: Record<string, unknown>) {
  const res = await request.put(`/api/projects/${PROJECT_KEY}/tasks/${id}`, { headers: ADMIN_AUTH, data });
  expect(res.status(), await res.text()).toBe(200);
}

async function stored(request: APIRequestContext, n: number) {
  const res = await request.get(`/api/projects/${PROJECT_KEY}/tasks/${n}`, { headers: ADMIN_AUTH });
  expect(res.status()).toBe(200);
  return res.json();
}

function taskPut(page: Page, id: { toString(): string }) {
  return page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/tasks/${id}`));
}

/** Urgent: TP-3 (in progress). High: TP-2 (in review). Medium: TP-1 (in progress, held by a worker) and TP-4 (to do). */
async function openByPriority(page: Page, request: APIRequestContext) {
  await put(request, SIBLING_TASK_ID, { priority: "urgent" });
  await put(request, DECOY_TASK_ID, { priority: "high" });
  await silenceBoardPoll(page);
  await signIn(page);
  await page.goto(BOARD);
  await expect(page.locator("[data-column-body] a[href*='/tasks/']")).toHaveCount(SEEDED_TASKS);
  await groupSelect(page).selectOption({ label: "Group: Priority" });
  await expect(headers(page)).toHaveCount(3);
}

test("the board lays its columns out in rows, in order, with counts and the tasks under their own row", async ({ page, request }) => {
  await signIn(page);
  await page.goto(BOARD);
  await expect(page.locator("[data-column-body] a[href*='/tasks/']")).toHaveCount(SEEDED_TASKS);

  await test.step("the control: without a grouping there are no rows and each column is one", async () => {
    await expect(headers(page)).toHaveCount(0);
    await expect(page.getByTestId("column-in_progress")).toHaveCount(1);
  });

  await put(request, SIBLING_TASK_ID, { priority: "urgent" });
  await put(request, DECOY_TASK_ID, { priority: "high" });
  await page.reload();
  await expect(page.locator("[data-column-body] a[href*='/tasks/']")).toHaveCount(SEEDED_TASKS);

  await test.step("grouping by priority draws urgent, high, medium", async () => {
    await groupSelect(page).selectOption({ label: "Group: Priority" });
    await expect(headers(page)).toHaveCount(3);
    await expect(headers(page).nth(0)).toContainText("Urgent");
    await expect(headers(page).nth(1)).toContainText("High");
    await expect(headers(page).nth(2)).toContainText("Medium");
    await expect(headers(page).nth(2).getByTestId("board-lane-count")).toHaveText("2");
  });

  await test.step("each task sits in its own row and column", async () => {
    await expect(cardIn(cell(page, "v:urgent", "in_progress"), SIBLING)).toBeVisible();
    await expect(cardIn(cell(page, "v:high", "in_review"), DECOY)).toBeVisible();
    await expect(cardIn(cell(page, "v:medium", "in_progress"), HELD_TASK_NUMBER)).toBeVisible();
    await expect(cardIn(cell(page, "v:medium", "todo"), FINISHED)).toBeVisible();
    await expect(page.locator("[data-column-body] a[href*='/tasks/']")).toHaveCount(SEEDED_TASKS);
  });

  await test.step("the board offers rows for three choices only", async () => {
    const options = await groupSelect(page).locator("option").allTextContents();
    expect(options).toEqual(["No grouping", "Group: Assignee", "Group: Priority", "Group: Category"]);
  });
});

test("dropping into another row gives the task that row's value, with its status, in one request", async ({ page, request }) => {
  await openByPriority(page, request);

  const write = taskPut(page, SIBLING_TASK_ID);
  await dragTo(page, cardIn(cell(page, "v:urgent", "in_progress"), SIBLING), body(cell(page, "v:high", "in_review")));
  const res = await write;

  expect(res.status()).toBe(200);
  const sent = res.request().postDataJSON();
  expect(sent).toMatchObject({ status: "in_review", priority: "high" });
  expect(sent).toHaveProperty("order");

  const task = await stored(request, SIBLING);
  expect(task).toMatchObject({ status: "in_review", priority: "high" });
  await expect(cardIn(cell(page, "v:high", "in_review"), SIBLING)).toBeVisible();
  await expect(header(page, "Urgent")).toHaveCount(0);
});

test("a drop inside the row the task is in changes its status and nothing else, and a reorder sends neither", async ({ page, request }) => {
  await openByPriority(page, request);

  await test.step("to another column of the same row", async () => {
    const write = taskPut(page, FINISHED_TASK_ID);
    await dragTo(page, cardIn(cell(page, "v:medium", "todo"), FINISHED), body(cell(page, "v:medium", "in_progress")));
    const sent = (await write).request().postDataJSON();
    expect(sent).toMatchObject({ status: "in_progress" });
    expect(sent).not.toHaveProperty("priority");
    expect((await stored(request, FINISHED)).priority).toBe("medium");
  });

  await test.step("above a neighbour in the same cell: an order, no status and no field", async () => {
    const moved = cardIn(cell(page, "v:medium", "in_progress"), FINISHED);
    await expect(moved).toBeVisible();
    const held = cardIn(cell(page, "v:medium", "in_progress"), HELD_TASK_NUMBER);
    const write = taskPut(page, FINISHED_TASK_ID);
    await dragTo(page, moved, held, { atTop: true });
    const sent = (await write).request().postDataJSON();
    expect(sent).toHaveProperty("order");
    expect(sent).not.toHaveProperty("status");
    expect(sent).not.toHaveProperty("priority");
    const [a, b] = await Promise.all([stored(request, FINISHED), stored(request, HELD_TASK_NUMBER)]);
    expect(a.order).toBeLessThan(b.order);
  });
});

test("the position is among the neighbours in the row, not the whole column", async ({ page, request }) => {
  await put(request, SIBLING_TASK_ID, { priority: "urgent", order: 50 });
  await put(request, HELD_TASK_ID, { order: 10 });
  await put(request, DECOY_TASK_ID, { priority: "high", status: "in_progress", order: 99 });
  // Three rows are taller than the default window, and a drag needs both ends on the screen
  await page.setViewportSize({ width: 1280, height: 1100 });
  await silenceBoardPoll(page);
  await signIn(page);
  await page.goto(BOARD);
  await expect(page.locator("[data-column-body] a[href*='/tasks/']")).toHaveCount(SEEDED_TASKS);
  await groupSelect(page).selectOption({ label: "Group: Priority" });

  const write = taskPut(page, SIBLING_TASK_ID);
  await dragTo(page, cardIn(cell(page, "v:urgent", "in_progress"), SIBLING), body(cell(page, "v:medium", "in_progress")));
  const sent = (await write).request().postDataJSON();

  // The only task in the target cell is TP-1 at 10, so the drop goes after it; counting TP-2 at 99
  // in another row of the column as well would have put it between the two
  expect(sent.order).toBe(11);
});

test("Unassigned is a row of its own: dropping there clears the assignee, dropping into a person's row sets it", async ({ page, request }) => {
  await put(request, SIBLING_TASK_ID, { assignee: MEMBER_USERNAME });
  await put(request, DECOY_TASK_ID, { assignee: MEMBER_USERNAME });
  await silenceBoardPoll(page);
  await signIn(page);
  await page.goto(BOARD);
  await expect(page.locator("[data-column-body] a[href*='/tasks/']")).toHaveCount(SEEDED_TASKS);
  await groupSelect(page).selectOption({ label: "Group: Assignee" });
  await expect(headers(page)).toHaveCount(2);
  await expect(headers(page).nth(1)).toContainText("Unassigned");

  await test.step("into Unassigned", async () => {
    const write = taskPut(page, SIBLING_TASK_ID);
    await dragTo(page, cardIn(cell(page, "v:member", "in_progress"), SIBLING), body(cell(page, "@none", "in_progress")));
    const sent = (await write).request().postDataJSON();
    expect(sent).toHaveProperty("assignee", null);
    expect(sent).not.toHaveProperty("status");
    expect((await stored(request, SIBLING)).assignee).toBeNull();
  });

  await test.step("into a person's row", async () => {
    const write = taskPut(page, FINISHED_TASK_ID);
    await dragTo(page, cardIn(cell(page, "@none", "todo"), FINISHED), body(cell(page, "v:member", "in_review")));
    const sent = (await write).request().postDataJSON();
    expect(sent).toMatchObject({ assignee: MEMBER_USERNAME, status: "in_review" });
    expect((await stored(request, FINISHED)).assignee).toMatchObject({ username: MEMBER_USERNAME });
  });
});

test("a task a worker is running asks first, and the whole move waits for the answer", async ({ page, request }) => {
  await openByPriority(page, request);
  const source = cardIn(cell(page, "v:medium", "in_progress"), HELD_TASK_NUMBER);

  await test.step("the drop into another row is refused with a question", async () => {
    await dragTo(page, source, body(cell(page, "v:urgent", "in_review")));
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "This task is being executed" })).toBeVisible();
    expect(await stored(request, HELD_TASK_NUMBER)).toMatchObject({ priority: "medium", status: "in_progress" });
  });

  await test.step("cancelling leaves the card in its row", async () => {
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(cardIn(cell(page, "v:medium", "in_progress"), HELD_TASK_NUMBER)).toBeVisible();
    expect(await stored(request, HELD_TASK_NUMBER)).toMatchObject({ priority: "medium", status: "in_progress" });
  });

  await test.step("confirming retries the same move, row value included, with force", async () => {
    await dragTo(page, cardIn(cell(page, "v:medium", "in_progress"), HELD_TASK_NUMBER), body(cell(page, "v:urgent", "in_review")));
    await expect(page.getByRole("dialog").getByRole("button", { name: "Move anyway" })).toBeVisible();
    const retried = taskPut(page, HELD_TASK_ID);
    await page.getByRole("dialog").getByRole("button", { name: "Move anyway" }).click();
    const sent = (await retried).request().postDataJSON();
    expect(sent).toMatchObject({ priority: "urgent", status: "in_review", force: true });
    expect(await stored(request, HELD_TASK_NUMBER)).toMatchObject({ priority: "urgent", status: "in_review" });
  });
});

test("a drop into another row inside the column a worker holds the task in is not a move, so nobody is asked", async ({ page, request }) => {
  await openByPriority(page, request);

  const write = taskPut(page, HELD_TASK_ID);
  await dragTo(page, cardIn(cell(page, "v:medium", "in_progress"), HELD_TASK_NUMBER), body(cell(page, "v:urgent", "in_progress")));
  const res = await write;

  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON()).toMatchObject({ priority: "urgent" });
  expect(res.request().postDataJSON()).not.toHaveProperty("status");
  await expect(cardIn(cell(page, "v:urgent", "in_progress"), HELD_TASK_NUMBER)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await stored(request, HELD_TASK_NUMBER)).priority).toBe("urgent");
});

test("a drop on a cell's header counts as one on its body: the row's value comes with it", async ({ page, request }) => {
  await openByPriority(page, request);

  const write = taskPut(page, SIBLING_TASK_ID);
  await dragTo(page, cardIn(cell(page, "v:urgent", "in_progress"), SIBLING), cell(page, "v:high", "in_review").locator("h3").first());
  const res = await write;

  expect(res.request().postDataJSON()).toMatchObject({ status: "in_review", priority: "high" });
  await expect(cardIn(cell(page, "v:high", "in_review"), SIBLING)).toBeVisible();
});

test("dropping into a category row sets the category, with the column", async ({ page, request }) => {
  await put(request, SIBLING_TASK_ID, { category: "bug" });
  await put(request, DECOY_TASK_ID, { category: "doc" });
  await page.setViewportSize({ width: 1280, height: 1100 });
  await silenceBoardPoll(page);
  await signIn(page);
  await page.goto(BOARD);
  await expect(page.locator("[data-column-body] a[href*='/tasks/']")).toHaveCount(SEEDED_TASKS);
  await groupSelect(page).selectOption({ label: "Group: Category" });
  await expect(headers(page)).toHaveCount(3);
  await expect(headers(page).nth(0)).toContainText("bug");

  const write = taskPut(page, SIBLING_TASK_ID);
  await dragTo(page, cardIn(cell(page, "v:bug", "in_progress"), SIBLING), body(cell(page, "v:doc", "in_review")));
  const res = await write;

  expect(res.request().postDataJSON()).toMatchObject({ status: "in_review", category: "doc" });
  expect(await stored(request, SIBLING)).toMatchObject({ status: "in_review", category: "doc" });
});

test("a refused drop puts the card back in its row and column, both of them", async ({ page, request }) => {
  await openByPriority(page, request);
  await page.route(new RegExp(`/api/projects/[^/]+/tasks/${SIBLING_TASK_ID}$`), (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "no" }) })
      : route.continue()
  );

  await dragTo(page, cardIn(cell(page, "v:urgent", "in_progress"), SIBLING), body(cell(page, "v:high", "in_review")));

  await expect(page.getByText("Failed to move task")).toBeVisible();
  await expect(cardIn(cell(page, "v:urgent", "in_progress"), SIBLING)).toBeVisible();
  await expect(cardIn(cell(page, "v:high", "in_review"), SIBLING)).toHaveCount(0);
  expect(await stored(request, SIBLING)).toMatchObject({ priority: "urgent", status: "in_progress" });
});

test("a row folds to its header, keeps its count, and opens again", async ({ page, request }) => {
  await openByPriority(page, request);
  const medium = header(page, "Medium").getByRole("button");

  await expect(cell(page, "v:medium", "in_progress")).toBeVisible();
  await medium.click();

  await expect(medium).toHaveAttribute("aria-expanded", "false");
  await expect(header(page, "Medium").getByTestId("board-lane-count")).toHaveText("2");
  await expect(cell(page, "v:medium", "in_progress")).toHaveCount(0);
  await expect(cell(page, "v:urgent", "in_progress")).toBeVisible();

  await medium.click();
  await expect(cell(page, "v:medium", "in_progress")).toBeVisible();
});

test("the grouping is the list's too, and comes back after a reload", async ({ page, request }) => {
  await openByPriority(page, request);

  await page.reload();
  await expect(headers(page)).toHaveCount(3);
  await expect(groupSelect(page)).toHaveValue("priority");

  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.getByTestId("list-group-header")).toHaveCount(3);

  await groupSelect(page).selectOption({ label: "Group: Status" });
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page.getByTestId("column-in_progress")).toBeVisible();
  await expect(headers(page), "status is the columns, so the board draws no rows for it").toHaveCount(0);
  await expect(groupSelect(page)).toHaveValue("");
});

test("on a phone the columns still page, the row's name stays on screen, and the board scrolls down through the rows", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 560 });
  await openByPriority(page, request);

  await expect(header(page, "Urgent")).toBeInViewport();
  await page.getByTestId("column-dot-in_review").click();
  await expect(cell(page, "v:high", "in_review")).toBeInViewport();
  await expect(header(page, "High").getByRole("button")).toBeInViewport({ ratio: 1 });
  await expect(header(page, "Urgent").getByRole("button")).toBeInViewport({ ratio: 1 });

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await test.step("the rows below the first screen are reached by scrolling the board down", async () => {
    const medium = header(page, "Medium").getByRole("button");
    await expect(medium).not.toBeInViewport();
    // As a person scrolls: with the wheel over the board, not by a script that scrolls any box
    await page.mouse.move(195, 400);
    await page.mouse.wheel(0, 400);
    await expect(medium).toBeInViewport({ ratio: 1 });
    await expect(cell(page, "v:medium", "in_review")).toBeInViewport();
  });
});
