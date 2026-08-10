import { test, expect, type Page } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USERNAME, PROJECT_KEY, seed } from "./seed";

/**
 * BP-248. Saving an integration advanced the draft's baseline only when the save **failed**, so a
 * save that worked left the page believing it still had unsaved work — and pressing Save again
 * re-diffed against the stale baseline and re-sent work already done. The audit log carries two
 * removals of one webhook with no addition between them.
 *
 * These assert whether the save bar is **shown**, never what it says. SaveBar deliberately holds
 * its last summary in a ref so the strip does not flash "0 unsaved changes" while it slides away,
 * which means the text survives at `max-height: 0` long after the count reaches zero. A test
 * reading that text would pass before the fix and after it, and reading it is what cost an hour
 * of believing the fix had not worked.
 */

const SETTINGS = `/projects/${PROJECT_KEY}/settings`;

test.beforeEach(seed);

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN_USERNAME);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);
}

const saveButton = (page: Page) => page.getByRole("button", { name: "Save changes" });

/** Webhooks are not on the page until added: the catalogue offers them behind the picker. */
async function openWebhooks(page: Page) {
  await page.goto(SETTINGS);
  await page.getByRole("button", { name: "Integrations", exact: true }).first().click();
  // The picker only appears once something is already connected; on a board with no integrations
  // the tiles are on show already. Both states are normal, so neither is assumed.
  const picker = page.getByRole("button", { name: /Add integration/ });
  if (await picker.isVisible().catch(() => false)) await picker.click();

  // The row's accessible name has three forms — "Webhook Webhooks POST board events to any URL"
  // before anything is configured, "Webhooks 1 endpoint" after, and a separate "Configure
  // Webhooks" button beside it. Matching the first thing containing "Webhooks" survives all of
  // them; anchoring on any one description works exactly once and then rots.
  const input = page.getByPlaceholder("https://example.com/webhook");
  if (!(await input.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /Webhooks/ }).first().click();
  }
  return input;
}

async function addWebhook(page: Page, url: string) {
  const input = await openWebhooks(page);
  await input.fill(url);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(saveButton(page)).toBeVisible();
}

test("a webhook save that succeeds leaves no unsaved work behind", async ({ page }) => {
  await signIn(page);
  await addWebhook(page, "https://example.com/e2e-hook");

  await saveButton(page).click();

  // The whole defect in one assertion: the save worked and the page still asked to be saved
  await expect(saveButton(page)).toBeHidden();
  await expect(page.getByText("1 endpoint")).toBeVisible();
});

test("pressing Save again after a successful save sends nothing", async ({ page }) => {
  await signIn(page);
  await addWebhook(page, "https://example.com/e2e-hook");
  await saveButton(page).click();
  await expect(saveButton(page)).toBeHidden();

  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/webhooks") && r.method() !== "GET") sent.push(`${r.method()} ${r.url()}`);
  });

  // Add a second one and save again. If the baseline had not moved, this save would re-issue the
  // first webhook's POST alongside the second — two requests where one is correct.
  const input = await openWebhooks(page);
  await input.fill("https://example.com/second");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(saveButton(page)).toBeVisible();
  await saveButton(page).click();
  await expect(saveButton(page)).toBeHidden();

  expect(sent, "the first webhook was sent again alongside the second").toHaveLength(1);
});

test("a save that fails keeps the edit on screen to retry", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/projects/*/webhooks", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 500, body: JSON.stringify({ error: "nope" }) })
      : route.continue()
  );

  await addWebhook(page, "https://example.com/e2e-hook");
  await saveButton(page).click();

  // The toast carries the server's own message, not the fallback — `fail` prefers err.message
  await expect(page.getByText("nope")).toBeVisible();
  await expect(saveButton(page), "a failed save must keep the work on screen").toBeVisible();
});
