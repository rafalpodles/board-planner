import { test, expect, type Page } from "@playwright/test";
import {
  HELD_TASK_TITLE,
  OTHER_HIT_KEY,
  OTHER_HIT_NUMBER,
  OTHER_HIT_TITLE,
  OTHER_PROJECT_KEY,
  OTHER_PROJECT_NAME,
  PROJECT_KEY,
  SIBLING_TASK_TITLE,
  seed,
  seedSearchCorpus,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-540. The intercepting modal lives under `projects/[projectId]`, and takes its project from
 * `useParams()` — which resolves against the layout still mounted for the project the reader came
 * from, while the task id follows the new URL. Pick another board's task out of ⌘K and the two
 * halves of the identity disagree: the address says one task, the screen draws another.
 *
 * The control is a hit on *this* board, which must still open as the modal it always did.
 */

const taskDialog = (page: Page) =>
  page.getByRole("dialog").filter({ has: page.getByLabel("Task title") });

async function pickFromSearch(page: Page, title: string) {
  await page.keyboard.press("ControlOrMeta+k");
  const layer = page.getByRole("dialog", { name: "Search" });
  await layer.getByLabel("Search tasks and projects").fill(title);
  await layer.getByText(title).first().click();
}

test.beforeEach(async ({ page }) => {
  await seed();
  await seedSearchCorpus();
  await signIn(page);
});

test("a hit on another board opens that board's task, not this board's", async ({ page }) => {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByText(SIBLING_TASK_TITLE).first()).toBeVisible();

  await pickFromSearch(page, OTHER_HIT_TITLE);

  await expect(page).toHaveURL(
    new RegExp(`/projects/${OTHER_PROJECT_KEY}/tasks/${OTHER_HIT_NUMBER}$`)
  );
  // First, because this is the line the navigation layer has to earn: as its own page, not an
  // overlay on the board being left. Left further down it never fires — the modal's own guard
  // draws the right task, but TP's board stays underneath with TP-1's card on it, so the title
  // assertions below go red first and say nothing about which layer failed.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Task title")).toHaveValue(OTHER_HIT_TITLE);
  await expect(page.getByText(HELD_TASK_TITLE)).toHaveCount(0);
  await expect(page.getByText(OTHER_HIT_KEY).first()).toBeVisible();
});

test("a hit on this board still opens as the modal it always did", async ({ page }) => {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByText(SIBLING_TASK_TITLE).first()).toBeVisible();

  await pickFromSearch(page, HELD_TASK_TITLE);

  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/tasks/1$`));
  await expect(taskDialog(page).getByLabel("Task title")).toHaveValue(HELD_TASK_TITLE);
  await expect(taskDialog(page)).toHaveCount(1);
});

/**
 * BP-567. Since BP-560 the palette refused to open over any layer, which withheld the most useful
 * ⌘K there was: from the task modal, straight to another task. It replaces the modal now instead
 * of stacking on it — and a *project* hit is the case BP-521 made a bug, because Next keeps an
 * unmatched `@modal` slot's active subpage across a soft navigation and the closed task reappeared
 * over whatever arrived.
 */
test("⌘K from the task modal replaces it, and a project hit leaves nothing parked", async ({
  page,
}) => {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByText(SIBLING_TASK_TITLE).first().click();
  await expect(taskDialog(page)).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");

  // Replaced: the palette is up and the task modal is not underneath it
  const layer = page.getByRole("dialog", { name: "Search" });
  await expect(layer).toBeVisible();
  await expect(taskDialog(page)).toHaveCount(0);

  await layer.getByLabel("Search tasks and projects").fill(OTHER_PROJECT_KEY);
  await layer.getByText(OTHER_PROJECT_NAME).first().click();

  await expect(page).toHaveURL(new RegExp(`/projects/${OTHER_PROJECT_KEY}$`));
  // The BP-521 shape: a task modal parked over the board that arrived
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Task title")).toHaveCount(0);
});

test("⌘K from the task modal still swaps to a task on the same board", async ({ page }) => {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByText(SIBLING_TASK_TITLE).first().click();
  await expect(taskDialog(page)).toBeVisible();

  await pickFromSearch(page, HELD_TASK_TITLE);

  // Back to a modal over this board, which is what it was before BP-560 withheld it
  await expect(taskDialog(page)).toBeVisible();
  await expect(page.getByLabel("Task title")).toHaveValue(HELD_TASK_TITLE);
});

/**
 * The task modal closes with `router.back()`, so it unmounts on `popstate` — after the palette has
 * mounted and focused itself. An unconditional focus restore in the layer's teardown then pulled
 * the caret back to the card that opened it, out of an open palette (BP-567 review).
 *
 * Typed with `keyboard.type`, deliberately: `fill()` focuses the field itself and would hide
 * exactly this. And read after the modal has gone, because that is when the teardown runs.
 */
test("⌘K from the task modal keeps the caret, even though the modal closes late", async ({
  page,
}) => {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByText(SIBLING_TASK_TITLE).first().click();
  await expect(taskDialog(page)).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  const field = page.getByRole("dialog", { name: "Search" }).getByLabel("Search tasks and projects");
  await expect(field).toBeVisible();

  // The modal's own teardown has to have run by now, which is what makes this the moment to look
  await expect(taskDialog(page)).toHaveCount(0);
  await expect(field, "the caret is still in the palette").toBeFocused();

  await page.keyboard.type(HELD_TASK_TITLE);
  await expect(field, "and what was typed reached it").toHaveValue(HELD_TASK_TITLE);
});

/**
 * Layers nest: a confirm opened from the task modal is two of them. Closing only the topmost left
 * the palette stacked on the parent — the state BP-560 exists to prevent — so the walk takes the
 * whole stack (BP-567 review).
 */
test("⌘K from a confirm inside the task modal clears both layers", async ({ page }) => {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByText(SIBLING_TASK_TITLE).first().click();
  await expect(taskDialog(page)).toBeVisible();

  const rail = page.getByRole("button", { name: /^Delete task$/ });
  if (await rail.count()) await rail.click();
  else {
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("option", { name: "Delete task" }).click();
  }
  await expect(page.getByRole("dialog", { name: /Delete/i })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");

  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  // One dialog on the page, and it is the palette: neither the confirm nor the task under it
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(taskDialog(page)).toHaveCount(0);
});

/**
 * Closing the palette that replaced a modal. Its own trigger was the modal's node, which has gone
 * with it, so without the hand-over the focus lands on `<body>` and Tab restarts at the top of the
 * document — a path that did not exist before ⌘K could replace a layer (BP-567 review).
 */
test("Escape out of a palette that replaced a task returns the focus to the card", async ({
  page,
}) => {
  await page.goto(`/projects/${PROJECT_KEY}`);
  const card = page.getByText(SIBLING_TASK_TITLE).first();
  await card.click();
  await expect(taskDialog(page)).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  await expect(taskDialog(page)).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Search" })).toHaveCount(0);

  const landed = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return "nothing";
    return el.textContent?.trim().slice(0, 40) ?? el.tagName;
  });
  expect(landed, "the focus is somewhere a keyboard can carry on from").not.toBe("nothing");
  expect(landed).toContain(SIBLING_TASK_TITLE);
});
