import { test, expect, type Page } from "@playwright/test";
import { MEMBER_USERNAME, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-583. The grant and the members read that follows it were one `try`, so a members GET that
 * blipped told an admin **"Failed to update access"** over access the server had already changed —
 * and, because the list never refreshed, the row still showed the old relation, so the obvious
 * next move was to grant it a second time.
 *
 * The write's failure and the refresh's failure are different facts. This drives them apart at
 * the surface, against the real endpoints.
 */

test.beforeEach(seed);

/**
 * A toast lives 3s and the suite's expect timeout is 15s, so a *retrying* `toHaveCount(0)` on one
 * passes by waiting it out — it cannot fail. Every negative below is `count()`, read once, after a
 * positive that proves the screen has settled.
 */
const LIST_REFRESH_FAILED = "The list could not be refreshed — reload the page to see it";

async function openMembers(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}/settings`);
  await expect(page.getByLabel(`Access for ${MEMBER_USERNAME}`)).toBeVisible();
}

/** Fails only the members **read**, and only from the next one on, so the write still lands */
async function breakTheMembersRead(page: Page) {
  await page.route("**/api/projects/*/members", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "the read gave up" }),
    });
  });
}

test("a grant that landed is not reported as a failure when only its refresh fails", async ({
  page,
}) => {
  await signIn(page);
  await openMembers(page);
  await breakTheMembersRead(page);

  const written = page.waitForResponse(
    (r) => r.url().includes("/members") && r.request().method() === "PUT" && r.ok()
  );
  await page.getByLabel(`Access for ${MEMBER_USERNAME}`).selectOption("owner");
  await written;

  await expect(page.getByText(LIST_REFRESH_FAILED)).toBeVisible();
  expect(await page.getByText("Failed to update access").count(), "the write's error").toBe(0);

  // The row carries the change even though the list could not be re-read
  await expect(page.getByLabel(`Access for ${MEMBER_USERNAME}`)).toHaveValue("owner");

  // And it is real, not just painted: a reload reads it back from the server
  await page.unroute("**/api/projects/*/members");
  await page.reload();
  await expect(page.getByLabel(`Access for ${MEMBER_USERNAME}`)).toHaveValue("owner");
});

// The control: a write that genuinely fails is still reported as the write's failure, and the
// refresh line must not appear in its place
test("a refused grant still says the access was not updated", async ({ page }) => {
  await signIn(page);
  await openMembers(page);

  await page.route("**/api/projects/*/members", async (route) => {
    if (route.request().method() === "GET") return route.continue();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "the write was refused" }),
    });
  });

  await page.getByLabel(`Access for ${MEMBER_USERNAME}`).selectOption("owner");

  // The server's own words, not a generic fallback, and not the refresh's line
  await expect(page.getByText("the write was refused")).toBeVisible();
  expect(await page.getByText(LIST_REFRESH_FAILED).count(), LIST_REFRESH_FAILED).toBe(0);
  expect(await page.getByText("Access updated").count(), "Access updated").toBe(0);

  // Nothing moved: the row still shows what the server still holds
  await expect(page.getByLabel(`Access for ${MEMBER_USERNAME}`)).toHaveValue("member");
});

// The other control: with both halves working, one success and nothing else
test("a grant that lands and refreshes says so once", async ({ page }) => {
  await signIn(page);
  await openMembers(page);

  // The row is painted from the write before the refresh is even issued, so both assertions below
  // would be satisfied while the read was still in flight. Wait for the read itself.
  const refreshed = page.waitForResponse(
    (r) => r.url().includes("/members") && r.request().method() === "GET" && r.ok()
  );
  await page.getByLabel(`Access for ${MEMBER_USERNAME}`).selectOption("owner");
  await refreshed;

  await expect(page.getByText("Access updated")).toBeVisible();
  await expect(page.getByLabel(`Access for ${MEMBER_USERNAME}`)).toHaveValue("owner");
  expect(await page.getByText(LIST_REFRESH_FAILED).count(), LIST_REFRESH_FAILED).toBe(0);
});
