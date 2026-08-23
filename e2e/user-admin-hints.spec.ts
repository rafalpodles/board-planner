import { test, expect, type Locator, type Page } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USERNAME, MEMBER_USERNAME, seed } from "./seed";

/**
 * BP-351, both halves of the Settings → Users screen.
 *
 * The hint under Email called the address a notification preference. Since BP-281 it is also the
 * only thing that lets an account recover itself, and whoever writes it decides where the next
 * reset link lands — the route already treats it that way (refused to a machine credential,
 * invalidates outstanding links, writes an audit row). The wording follows the published
 * `members-and-permissions` page rather than inventing a third description of the same field.
 *
 * And the cards truncated every ordinary name — "E2E Me…" — because three columns left 145px for
 * a name plus its role pill, which needs 165px, while an empty column sat beside it.
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

test("the new-user hint says the address is what makes the account resettable", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/settings/users");
  await page.getByRole("button", { name: "New User" }).click();

  const hint = page.locator("#newUserEmailHelp");
  // Still optional — an instance with no mail server has no use for it, and the form has always
  // said so
  await expect(hint).toContainText("Optional");
  await expect(hint).toContainText("reset a forgotten password");
  // The consequence of leaving it blank, in the docs' own words
  await expect(hint).toContainText("administrator setting a password");
  await expect(hint).not.toContainText("Used for email notifications.");
});

test("the edit-user hint says what changing the address does", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/users");
  await page.getByText(`@${MEMBER_USERNAME}`, { exact: true }).first().click();

  const hint = page.getByRole("dialog").locator("#editUserEmailHelp");
  await expect(hint).toContainText("reset a forgotten password");
  // The half an administrator had no way to know: this is a change of who can take the account
  // over at the next reset
  await expect(hint).toContainText("hands the next reset to the new address");
  await expect(hint).toContainText("audit log");
  await expect(hint).not.toContainText("Used for email notifications.");
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
