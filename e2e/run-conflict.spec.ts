import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  DECOY_TASK_TITLE,
  HELD_TASK_ID,
  HELD_TASK_KEY,
  HELD_TASK_NUMBER,
  HELD_TASK_TITLE,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  RUN_PHASE,
  SOURCE_COLUMN,
  TARGET_COLUMN,
  WORKER_NAME,
  seed,
} from "./seed";

// Per test, not once per run: the flow ends with the run released, so a retry or a second
// iteration would otherwise start from a task no worker is holding
test.beforeEach(seed);

const AUTH = {
  Authorization: `Basic ${Buffer.from(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`).toString("base64")}`,
};

const heldCardHref = `/projects/${PROJECT_KEY}/tasks/${HELD_TASK_NUMBER}`;

/** The column by its board id, which is stable across markup changes in a way its heading is not. */
function boardColumn(page: Page, columnId: string): Locator {
  return page.getByTestId(`column-${columnId}`);
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
    await page.goto(`/projects/${PROJECT_KEY}`);
    await page.getByLabel("Username").fill(ADMIN_USERNAME);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();

    await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
    await expect(page.getByText(HELD_TASK_TITLE)).toBeVisible();
    await expect(page.getByText(DECOY_TASK_TITLE)).toBeVisible();
  });

  const source = boardColumn(page, SOURCE_COLUMN.id);
  const target = boardColumn(page, TARGET_COLUMN.id);
  const heldCard = source.locator(`a[href="${heldCardHref}"]`);

  await test.step("the card shows a live run", async () => {
    await expect(heldCard).toBeVisible();
    await expect(
      heldCard.locator('[data-testid="card-run-live"], [data-testid="card-run-quiet"]')
    ).toContainText(RUN_PHASE);
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

    const res = await request.get(`/api/projects/${PROJECT_KEY}/tasks/${HELD_TASK_NUMBER}`, {
      headers: AUTH,
    });
    const task = await res.json();
    expect(task._id).toBe(String(HELD_TASK_ID));
    expect(task.status).toBe(SOURCE_COLUMN.id);
    expect(task.execution?.phase).toBe(RUN_PHASE);
  });

  await test.step("confirming moves it and releases the run", async () => {
    await dragCardToColumn(page, source.locator(`a[href="${heldCardHref}"]`), target);
    await page.getByRole("dialog").getByRole("button", { name: "Move anyway" }).click();

    await expect(page.getByText(`${HELD_TASK_KEY} taken from the worker`)).toBeVisible();
    await expect(target.locator(`a[href="${heldCardHref}"]`)).toBeVisible();
    await expect(source.locator(`a[href="${heldCardHref}"]`)).toHaveCount(0);
    await expect(
      page.locator('[data-testid="card-run-live"], [data-testid="card-run-quiet"]')
    ).toHaveCount(0);

    const res = await request.get(`/api/projects/${PROJECT_KEY}/tasks/${HELD_TASK_NUMBER}`, {
      headers: AUTH,
    });
    const task = await res.json();
    expect(task.status).toBe(TARGET_COLUMN.id);
    expect(task.execution).toBeUndefined();
  });
});
