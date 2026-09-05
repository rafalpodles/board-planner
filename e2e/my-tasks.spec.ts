import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  MINE_ACTIVE_NUMBER,
  MINE_ACTIVE_TITLE,
  MINE_APPROVED_NUMBER,
  MINE_BLOCKED_NUMBER,
  MINE_BLOCKED_TITLE,
  MINE_CUSTOM_COLUMN,
  MINE_DONE_NUMBER,
  MINE_DONE_TITLE,
  MINE_ONLY_DONE_TITLE,
  MINE_ORPHAN_NUMBER,
  MINE_ORPHAN_STATUS,
  MINE_ORPHAN_TITLE,
  MINE_OTHER_BOARD_NUMBER,
  MINE_OTHER_BOARD_TITLE,
  PROJECT_KEY,
  PROJECT_NAME,
  SECOND_PROJECT_KEY,
  SECOND_PROJECT_NAME,
  THEIRS_TITLE,
  THEIRS_UNREACHABLE_TITLE,
  seed,
  seedMyTasks,
  seedMyTasksAllDone,
  seedSecondProject,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-469: /my-tasks, the one screen that spans boards.
 *
 * Everything it does happens in the browser and nowhere else — grouping by project, ordering by
 * what a column *means* rather than what it is called, the Hide done filter and two empty states
 * that say different things. `column-roles.spec.ts` asserts the endpoint's half of the role
 * question and says so; this is the half that reaches a person.
 *
 * The fixture is built so each claim has something that could contradict it: a task in a column
 * this board invented (which a page keying on ids sorts last), a task in a column that no longer
 * exists (which resolves to no role, label or colour at all), somebody else's task on a board the
 * reader can reach, and the reader's own task on a board they cannot.
 */

test.beforeEach(seed);

/** Every task row on the page, in the order the DOM has them — which is the order on screen. */
function rows(page: Page): Locator {
  // Scoped to main: the sidebar links to every board this reader can reach, and half of these
  // selectors would match there too
  return page.locator('main a[href*="/tasks/"]');
}

/** The keys, e.g. ["TP-200", "IB-3"], top to bottom. */
async function keysOnScreen(page: Page): Promise<string[]> {
  return (await rows(page).evaluateAll((links) =>
    links.map((link) => (link as HTMLAnchorElement).getAttribute("href") ?? "")
  )).map((href) => {
    const [, , key, , number] = href.split("/");
    return `${key}-${number}`;
  });
}

const key = (projectKey: string, taskNumber: number) => `${projectKey}-${taskNumber}`;

function row(page: Page, projectKey: string, taskNumber: number): Locator {
  return page.locator(`main a[href="/projects/${projectKey}/tasks/${taskNumber}"]`);
}

/** The status chip. `.first()` because the priority badge beside it carries the same class. */
function statusChip(taskRow: Locator): Locator {
  return taskRow.locator("span.chip").first();
}

/** The value the chip's colour is mixed from, as the browser resolved it. */
function chipVariable(taskRow: Locator): Promise<string> {
  return statusChip(taskRow).evaluate((chip) =>
    getComputedStyle(chip).getPropertyValue("--chip").trim()
  );
}

async function openMyTasks(page: Page, who: "admin" | "member" = "admin") {
  await signIn(page, who);
  await page.goto("/my-tasks");
  await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible();
}

test.describe("a list of my work, across boards", () => {
  test.beforeEach(async () => {
    await seedSecondProject();
    await seedMyTasks();
  });

  test("orders by what a column means, and groups by board", async ({ page }) => {
    await openMyTasks(page);

    // Done is hidden by default, so five of the six rows assigned to this reader
    await expect(page.getByText("5 tasks", { exact: true })).toBeVisible();

    await expect(keysOnScreen(page)).resolves.toEqual([
      // active, then the board's own blocked column, then approved, then the column that is gone
      key(PROJECT_KEY, MINE_ACTIVE_NUMBER),
      key(PROJECT_KEY, MINE_BLOCKED_NUMBER),
      key(PROJECT_KEY, MINE_APPROVED_NUMBER),
      key(PROJECT_KEY, MINE_ORPHAN_NUMBER),
      key(SECOND_PROJECT_KEY, MINE_OTHER_BOARD_NUMBER),
    ]);

    await test.step("each board is its own group, headed by a link to it", async () => {
      const headings = page.locator(`main a[href^="/projects/"]:not([href*="/tasks/"])`);
      await expect(headings).toHaveText([
        new RegExp(`${PROJECT_KEY}.*${PROJECT_NAME}`),
        new RegExp(`${SECOND_PROJECT_KEY}.*${SECOND_PROJECT_NAME}`),
      ]);
    });

    await test.step("somebody else's task is not mine, on either board", async () => {
      await expect(page.getByText(THEIRS_TITLE)).toHaveCount(0);
      await expect(page.getByText(THEIRS_UNREACHABLE_TITLE)).toHaveCount(0);
    });
  });

  test("Hide done takes the finished work off the list, and gives it back", async ({ page }) => {
    await openMyTasks(page);

    const hideDone = page.getByLabel("Hide done");
    await expect(hideDone).toBeChecked();
    await expect(page.getByText(MINE_DONE_TITLE)).toHaveCount(0);

    await hideDone.uncheck();
    // In its place by role — after approved, before the column that no longer exists
    await expect(keysOnScreen(page)).resolves.toEqual([
      key(PROJECT_KEY, MINE_ACTIVE_NUMBER),
      key(PROJECT_KEY, MINE_BLOCKED_NUMBER),
      key(PROJECT_KEY, MINE_APPROVED_NUMBER),
      key(PROJECT_KEY, MINE_DONE_NUMBER),
      key(PROJECT_KEY, MINE_ORPHAN_NUMBER),
      key(SECOND_PROJECT_KEY, MINE_OTHER_BOARD_NUMBER),
    ]);
    await expect(page.getByText("6 tasks", { exact: true })).toBeVisible();

    await hideDone.check();
    await expect(page.getByText(MINE_DONE_TITLE)).toHaveCount(0);
    await expect(page.getByText("5 tasks", { exact: true })).toBeVisible();
  });

  test("a status is the board's own label and colour, or the raw id when the column is gone", async ({
    page,
  }) => {
    await openMyTasks(page);

    const invented = row(page, PROJECT_KEY, MINE_BLOCKED_NUMBER);
    const orphaned = row(page, PROJECT_KEY, MINE_ORPHAN_NUMBER);

    await expect(statusChip(invented)).toHaveText(MINE_CUSTOM_COLUMN.label);
    await expect(chipVariable(invented)).resolves.toBe(MINE_CUSTOM_COLUMN.color);

    // No column to ask, so the id the task is stored with is all there is to show
    await expect(statusChip(orphaned)).toHaveText(MINE_ORPHAN_STATUS);
    const fallback = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--color-status-planned").trim()
    );
    await expect(chipVariable(orphaned)).resolves.toBe(fallback);

    // The control: the two chips are actually painted differently, which is the point of carrying
    // a colour per column at all
    const painted = await Promise.all(
      [invented, orphaned, row(page, PROJECT_KEY, MINE_ACTIVE_NUMBER)].map((taskRow) =>
        statusChip(taskRow).evaluate((chip) => getComputedStyle(chip).backgroundColor)
      )
    );
    expect(new Set(painted).size).toBe(3);
  });

  test("a row opens the task, and the group heading opens the board", async ({ page }) => {
    await openMyTasks(page);

    await row(page, SECOND_PROJECT_KEY, MINE_OTHER_BOARD_NUMBER).click();
    await expect(page).toHaveURL(
      `/projects/${SECOND_PROJECT_KEY}/tasks/${MINE_OTHER_BOARD_NUMBER}`
    );
    await expect(page.getByText(MINE_OTHER_BOARD_TITLE).first()).toBeVisible();

    await page.goBack();
    await page.locator(`main a[href="/projects/${PROJECT_KEY}"]`).click();
    await expect(page).toHaveURL(`/projects/${PROJECT_KEY}`);
    await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
  });

  test("a member sees their work on the board they hold, and not on the one they do not", async ({
    page,
  }) => {
    await openMyTasks(page, "member");

    await expect(page.getByText(THEIRS_TITLE)).toBeVisible();
    await expect(page.getByText(THEIRS_UNREACHABLE_TITLE)).toHaveCount(0);
    await expect(page.getByText("1 task", { exact: true })).toBeVisible();

    // Not a filter this page applies: the task they cannot see is not on the list they are sent
    const mine = await page.request.get("/api/tasks/mine");
    expect(mine.status()).toBe(200);
    expect(JSON.stringify(await mine.json())).not.toContain(THEIRS_UNREACHABLE_TITLE);

    // And it is theirs — the assignment is real, so what keeps it off the list is the board
    await expect(page.getByText(MINE_ACTIVE_TITLE)).toHaveCount(0);
  });
});

test("with nothing assigned, and with nothing left to do, the page says which", async ({ page }) => {
  await openMyTasks(page);
  await expect(page.getByText("No tasks assigned to you")).toBeVisible();

  await seedMyTasksAllDone();
  await page.reload();

  // A different sentence, and the one that would be wrong on an empty account
  await expect(page.getByText("All tasks are done!")).toBeVisible();
  await expect(page.getByText("No tasks assigned to you")).toHaveCount(0);

  await page.getByLabel("Hide done").uncheck();
  await expect(page.getByText(MINE_ONLY_DONE_TITLE)).toBeVisible();
  await expect(page.getByText("1 task", { exact: true })).toBeVisible();
});
