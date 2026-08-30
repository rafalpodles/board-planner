import { test, expect, type Page } from "@playwright/test";
import {
  OUTSIDER_PASSWORD,
  OUTSIDER_USERNAME,
  PROJECT_KEY,
  seed,
  seedAssignmentOutsider,
} from "./seed";
import { signIn, signInThroughForm } from "./session";

/**
 * BP-448. `loading` went false while `stats` stayed null, so the old guard `loading || !stats`
 * still held: a toast for three seconds and then an unattended spinner, for ever. Three different
 * refusals — no grant, no such board, a server that failed — all arrived as one generic string,
 * and `Promise.all` threw away a perfectly good `/stats` whenever the *project* request failed.
 */

const DASHBOARD = `/projects/${PROJECT_KEY}/dashboard`;
const STATS = new RegExp(`/api/projects/${PROJECT_KEY}/stats`);
/** The project request and not the stats one, which is a prefix of it */
const PROJECT_ONLY = new RegExp(`/api/projects/${PROJECT_KEY}$`);

const errorBanner = (page: Page) => page.getByTestId("dashboard-error");

test.beforeEach(seed);

test("a reader with no grant is told that, and is not left with a spinner", async ({ page }) => {
  await seedAssignmentOutsider();
  await signInThroughForm(page, OUTSIDER_USERNAME, OUTSIDER_PASSWORD);
  await page.goto(DASHBOARD);

  await expect(errorBanner(page)).toContainText("You do not have access to this board");

  /**
   * The point of the ticket, and it cannot be made without the wait: a toast is removed after
   * three seconds, so an assertion that runs immediately passes against the broken page too.
   */
  await page.waitForTimeout(3500);
  await expect(errorBanner(page)).toContainText("You do not have access to this board");
  await expect(page.locator(".animate-spin")).toHaveCount(0);
});

test("a board that does not exist says that instead — a different sentence", async ({ page }) => {
  await signIn(page);
  await page.goto("/projects/NOSUCHKEY/dashboard");

  await expect(errorBanner(page)).toContainText("There is no board here");
  // The two refusals must not collapse into one message, which is what the old code did
  await expect(errorBanner(page)).not.toContainText("do not have access");
});

test("a server that fails says what it said, and Try again picks it up", async ({ page }) => {
  await signIn(page);

  let refuse = true;
  await page.route(STATS, async (route) => {
    if (!refuse) return route.continue();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "the aggregation gave up" }),
    });
  });

  await page.goto(DASHBOARD);
  // The server's own words, which `use-api.ts` already puts on the error and the page discarded
  await expect(errorBanner(page)).toContainText("the aggregation gave up");

  // Retry, without reloading the page: the same URL must not be visited again
  const wasAt = page.url();
  refuse = false;
  await page.getByRole("button", { name: "Try again" }).click();

  await expect(page.getByRole("heading", { name: "Status Breakdown" })).toBeVisible();
  await expect(errorBanner(page)).toHaveCount(0);
  expect(page.url()).toBe(wasAt);
});

test("only the project request failing still draws the charts", async ({ page }) => {
  await signIn(page);
  await page.route(PROJECT_ONLY, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"nope"}' })
  );

  await page.goto(DASHBOARD);

  // `Promise.all` rejected on this and rendered nothing at all
  await expect(page.getByRole("heading", { name: "Status Breakdown" })).toBeVisible();
  await expect(errorBanner(page)).toHaveCount(0);
  // …and says the names may be wrong, because they now come from the defaults
  await expect(page.getByTestId("dashboard-settings-warning")).toBeVisible();
});

/**
 * The control. Every assertion above is about something appearing, and a page that rendered the
 * banner unconditionally would satisfy all four.
 */
test("a board that loads shows the charts and nothing else", async ({ page }) => {
  await signIn(page);
  await page.goto(DASHBOARD);

  await expect(page.getByRole("heading", { name: "Status Breakdown" })).toBeVisible();
  await expect(errorBanner(page)).toHaveCount(0);
  await expect(page.getByTestId("dashboard-settings-warning")).toHaveCount(0);
  await expect(page.locator(".animate-spin")).toHaveCount(0);
});
