import { test, expect, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import {
  ESTIMATE_DONE_NUMERIC_TASK_ID,
  ESTIMATE_FIELD_ID,
  ESTIMATE_OPEN_STRING_TASK_ID,
  ESTIMATE_SPRINT_ID,
  ESTIMATE_SPRINT_NAME,
  PROJECT_ID,
  PROJECT_KEY,
  demoteDoneColumn,
  seed,
  seedSprintEstimates,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-208 Task 11. GET /sprints is on the board's poll path (page.tsx), so its estimate
 * accumulators have to survive real documents, not just a mocked Task.aggregate — a unit test
 * mocking that call only proves the pipeline's shape, never what MongoDB does with a string in
 * $convert. This is the one place that question gets a real database to answer it. The first
 * test asks the API; the rest drive the sprint header and the planning pane that render the same
 * numbers (BP-701).
 */

test.beforeEach(async () => {
  await seed();
  await seedSprintEstimates();
});

test("sums a real number and a value the inline editor stored as a string, and treats an unconvertible legacy value and an absent one as zero", async ({
  request,
}) => {
  const response = await request.get(`/api/projects/${PROJECT_ID}/sprints`, {
    headers: ADMIN_AUTH,
  });

  // The request succeeding at all is the point: a $convert with no onError throws on "TBD" and
  // takes the whole poll down with it, not just this one sprint's numbers.
  expect(response.status(), await response.text()).toBe(200);

  const sprints = await response.json();
  const sprint = sprints.find((s: { _id: string }) => s._id === String(ESTIMATE_SPRINT_ID));

  expect(sprint.taskCount).toBe(4);
  expect(sprint.doneCount).toBe(2);
  // 5 (a genuine number) + 3 (parsed from the string "3") + 0 ("TBD" can't convert) + 0 (no
  // value at all). A bare $sum would have ignored the string "3" instead of parsing it, landing
  // on 5 rather than 8 — the exact silently-wrong-looking-right number this task exists to avoid.
  expect(sprint.estimateTotal).toBe(8);
  // Only the two done-role tasks count here: the 5, and the "TBD" one, which still contributes 0.
  expect(sprint.estimateDone).toBe(5);
});

/**
 * BP-701. The seeded sprint reads 5 of 8 points done: 5 finished, 3 (stored as the string "3")
 * still open, "TBD" finished but worth nothing, and one task never estimated. Moving the "3" to
 * Done on the board is what turns it into 8 of 8, so the second number is the screen's own
 * arithmetic after a real move, not a fixture echoed back.
 */
const SPRINT_URL = `/projects/${PROJECT_KEY}/sprints?sprint=${ESTIMATE_SPRINT_ID}`;

const estimateProgress = (page: Page) => page.getByTestId("sprint-estimate-progress");
const sprintPane = (page: Page) => page.getByTestId("planning-pane-sprint");
// The pane's own heading, not the task titles inside it, which are headings too
const sprintPaneHeading = (page: Page) => sprintPane(page).locator(":scope > h3");
const card = (page: Page, taskNumber: number) =>
  page.locator(`a[href="/projects/${PROJECT_KEY}/tasks/${taskNumber}"]`);

test("the sprint header reads the points done out of the points planned, and a move to Done adds to it", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(SPRINT_URL);

  await expect(page.getByTestId("sprint-name")).toHaveText(ESTIMATE_SPRINT_NAME);
  await expect(page.getByTestId("sprint-progress")).toHaveText("2/4");
  await expect(estimateProgress(page)).toHaveText("5/8 Points");

  const moved = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      r.url().endsWith(`/tasks/${ESTIMATE_OPEN_STRING_TASK_ID}/status`)
  );
  await card(page, 102).click({ button: "right" });
  const menu = page.getByTestId("task-context-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("button", { name: "Done", exact: true }).click();
  expect((await moved).status()).toBe(200);

  // Inside a second of the answer, so the board's ten-second poll cannot be what satisfied it
  await expect(page.getByTestId("sprint-progress")).toHaveText("3/4", { timeout: 1_000 });
  await expect(estimateProgress(page)).toHaveText("8/8 Points", { timeout: 1_000 });
});

test("the planning pane heads the sprint with its points, and moving tasks in and out moves them", async ({
  page,
  request,
}) => {
  const backlogTitle = "Estimated in the backlog";
  const created = await request.post(`/api/projects/${PROJECT_ID}/tasks`, {
    headers: ADMIN_AUTH,
    data: { title: backlogTitle, customFieldValues: { [String(ESTIMATE_FIELD_ID)]: 2 } },
  });
  expect(created.status(), await created.text()).toBe(201);
  const backlogTaskId = (await created.json())._id as string;

  await signIn(page);
  await page.goto(`${SPRINT_URL}&view=planning`);

  const heading = sprintPaneHeading(page);
  await expect(heading).toHaveText(`${ESTIMATE_SPRINT_NAME} (4) · 8 Points`);
  await expect(estimateProgress(page)).toHaveText("5/8 Points");

  // The board re-reads its tasks and sprints after each move, and those answers would carry the
  // new totals too. Held, they leave the planning view's own list as the only source — which is
  // the one place a task pulled in from the backlog exists until the board catches up.
  await page.route(
    (url) => /\/(sprints|tasks)$/.test(url.pathname),
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await new Promise(() => {});
    }
  );
  const sprintWrite = (taskId: string) =>
    page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().endsWith(`/tasks/${taskId}`)
    );

  const added = sprintWrite(backlogTaskId);
  await page
    .getByTestId("planning-pane-backlog")
    .getByRole("button", { name: `Add ${backlogTitle} to the sprint` })
    .click();
  expect((await added).status()).toBe(200);
  await expect(heading).toHaveText(`${ESTIMATE_SPRINT_NAME} (5) · 10 Points`, { timeout: 1_000 });
  await expect(estimateProgress(page)).toHaveText("5/10 Points", { timeout: 1_000 });

  const removed = sprintWrite(String(ESTIMATE_DONE_NUMERIC_TASK_ID));
  await sprintPane(page)
    .getByRole("button", { name: "Remove Estimated and done from the sprint" })
    .click();
  expect((await removed).status()).toBe(200);
  await expect(heading).toHaveText(`${ESTIMATE_SPRINT_NAME} (4) · 5 Points`, { timeout: 1_000 });
  // What is left done is the "TBD" task, worth nothing — not 5 carried over from the one removed
  await expect(estimateProgress(page)).toHaveText("0/5 Points", { timeout: 1_000 });
});

test("on a board with no Done column the header gives no points-done figure", async ({ page }) => {
  await demoteDoneColumn();
  await signIn(page);
  await page.goto(SPRINT_URL);

  await expect(page.getByTestId("sprint-name")).toHaveText(ESTIMATE_SPRINT_NAME);
  await expect(page.getByTestId("sprint-progress-unmeasurable")).toBeVisible();
  await expect(estimateProgress(page)).toHaveCount(0);

  // The total does not depend on Done, so the planning pane still owes it
  await page.goto(`${SPRINT_URL}&view=planning`);
  await expect(sprintPaneHeading(page)).toHaveText(
    `${ESTIMATE_SPRINT_NAME} (4) · 8 Points`
  );
  await expect(estimateProgress(page)).toHaveCount(0);
});
