import { test, expect, type Page } from "@playwright/test";
import { DECOY_TASK_TITLE, PROJECT_KEY, SIBLING_TASK_TITLE, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-475. Every spec in this suite leans on toasts and none owns them: they are read through
 * `e2e/toasts.ts`, which records each one as it is added precisely because a toast clears itself
 * before a retrying matcher can see it. That helper answers "was this message shown", never "what
 * does the stack do" — so nothing asserted that two can be on screen at once, that clicking one
 * dismisses that one, or that they leave on their own.
 *
 * Raised by failing the status write rather than by a happy path: an error is the one toast a test
 * can produce twice in a row on demand, and `use-project-board.ts` turns a refused PATCH into
 * exactly one "Failed to update status".
 */

const FAILED = "Failed to update status";
const toasts = (page: Page) => page.getByTestId("toast");

test.beforeEach(seed);

async function openBoardWithFailingStatusWrites(page: Page) {
  await signIn(page);
  await page.route(/\/tasks\/[^/]+\/status$/, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"nope"}' })
  );
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator("table")).toBeVisible();
}

/** The row's own status picker, which is the cheapest write on this screen */
async function failAStatusWrite(page: Page, title: string) {
  const row = page.locator("tr", { hasText: title });
  await row.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Done" }).click();
}

test("two toasts stand together rather than replacing one another", async ({ page }) => {
  await openBoardWithFailingStatusWrites(page);

  await failAStatusWrite(page, SIBLING_TASK_TITLE);
  await expect(toasts(page)).toHaveCount(1);
  await failAStatusWrite(page, DECOY_TASK_TITLE);

  await expect(toasts(page)).toHaveCount(2);
  await expect(toasts(page).first()).toContainText(FAILED);
});

/**
 * Its own test, and the assertion is given a short deadline on purpose. Folded into the test above
 * it passed with the dismiss handler deleted: by the time the click landed, the first toast was
 * near the end of its own three seconds and left on schedule, so "one fewer toast" was true either
 * way. Measured — that is not a hypothetical.
 */
test("a toast is its own dismiss control", async ({ page }) => {
  await openBoardWithFailingStatusWrites(page);

  await failAStatusWrite(page, SIBLING_TASK_TITLE);
  await expect(toasts(page)).toHaveCount(1);

  await toasts(page).first().click();

  // Well inside the three seconds it would have had left, so only the click can explain this
  await expect(toasts(page)).toHaveCount(0, { timeout: 750 });
});

test("and one nobody touches leaves on its own", async ({ page }) => {
  await openBoardWithFailingStatusWrites(page);

  await failAStatusWrite(page, SIBLING_TASK_TITLE);
  await expect(toasts(page)).toHaveCount(1);

  await expect(toasts(page)).toHaveCount(0, { timeout: 6_000 });
});
