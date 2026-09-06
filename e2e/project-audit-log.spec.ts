import { test, expect, type Locator, type Page } from "@playwright/test";
import { PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-469: the project's audit log — "every settings change on this project, newest first".
 *
 * The screen was reachable in the suite and asserted nowhere, and its failure mode is silent: a
 * read that answers nothing renders "No settings changes recorded yet", which is also what a
 * healthy log says on a fresh board. So every test here **causes** the rows it then reads, through
 * the settings screen a person uses, and the empty state is asserted first — as the control that
 * says the rows arrived because of the change rather than being there all along.
 */

test.beforeEach(seed);

const SETTINGS = `/projects/${PROJECT_KEY}/settings`;

async function openAuditLog(page: Page) {
  await page.goto(`${SETTINGS}?section=audit`);
  await expect(page.getByRole("heading", { name: "Audit log", exact: true })).toBeVisible();
}

/**
 * The rows, newest first. Each is [when, who, what, detail].
 *
 * Scoped to the card: the settings screen mounts every section a reader may have and hides the
 * inactive ones with `hidden`, so an unscoped `table tbody tr` counts rows from screens nobody is
 * looking at — six of them, on a board whose log holds one.
 */
function rows(page: Page): Locator {
  return page.locator("section").filter({ hasText: "Recent changes" }).locator("tbody tr");
}

const cells = (row: Locator) => row.locator("td");

async function addCategory(page: Page, name: string) {
  await page.goto(`${SETTINGS}?section=fields`);
  await expect(page.getByRole("heading", { name: "Task fields", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "+ Add category" }).click();
  await page.getByLabel("Category name").last().fill(name);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Categories saved")).toBeVisible();
}

test("a change made on the settings screen becomes a row naming who made it", async ({ page }) => {
  await signIn(page);

  await openAuditLog(page);
  // The control: this board has no history, so a row below can only have come from the change
  await expect(page.getByText("No settings changes recorded yet.")).toBeVisible();
  await expect(rows(page)).toHaveCount(0);

  await addCategory(page, "spike");
  await openAuditLog(page);

  await expect(page.getByText("No settings changes recorded yet.")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(1);

  const row = cells(rows(page).first());
  await expect(row.nth(1)).toHaveText("admin");
  // Underscores are the stored form; the screen spells the action out
  await expect(row.nth(2)).toHaveText("settings updated");
  await expect(row.nth(3)).toHaveText("Category added: spike");

  // A time, and one from this run rather than a rendering of undefined
  const when = new Date(await row.nth(0).innerText());
  expect(when.getTime()).not.toBeNaN();
  expect(Math.abs(Date.now() - when.getTime())).toBeLessThan(10 * 60_000);
});

test("each change is its own row, newest first", async ({ page }) => {
  await signIn(page);

  await addCategory(page, "spike");
  await addCategory(page, "chore");
  await openAuditLog(page);

  await expect(rows(page)).toHaveCount(2);
  await expect(cells(rows(page).nth(0)).nth(3)).toHaveText("Category added: chore");
  await expect(cells(rows(page).nth(1)).nth(3)).toHaveText("Category added: spike");
});

test("a member is not shown the log at all", async ({ page }) => {
  await signIn(page, "member");
  await page.goto(`${SETTINGS}?section=audit`);

  // The section is projectAdmin's; a member asking for it by URL gets one they may have
  await expect(page.getByRole("heading", { name: "Audit log", exact: true })).toHaveCount(0);
  await expect(rows(page)).toHaveCount(0);

  // The control: this reader does reach the settings screen, so the absence above is the section
  // being withheld rather than the page failing to load
  await expect(page.getByRole("heading", { name: "Settings", exact: true }).first()).toBeVisible();
});
