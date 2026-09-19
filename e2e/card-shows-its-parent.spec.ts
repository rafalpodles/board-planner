import { test, expect, type APIRequestContext } from "@playwright/test";
import { ADMIN_AUTH, SAME_ORIGIN } from "./api";
import {
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
 * A `parent_of` link is stored on the **parent's** document, so a child's own record says nothing
 * about it. The board's list route did not compute the reverse lookup the detail route does, which
 * is why a card could show Blocked and Relates but never the epic it belongs to.
 *
 * The parent is named rather than counted: "Parent (1)" would be true of every child and useful to
 * nobody. So the assertion is on the key, on the child's card, on the board.
 */

test.beforeEach(seed);

const boardUrl = `/projects/${PROJECT_KEY}`;
const cardFor = (taskNumber: number) =>
  `a[href="/projects/${PROJECT_KEY}/tasks/${taskNumber}"]`;

async function makeParent(request: APIRequestContext, parentId: string, childId: string) {
  const response = await request.post(
    `/api/projects/${PROJECT_ID}/tasks/${parentId}/links`,
    { headers: { ...ADMIN_AUTH, ...SAME_ORIGIN }, data: { taskId: childId, type: "parent_of" } }
  );
  expect(response.status(), await response.text()).toBe(200);
}

test("a child's card names its parent, and the parent's own card does not", async ({
  page,
  request,
}) => {
  await makeParent(request, HELD_TASK_ID.toString(), SIBLING_TASK_ID.toString());

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

test("a board with no parent anywhere says nothing about one", async ({ page }) => {
  await signIn(page);
  await page.goto(boardUrl);

  // The positive first: a card only a loaded board has
  await expect(page.locator(cardFor(SIBLING_TASK_NUMBER))).toBeVisible();
  await expect(page.getByText(/^Parent /)).toHaveCount(0);
});
