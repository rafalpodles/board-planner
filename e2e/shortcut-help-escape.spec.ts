import { test, expect, type Page } from "@playwright/test";
import { PROJECT_KEY, DECOY_TASK_NUMBER, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-522. `?` opened the keyboard-shortcuts help and Escape did nothing at all.
 *
 * The board's own keydown listener runs first and always wrote selection state, so React
 * re-rendered inside the same dispatch; the help's effect then depended on the parent's inline
 * `onClose` and resubscribed — and a listener added mid-dispatch never sees that event.
 *
 * A synthetic `dispatchEvent` cannot show this: the microtask checkpoint that lets the re-render
 * land between the two listeners only happens for a real key. So every press here is a real one
 * through `page.keyboard`.
 */

test.beforeEach(seed);

const help = (page: Page) => page.getByRole("heading", { name: "Keyboard Shortcuts" });

const card = (page: Page) =>
  page.locator(`a[href="/projects/${PROJECT_KEY}/tasks/${DECOY_TASK_NUMBER}"]`);

const selectBox = (page: Page) =>
  page.getByRole("button", { name: `Select ${PROJECT_KEY}-${DECOY_TASK_NUMBER}` });

async function openBoard(page: Page) {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(card(page)).toBeVisible();
}

test("Escape closes the keyboard-shortcuts help", async ({ page }) => {
  await openBoard(page);

  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(help(page)).toBeHidden();
});

test("? still closes the help — the control for the press that always worked", async ({ page }) => {
  await openBoard(page);

  await page.keyboard.press("?");
  await expect(help(page)).toBeVisible();

  await page.keyboard.press("?");
  await expect(help(page)).toBeHidden();
});

test("Escape still clears a card selection when no dialog is open", async ({ page }) => {
  await openBoard(page);

  await card(page).click({ modifiers: ["Shift"] });
  await expect(selectBox(page)).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press("Escape");
  await expect(selectBox(page)).toBeHidden();
});
