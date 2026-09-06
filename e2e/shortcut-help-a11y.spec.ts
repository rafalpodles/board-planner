import { test, expect, type Page } from "@playwright/test";
import { PROJECT_KEY, STRANDED_SPRINT_ID, seed, seedTaskInCompletedSprint } from "./seed";
import { signIn } from "./session";

/**
 * BP-545. Found by the independent accessibility review of BP-530, which fixed the dialog's
 * *frame* (role, name, focus trap, scroll lock) and left its content exactly as it was.
 *
 * Three separate gaps in `ShortcutHelp.tsx`:
 *
 * - Each row was a `<span>` next to a `<kbd>` inside a plain `<div>` — visually paired, but a
 *   reader announces them as two unrelated blocks. `<dl>/<dt>/<dd>` pairs them for real.
 * - `⌘`, `⇧` and `↔` are bare glyphs: VoiceOver reads U+2318 as "place of interest sign", and NVDA
 *   commonly reads neither `⌘` nor `⇧` at all. Each now carries a visually-hidden spelling.
 * - The "Anywhere" group claimed N/V/R/Esc/? as global; they are only live in `ProjectBoardView`,
 *   on the board and sprints pages — and two of them are conditional there. `V` does nothing once
 *   `pinViewMode` is set, `N` does nothing when `readOnly` — the help kept advertising both anyway.
 */

const helpDialog = (page: Page) => page.getByRole("dialog", { name: "Keyboard Shortcuts" });

const cardVisible = (page: Page) =>
  expect(page.locator(`a[href^="/projects/${PROJECT_KEY}/tasks/"]`).first()).toBeVisible();

async function openBoard(page: Page) {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await cardVisible(page);
}

async function openHelp(page: Page) {
  await page.keyboard.press("?");
  await expect(helpDialog(page)).toBeVisible();
}

test.describe("on a normal board", () => {
  test.beforeEach(seed);

  test("the shortcuts are grouped as a definition list, pairing each description with its key", async ({
    page,
  }) => {
    await openBoard(page);
    await openHelp(page);

    // Measured before the fix: a plain `<div>` of `<span>`/`<kbd>` pairs, blockified by flex —
    // a reader gets "Search tasks and projects", then "⌘K / /", with nothing marking them as one
    await expect(helpDialog(page).locator("dl").first()).toBeVisible();

    const searchRow = helpDialog(page).locator("dl > div", { hasText: "Search tasks and projects" });
    await expect(searchRow.locator("dt")).toHaveText("Search tasks and projects");
    await expect(searchRow.locator("dd kbd")).toBeVisible();
  });

  test("a glyph key also carries a spoken label for screen readers", async ({ page }) => {
    await openBoard(page);
    await openHelp(page);

    const searchRow = helpDialog(page).locator("dl > div", { hasText: "Search tasks and projects" });
    // The glyph stays on screen, marked aria-hidden; the spelling is for assistive tech only — it
    // is in the DOM (and so the accessible name) even though visually clipped
    await expect(searchRow.getByText("Cmd", { exact: true })).toBeAttached();
    await expect(searchRow.locator("kbd")).toContainText("K / /");
  });

  test('only search is listed as available anywhere; board-only shortcuts are not', async ({
    page,
  }) => {
    await openBoard(page);
    await openHelp(page);

    const anywhere = helpDialog(page).locator("section", {
      has: page.getByRole("heading", { name: "Anywhere" }),
    });
    await expect(anywhere.getByText("Search tasks and projects")).toBeVisible();
    await expect(anywhere.getByText("Create new task")).toHaveCount(0);
    await expect(anywhere.getByText("Refresh board")).toHaveCount(0);

    // Still documented — just no longer claimed as global. The control for the assertion above:
    // this proves the row moved rather than vanished
    await expect(helpDialog(page).getByText("Create new task")).toBeVisible();
  });

  test("N and V are offered on a normal, unlocked board", async ({ page }) => {
    await openBoard(page);
    await openHelp(page);

    // The control for the read-only/view-locked case below
    await expect(helpDialog(page).getByText("Create new task")).toBeVisible();
    await expect(helpDialog(page).getByText("Toggle view: board")).toBeVisible();
  });
});

test.describe("on a read-only, view-locked board", () => {
  test.beforeEach(async () => {
    await seed();
    await seedTaskInCompletedSprint();
  });

  test("hides the shortcuts that would do nothing", async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}/sprints?sprint=${STRANDED_SPRINT_ID}`);
    await expect(page.getByTestId("sprint-name")).toBeVisible();

    await openHelp(page);

    // A completed sprint is both readOnly (kills N) and pinned to board view (kills V) — before
    // the fix the help advertised both anyway
    await expect(helpDialog(page).getByText("Create new task")).toHaveCount(0);
    await expect(helpDialog(page).getByText("Toggle view: board")).toHaveCount(0);

    // Not gated on either prop, so still offered — the control proving the section itself still
    // renders rather than the whole group having gone missing
    await expect(helpDialog(page).getByText("Refresh board")).toBeVisible();
  });
});
