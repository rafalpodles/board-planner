import { test, expect, type Page } from "@playwright/test";
import { PROJECT_KEY, DECOY_TASK_NUMBER, SIBLING_TASK_NUMBER, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-522. On a project board, Escape closed nothing: not the keyboard-shortcuts help, not the
 * New Task modal, not a confirm dialog, not the card's context menu.
 *
 * The board's own keydown listener is registered at mount and so runs first, and its Escape
 * branch always writes selection state. React gives that discrete priority and renders in a
 * microtask, and a microtask checkpoint runs between two listeners of one *real* dispatch — so
 * the dialog's effect, which depended on the caller's inline `onClose`, tore its listener down
 * and re-added it mid-dispatch. A listener added during a dispatch is not invoked for that
 * event, so the dialog's handler never saw the key that was meant for it.
 *
 * Two consequences for how this is tested:
 *
 * - Every press here is a real one through `page.keyboard`. A synthetic `dispatchEvent` gets no
 *   microtask checkpoint between listeners, so it closes the dialog even against the bug.
 * - The board polls its tasks every 10 s (`use-project-board.ts:172`), and that response feeds
 *   `filteredTasks`, a dep of the board's keydown effect. On that commit both listeners
 *   resubscribe, children first — which puts the dialog's listener *ahead* of the board's and
 *   makes the bug momentarily invisible. `freezeBoardPolling` holds the poll open so the
 *   ordering the bug needs is the ordering the test gets.
 */

test.beforeEach(seed);

const help = (page: Page) => page.getByRole("heading", { name: "Keyboard Shortcuts" });

const newTask = (page: Page) => page.getByRole("dialog", { name: "New Task" });

const cardFor = (page: Page, taskNumber: number) =>
  page.locator(`a[href="/projects/${PROJECT_KEY}/tasks/${taskNumber}"]`);

const card = (page: Page) => cardFor(page, DECOY_TASK_NUMBER);

const contextMenu = (page: Page) => page.getByRole("button", { name: "Duplicate", exact: true });

const selectBox = (page: Page) =>
  page.getByRole("button", { name: `Select ${PROJECT_KEY}-${DECOY_TASK_NUMBER}` });

/** Leaves the poll's request hanging, so no later response can re-order the two listeners. */
async function freezeBoardPolling(page: Page) {
  await page.route(
    (url) => /\/api\/projects\/[^/]+\/tasks(\?|$)/.test(url.pathname + url.search),
    () => {}
  );
}

async function openBoard(page: Page) {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(card(page)).toBeVisible();
  await freezeBoardPolling(page);
}

test("Escape closes the keyboard-shortcuts help", async ({ page }) => {
  await openBoard(page);

  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(help(page)).toBeHidden();
});

test("Escape closes the New Task modal", async ({ page }) => {
  await openBoard(page);

  await page.keyboard.press("n");
  await expect(newTask(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(newTask(page)).toBeHidden();
});

test("the board's own ? toggle still closes the help — the control for the press that worked", async ({
  page,
}) => {
  await openBoard(page);

  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();

  // Closed by the board's toggle, not by the help's own `?` branch: this control says the board's
  // handler is still reached, which is what the fix must not have broken
  await page.keyboard.press("?");
  await expect(help(page)).toBeHidden();
});

test("Escape still clears a card selection when no dialog is open", async ({ page }) => {
  await openBoard(page);

  await card(page).click({ modifiers: ["Shift"] });
  await expect(selectBox(page)).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press("Escape");
  // The board is still on screen — the checkbox unmounting is the selection clearing, not a
  // navigation away
  await expect(card(page)).toBeVisible();
  await expect(selectBox(page)).toBeHidden();
});

test("Escape closes the card's context menu", async ({ page }) => {
  await openBoard(page);

  await card(page).click({ button: "right" });
  await expect(contextMenu(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(contextMenu(page)).toBeHidden();
});

test("Escape closes the bulk-delete confirm rather than emptying the selection under it", async ({
  page,
}) => {
  await openBoard(page);

  await card(page).click({ modifiers: ["Shift"] });
  await cardFor(page, SIBLING_TASK_NUMBER).click({ modifiers: ["Shift"] });
  await card(page).click({ button: "right" });
  await page.getByRole("button", { name: /^Delete 2 tasks/ }).click();

  const confirm = page.getByRole("dialog", { name: "Delete Selected Tasks" });
  await expect(confirm).toBeVisible();

  // Before the fix Escape reached the board and not the dialog, so the dialog stayed open over an
  // emptied selection and relabelled itself "delete 0 tasks" — confirming then deleted nothing
  // and said it had succeeded
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(page.getByText("0 tasks")).toHaveCount(0);
});

/**
 * The order-flip case, and the one test here that must NOT freeze the poll.
 *
 * A poll response re-runs both keydown effects, children first, which registers the dialog's
 * listener ahead of the board's. `?` is a toggle on the board's side, so a second listener acting
 * on the same press used to close the help and let the board's toggle reopen it. The help no
 * longer handles `?` at all; the board owns that key.
 */
test("? still closes the help after a poll has reordered the listeners", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(card(page)).toBeVisible();

  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();

  await page.waitForResponse(
    (r) => /\/api\/projects\/[^/]+\/tasks(\?|$)/.test(new URL(r.url()).pathname + new URL(r.url()).search) && r.ok(),
    { timeout: 30_000 },
  );

  await page.keyboard.press("?");
  await expect(help(page)).toBeHidden();
});
