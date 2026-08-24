import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  PLANNING_BACKLOG_TASK_ID,
  PLANNING_BACKLOG_TASK_NUMBER,
  PLANNING_BACKLOG_TASK_TITLE,
  PLANNING_SPRINT_DONE_TASK_TITLE,
  PLANNING_SPRINT_ID,
  PLANNING_SPRINT_TASK_ID,
  PLANNING_SPRINT_TASK_NUMBER,
  PLANNING_SPRINT_TASK_TITLE,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  seed,
  seedSprintPlanning,
} from "./seed";
import { signIn as arriveSignedIn } from "./session";

/**
 * BP-207: the planning view's two panes accept a dragged task, but every existing check of that
 * path drives it through fireEvent.drop in happy-dom, which skips the dragover negotiation the
 * real drop handler depends on. This is the first coverage of the gesture through a real browser.
 */

test.beforeEach(async () => {
  await seed();
  await seedSprintPlanning();
});

const cardHref = (taskNumber: number) => `/projects/${PROJECT_KEY}/tasks/${taskNumber}`;
const planningUrl = `/projects/${PROJECT_KEY}/sprints?sprint=${PLANNING_SPRINT_ID}&view=planning`;

function backlogPane(page: Page): Locator {
  return page.getByTestId("planning-pane-backlog");
}

function sprintPane(page: Page): Locator {
  return page.getByTestId("planning-pane-sprint");
}

function cardsIn(pane: Locator): Locator {
  return pane.locator("a[href*='/tasks/']");
}

function sprintProgress(page: Page): Locator {
  return page.getByTestId("sprint-progress");
}

const signIn = arriveSignedIn;

async function readTask(request: APIRequestContext, taskNumber: number) {
  const res = await request.get(`/api/projects/${PROJECT_KEY}/tasks/${taskNumber}`, {
    headers: ADMIN_AUTH,
  });
  expect(res.status()).toBe(200);
  return res.json();
}

/**
 * Chromium runs a native drag on the OS, so Playwright's mouse produces no dragstart/drop in the
 * page (see e2e/run-conflict.spec.ts for the fuller explanation). The events are dispatched by
 * hand instead, sharing one live DataTransfer between the card and the pane.
 *
 * Unlike the board's columns, a planning pane has no insertion marker to prove the dragover was
 * even seen — the pane's own onDragOver only calls preventDefault, with no visible feedback. So
 * there is nothing to assert here beyond dispatching the sequence; the outcome is checked by the
 * caller, in two independent places (the two panes' counts, and the server's own copy of the task).
 */
async function dragCardToPane(page: Page, card: Locator, pane: Locator) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent("dragstart", { dataTransfer });
  await pane.dispatchEvent("dragenter", { dataTransfer });
  await pane.dispatchEvent("dragover", { dataTransfer });
  await pane.dispatchEvent("drop", { dataTransfer });
  await dataTransfer.dispose();
}

test("dragging a task from the backlog into the sprint pane adds it to the sprint", async ({
  page,
  request,
}) => {
  await test.step("the server is talking to the e2e database", async () => {
    // A project keyed TP exists in the development database too. This runs before the browser
    // touches anything, so a dev server that ignored MONGODB_URI fails here rather than writing
    // into whatever the developer is using.
    const res = await request.get(`/api/projects/${PROJECT_KEY}`, { headers: ADMIN_AUTH });
    expect(res.status()).toBe(200);
    const project = await res.json();
    expect(project._id).toBe(String(PROJECT_ID));
    expect(project.name).toBe(PROJECT_NAME);
  });

  await signIn(page);
  await page.goto(planningUrl);

  const backlog = backlogPane(page);
  const sprint = sprintPane(page);
  const backlogCard = backlog.locator(`a[href="${cardHref(PLANNING_BACKLOG_TASK_NUMBER)}"]`);

  await test.step("both panes are settled: two in the sprint, the new task in the backlog", async () => {
    await expect(sprintPane(page)).toContainText(PLANNING_SPRINT_TASK_TITLE);
    await expect(cardsIn(sprint)).toHaveCount(2);
    await expect(backlogCard).toBeVisible();
    await expect(sprintProgress(page)).toHaveText("1/2");
  });

  const backlogCountBefore = await cardsIn(backlog).count();

  await dragCardToPane(page, backlogCard, sprint);

  await test.step("the sprint pane gains it and the backlog pane loses it", async () => {
    await expect(cardsIn(sprint)).toHaveCount(3);
    await expect(sprint.locator(`a[href="${cardHref(PLANNING_BACKLOG_TASK_NUMBER)}"]`)).toBeVisible();
    await expect(cardsIn(backlog)).toHaveCount(backlogCountBefore - 1);
    await expect(backlog.locator(`a[href="${cardHref(PLANNING_BACKLOG_TASK_NUMBER)}"]`)).toHaveCount(0);
  });

  await test.step("the header's total follows; done stays put since the moved task isn't done", async () => {
    await expect(sprintProgress(page)).toHaveText("1/3");
  });

  await test.step("the task really moved on the server, not just on screen", async () => {
    const task = await readTask(request, PLANNING_BACKLOG_TASK_NUMBER);
    expect(task._id).toBe(String(PLANNING_BACKLOG_TASK_ID));
    expect(task.sprint).toBe(String(PLANNING_SPRINT_ID));
  });
});

test("dragging a task from the sprint pane back to the backlog removes it from the sprint", async ({
  page,
  request,
}) => {
  await signIn(page);
  await page.goto(planningUrl);

  const backlog = backlogPane(page);
  const sprint = sprintPane(page);
  const sprintCard = sprint.locator(`a[href="${cardHref(PLANNING_SPRINT_TASK_NUMBER)}"]`);

  await test.step("the sprint starts with both of its tasks, and the backlog has settled", async () => {
    await expect(cardsIn(sprint)).toHaveCount(2);
    await expect(sprintCard).toBeVisible();
    await expect(sprintProgress(page)).toHaveText("1/2");
    // The backlog pane fetches on its own, separately from the sprint's own tasks (see
    // PlanningView) — read its count only once that request has landed, or backlogCountBefore
    // below can catch it mid-"Loading…" and read zero.
    await expect(backlog.getByText("Loading…")).toHaveCount(0);
  });

  const backlogCountBefore = await cardsIn(backlog).count();

  await dragCardToPane(page, sprintCard, backlog);

  await test.step("the backlog pane gains it and the sprint pane loses it, keeping the done one", async () => {
    await expect(cardsIn(sprint)).toHaveCount(1);
    await expect(sprint).toContainText(PLANNING_SPRINT_DONE_TASK_TITLE);
    await expect(sprint.locator(`a[href="${cardHref(PLANNING_SPRINT_TASK_NUMBER)}"]`)).toHaveCount(0);
    await expect(cardsIn(backlog)).toHaveCount(backlogCountBefore + 1);
    await expect(backlog.locator(`a[href="${cardHref(PLANNING_SPRINT_TASK_NUMBER)}"]`)).toBeVisible();
  });

  await test.step("the header's total follows; the one done task is still the only one done", async () => {
    await expect(sprintProgress(page)).toHaveText("1/1");
  });

  await test.step("the task really moved on the server, not just on screen", async () => {
    const task = await readTask(request, PLANNING_SPRINT_TASK_NUMBER);
    expect(task._id).toBe(String(PLANNING_SPRINT_TASK_ID));
    expect(task.sprint).toBeNull();
  });
});
