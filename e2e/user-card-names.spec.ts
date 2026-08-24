import { test, expect, type Locator, type Page } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USERNAME, seed } from "./seed";

/**
 * BP-351. The cards truncated every ordinary name — "E2E Me…" for "E2E Member" — because three
 * fixed columns left 145px for a name plus its role pill, which needs 165px, while an empty
 * column sat beside them.
 */

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN_USERNAME);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);
}

// Whether the browser is hiding characters, which is what "truncated" means here. `toBeVisible`
// cannot see it: an ellipsised name is fully visible and still unreadable.
function overflows(name: Locator) {
  return name.evaluate((el) => el.scrollWidth > el.clientWidth);
}

function cardName(page: Page, fullName: string) {
  return page.locator("p.font-medium", { hasText: fullName }).first();
}

test.beforeEach(async () => {
  await seed();
});

test("a user card shows the whole display name", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/users");

  const member = cardName(page, "E2E Member");
  await expect(member).toBeVisible();
  // The name this ticket was filed over, rendered as "E2E Me…"
  expect(await overflows(member)).toBe(false);
  expect(await overflows(cardName(page, "E2E Admin"))).toBe(false);
});

// The control. Without it "nothing is truncated" would also pass on a screen that cannot truncate
// at all — and `truncate` is deliberately still there, as the fallback for a name no card can hold.
test("a name too long for any card still truncates rather than breaking the row", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/settings/users");

  const enormous = "Aleksandra Wielkopolska-Nowakowska von Habsburg-Lothringen";
  await page.getByRole("button", { name: "New User" }).click();
  await page.getByLabel("Username").fill("aleksandra");
  await page.getByLabel("Password", { exact: true }).fill("a-starting-password");
  await page.getByLabel("Full Name").fill(enormous);
  await page.getByRole("button", { name: "Create User" }).click();

  const name = cardName(page, enormous);
  await expect(name).toBeVisible();
  expect(await overflows(name)).toBe(true);

  // And the row it sits in did not grow to fit it — the card is the same width as its neighbour,
  // which is the thing `truncate` is there to protect
  const widths = await page
    .locator("p.font-medium")
    .evaluateAll((els) => els.map((el) => (el.parentElement as HTMLElement).clientWidth));
  expect(new Set(widths).size).toBe(1);
});
