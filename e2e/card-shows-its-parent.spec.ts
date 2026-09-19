import { test, expect, type APIRequestContext } from "@playwright/test";
import { ADMIN_AUTH, SAME_ORIGIN } from "./api";
import {
  FINISHED_TASK_ID,
  PLANNING_BACKLOG_TASK_ID,
  PLANNING_BACKLOG_TASK_NUMBER,
  PLANNING_SPRINT_ID,
  PLANNING_SPRINT_TASK_ID,
  PLANNING_SPRINT_TASK_NUMBER,
  PLANNING_SPRINT_TASK_TITLE,
  seedSprintPlanning,
  FINISHED_TASK_NUMBER,
  HELD_TASK_ID,
  HELD_TASK_NUMBER,
  HELD_TASK_TITLE,
  PROJECT_ID,
  PROJECT_KEY,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  seed,
} from "./seed";
import { signIn } from "./session";

/**
 * A `parent_of` link is stored on the **parent's** document. The board derives the reverse side of
 * a relation in the browser, but only across the tasks it loaded — so on a sprint-scoped board an
 * epic left in the backlog is invisible to that derivation. The server resolves it over the whole
 * project instead, which is what these tests drive.
 *
 * The parent is named rather than counted: "Parent (1)" would be true of every child and useful to
 * nobody. So the assertion is on the key, on the child's card, on the board.
 */

test.beforeEach(seed);

const boardUrl = `/projects/${PROJECT_KEY}`;
const cardFor = (taskNumber: number) =>
  `a[href="/projects/${PROJECT_KEY}/tasks/${taskNumber}"]`;

async function link(
  request: APIRequestContext,
  fromId: string,
  toId: string,
  type: "parent_of" | "relates"
) {
  const response = await request.post(`/api/projects/${PROJECT_ID}/tasks/${fromId}/links`, {
    headers: { ...ADMIN_AUTH, ...SAME_ORIGIN },
    data: { taskId: toId, type },
  });
  expect(response.status(), await response.text()).toBe(200);
}

test("a child's card names its parent, and the parent's own card does not", async ({
  page,
  request,
}) => {
  await link(request, HELD_TASK_ID.toString(), SIBLING_TASK_ID.toString(), "parent_of");

  await signIn(page);
  await page.goto(boardUrl);

  const child = page.locator(cardFor(SIBLING_TASK_NUMBER));
  await expect(child).toBeVisible();
  await expect(child.getByText(`Parent ${PROJECT_KEY}-${HELD_TASK_NUMBER}`)).toBeVisible();

  // Hovering it gives the title, because a key alone does not say what the epic is
  await expect(child.getByTitle(`Parent: ${HELD_TASK_TITLE}`)).toBeVisible();

  // The control, and the direction: the link is the same one document, and it must not read as a
  // parent from the end that holds it
  const parent = page.locator(cardFor(HELD_TASK_NUMBER));
  await expect(parent).toBeVisible();
  await expect(parent.getByText(/^Parent /)).toHaveCount(0);
});

test("a parent's other relations do not become parents of their own", async ({ page, request }) => {
  // One parent carrying two entries: `parent_of` to the sibling, `relates` to the finished task.
  // `$elemMatch` selects the DOCUMENT, so this parent is fetched either way — what keeps the
  // second entry from reading as a parent is the per-entry type check, and this is the only
  // arrangement in which that check is load-bearing.
  await link(request, HELD_TASK_ID.toString(), SIBLING_TASK_ID.toString(), "parent_of");
  await link(request, HELD_TASK_ID.toString(), FINISHED_TASK_ID.toString(), "relates");

  await signIn(page);
  await page.goto(boardUrl);

  // The one that really is a child
  const child = page.locator(cardFor(SIBLING_TASK_NUMBER));
  await expect(child.getByText(`Parent ${PROJECT_KEY}-${HELD_TASK_NUMBER}`)).toBeVisible();

  // The one that is merely related. The positive first — the relation that WAS stored — so a board
  // that failed to load cannot satisfy the absence on its own.
  const related = page.locator(cardFor(FINISHED_TASK_NUMBER));
  await expect(related.getByText("Relates (1)")).toBeVisible();
  await expect(related.getByText(/^Parent /)).toHaveCount(0);
});

/**
 * The case the browser's own derivation cannot reach, and therefore the reason this lookup is on
 * the server at all: the board scoped to a sprint loads only that sprint's tasks, so an epic left
 * in the backlog is not among them and there is nothing to derive a parent from.
 *
 * Without the server lookup this test fails while every other one here still passes — which is
 * what stops the justification and the coverage from drifting apart.
 */
test("a child in a sprint names the epic that is not in it", async ({ page, request }) => {
  await seedSprintPlanning();
  await link(
    request,
    PLANNING_BACKLOG_TASK_ID.toString(),
    PLANNING_SPRINT_TASK_ID.toString(),
    "parent_of"
  );

  await signIn(page);
  await page.goto(`${boardUrl}?sprint=${PLANNING_SPRINT_ID}`);

  const child = page.locator(cardFor(PLANNING_SPRINT_TASK_NUMBER));
  await expect(child.getByText(PLANNING_SPRINT_TASK_TITLE)).toBeVisible();
  await expect(
    child.getByText(`Parent ${PROJECT_KEY}-${PLANNING_BACKLOG_TASK_NUMBER}`)
  ).toBeVisible();

  // The parent really is absent from this view — otherwise the browser could have derived it and
  // the test would prove nothing about the server
  await expect(page.locator(cardFor(PLANNING_BACKLOG_TASK_NUMBER))).toHaveCount(0);
});
