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

/**
 * Waits for the read, not for the card. The card renders "No settings changes recorded yet."
 * before its request has been made — the empty state is also the pre-fetch state (BP-548) — so
 * asserting on what is on screen at load time says nothing about what the server holds.
 */
async function openAuditLog(page: Page): Promise<StoredRow[]> {
  const read = page.waitForResponse(
    (response) => response.url().endsWith("/audit") && response.request().method() === "GET"
  );
  await page.goto(`${SETTINGS}?section=audit`);
  await expect(page.getByRole("heading", { name: "Audit log", exact: true })).toBeVisible();
  const response = await read;
  expect(response.status()).toBe(200);
  // Before anything else can navigate: a response whose page has gone no longer has a body
  return response.json();
}

interface StoredRow {
  action: string;
  detail: string;
  createdAt: string;
  user: { username: string } | null;
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

  // The control, read off the payload rather than the card: this board has no history, so a row
  // below can only have come from the change. The card cannot answer it — it renders its empty
  // sentence before the request lands (BP-548)
  expect(await openAuditLog(page)).toEqual([]);
  await expect(page.getByText("No settings changes recorded yet.")).toBeVisible();

  await addCategory(page, "spike");

  // The write is fire-and-forget (`categories/route.ts` does not await logProjectAudit) and the
  // card fetches once per mount, so the read is retried rather than assumed to have caught it
  let stored: StoredRow[] = [];
  await expect(async () => {
    stored = await openAuditLog(page);
    expect(stored).toHaveLength(1);
  }).toPass({ timeout: 20_000 });

  await expect(page.getByText("No settings changes recorded yet.")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(1);

  const row = cells(rows(page).first());
  await expect(row.nth(1)).toHaveText("admin");
  // Underscores are the stored form; the screen spells the action out
  await expect(row.nth(2)).toHaveText("settings updated");
  await expect(row.nth(3)).toHaveText("Category added: spike");

  // A time from this run, taken from the payload: the cell is `toLocaleString()` and nothing pins
  // the browser's locale, so parsing what is on screen reads a day-first date as month-first and
  // fails by months on a machine whose locale differs from CI's
  expect(Math.abs(Date.now() - new Date(stored[0].createdAt).getTime())).toBeLessThan(10 * 60_000);
  // And the cell renders it rather than rendering nothing
  await expect(row.nth(0)).not.toHaveText("");
});

test("each change is its own row, newest first", async ({ page }) => {
  await signIn(page);

  await addCategory(page, "spike");
  await addCategory(page, "chore");
  await expect(async () => {
    expect(await openAuditLog(page)).toHaveLength(2);
  }).toPass({ timeout: 20_000 });

  await expect(rows(page)).toHaveCount(2);
  await expect(cells(rows(page).nth(0)).nth(3)).toHaveText("Category added: chore");
  await expect(cells(rows(page).nth(1)).nth(3)).toHaveText("Category added: spike");
});

test("a member is not shown the log at all", async ({ page }) => {
  await signIn(page, "member");
  await page.goto(`${SETTINGS}?section=audit`);

  // The control, and it has to come first: this screen renders a bare spinner while it loads, so
  // every assertion below would pass against a page that had not arrived yet. Asking for a section
  // this reader may not have falls back to the first one they may
  await expect(page.getByRole("heading", { name: "Task fields", exact: true })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Audit log", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Audit log" })).toHaveCount(0);
  await expect(page.getByText("Recent changes")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(0);

  // The endpoint now refuses what the screen already withholds (BP-549) — a member holds a
  // grant, not ownership, and the route asks for the same "admin" need `project.canAdmin` does.
  const asMember = await page.request.get(`/api/projects/${PROJECT_KEY}/audit`);
  expect(asMember.status()).toBe(403);
});
