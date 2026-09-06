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

const contextMenu = (page: Page) => page.getByTestId("task-context-menu");

const selectBox = (page: Page) =>
  page.getByRole("button", { name: `Select ${PROJECT_KEY}-${DECOY_TASK_NUMBER}` });

/**
 * Leaves the board's own reload hanging, so no later response can re-order the two listeners.
 * GET only: the same path is where a new task is POSTed, and test 2 opens that very form.
 */
async function freezeBoardPolling(page: Page) {
  await page.route(
    (url) => /\/api\/projects\/[^/]+\/tasks(\?|$)/.test(url.pathname + url.search),
    (route) => {
      if (route.request().method() !== "GET") return route.continue();
    }
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

test("Escape closes the bulk-delete confirm and leaves the selection it is about", async ({
  page,
}) => {
  await openBoard(page);

  await card(page).click({ modifiers: ["Shift"] });
  await cardFor(page, SIBLING_TASK_NUMBER).click({ modifiers: ["Shift"] });
  await card(page).click({ button: "right" });
  await page.getByRole("button", { name: /^Delete 2 tasks/ }).click();

  const confirm = page.getByRole("dialog", { name: "Delete Selected Tasks" });
  await expect(confirm).toBeVisible();

  // Escape used to reach the board and not the dialog, so the confirm stayed open over an emptied
  // selection, relabelled itself "delete 0 tasks", and confirming reported success having deleted
  // nothing. The dialog closes now — and the selection it was about is still there
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(selectBox(page)).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: `Select ${PROJECT_KEY}-${SIBLING_TASK_NUMBER}` })
  ).toHaveAttribute("aria-pressed", "true");
});

/**
 * The order-flip case, and the one test here that must NOT freeze the board's reload.
 *
 * A reload re-runs the board's keydown effect and so re-registers its listener *after* an open
 * dialog's. `?` is a toggle on the board's side, so a second listener acting on the same press
 * used to close the help and let the board's toggle reopen it. The help no longer handles `?` at
 * all; the board owns that key.
 *
 * The reorder is what this test is about, so it has to happen before the key is pressed — and it
 * is not observable in the DOM, because the reload fetches identical data and paints nothing new.
 * An earlier version waited two animation frames and so passed against the bug it names: React
 * commits through the scheduler, not through rAF, and the reload awaits three requests of which
 * this waited on one. Counting the board's own re-subscription is the signal itself, and turns a
 * setup that did not happen into a timeout rather than a false green.
 */
test("? still closes the help after a reload has reordered the listeners", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(card(page)).toBeVisible();

  await page.evaluate(() => {
    const w = window as unknown as { __keydownSubs: number };
    w.__keydownSubs = 0;
    const add = document.addEventListener.bind(document);
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === "keydown") w.__keydownSubs += 1;
      return (add as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof document.addEventListener;
  });

  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();

  // With the help open and its listener stable, the board's effect is the only thing left that
  // re-subscribes to keydown — so this count going up IS the reorder
  const before = await page.evaluate(
    () => (window as unknown as { __keydownSubs: number }).__keydownSubs
  );
  await page.keyboard.press("r");
  await page.waitForFunction(
    (n) => (window as unknown as { __keydownSubs: number }).__keydownSubs > n,
    before
  );

  await page.keyboard.press("?");
  await expect(help(page)).toBeHidden();
});

/**
 * BP-530. The same overlay, measured as an assistive technology and a keyboard see it.
 *
 * BP-522 fixed Escape and deliberately left the rest: the help hand-rolled its overlay instead of
 * going through `Modal`, so it had no `role="dialog"` and no accessible name, focus was never
 * moved into it and Tab walked out through the backdrop into the sidebar, the page behind stayed
 * scrollable, and — registering no focus-trap layer — it let the board's Escape branch run beside
 * its own and clear a card selection nobody had touched.
 *
 * Each of the four asserts one of those on its own. Only the first *gates* on `role="dialog"`;
 * the other three wait for the heading, which is on screen either way, so a run says which of the
 * four gaps is open rather than four times that the first one is. Their control is the `?` toggle
 * test above — routing the help through `Modal` must not cost the board the key it owns.
 */

const helpDialog = (page: Page) => page.getByRole("dialog", { name: "Keyboard Shortcuts" });

const activeElementIsInsideTheHelp = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    const dialog = document.querySelector('[role="dialog"]');
    return active !== null && dialog !== null && dialog.contains(active);
  });

const collapseSidebar = (page: Page) =>
  page.getByRole("button", { name: /(Collapse|Expand) sidebar/ });

test("the help announces as a dialog named after its heading", async ({ page }) => {
  await openBoard(page);

  await page.keyboard.press("?");
  // Measured: `[role="dialog"]` elements in the document — 0. A screen reader was told nothing
  // opened, and there was no name to announce if it had been
  await expect(helpDialog(page)).toBeVisible();
});

test("focus moves into the help and Tab never reaches the sidebar behind it", async ({ page }) => {
  await openBoard(page);

  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();
  // Measured at open: BODY. Focus was never moved into the overlay at all
  await expect.poll(() => activeElementIsInsideTheHelp(page)).toBe(true);

  // Measured: four presses walked out of the backdrop and into the sidebar's Collapse button.
  // Asserted as where focus *is* rather than as one place it is not — a `.not.toBe(thatButton)`
  // is satisfied by any of the several other elements Tab used to reach on the way there
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    await expect.poll(() => activeElementIsInsideTheHelp(page)).toBe(true);
  }

  // The control: that button is on the page and tabbable, so Tab staying put is the trap holding
  // rather than the target being gone
  await expect(collapseSidebar(page)).toBeVisible();
});

/**
 * Measured on the board before the help opens: `body` and `html` are both unscrollable there — the
 * shell scrolls inside its own containers — so `overflow: hidden` has nothing to stop on this
 * page and this asserts the lock, not movement. It is still the assertion worth having: the lock
 * is what holds on any surface where the body *is* the scrollport, and asserting both halves means
 * a pass is not the body having been unscrollable all along.
 */
test("the page behind the help does not scroll, and scrolls again once it closes", async ({
  page,
}) => {
  await openBoard(page);

  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("hidden");

  await page.keyboard.press("Escape");
  await expect(help(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("");
});

test("Escape closes the help without also clearing the selection underneath it", async ({
  page,
}) => {
  await openBoard(page);

  await card(page).click({ modifiers: ["Shift"] });
  await expect(selectBox(page)).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();

  // The help registered no layer, so `openLayerCount()` was 0 and the board's Escape branch ran
  // beside the help's own: one press closed the help and emptied a selection nobody asked it to.
  // The bulk-delete confirm above is the same arbitration, from a layer that did register
  await page.keyboard.press("Escape");
  await expect(help(page)).toBeHidden();
  await expect(selectBox(page)).toHaveAttribute("aria-pressed", "true");
});

/**
 * The fifth, and the one that made BP-530 more than a markup change.
 *
 * Routing the help through `Modal` gave away the ref that the hand-rolled version kept its
 * `onClose` in. `useFocusTrap`'s keydown effect lists `onEscape` in its deps, and every caller
 * passes an inline arrow — so any state write during an Escape dispatch re-renders the board, the
 * trap tears its listener down and re-adds it mid-dispatch, and a listener added during a dispatch
 * is not called for that event. That is BP-522's bug, one layer down.
 *
 * The card's context menu is the reachable way to cause the write: it keeps its own listener and
 * registers no layer, so its `onClose` sets board state while the help's trap is subscribed. One
 * Escape closed the menu and left the help open — worst for the reader this ticket is about, since
 * `aria-modal` tells them the menu behind is not there.
 *
 * The fix belongs in `use-focus-trap.ts`, so it holds for every dialog, not just this one.
 */
test("Escape closes the help even when a context menu closes on the same press", async ({
  page,
}) => {
  await openBoard(page);

  await card(page).click({ button: "right" });
  await expect(contextMenu(page)).toBeVisible();
  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(contextMenu(page)).toBeHidden();
  await expect(help(page)).toBeHidden();
});
