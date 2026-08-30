import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import {
  E2E_MONGODB_URI,
  OUTSIDER_PASSWORD,
  OUTSIDER_USERNAME,
  PROJECT_ID,
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

/**
 * A board that shares no column id with the seeded defaults. Without this the fallback renders
 * byte-identical output to the real thing — `e2e/seed.ts` seeds exactly the default ids, so no
 * label, colour or count could differ and the partial-load test could not fail whatever the page
 * did with the missing project.
 */
const RENAMED_COLUMNS = [
  { id: "icebox", label: "Icebox", color: "#6b7280", role: "backlog", order: 0 },
  { id: "col_wip", label: "Building", color: "#e11d48", role: "active", order: 1 },
  { id: "shipped", label: "Shipped", color: "#22c55e", role: "done", order: 2 },
];

async function renameTheColumns() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  await handle
    .collection("projects")
    .updateOne({ _id: PROJECT_ID }, { $set: { columns: RENAMED_COLUMNS } });
  await handle
    .collection("tasks")
    .updateMany({ project: PROJECT_ID }, { $set: { status: "col_wip" } });
}

/** The In Progress card's figure — the one number this page computes rather than reads */
const inProgressCard = (page: Page) =>
  page.locator("div").filter({ hasText: /^In Progress/ }).last();

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

  /**
   * Retry has to re-run the load in place. Comparing the URL proves nothing — a reload keeps it,
   * and nothing on this page ever navigated in either version. A value planted on `window` does
   * not survive a document load, so it is the thing that can tell the two apart.
   */
  await page.evaluate(() => {
    (window as unknown as { __stayedPut?: boolean }).__stayedPut = true;
  });
  refuse = false;
  await page.getByRole("button", { name: "Try again" }).click();

  await expect(page.getByRole("heading", { name: "Status Breakdown" })).toBeVisible();
  await expect(errorBanner(page)).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { __stayedPut?: boolean }).__stayedPut),
    "the page was reloaded rather than retried in place"
  ).toBe(true);
});

test("only the project request failing still draws the charts", async ({ page }) => {
  await renameTheColumns();
  await signIn(page);

  // The control first, on the same board: with the project loaded, In Progress counts the four
  // tasks now sitting in `col_wip`. Without it, "—" below could mean the card was simply never
  // rendered, and the whole assertion would be about nothing.
  await page.goto(DASHBOARD);
  await expect(inProgressCard(page)).toContainText("4");

  await page.route(PROJECT_ONLY, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"nope"}' })
  );
  await page.reload();

  // `Promise.all` rejected on this and rendered nothing at all
  await expect(page.getByRole("heading", { name: "Status Breakdown" })).toBeVisible();
  await expect(errorBanner(page)).toHaveCount(0);
  await expect(page.getByTestId("dashboard-settings-warning")).toBeVisible();

  /**
   * `statusBreakdown` is keyed by this board's own ids, and the defaults do not contain `col_wip`.
   * Summing them answers 0 — a wrong number in a row of right ones, which is the failure this
   * assertion exists for. Total and Completed come from the server and stay correct.
   */
  await expect(inProgressCard(page)).toContainText("—");
  await expect(inProgressCard(page)).not.toContainText("0");
});

/**
 * A 200 is not a success if the body is empty: `stats` ends up null with nothing rejected, so
 * `whyItFailed` never runs and the banner had no text at all — a red box with only a button.
 */
test("a 200 whose body is empty still says something", async ({ page }) => {
  await signIn(page);
  await page.route(STATS, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "null" })
  );

  await page.goto(DASHBOARD);

  await expect(errorBanner(page)).toContainText("The dashboard could not be loaded");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
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
