import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
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
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  RUN_PHASE,
  SIBLING_TASK_ID,
  SIBLING_TASK_KEY,
  SIBLING_TASK_NUMBER,
  SOURCE_COLUMN,
  SPARE_COLUMN,
  TARGET_COLUMN,
  WORKER_NAME,
  seed,
  storedExecution,
} from "./seed";

// Per test, not once per run: the flow ends with the run released, so a retry or a second
// iteration would otherwise start from a task no worker is holding
test.beforeEach(seed);

const AUTH = {
  Authorization: `Basic ${Buffer.from(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`).toString("base64")}`,
};

const cardHref = (taskNumber: number) => `/projects/${PROJECT_KEY}/tasks/${taskNumber}`;
const heldCardHref = cardHref(HELD_TASK_NUMBER);

/** The column by its board id, which is stable across markup changes in a way its heading is not. */
function boardColumn(page: Page, columnId: string): Locator {
  return page.getByTestId(`column-${columnId}`);
}

/**
 * The right-click menu, reached through its own "Move to" label: it carries no role and no test
 * id, and its column buttons are named after columns — text the board headings use too.
 */
function moveMenu(page: Page): Locator {
  return page.getByTestId("task-context-menu");
}

/** The badge a card shows while a run holds it, live or gone quiet. */
function runBadge(scope: Locator | Page): Locator {
  return scope.locator('[data-testid="card-run-live"], [data-testid="card-run-quiet"]');
}

/**
 * Every toast this page has raised, whether or not it is still on screen.
 *
 * Polling for the element loses them twice over: a toast clears itself after three seconds, and a
 * Fast Refresh — which the dev server runs whenever anything under the repo is saved, this suite
 * included — remounts the provider and takes any open toast with it before the poll comes round.
 * That is a real failure this test hit, with the board otherwise in exactly the right state.
 */
async function recordToasts(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = ((window as unknown as { __toasts?: string[] }).__toasts = []);
    const collect = (node: Node) => {
      if (!(node instanceof HTMLElement)) return;
      // The first toast arrives inside its container; later ones are added on their own
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

async function signIn(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByLabel("Username").fill(ADMIN_USERNAME);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();

  await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
  await expect(page.getByText(HELD_TASK_TITLE)).toBeVisible();
  await recordToasts(page);
}

async function readTask(request: APIRequestContext, taskNumber: number) {
  const res = await request.get(`/api/projects/${PROJECT_KEY}/tasks/${taskNumber}`, {
    headers: AUTH,
  });
  expect(res.status()).toBe(200);
  return res.json();
}

/**
 * The board uses native HTML5 drag and drop, which Playwright's mouse cannot drive: Chromium
 * runs the drag on the OS, so no dragstart/drop ever reaches the page. The events are dispatched
 * by hand instead, sharing one live DataTransfer — the card writes its id into it on dragstart
 * and the column reads that id back on drop.
 */
async function dragCardToColumn(page: Page, card: Locator, column: Locator) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const body = column.locator("[data-column-body]");

  await card.dispatchEvent("dragstart", { dataTransfer });
  await body.dispatchEvent("dragenter", { dataTransfer });
  await body.dispatchEvent("dragover", { dataTransfer });

  // The insertion marker is proof the column computed a drop index. Without one the drop falls
  // through to the status endpoint instead — a different code path, and not the one under test.
  await expect(column.locator("[data-column-body] > div.h-0\\.5")).toBeAttached();

  await body.dispatchEvent("drop", { dataTransfer });
  // No dragend: nothing listens for it, and a drop the server accepts moves the card out from
  // under the locator, so dispatching one would fail on exactly the path that worked
  await dataTransfer.dispose();
}

test("a task a worker is running cannot be dragged away without confirming", async ({
  page,
  request,
}) => {
  await test.step("the server is talking to the e2e database", async () => {
    // A project keyed TP exists in the development database too. This runs before the browser
    // touches anything, so a dev server that ignored MONGODB_URI fails here rather than writing
    // into whatever the developer is using.
    const res = await request.get(`/api/projects/${PROJECT_KEY}`, { headers: AUTH });
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
    // The menu goes through PATCH .../status while a drag goes through PUT on the task. Both
    // answer 409, so without pinning the endpoint this test would pass on the path already covered.
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

  // The board writes the order back with PUT and omits the status when it has not changed. The
  // response code is what separates a reorder from a takeover: the same endpoint answers 409 when
  // the status genuinely moves, which is what the first test in this file drives.
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
    // Present at all only while a runId still holds the task — toApiExecution returns nothing
    // once the run is released, so this is the assertion that a reorder did not detach the worker
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
    // Exact: the per-card checkboxes are named "Select TP-1", which a substring match also finds
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page.getByRole("button", { name: `Select ${HELD_TASK_KEY}`, exact: true }).click();
    await page.getByRole("button", { name: `Select ${SIBLING_TASK_KEY}`, exact: true }).click();
    await expect(page.getByRole("button", { name: "Select (2)", exact: true })).toBeVisible();
  });

  await test.step("the move is partial, and the toast names what stayed", async () => {
    // Right-clicking inside the selection is what makes the menu act on all of it
    await source.locator(`a[href="${heldCardHref}"]`).click({ button: "right" });
    await expect(moveMenu(page)).toContainText("2 tasks selected");
    await moveMenu(page).getByRole("button", { name: TARGET_COLUMN.label, exact: true }).click();

    await expectToast(page, `Moved 1 of 2. ${HELD_TASK_KEY} being executed by a worker.`);
    // A bulk move reports rather than asks: one refusal among many has no single retry to offer
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
    // The API never publishes this, so nothing else in the test can tell a released run from a
    // task that was never executed — and without it the absence of a dialog proves nothing
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
