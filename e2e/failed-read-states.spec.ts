import { test, expect, type Page } from "@playwright/test";
import { PROJECT_KEY, SIBLING_TASK_NUMBER, seed } from "./seed";
import { signIn as arriveSignedIn } from "./session";

/**
 * BP-577. Six screens swallowed a failed read into an empty result and then made a positive claim
 * about the data — nothing recorded, nothing finished, no mail server configured, no comments, no
 * agent with that id, no tasks found. A read that never answered supports none of them.
 *
 * Every case waits past the toast before asserting: three of these screens already toasted and
 * were still wrong, because the toast is gone after three seconds and the false sentence is not.
 */

test.beforeEach(seed);

const signIn = arriveSignedIn;

/** Long enough for the toast to have cleared — that is the whole point of the ticket */
const AFTER_THE_TOAST = 3500;

/**
 * Fails the matching request until `stop()` is called. Returns the switch, so the same test can
 * prove the screen recovers when a Retry finds a server that answers.
 */
async function failUntilTold(page: Page, url: string | RegExp) {
  let failing = true;
  await page.route(url, async (route) => {
    if (!failing) return route.continue();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "the read gave up" }),
    });
  });
  return () => {
    failing = false;
  };
}

const screens = [
  {
    name: "the instance audit log",
    url: "/settings/audit",
    api: "**/api/admin/audit",
    testId: "instance-audit-error",
    claim: "Nothing recorded yet.",
  },
  {
    name: "the run history",
    url: "/settings/workers/runs",
    api: "**/api/admin/runs",
    testId: "fleet-runs-error",
    claim: "Nothing has finished yet.",
  },
  {
    name: "the agents catalog",
    url: "/agents",
    api: "**/api/agents",
    testId: "agents-catalog-error",
    claim: "You have not created an agent yet.",
  },
] as const;

for (const { name, url, api, testId, claim } of screens) {
  test(`${name} says the read failed rather than making a claim`, async ({ page }) => {
    await signIn(page);
    const stopFailing = await failUntilTold(page, api);
    await page.goto(url);

    await expect(page.getByTestId(testId)).toBeVisible();
    await expect(page.getByText(claim)).toHaveCount(0);

    await page.waitForTimeout(AFTER_THE_TOAST);
    await expect(page.getByTestId(testId)).toBeVisible();
    await expect(page.getByText(claim)).toHaveCount(0);

    stopFailing();
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId(testId)).toHaveCount(0);
  });

  // The control: the same screen, the same assertion, against a server that answers
  test(`${name} still reads as empty when the read answers`, async ({ page }) => {
    await signIn(page);
    await page.goto(url);

    await expect(page.getByTestId(testId)).toHaveCount(0);
  });
}

test("the email settings screen never tells an admin to set SMTP_HOST after a failed read", async ({
  page,
}) => {
  await signIn(page);
  const stopFailing = await failUntilTold(page, "**/api/admin/email");
  await page.goto("/settings/email");

  await expect(page.getByTestId("email-settings-error")).toBeVisible();
  await page.waitForTimeout(AFTER_THE_TOAST);
  await expect(page.getByText("No mail server is configured.")).toHaveCount(0);
  await expect(page.getByText("SMTP_HOST")).toHaveCount(0);

  stopFailing();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("email-settings-error")).toHaveCount(0);
});

// The control for the one above: an instance with no SMTP must still get the instruction
test("the email settings screen still says so when the read answers unconfigured", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/settings/email");

  await expect(page.getByTestId("email-settings-error")).toHaveCount(0);
  await expect(page.getByText("No mail server is configured.")).toBeVisible();
});

test("a search that fails says so rather than reporting no tasks", async ({ page }) => {
  await signIn(page);
  const stopFailing = await failUntilTold(page, /\/api\/search\?q=/);
  await page.goto("/search");

  await page.getByRole("textbox", { name: "Search tasks and projects" }).fill("review");

  await expect(page.getByTestId("search-error")).toBeVisible();
  await expect(page.getByText("No tasks found")).toHaveCount(0);
  await page.waitForTimeout(AFTER_THE_TOAST);
  await expect(page.getByTestId("search-error")).toBeVisible();

  stopFailing();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("search-error")).toHaveCount(0);
});

// The control: a query that matches nothing must still say nothing matched
test("a search that answers with nothing still reports no tasks", async ({ page }) => {
  await signIn(page);
  await page.goto("/search");

  await page
    .getByRole("textbox", { name: "Search tasks and projects" })
    .fill("zzzzz-nothing-matches-this");

  await expect(page.getByText("No tasks found")).toBeVisible();
  await expect(page.getByTestId("search-error")).toHaveCount(0);
});

test("a task whose comments cannot be read does not claim it has none", async ({ page }) => {
  await signIn(page);
  const stopFailing = await failUntilTold(page, "**/comments");
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);

  await expect(page.getByTestId("comments-error")).toBeVisible();
  await expect(page.getByText("No comments yet")).toHaveCount(0);
  await page.waitForTimeout(AFTER_THE_TOAST);
  await expect(page.getByTestId("comments-error")).toBeVisible();

  stopFailing();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("comments-error")).toHaveCount(0);
});

// The control: a task nobody has commented on still says so
test("a task with no comments still says it has none", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`);

  await expect(page.getByText("No comments yet")).toBeVisible();
  await expect(page.getByTestId("comments-error")).toHaveCount(0);
});
