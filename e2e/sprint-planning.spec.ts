import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  PLANNING_BACKLOG_TASK_ID,
  PLANNING_BACKLOG_TASK_NUMBER,
  PLANNING_BACKLOG_TASK_TITLE,
  PLANNING_SPRINT_DONE_TASK_TITLE,
  PLANNING_SECOND_SPRINT_ID,
  PLANNING_SECOND_SPRINT_NAME,
  PLANNING_SPRINT_ID,
  PLANNING_SPRINT_TASK_ID,
  PLANNING_SPRINT_TASK_NUMBER,
  PLANNING_SPRINT_TASK_TITLE,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  seed,
  seedSecondPlanningSprint,
  seedSprintPlanning,
  storedTaskSprint,
} from "./seed";
import { dragTo } from "./drag";
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
 * BP-475. This used to dispatch `dragstart`/`dragover`/`drop` by hand, above a docblock claiming
 * that "Chromium runs a native drag on the OS, so Playwright's mouse produces no dragstart/drop"
 * and pointing at `run-conflict.spec.ts` for the fuller explanation. That spec has since been
 * corrected and now says the opposite — the claim is measurably untrue (BP-493, `e2e/drag.ts`) —
 * so the cross-reference had inverted and this was the last spec still dispatching its own events.
 *
 * What the hand-dispatched version could not tell you is whether a person's drag reaches the pane
 * at all: it called the handlers directly, so it would have stayed green with the drop target
 * unreachable, mis-positioned, or covered by something else. `dragTo` drives the mouse and lets
 * the browser produce the chain.
 *
 * Unlike the board's columns, a planning pane has no insertion marker to prove the dragover was
 * seen — its `onDragOver` only calls `preventDefault`, with no visible feedback. So the outcome is
 * what is checked, by the caller, in two independent places (the two panes' counts, and the
 * server's own copy of the task).
 */
async function dragCardToPane(page: Page, card: Locator, pane: Locator) {
  await dragTo(page, card, pane);
}

/**
 * BP-594. The reported failure was a card count — five backlog rows where four were expected —
 * and that is the same picture whether the drop found no handler, resolved no task, or the server
 * refused the move and the page put the card back. The move is a single PUT, so watching for it
 * tells "nothing was written" apart from "the write was refused", and leaves the counts below
 * with only the case where the write itself was fine.
 */
async function dragAndWatchTheWrite(page: Page, card: Locator, pane: Locator, taskId: string) {
  const write = page
    .waitForResponse(
      (res) => res.request().method() === "PUT" && res.url().endsWith(`/tasks/${taskId}`),
      { timeout: 30_000 }
    )
    .catch(() => null);

  await dragCardToPane(page, card, pane);

  const response = await write;
  expect(
    response,
    "no write reached the server in 30s: the drop found no handler, or no task for the dragged id, or the move was merely slow"
  ).not.toBeNull();
  expect(response!.status(), "the server refused the move").toBe(200);
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

  await dragAndWatchTheWrite(page, backlogCard, sprint, String(PLANNING_BACKLOG_TASK_ID));

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

  await dragAndWatchTheWrite(page, sprintCard, backlog, String(PLANNING_SPRINT_TASK_ID));

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

// next dev runs the backlog fetch twice; the late answer used to replace the list after the drop.
// This pins that the superseded answer is ignored; replaying a drop made mid-fetch is unit-tested
test("a superseded backlog answer that lands late does not undo a drop", async ({ page }) => {
  let backlogRequests = 0;
  await page.route(/\/tasks\?sprint=backlog/, async (route) => {
    const response = await route.fetch();
    if (++backlogRequests === 2) await new Promise((resolve) => setTimeout(resolve, 4000));
    await route.fulfill({ response });
  });

  await signIn(page);
  await page.goto(planningUrl);

  const backlog = backlogPane(page);
  const sprint = sprintPane(page);
  await expect(cardsIn(sprint)).toHaveCount(2);
  await expect(backlog.getByText("Loading…")).toHaveCount(0);
  const backlogCountBefore = await cardsIn(backlog).count();

  const sprintCard = sprint.locator(`a[href="${cardHref(PLANNING_SPRINT_TASK_NUMBER)}"]`);
  await dragAndWatchTheWrite(page, sprintCard, backlog, String(PLANNING_SPRINT_TASK_ID));

  await expect(cardsIn(backlog)).toHaveCount(backlogCountBefore + 1);
  await page.waitForTimeout(4500);
  await expect(cardsIn(backlog)).toHaveCount(backlogCountBefore + 1);
  expect(backlogRequests).toBe(2);
});

/**
 * BP-475. The drags above all land; none of them showed that a drop which is *supposed* to go
 * nowhere does. Without that, a helper that quietly did nothing — aimed off-target, blocked by an
 * overlay, releasing outside the window — would look exactly like this file passing.
 *
 * Two refusals are driven, and the second is here because a reviewer disproved my first answer.
 * I stalled the incoming fetch on a cold load, found no pane to aim at, and wrote that the
 * product's own refusal was unreachable — "measured". It was measured on one path only:
 * `sprints/page.tsx` latches `initialLoadDone` on the first load and never resets it, as its own
 * comment says, so **switching** sprints leaves the planning view on screen with the new sprint's
 * pane in its loading state, which is exactly when `PlanningView` withholds `onDropTask`.
 */
test("a drop outside either pane moves nothing", async ({ page }) => {
  await signIn(page);
  await page.goto(planningUrl);

  const backlog = backlogPane(page);
  const sprint = sprintPane(page);
  // Waited on by identity rather than by a count: the panes fill in over two fetches, and a count
  // read between them is a number that was never true for long
  const inBacklog = backlog.locator(`a[href="${cardHref(PLANNING_BACKLOG_TASK_NUMBER)}"]`);
  const inSprint = sprint.locator(`a[href="${cardHref(PLANNING_BACKLOG_TASK_NUMBER)}"]`);
  await expect(inBacklog).toBeVisible();

  const notADroppable = page.getByTestId("sprint-name");
  const written = page
    .waitForResponse(
      (res) => res.request().method() === "PUT" && res.url().includes(`/tasks/${PLANNING_BACKLOG_TASK_ID}`),
      { timeout: 2_000 }
    )
    .then(() => "written")
    .catch(() => "nothing written");
  await dragTo(page, inBacklog, notADroppable);

  expect(await written).toBe("nothing written");
  await expect(inBacklog).toBeVisible();
  await expect(inSprint).toHaveCount(0);
  expect(await storedTaskSprint(PLANNING_BACKLOG_TASK_NUMBER)).toBeNull();

  // The control: the same card, the same gesture, aimed at a pane that does take it
  await dragAndWatchTheWrite(page, inBacklog, sprint, String(PLANNING_BACKLOG_TASK_ID));
  await expect(inSprint).toBeVisible();
  await expect(inBacklog).toHaveCount(0);
});

/**
 * The product's own refusal, reached the way a person reaches it: by switching sprints while the
 * next one's tasks are still on the way. `PlanningView` passes `onDropTask` to the sprint pane
 * only once `tasksLoaded`, and without an `onDragOver` to call `preventDefault` the browser emits
 * no `drop` at all — so this asserts a refusal the product means, not merely a gesture that missed.
 */
test("a sprint pane still loading its tasks refuses the drop, and takes it once they land", async ({
  page,
}) => {
  await seedSecondPlanningSprint();

  // Only the first answer is held. The board polls, and a handler that kept stalling would still
  // be holding a request when the test ends — which Playwright reports as an error on a passing
  // run and reads like a product fault.
  let release: () => void = () => {};
  let held = false;
  let stalls = 0;
  const stalled = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) =>
      /\/tasks$/.test(url.pathname) &&
      url.searchParams.get("sprint") === String(PLANNING_SECOND_SPRINT_ID),
    async (route) => {
      if (held) return route.fallback();
      held = true;
      stalls += 1;
      const response = await route.fetch();
      await stalled;
      await route.fulfill({ response });
    }
  );

  await signIn(page);
  await page.goto(planningUrl);
  const backlog = backlogPane(page);
  const sprint = sprintPane(page);
  await expect(backlog.getByText("Loading…")).toHaveCount(0);

  // The switch, not a fresh load: the page has already latched `initialLoadDone`, so the planning
  // view stays on screen and the incoming pane shows its own loading state
  await page
    .getByRole("navigation", { name: "Sprint list" })
    .getByRole("button", { name: new RegExp(`^${PLANNING_SECOND_SPRINT_NAME}\\b`) })
    .click();
  await expect(sprint.getByText("Loading…")).toBeVisible();
  // The stub was actually hit. A matcher that never matches — comparing an ObjectId to a string is
  // the easy way to write one — leaves the fetch untouched, the pane loads instantly, and this
  // test goes green having asserted a refusal that never happened. A reviewer lost a measurement
  // to exactly that.
  expect(stalls).toBe(1);

  const card = backlog.locator(`a[href="${cardHref(PLANNING_BACKLOG_TASK_NUMBER)}"]`);
  await expect(card).toBeVisible();
  const written = page
    .waitForResponse(
      (res) => res.request().method() === "PUT" && res.url().includes(`/tasks/${PLANNING_BACKLOG_TASK_ID}`),
      { timeout: 2_000 }
    )
    .then(() => "written")
    .catch(() => "nothing written");
  await dragTo(page, card, sprint);

  expect(await written).toBe("nothing written");
  expect(await storedTaskSprint(PLANNING_BACKLOG_TASK_NUMBER)).toBeNull();

  // The control: the same card, the same pane, the same gesture, once its tasks have landed
  release();
  await expect(sprint.getByText("Loading…")).toHaveCount(0);
  await dragAndWatchTheWrite(page, card, sprint, String(PLANNING_BACKLOG_TASK_ID));
  expect(await storedTaskSprint(PLANNING_BACKLOG_TASK_NUMBER)).toBe(String(PLANNING_SECOND_SPRINT_ID));
});
