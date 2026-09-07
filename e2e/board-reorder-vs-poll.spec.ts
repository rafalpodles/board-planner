import { test, expect, type Page } from "@playwright/test";
import { PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-561. The board polls every ten seconds, so a read is very often in flight when somebody drags
 * a row. That read knows nothing about the drag; delivering its answer puts the old order back on
 * screen while the server keeps the new one, and the reader watches their own drop undo itself.
 *
 * BP-551 fixed the same shape in the sidebar and this is its recipe, moved to the board: hold the
 * read open, drag, then release it. Driven from the keyboard because dnd-kit's KeyboardSensor is
 * the only sensor that can be driven deterministically (BP-455).
 */

test.beforeEach(seed);

const BOARD = `/projects/${PROJECT_KEY}`;

/** dnd-kit's own announcements. `.last()` because an empty region is rendered before the first. */
const announced = (page: Page) =>
  page.locator('[id^="DndLiveRegion"]').filter({ hasText: /./ }).last();

const handles = (page: Page) => page.getByRole("button", { name: /^Reorder / });

/** The task keys the list shows, top to bottom */
async function rowOrder(page: Page): Promise<string[]> {
  return handles(page).evaluateAll((els) =>
    els.map((el) => el.getAttribute("aria-label")!.replace("Reorder ", ""))
  );
}

async function listView(page: Page) {
  await signIn(page);
  await toList(page);
}

/**
 * `v` toggles the view, and the reorder handles exist only in the list — and only under the manual
 * sort it opens with. Retried rather than pressed once: the key reaches a document listener React
 * has not attached yet if the press lands before hydration, and a swallowed keystroke looks exactly
 * like a view that has no list.
 */
async function toList(page: Page) {
  await page.goto(BOARD);
  await expect(page.getByRole("button", { name: /^Reorder /, includeHidden: true }).or(
    page.getByText(/To Do|Backlog|In Progress/).first()
  ).first()).toBeVisible();
  await expect(async () => {
    await page.locator("body").press("v");
    await expect(handles(page).first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect.poll(async () => (await rowOrder(page)).length).toBeGreaterThan(1);
}

/**
 * Lets the server answer the next `GET …/tasks` immediately — freezing the order it holds at that
 * moment — and hands that answer to the page only when the test releases it. `issued` resolves
 * once the server has answered, which is the moment a later drag is one the read cannot have seen.
 */
function holdNextTaskRead(page: Page) {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let answered = false;
  let taken = false;

  const arm = page.route(
    (url) => /\/api\/projects\/[^/]+\/tasks$/.test(url.pathname),
    async (route) => {
      if (taken || route.request().method() !== "GET") return route.fallback();
      taken = true;
      const response = await route.fetch();
      answered = true;
      await released;
      await route.fulfill({ response });
    }
  );

  return {
    arm,
    release: () => release(),
    issued: () =>
      expect
        .poll(() => answered, {
          message: "no GET …/tasks was issued — did the reload key stop reading?",
          timeout: 15_000,
        })
        .toBe(true),
  };
}

/**
 * dnd-kit announces the droppable's **id** — the task's `_id` — not the key the row is labelled
 * with, so the target is read out of the announcement rather than stated by the caller.
 */
async function overDroppable(page: Page): Promise<string | null> {
  const said = (await announced(page).textContent()) ?? "";
  return said.match(/over droppable area (\S+?)\.?$/)?.[1] ?? null;
}

async function dragFirstRowDown(page: Page) {
  await handles(page).first().focus();
  await page.keyboard.press("Space");
  await expect.poll(() => overDroppable(page)).not.toBeNull();
  const from = await overDroppable(page);

  // Retried, because an arrow can be swallowed while dnd-kit is between ticks — but only while the
  // announcement still names the starting row, since a press after one that landed walks past the
  // target and cannot be brought back from the bottom of the list
  await expect(async () => {
    if ((await overDroppable(page)) === from) await page.keyboard.press("ArrowDown");
    expect(await overDroppable(page)).not.toBe(from);
  }).toPass({ timeout: 20_000 });

  await page.keyboard.press("Space");
  await expect(announced(page)).toContainText(/was dropped/i);
}

test("a task read still in flight does not undo a reorder", async ({ page }) => {
  await listView(page);
  const before = await rowOrder(page);

  const read = holdNextTaskRead(page);
  await read.arm;
  // `r` is the board's reload, standing in for the poll that fires every ten seconds anyway
  await page.locator("body").press("r");
  await read.issued();

  const written = page.waitForResponse(
    (r) => r.url().includes("/tasks/reorder") && r.request().method() === "PUT" && r.ok()
  );
  await dragFirstRowDown(page);
  await written;

  const dropped = await rowOrder(page);
  expect(dropped[0], "the drag moved the row").toBe(before[1]);

  read.release();

  // Read once and soon: the board polls, so a retrying matcher would wait until a later read put
  // the right order back and pass for the wrong reason
  await page.waitForTimeout(1_000);
  expect(await rowOrder(page), "the stale read did not put the old order back").toEqual(dropped);

  // And the server agrees, which is what makes the screen right rather than merely stable
  await toList(page);
  expect(await rowOrder(page)).toEqual(dropped);
});

// The control: a read nothing overtook is the only way another person's work reaches this board
test("a task read that nothing overtook is still applied", async ({ page }) => {
  await listView(page);
  const before = await rowOrder(page);

  const read = holdNextTaskRead(page);
  await read.arm;
  await page.locator("body").press("r");
  await read.issued();
  read.release();

  await expect.poll(async () => rowOrder(page)).toEqual(before);
});
