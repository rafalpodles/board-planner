import { test, expect, type Locator, type Page } from "@playwright/test";
import { PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-469: the project's audit log — "every settings change on this project, newest first".
 *
 * The screen was reachable in the suite and asserted nowhere. So every test here **causes** the
 * rows it then reads, through the settings screen a person uses, and the empty state is asserted
 * first — as the control that says the rows arrived because of the change rather than being there
 * all along.
 *
 * The card's three silences — not yet, could not, nothing — are BP-548's own tests, at the foot
 * of this file.
 */

test.beforeEach(seed);

const SETTINGS = `/projects/${PROJECT_KEY}/settings`;

/**
 * Returns what the server held, by waiting for the read rather than reading the card. The card
 * now distinguishes "not answered yet" from "nothing recorded" (BP-548), so its sentence is worth
 * asserting — but it is still a rendering of the payload, and the callers below want the payload.
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
  // below can only have come from the change
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

  // What the screen withholds, the endpoint does not: `withProjectAccess` lets any member read
  // every row. Asserted as it is rather than as it should be, and filed as BP-549 — the day the
  // two are reconciled this goes red, which is the signal to rewrite it.
  const asMember = await page.request.get(`/api/projects/${PROJECT_KEY}/audit`);
  expect(asMember.status()).toBe(200);
});

/**
 * BP-548: which of the three silences the card is showing.
 *
 * "No settings changes recorded yet." used to be the answer to three different questions — the
 * read has not come back, the read failed, and the board really has no history — and only the
 * third of those is true. On a screen whose whole subject is "who changed what", the second is
 * the one that lies: the toast fades and the card is left asserting that nothing ever happened
 * here.
 *
 * Both tests below hold or break the read from the browser side, so what is asserted is what a
 * reader would have on screen at that moment, not what the endpoint would have said.
 */

const AUDIT_READ = "**/api/projects/*/audit";

// Scoped to the card, like rows() above: the settings screen mounts every section at once and
// hides the inactive ones, and a future copy tweak that lines up the toast text with the panel
// text would otherwise make an unscoped getByText match both and fail on strict mode.
const auditCard = (page: Page) => page.locator("section").filter({ hasText: "Recent changes" });
const spinner = (page: Page) => auditCard(page).getByRole("status", { name: "Loading the audit log" });
const emptyState = (page: Page) => auditCard(page).getByText("No settings changes recorded yet.");
const failurePanel = (page: Page) => auditCard(page).getByText("Failed to load the audit log.");

test("the card does not call the log empty while its read is still out", async ({ page }) => {
  await signIn(page);

  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(AUDIT_READ, async (route) => {
    await held;
    await route.continue();
  });

  await page.goto(`${SETTINGS}?section=audit`);
  await expect(page.getByRole("heading", { name: "Audit log", exact: true })).toBeVisible();

  // The bug first, so a red run names it: the read is not back, and the card must not answer a
  // question nobody can answer yet. Then what it shows instead — which also keeps the assertion
  // above from passing against a card that rendered nothing at all.
  await expect(emptyState(page)).toHaveCount(0);
  await expect(spinner(page)).toBeVisible();

  // The control, on the same card and the same board: once the read answers, the sentence is
  // exactly what it should say. Without it, a card that never rendered at all reads identically.
  release();
  await expect(emptyState(page)).toBeVisible();
  await expect(spinner(page)).toHaveCount(0);
});

test("a read that fails says so and offers a retry, rather than reporting no history", async ({
  page,
}) => {
  await signIn(page);

  // History for the failure to be wrong about. Without it a board that genuinely has nothing and
  // a board whose log could not be read look the same, which is the bug rather than the control.
  await addCategory(page, "spike");
  await expect(async () => {
    expect(await openAuditLog(page)).toHaveLength(1);
  }).toPass({ timeout: 20_000 });

  let breakIt = true;
  await page.route(AUDIT_READ, async (route) => {
    if (!breakIt) return route.continue();
    breakIt = false;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "the audit log could not be read" }),
    });
  });

  await page.goto(`${SETTINGS}?section=audit`);

  // The render anchor comes first: toBeVisible retries until the card exists, so the count-0
  // check after it is evaluated against a card that has actually rendered. Reversed, the empty
  // check runs immediately after goto — before anything is on screen — and passes vacuously,
  // which is exactly the bug this test exists to catch (found by independent review).
  await expect(failurePanel(page)).toBeVisible();
  await expect(emptyState(page)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(0);

  // The control: Retry reads again, and the row that was there the whole time arrives. This is
  // also what separates a failure branch that works from one that latches for ever.
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(cells(rows(page).first()).nth(3)).toHaveText("Category added: spike");
  await expect(failurePanel(page)).toHaveCount(0);
});
