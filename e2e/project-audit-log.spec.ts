import { test, expect, type Locator, type Page } from "@playwright/test";
import { PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

test.beforeEach(seed);

const SETTINGS = `/projects/${PROJECT_KEY}/settings`;

async function openAuditLog(page: Page): Promise<StoredRow[]> {
  const read = page.waitForResponse(
    (response) => response.url().endsWith("/audit") && response.request().method() === "GET"
  );
  await page.goto(`${SETTINGS}?section=audit`);
  await expect(page.getByRole("heading", { name: "Audit log", exact: true })).toBeVisible();
  const response = await read;
  expect(response.status()).toBe(200);
  return response.json();
}

interface StoredRow {
  action: string;
  detail: string;
  createdAt: string;
  user: { username: string } | null;
}

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

  expect(await openAuditLog(page)).toEqual([]);
  await expect(page.getByText("No settings changes recorded yet.")).toBeVisible();

  await addCategory(page, "spike");

  let stored: StoredRow[] = [];
  await expect(async () => {
    stored = await openAuditLog(page);
    expect(stored).toHaveLength(1);
  }).toPass({ timeout: 20_000 });

  await expect(page.getByText("No settings changes recorded yet.")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(1);

  const row = cells(rows(page).first());
  await expect(row.nth(1)).toHaveText("admin");
  await expect(row.nth(2)).toHaveText("settings updated");
  await expect(row.nth(3)).toHaveText("Category added: spike");

  expect(Math.abs(Date.now() - new Date(stored[0].createdAt).getTime())).toBeLessThan(10 * 60_000);
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

  await expect(page.getByRole("heading", { name: "Task fields", exact: true })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Audit log", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Audit log" })).toHaveCount(0);
  await expect(page.getByText("Recent changes")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(0);

  const asMember = await page.request.get(`/api/projects/${PROJECT_KEY}/audit`);
  expect(asMember.status()).toBe(403);
});

const AUDIT_READ = "**/api/projects/*/audit";

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

  await expect(emptyState(page)).toHaveCount(0);
  await expect(spinner(page)).toBeVisible();

  release();
  await expect(emptyState(page)).toBeVisible();
  await expect(spinner(page)).toHaveCount(0);
});

test("a read that fails says so and offers a retry, rather than reporting no history", async ({
  page,
}) => {
  await signIn(page);

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

  await expect(failurePanel(page)).toBeVisible();
  await expect(emptyState(page)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(0);

  await page.getByRole("button", { name: "Retry" }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(cells(rows(page).first()).nth(3)).toHaveText("Category added: spike");
  await expect(failurePanel(page)).toHaveCount(0);
});
